// Readers for a CALM architecture and flows. No I/O.

export function nodesOf(architecture) {
    return (Array.isArray(architecture?.nodes) ? architecture.nodes : [])
        .filter((node) => node && typeof node['unique-id'] === 'string');
}

export function relationshipsOf(architecture) {
    return (Array.isArray(architecture?.relationships) ? architecture.relationships : [])
        .filter((rel) => rel && typeof rel['unique-id'] === 'string');
}

// CALM allows metadata as one object or as an array of objects.
export function metadataValue(element, key) {
    const metadata = element?.metadata;
    const entries = Array.isArray(metadata) ? metadata : [metadata];
    for (const entry of entries) {
        if (entry && typeof entry === 'object' && typeof entry[key] === 'string' && entry[key].trim()) {
            return entry[key].trim();
        }
    }
    return undefined;
}

export function prometheusJob(node) {
    return metadataValue(node, 'prometheus-job') ?? node['unique-id'];
}

const listOf = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

// The pairs that a relationship draws, from the element that depends to the element it uses.
// Only connects carries the dependency that the impact rules follow.
export function relationshipEnds(rel) {
    const type = rel['relationship-type'] && typeof rel['relationship-type'] === 'object' ? rel['relationship-type'] : {};
    if (type.connects) {
        const source = type.connects.source?.node;
        const destination = type.connects.destination?.node;
        return source && destination ? { kind: 'connects', pairs: [[source, destination]] } : { kind: 'connects', pairs: [] };
    }
    if (type.interacts) {
        const actor = type.interacts.actor;
        return { kind: 'interacts', pairs: listOf(type.interacts.nodes).map((n) => [actor, n]) };
    }
    for (const kind of ['composed-of', 'deployed-in']) {
        if (type[kind]) {
            const container = type[kind].container;
            return { kind, pairs: listOf(type[kind].nodes).map((n) => [container, n]) };
        }
    }
    if (Array.isArray(type.options)) return { kind: 'options', pairs: [] };
    return { kind: 'unknown', pairs: [] };
}

// CALM 1.3 `flows` holds inline flow objects only, so the demo lists flow URLs in metadata.flows.
// Accept URL strings from both places.
export function flowUrlsOf(architecture) {
    const metadata = architecture?.metadata;
    const fromMetadata = (Array.isArray(metadata) ? metadata : [metadata])
        .flatMap((entry) => (entry && Array.isArray(entry.flows) ? entry.flows : []));
    const topLevel = Array.isArray(architecture?.flows) ? architecture.flows : [];
    return [...new Set([...topLevel, ...fromMetadata].filter((u) => typeof u === 'string'))];
}

// Inline flow objects, as CALM 1.3 allows in `flows`.
export function inlineFlowsOf(architecture) {
    return (Array.isArray(architecture?.flows) ? architecture.flows : [])
        .filter((f) => f && typeof f === 'object' && Array.isArray(f.transitions));
}

export function transitionsOf(flow) {
    return (Array.isArray(flow?.transitions) ? flow.transitions : [])
        .filter((t) => t && typeof t['relationship-unique-id'] === 'string')
        .sort((a, b) => (a['sequence-number'] ?? 0) - (b['sequence-number'] ?? 0));
}
