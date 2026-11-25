// The Flow status tab, its trace-links screen, the namespace screen and the home page card. No I/O.
// Blocks have no collapsible, so "Show trace links" is a screen with the same table and a Traces part.
import { EXTENSION_ID, flowWithStart, hubLink, isAffected, plural, screenLink, tracesNote, warnings } from './present.mjs';

const reply = (title, blocks) => ({ hubApi: 0, ...(title && { title }), blocks });

const errors = (flow) => flow.traces?.failed ?? 0;
const successes = (flow) => Math.max((flow.traces?.total ?? 0) - errors(flow), 0);

// Most errors first.
const sortByErrors = (flows) => [...flows].sort((a, b) => errors(b) - errors(a) || a.name.localeCompare(b.name));

function countCells(flow) {
    if (!flow.traces) return ['–', '–'];
    const e = errors(flow);
    const s = successes(flow);
    return [
        { badge: String(e), tone: e ? 'negative' : 'neutral' },
        { badge: String(s), tone: s ? 'positive' : 'neutral' },
    ];
}

function traceCells(flow, links) {
    const t = flow.traces;
    const view = t?.failed && t.lastFailed?.traceUrl ? { label: 'Last failure', href: t.lastFailed.traceUrl }
        : t?.lastRun?.traceUrl ? { label: 'Last run', href: t.lastRun.traceUrl } : '–';
    const search = t?.failed && t.searchUrl ? { label: 'Failing traces', href: t.searchUrl } : '–';
    const tryIt = typeof links.tryIt === 'function' ? links.tryIt(flow) : undefined;
    return [view, search, tryIt?.href ? tryIt : '–'];
}

function table(analysis, links, withTraces) {
    const flows = sortByErrors(analysis.flows);
    return {
        type: 'table',
        id: 'flows',
        columns: ['Flow', 'Errors', 'Success', ...(withTraces ? ['Trace', 'Failing traces', 'Try it'] : [])],
        rows: flows.map((f) => [flowWithStart(f, analysis), ...countCells(f), ...(withTraces ? traceCells(f, links) : [])]),
    };
}

const windowText = (analysis) => `Traces of the last ${analysis.traces?.minutes ?? 15} min.`;

export function flowStatusReply({ analysis, context, flowNotes = [], links = {} }) {
    return reply(undefined, [
        ...warnings(analysis, flowNotes),
        ...tracesNote(analysis),
        { type: 'markdown', text: windowText(analysis) },
        { type: 'links', items: [screenLink('Show trace links', context)] },
        table(analysis, links, false),
    ]);
}

export function traceLinksScreen({ analysis, context, flowNotes = [], links = {} }) {
    // No title: Hub names the screen and its architecture.
    return reply(undefined, [
        ...warnings(analysis, flowNotes),
        ...tracesNote(analysis),
        { type: 'markdown', text: windowText(analysis) },
        { type: 'links', items: [hubLink('Hide trace links', context, { extension: EXTENSION_ID })] },
        table(analysis, links, true),
    ]);
}

// summaries: [{ namespace, id, name, version, analysis?, error? }]
export function namespacesScreen({ summaries, namespaces }) {
    const blocks = [...cardStats(summaries).blocks];
    if (!summaries.length) return reply('All architectures', [...blocks, { type: 'markdown', text: `No architectures in ${namespaces.join(', ')}.` }]);
    blocks.push({
        type: 'table',
        columns: ['Architecture', 'Version', 'Services down', 'Flows affected'],
        rows: summaries.map((s) => {
            const context = { namespace: s.namespace, resourceType: 'architectures', resourceId: String(s.id), version: s.version };
            if (!s.analysis?.available) return [s.name, s.version ?? '–', '?', '?'];
            return [screenLink(s.name, context), s.version, s.analysis.summary.down, s.analysis.flows.filter(isAffected).length];
        }),
    });
    return reply('All architectures', blocks);
}

// Two numbers. '?' when no architecture could be checked: zero would claim that all is well.
export function cardStats(summaries) {
    const ok = summaries.filter((s) => s.analysis?.available);
    const sum = (pick) => (ok.length ? ok.reduce((n, s) => n + pick(s.analysis), 0) : '?');
    const blocks = [{
        type: 'stats',
        items: [
            { label: '✕ Services down', value: sum((a) => a.summary.down) },
            { label: '✕ Flows affected', value: sum((a) => a.flows.filter(isAffected).length) },
        ],
    }];
    const failed = summaries.length - ok.length;
    if (failed) blocks.push({ type: 'alert', tone: 'warning', text: `? ${plural(failed, 'architecture')} could not be checked.` });
    return { blocks };
}

export const cardReply = ({ summaries }) => reply('Service health', cardStats(summaries).blocks);
