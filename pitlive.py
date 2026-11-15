#!/usr/bin/env python3
"""pitlive.py — CLI for the LIVE PIT transponder state (https://live.zuchiangmai.app).

  pitlive.py show
  pitlive.py on  [--np "who is playing"]
  pitlive.py off
  pitlive.py auto
  pitlive.py set --title ... --subtitle ... --np ... --venue ...
  pitlive.py sources '<json array>'      # [{"type":"hls","url":...},{"type":"audio","url":...}]
  pitlive.py mirrors '<json array>'      # [{"name":"streameth","url":...}]
Token: /workspace/vault/pit-live/admin-token (or PITLIVE_TOKEN env).
"""
import argparse, json, os, sys, urllib.request

BASE = os.environ.get("PITLIVE_BASE", "https://live.zuchiangmai.app")

def token():
    t = os.environ.get("PITLIVE_TOKEN")
    if t:
        return t.strip()
    with open("/workspace/vault/pit-live/admin-token") as f:
        return f.read().strip()

def get():
    with urllib.request.urlopen(urllib.request.Request(BASE + "/live.json", headers={"user-agent": "pitlive-cli/1.0"}), timeout=15) as r:
        return json.load(r)

def post(body):
    req = urllib.request.Request(BASE + "/api/state", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": "Bearer " + token(), "user-agent": "pitlive-cli/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["show", "on", "off", "auto", "set", "sources", "mirrors"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--title"); ap.add_argument("--subtitle"); ap.add_argument("--np"); ap.add_argument("--venue")
    a = ap.parse_args()
    if a.cmd == "show":
        print(json.dumps(get(), indent=2)); return
    body = {}
    if a.cmd == "on": body["on_air"] = True
    elif a.cmd == "off": body["on_air"] = False
    elif a.cmd == "auto": body["on_air"] = "auto"
    elif a.cmd == "sources": body["sources"] = json.loads(a.arg)
    elif a.cmd == "mirrors": body["mirrors"] = json.loads(a.arg)
    for k, v in (("title", a.title), ("subtitle", a.subtitle), ("now_playing", a.np), ("venue", a.venue)):
        if v is not None: body[k] = v
    r = post(body)
    print(json.dumps(r, indent=2))
    sys.exit(0 if r.get("ok") else 1)

if __name__ == "__main__":
    main()
