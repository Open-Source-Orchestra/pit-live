#!/bin/bash
# Usage: CF_ACCOUNT_ID=<id> [VAULT=<dir>] ./setup-realtime.sh < file-holding-a-cloudflare-token-with-Realtime-Edit
#        (or run it in a terminal and paste the token at the hidden prompt)
# Creates a Cloudflare Realtime (Calls) SFU app, stores creds in vault, sets Worker secrets, redeploys.
# Secrets never go on a command line: argv is readable by every process on the machine (ps, /proc/*/cmdline).
# The token arrives on stdin, reaches curl as a header read from stdin (-H @-), and reaches wrangler
# through an exported variable inside a subshell (never `env VAR=$(cat …) cmd`, which puts it in env's argv).
set -u
umask 077   # every file this script writes (token, app secret) is owner-only from birth
[ $# -eq 0 ] || { echo "refusing: pass the token on stdin, not as an argument (argv is visible to other processes)"; exit 2; }
A="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID to your Cloudflare account id}"
if [ -t 0 ]; then read -rsp "Cloudflare token (Realtime Edit): " TOK; echo; else IFS= read -r TOK || true; fi
[ -n "${TOK:-}" ] || { echo "no token on stdin"; exit 1; }
V="${VAULT:-/workspace/vault/pit-live}"; mkdir -p "$V"; chmod 700 "$V"
printf '%s\n' "$TOK" > "$V/cf-realtime-token"; chmod 600 "$V/cf-realtime-token"
cfapi() { printf 'Authorization: Bearer %s\n' "$TOK" | curl -s -H @- "$@"; }   # header via stdin, not argv
cfw() { ( unset CF_API_TOKEN; CLOUDFLARE_API_TOKEN="$(cat "${CF_WORKERS_TOKEN_FILE:-/workspace/.cf-workers-token}")"; export CLOUDFLARE_API_TOKEN; exec npx wrangler "$@" ); }
echo "-- verify token"; cfapi https://api.cloudflare.com/client/v4/user/tokens/verify | jq -c '{status:.result.status,success}'
echo "-- existing apps"; cfapi "https://api.cloudflare.com/client/v4/accounts/$A/calls/apps" | jq -c '{success,errors,apps:[.result[]?|{uid,name}]}'
echo "-- create app"; R=$(cfapi -X POST -H "content-type: application/json" "https://api.cloudflare.com/client/v4/accounts/$A/calls/apps" -d '{"name":"pit-live"}'); echo "$R" | jq -c '{success,errors,uid:.result.uid}'
APP=$(echo "$R" | jq -r '.result.uid'); SEC=$(echo "$R" | jq -r '.result.secret')
[ "$APP" = "null" ] && { echo "app creation failed"; exit 1; }
echo "$R" > "$V/cf-realtime-app.json"; chmod 600 "$V/cf-realtime-app.json"
cd /workspace/pit-live
printf '%s' "$APP" | cfw secret put CALLS_APP_ID --config wrangler.jsonc 2>&1 | tail -1
printf '%s' "$SEC" | cfw secret put CALLS_APP_SECRET --config wrangler.jsonc 2>&1 | tail -1
sleep 3; curl -s https://live.zuchiangmai.app/api/rt/status; echo
