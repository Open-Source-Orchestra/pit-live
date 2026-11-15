# LIVE PIT · Operating Protocol v0.2

*pit-live 2.1 · 15 November 2026 · Open Source Orchestra · Code AGPL-3.0-or-later · this text CC BY-SA 4.0*
*Supersedes PIT LIVE protocol v0.1 (14 Nov). Compatible with PIT STANDARD V2 (`pit-manifest/0.2`).*

> The PIT is the floor, not the stage. A browser at the mixer is the transmitter; every door that
> carries the widget lights up by itself; anyone can listen without an account; anyone can fork it.

```
 Soundcraft USB → browser /broadcast ─WebRTC─▶ Cloudflare Realtime SFU ─▶ listeners (player · widget · any WHEP app)
 OBS / Larix ────WHIP /whip─────────────────▶        ▲                    /live.json tells 1,205 doors "on air"
                                    TURN relay (only while on air) for strict venue wifi
```

---

## 1 · The run sheet (for the human at the mixer)

1. **Sign in once.** Tap your one-tap link (`…/broadcast#k=…`, sent privately). It signs you in, remembers the
   device and wipes the key from the address bar. No link? Paste the key; the page tells you if you pasted the
   wrong thing (a Cloudflare token, an old key…).
2. **Sound check.** 🎤 Test the sound → pick the Soundcraft / USB input → the meter must move. Flat for 8 s → the
   page says so.
3. **Rehearse.** 🎧 START REHEARSAL. The doors stay dark. 📱 opens an unlisted listen link for your phone.
   👂 "Check that listeners hear you" proves bytes arrive at a real test listener.
4. **Go on air.** 🔴 Go on air now. Every door lights up. Keep the tab open; the page keeps the screen awake,
   reconnects by itself, and falls back to the relay if the venue wifi blocks WebRTC.
5. **Stop.** ⏹ STOP. The doors go dark within seconds. ⬇ Download the local safety recording. It never left
   your device.
6. **Emergency.** `/admin` → ⏹ KILL SWITCH. It hides every door, whatever is transmitting.

## 2 · CROPS safety layers

The four properties the Ethereum Foundation Mandate (13 Mar 2026) calls non-negotiable: **C**ensorship
resistance, **O**pen source (free as in freedom), **P**rivacy, **S**ecurity. How the radio keeps each one:

| | What LIVE PIT does today | Still open (honest) |
|---|---|---|
| **C · Censorship resistance** | Open standards in and out: WHIP ingest (RFC 9725) from any encoder, WHEP playback for any player, plus the JSON lane. `mirrors[]` lets friends carry the feed. The kill switch and the keys belong to the ʻohana, not to a platform. Anyone can fork and run their own station (§9). | One SFU vendor today (Cloudflare Realtime). Next lanes: Icecast (lane B, needs Shaka's 2-minute signup), the MDRN federated radio network (§4 lane O), a second SFU. |
| **O · Open source** | Code AGPL-3.0-or-later with an attribution term (§9). Docs and design CC BY-SA 4.0. Public repo, public protocol, REUSE-annotated. | OpenSSF Best Practices badge (needs a human account). |
| **P · Privacy** | No cookies, analytics or login for listeners. Keys travel only in the URL *fragment*, which is never sent to servers or logs, and are stored on the device. `Referrer-Policy: no-referrer`. TURN credentials are short-lived and only handed out while a channel is live. The recording stays local unless everyone heard in it consents (§5). | Cloudflare sees IP addresses as any CDN does. Document it in the privacy note. |
| **S · Security** | Per-person transmitter keys, stored only as SHA-256 hashes, timing-safe compare, least privilege (`tx` = go on air / stop / on-air text; only `admin` changes the station), revocable in one tap. Rehearsal room before air. One transmitter per channel, with a REPLACED warning if someone else takes over. Kill switch beats everything. Syntax gate + end-to-end test + rollback command before every deploy (§8). | Rate-limit failed sign-ins if abuse ever shows up (keys carry ~190 bits, so guessing is not the risk). |

## 3 · Infinite guard rails for growth (the ten laws)

1. **Rehearse first.** The default button is START REHEARSAL; going on air is a second, deliberate tap.
2. **Never test on the live channel.** Office tests run on `rehearsal` only. 1,205 doors never light up for a
   test tone.
3. **One key per person.** Mint one, send it privately (DM, never a group), revoke it the moment it leaks.
   Keys are never reused across people.
4. **The kill switch beats everything.** `on_air:false` hides every door no matter who transmits.
5. **Honest status.** A door says ON AIR only when the SFU confirms a live track. It says nothing when off air
   (the widget is invisible). It never claims an audience it cannot count. The listener count is marked ≈.
6. **Consent before a recording leaves the device** (§5).
7. **Credits travel with every play.** Whoever is on the floor is named in `now_playing` and `credits[]`. That
   is how support finds the artist (§4 lane O).
8. **Deploy like a surgeon.** Syntax gate → e2e (rehearsal) → WHIP test → deploy → check the served bytes →
   rollback ready. A broken page is an outage (scar: 15 Nov, 8 minutes).
9. **Forks keep the credit and stay open** (§9).
10. **Grow by lanes, not by rewrites.** New ingest or storage = a new lane in the manifest. The doors never
    need a redeploy to learn about it.

## 4 · Lanes

| Lane | What | Status 15 Nov |
|---|---|---|
| **A** browser → WebRTC | `/broadcast`, the transmitter in this repo | ✅ live (v2.1) |
| **A′** OBS / any WHIP app | `POST /whip` (Bearer = transmitter key), `?channel=rehearsal` to rehearse | ✅ live |
| **B** Icecast | classic radio mount for BUTT/OBS + `<audio>` players | ⏳ needs Shaka's 2-minute signup (hosts are card/captcha walled) |
| **C** HLS / friends' mirrors | `sources[]`, `mirrors[]` in `/live.json` | ✅ supported, none configured |
| **S** **Subcult** storage | consented sets → the SHAKA OHANA collection on Subcult | 🟡 manual today (see below) |
| **O** **Onda** penny extension | every play can send a wave to the artist on the floor | 🟡 metadata ready, waiting for Onda's release |

### Lane S · Subcult (sbclt.fm → subcult.fm) as the home of the recordings

Subcult, made by MDRN (Alaska / Christopher Rose), is "human made, human selected, music with context". Its
collections hold music *with the story around it*, and anyone can **upload their own**. A **SHAKA OHANA**
collection already exists there. Shaka set it up with Alaska over breakfast at the Grand Hyatt during Devcon 8.

The drop, every time:
1. STOP → the transmitter offers the local recording (stays on the device).
2. **Consent check (§5).** No yes from everyone audible → it stays private. Full stop.
3. The office writes the **drop card**: title · who played (`credits[]`) · where/when · the story · license
   (performers keep their rights; our words CC BY-SA 4.0) · consent receipt id.
4. Shaka (or the artist) uploads the file + card to the SHAKA OHANA collection on Subcult ("upload yours").
   Subcult has no public API that we know of, so a human taps upload. If Subcult opens an API, this step
   becomes automatic, behind the same consent gate.
5. The Subcult link goes into `recordings[]` in the manifest, the theater's archive channel, and the PIT's
   memory. The set now has a home, a context and a credit.

### Lane O · Onda: a penny for the artist on the floor

Onda (getonda.org, by MDRN) is "a payment layer for patronage". It recognizes the track you are listening to
(Spotify, SoundCloud, Bandcamp, YouTube Music, *online and community radio*) and sends a small gift (their
example is $0.01) **directly to the artist**. If the artist hasn't claimed yet, the gift waits. Artists claim
at getonda.org/claim with an existing wallet or a passkey wallet. "Onda for community radio" adds a support
layer to a station's stream. MDRN's wider plan is federated internet radio where "every station pays its
curators and artists". **Status: Onda says "releasing soon".** Nothing settles today and we don't pretend
otherwise.

What LIVE PIT does now so every play can become a wave on day one:
- **Now-playing law:** the transmitter's "who is on the floor" field → `rt.label` / `now_playing` in
  `/live.json`. Proposed: `credits[]` = `[{name, role: "artist"|"curator"|"community", onda?: "<claim handle>"}]`,
  so a recognizer (Onda or any other) knows *exactly* who to thank, with no fingerprint guessing needed.
- **Support lanes on every door:** `support[]` in the manifest (`{name, url, kind, note}`) is rendered by the
  player: e.g. "💧 a penny for the artist (Onda, releasing soon)", "🎧 the recordings live on Subcult". The
  doors learn new lanes without a redeploy.
- **Split:** MDRN describes splits between artists, curators and communities with no platform cut. OSO's
  proposed default: the artist on the floor first. The exact split is agreed with Alaska / MDRN and blessed by
  Shaka. The office does not set it.
- When MDRN's radio network opens, LIVE PIT applies as a station. Same manifest, one more `mirrors[]` entry.

## 5 · Consent law (recordings and voices)

- **Live is live.** People on the floor know the PIT transmits; the transmitter page and the doors say so.
- **A recording leaves the device only with a yes from everyone audible.** The receipt goes in
  `consent@publicinform.com` / the PIT memory. Silence is not a yes.
- **Takedown first, questions second:** https://opensourceorchestra.org/takedown/ (24 h).
- Performers keep the rights to their performances. Our license covers our code and our words, never their
  music.

## 6 · Keys and roles

| Key | Can | Where it lives |
|---|---|---|
| **admin** (`ADMIN_TOKEN` secret) | everything: station settings, kill switch, mint/revoke transmitter keys, transmit | office vault + Shaka |
| **transmitter** (`pit_tx_…`, one per person) | go on air, rehearse, stop, change on-air text, WHIP | the person's own device (one-tap link) |
| listener | listen. No key, no login, no cookie. | everyone |

Mint / rotate: `/admin` → "Create key + one-tap sign-in link", or `POST /api/keys {"name":"…"}` with the admin
key. The key is **shown once**; only its hash is stored. Re-issuing a name rotates it. Revoke:
`DELETE /api/keys?name=…`.

## 7 · Endpoints

| Path | Who | What |
|---|---|---|
| `GET /live.json` | anyone | station manifest (`on_air`, `live`, `webrtc`, `rt`, `now_playing`, `sources[]`, `mirrors[]`, `links[]`, `whep`). 4 s edge cache |
| `POST /api/state` | admin | change the station (title, venue, sources, mirrors, `on_air` true/false/`auto`) |
| `GET /widget.js` | anyone | the one-line door embed (invisible off air) |
| `GET /listen.js` | anyone | `pitListenRT(audio, channel)` + `pitListenWHEP(audio, channel)` |
| `/broadcast` | transmitter | the transmitter page |
| `/admin` | admin | mixer desk + key manager + kill switch |
| `GET /api/rt/status?channel=` | anyone | is a transmitter live on `live` / `rehearsal` |
| `GET /api/rt/ice?channel=` | anyone / transmitter | ICE servers (TURN for transmitters; for listeners only while live) |
| `POST /api/rt/publish · /stop · /text` | transmitter | JSON lane (`channel`: `live` or `rehearsal`) |
| `POST /api/rt/listen`, `PUT /api/rt/renegotiate` | anyone | JSON listen lane |
| `POST /whip[?channel=rehearsal]`, `DELETE /whip/:id` | transmitter | WHIP ingest (RFC 9725) |
| `POST /whep[?channel=rehearsal]` | anyone | WHEP playback |
| `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys?name=` | admin | transmitter keys |

## 8 · Deploying (the surgeon's checklist)

```
node qa/check-syntax.mjs                                  # every served script must parse
wrangler dev  +  PIT_ADMIN_FILE=… PIT_REVOKE=1 node test-v21.mjs     # full local e2e incl. ON AIR (local KV)
wrangler deploy
PIT_BASE=https://live.zuchiangmai.app PIT_LIVE=0 PIT_TX_FILE=<office-test key> node test-v21.mjs   # rehearsal only
node test-whip-whep.mjs                                   # OBS lane, rehearsal
curl the served pages → parse their scripts again         # what the world receives
wrangler rollback <previous-version-id>                   # if anything is off
```

## 9 · License: the ʻohana copyleft

- **Code: AGPL-3.0-or-later.** Copyleft that also covers network use: anyone who runs a modified LIVE PIT for
  others must offer those people the full source under the same license.
- **Attribution term (AGPL §7(b), in NOTICE):** every copy and fork keeps *"Built on LIVE PIT by Open Source
  Orchestra: Shaka Lei Kaumaka & the AI ʻohana"* visible to its users. Add your name, never remove ours.
- **Words, design, docs: CC BY-SA 4.0.** Credit + share-alike.
- **Not ours:** performers' music, Devcon photos (© their photographers, used with credit, takedown on request),
  third-party names.
- Plain-language summary, not legal advice.

## 10 · Changelog

- **v0.2 · 15 Nov 2026 (pit-live 2.1):** per-person transmitter keys + one-tap link + wrong-key hints ·
  rehearsal channel + promote · TURN relay + automatic relay fallback · REPLACED detection · listener count that
  never touches the air pointer · `/live.json` edge micro-cache · kill switch + key manager in `/admin` ·
  WHIP/WHEP rehearsal · CROPS layers · Subcult lane S + Onda lane O · AGPL + §7(b) attribution.
  Root cause of "/broadcast doesn't work": the browser held a wrong/stale key (14 × HTTP 401). The device, the
  microphone and the SFU were fine.
- v0.1 · 14 Nov 2026: receiver + manifest + widget + JSON WebRTC lane.
