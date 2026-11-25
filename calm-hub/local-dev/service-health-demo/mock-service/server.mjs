import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createControl } from './control.mjs';
import { loadFlows, loadNodes, runFlow, serviceUrlFromTemplate, traceUrl } from './flows.mjs';
import { renderPage } from './page.mjs';
import { SPAN_KIND, createTracer, parseTraceparent, tracerFromEnv } from './tracing.mjs';

export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const WORK_PATH = '/work';
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_BODY_BYTES = 4096;
const FLOW_RUN = /^\/flows\/([a-z0-9][a-z0-9-]{0,99})\/run$/;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noTracer = createTracer({ serviceName: 'none' });

// The small reply of each kind of service, so a flow shows what each step returned.
function replyOf(serviceName, caller, records) {
    const id = () => Math.random().toString(36).slice(2, 8);
    if (serviceName.endsWith('-db')) {
        const count = (records.get(caller) ?? 0) + 1;
        records.set(caller, count);
        return { stored: true, caller, records: count };
    }
    if (serviceName.startsWith('orders')) return { order: `ord-${id()}`, status: 'accepted' };
    if (serviceName.startsWith('payments')) return { authorisation: `auth-${id()}`, status: 'authorised' };
    if (serviceName.startsWith('auth')) return { token: 'valid', subject: caller };
    if (serviceName.includes('gateway')) return { routed: true };
    return { rendered: true };
}

// W3C baggage, only the calm.* keys, which the server span copies.
export function calmBaggage(header) {
    const values = {};
    for (const member of String(header ?? '').split(',')) {
        const [pair] = member.split(';');
        const index = pair.indexOf('=');
        if (index < 0) continue;
        const key = pair.slice(0, index).trim();
        if (!key.startsWith('calm.')) continue;
        try { values[key] = decodeURIComponent(pair.slice(index + 1).trim()); } catch { /* skip a bad value */ }
    }
    return values;
}

const toBaggage = (values) => Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join(',');

async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error('body too large');
        chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const reasonOf = (error) => error?.cause?.code ?? error?.cause?.message ?? error?.name ?? String(error);

// tickMs: interval of the simulated traffic (0 = no ticker, for tests); random: injectable for tests.
// tracer, fetchImpl, sleep, peerUrl: the real calls of /call and /work. flows: the flows for the page (null = none).
// nodes: the architecture nodes; with them, the service serves the control panel at /control.
export function createMockService(serviceName, {
    tickMs = 200, random = Math.random, tracer = noTracer, fetchImpl = fetch, sleep = sleepFor, maxWorkMs = 3000,
    peerUrl = serviceUrlFromTemplate(), callTimeoutMs = 5000, flows = null, grafanaUrl = 'http://localhost:3000',
    nodes = null, prometheusUrl = null,
} = {}) {
    let healthy = true;
    const chaos = { latencyMs: 0, errorRatio: 0 };
    const requests = new Map();
    const records = new Map();
    const histogram = { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
    const ownFlows = () => (flows ?? []).filter((flow) => flow.start === serviceName);
    const control = nodes ? createControl({ serviceName, nodes, flows: flows ?? [], tracer, peerUrl, fetchImpl, grafanaUrl, prometheusUrl }) : null;

    const count = (path, code) => {
        const key = `${path} ${code}`;
        requests.set(key, (requests.get(key) ?? 0) + 1);
    };

    const observe = (seconds, code) => {
        BUCKETS.forEach((le, i) => { if (seconds <= le) histogram.counts[i] += 1; });
        histogram.sum += seconds;
        histogram.count += 1;
        count(WORK_PATH, code);
    };

    // One request: base latency 20-80 ms plus chaos; 503 while DOWN, else 500 at the error ratio.
    const decide = () => ({
        seconds: (20 + random() * 60 + chaos.latencyMs) / 1000,
        code: !healthy ? 503 : random() < chaos.errorRatio ? 500 : 200,
    });

    const simulateRequest = () => {
        const { code, seconds } = decide();
        observe(seconds, code);
        return { code, seconds };
    };

    const json = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const state = () => ({ service: serviceName, status: healthy ? 'UP' : 'DOWN' });
    const chaosState = () => ({ service: serviceName, ...chaos });

    // Returns the number, or undefined when the query value is missing or outside [min, max].
    const numberParam = (url, name, min, max) => {
        const raw = url.searchParams.get(name);
        const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
        return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
    };

    // A real request from another service. The server span takes the calm.* ids from the baggage.
    async function work(res, url, req) {
        const span = tracer.startSpan(`${req.method} ${WORK_PATH}`, {
            kind: SPAN_KIND.server,
            parent: parseTraceparent(req.headers.traceparent),
            attributes: { 'http.request.method': req.method, 'http.route': WORK_PATH, ...calmBaggage(req.headers.baggage) },
        });
        const caller = NODE_ID.test(req.headers['x-calm-caller'] ?? '') ? req.headers['x-calm-caller'] : 'unknown';
        const { code, seconds } = decide();
        const delayMs = Math.min(seconds * 1000, maxWorkMs);
        if (healthy) await sleep(delayMs);
        observe(healthy ? delayMs / 1000 : 0.001, code);
        span.setAttribute('http.response.status_code', code);
        if (code === 200) {
            json(res, 200, { service: serviceName, ok: true, reply: replyOf(serviceName, caller, records) });
        } else {
            const error = code === 503 ? `${serviceName} is DOWN` : `${serviceName} failed the request (chaos)`;
            span.fail(error);
            json(res, code, { service: serviceName, ok: false, error });
        }
        span.end();
    }

    // Calls another service as one step of a flow. A DOWN caller fails the step without a call.
    async function call(res, url, req) {
        let body;
        try { body = await readJson(req); } catch { return json(res, 400, { ok: false, reason: 'body must be JSON up to 4 KiB' }); }
        const { to, relationship, flow, step } = body ?? {};
        if (typeof to !== 'string' || !NODE_ID.test(to)) return json(res, 400, { ok: false, reason: 'to must be a node id' });
        const ids = {
            'calm.relationship.unique-id': typeof relationship === 'string' ? relationship.slice(0, 128) : undefined,
            'calm.flow.unique-id': typeof flow === 'string' ? flow.slice(0, 128) : undefined,
            'calm.flow.step': Number.isInteger(step) ? step : undefined,
        };
        const span = tracer.startSpan(`call ${to}`, {
            kind: SPAN_KIND.client,
            parent: parseTraceparent(req.headers.traceparent),
            attributes: { ...ids, 'peer.service': to, 'server.address': to, 'http.request.method': 'POST' },
        });
        const started = performance.now();
        const reply = { ok: false, from: serviceName, to, relationship: ids['calm.relationship.unique-id'] ?? null, status: null };
        if (!healthy) {
            Object.assign(reply, { reason: `${serviceName} is DOWN`, failedNode: serviceName });
        } else {
            try {
                const answer = await fetchImpl(new URL(WORK_PATH, peerUrl(to)), {
                    method: 'POST',
                    headers: { traceparent: span.traceparent(), baggage: toBaggage(ids), 'x-calm-caller': serviceName },
                    signal: AbortSignal.timeout(callTimeoutMs),
                });
                const answerBody = await answer.json().catch(() => ({}));
                reply.status = answer.status;
                span.setAttribute('http.response.status_code', answer.status);
                if (answer.ok) Object.assign(reply, { ok: true, reply: answerBody.reply ?? null });
                else Object.assign(reply, { reason: `${to} replied ${answer.status}: ${answerBody.error ?? 'error'}`, failedNode: to });
            } catch (error) {
                Object.assign(reply, { reason: `${to} unreachable: ${reasonOf(error)}`, failedNode: to });
                span.setAttribute('error.type', reasonOf(error));
            }
        }
        if (!reply.ok) span.setAttribute('calm.failure.node', reply.failedNode).fail(reply.reason);
        span.end();
        json(res, reply.ok ? 200 : 502, { ...reply, durationMs: Math.round(performance.now() - started) });
    }

    async function runOwnFlow(res, slug) {
        const flow = ownFlows().find((candidate) => candidate.slug === slug);
        if (!flow) return json(res, 404, { error: `no flow ${slug} starts at ${serviceName}` });
        const result = await runFlow(flow, { tracer, serviceUrl: peerUrl, fetchImpl, trigger: 'ui', timeoutMs: callTimeoutMs * 2 });
        json(res, 200, { ...result, traceUrl: traceUrl(grafanaUrl, result.traceId) });
    }

    const routes = {
        'GET /': (res) => {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderPage(serviceName, ownFlows(), { control: Boolean(control) }));
        },
        'GET /flows': (res) => json(res, 200, { service: serviceName, flows: ownFlows() }),
        'GET /work': work,
        'POST /work': work,
        'POST /call': call,
        'GET /health': (res) => json(res, healthy ? 200 : 503, state()),
        'POST /health/toggle': (res) => { healthy = !healthy; json(res, 200, state()); },
        'POST /health/up': (res) => { healthy = true; json(res, 200, state()); },
        'POST /health/down': (res) => { healthy = false; json(res, 200, state()); },
        'GET /chaos': (res) => json(res, 200, chaosState()),
        'POST /chaos/latency': (res, url) => {
            const ms = numberParam(url, 'ms', 0, 60_000);
            if (ms === undefined) return json(res, 400, { error: 'ms must be a number from 0 to 60000' });
            chaos.latencyMs = ms;
            json(res, 200, chaosState());
        },
        'POST /chaos/errors': (res, url) => {
            const ratio = numberParam(url, 'ratio', 0, 1);
            if (ratio === undefined) return json(res, 400, { error: 'ratio must be a number from 0 to 1' });
            chaos.errorRatio = ratio;
            json(res, 200, chaosState());
        },
        'POST /chaos/reset': (res) => {
            chaos.latencyMs = 0;
            chaos.errorRatio = 0;
            json(res, 200, chaosState());
        },
        'GET /metrics': (res) => {
            const label = `service="${serviceName}"`;
            const lines = [
                '# HELP service_health_status 1 when the service reports healthy, 0 otherwise.',
                '# TYPE service_health_status gauge',
                `service_health_status{${label}} ${healthy ? 1 : 0}`,
                '# HELP service_http_requests_total HTTP requests handled, by path and status code. path="/work" is simulated and real work.',
                '# TYPE service_http_requests_total counter',
                ...[...requests].map(([key, n]) => {
                    const [path, code] = key.split(' ');
                    return `service_http_requests_total{${label},path="${path}",code="${code}"} ${n}`;
                }),
                '# HELP service_request_duration_seconds Latency of the /work requests.',
                '# TYPE service_request_duration_seconds histogram',
                // counts are cumulative already: an observation increments every bucket it fits in.
                ...BUCKETS.map((le, i) => `service_request_duration_seconds_bucket{${label},le="${le}"} ${histogram.counts[i]}`),
                `service_request_duration_seconds_bucket{${label},le="+Inf"} ${histogram.count}`,
                `service_request_duration_seconds_sum{${label}} ${histogram.sum}`,
                `service_request_duration_seconds_count{${label}} ${histogram.count}`,
            ];
            res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
            res.end(lines.join('\n') + '\n');
        },
    };

    const methodsByPath = Map.groupBy(Object.keys(routes), (key) => key.split(' ')[1]);

    const server = createServer(async (req, res) => {
        const url = URL.parse(req.url, 'http://localhost');
        const path = url?.pathname;
        const flowRun = path ? FLOW_RUN.exec(path) : null;
        const isControl = Boolean(control && path && (path === '/control' || path.startsWith('/control/')));
        const allowed = flowRun ? ['POST /flows/run'] : methodsByPath.get(path);
        const label = isControl ? '/control' : flowRun ? '/flows/run' : allowed ? path : 'other';
        // /work counts itself, with its latency. Only known paths are counted, so scanners cannot grow the label set.
        if (path !== WORK_PATH) res.on('finish', () => count(label, res.statusCode));
        try {
            if (isControl && await control.handle(req, res, url)) return;
            const route = flowRun ? (req.method === 'POST' ? (r) => runOwnFlow(r, flowRun[1]) : null) : routes[`${req.method} ${path}`];
            if (route) await route(res, url, req);
            else if (allowed) {
                res.setHeader('allow', allowed.map((key) => key.split(' ')[0]).join(', '));
                json(res, 405, { error: 'method not allowed' });
            } else json(res, 404, { error: 'not found' });
        } catch (error) {
            if (!res.headersSent) json(res, 500, { error: error.message });
            else res.end();
        }
    });

    let ticker;
    if (tickMs > 0) {
        server.on('listening', () => { ticker = setInterval(simulateRequest, tickMs); });
        server.on('close', () => clearInterval(ticker));
    }
    server.simulateRequest = simulateRequest;
    return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const name = process.env.SERVICE_NAME ?? 'mock-service';
    const port = Number(process.env.PORT ?? 8080);
    const tickMs = Number(process.env.TICK_MS ?? 200);
    let flows = null;
    let nodes = null;
    if (process.env.ARCHITECTURE_DIR) {
        flows = await loadFlows(process.env.ARCHITECTURE_DIR).catch((error) => {
            console.warn(`no flows: ${error.message}`);
            return null;
        });
        nodes = await loadNodes(process.env.ARCHITECTURE_DIR).catch(() => null);
    }
    // Only the UI services (webclient nodes) serve the control panel.
    const isUi = nodes?.some((node) => node.id === name && node.type === 'webclient');
    const server = createMockService(name, {
        tickMs,
        tracer: tracerFromEnv(name),
        flows,
        grafanaUrl: process.env.GRAFANA_URL || 'http://localhost:3000',
        peerUrl: serviceUrlFromTemplate(process.env.SERVICE_URL_TEMPLATE || undefined),
        nodes: isUi ? nodes : null,
        prometheusUrl: process.env.PROMETHEUS_URL || 'http://prometheus:9090',
    }).listen(port, () => console.log(`${name} listening on ${port}`));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
