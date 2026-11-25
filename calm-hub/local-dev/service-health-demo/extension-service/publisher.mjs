// Polls Prometheus and writes incident decorators to CALM Hub (decorators.mjs), so the normal diagram
// shows a failing node. Hub reads the decorators again every 5 s while a diagram is open.
import { createHubClient, hubHeaders } from './hub.mjs';
import { BASELINE_PREFIX, DECORATOR_TYPE, INCIDENT_PREFIX, RETIRED, buildBaseline, planIncidents, versionTarget } from './decorators.mjs';

const seg = encodeURIComponent;
// The per-element types of earlier versions of this demo. A delete needs global admin, so they are retired.
const OLD_TYPES = [DECORATOR_TYPE, 'service-health-what-if'];
const RETIRED_SUFFIX = '/retired';

// Hub replies with camelCase keys; a write takes kebab-case.
const toBody = (d) => ({
    $schema: d.schema, 'unique-id': d.uniqueId, type: d.type, 'target-type': d.targetType, target: d.target, 'applies-to': d.appliesTo, data: d.data,
});

export function createPublisher({
    hubUrl,
    prometheusUrl,
    namespace,
    token,
    intervalMs = 10000,
    // A node must stay down this long before an incident opens.
    minDownMs = 0,
    maxBackoffMs = 120000,
    timeoutMs = 5000,
    fetchImpl = fetch,
    hubClient,
    analyseFn,
    readHealthFn,
    log = console,
    now = () => new Date(),
}) {
    const hub = hubClient ?? createHubClient({ hubUrl, token, fetchImpl, cacheMs: 0 });
    const api = (path) => new URL(`/api/calm/namespaces/${seg(namespace)}/${path}`, hubUrl).toString();
    // target → Map<node id, { id, decorator }>: the open incidents.
    const targets = new Map();
    // target → { id, nodes } of its baseline decorator, or null before the first write.
    const baselines = new Map();
    // target → Map<node id, first down time>, for minDownMs.
    const pending = new Map();
    let retired = false;
    let timer;
    let running = false;
    let failures = 0;

    async function request(method, url, body) {
        const res = await fetchImpl(url, {
            method,
            headers: hubHeaders(token, body ? { 'Content-Type': 'application/json' } : {}),
            body: body && JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json;
        try {
            json = text ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }
        if (!res.ok) throw new Error(`${method} ${new URL(url).pathname} replied ${res.status}: ${text.slice(0, 300)}`);
        return json;
    }

    async function list(query) {
        const ids = (await request('GET', `${api('decorators')}?${new URLSearchParams(query)}`))?.values ?? [];
        return Promise.all(ids.map(async (id) => ({ id, decorator: await request('GET', api(`decorators/${seg(id)}`)) })));
    }

    // Once per start: moves each old per-element decorator to a target that no page asks for, with a hidden status.
    async function retireOld() {
        let count = 0;
        for (const type of OLD_TYPES) {
            for (const { id, decorator } of await list({ type })) {
                if (decorator.uniqueId?.startsWith(INCIDENT_PREFIX) || decorator.uniqueId?.startsWith(BASELINE_PREFIX) || decorator.target?.every((t) => t.endsWith(RETIRED_SUFFIX))) continue;
                const body = toBody(decorator);
                body.target = body.target.map((t) => `${t}${RETIRED_SUFFIX}`);
                body.data = { ...body.data, status: RETIRED };
                await request('PUT', api(`decorators/${seg(id)}`), body);
                count += 1;
            }
        }
        if (count) log.log(`service-health: retired ${count} old decorator(s)`);
    }

    // The open incidents of an earlier run, so a restart closes them and does not open another. Also its baseline.
    async function readTarget(target) {
        const open = new Map();
        let baseline = null;
        for (const { id, decorator } of await list({ type: DECORATOR_TYPE, target })) {
            if (decorator.uniqueId?.startsWith(INCIDENT_PREFIX) && decorator.data?.status === 'down') {
                open.set(decorator.appliesTo[0], { id, decorator: toBody(decorator) });
            } else if (decorator.uniqueId?.startsWith(BASELINE_PREFIX)) {
                baseline = { id, nodes: [...(decorator.appliesTo ?? [])].sort().join(',') };
            }
        }
        return { open, baseline };
    }

    // Writes the baseline only when there is none, or when the node set changed.
    async function publishBaseline(target, architectureId, version, document) {
        const ids = (document?.nodes ?? []).map((n) => n?.['unique-id']).filter(Boolean);
        if (!ids.length) return;
        const decorator = buildBaseline({ namespace, architectureId, version, nodes: ids, now: now() });
        const nodes = decorator['applies-to'].join(',');
        const current = baselines.get(target);
        if (current?.nodes === nodes) return;
        if (current) await request('PUT', api(`decorators/${seg(current.id)}`), decorator);
        else baselines.set(target, { id: (await request('POST', api('decorators'), decorator))?.id });
        baselines.get(target).nodes = nodes;
        log.log(`service-health: baseline decorator written for architecture ${architectureId} ${version}`);
    }

    async function publishArchitecture(architectureId, health, analyse) {
        const { document, version } = await hub.getArchitecture(namespace, String(architectureId));
        const analysis = analyse({ architecture: document, health });
        const target = versionTarget(namespace, architectureId, version);
        if (!targets.has(target)) {
            const { open, baseline } = await readTarget(target);
            targets.set(target, open);
            if (baseline) baselines.set(target, baseline);
            pending.set(target, new Map());
        }
        await publishBaseline(target, architectureId, version, document);
        const open = targets.get(target);
        const decorators = new Map([...open].map(([node, entry]) => [node, entry.decorator]));
        let written = 0;
        for (const { node, decorator, close } of planIncidents({ analysis, open: decorators, pending: pending.get(target), minDownMs, namespace, architectureId, version, now: now() })) {
            const entry = open.get(node);
            if (entry && entry.decorator['unique-id'] === decorator['unique-id']) await request('PUT', api(`decorators/${seg(entry.id)}`), decorator);
            else open.set(node, { id: (await request('POST', api('decorators'), decorator))?.id, decorator });
            if (close) open.delete(node);
            else open.get(node).decorator = decorator;
            written += 1;
        }
        if (written) log.log(`service-health: ${written} incident decorator(s) written for architecture ${architectureId} ${version}`);
        return written;
    }

    // One pass over the namespace. Never throws: returns { ok, architectures, written, error? }.
    async function pass() {
        const result = { ok: true, architectures: 0, written: 0 };
        try {
            const analyse = analyseFn ?? (await import('./analysis.mjs')).analyse;
            const readHealth = readHealthFn ?? (await import('./prometheus.mjs')).readHealth;
            if (!retired) {
                await retireOld();
                retired = true;
            }
            const architectures = (await request('GET', api('architectures')))?.values ?? [];
            const health = await readHealth(prometheusUrl, { history: false });
            for (const summary of architectures) {
                if (summary?.id === undefined) continue;
                result.written += await publishArchitecture(summary.id, health, analyse);
                result.architectures += 1;
            }
        } catch (error) {
            result.ok = false;
            result.error = error.message;
            log.warn(`service-health publisher: ${error.message}`);
        }
        failures = result.ok ? 0 : failures + 1;
        return result;
    }

    // One pass at a time.
    let inFlight;
    function tick() {
        inFlight ??= pass().finally(() => {
            inFlight = undefined;
        });
        return inFlight;
    }

    const delay = () => (failures ? Math.min(intervalMs * 2 ** failures, maxBackoffMs) : intervalMs);

    function schedule(ms) {
        timer = setTimeout(async () => {
            if (!running) return;
            await tick();
            if (running) schedule(delay());
        }, ms);
        timer.unref?.();
    }

    return {
        start() {
            if (running) return;
            running = true;
            schedule(0);
        },
        stop() {
            running = false;
            clearTimeout(timer);
        },
        tick,
        nextDelayMs: delay,
    };
}
