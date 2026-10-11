// In-game sidebar: live network telemetry, measured results and the list of v1.3 code changes. Toggle with C.
import {CHANGES} from './changes.js';
import {RESULTS} from './results.js';

const esc = (v) => String(v).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = (v, d = 0) => Number.isFinite(v) ? v.toFixed(d) : '—';

export function initSidebar(readTelemetry) {
  const tab = document.createElement('button');
  tab.id = 'changes-toggle'; tab.setAttribute('aria-expanded', 'false'); tab.title = 'Perubahan kode v1.3 (C)';
  tab.innerHTML = '<b>Δ</b><span>v1.3 CHANGES</span>';
  const side = document.createElement('aside');
  side.id = 'changes-sidebar'; side.className = 'hidden'; side.setAttribute('aria-label', 'Perubahan kode versi 1.3');
  const results = RESULTS ? `<section class="cs-block"><h3>MEASURED · v1.2 → v1.3</h3><table class="cs-table">${RESULTS.rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('')}</table><p class="cs-note">${esc(RESULTS.note)}</p></section>` : '';
  side.innerHTML = `<header><div><small>BUILD 1.3 · NETCODE</small><h2>Code changes</h2></div><button class="icon-button" id="changes-close" aria-label="Tutup">✕</button></header>
  <section class="cs-block"><h3>LIVE CONNECTION</h3><div id="cs-live" class="cs-grid"></div></section>${results}
  <section class="cs-block"><h3>WHAT CHANGED</h3>${CHANGES.map(c => `<details class="cs-change"><summary><i>${c.id}</i><span>${esc(c.title)}</span><em>${esc(c.tag)}</em></summary>
    <p>${esc(c.summary)}</p><div class="cs-files">${c.files.map(f => `<code>${esc(f)}</code>`).join('')}</div>
    <pre class="cs-del"><b>−</b>${esc(c.before)}</pre><pre class="cs-add"><b>+</b>${esc(c.after)}</pre></details>`).join('')}</section>
  <footer>Press <kbd>C</kbd> to toggle · metrics endpoint: <code>/api/metrics</code></footer>`;
  document.body.append(tab, side);
  const live = side.querySelector('#cs-live');
  const toggle = (open = side.classList.contains('hidden')) => {side.classList.toggle('hidden', !open); tab.setAttribute('aria-expanded', String(open)); tab.classList.toggle('open', open); if (open) refresh();};
  const cell = (label, value, unit = '') => `<div><span>${label}</span><b>${value}<small>${unit}</small></b></div>`;
  function refresh() {
    const t = readTelemetry(), p = t.pred;
    const avgErr = p.reconciles ? p.sumErr / p.reconciles : NaN;
    live.innerHTML = t.online && ['online', 'lobby'].includes(t.mode)
      ? cell('DOWN', fmt(t.downKiBps, 1), ' KiB/s') + cell('FRAME', fmt(t.lastFrameBytes), ' B') + cell('FRAMES/S', fmt(t.framesPerSec, 1)) + cell('PING', fmt(t.ping), ' ms')
        + cell('INTERP DELAY', fmt(t.delay), ' ms') + cell('JITTER', fmt(t.jitter, 1), ' ms') + cell('UP', fmt(t.upKiBps, 2), ' KiB/s') + cell('INPUT MSG/S', fmt(t.upMsgsPerSec, 1))
        + cell('PRED. ERR AVG', t.spectating ? '—' : fmt(avgErr, 3), ' u') + cell('PRED. ERR MAX', t.spectating ? '—' : fmt(p.maxErr, 2), ' u') + cell('CORRECTIONS', t.spectating ? '—' : p.corrections) + cell('HARD SNAPS', t.spectating ? '—' : p.snaps)
      : '<p class="cs-note">Join an online room to see live numbers. Practice mode runs locally with no network.</p>';
  }
  tab.addEventListener('click', () => toggle());
  side.querySelector('#changes-close').addEventListener('click', () => toggle(false));
  addEventListener('keydown', e => {if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) toggle();});
  setInterval(() => {if (!side.classList.contains('hidden')) refresh();}, 500);
}
