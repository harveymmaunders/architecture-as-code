// The HTTP routes of the service. With `verifyAssertion`, each route needs a valid CALM Hub
// identity assertion, and a route with {namespace} needs the namespace that Hub checked (`ns`).
// Screen and card routes have no namespace in the path, so they serve only `namespaces`.
// Every route is a GET.
import { analyse } from './analysis.mjs';
import { readHealth as defaultReadHealth } from './prometheus.mjs';
import { cardReply, flowStatusReply, namespacesScreen, traceLinksScreen } from './screen-view.mjs';
import { simulationReply } from './simulation.mjs';
import { errorReply, tabReply } from './views.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const RESOURCE_ROUTE = /^\/(tab|flow-status|lens)\/([^/]+)\/([^/]+)\/([^/]+)$/;
const MAX_ARCHITECTURES = 50;

class Problem extends Error {
    constructor(status, title, detail, extra) {
        super(title);
        this.status = status;
        this.detail = detail;
        this.extra = extra;
    }
}

function parseUrl(raw) {
    try {
        return new URL(raw, 'http://service');
    } catch {
        throw new Problem(400, 'The request URL is not valid');
    }
}

function send(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Problem(413, 'The request body is too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export function createHandler({
    prometheusUrl,
    hubClient,
    readHealth = defaultReadHealth,
    // traces.mjs createTraceReader. Never throws; unavailable gives no trace evidence.
    readTraces = async () => undefined,
    verifyAssertion,
    namespaces = ['service-health-demo'],
    links = {},
    log = console,
}) {
    async function load({ namespace, resourceId, version, live = true }) {
        const read = await hubClient.getArchitecture(namespace, resourceId, version);
        const architecture = read.document;
        const [health, flowResult, traces] = await Promise.all([
            live ? readHealth(prometheusUrl) : undefined, hubClient.getFlows(namespace, architecture), live ? readTraces().catch(() => undefined) : undefined,
        ]);
        const analysis = live ? analyse({ architecture, health, flows: flowResult.flows, traces }) : undefined;
        return { analysis, flows: flowResult.flows, flowNotes: flowResult.notes, version: read.version, architecture };
    }

    async function loadOrReply(context, title, options = {}) {
        try {
            const loaded = await load({ ...context, ...options });
            context.version = loaded.version;
            return loaded;
        } catch (error) {
            log.warn(`architecture ${context.namespace}/${context.resourceId}@${context.version}: ${error.message}`);
            return { reply: errorReply(`The architecture could not be read from CALM Hub: ${error.message}`, title) };
        }
    }

    async function resourceView(kind, context, url) {
        if (kind === 'lens') {
            // A lens shows a problem reply, not blocks.
            const loaded = await load({ ...context, live: false }).catch((error) => {
                throw new Problem(502, 'The architecture could not be read from CALM Hub', error.message);
            });
            return simulationReply({ architecture: loaded.architecture, flows: loaded.flows, fail: url.searchParams.get('fail') });
        }
        const loaded = await loadOrReply(context);
        if (loaded.reply) return loaded.reply;
        const view = kind === 'tab' ? tabReply : flowStatusReply;
        return view({ analysis: loaded.analysis, flowNotes: loaded.flowNotes, context, links });
    }

    async function summarise(namespace) {
        const list = (await hubClient.listArchitectures(namespace)).slice(0, MAX_ARCHITECTURES);
        return Promise.all(list.map(async ({ id, name }) => {
            try {
                const { analysis, version } = await load({ namespace, resourceId: id });
                return { namespace, id, name, version, analysis };
            } catch (error) {
                return { namespace, id, name, error: error.message };
            }
        }));
    }

    async function summariseAll() {
        const results = await Promise.all(namespaces.map((ns) => summarise(ns).catch((error) => {
            log.warn(`namespace ${ns}: ${error.message}`);
            return [{ namespace: ns, id: '–', name: ns, error: `The namespace could not be read: ${error.message}` }];
        })));
        return results.flat();
    }

    async function screen(url) {
        const q = url.searchParams;
        const namespace = q.get('namespace');
        if (!namespace) return namespacesScreen({ summaries: await summariseAll(), namespaces });
        if (!namespaces.includes(namespace)) {
            return errorReply(`Service health serves the namespaces ${namespaces.join(', ')} only.`, 'Flow status');
        }
        if (q.get('resourceType') !== 'architectures' || !q.get('resourceId') || !SEGMENT.test(q.get('resourceId'))) {
            return errorReply('Service health works on architectures only.', 'Flow status');
        }
        const context = { namespace, resourceType: 'architectures', resourceId: q.get('resourceId'), version: q.get('version') ?? undefined };
        const loaded = await loadOrReply(context, 'Flow status');
        if (loaded.reply) return loaded.reply;
        return traceLinksScreen({ analysis: loaded.analysis, flowNotes: loaded.flowNotes, context, links });
    }

    async function verify(req, raw) {
        if (!verifyAssertion) return undefined;
        try {
            return await verifyAssertion(req.headers['x-calm-hub-identity'], { method: req.method, pathAndQuery: req.url, body: raw });
        } catch (error) {
            log.warn(`rejected ${req.method} ${req.url?.split('?')[0]}: ${error.message}`);
            throw new Problem(401, 'A valid CALM Hub identity assertion is required');
        }
    }

    return async function handle(req, res) {
        try {
            const url = parseUrl(req.url);
            if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'UP' });
            const raw = await readBody(req);
            const claims = await verify(req, raw);
            if (req.method !== 'GET') throw new Problem(405, 'Method not allowed');

            if (url.pathname === '/screen') return send(res, 200, await screen(url));
            if (url.pathname === '/card') return send(res, 200, cardReply({ summaries: await summariseAll() }));

            const match = RESOURCE_ROUTE.exec(url.pathname);
            if (!match || !match.slice(2).every((s) => SEGMENT.test(s))) throw new Problem(404, 'Not found');
            const [, kind, namespace, resourceType, resourceId] = match;
            // Hub checked the route scope for `ns` only. Refuse a path with another namespace.
            if (claims && claims.ns !== namespace) throw new Problem(403, 'The namespace is not the one that CALM Hub checked');
            if (resourceType !== 'architectures') {
                if (kind === 'lens') throw new Problem(400, 'Service health works on architectures only');
                return send(res, 200, errorReply('Service health works on architectures only.'));
            }
            const context = { namespace, resourceType, resourceId, version: url.searchParams.get('version') ?? undefined };
            return send(res, 200, await resourceView(kind, context, url));
        } catch (error) {
            const problem = error instanceof Problem ? error : new Problem(500, 'The service-health service failed', error.message);
            if (!(error instanceof Problem)) log.error(error);
            return send(res, problem.status,
                { type: 'about:blank', title: problem.message, status: problem.status, ...(problem.detail && { detail: problem.detail }), ...problem.extra },
                'application/problem+json');
        }
    };
}
