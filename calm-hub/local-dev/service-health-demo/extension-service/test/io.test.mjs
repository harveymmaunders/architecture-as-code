// Prometheus and CALM Hub clients, against stubs. The routes are in routes.test.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHubClient, latestVersion, rewriteFlowUrl } from '../hub.mjs';
import { readHealth, samplesByJob } from '../prometheus.mjs';
import { FLOWS, architecture } from './fixtures.mjs';

async function listen(handler) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const vector = (values) => ({
    status: 'success',
    data: { resultType: 'vector', result: Object.entries(values).map(([job, v]) => ({ metric: { job }, value: [1, String(v)] })) },
});

describe('prometheus client', () => {
    it('parses an instant vector by job', () => {
        assert.deepEqual(samplesByJob(vector({ a: 1, b: 0 })), { a: 1, b: 0 });
        assert.throws(() => samplesByJob({ status: 'error' }));
    });

    it('returns unavailable with an error, and never throws, when Prometheus is down', async () => {
        const result = await readHealth('http://127.0.0.1:1', { timeoutMs: 500 });
        assert.equal(result.available, false);
        assert.match(result.error, /could not be read/);
    });

    it('returns unavailable on a timeout', async () => {
        const slow = await listen(() => {});
        try {
            const result = await readHealth(slow.url, { timeoutMs: 100 });
            assert.equal(result.available, false);
            assert.match(result.error, /no reply in 100 ms/);
        } finally {
            slow.server.closeAllConnections();
            slow.server.close();
        }
    });

    it('returns unavailable on an error reply', async () => {
        const result = await readHealth('http://prometheus', { fetchImpl: async () => new Response('x', { status: 503 }) });
        assert.equal(result.available, false);
        assert.match(result.error, /503/);
    });
});

describe('hub client helpers', () => {
    it('rewrites a Hub flow URL to the reachable Hub', () => {
        assert.equal(rewriteFlowUrl('http://localhost:8080/calm/namespaces/ns/flows/a/versions/1.0.0', 'http://hub:8080'),
            'http://hub:8080/calm/namespaces/ns/flows/a/versions/1.0.0');
        assert.equal(rewriteFlowUrl('https://calm.example.org/api/calm/namespaces/ns/flows/1/versions/1.0.0', 'http://hub:8080'),
            'http://hub:8080/api/calm/namespaces/ns/flows/1/versions/1.0.0');
        assert.equal(rewriteFlowUrl('https://calm.finos.org/traderx/flows/x.json', 'http://hub:8080'), undefined);
        assert.equal(rewriteFlowUrl('not a url', 'http://hub:8080'), undefined);
    });

    it('never lets a flow URL choose the host, the credentials or a non-flow path', () => {
        assert.equal(rewriteFlowUrl('http://user:pw@evil.example/calm/namespaces/ns/flows/a?x=1', 'http://hub:8080'),
            'http://hub:8080/calm/namespaces/ns/flows/a?x=1');
        assert.equal(rewriteFlowUrl('http://localhost:8080/api/calm/namespaces/ns/architectures/1', 'http://hub:8080'), undefined);
        assert.equal(rewriteFlowUrl('http://localhost:8080/calm/namespaces/ns/flows/../../../q/health', 'http://hub:8080'), undefined);
        assert.equal(rewriteFlowUrl('file:///etc/passwd', 'http://hub:8080'), undefined);
    });

    it('follows only flow URLs in the namespace of the architecture', async () => {
        assert.equal(rewriteFlowUrl('http://localhost:8080/calm/namespaces/other/flows/a/versions/1.0.0', 'http://hub:8080', 'mine'), undefined);
        assert.equal(rewriteFlowUrl('http://localhost:8080/calm/namespaces/mine/flows/a/versions/1.0.0', 'http://hub:8080', 'mine'),
            'http://hub:8080/calm/namespaces/mine/flows/a/versions/1.0.0');
        const fetched = [];
        const fetchImpl = async (url) => {
            fetched.push(String(url));
            return new Response(JSON.stringify(String(url).includes('/flows/2/') ? FLOWS[1] : { values: [] }), { status: 200 });
        };
        const client = createHubClient({ hubUrl: 'http://hub:8080', fetchImpl });
        const arch = { ...architecture(), flows: [
            'http://localhost:8080/calm/namespaces/secret/flows/1/versions/1.0.0',
            'http://localhost:8080/api/calm/namespaces/mine/flows/2/versions/1.0.0',
        ] };
        const result = await client.getFlows('mine', arch);
        assert.deepEqual(result.flows.map((f) => f.flow['unique-id']), ['staff-login']);
        assert.ok(!fetched.some((u) => u.includes('/secret/')));
        assert.deepEqual(result.notes, ['1 of 2 flows are in another namespace, so they are not shown.']);
    });

    it('sends a bearer token on each Hub call only when one is set', async () => {
        const seen = [];
        const fetchImpl = async (url, init) => {
            seen.push(init.headers.Authorization);
            return new Response(JSON.stringify({ values: [] }), { status: 200 });
        };
        await createHubClient({ hubUrl: 'http://hub:8080', fetchImpl, token: 's3cret' }).listArchitectures('mine');
        await createHubClient({ hubUrl: 'http://hub:8080', fetchImpl }).listArchitectures('mine');
        assert.deepEqual(seen, ['Bearer s3cret', undefined]);
    });

    it('lists the architectures of a namespace', async () => {
        const fetchImpl = async () => new Response(JSON.stringify({ values: [{ id: 12, name: 'Shop' }, { name: 'no id' }] }), { status: 200 });
        const client = createHubClient({ hubUrl: 'http://hub:8080', fetchImpl });
        assert.deepEqual(await client.listArchitectures('ns'), [{ id: '12', name: 'Shop' }]);
    });

    it('picks the latest version', () => {
        assert.equal(latestVersion(['1.0.0', '1.10.0', '1.2.0']), '1.10.0');
        assert.equal(latestVersion([]), undefined);
    });

    it('reads the flows that the architecture names, and caches them', async () => {
        let calls = 0;
        const fetchImpl = async (url) => {
            calls++;
            const id = String(url).includes('/flows/2/') ? 1 : 0;
            return new Response(JSON.stringify(JSON.stringify(FLOWS[id])), { status: 200 });
        };
        const client = createHubClient({ hubUrl: 'http://hub:8080', fetchImpl });
        const first = await client.getFlows('service-health-demo', architecture());
        assert.deepEqual(first.flows.map((f) => f.flow['unique-id']), ['place-order', 'staff-login']);
        assert.deepEqual(first.notes, []);
        await client.getFlows('service-health-demo', architecture());
        assert.equal(calls, 2);
    });

    it('drops expired flow cache entries, so old architecture versions do not pile up', async () => {
        let time = 0;
        const fetchImpl = async () => new Response(JSON.stringify(FLOWS[0]), { status: 200 });
        const client = createHubClient({ hubUrl: 'http://hub:8080', fetchImpl, cacheMs: 10, now: () => time });
        const version = (n) => ({ ...architecture(), flows: [`http://hub/calm/namespaces/service-health-demo/flows/f/versions/${n}`] });
        for (let n = 0; n < 5; n += 1) {
            await client.getFlows('service-health-demo', version(n));
            time += 20;
        }
        assert.equal(client.cacheSize(), 1);
    });

    it('notes missing flows and never throws when CALM Hub is down', async () => {
        const client = createHubClient({ hubUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
        const result = await client.getFlows('service-health-demo', architecture());
        assert.deepEqual(result.flows, []);
        assert.ok(result.notes.some((n) => /could not be read/.test(n)));
        assert.ok(result.notes.some((n) => /No flows found/.test(n)));
    });
});

describe('server.mjs', () => {
    it('listens on HOST', async () => {
        const probe = createServer();
        await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
        const port = probe.address().port;
        await new Promise((resolve) => probe.close(resolve));
        const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
            env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), VERIFY_IDENTITY: 'false', PUBLISH_DECORATORS: 'false' },
        });
        try {
            const line = await new Promise((resolve, reject) => {
                child.stdout.once('data', (data) => resolve(String(data)));
                child.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
            });
            assert.match(line, new RegExp(`on 127\\.0\\.0\\.1:${port},`));
            assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
        } finally {
            child.kill();
        }
    });
});
