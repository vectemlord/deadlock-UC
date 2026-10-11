# Evaluation: v1.2 vs v1.3

Generated 2026-10-07T05:51:26.444Z by `npm run evaluate`. Measured on 1 CPU core(s), Node v22.22.2, loopback + emulated links. Single-core sandbox: absolute CPU numbers include the load generator competing for the same core.

## Summary

| Metric | v1.2 | v1.3 |
|---|---|---|
| Snapshot on the wire (10 players) | 5.1 KB | 228 B |
| Download per player | 199.6 KiB/s | 9.7 KiB/s (-95%) |
| Upload per player | 30.1 msg/s | 5.8 msg/s |
| Room + 20 spectators, server out | 48.59 Mbit/s | 1.6 Mbit/s |
| Server CPU, 100 players (10 rooms) | 21.1% of 1 core | 9.4% of 1 core |
| Ping, 10 Mbit uplink (p50 / p95) | 241 / 2238 ms | 33 / 35 ms |
| Ping, 4 Mbit uplink (p50 / p95) | 606 / 6180 ms | 32 / 34 ms |
| Key press to movement @ 150 ms RTT | 201 ms | 18 ms |

## Direct (loopback) scenarios

| Scenario | Version | Down/player KiB/s | Frames/s | Up msg/s | Total out Mbit/s | Frame gap p50/p99/max ms | Ping p50/p95/max ms | Server CPU % |
|---|---|---|---|---|---|---|---|---|
| 1 room x 10 players | v1.2 | 199.6 | 30 | 30.1 | 16.35 | 33.2/42.4/51.5 | 1/2/3 | 5.1 |
| 1 room x 10 players | v1.3 | 9.7 | 30 | 5.8 | 0.79 | 33.4/53.7/104.6 | 1/2/12 | 3.9 |
| 10 rooms x 10 players | v1.2 | 194.8 | 30.1 | 30.2 | 159.54 | 33/39.3/45.2 | 4/11/17 | 21.1 |
| 10 rooms x 10 players | v1.3 | 9.7 | 30 | 5.8 | 7.94 | 33.3/36.9/71.4 | 3/8/10 | 9.4 |
| 1 room x 10 players + 20 spectators | v1.2 | 197.7 | 30.1 | 30.1 | 48.59 | 33.2/37.7/45.7 | 1/6/6 | 8.1 |
| 1 room x 10 players + 20 spectators | v1.3 | 9.8 | 30 | 5.9 | 1.6 | 33.3/42.6/46.5 | 1/2/2 | 3.9 |

## Bandwidth-limited uplink (1 room, 10 players)

| Link | Version | Down/player KiB/s | Frames/s | Frame gap p50/p99/max ms | Ping p50/p95/max ms | Peak proxy queue KiB |
|---|---|---|---|---|---|---|
| 10 Mbit uplink, 30 ms RTT | v1.2 | 122.8 | 19.3 | 5.7/251.2/3360.6 | 241/2238/9398 | 320 |
| 10 Mbit uplink, 30 ms RTT | v1.3 | 10 | 30 | 33.3/38.8/53.4 | 33/35/36 | 15 |
| 4 Mbit uplink, 30 ms RTT | v1.2 | 48.8 | 7.5 | 13.3/493.9/1046 | 606/6180/7559 | 318 |
| 4 Mbit uplink, 30 ms RTT | v1.3 | 9.8 | 29.9 | 33.3/38.1/44.3 | 32/34/35 | 15 |

## Client prediction (headless simulation)

| RTT ms | Key press to movement, no prediction | with prediction | Avg reconcile error (units) | Max error | Hard snaps | Corrections / reconciles |
|---|---|---|---|---|---|---|
| 40 | 92 ms | 18 ms | 0.011 | 0.2 | 0 | 66 / 1796 |
| 150 | 201 ms | 18 ms | 0.091 | 1.3 | 0 | 1041 / 1792 |
| 300 | 351 ms | 18 ms | 0.044 | 2.43 | 0 | 407 / 1785 |

