// The analysis model: node status with warn and root cause, flow steps, partial impact and a
// simulated failure. Trace errors count per flow, never per node. No I/O: the caller gives the architecture, the health read, the flows and, optionally,
// the traces (traces.mjs readFlowTraces).
import { metadataValue, nodesOf, prometheusJob, relationshipEnds, relationshipsOf, transitionsOf } from './calm.mjs';
import {
    DOWN, FLOW_BROKEN, FLOW_DEGRADED, FLOW_OK, FLOW_UNKNOWN, HEALTHY, IMPACTED, UNKNOWN, WARN, jobState, warnThresholds,
} from './impact.mjs';

export const STEP_OK = 'ok';
export const STEP_FAILS = 'fails';
export const STEP_AT_RISK = 'at-risk';
export const STEP_UNKNOWN = 'unknown';

const CRITICALITIES = ['critical', 'high', 'normal'];
const FLOW_ORDER = { [FLOW_BROKEN]: 0, [FLOW_DEGRADED]: 1, [FLOW_UNKNOWN]: 2, [FLOW_OK]: 3 };

export function parseSimulate(value) {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    return [...new Set(list.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
}

// The Hub customId from a flow URL `/flows/<slug>/versions/`, else the flow unique-id.
export function flowSlug(flow, source) {
    for (const url of [source, flow?.$id]) {
        const match = typeof url === 'string' ? /\/flows\/([^/]+)\/versions\//.exec(url) : null;
        if (match) return decodeURIComponent(match[1]);
    }
    return flow?.['unique-id'] ?? 'flow';
}

export function flowCriticality(flow) {
    const value = (typeof flow?.criticality === 'string' ? flow.criticality : metadataValue(flow, 'criticality'))?.toLowerCase();
    return CRITICALITIES.includes(value) ? value : 'normal';
}

const text = (value) => (typeof value === 'string' ? value : '');

// A failure older than this does not count: the 15 min trace window would keep a repaired service amber.
const RECENT_FAILURE_MS = 2 * 60 * 1000;

// The trace evidence of one node, relationship or flow, or undefined.
function evidence(entry) {
    if (!entry || !Number.isFinite(entry.total)) return undefined;
    const { total, inbound, failed = 0, errorRatio = 0, lastFailed = null, lastRun = null, recent, searchUrl } = entry;
    return { total, ...(inbound !== undefined && { inbound }), failed, errorRatio, lastFailed, ...(lastRun && { lastRun }), ...(recent && { recent }), searchUrl };
}

// Enough recent failures to act on: at least `minTraces` traces, an error ratio at the threshold. The counts of the
// short window when the reader gives them.
function failing(trace, thresholds, end) {
    const c = trace?.recent ?? trace;
    if (!c?.failed || c.total < thresholds.minTraces || c.errorRatio < thresholds.traceErrorRatio) return false;
    const last = Date.parse(trace.lastFailed?.time ?? '');
    return !Number.isFinite(last) || !Number.isFinite(end) || end - last <= RECENT_FAILURE_MS;
}

function dependencyGraph(nodes, relationships) {
    const ids = new Set(nodes.map((n) => n['unique-id']));
    const dependsOn = new Map([...ids].map((id) => [id, new Set()]));
    const usedBy = new Map([...ids].map((id) => [id, new Set()]));
    for (const rel of relationships) {
        const { kind, pairs } = relationshipEnds(rel);
        if (kind !== 'connects') continue;
        for (const [source, destination] of pairs) {
            if (!ids.has(source) || !ids.has(destination) || source === destination) continue;
            dependsOn.get(source).add(destination);
            usedBy.get(destination).add(source);
        }
    }
    return { dependsOn, usedBy };
}

// Breadth first: the nearest down node comes first, with the shortest path to it.
function reachableDown(start, dependsOn, isDown) {
    const seen = new Set([start]);
    const queue = [{ id: start, path: [] }];
    const found = [];
    while (queue.length) {
        const { id, path } = queue.shift();
        for (const next of dependsOn.get(id) ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            const nextPath = [...path, next];
            if (isDown(next)) found.push({ id: next, via: nextPath.slice(0, -1) });
            queue.push({ id: next, path: nextPath });
        }
    }
    return found;
}

function impactReason(reached) {
    const [nearest] = reached;
    const via = nearest.via.length ? ` via ${nearest.via.join(' → ')}` : '';
    const others = reached.slice(1).map((r) => r.id);
    return `depends on ${nearest.id}${via}${others.length ? `; also ${others.join(', ')}` : ''}`;
}

function analyseNodes(architecture, health, simulate, thresholds) {
    const nodes = nodesOf(architecture);
    const { dependsOn, usedBy } = dependencyGraph(nodes, relationshipsOf(architecture));
    const available = Boolean(health?.available);
    const result = new Map();
    for (const node of nodes) {
        const id = node['unique-id'];
        const job = prometheusJob(node);
        const simulated = simulate.includes(id);
        const state = jobState(health, job, thresholds);
        const sample = available && Object.hasOwn(health.jobs ?? {}, job) ? health.jobs[job] : undefined;
        let status = UNKNOWN;
        if (simulated) status = DOWN;
        else if (state.state === DOWN) status = DOWN;
        else if (state.state === WARN) status = WARN;
        else if (state.state) status = HEALTHY;
        result.set(id, {
            id,
            name: text(node.name) || id,
            nodeType: node['node-type'],
            description: text(node.description),
            job,
            status,
            reason: simulated ? 'simulated' : state.reason,
            rootCause: false,
            causedBy: [],
            downDependencies: [],
            via: [],
            dependents: [...usedBy.get(id)],
            dependencies: [...dependsOn.get(id)],
            since: simulated ? null : sample?.since ?? null,
            metrics: sample?.metrics ?? null,
            flows: { total: 0, broken: 0, degraded: 0 },
            owner: metadataValue(node, 'owner') ?? null,
            oncall: metadataValue(node, 'oncall') ?? null,
            runbook: metadataValue(node, 'runbook') ?? null,
            tier: metadataValue(node, 'tier') ?? null,
            simulated,
        });
    }

    const isDown = (id) => result.get(id)?.status === DOWN;
    const reach = new Map([...result.keys()].map((id) => [id, reachableDown(id, dependsOn, isDown)]));
    // A down node in a dependency cycle with other down nodes is a root cause with them.
    const reaches = (a, b) => reach.get(a).some((r) => r.id === b);
    for (const entry of result.values()) {
        if (entry.status !== DOWN) continue;
        entry.rootCause = reach.get(entry.id).every((r) => reaches(r.id, entry.id));
    }
    for (const entry of result.values()) {
        const reached = reach.get(entry.id);
        if (!reached.length) continue;
        entry.downDependencies = reached.map((r) => r.id);
        entry.causedBy = reached.filter((r) => result.get(r.id).rootCause).map((r) => r.id);
        if (entry.status === DOWN && !entry.rootCause) {
            entry.reason += `; caused by ${entry.causedBy.join(', ')}`;
        } else if (entry.status === HEALTHY || entry.status === UNKNOWN) {
            entry.status = IMPACTED;
            entry.via = reached[0].via;
            entry.reason = impactReason(reached);
            // Impacted since its first down dependency went down, not since its own health last changed.
            const starts = reached.map((r) => result.get(r.id).since);
            entry.since = starts.includes(null) ? null : starts.sort()[0];
        }
    }
    return { available, nodes: result };
}

function analyseEdges(architecture, nodes, available) {
    const edges = [];
    for (const rel of relationshipsOf(architecture)) {
        const { kind, pairs } = relationshipEnds(rel);
        pairs.forEach(([source, target], index) => {
            const destination = nodes.get(target);
            const onPath = destination && (destination.status === DOWN || destination.downDependencies.length > 0);
            const broken = kind === 'connects' && Boolean(onPath) && (available || destination.status !== UNKNOWN);
            edges.push({
                id: pairs.length > 1 ? `${rel['unique-id']}#${index + 1}` : rel['unique-id'],
                relationship: rel['unique-id'],
                kind,
                source,
                target,
                description: text(rel.description),
                protocol: text(rel.protocol) || null,
                broken,
                reason: broken ? (destination.status === DOWN ? `${target} is down` : `${target} depends on ${destination.downDependencies[0]}`) : undefined,
            });
        });
    }
    return edges;
}

function stepOf(transition, rel, nodes, available) {
    const step = {
        sequence: transition['sequence-number'] ?? null,
        relationship: transition['relationship-unique-id'],
        from: null,
        to: null,
        description: text(transition.description) || text(rel?.description),
        protocol: text(rel?.protocol) || null,
        status: STEP_UNKNOWN,
        reason: undefined,
        touches: [],
    };
    if (!rel) {
        step.reason = `relationship ${step.relationship} is not in the architecture`;
        return step;
    }
    const { pairs } = relationshipEnds(rel);
    const [first] = pairs;
    if (first) {
        const reverse = transition.direction === 'destination-to-source';
        [step.from, step.to] = reverse ? [first[1], first[0]] : first;
    }
    step.touches = [...new Set(pairs.flat())];
    const down = step.touches.filter((id) => nodes.get(id)?.status === DOWN);
    const warn = step.touches.filter((id) => nodes.get(id)?.status === WARN);
    if (down.length) {
        step.status = STEP_FAILS;
        step.reason = down.map((id) => `${id} is down (${nodes.get(id).reason})`).join('; ');
    } else if (warn.length) {
        step.status = STEP_AT_RISK;
        step.reason = warn.map((id) => `${id} is in warn (${nodes.get(id).reason})`).join('; ');
    } else if (!available) {
        step.reason = 'Prometheus could not be reached';
    } else {
        step.status = STEP_OK;
    }
    return step;
}

// The failed step of the most recent failed trace, as the analysis knows it.
function traceStep(trace, steps) {
    const last = trace?.lastFailed;
    if (!last) return undefined;
    const index = steps.findIndex((s) => (last.relationship && s.relationship === last.relationship)
        || (last.failedStep != null && Number(s.sequence) === Number(last.failedStep)));
    return { index, sequence: index >= 0 ? steps[index].sequence ?? index + 1 : last.failedStep ?? null, node: last.node ?? null, reason: last.reason ?? null };
}

function analyseFlows(flows, architecture, nodes, available, traces, thresholds) {
    const rels = new Map(relationshipsOf(architecture).map((r) => [r['unique-id'], r]));
    const end = Date.parse(traces?.window?.end ?? '');
    return (flows ?? []).map(({ flow, source }) => {
        const steps = transitionsOf(flow).map((t) => stepOf(t, rels.get(t['relationship-unique-id']), nodes, available));
        const touched = new Set(steps.flatMap((s) => s.touches));
        const breaking = [...touched].filter((id) => nodes.get(id)?.status === DOWN);
        const degrading = [...touched].filter((id) => nodes.get(id)?.status === WARN);
        let status = breaking.length ? FLOW_BROKEN
            : degrading.length ? FLOW_DEGRADED
                : available ? FLOW_OK : FLOW_UNKNOWN;
        const slug = flowSlug(flow, source);
        const trace = evidence(traces?.flows?.[slug]);
        // The last failure is evidence even when it is too old or too rare for the rule.
        const traceFailure = traceStep(trace, steps);
        if (trace && failing(trace, thresholds, end)) {
            // Healthy by metrics, failing in the traces.
            if (status === FLOW_OK || status === FLOW_UNKNOWN) {
                status = FLOW_DEGRADED;
                const step = steps[traceFailure?.index ?? -1];
                if (step && step.status === STEP_OK) {
                    step.status = STEP_AT_RISK;
                    step.reason = `fails in traces${traceFailure.reason ? `: ${traceFailure.reason}` : ''}`;
                }
            }
        }
        return {
            id: flow['unique-id'] ?? flow.$id ?? source ?? 'flow',
            slug,
            name: text(flow.name) || flow['unique-id'] || 'Unnamed flow',
            description: text(flow.description),
            criticality: flowCriticality(flow),
            // The entry endpoint: the source of the first transition.
            start: steps[0]?.from ?? null,
            status,
            breaking,
            degrading,
            source,
            touched: [...touched],
            ...(trace && { traces: trace }),
            ...(traceFailure && { traceFailure }),
            steps: steps.map(({ touches, ...step }) => step),
        };
    });
}

export function sortAnalysedFlows(flows) {
    return [...flows].sort((a, b) => FLOW_ORDER[a.status] - FLOW_ORDER[b.status]
        || CRITICALITIES.indexOf(a.criticality) - CRITICALITIES.indexOf(b.criticality)
        || a.name.localeCompare(b.name));
}

/** `traces`: the readFlowTraces result. Missing or unavailable: no trace evidence, and no trace rule. */
export function analyse({ architecture, health, flows = [], simulate = [], traces, thresholds: given }) {
    const thresholds = { ...warnThresholds(), ...given };
    const known = new Set(nodesOf(architecture).map((n) => n['unique-id']));
    const simulated = parseSimulate(simulate).filter((id) => known.has(id));
    // A simulation shows what the failure would break, not today's trace failures.
    const traceRead = traces?.available && !simulated.length ? traces : undefined;
    const { available, nodes } = analyseNodes(architecture, health, simulated, thresholds);
    const edges = analyseEdges(architecture, nodes, available);
    const analysed = analyseFlows(flows, architecture, nodes, available, traceRead, thresholds);

    for (const flow of analysed) {
        for (const id of flow.touched) {
            const counts = nodes.get(id)?.flows;
            if (!counts) continue;
            counts.total += 1;
            if (flow.status === FLOW_BROKEN) counts.broken += 1;
            if (flow.status === FLOW_DEGRADED) counts.degraded += 1;
        }
        delete flow.touched;
    }

    const count = (list, status) => list.filter((x) => x.status === status).length;
    const nodeList = [...nodes.values()];
    return {
        available,
        error: health?.error,
        traces: traces ? (traces.available ? { available: true, minutes: traces.window?.minutes ?? 15 } : { available: false, error: traces.error }) : undefined,
        simulated,
        rootCauses: nodeList.filter((n) => n.rootCause).map((n) => n.id),
        summary: {
            down: count(nodeList, DOWN),
            warn: count(nodeList, WARN),
            impacted: count(nodeList, IMPACTED),
            healthy: count(nodeList, HEALTHY),
            unknown: count(nodeList, UNKNOWN),
            flows: {
                broken: count(analysed, FLOW_BROKEN),
                degraded: count(analysed, FLOW_DEGRADED),
                ok: count(analysed, FLOW_OK),
                unknown: count(analysed, FLOW_UNKNOWN),
            },
            criticalBroken: analysed.filter((f) => f.status === FLOW_BROKEN && f.criticality === 'critical').length,
        },
        nodes,
        edges,
        flows: sortAnalysedFlows(analysed),
    };
}
