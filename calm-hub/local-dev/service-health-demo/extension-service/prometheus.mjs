// Reads health, traffic metrics and the start of the current status by job. Never throws: a failure of the up or
// health query gives { available: false, error }, so the views show unknown and a warning. A
// failure of the metrics or since queries only leaves metrics or since null.
import { DOWN, WARN, warnReason, warnThresholds } from './impact.mjs';

export const UP_QUERY = 'min by (job) (up)';
export const HEALTH_QUERY = 'min by (job) (service_health_status)';
// 1 while scraped and healthy, 0 otherwise. A stopped service has up 0 and a stale health series.
export const UPDOWN_QUERY = 'min by (job) ({__name__=~"up|service_health_status"})';

const WORK = 'service_http_requests_total{path="/work"}';
const WORK_ERRORS = 'service_http_requests_total{path="/work",code=~"5.."}';
export const RPS_QUERY = `sum by (job) (rate(${WORK}[1m]))`;
export const ERRORS_QUERY = `sum by (job) (rate(${WORK_ERRORS}[1m]))`;
export const P95_QUERY = 'histogram_quantile(0.95, sum by (job, le) (rate(service_request_duration_seconds_bucket[1m])))';

const SINCE_HOURS = 6;
const SINCE_STEP_SECONDS = 15;

function checkReply(reply, type) {
    if (reply?.status !== 'success' || reply.data?.resultType !== type || !Array.isArray(reply.data.result)) {
        throw new Error('Prometheus sent an unexpected reply');
    }
    return reply.data.result;
}

export function samplesByJob(reply) {
    const byJob = {};
    for (const series of checkReply(reply, 'vector')) {
        const job = series?.metric?.job;
        const value = Number(series?.value?.[1]);
        if (typeof job === 'string' && Number.isFinite(value)) byJob[job] = value;
    }
    return byJob;
}

// { [job]: Map<unix seconds, value> }, finite values only.
export function matrixByJob(reply) {
    const byJob = {};
    for (const series of checkReply(reply, 'matrix')) {
        const job = series?.metric?.job;
        if (typeof job !== 'string' || !Array.isArray(series.values)) continue;
        const points = byJob[job] ??= new Map();
        for (const [t, v] of series.values) {
            const value = Number(v);
            if (Number.isFinite(Number(t)) && Number.isFinite(value)) points.set(Number(t), value);
        }
    }
    return byJob;
}

export function mergeSamples(up, health) {
    const jobs = {};
    for (const [job, value] of Object.entries(up)) jobs[job] = { ...jobs[job], up: value };
    for (const [job, value] of Object.entries(health)) jobs[job] = { ...jobs[job], health: value };
    return jobs;
}

// rps missing means the service sends no traffic metrics: metrics null, which never gives warn.
export function metricsOf(rps, errors, p95seconds) {
    if (!Number.isFinite(rps)) return null;
    return {
        rps,
        errorRatio: rps > 0 && Number.isFinite(errors) ? errors / rps : 0,
        p95ms: Number.isFinite(p95seconds) ? p95seconds * 1000 : null,
    };
}

const seconds = (date) => (date.getTime() / 1000).toFixed(3);

function client(prometheusUrl, { fetchImpl = fetch, timeoutMs = 2500 } = {}) {
    async function get(path, params) {
        const url = new URL(path, prometheusUrl);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`Prometheus replied ${res.status}`);
        return res.json();
    }
    return {
        instant: async (query) => samplesByJob(await get('/api/v1/query', { query })),
        range: async (query, start, end, step) => matrixByJob(await get('/api/v1/query_range',
            { query, start: seconds(start), end: seconds(end), step: String(step) })),
    };
}

function failure(prometheusUrl, error, timeoutMs) {
    const message = error?.name === 'TimeoutError' ? `no reply in ${timeoutMs} ms` : error?.message ?? String(error);
    return `Prometheus at ${prometheusUrl} could not be read: ${message}`;
}

// Status down | warn | up by job at each step of a range, by the same rule as the instant read.
async function readStates(prom, start, end, step, thresholds) {
    const [updown, rps, errors, p95] = await Promise.all([
        prom.range(UPDOWN_QUERY, start, end, step),
        prom.range(RPS_QUERY, start, end, step).catch(() => ({})),
        prom.range(ERRORS_QUERY, start, end, step).catch(() => ({})),
        prom.range(P95_QUERY, start, end, step).catch(() => ({})),
    ]);
    const states = {};
    for (const [job, points] of Object.entries(updown)) {
        states[job] = [...points.entries()].sort(([a], [b]) => a - b).map(([t, value]) => {
            if (value === 0) return { t, state: DOWN };
            const metrics = metricsOf(rps[job]?.get(t), errors[job]?.get(t), p95[job]?.get(t));
            return { t, state: warnReason(metrics, thresholds) ? WARN : 'up' };
        });
    }
    return states;
}

// The start of the run of `current` that reaches the end of the points; null if the run covers
// the whole window. A change after the last point gives the end of the window.
export function sinceOf(points, current, end) {
    if (!points?.length || !current) return null;
    let i = points.length - 1;
    if (points[i].state !== current) return end.toISOString();
    while (i > 0 && points[i - 1].state === current) i -= 1;
    return i === 0 ? null : new Date(points[i].t * 1000).toISOString();
}

const instantState = (sample, thresholds) => {
    if (sample.up === undefined || sample.up === 0 || sample.health === undefined || sample.health === 0) return DOWN;
    return warnReason(sample.metrics, thresholds) ? WARN : 'up';
};

// health: { available, jobs: { [job]: { up, health, metrics, since } }, error? }
export async function readHealth(prometheusUrl, options = {}) {
    const { history = true, timeoutMs = 2500, thresholds = warnThresholds(), now = () => new Date() } = options;
    const prom = client(prometheusUrl, options);
    try {
        const optional = (query) => prom.instant(query).catch(() => ({}));
        const [up, health, rps, errors, p95] = await Promise.all([
            prom.instant(UP_QUERY), prom.instant(HEALTH_QUERY),
            optional(RPS_QUERY), optional(ERRORS_QUERY), optional(P95_QUERY),
        ]);
        const jobs = mergeSamples(up, health);
        for (const [job, sample] of Object.entries(jobs)) {
            sample.metrics = metricsOf(rps[job], errors[job], p95[job]);
            sample.since = null;
        }
        if (history) {
            const end = now();
            const start = new Date(end.getTime() - SINCE_HOURS * 3600 * 1000);
            const states = await readStates(prom, start, end, SINCE_STEP_SECONDS, thresholds).catch(() => ({}));
            for (const [job, sample] of Object.entries(jobs)) {
                sample.since = sinceOf(states[job], instantState(sample, thresholds), end);
            }
        }
        return { available: true, jobs };
    } catch (error) {
        return { available: false, jobs: {}, error: failure(prometheusUrl, error, timeoutMs) };
    }
}
