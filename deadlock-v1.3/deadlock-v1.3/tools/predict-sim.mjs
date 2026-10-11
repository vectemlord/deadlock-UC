// Headless latency simulation: real Game on the "server", real codec + Predictor on the "client",
// messages delayed by a configurable one-way latency. Used by tests/netcode.test.js and tools/evaluate.mjs.
import {Game} from '../shared/game.js';
import {encodeState, decodeState, rosterOf} from '../shared/codec.js';
import {Predictor, InputGate} from '../src/netcode.js';
const TICK = 1000 / 30;
const rng = (seed) => {let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;};

export function simulate({oneWayMs = 40, jitterMs = 0, seconds = 30, prediction = true, script = 'random', seed = 1} = {}) {
  const rand = rng(seed);
  const g = new Game(); g.addPlayer('me', 'Me', 'runner', 0); g.addPlayer('x', 'X', 'sentinel', 1); g.start(false);
  const roster = rosterOf(g), pred = new Predictor(), gate = new InputGate();
  const up = [], down = [];
  let lastUp = 0, lastDown = 0, serverNext = rand() * TICK, clientNext = rand() * TICK, t = 0, plainSeq = 0;
  let state = null, hold = {x: 0, z: 0, until: 0}, pressAt = null, lastX = null, firstMotion = null, sent = 0, ticks = 0, bytes = 0;
  while (t < seconds * 1000) {
    if (serverNext <= clientNext) {
      t = serverNext;
      while (up.length && up[0].t <= t) {const m = up.shift(); g.input('me', m.input, m.seq);}
      g.update(1 / 30);
      const frame = encodeState(g, 1); bytes += frame.length;
      const arrive = Math.max(lastDown, t + oneWayMs + rand() * jitterMs); lastDown = arrive; down.push({t: arrive, frame});
      serverNext += TICK;
    } else {
      t = clientNext;
      while (down.length && down[0].t <= t) {
        state = decodeState(down.shift().frame, roster, 1);
        if (prediction) pred.reconcile(state.players.find(p => p.id === 'me'), true);
      }
      let input;
      if (script === 'press') input = {x: t > 1000 ? 1 : 0, z: 0, angle: 0};
      else {
        if (t >= hold.until) {const d = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]][Math.floor(rand() * 9)]; hold = {x: d[0], z: d[1], until: t + 300 + rand() * 1200};}
        input = {x: hold.x, z: hold.z, angle: rand() * 6, dash: rand() < .03, skill: rand() < .01};
      }
      const me = state?.players.find(p => p.id === 'me');
      let seq = null;
      if (prediction) seq = pred.tick(input, me); else if (me) seq = (++plainSeq) & 0xFFFF;
      const out = seq === null ? null : gate.check(input);
      if (out) {sent++; const arrive = Math.max(lastUp, t + oneWayMs + rand() * jitterMs); lastUp = arrive; up.push({t: arrive, seq, input: out});}
      ticks++; clientNext += TICK;
      const shown = prediction ? pred.m : me;
      if (script === 'press' && shown) {
        if (input.x && pressAt === null) pressAt = t - rand() * TICK;          // the physical key press happened up to one tick before we sampled it
        if (pressAt !== null && firstMotion === null && lastX !== null && Math.abs(shown.x - lastX) > .01) firstMotion = t - pressAt;
        lastX = shown.x;
      }
    }
  }
  const s = pred.stats, truth = g.players[0];
  return {oneWayMs, jitterMs, prediction, firstMotionMs: firstMotion, avgErr: s.reconciles ? s.sumErr / s.reconciles : 0, maxErr: s.maxErr, corrections: s.corrections, snaps: s.snaps, reconciles: s.reconciles,
    inputMsgsPerSec: sent / (seconds), ticksPerSec: ticks / seconds, finalDelta: prediction && pred.m ? Math.hypot(pred.m.x - truth.x, pred.m.z - truth.z) : null, frameBytes: bytes / (seconds * 30)};
}
