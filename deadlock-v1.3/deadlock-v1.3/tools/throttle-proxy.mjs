// TCP proxy that emulates a bandwidth-limited, higher-latency link (e.g. a home uplink behind a tunnel).
// Server->client bytes share ONE FIFO queue drained at `mbps`, so pings queue behind state frames exactly like
// on a saturated uplink. When the queue is full the proxy stops reading from the server (TCP backpressure).
import net from 'node:net';
import {performance} from 'node:perf_hooks';
export function startProxy({listen, targetPort, mbps = 8, delayMs = 20, queueBytes = 256 * 1024}) {
  const rate = mbps * 1e6 / 8, fifo = [], targets = new Set();
  let queued = 0, credit = 0, last = performance.now(), peakQueued = 0;
  const server = net.createServer(client => {
    const up = net.connect(targetPort, '127.0.0.1'); targets.add(up);
    client.setNoDelay(true); up.setNoDelay(true);
    client.on('data', d => setTimeout(() => {if (!up.destroyed) up.write(d);}, delayMs));
    up.on('data', d => {fifo.push({sock: client, buf: d, due: performance.now() + delayMs}); queued += d.length; peakQueued = Math.max(peakQueued, queued); if (queued > queueBytes) for (const t of targets) t.pause();});
    const end = () => {client.destroy(); up.destroy(); targets.delete(up);};
    client.on('close', end); up.on('close', end); client.on('error', end); up.on('error', end);
  });
  const timer = setInterval(() => {
    const now = performance.now(); credit = Math.min(credit + rate * (now - last) / 1000, rate * .05); last = now;
    while (fifo.length && fifo[0].due <= now) {
      const h = fifo[0];
      if (h.sock.destroyed) {queued -= h.buf.length; fifo.shift(); continue;}
      const n = Math.min(h.buf.length, Math.floor(credit)); if (n <= 0) break;
      h.sock.write(h.buf.subarray(0, n)); credit -= n; queued -= n;
      if (n === h.buf.length) fifo.shift(); else h.buf = h.buf.subarray(n);
    }
    if (queued < queueBytes / 2) for (const t of targets) t.resume();
  }, 2);
  server.listen(listen, '127.0.0.1');
  return {close: () => {clearInterval(timer); server.close(); for (const t of targets) t.destroy();}, stats: () => ({queued, peakQueued})};
}
