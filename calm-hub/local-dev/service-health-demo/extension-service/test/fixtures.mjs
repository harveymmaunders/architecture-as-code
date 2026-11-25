// An architecture that mirrors the demo plan, without the files of the architecture task.
export const SERVICES = [
    ['customer-portal', 'webclient'],
    ['admin-console', 'webclient'],
    ['api-gateway', 'service'],
    ['auth-service', 'service'],
    ['orders-api', 'service'],
    ['payments-api', 'service'],
    ['central-db', 'database'],
];

export const CONNECTS = [
    ['customer-portal', 'api-gateway'],
    ['admin-console', 'api-gateway'],
    ['admin-console', 'auth-service'],
    ['api-gateway', 'auth-service'],
    ['api-gateway', 'orders-api'],
    ['api-gateway', 'payments-api'],
    ['orders-api', 'payments-api'],
    ['orders-api', 'central-db'],
    ['payments-api', 'central-db'],
    ['auth-service', 'central-db'],
];

export const relId = (source, destination) => `${source}-to-${destination}`;

export function architecture() {
    return {
        nodes: SERVICES.map(([id, type], i) => ({
            'unique-id': id,
            'node-type': type,
            name: id,
            description: `The ${id}`,
            // Both metadata shapes that CALM allows.
            metadata: i % 2 ? [{ owner: 'team' }, { 'prometheus-job': id }] : { 'prometheus-job': id },
        })),
        relationships: CONNECTS.map(([source, destination]) => ({
            'unique-id': relId(source, destination),
            description: `${source} calls ${destination}`,
            'relationship-type': { connects: { source: { node: source }, destination: { node: destination } } },
        })),
        flows: [
            'http://localhost:8080/calm/namespaces/service-health-demo/flows/place-order/versions/1.0.0',
            'http://localhost:8080/api/calm/namespaces/service-health-demo/flows/2/versions/1.0.0',
        ],
    };
}

export function flow(id, ...pairs) {
    return {
        'unique-id': id,
        name: id,
        description: id,
        transitions: pairs.map(([s, d], i) => ({ 'relationship-unique-id': relId(s, d), 'sequence-number': i + 1, description: `${s} → ${d}` })),
    };
}

export const FLOWS = [
    flow('place-order', ['customer-portal', 'api-gateway'], ['api-gateway', 'orders-api'], ['orders-api', 'central-db']),
    flow('staff-login', ['admin-console', 'auth-service'], ['auth-service', 'central-db']),
    flow('customer-login', ['customer-portal', 'api-gateway'], ['api-gateway', 'auth-service']),
    flow('take-payment', ['api-gateway', 'payments-api'], ['payments-api', 'central-db']),
];

// Prometheus samples with the given jobs down. stopped jobs have up = 0 and no health series.
export function health({ failing = [], stopped = [] } = {}) {
    const jobs = {};
    for (const [id] of SERVICES) {
        if (stopped.includes(id)) jobs[id] = { up: 0 };
        else jobs[id] = { up: 1, health: failing.includes(id) ? 0 : 1 };
    }
    return { available: true, jobs };
}

export const UNAVAILABLE = { available: false, jobs: {}, error: 'Prometheus at http://prometheus:9090 could not be read: fetch failed' };
