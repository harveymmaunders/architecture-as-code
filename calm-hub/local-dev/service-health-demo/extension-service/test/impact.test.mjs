import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { metadataValue, prometheusJob } from '../calm.mjs';
import { analyse } from '../analysis.mjs';
import { jobState } from '../impact.mjs';
import { CONNECTS, FLOWS, UNAVAILABLE, architecture, health, relId } from './fixtures.mjs';

const computeImpact = (architecture, health) => analyse({ architecture, health });
const statuses = (impact) => Object.fromEntries([...impact.nodes.values()].map((n) => [n.id, n.status]));
const redEdges = (impact) => impact.edges.filter((e) => e.broken).map((e) => e.id).sort();

describe('impact and edge rules', () => {
    it('marks every service healthy when all are up', () => {
        const impact = computeImpact(architecture(), health());
        assert.ok(Object.values(statuses(impact)).every((s) => s === 'healthy'));
        assert.deepEqual(redEdges(impact), []);
    });

    it('central-db down impacts everything upstream and turns every edge red', () => {
        const impact = computeImpact(architecture(), health({ failing: ['central-db'] }));
        assert.deepEqual(statuses(impact), {
            'customer-portal': 'impacted', 'admin-console': 'impacted', 'api-gateway': 'impacted',
            'auth-service': 'impacted', 'orders-api': 'impacted', 'payments-api': 'impacted', 'central-db': 'down',
        });
        assert.deepEqual(redEdges(impact), CONNECTS.map(([s, d]) => relId(s, d)).sort());
        assert.equal(impact.nodes.get('orders-api').reason, 'depends on central-db');
        assert.match(impact.nodes.get('customer-portal').reason, /^depends on central-db via api-gateway → /);
    });

    it('orders-api down impacts only api-gateway and the UIs', () => {
        const impact = computeImpact(architecture(), health({ stopped: ['orders-api'] }));
        assert.deepEqual(statuses(impact), {
            'customer-portal': 'impacted', 'admin-console': 'impacted', 'api-gateway': 'impacted',
            'auth-service': 'healthy', 'orders-api': 'down', 'payments-api': 'healthy', 'central-db': 'healthy',
        });
        assert.deepEqual(redEdges(impact), [
            'admin-console-to-api-gateway', 'api-gateway-to-orders-api', 'customer-portal-to-api-gateway',
        ]);
        assert.equal(impact.nodes.get('orders-api').reason, 'Prometheus cannot scrape it (up = 0)');
        assert.equal(impact.nodes.get('api-gateway').reason, 'depends on orders-api');
    });

    it('a leaf UI down impacts nothing', () => {
        const impact = computeImpact(architecture(), health({ failing: ['customer-portal'] }));
        const s = statuses(impact);
        assert.equal(s['customer-portal'], 'down');
        assert.ok(Object.entries(s).filter(([id]) => id !== 'customer-portal').every(([, v]) => v === 'healthy'));
        assert.deepEqual(redEdges(impact), []);
    });

    it('lists every down dependency of an impacted node', () => {
        const impact = computeImpact(architecture(), health({ failing: ['orders-api', 'auth-service'] }));
        assert.deepEqual(impact.nodes.get('api-gateway').downDependencies.sort(), ['auth-service', 'orders-api']);
        assert.equal(impact.nodes.get('payments-api').status, 'healthy');
    });

    it('marks every node unknown and no edge red when Prometheus is unavailable', () => {
        const impact = computeImpact(architecture(), UNAVAILABLE);
        assert.equal(impact.available, false);
        assert.ok(Object.values(statuses(impact)).every((s) => s === 'unknown'));
        assert.deepEqual(redEdges(impact), []);
    });
});

describe('down rule', () => {
    it('treats up = 0, a failing check and missing series as down', () => {
        const h = { available: true, jobs: { a: { up: 1, health: 1 }, b: { up: 0 }, c: { up: 1, health: 0 }, d: { up: 1 } } };
        assert.equal(jobState(h, 'a').down, false);
        assert.equal(jobState(h, 'b').down, true);
        assert.equal(jobState(h, 'c').down, true);
        assert.equal(jobState(h, 'd').down, true);
        assert.equal(jobState(h, 'missing').down, true);
    });
});

describe('metadata', () => {
    it('reads the job from object metadata, array metadata, or falls back to the unique-id', () => {
        assert.equal(prometheusJob({ 'unique-id': 'a', metadata: { 'prometheus-job': 'job-a' } }), 'job-a');
        assert.equal(prometheusJob({ 'unique-id': 'b', metadata: [{ x: 1 }, { 'prometheus-job': 'job-b' }] }), 'job-b');
        assert.equal(prometheusJob({ 'unique-id': 'c' }), 'c');
        assert.equal(prometheusJob({ 'unique-id': 'd', metadata: [null, 'text', { 'prometheus-job': '' }] }), 'd');
        assert.equal(metadataValue({ metadata: 'nonsense' }, 'k'), undefined);
    });

    it('uses the job override to find the samples', () => {
        const arch = architecture();
        arch.nodes.find((n) => n['unique-id'] === 'central-db').metadata = { 'prometheus-job': 'db-job' };
        const h = health();
        h.jobs['db-job'] = { up: 1, health: 0 };
        const impact = computeImpact(arch, h);
        assert.equal(impact.nodes.get('central-db').status, 'down');
        assert.equal(impact.nodes.get('central-db').job, 'db-job');
    });
});

describe('flow URLs', () => {
    it('reads URLs from top-level flows and from object or array metadata, once each', async () => {
        const { flowUrlsOf, inlineFlowsOf } = await import('../calm.mjs');
        assert.deepEqual(flowUrlsOf({ flows: ['a', { transitions: [] }], metadata: { flows: ['a', 'b'] } }), ['a', 'b']);
        assert.deepEqual(flowUrlsOf({ metadata: [{ owner: 'x' }, { flows: ['c'] }] }), ['c']);
        assert.deepEqual(flowUrlsOf({}), []);
        assert.equal(inlineFlowsOf({ flows: ['a', { transitions: [] }] }).length, 1);
    });
});

describe('unusual architectures', () => {
    it('handles a dependency cycle, other relationship types and a job with no series', () => {
        const arch = {
            nodes: [{ 'unique-id': 'a' }, { 'unique-id': 'b' }, { 'unique-id': 'constructor' }, { 'unique-id': 'c' }],
            relationships: [
                { 'unique-id': 'a-b', 'relationship-type': { connects: { source: { node: 'a' }, destination: { node: 'b' } } } },
                { 'unique-id': 'b-a', 'relationship-type': { connects: { source: { node: 'b' }, destination: { node: 'a' } } } },
                { 'unique-id': 'b-c', 'relationship-type': { connects: { source: { node: 'b' }, destination: { node: 'c' } } } },
                { 'unique-id': 'i', 'relationship-type': { interacts: { actor: 'a', nodes: 'not-an-array' } } },
                { 'unique-id': 'k', 'relationship-type': { 'composed-of': { container: 'a', nodes: ['b', null] } } },
                { 'unique-id': 's', 'relationship-type': 'connects' },
            ],
        };
        const sample = { up: 1, health: 1 };
        const impact = computeImpact(arch, { available: true, jobs: { a: sample, b: sample, c: { up: 1, health: 0 } } });
        assert.equal(impact.nodes.get('c').status, 'down');
        assert.equal(impact.nodes.get('a').status, 'impacted');
        assert.equal(impact.nodes.get('a').reason, 'depends on c via b');
        assert.equal(impact.nodes.get('constructor').status, 'down');
        assert.match(impact.nodes.get('constructor').reason, /no metrics/);
        assert.deepEqual(impact.edges.filter((e) => e.broken).map((e) => e.id).sort(), ['a-b', 'b-a', 'b-c']);
        assert.deepEqual(impact.flows, []);
    });
});

