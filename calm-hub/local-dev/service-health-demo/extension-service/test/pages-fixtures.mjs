// Analyses for the tab, screen and card tests, on the fixture architecture.
import { analyse } from '../analysis.mjs';
import { FLOWS, UNAVAILABLE, architecture, health } from './fixtures.mjs';

export const NOW = new Date('2026-11-25T10:00:00Z');
export const context = { namespace: 'service-health-demo', resourceType: 'architectures', resourceId: '12', version: '1.1.0' };
export const links = {
    grafanaUrl: 'http://localhost:3000/d/service-health/service-health',
    grafanaServiceUrl: 'http://localhost:3000/d/service-detail/service-detail?var-service={job}',
};

const CRITICALITY = { 'place-order': 'critical', 'take-payment': 'critical', 'customer-login': 'high' };

export function architectureWithMetadata() {
    const a = architecture();
    for (const node of a.nodes) {
        node.metadata = { 'prometheus-job': node['unique-id'], owner: 'team-x', oncall: 'x-oncall@example.com', runbook: `https://runbooks.example.com/${node['unique-id']}`, tier: 'tier-1' };
    }
    a.relationships[0].protocol = 'HTTPS';
    return a;
}

export const flowList = () => FLOWS.map((f) => ({
    flow: { ...f, metadata: { criticality: CRITICALITY[f['unique-id']] ?? 'normal' } },
    source: `http://localhost:8080/calm/namespaces/service-health-demo/flows/${f['unique-id']}/versions/1.1.0`,
}));

// Health with traffic metrics; `slow` jobs cross the p95 threshold. `since` sets the start of each status.
export function healthWith({ slow = [], since = {}, ...rest } = {}) {
    const h = health(rest);
    for (const [job, sample] of Object.entries(h.jobs)) {
        sample.metrics = { rps: 5, errorRatio: 0.01, p95ms: slow.includes(job) ? 900 : 40 };
        sample.since = since[job] ?? null;
    }
    return h;
}

export function analysisOf(h = healthWith(), options = {}) {
    return analyse({ architecture: architectureWithMetadata(), health: h, flows: flowList(), ...options });
}

export const SCENARIOS = [
    ['all healthy', () => analysisOf()],
    ['central-db down', () => analysisOf(healthWith({ failing: ['central-db'], since: { 'central-db': '2026-11-25T09:50:00.000Z' } }))],
    ['central-db and orders-api down', () => analysisOf(healthWith({ failing: ['central-db', 'orders-api'] }))],
    ['payments-api slow', () => analysisOf(healthWith({ slow: ['payments-api'] }))],
    ['simulated auth-service', () => analysisOf(healthWith(), { simulate: ['auth-service'] })],
    ['Prometheus unavailable', () => analysisOf(UNAVAILABLE)],
];
