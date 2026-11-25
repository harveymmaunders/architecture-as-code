// The HTTP routes end to end on loopback, with stub CALM Hub and Prometheus reads, and real
// identity assertions signed with a test key.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createHandler } from '../app.mjs';
import { createVerifier } from '../identity.mjs';
import { architectureWithMetadata, flowList, healthWith, links } from './pages-fixtures.mjs';

const NS = 'service-health-demo';
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwks = { keys: [{ ...ec.publicKey.export({ format: 'jwk' }), kid: 'k', alg: 'ES256', use: 'sig' }] };

function assertion({ method, path, body, claims = {} }) {
    const header = { alg: 'ES256', typ: 'calm-ext+jwt', kid: 'k' };
    const time = Math.floor(Date.now() / 1000);
    const payload = {
        iss: 'http://localhost:8080', aud: 'service-health', sub: 'alice', iat: time, exp: time + 60, jti: randomUUID(),
        htm: method, htp: path, ns: NS, ...(body && { bdh: createHash('sha256').update(body).digest('base64url') }), ...claims,
    };
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function stubs(state) {
    return {
        hubClient: {
            async getArchitecture(namespace, id, version) {
                state.calls.push(`arch ${namespace}/${id}@${version}`);
                if (id === '99') throw new Error('replied 404');
                return { document: architectureWithMetadata(), version: version ?? '1.1.0' };
            },
            async getFlows() {
                return { flows: flowList(), notes: [] };
            },
            async listArchitectures(namespace) {
                if (namespace === 'broken') throw new Error('replied 500');
                return [{ id: '12', name: 'Shop' }];
            },
        },
        readHealth: async (url, options) => {
            state.healthOptions.push(options);
            return healthWith({ failing: state.down });
        },
    };
}

async function listen(handler) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

describe('routes, with identity checked', () => {
    const state = { down: ['central-db'], calls: [], healthOptions: [] };
    let service;

    before(async () => {
        service = await listen(createHandler({
            ...stubs(state),
            prometheusUrl: 'http://prometheus',
            verifyAssertion: createVerifier({ issuer: 'http://localhost:8080', audience: 'service-health', fetchJwks: async () => jwks }),
            namespaces: [NS, 'broken'],
            links,
            log: { warn() {}, error() {}, log() {} },
        }));
    });

    after(() => service.server.close());

    async function call(path, { method = 'GET', body, claims, token } = {}) {
        const headers = { 'X-Calm-Hub-Identity': token ?? assertion({ method, path, body, claims }) };
        if (body) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${service.url}${path}`, { method, headers, body });
        return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
    }

    it('answers the health check without an assertion', async () => {
        assert.equal((await fetch(`${service.url}/healthz`)).status, 200);
    });

    it('refuses a call with no, a forged or a misdirected assertion', async () => {
        assert.equal((await fetch(`${service.url}/tab/${NS}/architectures/12`)).status, 401);
        const forged = assertion({ method: 'GET', path: `/tab/${NS}/architectures/12` }).replace(/\.([^.])([^.]*)$/, (_, c, rest) => `.${c === 'A' ? 'B' : 'A'}${rest}`);
        assert.equal((await call(`/tab/${NS}/architectures/12`, { token: forged })).status, 401);
        const other = assertion({ method: 'GET', path: `/flow-status/${NS}/architectures/12` });
        assert.equal((await call(`/tab/${NS}/architectures/12`, { token: other })).status, 401);
    });

    it('refuses a path namespace that Hub did not check', async () => {
        const reply = await call('/tab/other/architectures/12', { claims: { ns: NS } });
        assert.equal(reply.status, 403);
    });

    it('builds the Overview tab from the latest version', async () => {
        const reply = await call(`/tab/${NS}/architectures/12`);
        assert.equal(reply.status, 200);
        assert.ok(state.calls.includes(`arch ${NS}/12@undefined`));
        assert.match(reply.body.blocks.find((b) => b.type === 'alert').text, /^✕ 3 flows affected \(2 critical\) — central-db down$/);
    });

    it('replies with an alert, not an error, when the architecture is missing or not an architecture', async () => {
        const missing = await call(`/tab/${NS}/architectures/99?version=1.0.0`);
        assert.equal(missing.status, 200);
        assert.match(missing.body.blocks[0].text, /could not be read from CALM Hub: replied 404/);
        const pattern = await call(`/flow-status/${NS}/patterns/1`);
        assert.match(pattern.body.blocks[0].text, /architectures only/);
    });

    it('builds the Flow status tab, with a link to the trace links screen', async () => {
        const reply = await call(`/flow-status/${NS}/architectures/12?version=1.1.0`);
        const table = reply.body.blocks.find((b) => b.type === 'table');
        assert.deepEqual(table.columns, ['Flow', 'Errors', 'Success']);
        assert.ok(table.rows.some((r) => r[0] === 'place-order · starts at customer-portal'));
        assert.equal(reply.body.blocks.find((b) => b.type === 'links').items[0].label, 'Show trace links');
    });

    it('serves the screen: all architectures, and the trace links of one', async () => {
        const all = await call('/screen');
        assert.equal(all.body.title, 'All architectures');
        assert.equal(all.body.blocks.find((b) => b.type === 'table').rows.length, 2);

        const flows = await call(`/screen?namespace=${NS}&resource=architectures%2F12&resourceId=12&resourceType=architectures&version=1.1.0`);
        assert.equal(flows.body.title, undefined);
        assert.deepEqual(flows.body.blocks.find((b) => b.type === 'table').columns, ['Flow', 'Errors', 'Success', 'Trace', 'Failing traces', 'Try it']);
        assert.equal(flows.body.blocks.find((b) => b.type === 'links').items[0].label, 'Hide trace links');

        const other = await call('/screen?namespace=elsewhere&resourceId=1&resourceType=architectures&version=1.0.0');
        assert.match(other.body.blocks[0].text, /serves the namespaces service-health-demo, broken only/);
    });

    it('serves the landing card: services down and flows affected', async () => {
        const reply = await call('/card');
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body.blocks[0].items.map((i) => i.value), [1, 3]);
    });

    it('serves the simulation lens: each node link toggles it in fail', async () => {
        const healthy = await call(`/lens/${NS}/architectures/12?version=1.1.0`);
        assert.equal(healthy.status, 200);
        const node = (reply, id) => reply.body.graph.nodes.find((n) => n.id === id);
        assert.deepEqual(node(healthy, 'orders-api').link, { params: { fail: 'orders-api' } });

        const failed = await call(`/lens/${NS}/architectures/12?version=1.1.0&fail=orders-api,auth-service`);
        assert.deepEqual(node(failed, 'orders-api').tags, ['Service', 'Failed']);
        assert.deepEqual(node(failed, 'orders-api').link, { params: { fail: 'auth-service' } });
        assert.deepEqual(node(failed, 'central-db').link, { params: { fail: 'orders-api,auth-service,central-db' } });
        assert.ok(node(failed, 'api-gateway').tags.includes('Impacted'));
        assert.deepEqual(node(failed, 'central-db').tags, ['Database']);
        const panel = failed.body.panels[0].blocks;
        assert.match(panel[0].text, /^Failing: orders-api, auth-service — /);
        assert.equal(panel[1].rows.length, 4);
        assert.equal(failed.body.controls[0].items[0].value, 'none');
        assert.deepEqual(node(await call(`/lens/${NS}/architectures/12?fail=auth-service`), 'auth-service').link, { params: { fail: 'none' } });
    });

    it('refuses unknown routes and bad paths', async () => {
        assert.equal((await call(`/tab/${NS}/architectures/12/extra`)).status, 404);
        assert.equal((await call('/tab/a%2Fb/architectures/12')).status, 404);
        assert.equal((await call(`/tab/${NS}/architectures/12`, { method: 'DELETE' })).status, 405);
        assert.equal((await call(`/panel/${NS}/architectures/12`)).status, 404);
        assert.equal((await call('/card', { method: 'POST', body: '{}' })).status, 405);
    });
});

describe('routes, without identity', () => {
    let service;
    before(async () => {
        service = await listen(createHandler({ ...stubs({ down: [], calls: [], healthOptions: [] }), prometheusUrl: 'http://p', links, log: { warn() {}, error() {} } }));
    });
    after(() => service.server.close());

    it('answers 400, and stays up, for a request target that is not a valid URL', async () => {
        const status = await new Promise((resolve, reject) => {
            request(`${service.url}/healthz`, { path: 'http://[' }, (res) => resolve(res.statusCode)).on('error', reject).end();
        });
        assert.equal(status, 400);
        assert.equal((await fetch(`${service.url}/healthz`)).status, 200);
    });

    it('refuses a body over the size limit', async () => {
        const res = await fetch(`${service.url}/tab/${NS}/architectures/1`, { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) });
        assert.equal(res.status, 413);
    });
});
