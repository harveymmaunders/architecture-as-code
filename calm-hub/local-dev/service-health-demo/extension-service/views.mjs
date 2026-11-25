// The Overview designer tab: what is impacted, readable in three seconds. No I/O.
import { flowBadge, flowName, hhmm, isAffected, plural, warnings } from './present.mjs';

const CRITICALITY = { critical: 0, high: 1, normal: 2 };
const STATUS = { broken: 0, degraded: 1 };

// Critical first, then broken before degraded.
export const sortAffected = (flows) => [...flows].sort((a, b) => (CRITICALITY[a.criticality] ?? 9) - (CRITICALITY[b.criticality] ?? 9)
    || (STATUS[a.status] ?? 9) - (STATUS[b.status] ?? 9) || a.name.localeCompare(b.name));

// "orders-api down since 15:30", "payments-api slow", or "failing in traces".
export function cause(analysis) {
    const nodes = [...analysis.nodes.values()];
    const down = nodes.filter((n) => n.status === 'down' && n.rootCause);
    if (down.length) return down.map((n) => `${n.id} down${n.since ? ` since ${hhmm(n.since)}` : ''}`).join(', ');
    const warn = nodes.filter((n) => n.status === 'warn');
    if (warn.length) {
        return warn.map((n) => {
            const words = [/p95/.test(n.reason) && 'slow', /error ratio/.test(n.reason) && 'erroring'].filter(Boolean);
            return `${n.id} ${words.join(' and ') || 'in warning'}`;
        }).join(', ');
    }
    return 'failing in traces';
}

export function tabReply({ analysis, flowNotes = [], links = {} }) {
    const blocks = [...warnings(analysis, flowNotes)];
    const flows = analysis.flows;
    const affected = sortAffected(flows.filter(isAffected));
    if (analysis.available && !affected.length) {
        blocks.push({ type: 'markdown', text: `### ✓ All ${plural(flows.length, 'flow')} working` });
    } else if (affected.length) {
        const broken = affected.some((f) => f.status === 'broken');
        const critical = affected.filter((f) => f.criticality === 'critical').length;
        const head = broken ? `✕ ${plural(affected.length, 'flow')} affected` : `⚠ ${plural(affected.length, 'flow')} degraded`;
        blocks.push({ type: 'alert', tone: broken ? 'negative' : 'warning', text: `${head}${critical ? ` (${critical} critical)` : ''} — ${cause(analysis)}` });
        blocks.push({ type: 'table', columns: ['Flow', 'Status'], rows: affected.map((f) => [flowName(f), flowBadge(f.status)]) });
        const working = flows.length - affected.length;
        if (working) blocks.push({ type: 'markdown', text: `${plural(working, 'flow')} working.` });
    }
    if (links.grafanaUrl) blocks.push({ type: 'links', items: [{ label: 'Grafana dashboard', href: links.grafanaUrl }] });
    // No title: Hub already names the tab.
    return { hubApi: 0, blocks };
}

export function errorReply(message, title) {
    return { hubApi: 0, ...(title && { title }), blocks: [{ type: 'alert', tone: 'negative', text: `✕ ${message}` }] };
}
