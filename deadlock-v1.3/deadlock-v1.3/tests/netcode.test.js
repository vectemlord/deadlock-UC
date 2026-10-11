import test from 'node:test';
import assert from 'node:assert/strict';
import {Game, stepMover} from '../shared/game.js';
import {encodeState, decodeState, rosterOf, HEADER} from '../shared/codec.js';
import {SnapshotBuffer, Predictor, InputGate} from '../src/netcode.js';
import {simulate} from '../tools/predict-sim.mjs';

function busyGame() {
  const g = new Game(); for (let i = 0; i < 10; i++) g.addPlayer('p' + i, 'P' + i, ['runner', 'sentinel', 'engineer'][i % 3], i % 2, true);
  g.start(false); return g;
}
test('binary codec round-trips a live 5v5 snapshot within quantization error and is >90% smaller than JSON', () => {
  const g = busyGame(); let jsonBytes = 0, binBytes = 0;
  for (let i = 0; i < 400; i++) {
    g.update(1 / 30);
    const snap = g.snapshot(), bin = encodeState(g, 7);
    jsonBytes += JSON.stringify({type: 'state', state: snap}).length; binBytes += bin.length;
    const out = decodeState(bin, rosterOf(g), 7);
    assert.equal(out.players.length, snap.players.length);
    snap.players.forEach((p, k) => {
      const q = out.players[k];
      assert.equal(q.id, p.id); assert.ok(Math.abs(q.x - p.x) <= .011 && Math.abs(q.z - p.z) <= .011);
      assert.ok(Math.abs(q.hp - Math.ceil(p.hp)) <= 1e-9); assert.deepEqual(q.held, p.held); assert.equal(q.waiting, p.waiting); assert.equal(q.deadlocked, p.deadlocked);
      assert.equal(q.kills, p.kills); assert.equal(q.deliveries, p.deliveries);
    });
    assert.deepEqual(out.scores, snap.scores); assert.equal(out.phase, snap.phase); assert.equal(out.tick, snap.tick & 0xFFFF);
    assert.equal(out.bullets.length, snap.bullets.length);
    snap.bullets.forEach((b, k) => assert.ok(b.id === out.bullets[k].id && Math.abs(out.bullets[k].x - b.x) <= .011));
    assert.equal(Math.ceil(out.time), Math.ceil(snap.time));
  }
  assert.ok(binBytes / jsonBytes < .1, `ratio ${(binBytes / jsonBytes).toFixed(3)}`);
});
test('decode rejects malformed frames and waits for a matching roster version', () => {
  const g = busyGame(), bin = encodeState(g, 3), roster = rosterOf(g);
  assert.equal(decodeState(new Uint8Array(5), roster, 3), null);
  assert.equal(decodeState(bin.subarray(0, HEADER + 10), roster, 3), null);
  assert.equal(decodeState(bin, roster, 4).stale, true);
  assert.equal(decodeState(bin, [], 3).stale, true);
  assert.equal(decodeState(bin, roster, 3).stale, undefined);
});
test('cycles, resource owners and uplink survive the wire format', () => {
  const g = new Game(); g.addPlayer('a', 'A', 'runner', 0); g.addPlayer('b', 'B', 'runner', 1); g.start(false);
  const take = (p, id) => {const r = g.resources.find(r => r.id === id); p.x = r.x; p.z = r.z; g.interact(p);};
  const [a, b] = g.players; take(a, 'CPU'); take(b, 'RAM'); take(a, 'RAM'); take(b, 'CPU'); g.update(1 / 30);
  const out = decodeState(encodeState(g, 1), rosterOf(g), 1);
  assert.equal(out.cycles.length, 1); assert.deepEqual([...out.cycles[0]].sort(), ['a', 'b']);
  assert.equal(out.resources.find(r => r.id === 'CPU').owner, 'a'); assert.deepEqual(out.players[0].held, ['CPU']); assert.equal(out.players[0].waiting, 'RAM'); assert.equal(out.players[0].deadlocked, true);
});
test('prediction math is identical to the server: stepMover == Game.update for random inputs incl. dash and skill', () => {
  const g = new Game(); g.addPlayer('a', 'A', 'runner', 0); g.addPlayer('b', 'B', 'sentinel', 1); g.start(false);
  const p = g.players[0], m = {x: p.x, z: p.z, role: p.role, boost: p.boost, dashCd: p.dashCd, skillCd: p.skillCd, waiting: false, canAct: true};
  let s = 12345; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 1500; i++) {
    const inp = {x: Math.round(r() * 2 - 1), z: Math.round(r() * 2 - 1), dash: r() < .05, skill: r() < .02, angle: r() * 6};
    g.input('a', inp, i & 0xFFFF); g.update(1 / 30); stepMover(m, inp, 1 / 30);
    assert.ok(Math.abs(m.x - p.x) < 1e-9 && Math.abs(m.z - p.z) < 1e-9, `diverged at tick ${i}`);
    assert.ok(Math.abs(m.boost - p.boost) < 1e-9 && Math.abs(m.dashCd - p.dashCd) < 1e-9 && Math.abs(m.skillCd - p.skillCd) < 1e-9);
  }
});
test('server ack counts unchanged-input ticks so change-only sending stays reconcilable', () => {
  const g = new Game(); g.addPlayer('a', 'A', 'runner', 0); g.addPlayer('b', 'B', 'runner', 1); g.start(false);
  const p = g.players[0]; assert.equal(g.ack(p), 0xFFFF);
  g.input('a', {x: 1}, 10); g.update(1 / 30); assert.equal(g.ack(p), 10);
  g.update(1 / 30); g.update(1 / 30); assert.equal(g.ack(p), 12);
  g.input('a', {x: 0}, 13); g.update(1 / 30); assert.equal(g.ack(p), 13);
});
test('prediction + reconciliation: no hard snaps and tiny error at 40, 150 and 300 ms RTT, with dashes, skills and wall contact', () => {
  for (const oneWay of [20, 75, 150]) {
    const r = simulate({oneWayMs: oneWay, jitterMs: 15, seconds: 40, seed: oneWay});
    assert.equal(r.snaps, 0, `snaps at ${oneWay}`); assert.ok(r.avgErr < .35, `avg err ${r.avgErr} at ${oneWay}`); assert.ok(r.maxErr < 3, `max ${r.maxErr}`);
    assert.ok(r.inputMsgsPerSec < r.ticksPerSec, 'change-only input sends fewer messages than ticks');
  }
});
test('prediction removes the round trip from input latency', () => {
  const a = simulate({oneWayMs: 75, seconds: 4, script: 'press', prediction: false, seed: 3}), b = simulate({oneWayMs: 75, seconds: 4, script: 'press', prediction: true, seed: 3});
  assert.ok(a.firstMotionMs !== null && b.firstMotionMs !== null);
  assert.ok(a.firstMotionMs > 150, `without prediction ${a.firstMotionMs}`); assert.ok(b.firstMotionMs < 40, `with prediction ${b.firstMotionMs}`);
});
test('InputGate sends changes and a keep-alive, never repeats identical input every tick', () => {
  const gate = new InputGate(); let sent = 0;
  for (let i = 0; i < 60; i++) if (gate.check({x: 1, z: 0, angle: 1, fire: false})) sent++;
  assert.ok(sent >= 9 && sent <= 11, `sent ${sent}`);
  assert.ok(gate.check({x: 1, z: 0, angle: 1, fire: true})); assert.ok(gate.check({x: 1, z: 0, angle: 1, fire: true, dash: true}));
});
test('SnapshotBuffer interpolates between two snapshots and survives tick wrap-around', () => {
  const buf = new SnapshotBuffer(), mk = (tick, x) => ({tick, phase: 'playing', players: [{id: 'a', x, z: 0, angle: 0, respawn: 0}], bullets: []});
  for (let i = 0; i < 10; i++) buf.push(mk(65530 + i, i), 1000 + i * 33.333);       // wraps past 65535
  const out = buf.sample(1000 + 9 * 33.333 + 20 - 0), x = out.players[0].x;
  assert.ok(x > 0 && x < 9.5, `x=${x}`); assert.ok(buf.items.every((it, i, a) => !i || it.n > a[i - 1].n));
  const mid = buf.sample(1000 + 5 * 33.333 + buf.delay + buf.offset - 1000 + 0.0).players[0].x; assert.ok(Number.isFinite(mid));
});
