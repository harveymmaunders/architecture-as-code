import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renderControlPage } from './control.mjs';
import { createMockService } from './server.mjs';

const NODES = [
    { id: 'customer-portal', name: 'Customer Portal', type: 'webclient' },
    { id: 'orders-api', name: 'Orders API', type: 'service' },
    { id: 'payments-api', name: 'Payments API', type: 'service' },
    { id: 'gone-api', name: 'Gone API', type: 'service' },
];
const FLOW = {
    slug: 'place-order', id: 'flow-place-order', name: 'Place Order', criticality: 'critical', start: 'customer-portal',
    steps: [
        { sequence: 1, relationship: 'portal-orders', from: 'customer-portal', to: 'orders-api' },
        { sequence: 2, relationship: 'orders-payments', from: 'orders-api', to: 'payments-api' },
    ],
};

const ports = {};
const servers = [];
// gone-api has no server: the panel must report it and keep working.
const peerUrl = (node) => `http://127.0.0.1:${ports[node] ?? 1}`;
let base;

before(async () => {
    for (const node of ['orders-api', 'payments-api', 'customer-portal']) {
        const ui = node === 'customer-portal';
        const server = createMockService(node, {
            tickMs: 0, peerUrl, sleep: async () => {}, callTimeoutMs: 500,
            flows: [FLOW], nodes: ui ? NODES : null, grafanaUrl: 'http://grafana.test:3000',
        });
        await new Promise((resolve) => server.listen(0, resolve));
        ports[node] = server.address().port;
        servers.push(server);
    }
    base = peerUrl('customer-portal');
});

after(() => servers.forEach((server) => server.close()));

const api = async (method, path) => {
    const res = await fetch(base + path, { method });
    return { status: res.status, body: await res.json() };
};

test('state shows each node, and a node that cannot be reached as UNREACHABLE', async () => {
    const { status, body } = await api('GET', '/control/api/state');
    assert.equal(status, 200);
    assert.deepEqual(body.nodes.map((n) => [n.id, n.status]), [
        ['customer-portal', 'UP'], ['orders-api', 'UP'], ['payments-api', 'UP'], ['gone-api', 'UNREACHABLE'],
    ]);
    assert.equal(body.nodes[1].errorRatio, 0);
});

test('node actions reach the node, and only architecture nodes are targets', async () => {
    assert.equal((await api('POST', '/control/api/nodes/orders-api/down')).body.status, 'DOWN');
    assert.equal((await api('POST', '/control/api/nodes/payments-api/errors?ratio=0.3')).body.errorRatio, 0.3);
    assert.equal((await api('POST', '/control/api/nodes/payments-api/latency?ms=800')).body.latencyMs, 800);
    const state = (await api('GET', '/control/api/state')).body.nodes;
    assert.equal(state.find((n) => n.id === 'orders-api').status, 'DOWN');

    assert.equal((await api('POST', '/control/api/nodes/evil.example/down')).status, 404);
    assert.equal((await api('POST', '/control/api/nodes/prometheus/down')).status, 404);
    assert.equal((await api('POST', '/control/api/nodes/payments-api/errors?ratio=2')).status, 400);
    assert.equal((await api('POST', '/control/api/nodes/gone-api/down')).status, 502);

    const reset = await api('POST', '/control/api/reset');
    assert.deepEqual(reset.body, { reset: 3, unreachable: ['gone-api'] });
    const after = (await api('GET', '/control/api/state')).body.nodes.filter((n) => n.id !== 'gone-api');
    assert.ok(after.every((n) => n.status === 'UP' && n.errorRatio === 0 && n.latencyMs === 0));
});

test('a run counts successes and failures and names the failing step', async () => {
    await api('POST', '/control/api/nodes/payments-api/down');
    let { status, body: run } = await api('POST', '/control/api/runs?flow=place-order&count=7');
    assert.equal(status, 202);
    while (run.running) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        run = (await api('GET', `/control/api/runs/${run.id}`)).body;
    }
    await api('POST', '/control/api/reset');
    assert.deepEqual([run.done, run.ok, run.failed], [7, 0, 7]);
    assert.deepEqual(run.failures.map((f) => [f.step, f.node, f.count]), [[2, 'payments-api', 7]]);
    const panes = JSON.parse(new URL(run.searchUrl).searchParams.get('panes'));
    assert.equal(panes.trace.queries[0].query, '{ span."calm.flow.slug" = "place-order" }');
    assert.match(run.lastFailedTraceUrl, /^http:\/\/grafana\.test:3000\/explore/);
});

test('a run refuses an unknown flow and a count out of range', async () => {
    assert.equal((await api('POST', '/control/api/runs?flow=nope&count=1')).status, 404);
    assert.equal((await api('POST', '/control/api/runs?flow=place-order&count=501')).status, 400);
    assert.equal((await api('POST', '/control/api/runs?flow=place-order&count=1.5')).status, 400);
    assert.equal((await api('GET', '/control/api/runs/999')).status, 404);
});

test('the flows page links to the control panel, and a service without nodes has no panel', async () => {
    assert.match(await (await fetch(`${base}/`)).text(), /href="\/control"/);
    assert.equal((await fetch(`${peerUrl('orders-api')}/control`)).status, 404);
    assert.doesNotMatch(await (await fetch(`${peerUrl('orders-api')}/`)).text(), /href="\/control"/);
});

test('the control page escapes node and flow data', () => {
    const hostile = '<img src=x onerror=alert(1)></script>';
    const html = renderControlPage('customer-portal', [{ id: 'a', name: hostile }], [{ ...FLOW, name: hostile }]);
    assert.doesNotMatch(html, /<img|<\/script><\/script>/);
    const data = html.slice(html.indexOf('id="data">') + 10, html.indexOf('</script>'));
    assert.doesNotMatch(data, /</);
});
