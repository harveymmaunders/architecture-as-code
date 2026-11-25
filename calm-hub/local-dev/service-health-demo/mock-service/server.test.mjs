import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, createMockService } from './server.mjs';

let server;
let base;

before(async () => {
    // No ticker: the tests drive simulated traffic with simulateRequest().
    server = createMockService('orders-api', { tickMs: 0 });
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const call = (method, path) => fetch(base + path, { method });

test('health is UP by default', async () => {
    const res = await call('GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { service: 'orders-api', status: 'UP' });
});

test('toggle flips the state and health returns 503 when DOWN', async () => {
    const toggled = await call('POST', '/health/toggle');
    assert.equal(toggled.status, 200);
    assert.equal((await toggled.json()).status, 'DOWN');

    const res = await call('GET', '/health');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).status, 'DOWN');

    assert.equal((await (await call('POST', '/health/toggle')).json()).status, 'UP');
});

test('down and up set the state and are idempotent', async () => {
    for (const expected of ['DOWN', 'DOWN', 'UP', 'UP']) {
        const res = await call('POST', `/health/${expected.toLowerCase()}`);
        assert.equal((await res.json()).status, expected);
    }
});

test('metrics report health status and request counts', async () => {
    await call('POST', '/health/down');
    let text = await (await call('GET', '/metrics')).text();
    assert.match(text, /^# TYPE service_health_status gauge$/m);
    assert.match(text, /^service_health_status\{service="orders-api"\} 0$/m);
    assert.match(text, /^service_http_requests_total\{service="orders-api",path="\/health",code="200"\} \d+$/m);

    await call('POST', '/health/up');
    text = await (await call('GET', '/metrics')).text();
    assert.match(text, /^service_health_status\{service="orders-api"\} 1$/m);
});

test('unknown routes return 404, and a wrong method on a known path 405', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
    const wrong = await call('GET', '/health/toggle');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
    const text = await (await call('GET', '/metrics')).text();
    assert.match(text, /path="other",code="404"/);
    assert.doesNotMatch(text, /path="\/nope"/);
});

test('a request target that is not a valid URL gets 404 and does not stop the server', async () => {
    const { request } = await import('node:http');
    const status = await new Promise((resolve, reject) => {
        request(base, { path: 'http://[' }, (res) => resolve(res.statusCode)).on('error', reject).end();
    });
    assert.equal(status, 404);
    assert.equal((await call('GET', '/health')).status, 200);
});

const metric = (text, pattern) => Number(text.match(pattern)?.[1]);
const metrics = async () => (await call('GET', '/metrics')).text();

test('simulated requests are counted under /work and observed in the latency histogram', async () => {
    const before = await metrics();
    const ok = metric(before, /path="\/work",code="200"\} (\d+)/m) || 0;
    for (let i = 0; i < 4; i += 1) assert.equal(server.simulateRequest().code, 200);
    const text = await metrics();
    assert.equal(metric(text, /path="\/work",code="200"\} (\d+)/m), ok + 4);
    assert.match(text, /^# TYPE service_request_duration_seconds histogram$/m);
    for (const le of [0.05, 0.1, 0.25, 0.5, 1, 2.5]) assert.ok(BUCKETS.includes(le), `bucket ${le}`);
    const count = metric(text, /^service_request_duration_seconds_count\{service="orders-api"\} (\d+)$/m);
    assert.equal(metric(text, /^service_request_duration_seconds_bucket\{service="orders-api",le="\+Inf"\} (\d+)$/m), count);
    assert.equal(metric(text, /^service_request_duration_seconds_bucket\{service="orders-api",le="0.1"\} (\d+)$/m), count);
    assert.equal(metric(text, /^service_request_duration_seconds_bucket\{service="orders-api",le="0.005"\} (\d+)$/m), 0);
});

test('chaos latency adds to the simulated latency, and reset clears it', async () => {
    const res = await call('POST', '/chaos/latency?ms=800');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { service: 'orders-api', latencyMs: 800, errorRatio: 0 });
    const { seconds } = server.simulateRequest();
    assert.ok(seconds >= 0.82 && seconds <= 0.88, String(seconds));
    const text = await metrics();
    const count = metric(text, /_count\{service="orders-api"\} (\d+)$/m);
    assert.equal(metric(text, /le="0.5"\} (\d+)$/m), count - 1);
    assert.equal(metric(text, /le="1"\} (\d+)$/m), count);

    assert.deepEqual(await (await call('POST', '/chaos/reset')).json(), { service: 'orders-api', latencyMs: 0, errorRatio: 0 });
    assert.ok(server.simulateRequest().seconds < 0.1);
});

test('chaos errors make that fraction of simulated requests fail with 500', async () => {
    assert.equal((await call('POST', '/chaos/errors?ratio=1')).status, 200);
    assert.equal(server.simulateRequest().code, 500);
    assert.match(await metrics(), /path="\/work",code="500"\} \d+/);
    assert.deepEqual(await (await call('GET', '/chaos')).json(), { service: 'orders-api', latencyMs: 0, errorRatio: 1 });
    await call('POST', '/chaos/reset');
    assert.equal(server.simulateRequest().code, 200);
});

test('simulated requests fail with 503 while the health flag is DOWN, and reset keeps the flag', async () => {
    await call('POST', '/health/down');
    await call('POST', '/chaos/reset');
    assert.equal(server.simulateRequest().code, 503);
    assert.equal((await call('GET', '/health')).status, 503);
    await call('POST', '/health/up');
    assert.equal(server.simulateRequest().code, 200);
});

test('chaos rejects bad values and wrong methods', async () => {
    for (const path of ['/chaos/latency', '/chaos/latency?ms=-1', '/chaos/latency?ms=abc', '/chaos/latency?ms=',
        '/chaos/errors?ratio=1.5', '/chaos/errors?ratio=-0.1', '/chaos/errors']) {
        assert.equal((await call('POST', path)).status, 400, path);
    }
    const wrong = await call('GET', '/chaos/reset');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
    assert.equal((await call('POST', '/chaos')).headers.get('allow'), 'GET');
    assert.deepEqual(await (await call('GET', '/chaos')).json(), { service: 'orders-api', latencyMs: 0, errorRatio: 0 });
});

test('the ticker simulates traffic while listening and stops on close', async () => {
    const ticking = createMockService('ticker', { tickMs: 5 });
    await new Promise((resolve) => ticking.listen(0, resolve));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const text = await (await fetch(`http://127.0.0.1:${ticking.address().port}/metrics`)).text();
    await new Promise((resolve) => ticking.close(resolve));
    assert.ok(metric(text, /path="\/work",code="200"\} (\d+)/m) >= 3, text);
});
