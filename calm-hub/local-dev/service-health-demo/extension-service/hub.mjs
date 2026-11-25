// Reads architectures and flows from the CALM Hub REST API. The demo Hub runs with no auth, so the
// service sends no credentials. hubData cannot send flows, and a designer tab route must be a GET,
// so the service reads them here.
import { flowUrlsOf, inlineFlowsOf, relationshipsOf, transitionsOf } from './calm.mjs';

// Flow URLs in a document name the Hub as the author saw it, often http://localhost:8080. Only a
// Hub flow path in the architecture's own namespace is accepted, and the origin is always
// CALM_HUB_URL. So a document cannot make the service fetch another host, or read the flows of a
// namespace that the caller was not checked for.
export function rewriteFlowUrl(raw, hubUrl, namespace) {
    const url = URL.parse(raw);
    const match = url && /^\/(?:api\/)?calm\/namespaces\/([^/]+)\/flows\//.exec(url.pathname);
    if (!match) return undefined;
    if (namespace !== undefined && match[1] !== namespace) return undefined;
    const target = new URL(`${url.pathname}${url.search}`, hubUrl);
    return target.toString();
}

export function latestVersion(versions) {
    const parse = (v) => String(v).split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    return [...versions].sort((a, b) => {
        const pa = parse(a);
        const pb = parse(b);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            if (pa[i] === pb[i]) continue;
            if (pa[i] === undefined) return 1;
            if (pb[i] === undefined) return -1;
            if (typeof pa[i] === 'number' && typeof pb[i] === 'number') return pa[i] - pb[i];
            return String(pa[i]).localeCompare(String(pb[i]));
        }
        return 0;
    }).at(-1);
}

/** The headers of a Hub call. `token` is a service-account bearer token for a Hub that needs one. */
export const hubHeaders = (token, extra = {}) => ({ Accept: 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...extra });

export function createHubClient({ hubUrl, token, fetchImpl = fetch, timeoutMs = 3000, cacheMs = 15000, now = Date.now }) {
    const cache = new Map();

    async function getJson(url) {
        const res = await fetchImpl(url, { headers: hubHeaders(token), signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`${new URL(url).pathname} replied ${res.status}`);
        const body = await res.json();
        // A store can hand back the document as a JSON string.
        return typeof body === 'string' ? JSON.parse(body) : body;
    }

    const api = (path) => new URL(`/api/calm/namespaces/${path}`, hubUrl).toString();
    const seg = encodeURIComponent;

    async function getArchitecture(namespace, id, version) {
        let resolved = version;
        if (!resolved) {
            const versions = (await getJson(api(`${seg(namespace)}/architectures/${seg(id)}/versions`)))?.values ?? [];
            resolved = latestVersion(versions);
            if (!resolved) throw new Error(`architecture ${id} has no versions`);
        }
        const document = await getJson(api(`${seg(namespace)}/architectures/${seg(id)}/versions/${seg(resolved)}`));
        return { document, version: resolved };
    }

    async function listNamespaceFlows(namespace, architecture) {
        const relIds = new Set(relationshipsOf(architecture).map((r) => r['unique-id']));
        const summaries = (await getJson(api(`${seg(namespace)}/flows`)))?.values ?? [];
        const fetched = await Promise.allSettled(summaries.slice(0, 100)
            .filter((s) => s && s.id !== undefined)
            .map(async (s) => ({ flow: await getJson(api(`${seg(namespace)}/flows/${seg(s.id)}`)), source: `flows/${s.id}` })));
        return fetched.filter((r) => r.status === 'fulfilled').map((r) => r.value)
            .filter(({ flow }) => transitionsOf(flow).some((t) => relIds.has(t['relationship-unique-id'])));
    }

    // Returns { flows: [{ flow, source }], notes: [string] }. Never throws.
    async function getFlows(namespace, architecture) {
        const urls = flowUrlsOf(architecture);
        const key = `${namespace}|${urls.join('|')}|${relationshipsOf(architecture).map((r) => r['unique-id']).join(',')}`;
        const hit = cache.get(key);
        if (hit && hit.expires > now()) return hit.value;

        const notes = [];
        let flows = inlineFlowsOf(architecture).map((flow) => ({ flow, source: 'inline' }));
        if (urls.length) {
            const results = await Promise.allSettled(urls.map(async (raw) => {
                const url = rewriteFlowUrl(raw, hubUrl, namespace);
                if (!url) throw new Error(`${raw} is not a CALM Hub flow URL in namespace ${namespace}`);
                return { flow: await getJson(url), source: raw };
            }));
            flows.push(...results.filter((r) => r.status === 'fulfilled').map((r) => r.value));
            const failed = results.filter((r) => r.status === 'rejected').length;
            const outside = urls.filter((raw) => rewriteFlowUrl(raw, hubUrl) && !rewriteFlowUrl(raw, hubUrl, namespace)).length;
            if (outside) notes.push(`${outside} of ${urls.length} flows are in another namespace, so they are not shown.`);
            if (failed > outside) notes.push(`${failed - outside} of ${urls.length} flows in the architecture could not be read from CALM Hub.`);
        }
        if (!flows.length) {
            try {
                flows = await listNamespaceFlows(namespace, architecture);
                if (flows.length && urls.length) notes.push(`Showing the ${flows.length} flows of namespace ${namespace} that use this architecture.`);
            } catch (error) {
                notes.push(`The flows of namespace ${namespace} could not be listed: ${error.message}`);
            }
        }
        if (!flows.length) notes.push('No flows found for this architecture, so no flow status is shown.');
        const value = { flows, notes };
        if (flows.length) {
            for (const [k, entry] of cache) if (entry.expires <= now()) cache.delete(k);
            cache.set(key, { value, expires: now() + cacheMs });
        }
        return value;
    }

    // [{ id, name }] of a namespace.
    async function listArchitectures(namespace) {
        const values = (await getJson(api(`${seg(namespace)}/architectures`)))?.values ?? [];
        return values.filter((v) => v && v.id !== undefined).map((v) => ({ id: String(v.id), name: typeof v.name === 'string' ? v.name : String(v.id) }));
    }

    return { getArchitecture, getFlows, listArchitectures, cacheSize: () => cache.size };
}
