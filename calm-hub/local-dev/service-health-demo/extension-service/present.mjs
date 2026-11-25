// Labels, badges and links that the views share. Each status has an icon, so no view shows status by
// colour alone. No I/O.

export const EXTENSION_ID = 'service-health';
export const SCREEN_ID = 'flows';

const FLOW = {
    broken: { icon: '✕', label: 'Broken', tone: 'negative' },
    degraded: { icon: '⚠', label: 'Degraded', tone: 'warning' },
    ok: { icon: '✓', label: 'Working', tone: 'positive' },
    unknown: { icon: '?', label: 'Unknown', tone: 'neutral' },
};

export const flowBadge = (status) => {
    const entry = FLOW[status] ?? FLOW.unknown;
    return { badge: `${entry.icon} ${entry.label}`, tone: entry.tone };
};

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const sentence = (value) => (value ? String(value).replace(/\.?\s*$/, '.') : '');
export const hhmm = (iso) => String(iso ?? '').slice(11, 16);
export const isAffected = (flow) => flow.status === 'broken' || flow.status === 'degraded';

// "Place order · critical". Other criticalities are noise in a short list.
export const flowName = (flow) => (flow.criticality === 'critical' ? `${flow.name} · critical` : flow.name);

// "Place order · starts at Customer Portal".
export function flowWithStart(flow, analysis) {
    const start = flow.start && (analysis.nodes.get(flow.start)?.name ?? flow.start);
    return start ? `${flow.name} · starts at ${start}` : flow.name;
}

export function hubLink(label, context, extra = {}) {
    if (!context.version) return label;
    return {
        label,
        hub: { namespace: context.namespace, type: context.resourceType ?? 'architectures', id: context.resourceId, version: context.version, ...extra },
    };
}

export function screenLink(label, context, params = {}) {
    const screen = { extension: EXTENSION_ID, screen: SCREEN_ID };
    if (context?.namespace && context.resourceId && context.version) {
        screen.context = { namespace: context.namespace, type: context.resourceType ?? 'architectures', id: context.resourceId, version: context.version };
    }
    if (Object.keys(params).length) screen.params = params;
    return { label, screen };
}

// A quiet note when traces were asked for and could not be read. Nothing when Tempo is not set up.
export function tracesNote(analysis) {
    const t = analysis.traces;
    if (!t || t.available || /not set/.test(t.error ?? '')) return [];
    return [{ type: 'markdown', text: `_No trace data: ${sentence(t.error ?? 'Tempo could not be read')}_` }];
}

export function warnings(analysis, flowNotes = []) {
    const blocks = [];
    if (!analysis.available) {
        const error = sentence(analysis.error ?? 'Prometheus could not be reached');
        blocks.push({ type: 'alert', tone: 'warning', text: `? ${error} Every status is unknown.` });
    }
    for (const note of flowNotes) blocks.push({ type: 'alert', tone: 'info', text: note });
    return blocks;
}
