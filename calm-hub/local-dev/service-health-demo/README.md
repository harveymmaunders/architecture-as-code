# Service health demo

A local demo of the `service-health` CALM Hub extension. It shows live service health on a CALM
architecture, which flows a failure affects, and the traces of each flow. It runs in Docker: CALM
Hub, seven mock services, Prometheus, Tempo, Grafana and the extension backend. A flow driver runs
all 20 CALM flows as real calls every 15 seconds, so Tempo always has traces.

> **Warning:** CALM Hub runs the no-auth profile. Use this demo only on your own machine.

How the extension works, and how to run it in production:
[docs/docs/extensions/service-health.md](../../../docs/docs/extensions/service-health.md). The
backend: [extension-service/README.md](extension-service/README.md).

## Run it

You need Docker with Compose, Node 26, Java 21, and free ports 8080, 3000, 3200, 9090, 27017 and
9101–9107. The stack builds CALM Hub from source, so build it first, from the repository root:

```bash
npm ci && ./mvnw -B -pl calm-hub -am package -DskipTests
git checkout -- package-lock.json   # the Maven build runs npm install, which changes the lockfile
```

Then, from this folder:

```bash
docker compose up -d --build   # the whole stack
architecture/seed.sh           # namespace, 20 flows, architecture 1.1.0; prints the UI link
```

`seed.sh` is safe to run again. It prints the numeric id that Hub gave the architecture. The links
below use `12`: replace it with your id.

| Action | Command |
|---|---|
| Stop, keep all data | `docker compose stop`, then `docker compose start` |
| Remove the stack | `docker compose down` (add `-v` to delete the Prometheus and Tempo history). Run `seed.sh` again after the next `up`: Hub starts empty |
| Apply a change to `extensions/service-health/` | `docker compose restart calmhub` (Hub reads extensions only at start-up) |
| Apply a change to `extension-service/` | `docker compose up -d --build --no-deps service-health` |

## Links

| What | URL |
|---|---|
| Diagram (incident badges) | <http://localhost:8080/#/service-health-demo/architectures/12/1.1.0> |
| Overview tab open | <http://localhost:8080/#/service-health-demo/architectures/12/1.1.0?extension=service-health> |
| Flow status with trace links | <http://localhost:8080/#/extensions/service-health/flows?namespace=service-health-demo&resourceType=architectures&resourceId=12&version=1.1.0> |
| Failure Simulation | <http://localhost:8080/#/service-health-demo/architectures/12/1.1.0?lens=simulation> |
| Decorators tab | <http://localhost:8080/#/service-health-demo/architectures/12/1.1.0?tab=decorators&type=service-health> |
| Hub home page (card) | <http://localhost:8080/#/> |
| **Control panel** | <http://localhost:9101/control> |
| Customer portal, admin console | <http://localhost:9101>, <http://localhost:9102> |
| Grafana | [service-health](http://localhost:3000/d/service-health/service-health), [service-detail](http://localhost:3000/d/service-detail/service-detail?var-service=orders-api), [flow-traces](http://localhost:3000/d/flow-traces/flow-traces) |

The **Overview** and **Flow status** tabs are in **Details & extensions** at the right of the
diagram. The menu at the top of that drawer switches between them. The diagram badges update by
themselves every 5 s. The tabs do not: open them again for new figures.

## Demo script

Use the control panel for all changes. Keep it open in a second window. Before you start, click
**Reset all** and wait 2 minutes, so no earlier failure shows. Flow status counts the traces of the
last 15 minutes, so earlier errors stay there that long.

| Control panel | Script equivalent |
|---|---|
| **Down** / **Up** on a row | `scripts/toggle.sh orders-api down` / `up` |
| Error rate **30%** | `scripts/chaos.sh payments-api errors 0.3` |
| Added latency **800** | `scripts/chaos.sh payments-api latency 800` |
| **Run a flow**, 20 runs | `scripts/generate-traces.sh place-order 20` |
| **Reset all** | `curl -X POST http://localhost:9101/control/api/reset` |
| Observed column | `scripts/status.sh` |

### 1. Everything works

| Do | The audience sees | Say |
|---|---|---|
| Open the diagram | A green **Healthy** badge on all 7 nodes. Legend: **Service health · 7 OK** | "Hub draws live health from a decorator. No custom UI code runs in Hub." |
| Untick, then tick **Service health** in the legend | The badges go, then come back | "Each overlay is a layer that you can switch off." |
| Open **Details & extensions** → **Overview** | "✓ All 20 flows working" | "The director view: one line." |
| Switch the drawer menu to **Flow status** | Each flow, "· starts at Customer Portal", red errors and green successes from traces | "The engineer view: traces mapped to CALM flows." |
| Open Hub home | **Service health** card: 0 services down, 0 flows affected | "The same data on the landing page." |
| Open Grafana **service-health**, then **flow-traces** | All UP; flow runs, edge error ratios, the service graph | "Same data, the usual tool." |
| Open the customer portal, click **Run** on **Place Order** | "✓ Flow succeeded", each step, **View trace** | "The flows are real calls, so each run is a trace." |

### 2. A degraded service

| Do | The audience sees | Say |
|---|---|---|
| Control panel: **Payments API** error rate **30%** and latency **800** | Observed: errors ~30%, p95 ~975 ms, in red | "Payments is up, but slow and failing some calls." |
| Wait 30–60 s. Open **Overview** again | "⚠ 9 flows degraded (3 critical) — payments-api slow and erroring", the flows, "11 flows working" | "No outage, but the director sees what is at risk." |
| **Flow status** | The payment flows get red error counts within 1–2 min | "Errors belong to flows, not to boxes." |
| **Show trace links** | The same table as a page, with **Last failure**, **Failing traces** and **Try it** | "From a flow to its failing traces in one click." |
| **Last failure** | Grafana Explore: the trace, step 3 `api-gateway → payments-api` in red | "The exact failed call." |
| Control panel: error rate **0%**, latency **0** | Overview clears in ~1 min; a flow with recent trace failures stays degraded up to 2 min | |

The diagram shows no badge change here: badges are for incidents (a service down).

### 3. A failure and its recovery

| Do | The audience sees | Say |
|---|---|---|
| Control panel: **Orders API** → **Down** | Row turns red | "Orders API fails its health check." |
| Wait ~25 s on the diagram (no reload) | Orders API: red **Down** badge. Legend: 1 Error, 6 OK | "An incident opens after 15 s down, so a restart is not an incident." |
| Click the red badge | "Down since 16:28 · affects Customer Portal, Admin Console, API Gateway" | "When it started, and who it hurts." |
| **Overview** | "✕ 9 flows affected (2 critical) — orders-api down since 16:28", critical first. Flows with recent trace failures add to the count as degraded | "The director's answer." |
| Hub home | Card: 1 service down, 9 flows affected (broken) | |
| Control panel: **Run a flow**, **Place Order**, 20 runs | "0 succeeded, 20 failed", "×20 Step 3 api-gateway → orders-api: orders-api replied 503" | "Real traffic fails at the step the diagram predicts." |
| **Last failed trace** (trace is in Tempo after 10–30 s) | The Grafana trace, red from step 3 | |
| **Flow status** | Place Order and the other order flows at the top, with errors | |
| Control panel: **Orders API** → **Up**; wait ~10 s | The red badge goes, all nodes green | "Recovery needs no clean-up." |
| Open the **Decorators** tab | The incident with `status: resolved`, `started`, `ended`, `affected`, "Down 16:28–16:30 · affected …", and the baseline | "The incident record stays in Hub." |

### 4. Failure Simulation

| Do | The audience sees | Say |
|---|---|---|
| Diagram menu → **Failure Simulation** | The architecture, no live data, all 20 flows "✓ No" | "The developer and architect view: what if?" |
| Click **Orders API** | It turns red, its callers amber, broken edges red. "Failing: Orders API — 9 flows broken (2 critical)" | "Test a change before it happens." |
| Click **Auth Service** too | 19 flows broken (4 critical) | "Two failures together." |
| Click a red node, or **Reset** | That node, or all, restored | |

The simulation is only in the URL (`fail=…`). It changes nothing in Hub or in the services. The
lens shows no live data, so Hub says "Service health: 7 decorated elements are not shown". Do not
untick the legend here: the choice also hides the badges on the normal diagram.

### 5. Reset

Click **Reset all** in the control panel. Then go back to the normal diagram (the **Diagram** menu).

## Rules

| Item | Rule |
|---|---|
| Incident | A node down (Prometheus `up` 0 or its health check fails) as root cause for 15 s. One badge on that node, hidden on recovery |
| Broken flow | A step goes from or to a down node |
| Degraded flow | A step touches a node with error ratio > 5% or p95 > 500 ms (last minute), or 5% of its runs failed in traces (5 min, at least 5 runs) |
| Timings | Prometheus scrape 5 s, publisher 5 s, Hub badge refresh 5 s, Tempo traces 10–30 s |

## Layout

| Path | Contents |
|---|---|
| `docker-compose.yml` | The whole stack |
| `mock-service/` | The mock service, the portal pages, the control panel and the flow driver. One image |
| `extension-service/` | The extension backend. See [its README](extension-service/README.md) |
| `extensions/service-health/` | The extension manifest and lens notation. Hub mounts this folder |
| `architecture/` | The CALM architecture, 20 flows and `seed.sh`. See [its README](architecture/README.md) |
| `prometheus/`, `grafana/` | Scrape configuration, Tempo configuration, data sources and dashboards |
| `scripts/` | `toggle.sh`, `chaos.sh`, `status.sh`, `generate-traces.sh` |
