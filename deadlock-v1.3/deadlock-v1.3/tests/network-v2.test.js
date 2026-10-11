import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
import {decodeState} from '../shared/codec.js';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, limit = 4000) {const t = Date.now(); while (Date.now() - t < limit) {if (fn()) return; await wait(20);} throw new Error('Timed out');}
async function boot(port, env = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {env: {...process.env, PORT: String(port), ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  await until(() => log.includes(`localhost:${port}`)); return {child, log: () => log};
}
async function stop(child) {if (child.exitCode === null) {const done = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await done;}}
function client(port, sink) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const c = {ws, json: [], frames: [], bytes: 0, roster: null, events: []}; sink.push(c);
  ws.on('message', (data, isBinary) => {
    c.bytes += data.length;
    if (isBinary) {const d = decodeState(new Uint8Array(data), c.roster?.players, c.roster?.v); if (d && !d.stale) c.frames.push({d, size: data.length}); return;}
    const m = JSON.parse(data); c.json.push(m);
    if (m.type === 'roster') c.roster = m; if (m.type === 'meta') c.meta = m; if (m.type === 'events') c.events.push(...m.events); if (m.type === 'joined') c.id = m.id;
  });
  return new Promise((res, rej) => {ws.once('open', () => res(c)); ws.once('error', rej);});
}

test('protocol 2: roster + meta + events then ~250 byte binary frames; legacy client in the same room still gets JSON state', async () => {
  const {child} = await boot(17870), all = [];
  try {
    const host = await client(17870, all); host.ws.send(JSON.stringify({type: 'create', name: 'Host', role: 'runner', proto: 2}));
    await until(() => host.id && host.roster && host.meta);
    const old = await client(17870, all); old.ws.send(JSON.stringify({type: 'join', code: host.json.find(m => m.type === 'joined').code, name: 'Legacy'}));
    await until(() => old.id); await until(() => host.roster.players.length === 2);
    host.ws.send(JSON.stringify({type: 'start', bots: true}));
    await until(() => host.frames.length > 30 && host.frames.at(-1).d.phase === 'playing');
    assert.equal(host.roster.players.length, 10); assert.ok(host.frames.slice(-20).every(f => f.size < 700), 'frames stay small');
    assert.ok(host.events.length > 0, 'feed events arrive on the reliable channel');
    assert.ok(old.json.some(m => m.type === 'state' && m.state.players.length === 10), 'legacy JSON state still delivered');
    assert.ok(!old.json.some(m => m.type === 'roster'), 'legacy client never receives protocol-2 messages');
    const me = host.frames.at(-1).d.players.find(p => p.id === host.id), before = me.x;
    for (let i = 1; i <= 20; i++) {host.ws.send(JSON.stringify({type: 'input', seq: i, input: {x: 1, z: 0, angle: 0}})); await wait(34);}
    await until(() => host.frames.at(-1).d.players.find(p => p.id === host.id).x > before + 1);
    const ack = host.frames.at(-1).d.players.find(p => p.id === host.id).ack; assert.notEqual(ack, 0xFFFF); assert.ok(ack >= 15, `ack ${ack}`);
    const metrics = await (await fetch('http://127.0.0.1:17870/api/metrics')).json();
    assert.equal(metrics.version, '1.3'); assert.equal(metrics.protocol2Clients, 1); assert.ok(metrics.tick.avgMs < 5 && metrics.network.avgFrameBytes > 0);
  } finally {all.forEach(c => c.ws.terminate()); await stop(child);}
});
test('invalid, binary and oversized input never crashes the server; spammers are disconnected', async () => {
  const {child, log} = await boot(17871), all = [];
  try {
    const host = await client(17871, all); host.ws.send(JSON.stringify({type: 'create', name: 'H', proto: 2})); await until(() => host.id);
    host.ws.send(JSON.stringify({type: 'start', bots: true})); await until(() => host.frames.length > 5);
    for (const bad of ['{', 'null', '[]', JSON.stringify({type: 7}), JSON.stringify({type: 'input', input: 'x', seq: 'a'}), JSON.stringify({type: 'input', input: {x: 'NaN', z: {}, angle: 1e999, fire: 'yes'}, seq: -5})]) host.ws.send(bad);
    host.ws.send(Buffer.from([1, 2, 3]));
    await wait(200);
    const afterBad = host.frames.length; await wait(300); assert.ok(host.frames.length > afterBad, 'room keeps ticking');
    const spam = await client(17871, all); const closed = new Promise(r => spam.ws.once('close', code => r(code)));
    for (let i = 0; i < 80; i++) {spam.ws.send('not json'); if (i % 30 === 29) await wait(1000);}
    assert.equal(await Promise.race([closed, wait(5000).then(() => 'timeout')]), 1008);
    const m = await (await fetch('http://127.0.0.1:17871/api/metrics')).json(); assert.ok(m.errors.badMessages >= 40); assert.equal(m.errors.handler, 0);
    assert.ok(!log().includes('TypeError'), log());
  } finally {all.forEach(c => c.ws.terminate()); await stop(child);}
});
test('backpressure: congested sockets skip state frames but still receive reliable messages', async () => {
  const {child} = await boot(17872, {MAX_BUFFER: '-1'}), all = [];       // -1 makes every socket look congested
  try {
    const host = await client(17872, all); host.ws.send(JSON.stringify({type: 'create', name: 'H', proto: 2})); await until(() => host.id && host.roster);
    host.ws.send(JSON.stringify({type: 'start', bots: true})); await until(() => host.events.length > 0);
    await wait(1200);
    assert.equal(host.frames.length, 0, 'no state frames while congested');
    const m = await (await fetch('http://127.0.0.1:17872/api/metrics')).json(); assert.ok(m.network.framesDropped > 20 && m.network.dropRatePct > 90);
  } finally {all.forEach(c => c.ws.terminate()); await stop(child);}
});
test('rematch resets event ids without losing feed events (reset flag)', async () => {
  const {child} = await boot(17873), all = [];
  try {
    const host = await client(17873, all); host.ws.send(JSON.stringify({type: 'create', name: 'H', proto: 2})); await until(() => host.id && host.roster);
    host.ws.send(JSON.stringify({type: 'start', bots: true})); await until(() => host.events.length > 0 && host.frames.some(f => f.d.phase === 'playing'));
    host.ws.send(JSON.stringify({type: 'rematch'})); await until(() => host.json.some(m => m.type === 'events' && m.reset && m.events.length === 0));
    host.ws.send(JSON.stringify({type: 'start', bots: true})); await until(() => host.json.filter(m => m.type === 'events' && m.events.length).length >= 2 && host.frames.at(-1).d.phase === 'playing');
  } finally {all.forEach(c => c.ws.terminate()); await stop(child);}
});
