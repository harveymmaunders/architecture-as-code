---
id: service-health
title: Service Health
sidebar_label: Service health (proposed)
---

# Service Health

:::caution Proposed extension
Service health is a proposal. Its code is a local demo in
[`calm-hub/local-dev/service-health-demo`](https://github.com/finos/architecture-as-code/tree/main/calm-hub/local-dev/service-health-demo).
No image is published, and the demo is not safe for production. This page is the plan to set it up
in an organisation. [Security considerations](#security-considerations) lists the work that is still open.
:::

Shows the live health of the services in an architecture: an incident badge on the node that is
down, the flows that it breaks, and the errors of each flow. It reads health from Prometheus and,
optionally, flow runs from Tempo traces.

## What it does

| View | For | Shows |
|:--|:--|:--|
| **Service health** on the normal diagram (`decorator-views`) | Everyone | A green **Healthy** badge on each node, and one incident badge on the node that is down: since when, and the services it affects. A resolved incident leaves the diagram and stays in the **Decorators** tab with its end time. The legend toggle **Service health** hides the badges |
| **Overview** tab | A director: "what is impacted?" | One headline, the affected flows (critical first) and "n flows working". When all is healthy: "All n flows working" |
| **Flow status** tab | An engineer | Each flow, its starting node, and its errors and successes in the traces of the last 15 minutes. **Show trace links** opens the same table as a screen, with links to the last failure or last run in Grafana, the failing traces, and **Try it** |
| **Failure Simulation** lens (`diagram-lens`) | An architect | Click a node to fail or restore it. The lens shows the impacted nodes, the broken edges and every flow, affected or not. **Reset** clears it. No live data |
| Home page card | Everyone | Services down and flows affected, across `HEALTH_NAMESPACES` |

A node is **down** when Prometheus `up` or `service_health_status` is `0`, or has no series. It is
in **warning** when its error ratio is over 5% or its p95 latency is over 500 ms. It is **impacted**
when it depends, through `connects`, on a down node. A flow is **broken** when a step goes from or to
a down node, and **degraded** when a step touches a node in warning or its runs fail in the traces
(see [Traces](#traces)). Trace errors count per flow, never per node. The **starting node** of a
flow is the source of its first transition.

## How it works

```text
User ── CALM Hub ── route call + identity assertion ──► service-health backend ──► Prometheus
                                                         │  reads architectures and flows (service account)
                                                         └► writes incident decorators ──► CALM Hub
```

| Data | From | To | With the access of |
|:--|:--|:--|:--|
| Architecture and flows for every view | CALM Hub REST API | Backend | The backend service account |
| Health and RED metrics | Prometheus HTTP API | Backend | The backend credential for Prometheus |
| Flow runs and failures (optional) | Tempo HTTP API (TraceQL) | Backend | The backend credential for Tempo |
| Incident decorators | Backend (publisher) | CALM Hub decorator API | The backend service account |

The tab, lens and card routes are `GET`, so CALM Hub sends no data to them. Thus the backend reads
CALM Hub itself. The publisher runs on a timer. When a node is down as a root cause for
`INCIDENT_MIN_DOWN_MS`, it writes one `service-health` decorator for the incident on that node, with
`status: down`, `started`, `affected` and a `summary`. On recovery it sets `status: resolved` and
`ended`. The decorator view hides `resolved`, so the badge leaves the diagram, and the decorator
stays as the record. CALM Hub reads decorators again every 5 seconds while a diagram is open, so the
diagram updates with no user action. The tabs reload when the user opens them again.

The publisher also writes one baseline decorator for each architecture version, on all nodes, with
`status: healthy`. It gives the green badges and keeps the legend toggle when no incident is open.
It writes the baseline again only when the node set changes. Its `node` key is `*`, so it never hides
an incident, and an incident (`error`) is worse than `ok`, so the node shows the incident.

Earlier versions of the demo wrote a decorator for each element, and a what-if type. A delete needs
global admin, so at start-up the publisher moves each of them to a `…/retired` target with
`status: retired`, once.

## Prerequisites

| Item | Detail |
|:--|:--|
| CALM Hub | A version with decorator views and diagram lenses, in a secured auth mode (`secure`, `oidc` or `proxy-auth`) |
| Metrics store | Prometheus-compatible HTTP API. Each service needs `up` and `service_health_status`. For warnings: `service_http_requests_total` and `service_request_duration_seconds` |
| Node to job map | `metadata.prometheus-job` on each node. With no value, the node `unique-id` is the job |
| Flows | In CALM Hub, in the same namespace as the architecture. Inline flows also work |
| Flow criticality (optional) | `criticality` (`critical`, `high` or `normal`) on the flow or in its metadata. Summaries put critical flows first |

A service that has no `service_health_status` series shows as down. Add that gauge, or change the
query in `prometheus.mjs`, before you connect real services.

## Install

Run the backend as a **sidecar** of CALM Hub. A hosted service does not fit: the backend needs a
service account in your CALM Hub, a route to your metrics store, and it keeps data. As a sidecar,
CALM Hub calls it on `localhost`, so `allow-http` is not necessary. See
[Install an extension](install.md#kubernetes) for the pod layout.

1. Put the folder `extensions/service-health/` (`extension.json` and the lens `notation.json`) in `calm.extensions.dir`.
2. Configure CALM Hub, then restart it. CALM Hub reads the folder only at start-up.

```properties
calm.extensions.dir=/extensions
calm.extensions.service-health.backend-url=http://localhost:8095
# The issuer that the backend expects in CALM_HUB_ISSUER
calm.hub.base-url=https://calm-hub.example.com
calm.extensions.identity.private-key-location=/secrets/hub-private.pem
calm.extensions.identity.public-key-locations=/secrets/hub-public.pem
```

Every route is `GET` and `readOnly`, so CALM Hub allows `send-identity=false`. Keep the assertion on:
the backend reads CALM Hub with its own account, and the `ns` claim limits each call to a namespace
that CALM Hub checked for the user. Set
`allow-http=true` only for a plain `http` backend on a trusted network. Never set
`calm.extensions.allow-without-auth` outside a local machine. See [Extensions](../calm-hub/index.md#extensions)
and [Identity keys](../calm-hub/index.md#identity-keys).

| Backend variable | Default | Use |
|:--|:--|:--|
| `HOST`, `PORT` | `0.0.0.0`, `8095` | Listen address and port. Set `HOST=127.0.0.1` for a sidecar |
| `HUB_TOKEN` | not set | Service-account bearer token. When set, the Hub client and the publisher send `Authorization: Bearer <token>` on each CALM Hub call |
| `CALM_HUB_URL` | `http://hub:8080` | CALM Hub REST API and JWKS |
| `CALM_HUB_ISSUER` | `http://localhost:8080` | The `iss` that CALM Hub signs: its `calm.hub.base-url` |
| `VERIFY_IDENTITY` | `true` | Keep `true`. `false` is for local tests only |
| `PROMETHEUS_URL` | `http://prometheus:9090` | Prometheus HTTP API |
| `HEALTH_NAMESPACES` | `service-health-demo` | The namespaces of the screen, the card and the publisher |
| `PUBLISH_DECORATORS`, `PUBLISH_INTERVAL_MS` | `true`, `10000` | Turn the publisher on or off, and how often it checks |
| `INCIDENT_MIN_DOWN_MS` | `15000` | How long a node must be down before an incident opens, so a restart opens none |
| `WARN_ERROR_RATIO`, `WARN_P95_MS` | `0.05`, `500` | Warning thresholds |
| `TEMPO_URL` | not set | Tempo HTTP API. Not set: no flow errors |
| `WARN_TRACE_ERROR_RATIO`, `MIN_TRACES` | `0.05`, `5` | The trace rule: the failed share of runs of a flow, and the fewest runs, in the last 5 minutes |
| `GRAFANA_URL` | `http://localhost:3000` | The Grafana origin, as the browser sees it: dashboard and trace links |
| `FLOW_CACHE_MS` | `15000` | How long to keep the flows of an architecture |

## Authentication and authorisation

### The identity assertion

CALM Hub sends a signed JWT in `X-Calm-Hub-Identity` with each call. The backend checks it on each
call (`identity.mjs`): `typ`, algorithm and signature, `iss` = `CALM_HUB_ISSUER`, `aud` =
`service-health`, expiry, `htm` and `htp`, `bdh` (the body hash), and a used-once `jti`. It gets the
keys only from `CALM_HUB_URL`, never from a URL in the request. A route with `{namespace}` must have
`ns` equal to the path namespace, else the backend returns `403`. See
[Verify it](../calm-hub/extension-access.md#verify-it).

### Route scopes

| Route | Scope | Why |
|:--|:--|:--|
| `tab`, `flow-status`, `lens` | `read` | Health shows the structure of the architecture, so the user must read the namespace |
| `screen`, `card` | `authenticated` | No namespace in the path, so CALM Hub checks no namespace. They serve only `HEALTH_NAMESPACES` |

With `calm.auth.allow-public-read=true`, each signed-in user reads every namespace, so `read` gives
little protection.

### The backend service account

CALM Hub refuses its own assertion as a credential. The backend needs its own account:

| Job | Grant |
|:--|:--|
| Read architectures and flows | `read` on each namespace that it serves (and each parent namespace) |
| Write `service-health` decorators | `write` on each namespace in `HEALTH_NAMESPACES` |

| Hub auth mode | How the account signs in | Principal for the grant |
|:--|:--|:--|
| `secure` / `oidc` | A bearer token from your IdP, for example OAuth client credentials, in `HUB_TOKEN`. The token audience must be `CALM_OIDC_CLIENT_ID` | The value of the `CALM_OIDC_USERNAME_CLAIM` claim (default `preferred_username`) |
| `proxy-auth` | The proxy signs the account in and sets `Remote-User`. The backend must call through the proxy | The `Remote-User` value. CALM Hub must not be reachable around the proxy, because any direct caller can set that header |
| `no-auth` | None. Each caller is a global admin | Local only |

Grant with `POST /api/calm/namespaces/{ns}/user-access` and `{"username": "<principal>", "permission": "read"}`,
or in the admin UI. See [CALM Hub Entitlements](../working-with-calm/calm-hub-entitlements.md).

### Reserve the decorator type

Reserve the type, so that only the backend can write incident badges:

```properties
calm.decorators.reserved."service-health".writers=<service-account-principal>
```

The cost: a reserved type is append-only. Each change stores a full copy (an incident has two or
three: opened, affected services changed, resolved), and in MongoDB all
decorators of a namespace share one 16 MB document. At the limit, each decorator write in that
namespace fails with `413`. Plan retention: a global admin deletes old histories with
`DELETE .../decorators/{id}`. Before you reserve the type, delete `service-health` decorators that
other principals wrote. See [Decorator Write Rules](../calm-hub/mcp-and-api.md#decorator-write-rules).

### Credentials for the metrics store

The demo reads Prometheus with no credential. Production needs one of these, from a mounted secret,
never from the manifest (CALM Hub shows the manifest to each signed-in user):

| Store | Credential |
|:--|:--|
| Prometheus behind a proxy | `Authorization: Bearer <token>` or basic auth |
| Service mesh or internal PKI | mTLS: client certificate, key and CA bundle |
| Grafana Mimir or Cortex | `X-Scope-OrgID: <tenant>`. One tenant for each namespace also limits which jobs a namespace can read |

## Security considerations

| Risk | Mitigation | Demo |
|:--|:--|:--|
| Hub runs `no-auth` with `allow-without-auth=true`: each caller is a global admin | Use `secure`, `oidc` or `proxy-auth` | Open |
| A caller goes around CALM Hub to the backend | Verify the assertion on each call; do not publish the port | Fixed |
| A path names a namespace that CALM Hub did not check | Refuse when `ns` is not the path namespace (`403`) | Fixed |
| An architecture points at flows in another namespace | Follow only flow URLs in the architecture namespace, always on `CALM_HUB_URL` | Fixed |
| The backend reads with its own access, not the user's | Read only inside the checked `ns`; give the account no more grants than it needs | Partly fixed |
| `screen` and `card` show `HEALTH_NAMESPACES` to each signed-in user | List only namespaces that all signed-in users may read | Open |
| `prometheus-job` metadata can name another team's job | Allow-list jobs for each namespace, or one metrics tenant for each namespace | Open |
| Without a token the Hub client and publisher send no credentials, and the type is not reserved: any namespace writer can forge badges | Set `HUB_TOKEN` to a service-account token; reserve the decorator type | Settable (`HUB_TOKEN`); type not reserved |
| Plain `http` with `allow-http=true` on the Docker network | Sidecar on `localhost`, or `https` | Open |
| The backend listens on all interfaces by default | Set `HOST=127.0.0.1` in a sidecar | Settable (`HOST`); demo uses `0.0.0.0` |
| Prometheus is open; Grafana has anonymous Viewer | Put authentication in front of both | Open |
| The identity private key is in a shared volume with mode `0644` | A secrets manager or Kubernetes Secret, mode `0600` | Open |
| Two backends would each open the same incident | Run one publisher (or use leader election) | Open |

## Health sources

Prometheus is the first source, and Mimir, Cortex and Thanos use the same queries. Other sources fit
behind the same model, and the worst status wins:

- **Alerts.** A firing alert is often a better "down" signal than a raw metric, because on-call
  teams already tune it. The `ALERTS{alertstate="firing"}` series works with the current queries.
  Alertmanager also shows silences, so planned work can show as "silenced".
- **OpenTelemetry.** Set `service.name` to the node `unique-id`. Service graph metrics then give the
  health of each `connects` edge, and show edges that the architecture does not declare.

## Traces

Traces are an optional source (`TEMPO_URL`). A health check says that a service runs; a trace says
that a flow works. The demo marks each span with the CALM ids (`calm.flow.slug`,
`calm.relationship.unique-id`, `calm.failure.node`), so a failed run maps to a flow and its step.

| Adds | Rule |
|:--|:--|
| Errors and successes of each flow | **Flow status**: the runs of the last 15 minutes |
| Degraded flow | Healthy by metrics, but at least `MIN_TRACES` runs in 5 minutes with `WARN_TRACE_ERROR_RATIO` or more failed, the last one in 2 minutes |
| Links | The trace links screen: the last failure or last run, the failing traces in Grafana, and **Try it** |

If Tempo cannot be read, the views show no counts and a short note; nothing else changes.
In production, use the same credential rules for Tempo as for the metrics store.

## Try it locally

The [demo README](https://github.com/finos/architecture-as-code/tree/main/calm-hub/local-dev/service-health-demo#readme)
starts CALM Hub, seven mock services, Prometheus, Tempo, Grafana and the extension in Docker, and
has commands to break services. The
[backend README](https://github.com/finos/architecture-as-code/tree/main/calm-hub/local-dev/service-health-demo/extension-service)
lists its routes and variables.
