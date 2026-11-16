# 📻 LIVE PIT: open-source radio from the floor

**Live:** https://live.zuchiangmai.app/ · **Protocol:** [PROTOCOL.md](PROTOCOL.md) · **License:** AGPL-3.0-or-later + attribution ([NOTICE](NOTICE)) · docs CC BY-SA 4.0

The Open Source Orchestra PIT is the floor, not the stage. LIVE PIT turns a browser at the mixer into a radio
transmitter. A Soundcraft USB into a laptop is enough: no OBS, no app, no account for listeners. Every website that
carries one line of HTML lights up by itself when the PIT goes live, and stays invisible when it is quiet.

```html
<script src="https://live.zuchiangmai.app/widget.js" async></script>
```

It is one Cloudflare Worker + one KV namespace + a Cloudflare Realtime SFU app, all open standards:

- **Transmit** from the browser (`/broadcast`) or from OBS/Larix/GStreamer with **WHIP** (`POST /whip`, RFC 9725)
- **Listen** in the player (`/`), the widget, or any **WHEP** player (`POST /whep`)
- **Rehearse** on an unlisted channel first (doors stay dark), then go on air with one tap
- **Keys per person**, stored only as hashes, least privilege, revocable; a **kill switch** that beats everything
- **TURN relay** for strict venue wifi, auto-reconnect, local safety recording, honest on-air status
- **No cookies, no analytics, no listener login.** Keys travel in the URL fragment, which never reaches a server log.

## Run your own station (fork → live in ~15 minutes)

1. Fork this repo. You need a Cloudflare account with Workers + KV, and **Realtime** (SFU) enabled.
2. `cp wrangler.example.jsonc wrangler.jsonc` → set your Worker name, your domain (or use workers.dev) and a KV
   namespace id (`npx wrangler kv namespace create LIVE`).
3. Create a Realtime SFU app (dash → Realtime → SFU, or `CF_ACCOUNT_ID=… ./setup-realtime.sh < token-file`;
   the token goes on stdin, never as an argument, because argv is visible to other processes), then:
   ```
   npx wrangler secret put CALLS_APP_ID
   npx wrangler secret put CALLS_APP_SECRET
   npx wrangler secret put ADMIN_TOKEN          # a long random string: your master key
   npx wrangler secret put TURN_KEY_ID          # optional, Cloudflare TURN key (recommended for venues)
   npx wrangler secret put TURN_KEY_SECRET
   ```
4. `node qa/check-syntax.mjs && npx wrangler deploy`
5. Open `/admin#k=<ADMIN_TOKEN>` → "Create key + one-tap sign-in link" for each person who will transmit.
6. Put the widget line on your sites. Change `BASE` in the widget (worker.js) to your domain.

**Keep the credit** (it is a license term, AGPL §7(b), see NOTICE): *"Built on LIVE PIT by Open Source
Orchestra: Shaka Lei Kaumaka & the AI ʻohana"* stays visible in your player/transmitter footers. Add your own name
next to it. And because it is AGPL: if you run a modified version for others, offer them your source.

## Test like we do

```
node qa/check-syntax.mjs                       # every script the Worker serves must parse (guard rail)
npx wrangler dev                               # local, with .dev.vars (never commit it)
PIT_ADMIN_FILE=… PIT_REVOKE=1 node test-v21.mjs            # full e2e incl. on-air, local KV only
PIT_BASE=https://your.domain PIT_LIVE=0 PIT_TX_FILE=… node test-v21.mjs   # production: rehearsal only
PIT_BASE=https://your.domain PIT_TX_FILE=… node test-whip-whep.mjs        # OBS/WHIP lane, rehearsal
```
Playwright is the only test dependency. On production, test on the **rehearsal** channel only, so your doors
never light up for a test tone.

## Files

| file | what |
|---|---|
| `worker.js` | routing, manifest (`/live.json`), keys + roles, widget, player, admin desk |
| `realtime.js` | SFU lanes: JSON publish/listen, WHIP, WHEP, channels, TURN, status |
| `broadcast.html` | the transmitter page (sign-in → sound check → rehearse → on air) |
| `PROTOCOL.md` | the operating protocol: CROPS safety layers, the ten laws, lanes, consent, Subcult + Onda |
| `qa/check-syntax.mjs`, `test-*.mjs` | guard rails |

## Credits

Built by **Open Source Orchestra**: Shaka Lei Kaumaka & the AI ʻohana, Chiang Mai, November 2026, for the PIT at
4Seas / Zu Chiang Mai and for every community that wants its own floor on the air. Inspired by community radio, by
patio.fm ("the tab is the transmitter"), and by the friends at MDRN / Subcult / Onda who are building the payment
and storage layers for underground music.

Security: see [SECURITY.md](SECURITY.md). Contact: contribute@opensourceorchestra.org
