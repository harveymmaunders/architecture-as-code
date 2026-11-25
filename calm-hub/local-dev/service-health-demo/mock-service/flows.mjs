// Loads the CALM flows and runs one as real calls: for each transition, the source service calls the destination
// through its /call endpoint. The flow driver and the UI pages share this code, so both make the same traces.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SPAN_KIND } from './tracing.mjs';

export const ARCHITECTURE_NAME = 'service-health';
const FLOW_SUFFIX = '.flow.json';

// { [relationship unique-id]: { source, destination } } for the connects relationships.
export function connectsOf(architecture) {
    const map = {};
    for (const relationship of architecture?.relationships ?? []) {
        const connects = relationship?.['relationship-type']?.connects;
        const source = connects?.source?.node;
        const destination = connects?.destination?.node;
        if (relationship['unique-id'] && source && destination) map[relationship['unique-id']] = { source, destination };
    }
    return map;
}

// A flow with its steps resolved to { from, to }. `direction` destination-to-source swaps the ends.
export function resolveFlow(slug, document, connects) {
    const steps = [...(document?.transitions ?? [])]
        .sort((a, b) => a['sequence-number'] - b['sequence-number'])
        .map((transition) => {
            const relationship = transition['relationship-unique-id'];
            const ends = connects[relationship];
            if (!ends) throw new Error(`flow ${slug}: relationship ${relationship} is not a connects relationship`);
            const reverse = transition.direction === 'destination-to-source';
            return {
                sequence: transition['sequence-number'],
                relationship,
                description: transition.description ?? '',
                from: reverse ? ends.destination : ends.source,
                to: reverse ? ends.source : ends.destination,
            };
        });
    return {
        slug,
        id: document['unique-id'] ?? slug,
        name: document.name ?? slug,
        description: document.description ?? '',
        criticality: document.metadata?.criticality ?? 'normal',
        start: steps[0]?.from ?? null,
        steps,
    };
}

async function readArchitecture(architectureDir) {
    const files = await readdir(architectureDir);
    const architectureFile = files.find((file) => file.endsWith('.architecture.json'));
    if (!architectureFile) throw new Error(`no *.architecture.json in ${architectureDir}`);
    return JSON.parse(await readFile(join(architectureDir, architectureFile), 'utf8'));
}

// [{ id, name, type }] of the architecture nodes.
export async function loadNodes(architectureDir) {
    return ((await readArchitecture(architectureDir)).nodes ?? [])
        .filter((node) => node?.['unique-id'])
        .map((node) => ({ id: node['unique-id'], name: node.name ?? node['unique-id'], type: node['node-type'] ?? '' }));
}

// The slug is the file name, which is also the Hub customId of the flow.
export async function loadFlows(architectureDir) {
    const connects = connectsOf(await readArchitecture(architectureDir));
    const flowDir = join(architectureDir, 'flows');
    const flowFiles = (await readdir(flowDir)).filter((file) => file.endsWith(FLOW_SUFFIX)).sort();
    return Promise.all(flowFiles.map(async (file) => resolveFlow(
        file.slice(0, -FLOW_SUFFIX.length), JSON.parse(await readFile(join(flowDir, file), 'utf8')), connects,
    )));
}

export const serviceUrlFromTemplate = (template = 'http://{node}:8080') => (node) => template.replace('{node}', node);

const reasonOf = (error) => error?.cause?.code ?? error?.cause?.message ?? error?.name ?? String(error);

async function runStep(step, flow, { tracer, root, serviceUrl, fetchImpl, timeoutMs }) {
    const span = tracer.startSpan(`step ${step.sequence} ${step.relationship}`, {
        parent: root,
        attributes: {
            'calm.flow.unique-id': flow.id,
            'calm.flow.step': step.sequence,
            'calm.relationship.unique-id': step.relationship,
            'calm.step.from': step.from,
            'calm.step.to': step.to,
        },
    });
    const started = performance.now();
    let result;
    try {
        const res = await fetchImpl(new URL('/call', serviceUrl(step.from)), {
            method: 'POST',
            headers: { 'content-type': 'application/json', traceparent: span.traceparent() },
            body: JSON.stringify({ to: step.to, relationship: step.relationship, flow: flow.id, step: step.sequence }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await res.json().catch(() => ({}));
        result = body.ok === true
            ? { status: 'ok', reply: body.reply ?? null }
            : { status: 'failed', reason: body.reason ?? `${step.from} replied ${res.status}`, failedNode: body.failedNode ?? step.from };
    } catch (error) {
        result = { status: 'failed', reason: `${step.from} unreachable: ${reasonOf(error)}`, failedNode: step.from };
    }
    // The node that failed the step: traces.mjs counts failures per node and relationship from these step spans.
    if (result.status === 'failed') {
        span.setAttributes({ 'calm.failure.node': result.failedNode, 'calm.failure.reason': result.reason }).fail(result.reason);
    }
    span.end();
    return { ...step, ...result, latencyMs: Math.round(performance.now() - started) };
}

// Runs the steps in order and stops at the first failure: later steps are "not-run".
// The root span carries the flow outcome, which traces.mjs reads back from Tempo.
export async function runFlow(flow, {
    tracer, serviceUrl = serviceUrlFromTemplate(), fetchImpl = fetch, timeoutMs = 10_000, trigger = 'driver',
} = {}) {
    const root = tracer.startSpan(`flow ${flow.name}`, {
        kind: SPAN_KIND.internal,
        attributes: {
            'calm.architecture': ARCHITECTURE_NAME,
            'calm.flow.unique-id': flow.id,
            'calm.flow.slug': flow.slug,
            'calm.flow.name': flow.name,
            'calm.flow.criticality': flow.criticality,
            'calm.flow.trigger': trigger,
            'calm.flow.steps': flow.steps.length,
        },
    });
    const started = performance.now();
    const steps = [];
    let failed = null;
    for (const step of flow.steps) {
        if (failed) {
            steps.push({ ...step, status: 'not-run' });
            continue;
        }
        const done = await runStep(step, flow, { tracer, root, serviceUrl, fetchImpl, timeoutMs });
        steps.push(done);
        if (done.status === 'failed') failed = done;
    }
    if (failed) {
        root.setAttributes({
            'calm.flow.failed-step': failed.sequence,
            'calm.flow.failed-relationship': failed.relationship,
            'calm.flow.failed-node': failed.failedNode,
            'calm.flow.failure-reason': failed.reason,
        });
        root.fail(`step ${failed.sequence} ${failed.relationship}: ${failed.reason}`);
    }
    root.end();
    return {
        slug: flow.slug,
        id: flow.id,
        name: flow.name,
        traceId: root.traceId,
        ok: !failed,
        failedStep: failed?.sequence ?? null,
        durationMs: Math.round(performance.now() - started),
        steps,
    };
}

// A Grafana Explore link that runs one TraceQL query (a trace id opens that trace) on the Tempo datasource (uid tempo).
export function traceUrl(grafanaUrl, query, { datasourceUid = 'tempo', from = 'now-1h' } = {}) {
    const panes = {
        trace: {
            datasource: datasourceUid,
            queries: [{ refId: 'A', datasource: { type: 'tempo', uid: datasourceUid }, queryType: 'traceql', query }],
            range: { from, to: 'now' },
        },
    };
    const url = new URL('/explore', grafanaUrl);
    url.searchParams.set('schemaVersion', '1');
    url.searchParams.set('panes', JSON.stringify(panes));
    url.searchParams.set('orgId', '1');
    return url.href;
}
