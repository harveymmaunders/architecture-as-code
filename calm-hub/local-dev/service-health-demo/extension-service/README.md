# service-health extension service

The backend of the `service-health` CALM Hub extension (manifest in
[`../extensions/service-health`](../extensions/service-health)). It reads health and traffic from
Prometheus, failing traces from Tempo (optional), and architectures and flows from CALM Hub.

| Route | Contribution |
|---|---|
| `GET /tab/{namespace}/{resourceType}/{resourceId}` | **Overview** designer tab: the affected flows |
| `GET /flow-status/{namespace}/{resourceType}/{resourceId}` | **Flow status** designer tab: errors and successes of each flow, from traces |
| `GET /screen` | **Flow status** screen. With a context: the same table with trace links (**Show trace links**). No context: all architectures |
| `GET /lens/{namespace}/{resourceType}/{resourceId}` | **Failure Simulation** lens. Param `fail`: a comma list of node ids, or `none`. Each node link toggles that node |
| `GET /card` | Home page card: services down, flows affected |
| `GET /healthz` | Container health check, no identity |

The service also writes incident decorators to CALM Hub (`publisher.mjs`): one `service-health`
decorator per incident, on the node that is down, with `started`, `affected` and, on recovery,
`ended` and `status: resolved` (hidden on the diagram). It also writes one baseline decorator per
architecture version on all nodes (`status: healthy`, key `*`): the green badges and the legend
toggle when no incident is open. It rewrites the baseline only when the node set changes. At start-up it retires the per-element
decorators of earlier versions once: a delete needs global admin, so it moves them to a
`…/retired` target with `status: retired`.

| Module | Use |
|---|---|
| `analysis.mjs` | Node and flow status, root cause, the flow trace rule, simulation. No I/O |
| `prometheus.mjs`, `hub.mjs` | Reads. `hub.mjs` follows only flow URLs in the architecture's namespace |
| `traces.mjs` | Reads flow runs and failures from Tempo, with a 10 s cache. Never throws. Also the **Try it** link of a flow |
| `views.mjs`, `screen-view.mjs`, `simulation.mjs` | The replies. `present.mjs` holds the shared labels and links |
| `identity.mjs` | Checks Hub's identity assertion. A copy of `../../extensions/example-services/identity.mjs` |
| `decorators.mjs`, `publisher.mjs` | The incident decorators |

The lens notation is `../extensions/service-health/notation.json`.

## Identity

Every route is `GET` and `readOnly`, so Hub would allow `send-identity=false`. The demo keeps the
assertion on, as production should: the service checks it on each call with Hub's JWKS, and a route
with `{namespace}` also needs `ns` to be that namespace. The screen and card routes have no
namespace in the path, so they serve only `HEALTH_NAMESPACES`.

The service reads CALM Hub and Prometheus with its own access, not the user's. That is fine for the
open demo data, not for production.

| Variable | Default | Use |
|---|---|---|
| `HOST` | `0.0.0.0` | Listen address. `127.0.0.1` for a sidecar |
| `PORT` | `8095` | Listen port |
| `PROMETHEUS_URL` | `http://prometheus:9090` | Prometheus HTTP API |
| `CALM_HUB_URL` | `http://hub:8080` | CALM Hub REST API and JWKS |
| `HUB_TOKEN` | not set | Service-account bearer token, sent on each CALM Hub call (reads and decorator writes). Not needed on a no-auth Hub |
| `CALM_HUB_ISSUER` | `http://localhost:8080` | The `iss` that Hub signs with: `calm.hub.base-url` |
| `VERIFY_IDENTITY` | `true` | `false` skips the check. Local tests only |
| `HEALTH_NAMESPACES` | `service-health-demo` | Comma list: the screen, the card and the decorator publisher |
| `PUBLISH_DECORATORS` | `true` | `false` stops the decorator writes |
| `PUBLISH_INTERVAL_MS` | `10000` | How often the publisher checks for changes |
| `INCIDENT_MIN_DOWN_MS` | `15000` | How long a node must be down before an incident opens |
| `WARN_ERROR_RATIO`, `WARN_P95_MS` | `0.05`, `500` | Warn thresholds |
| `TEMPO_URL` | not set | Tempo HTTP API. Not set or not reachable: no flow counts, and nothing else changes |
| `WARN_TRACE_ERROR_RATIO` | `0.05` | A flow that is healthy by metrics is degraded when this share of its runs in the last 5 minutes failed in traces |
| `MIN_TRACES` | `5` | The fewest runs in the last 5 minutes for the trace rule |
| `TRACE_CACHE_MS` | `10000` | How long to keep a Tempo read |
| `GRAFANA_URL` | `http://localhost:3000` | Grafana origin, as the browser sees it. Dashboard and trace links |
| `FLOW_CACHE_MS` | `15000` | How long to keep the flows of an architecture |

## Test

The tests use `ajv` from the monorepo root `node_modules` to check the manifest and the replies
against the CALM Hub extension schemas.

```bash
cd calm-hub/local-dev/service-health-demo/extension-service
node --test test/*.test.mjs
```

To try the routes from the host, run the service without identity checks:

```bash
PORT=8096 VERIFY_IDENTITY=false PUBLISH_DECORATORS=false PROMETHEUS_URL=http://localhost:9090 \
  CALM_HUB_URL=http://localhost:8080 node server.mjs
curl 'http://localhost:8096/tab/service-health-demo/architectures/12'
```
