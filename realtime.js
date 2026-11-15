// realtime.js — Lane A: transmitter (browser or any WHIP client) → Cloudflare Realtime SFU → listeners (browser or any WHEP client).
// "Open the website, sign in, pick the Soundcraft USB input, go on air." Also OBS → /whip. Any player → /whep.
// Secrets: CALLS_APP_ID, CALLS_APP_SECRET (Cloudflare Realtime SFU app) · TURN_KEY_ID, TURN_KEY_SECRET (Cloudflare TURN, optional).
// KV: 'rt' = the one transmitter ON AIR (pointer) · 'rt:rehearsal' = unlisted sound-check room (never lights the doors)
//     'rtl:<session>' = approximate listener count (throttled; never rewrites the air pointer).
// Who may transmit is decided by worker.js (auth → who = {role:'admin'|'tx', name}) and passed in here.
import BROADCAST_HTML from './broadcast.html';
export { BROADCAST_HTML };

const RTC = 'https://rtc.live.cloudflare.com/v1/apps';
const STUN = 'stun:stun.cloudflare.com:3478';
const PTR_KEY = { live: 'rt', rehearsal: 'rt:rehearsal' };
export const channelOf = v => (v === 'rehearsal' ? 'rehearsal' : 'live');

function cfg(env) {
  if (!env.CALLS_APP_ID || !env.CALLS_APP_SECRET) return null;
  return { id: env.CALLS_APP_ID, secret: env.CALLS_APP_SECRET };
}

async function rtc(env, path, body, method = 'POST') {
  const c = cfg(env);
  const r = await fetch(`${RTC}/${c.id}${path}`, {
    method,
    headers: { authorization: `Bearer ${c.secret}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (!r.ok) throw new Error(`SFU ${path.split('/').slice(0, 3).join('/')} ${r.status}: ${txt.slice(0, 300)}`);
  return j;
}

const CORS_RT = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,if-match',
  'access-control-expose-headers': 'location,etag,link,accept-post'
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_RT } });
const T = (txt, s, extra = {}) => new Response(txt, { status: s, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...CORS_RT, ...extra } });
const whOptions = () => new Response(null, { status: 204, headers: { ...CORS_RT, 'accept-post': 'application/sdp', link: `<${STUN}>; rel="ice-server"` } });

export function isRtPath(p) { return p.startsWith('/api/rt/') || /^\/(whip|whep|ingest|play)(\/|$)/.test(p); }

// ---------------------------------------------------------------- ICE (STUN always · TURN relay when configured)
// TURN is handed to signed-in transmitters always, and to listeners only while that channel is on air
// (keeps the relay from being an open proxy when nothing is playing). Credentials are short-lived (4 h).
let ICE = null; // {at, servers, turn}
export async function iceServers(env) {
  const now = Date.now();
  if (ICE && now - ICE.at < (ICE.turn ? 20 * 60e3 : 30e3)) return ICE;
  let servers = [{ urls: [STUN] }], turn = false;
  if (env.TURN_KEY_ID && env.TURN_KEY_SECRET) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.TURN_KEY_SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 4 * 3600 })
      });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.iceServers) && j.iceServers.length) { servers = j.iceServers; turn = true; }
      }
    } catch {}
  }
  ICE = { at: now, servers, turn };
  return ICE;
}
const stunOnly = () => [{ urls: [STUN] }];

// ---------------------------------------------------------------- pointer helpers
function midKinds(sdp) { // m-section → kind map from an SDP offer, keyed by a=mid
  const m = {}; let kind = null;
  for (const line of String(sdp).split(/\r?\n/)) {
    if (line.startsWith('m=')) kind = line.slice(2).split(' ')[0];
    else if (line.startsWith('a=mid:') && kind) m[line.slice(6).trim()] = kind;
  }
  return m;
}

async function readPtr(env, ch = 'live') {
  const raw = await env.LIVE.get(PTR_KEY[ch]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// One transmitter per channel; a new publish replaces the pointer (last one wins, the old one learns via /api/rt/status).
async function publishCore(env, sdp, meta, via, who, ch) {
  const s = await rtc(env, '/sessions/new');
  const t = await rtc(env, `/sessions/${s.sessionId}/tracks/new`, { sessionDescription: { type: 'offer', sdp }, autoDiscover: true });
  const kinds = midKinds(sdp);
  const tracks = (t.tracks || []).filter(x => x && x.trackName && !x.errorCode)
    .map(x => ({ trackName: x.trackName, mid: String(x.mid), kind: kinds[String(x.mid)] || 'audio' }));
  if (!tracks.length) throw new Error('SFU accepted no tracks: ' + JSON.stringify(t.tracks || t).slice(0, 300));
  if (!t.sessionDescription || !t.sessionDescription.sdp) throw new Error('SFU returned no answer');
  const prev = await readPtr(env, ch);
  const ptr = {
    sessionId: s.sessionId, tracks, via, channel: ch,
    by: (who && who.name) || 'unknown',
    label: String(meta.label || 'OSO PIT main mix').slice(0, 200),
    title: String(meta.title || '').slice(0, 200),
    message: String(meta.message || '').slice(0, 300),
    started_at: new Date().toISOString(),
    replaced: prev ? prev.sessionId : null
  };
  await env.LIVE.put(PTR_KEY[ch], JSON.stringify(ptr));
  ALIVE.delete(s.sessionId);
  return { ptr, answer: t.sessionDescription };
}

// Stop: by channel (+ optional session guard). WHIP DELETE passes only a session id → search both channels.
async function stopCore(env, ch, sessionId) {
  const chans = ch ? [ch] : ['live', 'rehearsal'];
  for (const c of chans) {
    const ptr = await readPtr(env, c);
    if (!ptr) continue;
    if (sessionId && ptr.sessionId !== sessionId) { if (ch) return { ok: true, stale: true, note: 'another transmitter is on this channel; nothing changed' }; continue; }
    await env.LIVE.delete(PTR_KEY[c]);
    ALIVE.delete(ptr.sessionId);
    try { await rtc(env, `/sessions/${ptr.sessionId}/tracks/close`, { tracks: ptr.tracks.map(t => ({ mid: t.mid })), force: true }, 'PUT'); } catch {}
    return { ok: true, was: 'on', channel: c, sessionId: ptr.sessionId };
  }
  return { ok: true, was: 'off' };
}

// Listener count: approximate on purpose. Per-isolate tally flushed to its own KV key at most every 15 s.
const LBUMP = new Map();
async function bumpListeners(env, sid) {
  const e = LBUMP.get(sid) || { pending: 0, last: 0 };
  e.pending++; LBUMP.set(sid, e);
  const now = Date.now();
  if (now - e.last < 15000) return;
  e.last = now; const add = e.pending; e.pending = 0;
  const k = 'rtl:' + sid;
  const cur = parseInt((await env.LIVE.get(k)) || '0', 10) || 0;
  await env.LIVE.put(k, String(cur + add), { expirationTtl: 2 * 86400 });
  if (LBUMP.size > 200) LBUMP.clear();
}

async function listenCore(env, ctx, sdp, ch) {
  const ptr = await readPtr(env, ch);
  if (!ptr) return { error: ch === 'rehearsal' ? 'no rehearsal running' : 'off air', status: 404 };
  const audio = ptr.tracks.filter(t => t.kind === 'audio');
  const pick = (audio.length ? audio : ptr.tracks).slice(0, 1);
  const s = await rtc(env, '/sessions/new');
  const body = { tracks: pick.map(t => ({ location: 'remote', sessionId: ptr.sessionId, trackName: t.trackName })) };
  if (sdp) body.sessionDescription = { type: 'offer', sdp };
  const t = await rtc(env, `/sessions/${s.sessionId}/tracks/new`, body);
  const bump = bumpListeners(env, ptr.sessionId).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(bump);
  return { sessionId: s.sessionId, sessionDescription: t.sessionDescription, requiresImmediateRenegotiation: !!t.requiresImmediateRenegotiation, tracks: t.tracks };
}

// Is the transmitter's track still alive on the SFU? Cached 3 s per isolate (1,205 doors poll /live.json).
const ALIVE = new Map();
async function aliveCore(env, ptr) {
  const now = Date.now(); const c = ALIVE.get(ptr.sessionId);
  if (c && now - c.at < 3000) return c.v;
  let v = false;
  try {
    const st = await rtc(env, `/sessions/${ptr.sessionId}`, null, 'GET');
    const names = new Set(ptr.tracks.map(t => t.trackName));
    v = Array.isArray(st.tracks) && st.tracks.some(t => names.has(t.trackName) && t.status !== 'inactive');
  } catch { v = false; }
  if (ALIVE.size > 100) ALIVE.clear();
  ALIVE.set(ptr.sessionId, { at: now, v });
  return v;
}

export async function realtimeInfo(env, ch = 'live') {
  if (!cfg(env)) return { alive: false, configured: false };
  const ptr = await readPtr(env, ch);
  if (!ptr) return { alive: false, configured: true };
  return { alive: await aliveCore(env, ptr), ptr, configured: true };
}
export async function realtimeLive(env) { return (await realtimeInfo(env)).alive; }

export async function handleRealtime(req, env, ctx, p, who) {
  try { return await inner(req, env, ctx, p, who); }
  catch (e) { return J({ ok: false, error: String(e && e.message || e).slice(0, 400) }, 502); }
}

async function readJson(req) { try { return (await req.json()) || {}; } catch { return {}; } }

async function inner(req, env, ctx, p, who) {
  const m = req.method;
  const url = new URL(req.url);
  if (m === 'OPTIONS' && !/^\/(whip|whep|ingest|play)/.test(p)) return new Response(null, { headers: CORS_RT });
  if (!cfg(env)) return J({ ok: false, error: 'realtime not configured (CALLS_APP_ID/SECRET missing)' }, 503);
  const qch = channelOf(url.searchParams.get('channel') || url.searchParams.get('ch'));

  // ---- WHIP ingest (RFC 9725): OBS 30+, Larix, GStreamer whipsink, any WHIP client. Bearer = a transmitter key.
  const whip = p.match(/^\/(whip|ingest)(?:\/([\w-]+))?$/);
  if (whip) {
    const sid = whip[2];
    if (m === 'OPTIONS') return whOptions();
    if (!sid) {
      if (m !== 'POST') return T('method not allowed', 405);
      if (!who) return T('unauthorized — use your transmitter key as the Bearer token', 401, { 'www-authenticate': 'Bearer realm="pit-live"' });
      const sdp = await req.text();
      if (!/^v=0/m.test(sdp)) return T('expected an application/sdp offer', 400);
      const { ptr, answer } = await publishCore(env, sdp, { label: url.searchParams.get('label') || 'OBS / WHIP', message: url.searchParams.get('message') || '' }, 'whip', who, qch);
      const links = (await iceServers(env)).servers.map(s => linkHeader(s)).filter(Boolean).join(', ');
      return new Response(answer.sdp, { status: 201, headers: { ...CORS_RT, 'content-type': 'application/sdp', location: `/whip/${ptr.sessionId}`, etag: `"${ptr.sessionId}"`, link: links || `<${STUN}>; rel="ice-server"` } });
    }
    if (m === 'DELETE') return J(await stopCore(env, null, sid));
    if (m === 'PATCH') return T('trickle ICE not supported — send a complete offer', 405);
    return T('method not allowed', 405);
  }

  // ---- WHEP playback (RFC 9725 sibling, draft-ietf-wish-whep): any WHEP player.
  const whep = p.match(/^\/(whep|play)(?:\/([\w-]+))?$/);
  if (whep) {
    const sid = whep[2];
    if (m === 'OPTIONS') return whOptions();
    if (!sid) {
      if (m !== 'POST') return T('method not allowed', 405);
      const sdp = await req.text();
      if (!/^v=0/m.test(sdp)) return T('expected an application/sdp offer', 400);
      const r = await listenCore(env, ctx, sdp, qch);
      if (r.error) return T(r.error, r.status || 500);
      if (!r.sessionDescription || r.sessionDescription.type !== 'answer') return T('SFU did not answer the offer', 502);
      return new Response(r.sessionDescription.sdp, { status: 201, headers: { ...CORS_RT, 'content-type': 'application/sdp', location: `/whep/${r.sessionId}`, etag: `"${r.sessionId}"`, link: `<${STUN}>; rel="ice-server"` } });
    }
    if (m === 'DELETE') return new Response(null, { status: 200, headers: CORS_RT });
    if (m === 'PATCH') return T('trickle ICE not supported', 405);
    return T('method not allowed', 405);
  }

  // ---- JSON API used by /broadcast, the player, the widget
  if (p === '/api/rt/whoami') return who ? J({ ok: true, name: who.name, role: who.role }) : J({ ok: false, error: 'unauthorized' }, 401);

  if (p === '/api/rt/ice') {
    // transmitters: always STUN+TURN · listeners: TURN only while the channel is on air
    let give = !!who;
    if (!give) { const ptr = await readPtr(env, qch); give = !!ptr; }
    const ice = give ? await iceServers(env) : { servers: stunOnly(), turn: false };
    return J({ ok: true, iceServers: ice.servers, turn: ice.turn });
  }

  if (p === '/api/rt/publish' && m === 'POST') {
    if (!who) return J({ ok: false, error: 'unauthorized' }, 401);
    const b = await readJson(req);
    if (!b.sdp) return J({ ok: false, error: 'sdp missing' }, 400);
    const ch = channelOf(b.channel);
    const { ptr, answer } = await publishCore(env, b.sdp, b, 'browser', who, ch);
    return J({ ok: true, sessionId: ptr.sessionId, channel: ch, by: ptr.by, answer, tracks: ptr.tracks });
  }

  if (p === '/api/rt/text' && m === 'POST') {
    if (!who) return J({ ok: false, error: 'unauthorized' }, 401);
    const b = await readJson(req);
    const ch = channelOf(b.channel);
    const ptr = await readPtr(env, ch);
    if (!ptr) return J({ ok: false, error: 'off air' }, 404);
    for (const k of ['label', 'title', 'message']) if (typeof b[k] === 'string') ptr[k] = b[k].slice(0, 300);
    await env.LIVE.put(PTR_KEY[ch], JSON.stringify(ptr));
    return J({ ok: true, label: ptr.label, title: ptr.title, message: ptr.message });
  }

  if (p === '/api/rt/stop' && m === 'POST') {
    if (!who) return J({ ok: false, error: 'unauthorized' }, 401);
    const b = await readJson(req);
    return J(await stopCore(env, channelOf(b.channel), b.sessionId));
  }

  if (p === '/api/rt/listen' && m === 'POST') {
    const b = await readJson(req);
    const r = await listenCore(env, ctx, b.sdp, channelOf(b.channel));
    if (r.error) return J({ ok: false, error: r.error }, r.status);
    return J({ ok: true, ...r });
  }

  if (p === '/api/rt/renegotiate' && m === 'PUT') {
    const { sessionId, sdp } = await readJson(req);
    if (!sessionId || !sdp) return J({ ok: false, error: 'sessionId + sdp required' }, 400);
    const r = await rtc(env, `/sessions/${sessionId}/renegotiate`, { sessionDescription: { type: 'answer', sdp } }, 'PUT');
    return J({ ok: true, result: r });
  }

  if (p === '/api/rt/status') {
    const info = await realtimeInfo(env, qch);
    if (!info.ptr) return J({ ok: true, channel: qch, on_air: false, configured: info.configured });
    const q = info.ptr;
    let listeners = 0; try { listeners = parseInt((await env.LIVE.get('rtl:' + q.sessionId)) || '0', 10) || 0; } catch {}
    return J({ ok: true, channel: qch, on_air: !!info.alive, session: q.sessionId.slice(0, 8), via: q.via, by: q.by, started_at: q.started_at, label: q.label, title: q.title, message: q.message, listeners, tracks: q.tracks.length });
  }

  return J({ ok: false, error: 'not found' }, 404);
}

function linkHeader(s) {
  const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
  return urls.filter(Boolean).map(u => {
    let v = `<${u}>; rel="ice-server"`;
    if (s.username) v += `; username="${s.username}"; credential="${s.credential}"; credential-type="password"`;
    return v;
  }).join(', ');
}

// Listener snippet shared by the player + widget + self-check:
//   window.pitListenRT(audioEl, channel?) → Promise<RTCPeerConnection>   (JSON lane, renegotiation-aware)
//   window.pitListenWHEP(audioEl, channel?) → Promise<RTCPeerConnection> (standards lane)
export const LISTEN_JS = `(function(){
function B(){return window.__pitLiveBase||''}
function q(ch){return ch==='rehearsal'?'?channel=rehearsal':''}
async function ice(ch){try{var j=await fetch(B()+'/api/rt/ice'+q(ch),{cache:'no-store'}).then(function(r){return r.json()});if(j&&j.iceServers&&j.iceServers.length)return j.iceServers}catch(e){}return [{urls:'stun:stun.cloudflare.com:3478'}]}
function waitIce(pc){return new Promise(function(r){if(pc.iceGatheringState==='complete')return r();pc.onicegatheringstatechange=function(){if(pc.iceGatheringState==='complete')r()};setTimeout(r,1500)})}
async function mk(audioEl,ch){var pc=new RTCPeerConnection({iceServers:await ice(ch),bundlePolicy:'max-bundle'});pc.addTransceiver('audio',{direction:'recvonly'});pc.ontrack=function(e){audioEl.srcObject=e.streams[0]||new MediaStream([e.track]);var p=audioEl.play();if(p&&p.catch)p.catch(function(){})};var offer=await pc.createOffer();await pc.setLocalDescription(offer);await waitIce(pc);return pc}
window.pitListenRT=async function(audioEl,ch){
 var pc=await mk(audioEl,ch);
 var res=await fetch(B()+'/api/rt/listen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sdp:pc.localDescription.sdp,channel:ch==='rehearsal'?'rehearsal':'live'})}).then(function(r){return r.json()});
 if(!res.ok){try{pc.close()}catch(e){}throw new Error(res.error||'listen failed')}
 var sd=res.sessionDescription;
 if(sd&&sd.type==='answer'){await pc.setRemoteDescription(sd)}
 else if(sd&&sd.type==='offer'){await pc.setRemoteDescription(sd);var ans=await pc.createAnswer();await pc.setLocalDescription(ans);await fetch(B()+'/api/rt/renegotiate',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:res.sessionId,sdp:ans.sdp})})}
 return pc;
};
window.pitListenWHEP=async function(audioEl,ch){
 var pc=await mk(audioEl,ch);
 var r=await fetch(B()+'/whep'+q(ch),{method:'POST',headers:{'content-type':'application/sdp'},body:pc.localDescription.sdp});
 if(r.status!==201){var t=await r.text();try{pc.close()}catch(e){}throw new Error('whep '+r.status+': '+t.slice(0,100))}
 await pc.setRemoteDescription({type:'answer',sdp:await r.text()});
 pc.__whepResource=r.headers.get('location');
 return pc;
};
})();`;
