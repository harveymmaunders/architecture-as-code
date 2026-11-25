#!/usr/bin/env bash
# Usage: toggle.sh <service> up|down|toggle
set -euo pipefail

service="${1:-}"
action="${2:-toggle}"

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

case "$action" in
  up|down|toggle) ;;
  *) port="" ;;
esac

if [[ -z "$port" ]]; then
  echo "Usage: $0 <customer-portal|admin-console|api-gateway|auth-service|orders-api|payments-api|central-db> up|down|toggle" >&2
  exit 2
fi

curl -fsS -X POST "http://localhost:${port}/health/${action}"
echo
