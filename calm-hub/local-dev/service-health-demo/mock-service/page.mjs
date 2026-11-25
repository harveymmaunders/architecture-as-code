// The page of a UI service: the flows that start at it, each with a Run button. No external assets.
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON in a <script> element: escape < so that the data cannot close the element.
export const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const TITLES = { 'customer-portal': 'Customer Portal', 'admin-console': 'Admin Console' };
export const CRITICALITY_ORDER = { critical: 0, high: 1, normal: 2 };

export const titleOf = (serviceName) => TITLES[serviceName]
    ?? serviceName.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');

export const STYLE = `
:root { --bg: #f6f7f9; --card: #fff; --text: #1b1f24; --muted: #5d6673; --line: #dde1e6; --accent: #0b5fff;
  --on-accent: #fff; --ok: #137333; --ok-bg: #e6f4ea; --bad: #b3261e; --bad-bg: #fce8e6; --idle: #6b7280; --high: #9a5b00; --high-bg: #fff4e0; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111418; --card: #1a1f26; --text: #e6e9ee; --muted: #9aa4b1; --line: #2c333d; --accent: #6ea0ff; --on-accent: #0b1220;
    --ok: #81c995; --ok-bg: #16301f; --bad: #f28b82; --bad-bg: #3a1a18; --idle: #8b93a0; --high: #f6c26b; --high-bg: #33280f; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 20px 24px 8px; max-width: 920px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
header p { margin: 0; color: var(--muted); }
.top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.top h1 { flex: 1 1 auto; }
.navlink { color: var(--accent); font-weight: 600; text-decoration: none; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
.navlink:hover { border-color: var(--accent); }
main { max-width: 920px; margin: 0 auto; padding: 8px 16px 32px; display: grid; gap: 12px; }
.flow { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.flow.focus { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head h2 { font-size: 16px; margin: 0; flex: 1 1 auto; }
.desc { margin: 6px 0 0; color: var(--muted); }
.tag { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--bg); color: var(--muted); border: 1px solid var(--line); }
.tag.critical { color: var(--bad); background: var(--bad-bg); border-color: transparent; }
.tag.high { color: var(--high); background: var(--high-bg); border-color: transparent; }
button { font: inherit; font-weight: 600; padding: 6px 16px; border-radius: 8px; border: 0; background: var(--accent); color: var(--on-accent); cursor: pointer; }
button:disabled { opacity: .6; cursor: progress; }
.result { margin-top: 12px; display: none; }
.result.shown { display: block; }
.summary { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-weight: 600; margin-bottom: 8px; }
.summary.ok { color: var(--ok); } .summary.failed { color: var(--bad); }
.summary a { font-weight: 500; color: var(--accent); }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
li { display: grid; grid-template-columns: 22px 1fr auto; gap: 8px; align-items: baseline; padding: 6px 8px; border-radius: 6px; }
li.ok { background: var(--ok-bg); } li.failed { background: var(--bad-bg); } li.not-run { color: var(--idle); }
.icon { font-weight: 700; text-align: center; }
li.ok .icon { color: var(--ok); } li.failed .icon { color: var(--bad); }
.hop { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.why { display: block; color: var(--bad); font-size: 13px; }
.note { display: block; color: var(--muted); font-size: 13px; }
.ms { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); padding: 24px 0; }
`;

const SCRIPT = `
const ICONS = { ok: '✓', failed: '✕', 'not-run': '–' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function render(card, result) {
  const box = card.querySelector('.result');
  const failed = result.steps.find((s) => s.status === 'failed');
  box.innerHTML = '<div class="summary ' + (result.ok ? 'ok' : 'failed') + '">'
    + (result.ok ? '✓ Flow succeeded' : '✕ Failed at step ' + esc(failed?.sequence ?? '?')) + ' <span class="ms">' + esc(result.durationMs) + ' ms</span>'
    + ' <a href="' + esc(result.traceUrl) + '" target="_blank" rel="noopener">View trace</a></div><ol>'
    + result.steps.map((s) => '<li class="' + esc(s.status) + '"><span class="icon" aria-hidden="true">' + (ICONS[s.status] ?? '?') + '</span>'
      + '<span><span class="hop">' + esc(s.sequence) + '. ' + esc(s.from) + ' → ' + esc(s.to) + '</span>'
      + '<span class="note">' + esc(s.description) + (s.status === 'not-run' ? ' (not run)' : '') + '</span>'
      + (s.reason ? '<span class="why">' + esc(s.reason) + '</span>' : '') + '</span>'
      + '<span class="ms">' + (s.latencyMs !== undefined ? esc(s.latencyMs) + ' ms' : '') + '</span></li>').join('')
    + '</ol>';
  box.classList.add('shown');
}
async function run(card) {
  const button = card.querySelector('button');
  button.disabled = true;
  button.textContent = 'Running…';
  try {
    const res = await fetch('/flows/' + encodeURIComponent(card.dataset.slug) + '/run', { method: 'POST' });
    if (!res.ok) throw new Error('the service replied ' + res.status);
    render(card, await res.json());
  } catch (error) {
    const box = card.querySelector('.result');
    box.innerHTML = '<div class="summary failed">✕ ' + esc(error.message) + '</div>';
    box.classList.add('shown');
  } finally {
    button.disabled = false;
    button.textContent = 'Run';
  }
}
document.querySelectorAll('.flow').forEach((card) => card.querySelector('button').addEventListener('click', () => run(card)));
const params = new URLSearchParams(location.search);
const focus = params.get('flow') && document.querySelector('.flow[data-slug="' + CSS.escape(params.get('flow')) + '"]');
if (focus) {
  focus.classList.add('focus');
  focus.scrollIntoView({ block: 'center' });
  if (params.get('run') === '1') run(focus);
}
`;

function flowCard(flow) {
    const steps = flow.steps.length;
    return `<section class="flow" data-slug="${escapeHtml(flow.slug)}" id="${escapeHtml(flow.slug)}">
  <div class="head"><h2>${escapeHtml(flow.name)}</h2>
    <span class="tag ${escapeHtml(flow.criticality)}">${escapeHtml(flow.criticality)}</span>
    <span class="tag">${steps} step${steps === 1 ? '' : 's'}</span>
    <button type="button">Run</button></div>
  <p class="desc">${escapeHtml(flow.description)}</p>
  <div class="result" aria-live="polite"></div>
</section>`;
}

// control: link to the control panel in the header.
export function renderPage(serviceName, flows, { control = false } = {}) {
    const title = titleOf(serviceName);
    const sorted = [...flows].sort((a, b) => (CRITICALITY_ORDER[a.criticality] ?? 3) - (CRITICALITY_ORDER[b.criticality] ?? 3)
        || a.name.localeCompare(b.name));
    const body = sorted.length
        ? sorted.map(flowCard).join('\n')
        : `<p class="empty">No CALM flow starts at ${escapeHtml(serviceName)}.</p>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><header><div class="top"><h1>${escapeHtml(title)}</h1>${control ? '<a class="navlink" href="/control">Control panel →</a>' : ''}</div><p>The CALM flows that start here. Run one to make real calls and a trace.</p></header>
<main>${body}</main>
<script type="application/json" id="flows">${scriptJson(sorted.map((flow) => flow.slug))}</script>
<script>${SCRIPT}</script></body></html>`;
}
