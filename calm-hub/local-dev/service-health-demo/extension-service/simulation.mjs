// The Failure Simulation lens: the architecture with the nodes of `fail` failed. No live data. No I/O.
// A click on a node toggles it in `fail`, so Hub asks for the lens again and draws the new state.
import { analyse, sortAnalysedFlows } from './analysis.mjs';
import { nodesOf, prometheusJob } from './calm.mjs';
import { flowName, plural } from './present.mjs';

export const NONE = 'none';
const TYPE_TAGS = { webclient: 'WebClient', service: 'Service', database: 'Database' };

export function parseFail(value) {
    if (!value || value === NONE) return [];
    return [...new Set(String(value).split(',').map((v) => v.trim()).filter(Boolean))];
}

// The `fail` value after a click on `id`: added when not failed, else removed.
export function toggleFail(fail, id) {
    const list = parseFail(fail);
    const next = list.includes(id) ? list.filter((v) => v !== id) : [...list, id];
    return next.length ? next.join(',') : NONE;
}

// Every service up: the simulation shows only what the chosen failures break.
function allUp(architecture) {
    return { available: true, jobs: Object.fromEntries(nodesOf(architecture).map((n) => [prometheusJob(n), { up: 1, health: 1 }])) };
}

export function simulationReply({ architecture, flows = [], fail }) {
    const known = new Set(nodesOf(architecture).map((n) => n['unique-id']));
    const failed = parseFail(fail).filter((id) => known.has(id));
    const current = failed.length ? failed.join(',') : NONE;
    const analysis = analyse({ architecture, health: allUp(architecture), flows, simulate: failed });

    const nodes = nodesOf(architecture).map((node) => {
        const id = node['unique-id'];
        const state = analysis.nodes.get(id);
        const isFailed = failed.includes(id);
        const impacted = !isFailed && (state.status === 'impacted' || state.status === 'down');
        return {
            id,
            label: state.name,
            metadata: `[${node['node-type'] ?? 'node'}]`,
            tags: [TYPE_TAGS[node['node-type']] ?? 'Component', ...(isFailed ? ['Failed'] : impacted ? ['Impacted'] : [])],
            ...(isFailed && { badges: [{ text: '✕ Failed', tone: 'negative' }] }),
            ...(impacted && { badges: [{ text: '⚠ Impacted', tone: 'warning' }] }),
            link: { params: { fail: toggleFail(current, id) } },
            tooltip: isFailed ? 'Click to restore' : 'Click to fail',
        };
    });
    const edges = analysis.edges.filter((e) => known.has(e.source) && known.has(e.target)).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        tags: [e.broken ? 'Broken' : e.kind === 'connects' ? 'Connects' : 'Other'],
    }));

    const all = sortAnalysedFlows(analysis.flows);
    const broken = all.filter((f) => f.status === 'broken');
    const critical = broken.filter((f) => f.criticality === 'critical').length;
    const head = failed.length
        ? { type: 'alert', tone: broken.length ? 'negative' : 'positive',
            text: `Failing: ${failed.map((id) => analysis.nodes.get(id).name).join(', ')} — ${plural(broken.length, 'flow')} broken${critical ? ` (${critical} critical)` : ''}` }
        : { type: 'markdown', text: 'Click a node to fail it. Click it again to restore it.' };

    return {
        hubApi: 0,
        kind: 'graph',
        layout: { algorithm: 'layered', direction: 'down' },
        graph: { nodes, edges },
        // Hub accepts a control value only when it is one of the items.
        controls: [{ type: 'segmented', param: 'fail', label: 'Simulation', ...(current === NONE && { value: NONE }), items: [{ value: NONE, label: 'Reset' }] }],
        panels: [{
            title: 'Failure Simulation',
            blocks: [
                head,
                {
                    type: 'table',
                    columns: ['Flow', 'Affected'],
                    rows: all.map((f) => [flowName(f), f.status === 'broken' ? { badge: '✕ Broken', tone: 'negative' } : { badge: '✓ No', tone: 'positive' }]),
                },
            ],
        }],
    };
}
