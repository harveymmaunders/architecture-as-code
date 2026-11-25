// Runs the CALM flows as real calls between the mock services, so Tempo has traces without clicks.
//   node flow-driver.mjs                  every FLOW_INTERVAL_MS, each flow once
//   node flow-driver.mjs <slug|all> [n]   n runs of one flow or all flows, then exit (burst)
import { pathToFileURL } from 'node:url';
import { loadFlows, runFlow, serviceUrlFromTemplate } from './flows.mjs';
import { createTracer } from './tracing.mjs';

export function pickFlows(flows, which = 'all') {
    if (which === 'all') return flows;
    const picked = flows.filter((flow) => flow.slug === which || flow.id === which);
    if (picked.length === 0) throw new Error(`no flow ${which}. Flows: ${flows.map((flow) => flow.slug).join(', ')}`);
    return picked;
}

const line = (result) => `${result.ok ? 'ok    ' : 'FAILED'} ${result.slug} trace=${result.traceId}`
    + (result.ok ? '' : ` step ${result.failedStep}: ${result.steps.find((s) => s.status === 'failed').reason}`);

export async function runAll(flows, options, log = console.log) {
    const results = [];
    for (const flow of flows) {
        const result = await runFlow(flow, options);
        log(line(result));
        results.push(result);
    }
    return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const env = process.env;
    const flows = await loadFlows(env.ARCHITECTURE_DIR ?? '/architecture');
    const tracer = createTracer({
        serviceName: 'flow-driver',
        resource: { 'service.namespace': 'service-health-demo' },
        endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
        onError: (error) => console.warn(`trace export failed: ${error.message}`),
    });
    const options = { tracer, serviceUrl: serviceUrlFromTemplate(env.SERVICE_URL_TEMPLATE || undefined), trigger: 'driver' };
    const [which, countArg] = process.argv.slice(2);
    if (which) {
        const count = Math.max(1, Number(countArg ?? 1) || 1);
        const picked = pickFlows(flows, which);
        let failed = 0;
        for (let i = 0; i < count; i += 1) failed += (await runAll(picked, options)).filter((r) => !r.ok).length;
        await tracer.flush();
        console.log(`${count * picked.length} flow runs, ${failed} failed`);
    } else {
        const intervalMs = Number(env.FLOW_INTERVAL_MS ?? 15_000);
        console.log(`flow driver: ${flows.length} flows every ${intervalMs} ms`);
        process.on('SIGTERM', () => tracer.flush().finally(() => process.exit(0)));
        for (;;) {
            await runAll(flows, options);
            await tracer.flush();
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
}
