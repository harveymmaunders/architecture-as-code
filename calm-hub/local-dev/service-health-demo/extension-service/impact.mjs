// The status constants and the down and warn rules of one Prometheus job. No I/O. analysis.mjs applies them.

export const DOWN = 'down';
export const IMPACTED = 'impacted';
export const HEALTHY = 'healthy';
export const UNKNOWN = 'unknown';

export const WARN = 'warn';

const envNumber = (name, fallback) => {
    const value = Number(process.env[name]);
    return process.env[name] !== undefined && Number.isFinite(value) ? value : fallback;
};

export function warnThresholds(env = {}) {
    return {
        errorRatio: env.errorRatio ?? envNumber('WARN_ERROR_RATIO', 0.05),
        p95ms: env.p95ms ?? envNumber('WARN_P95_MS', 500),
        traceErrorRatio: env.traceErrorRatio ?? envNumber('WARN_TRACE_ERROR_RATIO', 0.05),
        minTraces: env.minTraces ?? envNumber('MIN_TRACES', 5),
    };
}

// Why a running service is in warn, or undefined. Missing metrics never give warn.
export function warnReason(metrics, thresholds = warnThresholds()) {
    if (!metrics) return undefined;
    const reasons = [];
    if (Number.isFinite(metrics.errorRatio) && metrics.errorRatio > thresholds.errorRatio) {
        reasons.push(`error ratio ${percent(metrics.errorRatio)} is over ${percent(thresholds.errorRatio)}`);
    }
    if (Number.isFinite(metrics.p95ms) && metrics.p95ms > thresholds.p95ms) {
        reasons.push(`p95 latency ${Math.round(metrics.p95ms)} ms is over ${thresholds.p95ms} ms`);
    }
    return reasons.length ? reasons.join('; ') : undefined;
}

const percent = (ratio) => `${Number((ratio * 100).toFixed(1))}%`;

// health: { available, jobs: { [job]: { up?: number, health?: number, metrics? } } }
// A job is down when up is 0, the health check is 0, or either series is missing.
// state is down | warn | up, or undefined when Prometheus could not be read.
export function jobState(health, job, thresholds = warnThresholds()) {
    if (!health?.available) return { down: undefined, state: undefined, reason: 'Prometheus could not be reached' };
    const sample = Object.hasOwn(health.jobs ?? {}, job) ? health.jobs[job] : undefined;
    const down = (reason) => ({ down: true, state: DOWN, reason });
    if (!sample || sample.up === undefined) return down(`no metrics for job "${job}"`);
    if (sample.up === 0) return down('Prometheus cannot scrape it (up = 0)');
    if (sample.health === undefined) return down('no service_health_status series');
    if (sample.health === 0) return down('health check failing');
    const warn = warnReason(sample.metrics, thresholds);
    if (warn) return { down: false, state: WARN, reason: warn };
    return { down: false, state: 'up', reason: 'health check passing' };
}

export const FLOW_BROKEN = 'broken';
export const FLOW_DEGRADED = 'degraded';
export const FLOW_OK = 'ok';
export const FLOW_UNKNOWN = 'unknown';
