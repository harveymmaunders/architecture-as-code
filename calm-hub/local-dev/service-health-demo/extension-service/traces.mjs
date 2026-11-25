// Reads flow, node and relationship failures from the traces in Tempo. Never throws: a failure gives
// { available: false, error }.
//
// The flow driver and the UI pages mark the spans (mock-service/flows.mjs):
//   root span  calm.flow.slug, calm.flow.unique-id; on failure status error and calm.flow.failed-step,
//              calm.flow.failed-relationship, calm.flow.failed-node, calm.flow.failure-reason
//   step span  one per executed step: calm.relationship.unique-id, calm.step.from, calm.step.to, calm.flow.step;
//              on failure status error and calm.failure.node (the node that failed), calm.failure.reason
// A failed step counts once, against the node that failed it: the destination that replied with an error or could
// not be reached, or the source when the source itself was down.
//
// Counts come from TraceQL metrics (GET /api/metrics/query). If Tempo cannot answer them, they come from a search.
// The last failures come from a search (GET /api/search), most recent first.

export const FLOW_COUNTS_QUERY = '{ span."calm.flow.slug" != "" } | count_over_time() by (span."calm.flow.slug", span."calm.flow.unique-id", status)';
export const STEP_COUNTS_QUERY = '{ span."calm.step.to" != "" } | count_over_time() '
    + 'by (span."calm.relationship.unique-id", span."calm.step.from", span."calm.step.to", span."calm.failure.node", status)';
const FLOW_FIELDS = ['calm.flow.slug', 'calm.flow.unique-id', 'calm.flow.failed-step', 'calm.flow.failed-relationship', 'calm.flow.failed-node', 'calm.flow.failure-reason'];
const STEP_FIELDS = ['calm.relationship.unique-id', 'calm.step.from', 'calm.step.to', 'calm.failure.node', 'calm.failure.reason', 'calm.flow.unique-id', 'calm.flow.step'];
// statusMessage: the reason on spans that have no calm.*-reason attribute.
const select = (fields) => `select(${fields.map((field) => `span."${field}"`).join(', ')}, statusMessage)`;
export const FLOWS_QUERY = `{ span."calm.flow.slug" != "" } | ${select(FLOW_FIELDS)}`;
export const FAILED_FLOWS_QUERY = `{ span."calm.flow.slug" != "" && status = error } | ${select(FLOW_FIELDS)}`;
export const STEPS_QUERY = `{ span."calm.step.to" != "" } | ${select(STEP_FIELDS)}`;
export const FAILED_STEPS_QUERY = `{ span."calm.step.to" != "" && status = error } | ${select(STEP_FIELDS)}`;
// The latest run of each flow, over a short window so that the search limit does not cut off recent runs.
export const LATEST_FLOWS_QUERY = '{ span."calm.flow.slug" != "" } | select(span."calm.flow.slug")';
const LATEST_SECONDS = 120;

const quote = (value) => JSON.stringify(String(value));
export const flowFailuresTraceql = (slug) => `{ span."calm.flow.slug" = ${quote(slug)} && status = error }`;
export const nodeFailuresTraceql = (node) => `{ span."calm.failure.node" = ${quote(node)} }`;
export const relationshipFailuresTraceql = (id) => `{ span."calm.step.to" != "" && span."calm.relationship.unique-id" = ${quote(id)} && status = error }`;

const DEFAULT_GRAFANA = 'http://localhost:3000';
const SEARCH_LIMIT = 500;
const COUNT_LIMIT = 5000;

// Tempo drops the leading zeros of a trace id.
export const normaliseTraceId = (id) => String(id ?? '').toLowerCase().padStart(32, '0');

function explore(grafanaUrl, query, range, datasourceUid) {
    const panes = {
        traces: {
            datasource: datasourceUid,
            queries: [{ refId: 'A', datasource: { type: 'tempo', uid: datasourceUid }, queryType: 'traceql', query, limit: 50, tableType: 'traces' }],
            range,
        },
    };
    const url = new URL('/explore', grafanaUrl);
    url.searchParams.set('schemaVersion', '1');
    url.searchParams.set('panes', JSON.stringify(panes));
    url.searchParams.set('orgId', '1');
    return url.href;
}

// Grafana Explore with one trace open. grafanaUrl: any Grafana URL; only its origin is used.
export function traceUrl(grafanaUrl, traceId, { datasourceUid = 'tempo' } = {}) {
    return explore(grafanaUrl, normaliseTraceId(traceId), { from: 'now-1h', to: 'now' }, datasourceUid);
}

// Grafana Explore with a TraceQL search over the last `minutes`.
export function searchUrl(grafanaUrl, traceql, { minutes = 15, datasourceUid = 'tempo' } = {}) {
    return explore(grafanaUrl, traceql, { from: `now-${minutes}m`, to: 'now' }, datasourceUid);
}

function valueOf(value) {
    if (!value || typeof value !== 'object') return undefined;
    if ('stringValue' in value) return value.stringValue;
    if ('intValue' in value) return Number(value.intValue);
    if ('doubleValue' in value) return Number(value.doubleValue);
    if ('boolValue' in value) return value.boolValue;
    return undefined;
}

const attributesOf = (list) => Object.fromEntries((Array.isArray(list) ? list : [])
    .filter((a) => typeof a?.key === 'string').map((a) => [a.key.replace(/^span\./, ''), valueOf(a.value)]));

// /api/metrics/query → [{ labels: {...}, value }].
export function seriesOf(reply) {
    if (!Array.isArray(reply?.series)) throw new Error('Tempo sent an unexpected metrics reply');
    return reply.series
        .map((series) => ({ labels: attributesOf(series.labels), value: Number(series.value) }))
        .filter((series) => Number.isFinite(series.value));
}

// /api/search → one entry per matched span: { traceId, time (ISO), attributes }, most recent first.
export function spansOf(reply) {
    if (!Array.isArray(reply?.traces)) throw new Error('Tempo sent an unexpected search reply');
    const spans = [];
    for (const trace of reply.traces) {
        const sets = Array.isArray(trace.spanSets) ? trace.spanSets : trace.spanSet ? [trace.spanSet] : [];
        const seen = new Set();
        for (const span of sets.flatMap((set) => set?.spans ?? [])) {
            if (seen.has(span.spanID)) continue;
            seen.add(span.spanID);
            const nanos = BigInt(span.startTimeUnixNano ?? trace.startTimeUnixNano ?? 0);
            spans.push({
                traceId: normaliseTraceId(trace.traceID),
                nanos,
                time: new Date(Number(nanos / 1_000_000n)).toISOString(),
                attributes: attributesOf(span.attributes),
            });
        }
    }
    return spans.sort((a, b) => (b.nanos > a.nanos ? 1 : b.nanos < a.nanos ? -1 : 0));
}

function client(tempoUrl, { fetchImpl, timeoutMs, start, end }) {
    async function get(path, params) {
        const url = new URL(path, tempoUrl);
        for (const [key, value] of Object.entries({ start, end, ...params })) url.searchParams.set(key, String(value));
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`Tempo replied ${res.status} to ${path}`);
        return res.json();
    }
    return {
        metrics: async (q) => seriesOf(await get('/api/metrics/query', { q })),
        search: async (q, limit, spss, from = start) => spansOf(await get('/api/search', { q, limit, spss, start: from })),
    };
}

const ratio = (failed, total) => (total > 0 ? failed / total : 0);
const entry = () => ({ total: 0, failed: 0, errorRatio: 0, lastFailed: null });

// Counts with TraceQL metrics, or by search if metrics fail. Returns { method, flowCounts, stepCounts } as label rows.
async function readCounts(tempo) {
    try {
        const [flowCounts, stepCounts] = await Promise.all([tempo.metrics(FLOW_COUNTS_QUERY), tempo.metrics(STEP_COUNTS_QUERY)]);
        return { method: 'traceql-metrics', flowCounts, stepCounts };
    } catch {
        const [flows, steps] = await Promise.all([tempo.search(FLOWS_QUERY, COUNT_LIMIT, 1), tempo.search(STEPS_QUERY, COUNT_LIMIT, 20)]);
        const row = (span) => ({ labels: span.attributes, value: 1 });
        return { method: 'search', flowCounts: flows.map(row), stepCounts: steps.map(row) };
    }
}

/**
 * Flow, node and relationship results of the traces in the last `minutes`.
 * @returns {Promise<{ available: true, method, window, flows, byNode, byRelationship } | { available: false, error }>}
 */
export async function readFlowTraces(tempoUrl, {
    minutes = 15, fetchImpl = fetch, timeoutMs = 5000, grafanaUrl = DEFAULT_GRAFANA, now = Date.now(),
} = {}) {
    const end = Math.floor(now / 1000);
    const start = end - minutes * 60;
    const tempo = client(tempoUrl, { fetchImpl, timeoutMs, start, end });
    const links = { minutes };
    try {
        const [{ method, flowCounts, stepCounts }, failedFlows, failedSteps, latest] = await Promise.all([
            readCounts(tempo),
            tempo.search(FAILED_FLOWS_QUERY, SEARCH_LIMIT, 1),
            tempo.search(FAILED_STEPS_QUERY, SEARCH_LIMIT, 20),
            // Only for the "View trace" link: a failure here gives no link, not a failed read.
            tempo.search(LATEST_FLOWS_QUERY, SEARCH_LIMIT, 1, Math.max(start, end - LATEST_SECONDS)).catch(() => []),
        ]);

        // Keys come from span attributes, which any OTLP sender sets: no prototype, so "__proto__" is a plain key.
        const flows = Object.create(null);
        for (const { labels, value } of flowCounts) {
            const slug = labels['calm.flow.slug'];
            if (typeof slug !== 'string') continue;
            const flow = flows[slug] ??= {
                slug, id: labels['calm.flow.unique-id'] ?? null, ...entry(), lastRun: null, searchUrl: searchUrl(grafanaUrl, flowFailuresTraceql(slug), links),
            };
            flow.total += value;
            if (labels.status === 'error') flow.failed += value;
        }
        for (const span of failedFlows) {
            const a = span.attributes;
            const flow = flows[a['calm.flow.slug']];
            if (!flow || flow.lastFailed) continue;
            flow.lastFailed = {
                traceId: span.traceId,
                time: span.time,
                failedStep: a['calm.flow.failed-step'] ?? null,
                relationship: a['calm.flow.failed-relationship'] ?? null,
                node: a['calm.flow.failed-node'] ?? null,
                reason: a['calm.flow.failure-reason'] ?? a.statusMessage ?? null,
                traceUrl: traceUrl(grafanaUrl, span.traceId),
            };
        }

        for (const span of latest) {
            const flow = flows[span.attributes['calm.flow.slug']];
            if (flow && !flow.lastRun) flow.lastRun = { traceId: span.traceId, time: span.time, traceUrl: traceUrl(grafanaUrl, span.traceId) };
        }

        const byNode = Object.create(null);
        const byRelationship = Object.create(null);
        const node = (id) => (byNode[id] ??= { ...entry(), inbound: 0, searchUrl: searchUrl(grafanaUrl, nodeFailuresTraceql(id), links) });
        for (const { labels, value } of stepCounts) {
            const id = labels['calm.relationship.unique-id'];
            const from = labels['calm.step.from'];
            const to = labels['calm.step.to'];
            if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') continue;
            const relationship = byRelationship[id] ??= {
                source: from, destination: to, ...entry(), searchUrl: searchUrl(grafanaUrl, relationshipFailuresTraceql(id), links),
            };
            relationship.total += value;
            node(from).total += value;
            if (to !== from) node(to).total += value;
            node(to).inbound += value;
            if (labels.status === 'error') {
                relationship.failed += value;
                const failedNode = labels['calm.failure.node'] ?? to;
                node(failedNode).failed += value;
            }
        }
        for (const span of failedSteps) {
            const a = span.attributes;
            const failure = {
                traceId: span.traceId,
                time: span.time,
                reason: a['calm.failure.reason'] ?? a.statusMessage ?? null,
                flow: a['calm.flow.unique-id'] ?? null,
                step: a['calm.flow.step'] ?? null,
                traceUrl: traceUrl(grafanaUrl, span.traceId),
            };
            const relationship = byRelationship[a['calm.relationship.unique-id']];
            if (relationship && !relationship.lastFailed) relationship.lastFailed = { ...failure, node: a['calm.failure.node'] ?? null };
            const failed = byNode[a['calm.failure.node'] ?? a['calm.step.to']];
            if (failed && !failed.lastFailed) failed.lastFailed = { ...failure, relationship: a['calm.relationship.unique-id'] ?? null };
        }
        for (const item of [...Object.values(flows), ...Object.values(byRelationship)]) item.errorRatio = ratio(item.failed, item.total);
        // A node fails the calls into it: its outbound calls would dilute the ratio.
        for (const item of Object.values(byNode)) item.errorRatio = ratio(item.failed, Math.max(item.inbound, item.failed));
        return {
            available: true,
            method,
            window: { start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString(), minutes },
            flows,
            byNode,
            byRelationship,
        };
    } catch (error) {
        return { available: false, error: error?.name === 'TimeoutError' ? 'Tempo did not answer in time' : error.message };
    }
}

const counts = (item) => ({
    total: item?.total ?? 0, ...(item?.inbound !== undefined && { inbound: item.inbound }), failed: item?.failed ?? 0, errorRatio: item?.errorRatio ?? 0,
});

// Adds the counts of the short window to each entry of the long one, as `recent`: the status rule reads them, so a
// new failure is not diluted by the 15 minutes before it.
export function withRecent(read, recent) {
    if (!read?.available || !recent?.available) return read;
    for (const kind of ['flows', 'byNode', 'byRelationship']) {
        for (const [id, item] of Object.entries(read[kind] ?? {})) item.recent = { ...counts(recent[kind]?.[id]), minutes: recent.window?.minutes };
    }
    return read;
}

/**
 * readFlowTraces with a short cache, shared by the views and the publisher: the `minutes` window for the evidence,
 * and the `recentMinutes` window for the status rule. Without `tempoUrl` it gives { available: false } and sends
 * nothing. Never throws.
 */
export function createTraceReader({
    tempoUrl, grafanaUrl = DEFAULT_GRAFANA, cacheMs = 10000, minutes = 15, recentMinutes = 5, readFn = readFlowTraces, clock = Date.now, log = console,
} = {}) {
    let cached;
    let lastError;
    return async function readTraces() {
        if (!tempoUrl) return { available: false, error: 'TEMPO_URL is not set' };
        const t = clock();
        if (!cached || t - cached.at >= cacheMs) {
            cached = {
                at: t,
                result: Promise.all([
                    readFn(tempoUrl, { minutes, grafanaUrl, now: t }),
                    readFn(tempoUrl, { minutes: recentMinutes, grafanaUrl, now: t }).catch(() => undefined),
                ])
                    .then(([read, recent]) => withRecent(read, recent))
                    .catch((error) => ({ available: false, error: error?.message ?? String(error) })),
            };
        }
        const result = await cached.result;
        // One log line per new error, not one per read.
        if (!result.available && result.error !== lastError) log.warn(`service-health: no trace evidence: ${result.error}`);
        lastError = result.available ? undefined : result.error;
        return result;
    };
}

// The UI page that a flow starts at, with the flow chosen and run on load. A flow that starts at a service has none.
export const TRY_IT_URLS = { 'customer-portal': 'http://localhost:9101', 'admin-console': 'http://localhost:9102' };

export function tryItLink(flow, urls = TRY_IT_URLS) {
    const base = urls[flow?.steps?.[0]?.from];
    if (!base || !flow.slug) return undefined;
    const url = new URL('/', base);
    url.searchParams.set('flow', flow.slug);
    url.searchParams.set('run', '1');
    return { label: 'Try it', href: url.href };
}
