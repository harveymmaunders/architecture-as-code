import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { analyse, flowCriticality, flowSlug, parseSimulate } from '../analysis.mjs';
import { warnReason, warnThresholds } from '../impact.mjs';
import { FLOWS, UNAVAILABLE, architecture, flow, health } from './fixtures.mjs';

const flows = (list = FLOWS) => list.map((f) => ({ flow: f, source: `http://hub/calm/namespaces/ns/flows/${f['unique-id']}/versions/1.0.0` }));
const statuses = (a) => Object.fromEntries([...a.nodes.values()].map((n) => [n.id, n.status]));
const byId = (a) => Object.fromEntries(a.flows.map((f) => [f.id, f]));

// Health with traffic metrics; `slow` and `erroring` jobs cross the warn thresholds.
function healthWith({ slow = [], erroring = [], ...rest } = {}) {
    const h = health(rest);
    for (const [job, sample] of Object.entries(h.jobs)) {
        sample.metrics = { rps: 5, errorRatio: erroring.includes(job) ? 0.2 : 0.01, p95ms: slow.includes(job) ? 900 : 40 };
    }
    return h;
}

describe('analysis: node status', () => {
    it('gives healthy nodes, ok flows and the metrics when all are up', () => {
        const a = analyse({ architecture: architecture(), health: healthWith(), flows: flows() });
        assert.ok(Object.values(statuses(a)).every((s) => s === 'healthy'));
        assert.deepEqual(a.summary, { down: 0, warn: 0, impacted: 0, healthy: 7, unknown: 0,
            flows: { broken: 0, degraded: 0, ok: 4, unknown: 0 }, criticalBroken: 0 });
        assert.deepEqual(a.nodes.get('orders-api').metrics, { rps: 5, errorRatio: 0.01, p95ms: 40 });
        assert.equal(a.edges.filter((e) => e.broken).length, 0);
    });

    it('puts a node in warn by latency and by errors, without impacting its dependents', () => {
        const a = analyse({ architecture: architecture(), health: healthWith({ slow: ['payments-api'], erroring: ['auth-service'] }), flows: flows() });
        const s = statuses(a);
        assert.equal(s['payments-api'], 'warn');
        assert.equal(s['auth-service'], 'warn');
        assert.equal(s['api-gateway'], 'healthy');
        assert.match(a.nodes.get('payments-api').reason, /p95 latency 900 ms is over 500 ms/);
        assert.match(a.nodes.get('auth-service').reason, /error ratio 20% is over 5%/);
        assert.equal(a.summary.warn, 2);
        assert.equal(a.edges.filter((e) => e.broken).length, 0);
    });

    it('never gives warn when metrics are missing', () => {
        const a = analyse({ architecture: architecture(), health: health(), flows: flows() });
        assert.equal(a.summary.warn, 0);
        assert.equal(a.nodes.get('orders-api').metrics, null);
    });

    it('reads thresholds from the env, and from the option', () => {
        process.env.WARN_P95_MS = '30';
        try {
            assert.equal(warnThresholds().p95ms, 30);
        } finally {
            delete process.env.WARN_P95_MS;
        }
        assert.equal(warnThresholds().p95ms, 500);
        const a = analyse({ architecture: architecture(), health: healthWith(), thresholds: { errorRatio: 0.5, p95ms: 10 } });
        assert.equal(a.summary.warn, 7);
        assert.equal(warnReason({ rps: 0, errorRatio: 0, p95ms: null }), undefined);
    });

    it('gives the direct dependents and dependencies, and the node metadata', () => {
        const arch = architecture();
        arch.nodes[4].metadata = { 'prometheus-job': 'orders-api', owner: 'orders-team', oncall: '@orders', runbook: 'https://rb/orders', tier: '1' };
        const a = analyse({ architecture: arch, health: health() });
        const orders = a.nodes.get('orders-api');
        assert.deepEqual(orders.dependents, ['api-gateway']);
        assert.deepEqual(orders.dependencies, ['payments-api', 'central-db']);
        assert.deepEqual([orders.owner, orders.oncall, orders.runbook, orders.tier], ['orders-team', '@orders', 'https://rb/orders', '1']);
        assert.equal(a.nodes.get('central-db').owner, null);
    });

    it('passes since through, and gives unknown when Prometheus fails', () => {
        const h = health({ failing: ['orders-api'] });
        h.jobs['orders-api'].since = '2026-11-25T09:58:00.000Z';
        const down = analyse({ architecture: architecture(), health: h });
        assert.equal(down.nodes.get('orders-api').since, '2026-11-25T09:58:00.000Z');
        assert.equal(down.nodes.get('api-gateway').status, 'impacted');
        assert.equal(down.nodes.get('api-gateway').since, '2026-11-25T09:58:00.000Z');
        h.jobs['orders-api'].since = null;
        assert.equal(analyse({ architecture: architecture(), health: h }).nodes.get('api-gateway').since, null);

        const a = analyse({ architecture: architecture(), health: UNAVAILABLE, flows: flows() });
        assert.equal(a.available, false);
        assert.match(a.error, /could not be read/);
        assert.equal(a.summary.unknown, 7);
        assert.equal(a.summary.flows.unknown, 4);
        assert.ok(a.flows.every((f) => f.steps.every((s) => s.status === 'unknown')));
    });
});

describe('analysis: root cause', () => {
    it('central-db down causes payments-api down: only central-db is a root cause', () => {
        const a = analyse({ architecture: architecture(), health: health({ failing: ['central-db', 'payments-api'] }), flows: flows() });
        assert.deepEqual(a.rootCauses, ['central-db']);
        const payments = a.nodes.get('payments-api');
        assert.equal(payments.rootCause, false);
        assert.deepEqual(payments.causedBy, ['central-db']);
        assert.match(payments.reason, /caused by central-db/);
        assert.equal(a.nodes.get('central-db').rootCause, true);
        assert.deepEqual(a.nodes.get('central-db').causedBy, []);
        assert.deepEqual(a.nodes.get('api-gateway').causedBy, ['central-db']);
    });

    it('two independent failures are both root causes', () => {
        const a = analyse({ architecture: architecture(), health: health({ failing: ['customer-portal', 'admin-console'] }) });
        assert.deepEqual(a.rootCauses, ['customer-portal', 'admin-console']);
    });

    it('a down node that depends on another down node is not a root cause', () => {
        const a = analyse({ architecture: architecture(), health: health({ failing: ['customer-portal', 'central-db'] }) });
        assert.deepEqual(a.rootCauses, ['central-db']);
        assert.deepEqual(a.nodes.get('customer-portal').causedBy, ['central-db']);
    });

    it('down nodes in a cycle are root causes together', () => {
        const connects = (s, d) => ({ 'unique-id': `${s}-${d}`, 'relationship-type': { connects: { source: { node: s }, destination: { node: d } } } });
        const arch = { nodes: [{ 'unique-id': 'a' }, { 'unique-id': 'b' }, { 'unique-id': 'c' }],
            relationships: [connects('a', 'b'), connects('b', 'a'), connects('c', 'a')] };
        const a = analyse({ architecture: arch, health: { available: true, jobs: { a: { up: 0 }, b: { up: 0 }, c: { up: 1, health: 1 } } } });
        assert.deepEqual(a.rootCauses, ['a', 'b']);
        assert.equal(a.nodes.get('c').status, 'impacted');
        assert.deepEqual(a.nodes.get('c').causedBy, ['a', 'b']);
    });
});

describe('analysis: flows', () => {
    it('orders-api down: a flow that passes an impacted node but avoids orders-api is ok', () => {
        const a = analyse({ architecture: architecture(), health: health({ stopped: ['orders-api'] }), flows: flows() });
        const f = byId(a);
        assert.equal(f['place-order'].status, 'broken');
        assert.deepEqual(f['place-order'].breaking, ['orders-api']);
        assert.equal(f['customer-login'].status, 'ok');
        assert.equal(f['take-payment'].status, 'ok');
        assert.equal(f['staff-login'].status, 'ok');
        assert.equal(statuses(a)['api-gateway'], 'impacted');
    });

    it('a flow that touches a warn node is degraded, with at-risk steps', () => {
        const a = analyse({ architecture: architecture(), health: healthWith({ slow: ['payments-api'] }), flows: flows() });
        const f = byId(a)['take-payment'];
        assert.equal(f.status, 'degraded');
        assert.deepEqual(f.degrading, ['payments-api']);
        assert.deepEqual(f.steps.map((s) => s.status), ['at-risk', 'at-risk']);
        assert.match(f.steps[0].reason, /payments-api is in warn/);
        assert.equal(byId(a)['place-order'].status, 'ok');
    });

    it('a down node wins over a warn node in a flow and in a step', () => {
        const a = analyse({ architecture: architecture(), health: healthWith({ slow: ['api-gateway'], failing: ['orders-api'] }), flows: flows() });
        const f = byId(a)['place-order'];
        assert.equal(f.status, 'broken');
        assert.deepEqual(f.degrading, ['api-gateway']);
        assert.deepEqual(f.steps.map((s) => s.status), ['at-risk', 'fails', 'fails']);
    });

    it('gives the steps in order with from, to, protocol and the failing step', () => {
        const arch = architecture();
        arch.relationships.find((r) => r['unique-id'] === 'api-gateway-to-orders-api').protocol = 'HTTPS';
        const a = analyse({ architecture: arch, health: health({ failing: ['orders-api'] }), flows: flows() });
        const steps = byId(a)['place-order'].steps;
        assert.deepEqual(steps.map((s) => [s.sequence, s.from, s.to, s.status]), [
            [1, 'customer-portal', 'api-gateway', 'ok'],
            [2, 'api-gateway', 'orders-api', 'fails'],
            [3, 'orders-api', 'central-db', 'fails'],
        ]);
        assert.equal(steps[1].protocol, 'HTTPS');
        assert.equal(steps[0].protocol, null);
        assert.match(steps[1].reason, /orders-api is down \(health check failing\)/);
        assert.equal(steps[0].description, 'customer-portal → api-gateway');
    });

    it('reverses a step that goes from destination to source, and marks a missing relationship', () => {
        const f = { 'unique-id': 'r', transitions: [
            { 'relationship-unique-id': 'api-gateway-to-orders-api', 'sequence-number': 1, direction: 'destination-to-source' },
            { 'relationship-unique-id': 'nope', 'sequence-number': 2 },
        ] };
        const [result] = analyse({ architecture: architecture(), health: health(), flows: [{ flow: f }] }).flows;
        assert.deepEqual([result.steps[0].from, result.steps[0].to], ['orders-api', 'api-gateway']);
        assert.equal(result.steps[1].status, 'unknown');
        assert.match(result.steps[1].reason, /not in the architecture/);
        assert.equal(result.status, 'ok');
    });

    it('counts the flows through each node, and how many are broken or degraded', () => {
        const a = analyse({ architecture: architecture(), health: healthWith({ failing: ['orders-api'], slow: ['payments-api'] }), flows: flows() });
        assert.deepEqual(a.nodes.get('api-gateway').flows, { total: 3, broken: 1, degraded: 1 });
        assert.deepEqual(a.nodes.get('central-db').flows, { total: 3, broken: 1, degraded: 1 });
        assert.deepEqual(a.nodes.get('admin-console').flows, { total: 1, broken: 0, degraded: 0 });
    });

    it('gives the slug, criticality, and sorts broken critical flows first', () => {
        const critical = { ...flow('a-critical', ['customer-portal', 'api-gateway'], ['api-gateway', 'orders-api']), metadata: { criticality: 'critical' } };
        const normal = flow('a-normal', ['api-gateway', 'orders-api']);
        const a = analyse({ architecture: architecture(), health: health({ failing: ['orders-api'] }), flows: flows([normal, critical, ...FLOWS]) });
        assert.deepEqual(a.flows.slice(0, 2).map((f) => f.id), ['a-critical', 'a-normal']);
        assert.equal(a.flows[0].slug, 'a-critical');
        assert.equal(a.summary.criticalBroken, 1);
        assert.equal(flowSlug({ $id: 'http://h/calm/namespaces/n/flows/x%20y/versions/1.0.0' }), 'x y');
        assert.equal(flowSlug({ 'unique-id': 'inline' }, 'inline'), 'inline');
        assert.equal(flowCriticality({ criticality: 'HIGH' }), 'high');
        assert.equal(flowCriticality({ metadata: [{ criticality: 'bogus' }] }), 'normal');
    });
});

describe('analysis: simulate', () => {
    it('forces listed nodes down, ignores unknown ids, and leaves since null', () => {
        const h = health();
        h.jobs['orders-api'].since = '2026-11-25T08:00:00.000Z';
        const a = analyse({ architecture: architecture(), health: h, flows: flows(), simulate: 'orders-api, nope,orders-api' });
        assert.deepEqual(a.simulated, ['orders-api']);
        const orders = a.nodes.get('orders-api');
        assert.equal(orders.status, 'down');
        assert.equal(orders.simulated, true);
        assert.equal(orders.reason, 'simulated');
        assert.equal(orders.since, null);
        assert.equal(byId(a)['place-order'].status, 'broken');
        assert.deepEqual(a.rootCauses, ['orders-api']);
        assert.deepEqual(parseSimulate(['a', '', 3, 'b']), ['a', 'b']);
    });

    it('simulates even when Prometheus fails', () => {
        const a = analyse({ architecture: architecture(), health: UNAVAILABLE, flows: flows(), simulate: ['central-db'] });
        assert.equal(a.nodes.get('central-db').status, 'down');
        assert.equal(a.nodes.get('orders-api').status, 'impacted');
        assert.equal(byId(a)['place-order'].status, 'broken');
        assert.equal(byId(a)['customer-login'].status, 'unknown');
    });
});

const dir = new URL('../../architecture/', import.meta.url);
const archFile = new URL('service-health.architecture.json', dir);

describe('analysis: demo architecture files', { skip: !existsSync(archFile) && 'the demo architecture is not there' }, () => {
    const arch = () => JSON.parse(readFileSync(archFile, 'utf8'));
    const demoFlows = () => readdirSync(new URL('flows/', dir)).filter((f) => f.endsWith('.json'))
        .map((f) => ({ flow: JSON.parse(readFileSync(new URL(`flows/${f}`, dir), 'utf8')) }));

    it('orders-api down breaks 9 flows; the admin flows that avoid it stay ok', () => {
        const a = analyse({ architecture: arch(), health: health({ failing: ['orders-api'] }), flows: demoFlows() });
        assert.equal(a.summary.flows.broken, 9);
        assert.equal(a.summary.flows.degraded, 0);
        const admin = a.flows.filter((f) => f.slug.startsWith('admin-') && f.status !== 'broken');
        assert.ok(admin.length > 0);
        assert.ok(admin.every((f) => f.status === 'ok'), admin.map((f) => `${f.slug}:${f.status}`).join(', '));
        assert.ok(a.flows.every((f) => !f.slug.startsWith('flow-')));
    });

    it('an admin flow that touches a warn node is degraded', () => {
        const h = health({ failing: ['orders-api'] });
        h.jobs['auth-service'].metrics = { rps: 5, errorRatio: 0.3, p95ms: 20 };
        const a = analyse({ architecture: arch(), health: h, flows: demoFlows() });
        const login = a.flows.find((f) => f.slug === 'admin-login');
        assert.equal(login.status, 'degraded');
        assert.deepEqual(login.degrading, ['auth-service']);
    });
});
