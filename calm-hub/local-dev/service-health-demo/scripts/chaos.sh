#!/usr/bin/env bash
# Usage: chaos.sh <service> latency <ms> | errors <ratio> | reset | show
# Changes the simulated traffic of one service. It does not change the health flag (see toggle.sh).
set -euo pipefail

service="${1:-}"
action="${2:-show}"
value="${3:-}"

case "$service" in
  customer-portal) port=9101 ;;
  admin-console) port=9102 ;;
  api-gateway) port=9103 ;;
  auth-service) port=9104 ;;
  orders-api) port=9105 ;;
  payments-api) port=9106 ;;
  central-db) port=9107 ;;
  *) port="" ;;
esac

base="http://localhost:${port}"
case "$action" in
  latency) [[ -n "$value" ]] || port=""; method=POST; url="${base}/chaos/latency?ms=${value}" ;;
  errors) [[ -n "$value" ]] || port=""; method=POST; url="${base}/chaos/errors?ratio=${value}" ;;
  reset) method=POST; url="${base}/chaos/reset" ;;
  show) method=GET; url="${base}/chaos" ;;
  *) port="" ;;
esac

if [[ -z "$port" ]]; then
  echo "Usage: $0 <customer-portal|admin-console|api-gateway|auth-service|orders-api|payments-api|central-db> latency <ms> | errors <0..1> | reset | show" >&2
  exit 2
fi

curl -fsS -X "$method" "$url"
echo
