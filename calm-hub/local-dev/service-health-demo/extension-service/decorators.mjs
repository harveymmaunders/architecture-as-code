// Incident decorators: one per incident, on the failing node only. Pure: the publisher does the I/O.
// An incident opens when a node goes down (as a root cause) and gets `ended` when it recovers. A resolved
// incident stays in Hub as the record, and the view hides it on the diagram.

export const DECORATOR_TYPE = 'service-health';
// Hub knows this schema and checks each decorator against it on write.
export const DECORATOR_SCHEMA = 'https://calm.finos.org/release/1.3/meta/decorators.json#/defs/decorator';
export const INCIDENT_PREFIX = `${DECORATOR_TYPE}:incident:`;
export const BASELINE_PREFIX = `${DECORATOR_TYPE}:baseline:`;
export const DOWN = 'down';
export const HEALTHY = 'healthy';
// The baseline's `node`: the overlay keys on it, so it never shares a key with an incident.
export const BASELINE_KEY = '*';
export const RESOLVED = 'resolved';
// The per-element decorators of earlier versions of this demo, moved out of sight.
export const RETIRED = 'retired';

export const DECORATOR_VIEW = {
    id: 'service-health',
    match: { type: DECORATOR_TYPE },
    label: 'Service health',
    overlay: { status: '/status', map: { [DOWN]: 'error', [HEALTHY]: 'ok' }, default: 'info', hide: [RESOLVED, RETIRED], label: '/summary', time: '/started', key: '/node' },
};

const MAX_NAMES = 4;

// The exact string that the Hub UI asks for: numeric id, and the version with dashes.
export function versionTarget(namespace, architectureId, version) {
    return `/api/calm/namespaces/${namespace}/architectures/${architectureId}/versions/${String(version).replace(/\./g, '-')}`;
}

export const hhmm = (iso) => String(iso ?? '').slice(11, 16);

const names = (list) => (list.length > MAX_NAMES ? `${list.slice(0, MAX_NAMES).join(', ')} and ${list.length - MAX_NAMES} more` : list.join(', '));

// "Down since 15:30 · affects API Gateway, Customer Portal" or "Down 15:30–15:42 · affected API Gateway".
export function incidentSummary({ started, ended, affectedNames = [] }) {
    const head = ended ? `Down ${hhmm(started)}–${hhmm(ended)}` : `Down since ${hhmm(started)}`;
    if (!affectedNames.length) return head;
    return `${head} · ${ended ? 'affected' : 'affects'} ${names(affectedNames)}`;
}

export function buildIncident({ namespace, architectureId, version, node, data }) {
    const stamp = data.started.replace(/[^0-9]/g, '').slice(0, 14);
    return {
        $schema: DECORATOR_SCHEMA,
        'unique-id': `${INCIDENT_PREFIX}${namespace}:${architectureId}:${String(version).replace(/\./g, '-')}:${node}:${stamp}`,
        type: DECORATOR_TYPE,
        'target-type': ['architecture'],
        target: [versionTarget(namespace, architectureId, version)],
        'applies-to': [node],
        data,
    };
}

// One per architecture version, on all nodes: green badges and the legend toggle while nothing is down.
// An incident on a node is worse, so the overlay shows it instead.
export function buildBaseline({ namespace, architectureId, version, nodes, now = new Date() }) {
    return {
        $schema: DECORATOR_SCHEMA,
        'unique-id': `${BASELINE_PREFIX}${namespace}:${architectureId}:${String(version).replace(/\./g, '-')}`,
        type: DECORATOR_TYPE,
        'target-type': ['architecture'],
        target: [versionTarget(namespace, architectureId, version)],
        'applies-to': [...nodes].sort(),
        data: { status: HEALTHY, node: BASELINE_KEY, started: new Date(now).toISOString(), summary: 'Monitored by Service health' },
    };
}

// The nodes that need `id`: impacted by it, or down because of it.
function affectedBy(analysis, id) {
    return [...analysis.nodes.values()].filter((n) => n.id !== id && n.downDependencies?.includes(id));
}

/**
 * The incident writes of one pass. `open`: Map<node id, decorator> of the open incidents of this target.
 * Returns [{ node, decorator, close }]: a new or changed open incident, or a resolved one (`close`).
 * Writes nothing when Prometheus could not be read: no data is not a recovery.
 * `pending` (Map<node id, first down time>, kept by the caller) holds a node that is down for less than
 * `minDownMs`, so a container restart opens no incident.
 */
export function planIncidents({ analysis, open = new Map(), pending = new Map(), minDownMs = 0, namespace, architectureId, version, now = new Date() }) {
    if (!analysis?.available) return [];
    const time = new Date(now).toISOString();
    const nodes = [...analysis.nodes.values()];
    const down = nodes.filter((n) => n.status === DOWN && n.rootCause);
    for (const id of pending.keys()) if (!down.some((n) => n.id === id)) pending.delete(id);
    const planned = [];
    for (const node of down) {
        if (!open.has(node.id)) {
            if (!pending.has(node.id)) pending.set(node.id, time);
            if (Date.parse(time) - Date.parse(pending.get(node.id)) < minDownMs) continue;
        }
        const affected = affectedBy(analysis, node.id);
        const started = open.get(node.id)?.data.started ?? pending.get(node.id) ?? time;
        pending.delete(node.id);
        const data = {
            status: DOWN,
            node: node.id,
            started,
            affected: affected.map((n) => n.id),
            summary: incidentSummary({ started, affectedNames: affected.map((n) => n.name) }),
        };
        if (open.get(node.id)?.data.summary === data.summary) continue;
        planned.push({ node: node.id, decorator: buildIncident({ namespace, architectureId, version, node: node.id, data }) });
    }
    const stillDown = new Set(down.map((n) => n.id));
    for (const [id, decorator] of open) {
        if (stillDown.has(id)) continue;
        const affectedNames = (decorator.data.affected ?? []).map((a) => analysis.nodes.get(a)?.name ?? a);
        const data = { ...decorator.data, status: RESOLVED, ended: time };
        data.summary = incidentSummary({ started: data.started, ended: time, affectedNames });
        planned.push({ node: id, decorator: { ...decorator, data }, close: true });
    }
    return planned;
}
