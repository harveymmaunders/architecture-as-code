# Service health demo: architecture and flows

- `service-health.architecture.json`: seven nodes and ten `connects` relationships (CALM 1.3).
  Each node has `metadata` with `prometheus-job`, `owner`, `oncall`, `runbook` (placeholder URL) and `tier`.
- `flows/*.flow.json`: 20 CALM flows over those relationships. Each has `metadata.criticality`
  (`critical`, `high` or `normal`). The flow schema refuses unknown top-level keys, so it is in `metadata`.
- `seed.sh`: puts the namespace `service-health-demo`, the flows and the architecture (version
  `1.1.0`) into a running CALM Hub. Set `CALM_HUB_URL` (default `http://localhost:8080`) and, if the
  Hub's `calm.hub.base-url` differs, `CALM_HUB_BASE_URL`. A second run skips what exists.

The CALM 1.3 `flows` property holds only inline flow objects, not links. So the architecture lists
the Hub URLs of its flows in `metadata.flows`. Each flow `$id` is its name-based Hub URL, for example
`/calm/namespaces/service-health-demo/flows/customer-login/versions/1.1.0`.

Version `1.1.0` added the node metadata and the flow criticality. Version `1.0.0` (without them) is
not kept here: a Hub seeded before still has it, and a fresh Hub gets only `1.1.0`.

Validate with the `calm` CLI: `calm validate -a service-health.architecture.json`. To check the
flows too, put them (without `$schema` and `$id`) in the architecture's `flows` array in a temporary
copy and validate that copy.

| Flow | Criticality | Nodes touched |
|---|---|---|
| `customer-login` | critical | customer-portal, api-gateway, auth-service, central-db |
| `customer-token-refresh` | high | customer-portal, api-gateway, auth-service |
| `browse-catalogue` | high | customer-portal, api-gateway, orders-api, central-db |
| `place-order` | critical | customer-portal, api-gateway, auth-service, orders-api, payments-api, central-db |
| `pay-for-order` | critical | customer-portal, api-gateway, auth-service, payments-api, central-db |
| `view-order-history` | normal | customer-portal, api-gateway, auth-service, orders-api, central-db |
| `order-status-polling` | normal | customer-portal, api-gateway, orders-api, central-db |
| `cancel-order` | high | customer-portal, api-gateway, auth-service, orders-api, payments-api, central-db |
| `request-refund` | high | customer-portal, api-gateway, auth-service, payments-api, central-db |
| `manage-saved-cards` | high | customer-portal, api-gateway, payments-api, central-db |
| `download-invoice` | normal | customer-portal, api-gateway, auth-service, orders-api, payments-api, central-db |
| `admin-login` | high | admin-console, auth-service, central-db |
| `admin-user-management` | normal | admin-console, auth-service, central-db |
| `admin-cert-rotation` | normal | admin-console, auth-service, central-db |
| `admin-session-check` | normal | admin-console, auth-service |
| `admin-order-search` | normal | admin-console, api-gateway, auth-service, orders-api, central-db |
| `admin-issue-refund` | high | admin-console, api-gateway, auth-service, payments-api, central-db |
| `payment-reconciliation` | normal | admin-console, api-gateway, orders-api, payments-api, central-db |
| `gateway-key-refresh` | high | api-gateway, auth-service |
| `order-payment-sync` | critical | orders-api, payments-api, central-db |
