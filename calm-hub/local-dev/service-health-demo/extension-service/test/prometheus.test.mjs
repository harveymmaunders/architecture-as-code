// The Prometheus reads: metrics and since, against a fetch stub.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ERRORS_QUERY, HEALTH_QUERY, P95_QUERY, RPS_QUERY, UPDOWN_QUERY, UP_QUERY, matrixByJob, metricsOf, readHealth, sinceOf,
} from '../prometheus.mjs';

const vector = (values) => ({
    status: 'success',
    data: { resultType: 'vector', result: Object.entries(values).map(([job, v]) => ({ metric: { job }, value: [1, String(v)] })) },
});
const matrix = (series) => ({
    status: 'success',
    data: { resultType: 'matrix', result: Object.entries(series).map(([job, values]) => ({ metric: { job }, values: values.map(([t, v]) => [t, String(v)]) })) },
});

// replies: { instant: { [query]: values }, range: { [query]: series } }. Others give a 400.
function stub(replies, calls = []) {
    return async (url) => {
        calls.push(url);
        const query = url.searchParams.get('query');
        const kind = url.pathname.endsWith('query_range') ? 'range' : 'instant';
        const body = replies[kind]?.[query];
        if (!body) return new Response('{"status":"error"}', { status: 400 });
        return Response.json(kind === 'range' ? matrix(body) : vector(body));
    };
}

const ALL_UP = { instant: { [UP_QUERY]: { a: 1, b: 1, c: 0 }, [HEALTH_QUERY]: { a: 1, b: 1 } } };

describe('readHealth v2', () => {
    it('reads rps, error ratio and p95 by job; a job with no traffic series has metrics null', async () => {
        const replies = { instant: { ...ALL_UP.instant, [RPS_QUERY]: { a: 5, b: 0 }, [ERRORS_QUERY]: { a: 0.5 }, [P95_QUERY]: { a: 0.12, b: 'NaN' } } };
        const h = await readHealth('http://prom', { fetchImpl: stub(replies), history: false });
        assert.equal(h.available, true);
        assert.deepEqual(h.jobs.a.metrics, { rps: 5, errorRatio: 0.1, p95ms: 120 });
        assert.deepEqual(h.jobs.b.metrics, { rps: 0, errorRatio: 0, p95ms: null });
        assert.equal(h.jobs.c.metrics, null);
        assert.deepEqual([h.jobs.a.up, h.jobs.a.health], [1, 1]);
    });

    it('stays available when the metrics queries fail', async () => {
        const h = await readHealth('http://prom', { fetchImpl: stub(ALL_UP) });
        assert.equal(h.available, true);
        assert.equal(h.jobs.a.metrics, null);
        assert.equal(h.jobs.a.since, null);
    });

    it('sends no time param for a live read', async () => {
        const calls = [];
        await readHealth('http://prom', { fetchImpl: stub(ALL_UP, calls), history: false });
        assert.ok(calls.every((u) => !u.searchParams.has('time')));
        assert.ok(calls.every((u) => u.pathname === '/api/v1/query'));
    });

    it('gives since from the range: the start of the current status', async () => {
        const end = Date.parse('2026-11-25T10:00:00Z') / 1000;
        const replies = {
            instant: { [UP_QUERY]: { a: 1, b: 1, c: 1 }, [HEALTH_QUERY]: { a: 0, b: 1, c: 1 } },
            range: { [UPDOWN_QUERY]: {
                a: [[end - 180, 1], [end - 120, 0], [end - 60, 0], [end, 0]],
                b: [[end - 180, 1], [end - 120, 1], [end - 60, 1], [end, 1]],
                c: [[end - 120, 1], [end - 60, 1], [end, 0]],
            } },
        };
        const h = await readHealth('http://prom', { fetchImpl: stub(replies), now: () => new Date(end * 1000) });
        assert.equal(h.jobs.a.since, new Date((end - 120) * 1000).toISOString());
        assert.equal(h.jobs.b.since, null);
        // The range says down, the instant read says up: it changed at the end of the window.
        assert.equal(h.jobs.c.since, '2026-11-25T10:00:00.000Z');
    });
});

describe('prometheus helpers', () => {
    it('computes metrics, matrices and since', () => {
        assert.equal(metricsOf(undefined, 1, 1), null);
        assert.deepEqual(metricsOf(4, undefined, undefined), { rps: 4, errorRatio: 0, p95ms: null });
        assert.deepEqual([...matrixByJob(matrix({ a: [[1, 1], [2, 'NaN']] })).a], [[1, 1]]);
        assert.throws(() => matrixByJob(vector({ a: 1 })));
        const end = new Date('2026-11-25T10:00:00Z');
        assert.equal(sinceOf([], 'up', end), null);
        assert.equal(sinceOf([{ t: 1, state: 'up' }], undefined, end), null);
    });
});
