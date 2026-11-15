#!/bin/bash
# Usage: CF_ACCOUNT_ID=<id> [VAULT=<dir>] ./setup-realtime.sh <cloudflare-token-with-Realtime-Edit>
# Creates a Cloudflare Realtime (Calls) SFU app, stores creds in vault, sets Worker secrets, redeploys.
set -u
TOK="$1"; A="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID to your Cloudflare account id}"
V="${VAULT:-/workspace/vault/pit-live}"; mkdir -p "$V"
echo "$TOK" > $V/cf-realtime-token; chmod 600 $V/cf-realtime-token
echo "-- verify token"; curl -s -H "Authorization: Bearer $TOK" https://api.cloudflare.com/client/v4/user/tokens/verify | jq -c '{status:.result.status,success}'
echo "-- existing apps"; curl -s -H "Authorization: Bearer $TOK" https://api.cloudflare.com/client/v4/accounts/$A/calls/apps | jq -c '{success,errors,apps:[.result[]?|{uid,name}]}'
echo "-- create app"; R=$(curl -s -X POST -H "Authorization: Bearer $TOK" -H "content-type: application/json" https://api.cloudflare.com/client/v4/accounts/$A/calls/apps -d '{"name":"pit-live"}'); echo "$R" | jq -c '{success,errors,uid:.result.uid}'
APP=$(echo "$R" | jq -r '.result.uid'); SEC=$(echo "$R" | jq -r '.result.secret')
[ "$APP" = "null" ] && { echo "app creation failed"; exit 1; }
echo "$R" > $V/cf-realtime-app.json; chmod 600 $V/cf-realtime-app.json
cd /workspace/pit-live
echo -n "$APP" | env -u CF_API_TOKEN CLOUDFLARE_API_TOKEN=$(cat /workspace/.cf-workers-token) npx wrangler secret put CALLS_APP_ID --config wrangler.jsonc 2>&1 | tail -1
echo -n "$SEC" | env -u CF_API_TOKEN CLOUDFLARE_API_TOKEN=$(cat /workspace/.cf-workers-token) npx wrangler secret put CALLS_APP_SECRET --config wrangler.jsonc 2>&1 | tail -1
sleep 3; curl -s https://live.zuchiangmai.app/api/rt/status; echo
