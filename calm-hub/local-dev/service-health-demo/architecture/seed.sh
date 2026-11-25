#!/usr/bin/env bash
# Seeds a running CALM Hub with the service-health-demo namespace, its flows and its architecture.
# Uses the name-based API (/calm/namespaces/...), so each document keeps a stable URL by slug.
# Safe to run again: existing versions return 409 and are skipped.
# Seeds only VERSION (the files in this folder). A Hub seeded before keeps its older versions.
#
# CALM_HUB_URL       where this script reaches the Hub (default http://localhost:8080)
# CALM_HUB_BASE_URL  the Hub's calm.hub.base-url, used in each $id (default CALM_HUB_URL)
set -euo pipefail

CALM_HUB_URL="${CALM_HUB_URL:-http://localhost:8080}"
CALM_HUB_URL="${CALM_HUB_URL%/}"
CALM_HUB_BASE_URL="${CALM_HUB_BASE_URL:-$CALM_HUB_URL}"
CALM_HUB_BASE_URL="${CALM_HUB_BASE_URL%/}"
NAMESPACE="service-health-demo"
VERSION="1.1.0"
ARCH_SLUG="service-health"
# The documents carry this base in $id and metadata.flows; it is replaced with CALM_HUB_BASE_URL.
DOC_BASE="http://localhost:8080"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for tool in curl node; do
    command -v "$tool" >/dev/null || { echo "ERROR: $tool is required" >&2; exit 1; }
done

if ! curl -sf -o /dev/null "$CALM_HUB_URL/api/calm/namespaces"; then
    echo "ERROR: CALM Hub is not reachable at $CALM_HUB_URL" >&2
    exit 1
fi

# post <url> <body-file> <label>: 200/201 created, 409 already there, else fail.
post() {
    local code
    code=$(curl -s -o "$resp" -w '%{http_code}' -X POST "$1" \
        -H 'Content-Type: application/json' --data-binary @"$2")
    case "$code" in
        200|201) echo "created  $3" ;;
        409)     echo "exists   $3" ;;
        *)       echo "ERROR: HTTP $code for $3: $(cat "$resp")" >&2; exit 1 ;;
    esac
}

# rebase <file>: prints the document with DOC_BASE replaced by CALM_HUB_BASE_URL.
rebase() {
    node -e 'const fs=require("fs");const [f,from,to]=process.argv.slice(1);
process.stdout.write(fs.readFileSync(f,"utf8").split(from+"/calm/namespaces/").join(to+"/calm/namespaces/"))' \
        "$1" "$DOC_BASE" "$CALM_HUB_BASE_URL"
}

body=$(mktemp)
resp=$(mktemp)
trap 'rm -f "$body" "$resp"' EXIT

node -e 'process.stdout.write(JSON.stringify({name: process.argv[1], description: "Service health demo: seven services and their flows"}))' \
    "$NAMESPACE" > "$body"
post "$CALM_HUB_URL/api/calm/namespaces" "$body" "namespace $NAMESPACE"

for flow in "$DIR"/flows/*.flow.json; do
    slug=$(basename "$flow" .flow.json)
    rebase "$flow" > "$body"
    post "$CALM_HUB_URL/calm/namespaces/$NAMESPACE/flows/$slug/versions/$VERSION" "$body" "flow $slug"
done

rebase "$DIR/service-health.architecture.json" > "$body"
post "$CALM_HUB_URL/calm/namespaces/$NAMESPACE/architectures/$ARCH_SLUG/versions/$VERSION" "$body" "architecture $ARCH_SLUG"

arch_id=$(curl -sf "$CALM_HUB_URL/calm/namespaces/$NAMESPACE/architectures" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
const m=(JSON.parse(s).values||[]).find(v=>v.customId===process.argv[1]||v.name===process.argv[1]);
process.stdout.write(m?String(m.numericId??m.id??""):"")})' "$ARCH_SLUG")

echo
echo "Architecture API: $CALM_HUB_URL/calm/namespaces/$NAMESPACE/architectures/$ARCH_SLUG/versions/$VERSION"
if [[ -n "$arch_id" ]]; then
    echo "Architecture UI:  $CALM_HUB_URL/#/$NAMESPACE/architectures/$arch_id/$VERSION"
else
    echo "Architecture UI:  $CALM_HUB_URL/#/namespace/$NAMESPACE"
fi
