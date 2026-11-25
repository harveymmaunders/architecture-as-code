#!/usr/bin/env bash
# Prints the state of each service from Prometheus, with the demo's down rule,
# and the simulated traffic over the last minute: requests/s, error % and p95 latency.
set -euo pipefail

PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"

PROMETHEUS_URL="$PROMETHEUS_URL" node --input-type=module -e '
const queries = {
  up: "min by (job) (up) * on(job) (min by (job) (service_health_status) or on(job) (min by (job) (up) * 0))",
  rps: "sum by (job) (rate(service_http_requests_total{path=\"/work\"}[1m]))",
  err: "(sum by (job) (rate(service_http_requests_total{path=\"/work\",code=~\"5..\"}[1m])) or sum by (job) (rate(service_http_requests_total{path=\"/work\"}[1m])) * 0) / sum by (job) (rate(service_http_requests_total{path=\"/work\"}[1m]))",
  p95: "histogram_quantile(0.95, sum by (job, le) (rate(service_request_duration_seconds_bucket[1m])))",
};
const query = async (q) => {
  const url = new URL("/api/v1/query", process.env.PROMETHEUS_URL);
  url.searchParams.set("query", q);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Prometheus returned HTTP ${res.status}`);
  return new Map((await res.json()).data.result.map((r) => [r.metric.job, Number(r.value[1])]));
};
try {
  const [up, rps, err, p95] = await Promise.all(Object.values(queries).map(query));
  const fmt = (v, f) => (v === undefined || Number.isNaN(v) ? "-" : f(v));
  console.log(`${"SERVICE".padEnd(16)} ${"STATE".padEnd(5)} ${"RPS".padStart(6)} ${"ERR%".padStart(6)} ${"P95MS".padStart(7)}`);
  for (const job of [...up.keys()].sort()) {
    console.log([
      job.padEnd(16),
      (up.get(job) === 1 ? "UP" : "DOWN").padEnd(5),
      fmt(rps.get(job), (v) => v.toFixed(1)).padStart(6),
      fmt(err.get(job), (v) => (v * 100).toFixed(1)).padStart(6),
      fmt(p95.get(job), (v) => (v * 1000).toFixed(0)).padStart(7),
    ].join(" "));
  }
} catch (e) {
  console.error(`ERROR: cannot read ${process.env.PROMETHEUS_URL}: ${e.message}`);
  process.exit(1);
}
'
