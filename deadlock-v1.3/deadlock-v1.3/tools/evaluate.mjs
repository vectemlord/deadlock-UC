// Head-to-head evaluation of the v1.2 baseline vs this build. Usage: npm run evaluate
// Writes evaluation/results.json, EVALUATION.md and src/results.js (rows shown in the in-game sidebar).
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {run} from './loadtest.mjs';
import {startProxy} from './throttle-proxy.mjs';
import {simulate} from './predict-sim.mjs';
import {Game} from '../shared/game.js';
import {encodeState} from '../shared/codec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = path.join(root, 'tools/baseline-v1.2/server/index.js'), NEW = path.join(root, 'server/index.js');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cpuSeconds = (pid) => {const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100;};
let nextPort = 18100;

async function withServer(entry, fn) {
  const port = nextPort += 3;
  const child = spawn(process.execPath, [entry], {env: {...process.env, PORT: String(port)}, stdio: 'ignore'});
  for (let i = 0; i < 50; i++) {try {if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;} catch {} await sleep(100);}
  const c0 = cpuSeconds(child.pid), t0 = Date.now();
  try {const result = await fn(port, child.pid); const wall = (Date.now() - t0) / 1000; return {...result, serverCpuPct: +((cpuSeconds(child.pid) - c0) / wall * 100).toFixed(1)};}
  finally {child.kill('SIGKILL'); await sleep(200);}
}
const label = (e) => e === OLD ? 'v1.2' : 'v1.3';
const proto = (e) => e === OLD ? 1 : 2;
const log = (...a) => console.error(...a);

const results = {generatedAt: new Date().toISOString(), host: {cpus: os.cpus().length, model: os.cpus()[0]?.model, node: process.version}, direct: [], throttled: [], prediction: [], snapshot: {}};

// 1. wire size of one 5v5 snapshot
{
  const g = new Game(); for (let i = 0; i < 10; i++) g.addPlayer('p' + i, 'P' + i, ['runner', 'sentinel', 'engineer'][i % 3], i % 2, true); g.start(false);
  let json = 0, bin = 0; const n = 900; for (let i = 0; i < n; i++) {g.update(1 / 30); json += JSON.stringify({type: 'state', state: g.snapshot(), host: 'x', spectators: 0}).length; bin += encodeState(g, 1).length;}
  results.snapshot = {jsonBytes: Math.round(json / n), binaryBytes: Math.round(bin / n)};
  log('snapshot', results.snapshot);
}
// 2. direct (loopback) scenarios
for (const [name, opts] of [['1 room x 10 players', {rooms: 1, per: 10, secs: 10}], ['10 rooms x 10 players', {rooms: 10, per: 10, secs: 10}], ['1 room x 10 players + 20 spectators', {rooms: 1, per: 10, spectators: 20, secs: 10}]]) {
  for (const entry of [OLD, NEW]) {
    log('direct', name, label(entry));
    const r = await withServer(entry, (port) => run({port, proto: proto(entry), ...opts}));
    results.direct.push({scenario: name, version: label(entry), ...r});
  }
}
// 3. bandwidth-limited uplink behind a proxy (emulates hosting from a home connection)
for (const link of [{mbps: 10, delayMs: 15, name: '10 Mbit uplink, 30 ms RTT'}, {mbps: 4, delayMs: 15, name: '4 Mbit uplink, 30 ms RTT'}]) {
  for (const entry of [OLD, NEW]) {
    log('throttled', link.name, label(entry));
    const r = await withServer(entry, async (port) => {
      const proxy = startProxy({listen: port + 1, targetPort: port, mbps: link.mbps, delayMs: link.delayMs});
      try {const out = await run({port: port + 1, proto: proto(entry), rooms: 1, per: 10, spectators: 0, secs: 14, warmup: 2}); return {...out, proxy: proxy.stats()};}
      finally {proxy.close();}
    });
    results.throttled.push({link: link.name, version: label(entry), ...r});
  }
}
// 4. client prediction (headless, real Game + real codec + real Predictor)
for (const rtt of [40, 150, 300]) {
  const press = (prediction) => {const xs = Array.from({length: 40}, (_, i) => simulate({oneWayMs: rtt / 2, seconds: 3, script: 'press', prediction, seed: 100 + i}).firstMotionMs); return xs.reduce((a, b) => a + b, 0) / xs.length;};   // mean over 40 random phase offsets
  const noisy = simulate({oneWayMs: rtt / 2, jitterMs: 15, seconds: 60, seed: rtt});
  results.prediction.push({rttMs: rtt, inputToMotionWithoutMs: Math.round(press(false)), inputToMotionWithMs: Math.round(press(true)), avgErrUnits: +noisy.avgErr.toFixed(3), maxErrUnits: +noisy.maxErr.toFixed(2), hardSnaps: noisy.snaps, corrections: noisy.corrections, reconciles: noisy.reconciles});
}
mkdirSync(path.join(root, 'evaluation'), {recursive: true});
writeFileSync(path.join(root, 'evaluation/results.json'), JSON.stringify(results, null, 2));

// ---- report ----
const d = (sc, v) => results.direct.find(r => r.scenario === sc && r.version === v);
const t = (l, v) => results.throttled.find(r => r.link === l && r.version === v);
const pctDown = (a, b) => `-${Math.round((1 - b / a) * 100)}%`;
const s1 = '1 room x 10 players', s10 = '10 rooms x 10 players', s20 = '1 room x 10 players + 20 spectators';
const rows = [
  ['Snapshot on the wire (10 players)', `${(results.snapshot.jsonBytes / 1024).toFixed(1)} KB`, `${results.snapshot.binaryBytes} B`],
  ['Download per player', `${d(s1, 'v1.2').playerDownKiBps} KiB/s`, `${d(s1, 'v1.3').playerDownKiBps} KiB/s (${pctDown(d(s1, 'v1.2').playerDownKiBps, d(s1, 'v1.3').playerDownKiBps)})`],
  ['Upload per player', `${d(s1, 'v1.2').playerUpMsgsPerSec} msg/s`, `${d(s1, 'v1.3').playerUpMsgsPerSec} msg/s`],
  ['Room + 20 spectators, server out', `${d(s20, 'v1.2').totalDownMbit} Mbit/s`, `${d(s20, 'v1.3').totalDownMbit} Mbit/s`],
  ['Server CPU, 100 players (10 rooms)', `${d(s10, 'v1.2').serverCpuPct}% of 1 core`, `${d(s10, 'v1.3').serverCpuPct}% of 1 core`],
  ['Ping, 10 Mbit uplink (p50 / p95)', `${t('10 Mbit uplink, 30 ms RTT', 'v1.2').pingMs.p50} / ${t('10 Mbit uplink, 30 ms RTT', 'v1.2').pingMs.p95} ms`, `${t('10 Mbit uplink, 30 ms RTT', 'v1.3').pingMs.p50} / ${t('10 Mbit uplink, 30 ms RTT', 'v1.3').pingMs.p95} ms`],
  ['Ping, 4 Mbit uplink (p50 / p95)', `${t('4 Mbit uplink, 30 ms RTT', 'v1.2').pingMs.p50} / ${t('4 Mbit uplink, 30 ms RTT', 'v1.2').pingMs.p95} ms`, `${t('4 Mbit uplink, 30 ms RTT', 'v1.3').pingMs.p50} / ${t('4 Mbit uplink, 30 ms RTT', 'v1.3').pingMs.p95} ms`],
  [`Key press to movement @ ${results.prediction[1].rttMs} ms RTT`, `${results.prediction[1].inputToMotionWithoutMs} ms`, `${results.prediction[1].inputToMotionWithMs} ms`],
];
const note = `Measured on ${results.host.cpus} CPU core(s), Node ${results.host.node}, loopback + emulated links. Single-core sandbox: absolute CPU numbers include the load generator competing for the same core.`;
writeFileSync(path.join(root, 'src/results.js'), `// Generated by tools/evaluate.mjs on ${results.generatedAt}\nexport const RESULTS = ${JSON.stringify({rows, note}, null, 2)};\n`);
const table = (head, body) => `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${body.map(r => `| ${r.join(' | ')} |`).join('\n')}\n`;
const md = `# Evaluation: v1.2 vs v1.3\n\nGenerated ${results.generatedAt} by \`npm run evaluate\`. ${note}\n\n## Summary\n\n${table(['Metric', 'v1.2', 'v1.3'], rows)}\n## Direct (loopback) scenarios\n\n${table(['Scenario', 'Version', 'Down/player KiB/s', 'Frames/s', 'Up msg/s', 'Total out Mbit/s', 'Frame gap p50/p99/max ms', 'Ping p50/p95/max ms', 'Server CPU %'], results.direct.map(r => [r.scenario, r.version, r.playerDownKiBps, r.playerFramesPerSec, r.playerUpMsgsPerSec, r.totalDownMbit, `${r.frameGapMs.p50}/${r.frameGapMs.p99}/${r.frameGapMs.max}`, `${r.pingMs.p50}/${r.pingMs.p95}/${r.pingMs.max}`, r.serverCpuPct]))}\n## Bandwidth-limited uplink (1 room, 10 players)\n\n${table(['Link', 'Version', 'Down/player KiB/s', 'Frames/s', 'Frame gap p50/p99/max ms', 'Ping p50/p95/max ms', 'Peak proxy queue KiB'], results.throttled.map(r => [r.link, r.version, r.playerDownKiBps, r.playerFramesPerSec, `${r.frameGapMs.p50}/${r.frameGapMs.p99}/${r.frameGapMs.max}`, `${r.pingMs.p50}/${r.pingMs.p95}/${r.pingMs.max}`, Math.round(r.proxy.peakQueued / 1024)]))}\n## Client prediction (headless simulation)\n\n${table(['RTT ms', 'Key press to movement, no prediction', 'with prediction', 'Avg reconcile error (units)', 'Max error', 'Hard snaps', 'Corrections / reconciles'], results.prediction.map(r => [r.rttMs, `${r.inputToMotionWithoutMs} ms`, `${r.inputToMotionWithMs} ms`, r.avgErrUnits, r.maxErrUnits, r.hardSnaps, `${r.corrections} / ${r.reconciles}`]))}\n`;
writeFileSync(path.join(root, 'EVALUATION.md'), md);
console.log(md);
process.exit(0);
