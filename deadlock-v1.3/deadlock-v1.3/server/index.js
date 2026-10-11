import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {WebSocketServer} from 'ws';
import {Game} from '../shared/game.js';
import {encodeState, rosterOf, rosterSignature} from '../shared/codec.js';

const VERSION = '1.3';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rooms = new Map();
const reconnectGrace = Number(process.env.RECONNECT_GRACE_MS) || 45000;
const TICK_MS = 1000 / 30;
// v1.3 backpressure: a state frame is only sent while the client's socket has less than this queued.
// v1.2 allowed 256 000 bytes (~1 s of data), so a slow link accumulated a second of stale state.
const MAX_BUFFER = Number(process.env.MAX_BUFFER) || 16 * 1024;
const RELIABLE_LIMIT = 256000;           // roster/meta/events/errors are tiny and must not be dropped
const LOBBY_INTERVAL = 500;              // idle (lobby / finished) rooms only need a keep-alive state
const SPECTATOR_STRIDE = 2;              // spectators get 15 Hz; client interpolation hides the lower rate
const DEGRADED_STRIDE = 3;               // ...and 10 Hz while the server is behind its tick budget
const SLOW_RTT_MS = 350;                 // clients reporting a higher RTT get 15 Hz state
const BAD_LIMIT = 40;                    // invalid messages tolerated per 10 s before the socket is closed
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'};

// ---------- metrics (exposed on /api/metrics) ----------
const ring = new Float32Array(600);
const metrics = {started: Date.now(), ticks: 0, overruns: 0, maxLagMs: 0, errors: 0, badMessages: 0,
  bytesOut: 0, framesOut: 0, framesDropped: 0, window: [], lastBytes: 0};
let loadEma = 0, degraded = false;
const pct = (arr, p) => {const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;};
function metricsSnapshot() {
  const filled = ring.subarray(0, Math.min(metrics.ticks, ring.length));
  const sum = filled.reduce((a, b) => a + b, 0);
  const clients = [...wss.clients].filter(ws => ws.readyState === 1);
  const rtts = clients.map(ws => ws.rtt).filter(Number.isFinite);
  const recent = metrics.window.filter(w => Date.now() - w.t < 5000);
  const span = recent.length ? Math.max(1, (Date.now() - recent[0].t) / 1000) : 1;
  const recentBytes = recent.reduce((a, w) => a + w.bytes, 0);
  return {
    ok: true, version: VERSION, uptimeS: Math.round((Date.now() - metrics.started) / 1000),
    rooms: rooms.size, clients: clients.length, protocol2Clients: clients.filter(ws => ws.proto === 2).length, degraded,
    tick: {budgetMs: +TICK_MS.toFixed(2), avgMs: +(filled.length ? sum / filled.length : 0).toFixed(3), p95Ms: +pct(filled, .95).toFixed(3), maxMs: +Math.max(0, ...filled).toFixed(3), overruns: metrics.overruns, maxLagMs: +metrics.maxLagMs.toFixed(1)},
    network: {outKiBps: +(recentBytes / span / 1024).toFixed(1), framesOut: metrics.framesOut, framesDropped: metrics.framesDropped,
      dropRatePct: +(metrics.framesOut + metrics.framesDropped ? metrics.framesDropped / (metrics.framesOut + metrics.framesDropped) * 100 : 0).toFixed(2),
      avgFrameBytes: metrics.framesOut ? Math.round(metrics.bytesOut / metrics.framesOut) : 0},
    rtt: {reported: rtts.length, avgMs: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null, maxMs: rtts.length ? Math.max(...rtts) : null},
    errors: {handler: metrics.errors, badMessages: metrics.badMessages},
    roomList: [...rooms.values()].slice(0, 20).map(r => ({code: r.code, phase: r.game.phase, players: r.clients.size, spectators: r.spectators.size, tickMs: +r.ema.toFixed(3)})),
  };
}

// ---------- static files + health ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: true, version: VERSION, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0), spectators: [...rooms.values()].reduce((n, r) => n + r.spectators.size, 0)}));
    return;
  }
  if (url.pathname === '/api/metrics') {res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(metricsSnapshot())); return;}
  let name; try {name = decodeURIComponent(url.pathname);} catch {res.writeHead(400); res.end(); return;}
  if (name === '/') name = '/index.html';
  const allowed = name === '/index.html' || name === '/style.css' || /^\/(src|shared|public)\/[\w./-]+$/.test(name);
  const file = path.resolve(root, `.${name}`);
  if (!allowed || name.split('/').some(part => part === '..' || part === '.') || !file.startsWith(root + path.sep)) {res.writeHead(404); res.end('Not found'); return;}
  try {const data = await readFile(file); res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache'}); res.end(data);}
  catch {res.writeHead(404); res.end('Not found');}
});
const wss = new WebSocketServer({server, path: '/ws', maxPayload: 4096});

// ---------- sending ----------
// Reliable control messages. Rarely sent and tiny, so only the old generous limit applies.
const send = (ws, data) => {if (ws.readyState === 1 && ws.bufferedAmount < RELIABLE_LIMIT) ws.send(typeof data === 'string' ? data : JSON.stringify(data));};
// Droppable state frame. State is idempotent (the newest frame supersedes older ones),
// so when the socket is congested we skip a frame instead of queueing stale data behind it.
function sendFrame(ws, payload) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_BUFFER) {ws.dropped = (ws.dropped || 0) + 1; metrics.framesDropped++; return;}
  ws.send(payload);
  const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
  metrics.bytesOut += bytes; metrics.framesOut++; metrics.lastBytes += bytes;
}

function cleanup(room) {
  if (!room.clients.size && ![...room.pending.values()].some(p => !p.spectating)) {
    for (const viewer of room.spectators.values()) {send(viewer, {type: 'room_closed', message: 'Semua pemain sudah keluar. Room ditutup.'}); viewer.room = null; viewer.spectating = false;}
    rooms.delete(room.code);
  } else if (!room.clients.has(room.host) && room.clients.size) room.host = room.clients.keys().next().value;
}
function leave(ws, temporary = false) {
  const room = rooms.get(ws.room); if (!room) return;
  if (ws.spectating) room.spectators.delete(ws.id);
  else room.clients.delete(ws.id);
  if (temporary) {
    room.pending.set(ws.token, {id: ws.id, spectating: !!ws.spectating, expires: Date.now() + reconnectGrace});
    const p = room.game.players.find(p => p.id === ws.id);
    if (p) {room.game.release(p); p.input = {}; p.shield = 0; p.boost = 0; p.disconnected = true;}
  } else if (!ws.spectating) {room.game.removePlayer(ws.id);}
  cleanup(room);
  ws.room = null; ws.spectating = false;
}
function expire(room) {
  for (const [token, p] of room.pending) {if (p.expires <= Date.now()) {if (!p.spectating) room.game.removePlayer(p.id); room.pending.delete(token);}}
  cleanup(room);
}
function newRoom(ws, code) {
  return {game: new Game(), clients: new Map(), spectators: new Map(), pending: new Map(), host: ws.id, code,
    rv: 0, rosterSig: null, rosterMsg: '', rosterDirty: false, metaKey: '', metaMsg: '', metaDirty: false,
    lastEventId: 0, lastPhase: '', lastSentAt: 0, frame: 0, ema: 0};
}
// Recompute the roster / meta messages. Dirty flags are cleared only by broadcast(), so a refresh
// triggered by a join can never swallow an update the rest of the room still has to receive.
function refreshRoomMeta(room) {
  const sig = rosterSignature(room.game);
  if (sig !== room.rosterSig) {
    room.rosterSig = sig; room.rv = (room.rv + 1) & 255; room.rosterDirty = true;
    room.rosterMsg = JSON.stringify({type: 'roster', v: room.rv, players: rosterOf(room.game)});
  }
  const metaKey = `${room.host}|${room.spectators.size}`;
  if (metaKey !== room.metaKey) {room.metaKey = metaKey; room.metaDirty = true; room.metaMsg = JSON.stringify({type: 'meta', host: room.host, spectators: room.spectators.size});}
}
// Everything a protocol-2 client needs before it can decode state frames.
function initialSync(ws, room) {
  if (ws.proto !== 2) return;
  refreshRoomMeta(room);
  send(ws, room.rosterMsg); send(ws, room.metaMsg);
  send(ws, {type: 'events', reset: true, events: room.game.events});
  sendFrame(ws, encodeState(room.game, room.rv));
}
function joined(ws, room, resumed = false) {
  send(ws, {type: 'joined', id: ws.id, code: room.code, spectator: !!ws.spectating, token: ws.token, resumed});
  initialSync(ws, room);
}
function resume(ws, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase());
  if (room) expire(room);
  const saved = room?.pending.get(msg.token);
  if (!room || !rooms.has(room.code) || !saved) {send(ws, {type: 'resume_failed', message: 'Sesi tidak tersedia atau batas sambung ulang 45 detik sudah habis. Silakan gabung kembali.'}); return;}
  room.pending.delete(msg.token);
  ws.id = saved.id; ws.token = msg.token; ws.room = room.code; ws.spectating = saved.spectating;
  if (ws.spectating) room.spectators.set(ws.id, ws);
  else {
    room.clients.set(ws.id, ws);
    const p = room.game.players.find(p => p.id === ws.id); if (p) p.disconnected = false;
    if (!room.clients.has(room.host)) room.host = ws.id;
  }
  joined(ws, room, true);
}

// ---------- input validation ----------
const num = (v, lo, hi, fallback = 0) => (typeof v === 'number' && Number.isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : fallback;
function sanitizeInput(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return {x: num(raw.x, -1, 1), z: num(raw.z, -1, 1), angle: typeof raw.angle === 'number' && Number.isFinite(raw.angle) ? num(raw.angle, -1000, 1000) : undefined,
    fire: raw.fire === true, interact: raw.interact === true, rollback: raw.rollback === true, skill: raw.skill === true, dash: raw.dash === true};
}
function reject(ws) {
  metrics.badMessages++;
  const now = Date.now();
  if (now - (ws.badWindow || 0) > 10000) {ws.badWindow = now; ws.bad = 0;}
  if (++ws.bad > BAD_LIMIT) ws.close(1008, 'too many invalid messages');
}

wss.on('connection', ws => {
  ws.id = randomUUID(); ws.token = randomBytes(24).toString('hex'); ws.alive = true; ws.window = Date.now(); ws.count = 0; ws.proto = 1; ws.dropped = 0;
  ws.on('pong', () => ws.alive = true);
  ws.on('error', () => {});
  ws.on('message', (raw, isBinary) => {
    try {handleMessage(ws, raw, isBinary);}
    catch (err) {metrics.errors++; console.error('message handler error:', err?.message || err);}   // one bad packet must never stop the tick loop
  });
  ws.on('close', () => leave(ws, true));
});

function handleMessage(ws, raw, isBinary) {
  if (Date.now() - ws.window > 1000) {ws.window = Date.now(); ws.count = 0;}
  if (++ws.count > 90) return;
  if (isBinary) {reject(ws); return;}
  let msg; try {msg = JSON.parse(raw);} catch {reject(ws); return;}
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {reject(ws); return;}
  if (msg.type === 'ping') {
    if (Number.isFinite(msg.rtt)) ws.rtt = Math.max(0, Math.min(10000, msg.rtt));
    send(ws, {type: 'pong', at: msg.at}); return;
  }
  if (msg.type === 'leave') {leave(ws); return;}
  if (msg.type === 'resume' && !ws.room) {ws.proto = msg.proto === 2 ? 2 : 1; resume(ws, msg); return;}
  if (msg.type === 'create' || msg.type === 'join' || msg.type === 'spectate') {
    if (ws.room) return;
    ws.proto = msg.proto === 2 ? 2 : 1;
    let room, code;
    if (msg.type === 'create') {
      if (rooms.size >= 100) {send(ws, {type: 'error', message: 'Server penuh. Coba beberapa saat lagi.'}); return;}
      code = randomBytes(3).toString('hex').toUpperCase();
      while (rooms.has(code)) code = randomBytes(3).toString('hex').toUpperCase();
      room = newRoom(ws, code); rooms.set(code, room);
    } else {code = String(msg.code || '').toUpperCase(); room = rooms.get(code);}
    if (!room) {send(ws, {type: 'error', message: 'Room tidak ditemukan. Periksa kode undangan.'}); return;}
    if (msg.type === 'spectate') {
      if (room.spectators.size + [...room.pending.values()].filter(p => p.spectating).length >= 20) {send(ws, {type: 'error', message: 'Slot penonton penuh (maksimal 20).'}); return;}
      room.spectators.set(ws.id, ws); ws.room = code; ws.spectating = true;
      joined(ws, room); return;
    }
    if (room.game.phase === 'finished') {send(ws, {type: 'error', message: 'Pertandingan sudah selesai. Buat room baru.'}); return;}
    const humans = [0, 1].map(t => room.game.players.filter(p => p.team === t && !p.bot).length);
    const team = humans[0] <= humans[1] ? 0 : 1;
    if (humans[team] >= 5) {send(ws, {type: 'error', message: 'Room penuh: maksimal 10 pemain.'}); return;}
    const bot = room.game.players.find(p => p.bot && p.team === team); if (bot) room.game.removePlayer(bot.id);
    const player = room.game.addPlayer(ws.id, typeof msg.name === 'string' ? msg.name : undefined, typeof msg.role === 'string' ? msg.role : undefined, team);
    if (!player) {send(ws, {type: 'error', message: 'Tim penuh.'}); return;}
    room.clients.set(ws.id, ws); ws.room = code;
    joined(ws, room); return;
  }
  const room = rooms.get(ws.room); if (!room || ws.spectating) return;
  if (msg.type === 'input') room.game.input(ws.id, sanitizeInput(msg.input), msg.seq);
  else if (msg.type === 'rematch' && room.host === ws.id) room.game.rematch();
  else if (msg.type === 'start' && room.host === ws.id && room.game.phase === 'lobby') {
    if (!msg.bots && room.clients.size < 2) {send(ws, {type: 'error', message: 'Butuh minimal 2 pemain, atau aktifkan bot.'}); return;}
    room.game.start(msg.bots !== false);
  }
}

// ---------- per-room broadcast ----------
function broadcast(room, now) {
  const game = room.game;
  refreshRoomMeta(room);
  const rosterChanged = room.rosterDirty, metaChanged = room.metaDirty;
  room.rosterDirty = room.metaDirty = false;
  const everyone = [...room.clients.values(), ...room.spectators.values()];
  const v2 = everyone.filter(ws => ws.proto === 2);
  if (rosterChanged) for (const ws of v2) send(ws, room.rosterMsg);
  if (metaChanged) for (const ws of v2) send(ws, room.metaMsg);
  // New feed events go out once, reliably. (Event ids restart when a rematch builds a fresh Game.)
  const newest = game.events.length ? game.events[game.events.length - 1].id : 0;
  let reset = false;
  if (newest < room.lastEventId) {room.lastEventId = 0; reset = true;}
  const fresh = game.events.filter(e => e.id > room.lastEventId);
  if (fresh.length || reset) {room.lastEventId = Math.max(room.lastEventId, newest); const msg = JSON.stringify({type: 'events', reset, events: fresh}); for (const ws of v2) send(ws, msg);}

  room.frame++;
  const phaseChanged = game.phase !== room.lastPhase; room.lastPhase = game.phase;
  const due = game.phase === 'playing' || phaseChanged || rosterChanged || metaChanged || now - room.lastSentAt >= LOBBY_INTERVAL;
  if (!due) return;
  room.lastSentAt = now;
  const force = phaseChanged || rosterChanged || metaChanged;
  const spectatorTurn = force || room.frame % (degraded ? DEGRADED_STRIDE : SPECTATOR_STRIDE) === 0;
  // Serialize once per wire format, then hand the same buffer to every recipient.
  let binary = null, json = null;
  const encodeBinary = () => binary ||= encodeState(game, room.rv);
  const encodeJson = () => json ||= JSON.stringify({type: 'state', state: game.snapshot(), host: room.host, spectators: room.spectators.size});
  for (const ws of room.clients.values()) {
    if (!force && ws.rtt > SLOW_RTT_MS && room.frame % 2) continue;      // very slow link (client-reported RTT): halve its rate
    sendFrame(ws, ws.proto === 2 ? encodeBinary() : encodeJson());
  }
  if (spectatorTurn) for (const ws of room.spectators.values()) sendFrame(ws, ws.proto === 2 ? encodeBinary() : encodeJson());
}

// ---------- drift-corrected 30 Hz loop ----------
// setInterval(…, 1000/30) truncates to 33 ms (30.3 Hz) and drifts; schedule against an absolute clock instead.
let nextTick = performance.now() + TICK_MS, timer = null, stopped = false;
function loop() {
  if (stopped) return;
  const started = performance.now();
  metrics.maxLagMs = Math.max(metrics.maxLagMs * .999, started - nextTick);   // how late this tick started
  for (const room of [...rooms.values()]) {
    try {
      expire(room); if (!rooms.has(room.code)) continue;
      const t0 = performance.now();
      room.game.update(1 / 30);
      broadcast(room, Date.now());
      room.ema = room.ema * .9 + (performance.now() - t0) * .1;
    } catch (err) {metrics.errors++; console.error('room tick error:', err?.stack || err);}
  }
  const spent = performance.now() - started;
  ring[metrics.ticks++ % ring.length] = spent;
  if (spent > TICK_MS) metrics.overruns++;
  loadEma = loadEma * .9 + spent * .1;
  if (!degraded && loadEma > 18) degraded = true; else if (degraded && loadEma < 12) degraded = false;
  const stamp = Date.now();
  if (!metrics.window.length || stamp - metrics.window[metrics.window.length - 1].t >= 1000) {metrics.window.push({t: stamp, bytes: metrics.lastBytes}); metrics.lastBytes = 0; if (metrics.window.length > 10) metrics.window.shift();}
  nextTick += TICK_MS;
  const now = performance.now();
  if (now - nextTick > TICK_MS * 3) nextTick = now;     // far behind: skip ahead instead of spiralling
  timer = setTimeout(loop, Math.max(0, nextTick - now));
}
timer = setTimeout(loop, TICK_MS);
const heartbeat = setInterval(() => {for (const ws of wss.clients) {if (!ws.alive) {ws.terminate(); continue;} ws.alive = false; ws.ping();}}, 15000);
const port = Number(process.env.PORT) || 7860;
server.listen(port, '0.0.0.0', () => console.log(`DEADLOCK: Kernel Wars • http://localhost:${port}`));
function shutdown() {stopped = true; clearTimeout(timer); clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close();}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
