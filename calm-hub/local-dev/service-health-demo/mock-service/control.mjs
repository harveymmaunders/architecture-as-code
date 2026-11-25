// The demo control panel at /control of a UI service: set each node UP or DOWN, its error rate and latency,
// and run a flow many times. It calls the other services over the compose network. Only architecture nodes are targets.
import { runFlow, traceUrl } from './flows.mjs';
import { CRITICALITY_ORDER, STYLE, escapeHtml, scriptJson, titleOf } from './page.mjs';

export const MAX_RUNS = 500;
const MAX_ACTIVE_RUNS = 2;
const KEEP_RUNS = 20;
const NODE_ACTION = /^\/control\/api\/nodes\/([a-z0-9][a-z0-9-]{0,62})\/(up|down|errors|latency)$/;
const RUN_PATH = /^\/control\/api\/runs\/(\d{1,9})$/;
const WINDOW = '30s';

const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
};

// Returns the number, or undefined when the query value is missing or outside [min, max].
const numberParam = (url, name, min, max) => {
    const raw = url.searchParams.get(name);
    const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
};

export function createControl({
    serviceName, nodes, flows, tracer, peerUrl, fetchImpl = fetch, grafanaUrl = 'http://localhost:3000',
    prometheusUrl = null, timeoutMs = 1500, concurrency = 5,
}) {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const runs = new Map();
    let nextRunId = 1;

    // A JSON reply from a node, or null when it cannot be reached. A 503 from a DOWN node still has a body.
    const ask = async (node, method, path) => {
        try {
            const res = await fetchImpl(new URL(path, peerUrl(node)), { method, signal: AbortSignal.timeout(timeoutMs) });
            return await res.json();
        } catch {
            return null;
        }
    };

    const promQuery = async (query) => {
        const url = new URL('/api/v1/query', prometheusUrl);
        url.searchParams.set('query', query);
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`Prometheus replied ${res.status}`);
        return new Map((await res.json()).data.result.map((r) => [r.metric.job, Number(r.value[1])]));
    };

    // Request rate, error ratio and p95 of /work per node over the last WINDOW, from Prometheus.
    async function observed() {
        if (!prometheusUrl) return {};
        try {
            const work = `service_http_requests_total{path="/work"}`;
            const [rps, errors, p95] = await Promise.all([
                promQuery(`sum by (job) (rate(${work}[${WINDOW}]))`),
                promQuery(`sum by (job) (rate(service_http_requests_total{path="/work",code=~"5.."}[${WINDOW}]))`),
                promQuery(`histogram_quantile(0.95, sum by (job, le) (rate(service_request_duration_seconds_bucket[${WINDOW}])))`),
            ]);
            const byNode = {};
            for (const [job, rate] of rps) {
                const p95Seconds = p95.get(job);
                byNode[job] = {
                    rps: rate,
                    errorRatio: rate > 0 ? (errors.get(job) ?? 0) / rate : null,
                    p95Ms: Number.isFinite(p95Seconds) ? Math.round(p95Seconds * 1000) : null,
                };
            }
            return byNode;
        } catch {
            return {};
        }
    }

    async function state() {
        const [metrics, list] = await Promise.all([observed(), Promise.all(nodes.map(async (node) => {
            const [health, chaos] = await Promise.all([ask(node.id, 'GET', '/health'), ask(node.id, 'GET', '/chaos')]);
            return {
                id: node.id,
                status: health?.status === 'UP' || health?.status === 'DOWN' ? health.status : 'UNREACHABLE',
                errorRatio: chaos?.errorRatio ?? null,
                latencyMs: chaos?.latencyMs ?? null,
            };
        }))]);
        return { service: serviceName, nodes: list.map((node) => ({ ...node, observed: metrics[node.id] ?? null })) };
    }

    async function nodeAction(res, url, node, action) {
        if (!nodeIds.has(node)) return json(res, 404, { error: `${node} is not a node of the architecture` });
        let path = `/health/${action}`;
        if (action === 'errors') {
            const ratio = numberParam(url, 'ratio', 0, 1);
            if (ratio === undefined) return json(res, 400, { error: 'ratio must be a number from 0 to 1' });
            path = `/chaos/errors?ratio=${ratio}`;
        } else if (action === 'latency') {
            const ms = numberParam(url, 'ms', 0, 60_000);
            if (ms === undefined) return json(res, 400, { error: 'ms must be a number from 0 to 60000' });
            path = `/chaos/latency?ms=${ms}`;
        }
        const reply = await ask(node, 'POST', path);
        if (!reply) return json(res, 502, { error: `${node} cannot be reached` });
        json(res, 200, reply);
    }

    async function reset(res) {
        const replies = await Promise.all(nodes.flatMap((node) => [ask(node.id, 'POST', '/health/up'), ask(node.id, 'POST', '/chaos/reset')]));
        const unreachable = nodes.filter((_, i) => !replies[2 * i] || !replies[2 * i + 1]).map((node) => node.id);
        json(res, 200, { reset: nodes.length - unreachable.length, unreachable });
    }

    const view = (run) => ({
        id: run.id, flow: run.flow, name: run.name, count: run.count, done: run.done, ok: run.ok, failed: run.failed,
        running: run.running, durationMs: (run.finishedAt ?? Date.now()) - run.startedAt,
        failures: [...run.failures.values()].sort((a, b) => b.count - a.count).slice(0, 3),
        searchUrl: run.searchUrl,
        lastTraceUrl: run.lastTraceId ? traceUrl(grafanaUrl, run.lastTraceId) : null,
        lastFailedTraceUrl: run.lastFailedTraceId ? traceUrl(grafanaUrl, run.lastFailedTraceId) : null,
    });

    function record(run, result) {
        run.done += 1;
        run.lastTraceId = result.traceId ?? run.lastTraceId;
        if (result.ok) {
            run.ok += 1;
            return;
        }
        run.failed += 1;
        run.lastFailedTraceId = result.traceId ?? run.lastFailedTraceId;
        const step = result.steps?.find((candidate) => candidate.status === 'failed');
        const key = step ? `${step.sequence} ${step.failedNode}` : 'error';
        const failure = run.failures.get(key) ?? {
            step: step?.sequence ?? null, from: step?.from ?? null, to: step?.to ?? null,
            node: step?.failedNode ?? null, reason: step?.reason ?? result.error ?? 'error', count: 0,
        };
        failure.count += 1;
        run.failures.set(key, failure);
    }

    function startRun(res, url) {
        const slug = url.searchParams.get('flow');
        const flow = flows.find((candidate) => candidate.slug === slug);
        if (!flow) return json(res, 404, { error: 'no such flow' });
        const count = numberParam(url, 'count', 1, MAX_RUNS);
        if (!Number.isInteger(count)) return json(res, 400, { error: `count must be a whole number from 1 to ${MAX_RUNS}` });
        if ([...runs.values()].filter((run) => run.running).length >= MAX_ACTIVE_RUNS) {
            return json(res, 429, { error: 'two runs are in progress already; wait for one to finish' });
        }
        const run = {
            id: nextRunId++, flow: flow.slug, name: flow.name, count, done: 0, ok: 0, failed: 0, running: true,
            failures: new Map(), startedAt: Date.now(), finishedAt: null, lastTraceId: null, lastFailedTraceId: null,
            searchUrl: traceUrl(grafanaUrl, `{ span."calm.flow.slug" = "${flow.slug}" }`, { from: 'now-15m' }),
        };
        runs.set(run.id, run);
        for (const id of runs.keys()) if (runs.size > KEEP_RUNS && !runs.get(id).running) runs.delete(id);

        let started = 0;
        const worker = async () => {
            while (started < count) {
                started += 1;
                const result = await runFlow(flow, { tracer, serviceUrl: peerUrl, fetchImpl, trigger: 'ui' })
                    .catch((error) => ({ ok: false, error: error.message, steps: [] }));
                record(run, result);
            }
        };
        Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker)).finally(() => {
            run.running = false;
            run.finishedAt = Date.now();
            tracer?.flush?.();
        });
        json(res, 202, view(run));
    }

    // Returns false when the path is not the control panel's.
    async function handle(req, res, url) {
        const path = url.pathname;
        const key = `${req.method} ${path}`;
        if (key === 'GET /control') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderControlPage(serviceName, nodes, flows));
        } else if (key === 'GET /control/api/state') json(res, 200, await state());
        else if (key === 'POST /control/api/reset') await reset(res);
        else if (key === 'POST /control/api/runs') startRun(res, url);
        else if (req.method === 'GET' && RUN_PATH.test(path)) {
            const run = runs.get(Number(RUN_PATH.exec(path)[1]));
            if (run) json(res, 200, view(run));
            else json(res, 404, { error: 'no such run' });
        } else if (req.method === 'POST' && NODE_ACTION.test(path)) {
            const [, node, action] = NODE_ACTION.exec(path);
            await nodeAction(res, url, node, action);
        } else if (path === '/control' || path.startsWith('/control/')) json(res, 404, { error: 'not found' });
        else return false;
        return true;
    }

    return { handle, state };
}

const CONTROL_STYLE = `
header, main { max-width: 1120px; }
main > * { min-width: 0; }
.top .actions { display: flex; gap: 8px; align-items: center; }
button.danger { background: var(--bad); color: var(--card); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
.card h2 { font-size: 17px; margin: 0 0 2px; }
.card > p.hint { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 900px; }
th { text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px; border-bottom: 1px solid var(--line); }
td { padding: 9px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
tr.down td { background: var(--bad-bg); }
.name { font-weight: 600; white-space: nowrap; }
.id { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); font-weight: 400; }
.pill { display: inline-block; min-width: 64px; text-align: center; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
.pill.UP { color: var(--ok); background: var(--ok-bg); }
.pill.DOWN { color: var(--card); background: var(--bad); }
.pill.UNREACHABLE { color: var(--idle); background: var(--bg); border: 1px solid var(--line); }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--bg); }
.seg button { background: transparent; color: var(--text); font-weight: 500; font-size: 13px; padding: 5px 10px; white-space: nowrap; border-radius: 0; border-left: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.seg button:first-child { border-left: 0; }
.seg button:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.seg button[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); font-weight: 700; }
.seg.chaos button[aria-pressed="true"] { background: var(--high); color: var(--card); }
.seg.chaos button.zero[aria-pressed="true"] { background: var(--card); color: var(--text); box-shadow: inset 0 0 0 1px var(--muted); }
.seg button.up[aria-pressed="true"] { background: var(--ok); color: var(--card); }
.seg button.down[aria-pressed="true"] { background: var(--bad); color: var(--card); }
.seg button:disabled { cursor: progress; }
.obs { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.obs b { color: var(--text); font-weight: 600; }
.obs b.hot { color: var(--bad); }
.custom { font-size: 12px; color: var(--muted); margin-left: 6px; }
.self { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; margin-left: 6px; font-weight: 500; }
.form { display: flex; gap: 16px; align-items: end; flex-wrap: wrap; }
.field { display: grid; gap: 4px; }
.field > span { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
select, input[type=number] { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); }
select { min-width: min(320px, 100%); max-width: 100%; }
input[type=number] { width: 84px; margin-left: 6px; }
button.big { padding: 8px 26px; font-size: 16px; }
.run { margin-top: 16px; display: none; }
.run.shown { display: block; }
.run-head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
.run-head h3 { font-size: 15px; margin: 0; flex: 1 1 auto; }
.bar { height: 12px; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); display: flex; overflow: hidden; }
.bar .ok { background: var(--ok); } .bar .failed { background: var(--bad); }
.counts { display: flex; gap: 24px; margin: 12px 0 4px; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.count { font-size: 28px; font-weight: 700; line-height: 1.1; }
.count small { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.count.ok { color: var(--ok); } .count.failed { color: var(--bad); } .count.total { color: var(--muted); }
.failures { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.failures li { display: flex; gap: 10px; padding: 6px 10px; border-radius: 6px; background: var(--bad-bg); font-size: 14px; }
.failures .n { font-weight: 700; color: var(--bad); min-width: 36px; font-variant-numeric: tabular-nums; }
.links { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; font-size: 14px; }
.links a { color: var(--accent); font-weight: 600; }
.links .note { color: var(--muted); }
.error { color: var(--bad); font-weight: 600; }
`;

const SCRIPT = `
const DATA = JSON.parse(document.getElementById('data').textContent);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ERRORS = [0, 0.1, 0.3, 0.5, 1];
const LATENCY = [0, 300, 800, 2000];
const rows = document.getElementById('rows');
const message = document.getElementById('message');
const pct = (r) => Math.round(r * 100) + '%';

async function api(method, path) {
  const res = await fetch(path, { method });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'the service replied ' + res.status);
  return body;
}
function show(error) { message.textContent = error ? error.message : ''; }

function seg(action, values, label, cls) {
  const chaos = !cls;
  return '<div class="seg' + (chaos ? ' chaos' : '') + '" role="group">' + values.map((v, i) => '<button type="button" data-action="' + action + '" data-value="' + esc(v) + '"'
    + ' class="' + esc(chaos ? (v === 0 ? 'zero' : '') : cls[i]) + '" aria-pressed="false">' + esc(label(v)) + '</button>').join('') + '</div>';
}
rows.innerHTML = DATA.nodes.map((n) => '<tr data-node="' + esc(n.id) + '">'
  + '<td><span class="name">' + esc(n.name) + '</span>' + (n.id === DATA.service ? '<span class="self" title="DOWN only flips its health flag: this page keeps working">this page</span>' : '')
  + '<span class="id">' + esc(n.id) + '</span></td>'
  + '<td><span class="pill" data-cell="status">…</span></td>'
  + '<td>' + seg('health', ['up', 'down'], (v) => v === 'up' ? 'Up' : 'Down', ['up', 'down']) + '</td>'
  + '<td>' + seg('errors', ERRORS, pct) + '<span class="custom" data-cell="errors"></span></td>'
  + '<td>' + seg('latency', LATENCY, String) + '<span class="custom" data-cell="latency"></span></td>'
  + '<td class="obs" data-cell="observed">–</td></tr>').join('');

function update(state) {
  for (const n of state.nodes) {
    const row = rows.querySelector('tr[data-node="' + CSS.escape(n.id) + '"]');
    if (!row) continue;
    row.classList.toggle('down', n.status !== 'UP');
    const pill = row.querySelector('[data-cell="status"]');
    pill.className = 'pill ' + n.status;
    pill.textContent = n.status === 'UNREACHABLE' ? 'NO REPLY' : n.status;
    const pressed = { health: n.status === 'UP' ? 'up' : n.status === 'DOWN' ? 'down' : null, errors: n.errorRatio, latency: n.latencyMs };
    for (const b of row.querySelectorAll('button[data-action]')) {
      const want = pressed[b.dataset.action];
      b.setAttribute('aria-pressed', String(want !== null && String(want) === b.dataset.value));
    }
    row.querySelector('[data-cell="errors"]').textContent = n.errorRatio !== null && !ERRORS.includes(n.errorRatio) ? '(' + pct(n.errorRatio) + ')' : '';
    row.querySelector('[data-cell="latency"]').textContent = n.latencyMs !== null && !LATENCY.includes(n.latencyMs) ? '(' + n.latencyMs + ' ms)' : '';
    const o = n.observed;
    row.querySelector('[data-cell="observed"]').innerHTML = o
      ? 'errors <b class="' + (o.errorRatio > 0.05 ? 'hot' : '') + '">' + (o.errorRatio === null ? '–' : esc((o.errorRatio * 100).toFixed(o.errorRatio < 0.1 && o.errorRatio > 0 ? 1 : 0)) + '%') + '</b>'
        + ' · p95 <b class="' + (o.p95Ms > 500 ? 'hot' : '') + '">' + (o.p95Ms === null ? '–' : esc(o.p95Ms) + ' ms') + '</b>'
      : '–';
  }
}

let polling = false;
async function refresh() {
  if (polling) return;
  polling = true;
  try { update(await api('GET', '/control/api/state')); show(null); } catch (error) { show(error); } finally { polling = false; }
}

rows.addEventListener('click', async (event) => {
  const b = event.target.closest('button[data-action]');
  if (!b) return;
  const node = encodeURIComponent(b.closest('tr').dataset.node);
  const v = b.dataset.value;
  const path = b.dataset.action === 'health' ? '/control/api/nodes/' + node + '/' + v
    : b.dataset.action === 'errors' ? '/control/api/nodes/' + node + '/errors?ratio=' + v
    : '/control/api/nodes/' + node + '/latency?ms=' + v;
  for (const other of b.parentElement.children) other.setAttribute('aria-pressed', String(other === b));
  try { await api('POST', path); show(null); } catch (error) { show(error); }
  refresh();
});

document.getElementById('reset').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try { await api('POST', '/control/api/reset'); show(null); } catch (error) { show(error); }
  event.target.disabled = false;
  refresh();
});

// Run a flow.
const select = document.getElementById('flow');
const countInput = document.getElementById('count');
const runButton = document.getElementById('run');
const box = document.getElementById('result');
const counts = document.getElementById('counts');
const starts = DATA.nodes.map((n) => n.id).filter((id) => DATA.flows.some((f) => f.start === id));
const nodeName = (id) => DATA.nodes.find((n) => n.id === id)?.name ?? id;
select.innerHTML = starts.map((s) => '<optgroup label="Starts at ' + esc(nodeName(s)) + '">'
  + DATA.flows.filter((f) => f.start === s).map((f) => '<option value="' + esc(f.slug) + '">' + esc(f.name) + ' · ' + esc(f.criticality) + ' · ' + esc(f.steps) + ' steps</option>').join('')
  + '</optgroup>').join('');
const wanted = new URLSearchParams(location.search).get('flow');
if (wanted && DATA.flows.some((f) => f.slug === wanted)) select.value = wanted;
function setCount(v) {
  countInput.value = v;
  for (const b of counts.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === String(v)));
}
counts.addEventListener('click', (event) => { const b = event.target.closest('button'); if (b) setCount(b.dataset.value); });
countInput.addEventListener('input', () => setCount(countInput.value));

function renderRun(run) {
  const total = Math.max(run.count, 1);
  box.innerHTML = '<div class="run-head"><h3>' + esc(run.name) + ' × ' + esc(run.count) + '</h3><span class="obs">'
    + (run.running ? 'running… ' + esc(run.done) + ' of ' + esc(run.count) : 'finished in ' + esc((run.durationMs / 1000).toFixed(1)) + ' s') + '</span></div>'
    + '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + esc(run.count) + '" aria-valuenow="' + esc(run.done) + '">'
    + '<span class="ok" style="width:' + (100 * run.ok / total) + '%"></span><span class="failed" style="width:' + (100 * run.failed / total) + '%"></span></div>'
    + '<div class="counts"><div class="count ok">' + esc(run.ok) + '<small>succeeded</small></div>'
    + '<div class="count failed">' + esc(run.failed) + '<small>failed</small></div>'
    + (run.running ? '<div class="count total">' + esc(run.count - run.done) + '<small>to go</small></div>' : '') + '</div>'
    + (run.failures.length ? '<ul class="failures">' + run.failures.map((f) => '<li><span class="n">×' + esc(f.count) + '</span><span>'
      + (f.step === null ? '' : 'Step ' + esc(f.step) + ' ' + esc(f.from) + ' → ' + esc(f.to) + ': ') + esc(f.reason) + '</span></li>').join('') + '</ul>' : '')
    + '<div class="links"><a href="' + esc(run.searchUrl) + '" target="_blank" rel="noopener">Search these traces in Grafana</a>'
    + (run.lastTraceUrl ? '<a href="' + esc(run.lastTraceUrl) + '" target="_blank" rel="noopener">Last trace</a>' : '')
    + (run.lastFailedTraceUrl ? '<a href="' + esc(run.lastFailedTraceUrl) + '" target="_blank" rel="noopener">Last failed trace</a>' : '')
    + '<span class="note">Traces take 10 to 30 s to reach Tempo.</span></div>';
  box.classList.add('shown');
}

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  runButton.textContent = 'Running…';
  try {
    let run = await api('POST', '/control/api/runs?flow=' + encodeURIComponent(select.value) + '&count=' + encodeURIComponent(countInput.value));
    renderRun(run);
    while (run.running) {
      await new Promise((r) => setTimeout(r, 400));
      run = await api('GET', '/control/api/runs/' + run.id);
      renderRun(run);
    }
  } catch (error) {
    box.innerHTML = '<p class="error">' + esc(error.message) + '</p>';
    box.classList.add('shown');
  } finally {
    runButton.disabled = false;
    runButton.textContent = 'Run';
  }
});

refresh();
setInterval(refresh, 2000);
`;

export function renderControlPage(serviceName, nodes, flows) {
    const data = {
        service: serviceName,
        nodes: nodes.map(({ id, name }) => ({ id, name })),
        flows: [...flows].sort((a, b) => (CRITICALITY_ORDER[a.criticality] ?? 3) - (CRITICALITY_ORDER[b.criticality] ?? 3)
            || a.name.localeCompare(b.name))
            .map(({ slug, name, criticality, start, steps }) => ({ slug, name, criticality, start, steps: steps.length })),
    };
    const countButtons = [1, 10, 50, 100].map((n) => `<button type="button" data-value="${n}" aria-pressed="${n === 10}">${n}</button>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Control panel</title><style>${STYLE}${CONTROL_STYLE}</style></head>
<body><header><div class="top"><h1>Control panel</h1><div class="actions">
<a class="navlink" href="/">← ${escapeHtml(titleOf(serviceName))} flows</a>
<button type="button" class="danger" id="reset">Reset all</button></div></div>
<p>Changes apply to the running services at once. <span class="error" id="message" role="status"></span></p></header>
<main>
<section class="card"><h2>Services</h2><p class="hint">Live state, refreshed every 2 s. Observed errors and p95 are from Prometheus over the last 30 s.</p>
<div class="scroll"><table><thead><tr><th>Service</th><th>State</th><th>Health</th><th>Error rate</th><th>Added latency (ms)</th><th>Observed</th></tr></thead>
<tbody id="rows"></tbody></table></div></section>
<section class="card"><h2>Run a flow</h2><p class="hint">Runs on the server, 5 at a time, as real calls between the services. Up to ${MAX_RUNS} runs.</p>
<div class="form">
<label class="field"><span>Flow</span><select id="flow"></select></label>
<div class="field"><span>Runs</span><div><div class="seg" id="counts">${countButtons}</div><input id="count" type="number" min="1" max="${MAX_RUNS}" value="10" aria-label="Number of runs"></div></div>
<button type="button" class="big" id="run">Run</button>
</div>
<div class="run" id="result" aria-live="polite"></div></section>
</main>
<script type="application/json" id="data">${scriptJson(data)}</script>
<script>${SCRIPT}</script></body></html>`;
}
