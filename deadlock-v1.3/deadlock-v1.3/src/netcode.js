// Deadlock v1.3 client netcode: snapshot interpolation, client-side prediction and live telemetry.
import {stepMover} from '../shared/game.js';

const TICK_MS = 1000 / 30;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, f) => a + (b - a) * f;
const lerpAngle = (a, b, f) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * f;

// ---------------------------------------------------------------------------
// SnapshotBuffer: render remote players ~2 ticks in the past, interpolating between two real snapshots.
// The timeline is the server's own tick counter, so dropped or late frames do not distort movement.
// ---------------------------------------------------------------------------
export class SnapshotBuffer {
  constructor() {this.clear();}
  clear() {this.items = []; this.lastTick = null; this.unwrapped = 0; this.offset = null; this.delay = 100; this.meanGap = TICK_MS; this.jitter = 0; this.lastArrival = 0; this.frames = 0;}
  push(state, now) {
    // The wire tick is a u16; unwrap it into a monotonically increasing counter.
    if (this.lastTick === null) this.unwrapped = state.tick;
    else this.unwrapped += (state.tick - this.lastTick + 0x10000) & 0xFFFF;
    this.lastTick = state.tick;
    if (this.items.length && this.unwrapped <= this.items[this.items.length - 1].n) return;
    const tm = this.unwrapped * TICK_MS;
    // Clock offset between server timeline and local clock: follow the fastest packets down at once, drift up slowly.
    const sample = now - tm;
    this.offset = this.offset === null || sample < this.offset ? sample : this.offset + (sample - this.offset) * .02;
    if (this.lastArrival) {
      const gap = now - this.lastArrival;
      this.meanGap += (gap - this.meanGap) * .1; this.jitter += (Math.abs(gap - this.meanGap) - this.jitter) * .1;
      this.delay = clamp(this.meanGap * 1.5 + this.jitter * 2 + 10, 50, 250);
    }
    this.lastArrival = now; this.frames++;
    this.items.push({n: this.unwrapped, tm, s: state});
    while (this.items.length > 24) this.items.shift();
  }
  latest() {return this.items.length ? this.items[this.items.length - 1].s : null;}
  sample(now) {
    const n = this.items.length;
    if (!n) return null;
    const newest = this.items[n - 1].s;
    if (n < 2 || newest.phase !== 'playing') return newest;
    const rt = now - this.offset - this.delay;
    let j = 0; while (j < n && this.items[j].tm < rt) j++;
    if (j === 0) return this.items[0].s;
    if (j === n) return newest;
    const a = this.items[j - 1], b = this.items[j], f = clamp((rt - a.tm) / (b.tm - a.tm), 0, 1);
    const before = new Map(a.s.players.map(p => [p.id, p]));
    const players = b.s.players.map(p => {
      const q = before.get(p.id);
      if (!q || q.respawn || p.respawn) return p;
      return {...p, x: lerp(q.x, p.x, f), z: lerp(q.z, p.z, f), angle: lerpAngle(q.angle, p.angle, f)};
    });
    const bullets0 = new Map(a.s.bullets.map(x => [x.id, x]));
    const bullets = b.s.bullets.map(x => {const q = bullets0.get(x.id); return q ? {...x, x: lerp(q.x, x.x, f), z: lerp(q.z, x.z, f)} : x;});
    return {...b.s, players, bullets};
  }
}

// ---------------------------------------------------------------------------
// Predictor: move the local player immediately, then reconcile with the authoritative state.
// ---------------------------------------------------------------------------
export class Predictor {
  constructor() {this.reset();}
  reset() {
    this.m = null; this.hist = []; this.seq = 0;
    this.stats = {reconciles: 0, corrections: 0, snaps: 0, lastErr: 0, maxErr: 0, sumErr: 0};
  }
  get ready() {return !!this.m;}
  // Advance one fixed client tick. `me` is the newest authoritative record of the local player (used only to initialise).
  tick(input, me) {
    if (!this.m) {
      if (!me) return null;
      this.m = {x: me.x, z: me.z, role: me.role, boost: me.boost, dashCd: me.dashCd, skillCd: me.skillCd, waiting: !!me.waiting, canAct: true};
    }
    this.seq = (this.seq + 1) & 0xFFFF;
    const step = {x: clamp(Number(input.x) || 0, -1, 1), z: clamp(Number(input.z) || 0, -1, 1), dash: !!input.dash, skill: !!input.skill};
    this.hist.push({seq: this.seq, step});
    if (this.hist.length > 300) this.hist.shift();
    stepMover(this.m, step, 1 / 30);
    return this.seq;
  }
  // Called for every authoritative snapshot containing the local player.
  reconcile(me, playing) {
    if (!this.m || !me) return;
    const base = {x: me.x, z: me.z, role: me.role, boost: me.boost, dashCd: me.dashCd, skillCd: me.skillCd, waiting: !!me.waiting, canAct: !!playing && !me.respawn && !me.disconnected};
    const ack = me.ack;
    if (ack === 0xFFFF) {this.m.canAct = base.canAct; this.m.waiting = base.waiting; return;}     // server has not seen any input yet
    const ahead = (this.seq - ack) & 0xFFFF;
    if (ahead > 0x7FFF) {Object.assign(this.m, base); this.hist.length = 0; this.stats.snaps++; return;}   // server is ahead of us (tab was asleep): trust it
    while (this.hist.length && ((ack - this.hist[0].seq) & 0xFFFF) <= 0x7FFF) this.hist.shift();            // drop inputs the server has applied
    const pred = {...base};
    for (const h of this.hist) stepMover(pred, h.step, 1 / 30);                                              // replay what the server has not seen yet
    const err = Math.hypot(pred.x - this.m.x, pred.z - this.m.z), s = this.stats;
    s.reconciles++; s.lastErr = err; s.sumErr += err; s.maxErr = Math.max(s.maxErr, err);
    if (err > 3) {this.m.x = pred.x; this.m.z = pred.z; s.snaps++;}
    else if (err > .02) {this.m.x += (pred.x - this.m.x) * .4; this.m.z += (pred.z - this.m.z) * .4; s.corrections++;}
    this.m.boost = pred.boost; this.m.dashCd = pred.dashCd; this.m.skillCd = pred.skillCd; this.m.waiting = pred.waiting; this.m.canAct = pred.canAct; this.m.role = pred.role;
  }
}

// ---------------------------------------------------------------------------
// Telemetry: rolling bandwidth / frame counters shown in the sidebar.
// ---------------------------------------------------------------------------
export class Telemetry {
  constructor() {this.reset();}
  reset() {this.window = []; this.upWindow = []; this.frames = 0; this.lastFrameBytes = 0; this.gapMax = 0; this.lastAt = 0; this.sentInputs = 0; this.total = 0;}
  down(bytes, now, isFrame) {
    this.window.push({t: now, bytes, frame: isFrame ? 1 : 0}); this.total += bytes;
    if (isFrame) {this.lastFrameBytes = bytes; this.frames++; if (this.lastAt) this.gapMax = Math.max(this.gapMax * .995, now - this.lastAt); this.lastAt = now;}
    while (this.window.length && now - this.window[0].t > 3000) this.window.shift();
  }
  up(bytes, now) {this.upWindow.push({t: now, bytes}); while (this.upWindow.length && now - this.upWindow[0].t > 3000) this.upWindow.shift();}
  read(now) {
    while (this.window.length && now - this.window[0].t > 3000) this.window.shift();
    while (this.upWindow.length && now - this.upWindow[0].t > 3000) this.upWindow.shift();
    const span = Math.max(1, Math.min(3000, this.window.length ? now - this.window[0].t : 1000)) / 1000;
    const down = this.window.reduce((a, w) => a + w.bytes, 0), frames = this.window.reduce((a, w) => a + w.frame, 0);
    const upSpan = Math.max(1, Math.min(3000, this.upWindow.length ? now - this.upWindow[0].t : 1000)) / 1000;
    const up = this.upWindow.reduce((a, w) => a + w.bytes, 0);
    return {downKiBps: down / span / 1024, upKiBps: up / upSpan / 1024, framesPerSec: frames / span, upMsgsPerSec: this.upWindow.length / upSpan, lastFrameBytes: this.lastFrameBytes, maxGapMs: this.gapMax};
  }
}

// Decide whether the current input needs to go over the wire. Unchanged input is implied by the server
// (it keeps the last input in force), so only changes and a 200 ms keep-alive are sent.
export class InputGate {
  constructor() {this.last = null; this.since = 99;}
  reset() {this.last = null; this.since = 99;}
  check(input) {
    this.since++;
    const q = {x: Math.round(clamp(input.x || 0, -1, 1) * 100) / 100, z: Math.round(clamp(input.z || 0, -1, 1) * 100) / 100, fire: !!input.fire};
    const flags = ['interact', 'rollback', 'skill', 'dash'].filter(k => input[k]);
    const last = this.last;
    const angle = Number.isFinite(input.angle) ? input.angle : 0;
    const changed = !last || q.x !== last.x || q.z !== last.z || q.fire !== last.fire || Math.abs(Math.atan2(Math.sin(angle - last.angle), Math.cos(angle - last.angle))) > .02 || flags.length > 0;
    if (!changed && this.since < 6) return null;
    this.last = {...q, angle}; this.since = 0;
    const out = {x: q.x, z: q.z, angle: Math.round(angle * 1000) / 1000};
    if (q.fire) out.fire = true;
    for (const k of flags) out[k] = true;
    return out;
  }
}
