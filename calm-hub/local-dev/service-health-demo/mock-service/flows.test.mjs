// /call, /work, the flow runner, the flow driver and the UI page, with real services on loopback ports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { connectsOf, loadFlows, resolveFlow, runFlow, traceUrl } from './flows.mjs';
import { pickFlows, runAll } from './flow-driver.mjs';
import { calmBaggage, createMockService } from './server.mjs';
import { SPAN_KIND, STATUS, createTracer } from './tracing.mjs';

const ARCHITECTURE_DIR = fileURLToPath(new URL('../architecture', import.meta.url));
const NODES = ['customer-portal', 'admin-console', 'api-gateway', 'auth-service', 'orders-api', 'payments-api', 'central-db'];

const exported = [];
const sinkFetch = async (url, init) => {
    const { resourceSpans } = JSON.parse(init.body);
    for (const rs of resourceSpans) {
        const service = rs.resource.attributes.find((a) => a.key === 'service.name').value.stringValue;
        for (const span of rs.scopeSpans[0].spans) {
            const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
            exported.push({ ...span, service, attrs });
        }
    }
    return new Response('{}');
};
const tracerFor = (serviceName) => createTracer({ serviceName, endpoint: 'http://sink', fetchImpl: sinkFetch, flushMs: 60_000 });

let flows;
const servers = {};
const tracers = {};
const ports = {};
const slept = [];
let closedPort;
const urlOf = (node) => `http://127.0.0.1:${ports[node] ?? closedPort}`;
const flushAll = () => Promise.all(Object.values(tracers).map((t) => t.flush()));
const resetExported = async () => { await flushAll(); exported.length = 0; };
const post = (node, path, body, headers = {}) => fetch(urlOf(node) + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const setHealth = (node, state) => fetch(`${urlOf(node)}/health/${state}`, { method: 'POST' });

before(async () => {
    const probe = createMockService('probe', { tickMs: 0 });
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    closedPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    flows = await loadFlows(ARCHITECTURE_DIR);
    for (const node of NODES) {
        tracers[node] = tracerFor(node);
        servers[node] = createMockService(node, {
            tickMs: 0, tracer: tracers[node], peerUrl: urlOf, flows, grafanaUrl: 'http://grafana.test:3000', random: () => 0.5,
            sleep: async (ms) => { slept.push(ms); }, maxWorkMs: 1000,
        });
        await new Promise((resolve) => servers[node].listen(0, '127.0.0.1', resolve));
        ports[node] = servers[node].address().port;
    }
});

after(() => Object.values(servers).forEach((server) => server.close()));

test('connects relationships resolve, and direction destination-to-source swaps the ends', () => {
    const connects = connectsOf({ relationships: [
        { 'unique-id': 'a-to-b', 'relationship-type': { connects: { source: { node: 'a' }, destination: { node: 'b' } } } },
        { 'unique-id': 'ignored', 'relationship-type': { interacts: { actor: 'x', nodes: ['a'] } } },
    ] });
    assert.deepEqual(connects, { 'a-to-b': { source: 'a', destination: 'b' } });
    const flow = resolveFlow('f', { 'unique-id': 'flow-f', name: 'F', transitions: [
        { 'relationship-unique-id': 'a-to-b', 'sequence-number': 2, direction: 'destination-to-source' },
        { 'relationship-unique-id': 'a-to-b', 'sequence-number': 1 },
    ] }, connects);
    assert.deepEqual(flow.steps.map((s) => [s.sequence, s.from, s.to]), [[1, 'a', 'b'], [2, 'b', 'a']]);
    assert.equal(flow.start, 'a');
    assert.equal(flow.criticality, 'normal');
    assert.throws(() => resolveFlow('g', { transitions: [{ 'relationship-unique-id': 'nope', 'sequence-number': 1 }] }, connects), /nope/);
});

test('all 20 demo flows load with their slug, id, criticality and start node', () => {
    assert.equal(flows.length, 20);
    const place = flows.find((f) => f.slug === 'place-order');
    assert.equal(place.id, 'flow-place-order');
    assert.equal(place.criticality, 'critical');
    assert.equal(place.start, 'customer-portal');
    assert.deepEqual(place.steps[2], {
        sequence: 3, relationship: 'api-gateway-to-orders-api', description: 'Gateway routes the order to the orders API', from: 'api-gateway', to: 'orders-api',
    });
});

test('baggage gives only the calm.* keys, decoded', () => {
    assert.deepEqual(calmBaggage('calm.flow.unique-id=flow%20x,other=1, calm.flow.step=3;prop=1,bad,calm.x=%E0%A4%A'), {
        'calm.flow.unique-id': 'flow x', 'calm.flow.step': '3',
    });
});

test('/call makes a client span, calls /work with the trace context, and /work makes the server span', async () => {
    await resetExported();
    const res = await post('api-gateway', '/call', { to: 'orders-api', relationship: 'api-gateway-to-orders-api', flow: 'flow-place-order', step: 3 },
        { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 200);
    assert.equal(body.reply.status, 'accepted');
    await flushAll();
    const client = exported.find((s) => s.kind === SPAN_KIND.client);
    const server = exported.find((s) => s.kind === SPAN_KIND.server);
    assert.equal(client.service, 'api-gateway');
    assert.equal(client.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(client.parentSpanId, '00f067aa0ba902b7');
    assert.equal(client.attrs['calm.relationship.unique-id'], 'api-gateway-to-orders-api');
    assert.equal(client.attrs['calm.flow.unique-id'], 'flow-place-order');
    assert.equal(client.attrs['calm.flow.step'], '3');
    assert.equal(client.attrs['peer.service'], 'orders-api');
    assert.equal(server.service, 'orders-api');
    assert.equal(server.parentSpanId, client.spanId);
    assert.equal(server.attrs['calm.relationship.unique-id'], 'api-gateway-to-orders-api');
    assert.equal(server.status.code, STATUS.unset);
});

test('/work fails with 503 and an error span while DOWN, and 500 at the chaos error ratio', async () => {
    await resetExported();
    await setHealth('orders-api', 'down');
    const down = await post('api-gateway', '/call', { to: 'orders-api', relationship: 'api-gateway-to-orders-api' });
    assert.equal(down.status, 502);
    assert.equal((await down.json()).reason, 'orders-api replied 503: orders-api is DOWN');
    await setHealth('orders-api', 'up');

    await fetch(`${urlOf('payments-api')}/chaos/errors?ratio=1`, { method: 'POST' });
    const chaos = await fetch(`${urlOf('payments-api')}/work`);
    assert.equal(chaos.status, 500);
    await fetch(`${urlOf('payments-api')}/chaos/reset`, { method: 'POST' });

    await flushAll();
    const errors = exported.filter((s) => s.status.code === STATUS.error).map((s) => [s.service, s.kind, s.status.message]).sort();
    assert.deepEqual(errors, [
        ['api-gateway', SPAN_KIND.client, 'orders-api replied 503: orders-api is DOWN'],
        ['orders-api', SPAN_KIND.server, 'orders-api is DOWN'],
        ['payments-api', SPAN_KIND.server, 'payments-api failed the request (chaos)'],
    ]);
    const metrics = await (await fetch(`${urlOf('orders-api')}/metrics`)).text();
    assert.match(metrics, /path="\/work",code="503"\} 1$/m);
});

test('/work sleeps the chaos latency, capped', async () => {
    slept.length = 0;
    await fetch(`${urlOf('auth-service')}/chaos/latency?ms=5000`, { method: 'POST' });
    assert.equal((await fetch(`${urlOf('auth-service')}/work`)).status, 200);
    await fetch(`${urlOf('auth-service')}/chaos/reset`, { method: 'POST' });
    assert.equal((await fetch(`${urlOf('auth-service')}/work`)).status, 200);
    assert.deepEqual(slept, [1000, 50]);
});

test('the database counts records per caller', async () => {
    const first = await (await post('orders-api', '/call', { to: 'central-db' })).json();
    const second = await (await post('orders-api', '/call', { to: 'central-db' })).json();
    const other = await (await post('auth-service', '/call', { to: 'central-db' })).json();
    assert.equal(second.reply.records, first.reply.records + 1);
    assert.equal(second.reply.caller, 'orders-api');
    assert.equal(other.reply.caller, 'auth-service');
});

test('/call fails with the reason when the caller is DOWN or the destination is unreachable', async () => {
    await setHealth('orders-api', 'down');
    const self = await post('orders-api', '/call', { to: 'payments-api' });
    assert.equal(self.status, 502);
    assert.deepEqual(await self.json().then(({ reason, failedNode }) => ({ reason, failedNode })), { reason: 'orders-api is DOWN', failedNode: 'orders-api' });
    await setHealth('orders-api', 'up');

    const gone = await (await post('api-gateway', '/call', { to: 'stopped-service' })).json();
    assert.equal(gone.ok, false);
    assert.match(gone.reason, /^stopped-service unreachable: ECONNREFUSED$/);
    assert.equal(gone.failedNode, 'stopped-service');
});

test('/call refuses a bad body or target', async () => {
    for (const body of [{}, { to: 'Bad Host' }, { to: 'x'.repeat(80) }, { to: 'evil.com/x' }]) {
        assert.equal((await post('api-gateway', '/call', body)).status, 400, JSON.stringify(body));
    }
    const notJson = await fetch(`${urlOf('api-gateway')}/call`, { method: 'POST', body: '{' });
    assert.equal(notJson.status, 400);
    const big = await fetch(`${urlOf('api-gateway')}/call`, { method: 'POST', body: JSON.stringify({ to: 'a', pad: 'x'.repeat(5000) }) });
    assert.equal(big.status, 400);
    assert.equal((await fetch(`${urlOf('api-gateway')}/call`)).status, 405);
});

test('a flow runs every step and makes one trace whose root carries the flow', async () => {
    await resetExported();
    const tracer = tracerFor('flow-driver');
    const place = flows.find((f) => f.slug === 'place-order');
    const result = await runFlow(place, { tracer, serviceUrl: urlOf });
    await Promise.all([tracer.flush(), flushAll()]);
    assert.equal(result.ok, true);
    assert.equal(result.failedStep, null);
    assert.deepEqual(result.steps.map((s) => s.status), Array(6).fill('ok'));
    assert.ok(exported.every((s) => s.traceId === result.traceId));
    const root = exported.find((s) => !s.parentSpanId);
    assert.equal(root.name, 'flow Place Order');
    assert.equal(root.attrs['calm.flow.slug'], 'place-order');
    assert.equal(root.attrs['calm.flow.unique-id'], 'flow-place-order');
    assert.equal(root.attrs['calm.architecture'], 'service-health');
    assert.equal(exported.filter((s) => s.kind === SPAN_KIND.server).length, 6);
    assert.equal(exported.filter((s) => s.kind === SPAN_KIND.client).length, 6);
    const steps = exported.filter((s) => s.parentSpanId === root.spanId).map((s) => s.attrs['calm.flow.step']).sort();
    assert.deepEqual(steps, ['1', '2', '3', '4', '5', '6']);
});

test('a flow stops at the first failing step and records it on the root span', async () => {
    await resetExported();
    await setHealth('orders-api', 'down');
    const tracer = tracerFor('flow-driver');
    const place = flows.find((f) => f.slug === 'place-order');
    const result = await runFlow(place, { tracer, serviceUrl: urlOf });
    await setHealth('orders-api', 'up');
    await Promise.all([tracer.flush(), flushAll()]);
    assert.equal(result.ok, false);
    assert.equal(result.failedStep, 3);
    assert.deepEqual(result.steps.map((s) => s.status), ['ok', 'ok', 'failed', 'not-run', 'not-run', 'not-run']);
    assert.equal(result.steps[2].reason, 'orders-api replied 503: orders-api is DOWN');
    const root = exported.find((s) => !s.parentSpanId);
    assert.equal(root.status.code, STATUS.error);
    assert.equal(root.attrs['calm.flow.failed-step'], '3');
    assert.equal(root.attrs['calm.flow.failed-relationship'], 'api-gateway-to-orders-api');
    assert.equal(root.attrs['calm.flow.failure-reason'], 'orders-api replied 503: orders-api is DOWN');
    assert.equal(root.attrs['calm.flow.failed-node'], 'orders-api');
    assert.equal(result.steps[2].failedNode, 'orders-api');
    const step = exported.find((s) => s.attrs['calm.flow.step'] === '3' && s.attrs['calm.step.to']);
    assert.equal(step.status.code, STATUS.error);
    assert.equal(step.attrs['calm.failure.node'], 'orders-api');
    assert.equal(step.attrs['calm.failure.reason'], 'orders-api replied 503: orders-api is DOWN');
});

test('a step whose source cannot be reached fails with the reason', async () => {
    const tracer = tracerFor('flow-driver');
    const flow = resolveFlow('x', { 'unique-id': 'flow-x', transitions: [{ 'relationship-unique-id': 'r', 'sequence-number': 1 }] },
        { r: { source: 'stopped-service', destination: 'orders-api' } });
    const result = await runFlow(flow, { tracer, serviceUrl: urlOf, timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.match(result.steps[0].reason, /^stopped-service unreachable: /);
    assert.equal(result.steps[0].failedNode, 'stopped-service');
});

test('the driver picks one flow, by slug or id, or all', async () => {
    assert.equal(pickFlows(flows).length, 20);
    assert.deepEqual(pickFlows(flows, 'flow-admin-login').map((f) => f.slug), ['admin-login']);
    assert.throws(() => pickFlows(flows, 'nope'), /no flow nope/);
    const lines = [];
    const results = await runAll(pickFlows(flows, 'admin-login'), { tracer: tracerFor('flow-driver'), serviceUrl: urlOf }, (l) => lines.push(l));
    assert.equal(results.length, 1);
    assert.match(lines[0], /^ok {5}admin-login trace=[0-9a-f]{32}$/);
});

test('the UI page lists only the flows that start at the service, critical first, escaped', async () => {
    const res = await fetch(`${urlOf('customer-portal')}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<title>Customer Portal<\/title>/);
    assert.match(html, /data-slug="place-order"/);
    assert.doesNotMatch(html, /data-slug="admin-login"/);
    assert.doesNotMatch(html, /data-slug="order-payment-sync"/);
    assert.ok(html.indexOf('data-slug="customer-login"') < html.indexOf('data-slug="browse-catalogue"'));
    assert.doesNotMatch(html, /<(link|img)\b|src="http/);

    const admin = await (await fetch(`${urlOf('admin-console')}/flows`)).json();
    assert.deepEqual(admin.flows.map((f) => f.slug), ['admin-cert-rotation', 'admin-issue-refund', 'admin-login', 'admin-order-search',
        'admin-session-check', 'admin-user-management', 'payment-reconciliation']);
    assert.match(await (await fetch(`${urlOf('central-db')}/`)).text(), /No CALM flow starts at central-db/);
});

test('the page runs its own flows only, and returns the trace link', async () => {
    const res = await fetch(`${urlOf('customer-portal')}/flows/customer-login/run`, { method: 'POST' });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.ok, true);
    assert.equal(result.traceUrl, traceUrl('http://grafana.test:3000', result.traceId));
    assert.equal((await fetch(`${urlOf('customer-portal')}/flows/admin-login/run`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${urlOf('customer-portal')}/flows/customer-login/run`)).status, 405);
    assert.equal((await fetch(`${urlOf('customer-portal')}/flows/BAD/run`, { method: 'POST' })).status, 404);
    assert.match(await (await fetch(`${urlOf('customer-portal')}/metrics`)).text(), /path="\/flows\/run",code="200"\} 1$/m);
});

test('traceUrl opens the trace in Grafana Explore with the Tempo datasource', () => {
    const url = new URL(traceUrl('http://localhost:3000/d/service-health/x', 'abc123'));
    assert.equal(url.origin + url.pathname, 'http://localhost:3000/explore');
    const panes = JSON.parse(url.searchParams.get('panes'));
    assert.deepEqual(panes.trace.queries[0], { refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, queryType: 'traceql', query: 'abc123' });
});
