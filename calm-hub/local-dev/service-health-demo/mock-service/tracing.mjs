// A small OpenTelemetry tracer with an OTLP/HTTP JSON exporter, so the mock service needs no npm dependencies.
// Spans go to <endpoint>/v1/traces in batches. Export failures drop the batch: tracing never stops or slows a request.
import { randomBytes } from 'node:crypto';

export const SPAN_KIND = { internal: 1, server: 2, client: 3 };
export const STATUS = { unset: 0, ok: 1, error: 2 };

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

// W3C trace context. Returns { traceId, spanId } of the remote parent, or null for a missing or bad header.
export function parseTraceparent(header) {
    const match = TRACEPARENT.exec(String(header ?? '').trim().toLowerCase());
    if (!match || match[1] === ZERO_TRACE || match[2] === ZERO_SPAN) return null;
    return { traceId: match[1], spanId: match[2] };
}

export const formatTraceparent = ({ traceId, spanId }) => `00-${traceId}-${spanId}-01`;

const nowNanos = () => BigInt(Date.now()) * 1_000_000n + process.hrtime.bigint() % 1_000_000n;

function attributeValue(value) {
    if (typeof value === 'boolean') return { boolValue: value };
    if (Number.isInteger(value)) return { intValue: String(value) };
    if (typeof value === 'number') return { doubleValue: value };
    return { stringValue: String(value) };
}

export const toAttributes = (object) => Object.entries(object)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ({ key, value: attributeValue(value) }));

// endpoint: the OTLP/HTTP base URL (OTEL_EXPORTER_OTLP_ENDPOINT). Without it, spans are made for propagation and dropped.
export function createTracer({
    serviceName, resource = {}, endpoint, fetchImpl = fetch, flushMs = 1000, maxBatch = 256, maxQueue = 4096,
    timeoutMs = 2000, onError = () => {},
} = {}) {
    const queue = [];
    const url = endpoint ? new URL('v1/traces', endpoint.endsWith('/') ? endpoint : `${endpoint}/`) : null;
    const resourceAttributes = toAttributes({ 'service.name': serviceName, ...resource });
    let timer;
    let sending = Promise.resolve();

    const exportBatch = async (spans) => {
        const body = {
            resourceSpans: [{
                resource: { attributes: resourceAttributes },
                scopeSpans: [{ scope: { name: 'calm-service-health-demo' }, spans }],
            }],
        };
        try {
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) onError(new Error(`OTLP export replied ${res.status}`));
        } catch (error) {
            onError(error);
        }
    };

    // Spans taken from the queue and not yet sent. A slow collector must not hold more than maxQueue of them.
    let waiting = 0;
    const flush = () => {
        clearTimeout(timer);
        timer = undefined;
        if (!url || queue.length === 0) return sending;
        const batches = [];
        while (queue.length > 0) {
            const batch = queue.splice(0, maxBatch);
            if (waiting + batch.length > maxQueue) {
                onError(new Error(`dropped ${batch.length} spans: the OTLP export is behind`));
                continue;
            }
            waiting += batch.length;
            batches.push(batch);
        }
        sending = sending.then(() => Promise.all(batches.map(async (batch) => {
            await exportBatch(batch);
            waiting -= batch.length;
        })));
        return sending;
    };

    const enqueue = (span) => {
        if (!url) return;
        if (queue.length >= maxQueue) queue.shift();
        queue.push(span);
        if (queue.length >= maxBatch) flush();
        else if (!timer) {
            timer = setTimeout(flush, flushMs);
            timer.unref?.();
        }
    };

    // parent: { traceId, spanId } (a span or a parsed traceparent). No parent starts a new trace.
    function startSpan(name, { kind = SPAN_KIND.internal, parent = null, attributes = {} } = {}) {
        const traceId = parent?.traceId ?? randomBytes(16).toString('hex');
        const spanId = randomBytes(8).toString('hex');
        const start = nowNanos();
        const attrs = { ...attributes };
        let status = { code: STATUS.unset };
        let ended = false;
        return {
            traceId,
            spanId,
            traceparent: () => formatTraceparent({ traceId, spanId }),
            setAttribute(key, value) { attrs[key] = value; return this; },
            setAttributes(values) { Object.assign(attrs, values); return this; },
            setStatus(code, message) { status = message ? { code, message } : { code }; return this; },
            fail(message) { return this.setStatus(STATUS.error, message); },
            end() {
                if (ended) return;
                ended = true;
                enqueue({
                    traceId,
                    spanId,
                    ...(parent?.spanId ? { parentSpanId: parent.spanId } : {}),
                    name,
                    kind,
                    startTimeUnixNano: String(start),
                    endTimeUnixNano: String(nowNanos()),
                    attributes: toAttributes(attrs),
                    status,
                });
            },
        };
    }

    return { startSpan, flush, pending: () => queue.length };
}

// The tracer for this process, from the standard OTel environment variables.
export function tracerFromEnv(serviceName, env = process.env) {
    return createTracer({
        serviceName,
        resource: { 'calm.node.unique-id': serviceName, 'service.namespace': 'service-health-demo' },
        endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
        onError: (error) => console.warn(`trace export failed: ${error.message}`),
    });
}
