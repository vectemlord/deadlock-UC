// Deadlock v1.3 wire format ("proto 2").
//
// v1.2 sent the whole game state as JSON (~5.3 KB) to every client 30 times a second.
// v1.3 splits it into three message kinds:
//   roster  (JSON, reliable) static per-player data: id, name, role, team, bot, maxHp. Sent when it changes.
//   events  (JSON, reliable) only the new feed events.
//   state   (binary, droppable) everything that changes every tick, quantized, ~250 bytes for a 5v5 room.
//
// Layout (little endian). Header = 29 bytes:
//   0 u8 kind(1)   1 u8 flags   2 u8 rosterVersion   3 u8 playerCount   4 u16 tick   6 u16 time*100
//   8 u16 score0   10 u16 score1   12..15 u8 resource owner (player index + 1, 0 = free)
//   16 i8 uplink progress*100   17 u8 uplink owner (0 none, 1 team0, 2 team1)   18 u16 uplink next*10
//   20 u8 winner code   21 u16 deadlocks   23 u16 recoveries   25 u16 deliveries   27 u8 bulletCount   28 u8 cycleCount
// then playerCount * 19 bytes, bulletCount * 10 bytes, then cycles (u8 length + u8 player indexes each).
import {NODES} from './game.js';

export const PROTO = 2;
export const HEADER = 29, PLAYER_BYTES = 19, BULLET_BYTES = 10;
const POS = 50, TAU = Math.PI * 2, PHASES = ['lobby', 'playing', 'finished'];
const u8 = (v, max = 255) => Math.max(0, Math.min(max, Math.round(v)));
const ceil8 = (v) => Math.max(0, Math.min(255, Math.ceil(v - 1e-9)));
const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * POS)));
const angleToU16 = (a) => Math.round((((a % TAU) + TAU) % TAU) / TAU * 65535);
const angleToU8 = (a) => Math.round((((a % TAU) + TAU) % TAU) / TAU * 255) & 255;

export function rosterOf(game) {
  return game.players.map(p => ({id: p.id, name: p.name, role: p.role, team: p.team, bot: !!p.bot, maxHp: p.maxHp}));
}
export const rosterSignature = (game) => game.players.map(p => p.id).join('|');

export function encodeState(game, rosterVersion) {
  const players = game.players, bullets = game.bullets.slice(0, 255), cycles = game.cycles.slice(0, 255);
  const index = new Map(players.map((p, i) => [p.id, i]));
  let cycleBytes = 0; for (const c of cycles) cycleBytes += 1 + Math.min(c.length, 255);
  const buffer = new Uint8Array(HEADER + players.length * PLAYER_BYTES + bullets.length * BULLET_BYTES + cycleBytes);
  const v = new DataView(buffer.buffer);
  const u = game.uplink;
  v.setUint8(0, 1);
  v.setUint8(1, Math.max(0, PHASES.indexOf(game.phase)) | (game.blitz ? 4 : 0) | (u.active ? 8 : 0) | (u.contested ? 16 : 0));
  v.setUint8(2, rosterVersion & 255); v.setUint8(3, players.length);
  v.setUint16(4, game.tick & 0xFFFF, true);
  v.setUint16(6, Math.min(65535, Math.ceil(game.time * 100 - 1e-6)), true);
  v.setUint16(8, Math.min(65535, game.scores[0]), true); v.setUint16(10, Math.min(65535, game.scores[1]), true);
  game.resources.forEach((r, i) => v.setUint8(12 + i, r.owner && index.has(r.owner) ? index.get(r.owner) + 1 : 0));
  v.setInt8(16, Math.max(-100, Math.min(100, Math.round(u.progress * 100))));
  v.setUint8(17, u.owner === null || u.owner === undefined ? 0 : u.owner + 1);
  v.setUint16(18, Math.min(65535, Math.ceil(u.next * 10 - 1e-6)), true);
  v.setUint8(20, game.winner === undefined ? 0 : game.winner + 2);
  v.setUint16(21, Math.min(65535, game.stats.deadlocks), true); v.setUint16(23, Math.min(65535, game.stats.recoveries), true); v.setUint16(25, Math.min(65535, game.stats.deliveries), true);
  v.setUint8(27, bullets.length); v.setUint8(28, cycles.length);
  const resIndex = new Map(game.resources.map((r, i) => [r.id, i + 1]));
  let o = HEADER;
  for (const p of players) {
    v.setInt16(o, i16(p.x), true); v.setInt16(o + 2, i16(p.z), true); v.setUint16(o + 4, angleToU16(p.angle), true);
    v.setUint8(o + 6, ceil8(p.hp)); v.setUint8(o + 7, ceil8(p.respawn * 40));
    v.setUint8(o + 8, (resIndex.get(p.held[0]) || 0) | ((resIndex.get(p.held[1]) || 0) << 3));
    v.setUint8(o + 9, (resIndex.get(p.waiting) || 0) | (p.deadlocked ? 8 : 0) | (p.disconnected ? 16 : 0));
    v.setUint8(o + 10, ceil8(p.shield * 20)); v.setUint8(o + 11, ceil8(p.boost * 40));
    v.setUint8(o + 12, ceil8(p.skillCd * 20)); v.setUint8(o + 13, ceil8(p.dashCd * 50));
    v.setUint8(o + 14, u8(p.kills)); v.setUint8(o + 15, u8(p.deliveries)); v.setUint8(o + 16, u8(p.recoveries));
    v.setUint16(o + 17, game.ack(p), true);
    o += PLAYER_BYTES;
  }
  for (const b of bullets) {
    v.setUint32(o, b.id >>> 0, true); v.setInt16(o + 4, i16(b.x), true); v.setInt16(o + 6, i16(b.z), true);
    v.setUint8(o + 8, angleToU8(Math.atan2(b.dx, b.dz))); v.setUint8(o + 9, b.team);
    o += BULLET_BYTES;
  }
  for (const c of cycles) {
    const ids = c.slice(0, 255); v.setUint8(o++, ids.length);
    for (const id of ids) v.setUint8(o++, index.get(id) ?? 255);
  }
  return buffer;
}

// Returns a state object shaped like Game.snapshot() (events are filled in by the caller),
// {stale:true, rv} when the roster for this version has not arrived yet, or null for a malformed frame.
export function decodeState(bytes, roster, rosterVersion) {
  if (!bytes || bytes.length < HEADER || bytes[0] !== 1) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint8(3), nb = v.getUint8(27), nc = v.getUint8(28), rv = v.getUint8(2);
  if (bytes.length < HEADER + n * PLAYER_BYTES + nb * BULLET_BYTES) return null;
  if (rv !== (rosterVersion & 255) || !roster || roster.length !== n) return {stale: true, rv};
  const flags = v.getUint8(1);
  const ids = NODES.map(r => r.id);
  const players = [];
  let o = HEADER;
  for (let i = 0; i < n; i++, o += PLAYER_BYTES) {
    const r = roster[i], held = v.getUint8(o + 8), wait = v.getUint8(o + 9);
    players.push({id: r.id, name: r.name, role: r.role, team: r.team, bot: r.bot, maxHp: r.maxHp,
      x: v.getInt16(o, true) / POS, z: v.getInt16(o + 2, true) / POS, angle: v.getUint16(o + 4, true) / 65535 * TAU,
      hp: v.getUint8(o + 6), respawn: v.getUint8(o + 7) / 40,
      held: [held & 7, (held >> 3) & 7].filter(Boolean).map(k => ids[k - 1]), waiting: (wait & 7) ? ids[(wait & 7) - 1] : null,
      deadlocked: !!(wait & 8), disconnected: !!(wait & 16),
      shield: v.getUint8(o + 10) / 20, boost: v.getUint8(o + 11) / 40, skillCd: v.getUint8(o + 12) / 20, dashCd: v.getUint8(o + 13) / 50,
      kills: v.getUint8(o + 14), deliveries: v.getUint8(o + 15), recoveries: v.getUint8(o + 16), ack: v.getUint16(o + 17, true)});
  }
  const bullets = [];
  for (let i = 0; i < nb; i++, o += BULLET_BYTES) {
    const a = v.getUint8(o + 8) / 255 * TAU;
    bullets.push({id: v.getUint32(o, true), x: v.getInt16(o + 4, true) / POS, z: v.getInt16(o + 6, true) / POS, dx: Math.sin(a) * 30, dz: Math.cos(a) * 30, team: v.getUint8(o + 9)});
  }
  const cycles = [];
  for (let i = 0; i < nc && o < bytes.length; i++) {
    const len = v.getUint8(o++), cycle = [];
    for (let k = 0; k < len && o < bytes.length; k++) {const idx = v.getUint8(o++); if (players[idx]) cycle.push(players[idx].id);}
    cycles.push(cycle);
  }
  const owner = v.getUint8(17), winner = v.getUint8(20);
  return {
    players, bullets, cycles, events: [],
    resources: NODES.map((r, i) => ({...r, owner: v.getUint8(12 + i) ? players[v.getUint8(12 + i) - 1]?.id ?? null : null})),
    scores: [v.getUint16(8, true), v.getUint16(10, true)], time: v.getUint16(6, true) / 100,
    phase: PHASES[flags & 3] || 'lobby', tick: v.getUint16(4, true), blitz: !!(flags & 4),
    stats: {deadlocks: v.getUint16(21, true), recoveries: v.getUint16(23, true), deliveries: v.getUint16(25, true)},
    winner: winner ? winner - 2 : undefined,
    uplink: {active: !!(flags & 8), contested: !!(flags & 16), owner: owner ? owner - 1 : null, progress: v.getInt8(16) / 100, next: v.getUint16(18, true) / 10, pulse: 0},
  };
}
