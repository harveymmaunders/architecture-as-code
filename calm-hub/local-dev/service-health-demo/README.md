# Service health demo

A local demo of a CALM Hub extension that shows live service health on an architecture. It runs in
Docker: CALM Hub, seven mock services, Prometheus, Tempo, Grafana and the `service-health`
extension. A flow driver runs every CALM flow as real calls between the mock services every 15
seconds, so Tempo always has traces.

> **Warning:** CALM Hub runs the no-auth profile. Use this demo only on your own machine.

## Prerequisites

- Docker with Compose, Node 26 and Java (for the Maven build).
- The ports 8080, 9090, 3000, 3200, 27017 and 9101–9107 are free.

## Build

The stack builds CALM Hub from source, because the demo needs the newest extension points
(decorator views and forms). From the repository root:

```bash
npm ci && ./mvnw -B -pl calm-hub -am package -DskipTests
git checkout -- package-lock.json   # the Maven build runs npm install, which changes it
```

This makes the Hub jar, the UI and the meta-schemas that MongoDB loads.

## Start, seed and stop

From this folder:

```bash
docker compose up -d --build     # the whole stack, one compose file
architecture/seed.sh             # namespace, 20 flows and the architecture; prints the UI link
docker compose down              # stop; add -v to also delete the data
scripts/generate-traces.sh place-order 20   # optional: a burst of traces now
```

Prometheus and Tempo keep their data in named volumes, so a recreate keeps the history.

`seed.sh` adds version `1.0.0`, and version `1.1.0` with owners, on-call, runbooks and flow
criticality. The links below use `1.1.0`.

Hub reads the extensions folder only at start-up. If you change `extensions/service-health/`, run
`docker compose restart calmhub`.

## Links

Hub gives the architecture a numeric id. `seed.sh` prints it. The links below use `12`.

| What | URL |
|---|---|
| Diagram with live health | <http://localhost:8080/#/service-health-demo/architectures/12/1.1.0> |
| Overview tab | <http://localhost:8080/#/service-health-demo/architectures/12/1.1.0?extension=service-health> |
| A node selected (then choose **Service detail** in the view menu) | <http://localhost:8080/#/service-health-demo/architectures/12/1.1.0?node=orders-api&extension=service-health> |
| Flow health, all architectures | <http://localhost:8080/#/extensions/service-health/flows> |
| Flows of the architecture | <http://localhost:8080/#/extensions/service-health/flows?namespace=service-health-demo&resourceType=architectures&resourceId=12&version=1.1.0> |
| One flow | <http://localhost:8080/#/extensions/service-health/flows?namespace=service-health-demo&resourceType=architectures&resourceId=12&version=1.1.0&flow=place-order> |
| Home page, with the card | <http://localhost:8080/#/> |
| Grafana dashboard | <http://localhost:3000/d/service-health/service-health> |
| Grafana, one service | <http://localhost:3000/d/service-detail/service-detail?var-service=orders-api> |
| Grafana, flow traces | <http://localhost:3000/d/flow-traces> |
| Customer portal UI (runs its flows) | <http://localhost:9101> |
| Admin console UI (runs its flows) | <http://localhost:9102> |
| Prometheus | <http://localhost:9090> |
| Tempo API | <http://localhost:3200> |

The tab and the panel are in **Details & extensions** at the right of the diagram. The view menu at
the top of that drawer switches between **Overview** and **Service detail**.

The two UIs list the flows that start at them. `?flow=<slug>&run=1` runs one on load: this is the
**Try it** link of the flow screen. Flows that start at a service (`gateway-key-refresh`,
`order-payment-sync`) have no UI, so no **Try it**.

## 5-minute walkthrough

1. Open the diagram. All nodes have a green **Healthy** badge.
2. Break a service: `scripts/toggle.sh orders-api down`. Within about 15 seconds, with no reload,
   Orders API turns red, the nodes that call it turn amber, and the edges to it turn red. Click a red
   edge: its details list the broken flows.
3. Open **Details & extensions**. The **Overview** tab gives one headline (root cause, services
   affected, flows broken) and lists only what is not healthy.
4. Click **Place Order** in the tab. The flow screen shows each step; steps 3 to 5 fail, and the
   traces of the last 15 minutes show the failed runs. Click **Orders API** in a step to go back to
   the diagram with that node selected.
5. Repair: `scripts/toggle.sh orders-api up`. The diagram goes green again by itself.
6. Up, but failing: `scripts/chaos.sh payments-api errors 0.3`. The health check still passes, but
   within about a minute Payments API and the edges into it turn amber: **failing traces**. Select
   it and choose **Service detail**: the status gives the trace evidence, and **Failing traces**
   opens those traces in Grafana. Reset with `scripts/chaos.sh payments-api reset`.
7. Open the **Place Order** flow screen again. **Try it** opens the customer portal and runs the
   flow for real; **View trace** opens the last run in Grafana.
8. What-if: select **Payments API**, and in **Service detail** send **What-if: fail this service**.
   In the diagram legend, tick **What-if** on and **Service health** off: the diagram shows what
   would break. The tab says how many more flows would break. **Clear what-if** in the tab ends it.

## Break things

| Action | Command |
|---|---|
| Fail a health check (the process stays up) | `scripts/toggle.sh orders-api down`, then `up` |
| Stop a service (Prometheus `up` is 0) | `docker compose stop central-db`, then `docker compose start central-db` |
| Slow a service (warning above p95 500 ms) | `scripts/chaos.sh orders-api latency 800` |
| Make a service fail requests (warning above 5% errors) | `scripts/chaos.sh orders-api errors 0.2` |
| Clear latency and errors | `scripts/chaos.sh orders-api reset` |
| Stop Prometheus (all statuses unknown) | `docker compose stop prometheus` |
| Stop Tempo (no trace evidence; all else works) | `docker compose stop tempo` |
| Run flows now, for traces | `scripts/generate-traces.sh [flow-slug\|all] [count]` |
| Show each service: state, requests/s, error %, p95 ms | `scripts/status.sh` |

Prometheus scrapes every 5 seconds, the backend checks every 5 seconds, and Hub reads the badges
every 5 seconds. Reload the tab or panel for new figures: Hub does not refresh them on a timer. A
service that comes back up shows a warning for about a minute, because its error ratio still counts
the failed requests.

## What the extension shows

| Contribution | Shows |
|---|---|
| **Service health** badges on the diagram (`decorator-views`) | Live. Red, amber and green badges; red edges on the paths to a failure, with the broken flows |
| **What-if** badges on the diagram (`decorator-views`) | What would break if the chosen services failed. Shown only while a what-if is set |
| **Overview** tab | One headline, and only the services and flows that need attention. When all is healthy, the critical flows |
| **Service detail** panel | Status, traffic, trace evidence with a **Failing traces** link, dependencies, every flow that uses the service, owner, on-call, runbook, Grafana. The what-if form |
| **Flow health** screen | All architectures; the flows of one; the steps of one flow, its traces (runs, failures, failing step), **Try it**, **View trace**, and the other flows on its failing steps |
| Home page card | Services down, broken flows and critical flows broken, across `HEALTH_NAMESPACES` |
| **What-if: fail this service**, **Clear what-if** forms | Change the what-if of the architecture. Kept in memory and shared by all viewers: a backend restart clears it |

Each status has an icon as well as a colour: ✕ down or broken, ⚠ warning, impacted or degraded,
✓ healthy, ? unknown.

| Status | Rule |
|---|---|
| Down | Prometheus `up` is 0, `service_health_status` is 0, or there is no series |
| Root cause | Down, and none of the nodes it depends on is down |
| Warning | Up, but the error ratio is over 5% or p95 is over 500 ms in the last minute, or 5% or more of the calls to it failed in traces in the last 5 minutes (at least 5 calls, the last failure in 2 minutes) |
| Impacted | Not down, and it depends (through `connects`, transitively) on a down node |
| Healthy / Unknown | Otherwise / Prometheus cannot be reached |
| Broken flow | A step goes from or to a down node |
| Degraded flow | Not broken, and a step goes from or to a node in warning, or its runs fail in traces by the same rule |
| Warning edge | Not broken, and its calls fail in traces by the same rule |

Example: with `central-db` stopped and `auth-service` down, `central-db` is the root cause,
`auth-service` is caused by it, and all 20 flows are broken (4 critical).

## Identity

The what-if forms write, so Hub must send its identity assertion (`send-identity` stays on). The backend
checks each call with Hub's public keys, and refuses a namespace that Hub did not check. Its port is
not published, so only Hub can call it.

## Folder layout

| Path | Contents |
|---|---|
| `docker-compose.yml` | The whole stack, with Tempo and the flow driver |
| `mock-service/` | The mock service, its UI pages and the flow driver. One image |
| `prometheus/`, `grafana/` | Scrape configuration, Tempo configuration, data sources and dashboards |
| `architecture/` | The CALM architecture, flows and seed script. See [its README](architecture/README.md) |
| `extensions/service-health/` | The extension manifest. Hub mounts this folder |
| `extension-service/` | The extension backend. See [its README](extension-service/README.md) |
| `scripts/` | `toggle.sh`, `chaos.sh`, `status.sh` and `generate-traces.sh` |
