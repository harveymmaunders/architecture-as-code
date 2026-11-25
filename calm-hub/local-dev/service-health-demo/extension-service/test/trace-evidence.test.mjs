// Traces in the analysis (per flow only), and the cached trace reader.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTraceReader, tryItLink } from '../traces.mjs';
import { relId } from './fixtures.mjs';
import { analysisOf, healthWith } from './pages-fixtures.mjs';

const END = '2026-11-25T10:00:00.000Z';
const RECENT = '2026-11-25T09:59:30.000Z';
const OLD = '2026-11-25T09:50:00.000Z';
const quiet = { log() {}, warn() {}, error() {} };

const failed = (extra) => ({ traceId: 'a'.repeat(32), time: RECENT, traceUrl: 'http://g/trace', ...extra });
const entry = (total, failures, extra = {}) => ({ total, failed: failures, errorRatio: total ? failures / total : 0, lastFailed: null, searchUrl: 'http://g/search', ...extra });

// payments-api fails 9 of 30 calls into it; take-payment fails at step 1 in 6 of 20 runs.
function traces({ time = RECENT, nodeFailures = 9, total = 30 } = {}) {
    return {
        available: true,
        window: { minutes: 15, end: END },
        flows: {
            'take-payment': entry(20, 6, { lastFailed: failed({ time, failedStep: 1, relationship: relId('api-gateway', 'payments-api'), node: 'payments-api', reason: 'payments-api replied 500' }), lastRun: { traceUrl: 'http://g/last' } }),
            'place-order': entry(20, 0, { lastRun: { traceUrl: 'http://g/last-order' } }),
        },
        byNode: {
            'payments-api': entry(total, nodeFailures, { lastFailed: failed({ time }) }),
            'api-gateway': entry(60, 0),
        },
        byRelationship: {
            [relId('api-gateway', 'payments-api')]: entry(total, nodeFailures, { lastFailed: failed({ time }) }),
        },
    };
}

describe('traces in the analysis', () => {
    it('never puts a node or an edge in warn for trace failures', () => {
        const a = analysisOf(healthWith(), { traces: traces() });
        assert.equal(a.nodes.get('payments-api').status, 'healthy');
        assert.equal(a.edges.some((e) => e.warn), false);
        assert.deepEqual(a.traces, { available: true, minutes: 15 });
    });

    it('degrades a flow that fails in traces but is healthy by metrics, at the failed step', () => {
        const t = traces({ nodeFailures: 0 });
        const a = analysisOf(healthWith(), { traces: t });
        const flow = a.flows.find((f) => f.slug === 'take-payment');
        assert.equal(flow.status, 'degraded');
        assert.deepEqual(flow.degrading, []);
        assert.equal(flow.traceFailure.sequence, 1);
        assert.equal(flow.steps[0].status, 'at-risk');
        assert.equal(flow.traces.lastRun.traceUrl, 'http://g/last');
        assert.equal(a.flows.find((f) => f.slug === 'place-order').status, 'ok');
    });

    it('keeps an old failure as evidence, without the degraded status', () => {
        const t = traces({ nodeFailures: 0 });
        t.flows['take-payment'].lastFailed.time = OLD;
        const flow = analysisOf(healthWith(), { traces: t }).flows.find((f) => f.slug === 'take-payment');
        assert.equal(flow.status, 'ok');
        assert.equal(flow.traceFailure.sequence, 1);
    });

    it('ignores unavailable traces and a simulation', () => {
        const none = analysisOf(healthWith(), { traces: { available: false, error: 'Tempo replied 503' } });
        assert.deepEqual(none.traces, { available: false, error: 'Tempo replied 503' });
        const simulated = analysisOf(healthWith(), { traces: traces({ nodeFailures: 0 }), simulate: ['auth-service'] });
        assert.equal(simulated.flows.find((f) => f.slug === 'take-payment').status, 'ok');
    });

    it('gives each flow its starting node: the source of the first transition', () => {
        const a = analysisOf();
        assert.equal(a.flows.find((f) => f.slug === 'place-order').start, 'customer-portal');
        assert.equal(a.flows.find((f) => f.slug === 'take-payment').start, 'api-gateway');
    });
});

describe('createTraceReader', () => {
    it('reads both windows once per cache period, and never throws', async () => {
        let t = 0;
        const windows = [];
        let fail = false;
        const readFn = async (url, options) => {
            windows.push(options.minutes);
            assert.equal(url, 'http://tempo:3200');
            assert.equal(options.grafanaUrl, 'http://g:3000');
            if (fail && options.minutes === 15) throw new Error('boom');
            return { available: true, window: { minutes: options.minutes }, flows: {}, byRelationship: {}, byNode: { a: { total: options.minutes, inbound: 2, failed: 1, errorRatio: 0.5 } } };
        };
        const read = createTraceReader({ tempoUrl: 'http://tempo:3200', grafanaUrl: 'http://g:3000', cacheMs: 1000, readFn, clock: () => t, log: quiet });
        const first = await read();
        assert.deepEqual(first.byNode.a.recent, { total: 5, inbound: 2, failed: 1, errorRatio: 0.5, minutes: 5 });
        t = 500;
        await read();
        assert.deepEqual(windows, [15, 5]);
        t = 1000;
        fail = true;
        assert.deepEqual(await read(), { available: false, error: 'boom' });
        assert.equal(windows.length, 4);
    });

    it('uses the short window of a flow for the rule', () => {
        const t = traces({ nodeFailures: 0 });
        t.flows['take-payment'].recent = { total: 10, failed: 0, errorRatio: 0, minutes: 5 };
        assert.equal(analysisOf(healthWith(), { traces: t }).flows.find((f) => f.slug === 'take-payment').status, 'ok');
    });

    it('sends nothing when Tempo is not set', async () => {
        const read = createTraceReader({ readFn: () => assert.fail('no read'), log: quiet });
        assert.deepEqual(await read(), { available: false, error: 'TEMPO_URL is not set' });
    });

    it('links a flow to the UI that it starts at, and not a flow that starts at a service', () => {
        assert.deepEqual(tryItLink({ slug: 'admin-login', steps: [{ from: 'admin-console' }] }), { label: 'Try it', href: 'http://localhost:9102/?flow=admin-login&run=1' });
        assert.equal(tryItLink({ slug: 'order-payment-sync', steps: [{ from: 'orders-api' }] }), undefined);
        assert.equal(tryItLink({ slug: 'x', steps: [] }), undefined);
    });
});
