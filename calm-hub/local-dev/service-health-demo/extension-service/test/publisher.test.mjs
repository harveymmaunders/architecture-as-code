// The publisher and the incident decorator lifecycle, against a stub CALM Hub on loopback that keeps decorators in memory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createPublisher } from '../publisher.mjs';
import { FLOWS, architecture, health as healthOf } from './fixtures.mjs';

const NS = 'service-health-demo';
const TARGET = `/api/calm/namespaces/${NS}/architectures/12/versions/1-1-0`;

function hubStub(hub) {
    return async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        hub.requests.push(`${req.method} ${url.pathname}`);
        const send = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(value === undefined ? '' : JSON.stringify(value));
        };
        const base = `/api/calm/namespaces/${NS}`;
        const path = url.pathname;
        if (hub.fail && path.startsWith(base)) return send(503, { error: 'down' });
        if (path === `${base}/architectures`) return send(200, { values: [{ id: 12, customId: 'service-health' }] });
        if (path === `${base}/architectures/12/versions`) return send(200, { values: hub.versions ?? ['1.0.0', '1.1.0'] });
        if (/^\/api\/calm\/namespaces\/[^/]+\/architectures\/12\/versions\/1\.[12]\.0$/.test(path)) return send(200, architecture());
        const flow = /\/flows\/(.+?)\/versions\//.exec(path);
        if (flow) {
            const found = FLOWS.find((f) => f['unique-id'] === flow[1]) ?? FLOWS[1];
            return send(200, found);
        }
        if (path === `${base}/decorators` && req.method === 'GET') {
            const target = url.searchParams.get('target');
            const ids = [...hub.decorators].filter(([, d]) => d.type === url.searchParams.get('type') && (!target || d.target.includes(target))).map(([id]) => id);
            return send(200, { values: ids });
        }
        if (path === `${base}/decorators` && req.method === 'POST') {
            if (hub.rejectPost) return send(400, { error: 'bad' });
            const id = hub.nextId++;
            hub.decorators.set(id, body);
            return send(201, { id });
        }
        const one = new RegExp(`^${base}/decorators/(\\d+)$`).exec(path);
        if (one) {
            const id = Number(one[1]);
            if (!hub.decorators.has(id)) return send(404, { error: 'not found' });
            if (hub.failDecoratorGet && req.method === 'GET') {
                hub.failDecoratorGet = false;
                return send(503, { error: 'restarting' });
            }
            if (req.method === 'PUT') {
                hub.decorators.set(id, body);
                return send(200);
            }
            const d = hub.decorators.get(id);
            // Hub replies with camelCase keys.
            return send(200, { schema: d.$schema, uniqueId: d['unique-id'], type: d.type, targetType: d['target-type'], target: d.target, appliesTo: d['applies-to'], data: d.data });
        }
        send(404, {});
    };
}

const quiet = { log() {}, warn() {} };

describe('publisher', () => {
    let server;
    let hubUrl;
    let hub;
    let health;
    let clock;

    before(async () => {
        hub = {};
        server = createServer((req, res) => hubStub(hub)(req, res));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        hubUrl = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());
    beforeEach(() => {
        Object.assign(hub, { decorators: new Map(), nextId: 1, requests: [], fail: false });
        health = healthOf();
        clock = new Date('2026-11-25T15:30:00Z');
    });

    const publisher = () => createPublisher({
        hubUrl, prometheusUrl: 'http://prom', namespace: NS, intervalMs: 20, readHealthFn: async () => health, log: quiet, now: () => clock,
    });
    const all = () => [...hub.decorators.values()].filter((d) => d['unique-id'].startsWith('service-health:incident:'));
    const incidents = () => all().length;

    it('opens one incident on the failing node, updates nothing while it stays down, and ends it on recovery', async () => {
        const p = publisher();
        assert.equal((await p.tick()).written, 0);

        health = healthOf({ failing: ['orders-api'] });
        assert.equal((await p.tick()).written, 1);
        assert.equal(incidents(), 1);
        const [incident] = all();
        assert.deepEqual(incident['applies-to'], ['orders-api']);
        assert.equal(incident.target[0], TARGET);
        assert.deepEqual(incident.data, {
            status: 'down', node: 'orders-api', started: '2026-11-25T15:30:00.000Z', affected: ['customer-portal', 'admin-console', 'api-gateway'],
            summary: 'Down since 15:30 · affects customer-portal, admin-console, api-gateway',
        });

        clock = new Date('2026-11-25T15:35:00Z');
        assert.equal((await p.tick()).written, 0);

        health = healthOf();
        clock = new Date('2026-11-25T15:42:00Z');
        hub.requests = [];
        assert.equal((await p.tick()).written, 1);
        assert.deepEqual(hub.requests.filter((r) => !r.startsWith('GET')), [`PUT /api/calm/namespaces/${NS}/decorators/2`]);
        const [ended] = all();
        assert.equal(ended.data.status, 'resolved');
        assert.equal(ended.data.ended, '2026-11-25T15:42:00.000Z');
        assert.equal(ended.data.summary, 'Down 15:30–15:42 · affected customer-portal, admin-console, api-gateway');

        // A new failure is a new incident: the resolved one stays as the record.
        health = healthOf({ failing: ['orders-api'] });
        await p.tick();
        assert.equal(incidents(), 2);
        assert.deepEqual(all().map((d) => d.data.status), ['resolved', 'down']);
    });

    it('writes one baseline on all nodes once, and again only when the node set changes', async () => {
        const p = publisher();
        await p.tick();
        await createPublisher({ hubUrl, prometheusUrl: 'http://prom', namespace: NS, readHealthFn: async () => health, log: quiet, now: () => clock }).tick();
        const baselines = () => [...hub.decorators.values()].filter((d) => d['unique-id'].startsWith('service-health:baseline:'));
        assert.equal(baselines().length, 1);
        const [baseline] = baselines();
        assert.deepEqual(baseline['applies-to'], architecture().nodes.map((n) => n['unique-id']).sort());
        assert.equal(baseline.data.status, 'healthy');
        assert.notEqual(baseline.data.node, 'orders-api');
        hub.requests = [];
        health = healthOf({ failing: ['orders-api'] });
        await p.tick();
        health = healthOf();
        await p.tick();
        assert.equal(baselines().length, 1);
        assert.equal(hub.requests.filter((r) => r.startsWith('PUT')).length, 1, 'only the incident close');
    });

    it('closes the open incident of an earlier run after a restart, and opens no other', async () => {
        health = healthOf({ failing: ['central-db'] });
        await publisher().tick();
        await publisher().tick();
        assert.equal(incidents(), 1);
        health = healthOf();
        await publisher().tick();
        assert.equal(all()[0].data.status, 'resolved');
    });

    it('opens no incident for a node that is down for less than minDownMs, and keeps the first down time', async () => {
        const p = createPublisher({
            hubUrl, prometheusUrl: 'http://prom', namespace: NS, minDownMs: 15000, readHealthFn: async () => health, log: quiet, now: () => clock,
        });
        health = healthOf({ failing: ['orders-api'] });
        await p.tick();
        health = healthOf();
        clock = new Date('2026-11-25T15:30:10Z');
        await p.tick();
        health = healthOf({ failing: ['orders-api'] });
        clock = new Date('2026-11-25T15:30:20Z');
        await p.tick();
        assert.equal(incidents(), 0);
        clock = new Date('2026-11-25T15:30:35Z');
        await p.tick();
        assert.equal(all()[0].data.started, '2026-11-25T15:30:20.000Z');
    });

    it('writes nothing when Prometheus could not be read', async () => {
        health = healthOf({ failing: ['orders-api'] });
        const p = publisher();
        await p.tick();
        health = { available: false, jobs: {} };
        assert.equal((await p.tick()).written, 0);
        assert.equal(all()[0].data.status, 'down');
    });

    it('retires the old per-element decorators once: hidden status, moved off the version', async () => {
        hub.decorators.set(1, { 'unique-id': 'service-health:x:orders-api', type: 'service-health', target: [TARGET], 'applies-to': ['orders-api'], data: { status: 'healthy' } });
        hub.decorators.set(2, { 'unique-id': 'service-health-what-if:x:orders-api', type: 'service-health-what-if', target: [TARGET], 'applies-to': ['orders-api'], data: { status: 'off' } });
        hub.nextId = 3;
        const p = publisher();
        await p.tick();
        for (const id of [1, 2]) {
            assert.equal(hub.decorators.get(id).data.status, 'retired');
            assert.deepEqual(hub.decorators.get(id).target, [`${TARGET}/retired`]);
        }
        hub.requests = [];
        await p.tick();
        assert.ok(!hub.requests.some((r) => r.startsWith('PUT')));
    });

    it('never throws, and backs off while Hub fails', async () => {
        hub.fail = true;
        const p = publisher();
        const result = await p.tick();
        assert.equal(result.ok, false);
        assert.equal(p.nextDelayMs(), 40);
        hub.fail = false;
        assert.equal((await p.tick()).ok, true);
        assert.equal(p.nextDelayMs(), 20);
    });
});
