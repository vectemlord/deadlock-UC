# Deadlock: Kernel Wars v1.3 — multiplayer netcode update

Goal: stop lag from growing as players join a room. Everything below is implemented, tested (`npm test`, 37 tests)
and measured head-to-head against v1.2 (`npm run evaluate`, results in `EVALUATION.md`).
Press **C** in the game (or the **Δ** tab on the left edge) to open the in-game sidebar with this list and live network numbers.

## What changed

| # | Area | Change | Files |
|---|---|---|---|
| 1 | Protocol | Per-tick state is a quantized **binary frame** (29 B header + 19 B/player + 10 B/bullet) instead of ~5 KB of JSON | `shared/codec.js` |
| 2 | Protocol | Static data (name, role, team, max HP) sent once in a `roster` message; feed events sent once as a reliable `events` message; `meta` carries host + spectator count | `server/index.js`, `src/app.js` |
| 3 | Server | **Backpressure**: a state frame is skipped when the client already has >16 KiB queued (`MAX_BUFFER`), instead of queueing stale data (v1.2 allowed 256 KB). Clients reporting RTT > 350 ms get 15 Hz | `server/index.js` |
| 4 | Server | One encode per room per tick shared by all recipients; spectators at 15 Hz (10 Hz when the loop is behind); idle rooms send a 2 Hz keep-alive | `server/index.js` |
| 5 | Client | **Snapshot interpolation**: other players are rendered ~2 ticks in the past on the server's tick timeline (adaptive 50–250 ms) | `src/netcode.js` |
| 6 | Client | **Client-side prediction + reconciliation** using the same `stepMover()` as the server; inputs are numbered, the server acks, unacknowledged inputs are replayed | `shared/game.js`, `src/netcode.js` |
| 7 | Input | Change-only input (+200 ms keep-alive), server-side sanitising, `try/catch` around handlers, malformed/binary/spam handling (close 1008 after 40 bad messages / 10 s) | `src/netcode.js`, `server/index.js` |
| 8 | Ops | Drift-corrected 30 Hz loop (the old `setInterval(…, 1000/30)` ran at 30.3 Hz); `GET /api/metrics`; stale-link warning after 1 s (was 12 s) | `server/index.js`, `src/app.js` |

Backward compatible: a client that does not send `proto: 2` (a v1.2 browser tab, the old tests) still receives JSON `state` messages.

## Wire format (proto 2)
`roster` `{type,v,players:[{id,name,role,team,bot,maxHp}]}` · `meta` `{type,host,spectators}` · `events` `{type,reset,events}` · binary `state`
(layout documented at the top of `shared/codec.js`). A state frame is only decoded when its roster version matches the last `roster` message.
Client → server input: `{type:'input', seq, input:{x,z,angle,fire?,interact?,rollback?,skill?,dash?}}`, sent only when changed.

## Configuration
`MAX_BUFFER` (bytes, default 16384) · `PORT` · `RECONNECT_GRACE_MS` (unchanged).

## Running and verifying
```
npm ci            # installs ws + three and vendors three.js
npm start         # http://localhost:7860 (open on other devices via http://<LAN-IP>:7860)
npm test          # 37 tests: game rules, legacy protocol, binary codec, prediction parity, backpressure, abuse handling
npm run evaluate  # v1.2 baseline (tools/baseline-v1.2) vs v1.3: bandwidth, CPU, throttled-uplink ping, prediction (writes EVALUATION.md)
curl localhost:7860/api/metrics
```
`tools/loadtest.mjs` (protocol-aware bot clients) and `tools/throttle-proxy.mjs` (bandwidth/latency-limited TCP proxy) can be used on their own.

## Known limits (please read)
* **Not exercised in a real browser** during development (no browser in the build sandbox). The netcode modules are unit-tested headlessly and the server is tested over real WebSockets, but the Three.js/DOM integration in `src/app.js` and the sidebar should be smoke-tested on your side: open two browser tabs, create a room, join, play, press **C**.
* Measurements come from one CPU core with emulated links, not from real phones or your real network. Treat absolute numbers as indicative.
* `bufferedAmount` backpressure only reacts once the OS socket buffer is full. Behind a tunnel/reverse proxy the server may never observe congestion, so the main protection is the ~20× smaller frames; the RTT-based halving at 350 ms is a second line of defence.
* Prediction covers movement, dash and the runner boost. Locks/interaction, shooting and damage stay server-authoritative (as before); mispredictions are blended away, or snapped when the error exceeds 3 units.
* Interpolation trades ~50–120 ms of visual delay for other players against smoothness.
* Frames carry at most 255 players/bullets/cycles; positions are quantized to 0.02 units.
