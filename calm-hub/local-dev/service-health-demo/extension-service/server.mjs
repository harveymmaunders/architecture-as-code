// Backend of the service-health CALM Hub extension. Zero npm dependencies.
import { createServer } from 'node:http';
import { createHandler } from './app.mjs';
import { createHubClient } from './hub.mjs';
import { createVerifier } from './identity.mjs';
import { createPublisher } from './publisher.mjs';
import { createTraceReader, tryItLink } from './traces.mjs';

const PORT = Number(process.env.PORT ?? 8095);
// 127.0.0.1 keeps a sidecar private to its pod.
const HOST = process.env.HOST || '0.0.0.0';
// A service-account token for a Hub that needs credentials. The demo Hub runs no-auth.
const HUB_TOKEN = process.env.HUB_TOKEN || undefined;
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? 'http://prometheus:9090';
const CALM_HUB_URL = process.env.CALM_HUB_URL ?? 'http://hub:8080';
// Hub signs `iss` with calm.hub.base-url, whatever address the JWKS comes from.
const CALM_HUB_ISSUER = process.env.CALM_HUB_ISSUER ?? 'http://localhost:8080';
const NAMESPACES = (process.env.HEALTH_NAMESPACES ?? 'service-health-demo').split(',').map((n) => n.trim()).filter(Boolean);
const VERIFY_IDENTITY = process.env.VERIFY_IDENTITY !== 'false';
// Not set: no trace evidence.
const TEMPO_URL = process.env.TEMPO_URL || undefined;
// Browser-facing, not the container network name. Only the origin is used.
const GRAFANA = new URL(process.env.GRAFANA_URL || 'http://localhost:3000').origin;

const readTraces = createTraceReader({ tempoUrl: TEMPO_URL, grafanaUrl: GRAFANA, cacheMs: Number(process.env.TRACE_CACHE_MS ?? 10000) });

const verifyAssertion = VERIFY_IDENTITY ? createVerifier({
    issuer: CALM_HUB_ISSUER,
    audience: 'service-health',
    fetchJwks: async () => {
        const res = await fetch(new URL('/api/calm/auth/jwks', CALM_HUB_URL), { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`JWKS request failed with ${res.status}`);
        return res.json();
    },
}) : undefined;

const handle = createHandler({
    prometheusUrl: PROMETHEUS_URL,
    hubClient: createHubClient({ hubUrl: CALM_HUB_URL, token: HUB_TOKEN, cacheMs: Number(process.env.FLOW_CACHE_MS ?? 15000) }),
    verifyAssertion,
    namespaces: NAMESPACES,
    readTraces,
    links: {
        grafanaUrl: `${GRAFANA}/d/service-health/service-health`,
        tryIt: tryItLink,
    },
});

createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
        if (req.url !== '/healthz') console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    });
    handle(req, res).catch((error) => {
        console.error(error);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({ type: 'about:blank', title: 'The service-health service failed', status: 500 }));
    });
}).listen(PORT, HOST, () => {
    console.log(`service-health on ${HOST}:${PORT}, Prometheus ${PROMETHEUS_URL}, Tempo ${TEMPO_URL ?? 'not set'}, CALM Hub ${CALM_HUB_URL}, `
        + `namespaces ${NAMESPACES.join(', ')}, identity ${VERIFY_IDENTITY ? `checked (issuer ${CALM_HUB_ISSUER})` : 'NOT checked'}`);
});

// Writes incident decorators, so the normal CALM diagram shows a failing node and refreshes by itself.
if (process.env.PUBLISH_DECORATORS !== 'false') {
    const publishers = NAMESPACES.map((namespace) => createPublisher({
        hubUrl: CALM_HUB_URL,
        token: HUB_TOKEN,
        prometheusUrl: PROMETHEUS_URL,
        namespace,
        intervalMs: Number(process.env.PUBLISH_INTERVAL_MS ?? 10000),
        minDownMs: Number(process.env.INCIDENT_MIN_DOWN_MS ?? 15000),
    }));
    for (const publisher of publishers) publisher.start();
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.once(signal, () => {
            for (const publisher of publishers) publisher.stop();
            process.exit(0);
        });
    }
}
