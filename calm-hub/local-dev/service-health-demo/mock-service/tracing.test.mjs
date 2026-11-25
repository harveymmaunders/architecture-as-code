import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPAN_KIND, STATUS, createTracer, formatTraceparent, parseTraceparent, toAttributes, tracerFromEnv } from './tracing.mjs';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

function capture() {
    const posts = [];
    const fetchImpl = async (url, init) => {
        posts.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        return new Response('{}');
    };
    return { posts, fetchImpl, spans: () => posts.flatMap((p) => p.body.resourceSpans[0].scopeSpans[0].spans) };
}

test('traceparent parses a valid header and refuses bad ones', () => {
    assert.deepEqual(parseTraceparent(`00-${TRACE}-${SPAN}-01`), { traceId: TRACE, spanId: SPAN });
    assert.deepEqual(parseTraceparent(` 00-${TRACE.toUpperCase()}-${SPAN}-00 `), { traceId: TRACE, spanId: SPAN });
    for (const bad of [undefined, '', 'garbage', `00-${'0'.repeat(32)}-${SPAN}-01`, `00-${TRACE}-${'0'.repeat(16)}-01`, `00-${TRACE}-${SPAN}`]) {
        assert.equal(parseTraceparent(bad), null, String(bad));
    }
    assert.equal(formatTraceparent({ traceId: TRACE, spanId: SPAN }), `00-${TRACE}-${SPAN}-01`);
});

test('attributes are typed and empty values are dropped', () => {
    assert.deepEqual(toAttributes({ a: 'x', b: 3, c: 1.5, d: true, e: undefined, f: null, g: '' }), [
        { key: 'a', value: { stringValue: 'x' } },
        { key: 'b', value: { intValue: '3' } },
        { key: 'c', value: { doubleValue: 1.5 } },
        { key: 'd', value: { boolValue: true } },
    ]);
});

test('spans export as OTLP JSON with the resource, parent, kind and status', async () => {
    const sink = capture();
    const tracer = createTracer({ serviceName: 'orders-api', resource: { 'calm.node.unique-id': 'orders-api' }, endpoint: 'http://tempo:4318', fetchImpl: sink.fetchImpl });
    const root = tracer.startSpan('root');
    const child = tracer.startSpan('child', { kind: SPAN_KIND.client, parent: root, attributes: { 'calm.flow.step': 2 } });
    child.fail('boom');
    child.end();
    child.end();
    root.end();
    await tracer.flush();

    assert.equal(sink.posts.length, 1);
    assert.equal(sink.posts[0].url, 'http://tempo:4318/v1/traces');
    assert.deepEqual(sink.posts[0].body.resourceSpans[0].resource.attributes, [
        { key: 'service.name', value: { stringValue: 'orders-api' } },
        { key: 'calm.node.unique-id', value: { stringValue: 'orders-api' } },
    ]);
    const [c, r] = sink.spans();
    assert.equal(c.traceId, root.traceId);
    assert.equal(c.parentSpanId, root.spanId);
    assert.equal(c.kind, SPAN_KIND.client);
    assert.deepEqual(c.status, { code: STATUS.error, message: 'boom' });
    assert.equal(r.parentSpanId, undefined);
    assert.ok(BigInt(r.endTimeUnixNano) >= BigInt(r.startTimeUnixNano));
    assert.match(root.traceparent(), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test('a full batch is sent at once, and the queue drops the oldest spans when full', async () => {
    const sink = capture();
    const tracer = createTracer({ serviceName: 's', endpoint: 'http://t/', fetchImpl: sink.fetchImpl, maxBatch: 2, flushMs: 60_000 });
    tracer.startSpan('a').end();
    tracer.startSpan('b').end();
    await tracer.flush();
    assert.equal(sink.posts.length, 1);

    const small = createTracer({ serviceName: 's', endpoint: 'http://t', fetchImpl: sink.fetchImpl, maxBatch: 100, maxQueue: 2, flushMs: 60_000 });
    for (const name of ['1', '2', '3']) small.startSpan(name).end();
    assert.equal(small.pending(), 2);
    await small.flush();
    assert.deepEqual(sink.posts.at(-1).body.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name), ['2', '3']);
});

test('a slow collector holds at most maxQueue unsent spans, and the rest are dropped', async () => {
    const errors = [];
    let release;
    const stalled = new Promise((resolve) => { release = resolve; });
    const posts = [];
    const fetchImpl = async (url, init) => { posts.push(JSON.parse(init.body)); await stalled; return new Response('{}'); };
    const tracer = createTracer({ serviceName: 's', endpoint: 'http://t', fetchImpl, maxBatch: 2, maxQueue: 4, flushMs: 60_000, onError: (e) => errors.push(e.message) });
    for (let i = 0; i < 10; i += 1) tracer.startSpan(String(i)).end();
    assert.deepEqual(errors, ['dropped 2 spans: the OTLP export is behind', 'dropped 2 spans: the OTLP export is behind', 'dropped 2 spans: the OTLP export is behind']);
    release();
    await tracer.flush();
    assert.equal(posts.length, 2);
    tracer.startSpan('after').end();
    await tracer.flush();
    assert.equal(posts.length, 3, 'sending again once the collector catches up');
});

test('export failures never throw and are reported', async () => {
    const errors = [];
    const failing = createTracer({ serviceName: 's', endpoint: 'http://t', fetchImpl: async () => { throw new Error('refused'); }, onError: (e) => errors.push(e.message) });
    failing.startSpan('x').end();
    await failing.flush();
    const rejecting = createTracer({ serviceName: 's', endpoint: 'http://t', fetchImpl: async () => new Response('', { status: 500 }), onError: (e) => errors.push(e.message) });
    rejecting.startSpan('x').end();
    await rejecting.flush();
    assert.deepEqual(errors, ['refused', 'OTLP export replied 500']);
});

test('without an endpoint spans still propagate but nothing is sent', async () => {
    const tracer = tracerFromEnv('orders-api', {});
    const span = tracer.startSpan('x');
    span.end();
    assert.equal(tracer.pending(), 0);
    await tracer.flush();
    assert.equal(span.traceId.length, 32);
});
