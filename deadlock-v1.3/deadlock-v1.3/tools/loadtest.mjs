// Protocol-aware load generator. proto 1 behaves like the v1.2 client (JSON state, input every tick);
// proto 2 behaves like the v1.3 client (binary frames, change-only numbered input).
import {WebSocket} from 'ws';
import {InputGate} from '../src/netcode.js';
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function run({port, rooms = 1, per = 10, spectators = 0, secs = 10, proto = 1, warmup = 2}) {
  const all = [];
  const open = (kind, first) => new Promise((resolve, reject) => {
    const c = {kind, bytes: 0, frames: 0, gaps: [], rtts: [], upBytes: 0, upMsgs: 0, last: 0, recording: false, seq: 0, hold: {x: 0, z: 0, fire: false, until: 0}, gate: new InputGate()};
    const ws = c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => {all.push(c); ws.send(JSON.stringify(first(c)));});
    ws.on('error', reject);
    ws.on('message', (data, isBinary) => {
      const now = performance.now();
      if (c.recording) c.bytes += data.length;
      let frame = false;
      if (isBinary) frame = true;
      else if (data.length > 400 && proto === 1) frame = true;                     // legacy JSON state
      else {
        const m = JSON.parse(data);
        if (m.type === 'joined') {c.code = m.code; resolve(c);}
        else if (m.type === 'pong' && c.recording) c.rtts.push(Date.now() - m.at);
        else if (m.type === 'error') reject(new Error(m.message));
      }
      if (frame && c.recording) {c.frames++; if (c.last) c.gaps.push(now - c.last); c.last = now;} else if (frame) c.last = now;
    });
  });
  const roomsOut = [];
  for (let r = 0; r < rooms; r++) {
    const host = await open('player', () => ({type: 'create', name: 'H' + r, role: 'runner', proto: proto === 2 ? 2 : undefined}));
    const group = [host];
    for (let i = 1; i < per; i++) group.push(await open('player', () => ({type: 'join', code: host.code, name: `P${r}-${i}`, role: ['runner', 'sentinel', 'engineer'][i % 3], proto: proto === 2 ? 2 : undefined})));
    for (let i = 0; i < spectators; i++) group.push(await open('spectator', () => ({type: 'spectate', code: host.code, name: `S${r}-${i}`, proto: proto === 2 ? 2 : undefined})));
    host.ws.send(JSON.stringify({type: 'start', bots: false})); roomsOut.push(group);
  }
  const players = all.filter(c => c.kind === 'player');
  // Random-walk "gameplay": hold a direction ~0.5 s, fire in bursts.
  const inputs = setInterval(() => {
    const now = Date.now();
    for (const c of players) {
      if (now >= c.hold.until) c.hold = {x: Math.round(Math.random() * 2 - 1), z: Math.round(Math.random() * 2 - 1), fire: Math.random() < .5, until: now + 200 + Math.random() * 700, angle: Math.random() * 6};
      const input = {x: c.hold.x, z: c.hold.z, angle: c.hold.angle, fire: c.hold.fire};
      let msg;
      if (proto === 2) {const out = c.gate.check(input); if (!out) continue; msg = JSON.stringify({type: 'input', seq: ++c.seq & 0xFFFF, input: out});}
      else msg = JSON.stringify({type: 'input', input});
      c.ws.send(msg); if (c.recording) {c.upBytes += msg.length; c.upMsgs++;}
    }
  }, 1000 / 30);
  const pings = setInterval(() => {for (const c of all) c.ws.send(JSON.stringify({type: 'ping', at: Date.now()}));}, 500);
  await sleep(warmup * 1000);
  for (const c of all) {c.recording = true; c.last = 0;}
  const t0 = performance.now(); await sleep(secs * 1000); const elapsed = (performance.now() - t0) / 1000;
  clearInterval(inputs); clearInterval(pings);
  const P = players, S = all.filter(c => c.kind === 'spectator'), mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const gaps = P.flatMap(c => c.gaps), rtts = P.flatMap(c => c.rtts);
  const out = {proto, rooms, playersPerRoom: per, spectatorsPerRoom: spectators, clients: all.length, secs: +elapsed.toFixed(1),
    playerDownKiBps: +(mean(P.map(c => c.bytes)) / elapsed / 1024).toFixed(1),
    spectatorDownKiBps: S.length ? +(mean(S.map(c => c.bytes)) / elapsed / 1024).toFixed(1) : null,
    totalDownMbit: +(all.reduce((a, c) => a + c.bytes, 0) * 8 / elapsed / 1e6).toFixed(2),
    playerFramesPerSec: +(mean(P.map(c => c.frames)) / elapsed).toFixed(1),
    playerUpMsgsPerSec: +(mean(P.map(c => c.upMsgs)) / elapsed).toFixed(1), playerUpKiBps: +(mean(P.map(c => c.upBytes)) / elapsed / 1024).toFixed(2),
    frameGapMs: {p50: +pct(gaps, .5)?.toFixed(1), p99: +pct(gaps, .99)?.toFixed(1), max: +Math.max(...gaps).toFixed(1)},
    pingMs: {n: rtts.length, p50: pct(rtts, .5), p95: pct(rtts, .95), max: rtts.length ? Math.max(...rtts) : null}};
  for (const c of all) c.ws.terminate();
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d;};
  console.log(JSON.stringify(await run({port: arg('port', 7860), rooms: arg('rooms', 1), per: arg('per', 10), spectators: arg('spectators', 0), secs: arg('secs', 10), proto: arg('proto', 2)}), null, 2));
  process.exit(0);
}
