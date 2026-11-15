import { handleRealtime, realtimeInfo, isRtPath, BROADCAST_HTML, LISTEN_JS } from './realtime.js';
// pit-live — the LIVE PIT transponder.
// One tiny Worker + KV: /live.json (state), /widget.js (embed on any door), / (player), /broadcast (transmitter),
// /admin (mixer desk), POST /api/state (set state), /api/keys (transmitter keys), WHIP /whip + WHEP /whep.
// No trackers, no cookies, no analytics. Keys: ADMIN_TOKEN (secret, full power) + per-person transmitter keys
// (KV 'txkeys', stored only as SHA-256 hashes, scope 'tx' = go on air / stop / on-air text — nothing else).

const DEFAULT_STATE = {
  on_air: 'auto',            // true | false | 'auto' (probe sources + the WebRTC transmitter)
  title: 'LIVE PIT · Open Source Orchestra',
  subtitle: 'from the OSO PIT main mixer board · 4Seas · Zu Chiang Mai',
  now_playing: '',
  venue: 'Nomad Market I · 4Seas · Chiang Mai',
  sources: [],               // [{type:'hls'|'audio'|'webrtc'|'iframe', url, label}]
  mirrors: [],               // [{name,url}] friends carrying the same feed
  links: [
    { name: 'Open Source Orchestra', url: 'https://opensourceorchestra.org/' },
    { name: 'Join / play / host', url: 'https://opensourceorchestra.org/join/' },
    { name: 'Zu Chiang Mai agenda', url: 'https://zuchiangmai.app/' },
    { name: 'The PIT', url: 'https://zuchiangmai.app/pit/' }
  ],
  updated_at: null,
  started_at: null
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization'
};

async function readState(env) {
  const raw = await env.LIVE.get('state');
  if (!raw) return { ...DEFAULT_STATE };
  try { return { ...DEFAULT_STATE, ...JSON.parse(raw) }; } catch { return { ...DEFAULT_STATE }; }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra }
  });
}

function html(body, cache = 'public, max-age=60') {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'microphone=(self), camera=(), geolocation=()'
    }
  });
}

// ---------------------------------------------------------------- keys
const enc = new TextEncoder();
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  const A = enc.encode(a), B = enc.encode(b);
  if (A.length !== B.length) return false;
  return crypto.subtle.timingSafeEqual(A, B);
}
let KEYS = null; // per-isolate cache of KV 'txkeys' (30 s)
async function txKeys(env, fresh = false) {
  const now = Date.now();
  if (!fresh && KEYS && now - KEYS.at < 30000) return KEYS.v;
  let v = {};
  try { v = JSON.parse((await env.LIVE.get('txkeys')) || '{}') || {}; } catch { v = {}; }
  KEYS = { at: now, v };
  return v;
}
// → null | {role:'admin'|'tx', name}
async function auth(req, env) {
  const h = req.headers.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok || tok.length > 256) return null;
  if (env.ADMIN_TOKEN && safeEq(tok, env.ADMIN_TOKEN)) return { role: 'admin', name: 'admin' };
  const hit = (await txKeys(env))[await sha256hex(tok)];
  if (!hit || hit.revoked) return null;
  return { role: hit.scope === 'admin' ? 'admin' : 'tx', name: hit.name || 'transmitter' };
}
function newKey() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = ''; for (const x of b) s += A[x % A.length];
  return 'pit_tx_' + s;
}
async function keysApi(req, env, url, who) {
  if (!who || who.role !== 'admin') return json({ ok: false, error: 'admin key required' }, who ? 403 : 401);
  const keys = await txKeys(env, true);
  const list = () => Object.values(keys).map(k => ({ name: k.name, scope: k.scope, created: k.created, hint: k.hint }));
  if (req.method === 'GET') return json({ ok: true, keys: list() });
  if (req.method === 'POST') {
    let b = {}; try { b = await req.json(); } catch {}
    const name = String(b.name || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
    if (!name) return json({ ok: false, error: 'name required (letters, digits, . _ -)' }, 400);
    for (const [h, k] of Object.entries(keys)) if (k.name === name) delete keys[h]; // re-issue = rotate
    const key = newKey();
    keys[await sha256hex(key)] = { name, scope: 'tx', created: new Date().toISOString(), hint: key.slice(-4) };
    await env.LIVE.put('txkeys', JSON.stringify(keys)); KEYS = null;
    return json({ ok: true, name, key, link: `${url.origin}/broadcast#k=${key}`, note: 'shown once — only its hash is stored' });
  }
  if (req.method === 'DELETE') {
    const name = String(url.searchParams.get('name') || '').toLowerCase();
    let n = 0; for (const [h, k] of Object.entries(keys)) if (k.name === name) { delete keys[h]; n++; }
    await env.LIVE.put('txkeys', JSON.stringify(keys)); KEYS = null;
    return json({ ok: true, revoked: n, name });
  }
  return json({ ok: false, error: 'method not allowed' }, 405);
}

// Edge-side probe: is any source actually streaming right now? (no CORS problems here)
async function probeUrl(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-1023', 'user-agent': 'pit-live-probe/1.0' }, signal: ctl.signal, cf: { cacheTtl: 0 } });
    const ok = r.status === 200 || r.status === 206;
    try { ctl.abort(); } catch {}
    return ok;
  } catch { return false; } finally { clearTimeout(t); }
}

async function isLive(st) {
  if (st.on_air === true) return true;
  if (st.on_air === false) return false;
  const urls = (st.sources || []).filter(s => s && (s.type === 'audio' || s.type === 'hls') && s.url).map(s => s.url);
  if (!urls.length) return false;
  const r = await Promise.all(urls.map(probeUrl));
  return r.some(Boolean);
}

const ALLOWED = ['on_air', 'title', 'subtitle', 'now_playing', 'venue', 'sources', 'mirrors', 'links', 'started_at', 'support', 'credits', 'recordings', 'extensions'];
const LIVE_CK = 'https://live.zuchiangmai.app/__cache/live.json'; // micro-cache key (per data centre, 4 s)

async function liveJson(env, url) {
  const st = await readState(env);
  const [srcLive, rt] = await Promise.all([isLive(st), st.on_air === false ? { alive: false } : realtimeInfo(env)]);
  const rtLive = !!rt.alive;
  st.webrtc = rtLive;
  if (rtLive && rt.ptr) {
    st.rt = { label: rt.ptr.label || '', title: rt.ptr.title || '', message: rt.ptr.message || '', via: rt.ptr.via || 'browser', by: rt.ptr.by || '', started_at: rt.ptr.started_at };
    if (!st.now_playing) st.now_playing = rt.ptr.label || '';
    if (!st.started_at) st.started_at = rt.ptr.started_at;
  }
  st.whep = url.origin + '/whep';
  st.live = st.on_air === true ? true : st.on_air === false ? false : (srcLive || rtLive);
  return st;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const who = req.headers.has('authorization') ? await auth(req, env) : null;
    const bust = () => { try { ctx.waitUntil(caches.default.delete(LIVE_CK)); } catch {} };

    // Realtime lanes first (WHIP/WHEP need their own OPTIONS/PATCH/DELETE semantics)
    if (isRtPath(p)) {
      const r = await handleRealtime(req, env, ctx, p, who);
      if (req.method !== 'GET' && /publish|stop|whip|ingest/.test(p)) bust();
      return r;
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (p === '/api/keys') return keysApi(req, env, url, who);

    if (p === '/live.json' || p === '/api/state') {
      if (req.method === 'POST') {
        if (!who || who.role !== 'admin') return json({ ok: false, error: who ? 'this key can broadcast but not change the station — use the admin key' : 'unauthorized' }, who ? 403 : 401);
        let body;
        try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
        const cur = await readState(env);
        const next = { ...cur };
        for (const k of ALLOWED) if (k in body) next[k] = body[k];
        if (!Array.isArray(next.sources)) next.sources = [];
        if (!Array.isArray(next.mirrors)) next.mirrors = [];
        if (!Array.isArray(next.links)) next.links = DEFAULT_STATE.links;
        next.updated_at = new Date().toISOString();
        if (next.on_air === true && !next.started_at) next.started_at = next.updated_at;
        if (next.on_air === false) next.started_at = null;
        await env.LIVE.put('state', JSON.stringify(next));
        bust();
        return json({ ok: true, state: next });
      }
      const fresh = url.searchParams.has('fresh');
      if (!fresh) { try { const hit = await caches.default.match(LIVE_CK); if (hit) return hit; } catch {} }
      const st = await liveJson(env, url);
      const res = json(st, 200, { 'cache-control': 'public, max-age=4' });
      try { ctx.waitUntil(caches.default.put(LIVE_CK, res.clone())); } catch {}
      return res;
    }

    if (p === '/widget.js') {
      return new Response(WIDGET_JS, {
        headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=120', ...CORS }
      });
    }

    if (p === '/broadcast' || p === '/transmit') return html(BROADCAST_HTML, 'no-store');
    if (p === '/listen.js') return new Response(LISTEN_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=120', ...CORS } });

    if (p === '/health') return json({ ok: true, service: 'pit-live', version: '2.1', time: new Date().toISOString() });

    if (p === '/admin') return html(ADMIN_HTML, 'no-store');

    if (p === '/' || p === '/index.html') return html(PLAYER_HTML, 'public, max-age=60');

    if (p === '/robots.txt') return new Response('User-agent: *\nDisallow: /broadcast\nDisallow: /admin\nAllow: /\n', { headers: { 'content-type': 'text/plain' } });

    return new Response('not found', { status: 404 });
  }
};

// ---------------------------------------------------------------- PLAYER
const PLAYER_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LIVE PIT · Open Source Orchestra · live from Zu Chiang Mai</title>
<meta name="description" content="Live radio from the Open Source Orchestra PIT — the floor, not the stage. Main mixer board feed from 4Seas, Zu Chiang Mai. Free, open, no login.">
<meta property="og:title" content="LIVE PIT · Open Source Orchestra">
<meta property="og:description" content="Tune in: live from the OSO PIT main mixer board at 4Seas, Zu Chiang Mai. The floor, not the stage.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://live.zuchiangmai.app/">
<link rel="alternate" type="application/json" href="/live.json">
<style>
:root{--bg:#07060a;--fg:#f4efe6;--dim:#a79f93;--hot:#ff3b3b;--gold:#e8b84a;--card:#141019}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:clamp(28px,7vw,48px);margin:8px 0 4px;letter-spacing:.5px}
.sub{color:var(--dim);margin:0 0 22px}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:#1d1920;color:var(--dim);font-weight:600;letter-spacing:1px;font-size:13px}
.badge .dot{width:10px;height:10px;border-radius:50%;background:#555}
.badge.on{background:#2a0b0b;color:#ffd1d1}.badge.on .dot{background:var(--hot);box-shadow:0 0 0 0 rgba(255,59,59,.7);animation:pulse 1.6s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,59,59,.7)}70%{box-shadow:0 0 0 12px rgba(255,59,59,0)}100%{box-shadow:0 0 0 0 rgba(255,59,59,0)}}
@media (prefers-reduced-motion:reduce){.badge.on .dot{animation:none}}
.card{background:var(--card);border:1px solid #241e2b;border-radius:18px;padding:18px;margin:16px 0}
button.big{width:100%;font:inherit;font-size:22px;font-weight:700;padding:18px;border-radius:14px;border:0;background:var(--gold);color:#1b1405;cursor:pointer}
button.big[disabled]{opacity:.5;cursor:default}
video,audio{width:100%;border-radius:12px;background:#000;margin-top:14px}
video:not([src]):not(.has){display:none}
.np{font-size:18px;margin-top:10px;color:var(--fg)}
.meta{color:var(--dim);font-size:14px}
ul{padding-left:18px}a{color:var(--gold)}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.row a,.row button{font:inherit;font-size:14px;padding:8px 12px;border-radius:999px;border:1px solid #3a3242;background:transparent;color:var(--fg);text-decoration:none;cursor:pointer}
.stat{font-variant-numeric:tabular-nums}
footer{color:var(--dim);font-size:13px;margin-top:28px;border-top:1px solid #241e2b;padding-top:14px}
.hidden{display:none!important}
</style></head>
<body><main>
<div id="badge" class="badge"><span class="dot"></span><span id="badgeText">TUNING…</span></div>
<h1 id="title">LIVE PIT</h1>
<p class="sub" id="subtitle">from the OSO PIT main mixer board · 4Seas · Zu Chiang Mai</p>

<div class="card">
  <button class="big" id="play" disabled>▶ Tune in</button>
  <video id="video" playsinline controls preload="none"></video>
  <audio id="audio" controls preload="none" class="hidden"></audio>
  <div class="np" id="np"></div>
  <div class="meta" id="meta"></div>
  <div class="row">
    <button id="share" type="button">Share this door</button>
    <a id="raw" href="#" target="_blank" rel="noopener" class="hidden">Open raw stream</a>
    <a href="/live.json" target="_blank" rel="noopener">live.json</a>
  </div>
</div>

<div class="card" id="offcard">
  <strong>Off air right now.</strong>
  <p class="meta">This door stays open. When the PIT mixer board goes live, this page wakes up by itself (it re-checks every 15 s). Nomad Market I · 4Seas · Chiang Mai · music from 18:10 local.</p>
</div>

<div class="card hidden" id="mirrorsCard"><strong>Also carried by friends</strong><ul id="mirrors"></ul></div>

<div class="card"><strong>Doors</strong><ul id="links"></ul></div>

<footer>
<p>The Open Source Orchestra PIT is the floor, not the stage. Everything here is a public good — fork it, host it, carry the feed: <a href="https://opensourceorchestra.org/join/">opensourceorchestra.org/join/</a>. No login, no tracking, no cookies.</p>
<p>Carry this on your own site with one line: <code>&lt;script src="https://live.zuchiangmai.app/widget.js" async&gt;&lt;/script&gt;</code></p>
<p>Built on LIVE PIT by Open Source Orchestra: Shaka Lei Kaumaka &amp; the AI ʻohana · code <a href="https://github.com/Open-Source-Orchestra/pit-live">AGPL-3.0 source</a> · words CC BY-SA 4.0 · forks keep this credit and stay open.</p>
</footer>
</main>
<script>
(function(){
  var S=null, hls=null, rtpc=null, playing=false, probeTimer=null, curSess=null;
  var CH=/[?&]ch=rehearsal/.test(location.search)?'rehearsal':'live';
  var $=function(id){return document.getElementById(id)};
  var badge=$('badge'),bt=$('badgeText'),play=$('play'),video=$('video'),audio=$('audio');
  function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function pick(st){var s=st.sources||[];var v=s.filter(function(x){return x.type==='hls'||x.type==='webrtc'})[0];var a=s.filter(function(x){return x.type==='audio'})[0];var f=s.filter(function(x){return x.type==='iframe'})[0];return {video:v,audio:a,iframe:f}}
  function render(st,live){
    S=st;document.title=(live?'🔴 ':'')+(st.title||'LIVE PIT')+' · Open Source Orchestra';
    $('title').textContent=st.title||'LIVE PIT';$('subtitle').textContent=st.subtitle||'';
    $('np').textContent=st.now_playing?('♫ '+st.now_playing):'';
    $('meta').textContent=(st.venue||'')+(st.started_at&&live?(' · on air since '+new Date(st.started_at).toLocaleTimeString()):'');
    badge.className='badge'+(live?' on':'');bt.textContent=live?'ON AIR':'OFF AIR';
    $('offcard').classList.toggle('hidden',!!live);
    var p=pick(st);var any=p.video||p.audio||p.iframe;
    any=any||st.webrtc;play.disabled=!(live&&any);if(!playing)play.textContent=live?(p.video?'▶ Watch & listen':'▶ Listen'):'Off air';
    var raw=$('raw');if(p.audio||p.video||p.iframe){raw.href=(p.audio||p.video||p.iframe).url;raw.classList.remove('hidden')}else raw.classList.add('hidden');
    var L=$('links');L.innerHTML=(st.links||[]).map(function(l){return '<li><a href="'+esc(l.url)+'" rel="noopener">'+esc(l.name)+'</a></li>'}).join('');
    var M=$('mirrors');var ms=st.mirrors||[];$('mirrorsCard').classList.toggle('hidden',!ms.length);M.innerHTML=ms.map(function(l){return '<li><a href="'+esc(l.url)+'" rel="noopener" target="_blank">'+esc(l.name)+'</a></li>'}).join('');
  }
  function decide(st){return Promise.resolve(st.on_air===true?true:st.on_air===false?false:!!st.live)}
  function sessOf(st){return (st.rt&&st.rt.started_at)||st.session||null}
  function after(st,live){render(st,live);if(!live&&playing){stop();return}
    var s=sessOf(st);if(playing&&rtpc&&((curSess&&s&&s!==curSess)||/failed|closed/.test(rtpc.connectionState))){stop();start()}curSess=s}
  function tick(){
    if(CH==='rehearsal'){fetch('/api/rt/status?channel=rehearsal',{cache:'no-store'}).then(function(r){return r.json()}).then(function(q){var on=!!q.on_air;after({title:'LIVE PIT · rehearsal',subtitle:'unlisted sound check · not on the doors · anyone with this link can listen',now_playing:q.label||'',venue:q.by?('transmitter: '+q.by):'',webrtc:on,session:q.session,started_at:q.started_at,links:[],mirrors:[],sources:[]},on)}).catch(function(){bt.textContent='OFFLINE?'});return}
    fetch('/live.json',{cache:'no-store'}).then(function(r){return r.json()}).then(function(st){return decide(st).then(function(live){after(st,live)})}).catch(function(){bt.textContent='OFFLINE?'});
  }
  function stop(){playing=false;if(rtpc){try{rtpc.close()}catch(e){}rtpc=null;audio.srcObject=null}if(hls){hls.destroy();hls=null}video.pause();video.removeAttribute('src');video.classList.remove('has');video.load();audio.pause();audio.removeAttribute('src');audio.classList.add('hidden');audio.load();play.textContent='▶ Tune in'}
  function loadHls(){return new Promise(function(res,rej){if(window.Hls)return res();var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s)})}
  function start(){
    var p=pick(S);
    if(S.webrtc){audio.classList.remove('hidden');playing=true;play.textContent='■ Stop';var go=function(){window.pitListenRT(audio,CH).then(function(c){rtpc=c;curSess=sessOf(S)}).catch(function(e){if(p.audio)playAudio(p.audio);else{play.textContent='▶ Tune in';playing=false}})};if(window.pitListenRT)go();else{var sc=document.createElement('script');sc.src='/listen.js';sc.onload=go;document.head.appendChild(sc)}return;}
    if(p.video&&p.video.type==='hls'){
      video.classList.add('has');
      if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=p.video.url;video.play().catch(function(){})}
      else loadHls().then(function(){hls=new Hls({lowLatencyMode:true,liveSyncDurationCount:3});hls.loadSource(p.video.url);hls.attachMedia(video);hls.on(Hls.Events.MANIFEST_PARSED,function(){video.play().catch(function(){})});hls.on(Hls.Events.ERROR,function(e,d){if(d.fatal&&p.audio){stop();playAudio(p.audio)}})}).catch(function(){if(p.audio)playAudio(p.audio)});
      playing=true;play.textContent='■ Stop';return;
    }
    if(p.audio){playAudio(p.audio);return}
    if(p.iframe){window.open(p.iframe.url,'_blank','noopener');return}
  }
  function playAudio(a){audio.classList.remove('hidden');audio.src=a.url+(a.url.indexOf('?')<0?'?':'&')+'t='+Date.now();audio.play().catch(function(){});playing=true;play.textContent='■ Stop'}
  play.addEventListener('click',function(){playing?stop():start()});
  $('share').addEventListener('click',function(){var d={title:'LIVE PIT · Open Source Orchestra',text:'Tune in: live from the OSO PIT at Zu Chiang Mai',url:location.origin+'/'};if(navigator.share){navigator.share(d).catch(function(){})}else{navigator.clipboard&&navigator.clipboard.writeText(d.url);this.textContent='Link copied'}});
  tick();probeTimer=setInterval(tick,CH==='rehearsal'?5000:15000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)tick()});
})();
</script>
</body></html>`;

// ---------------------------------------------------------------- WIDGET
const WIDGET_JS = `(function(){
if(window.__pitLive)return;window.__pitLive=1;
var BASE='https://live.zuchiangmai.app';window.__pitLiveBase=BASE;var el=null,audio=null,st=null,on=false;
function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function pick(s){var a=(s.sources||[]).filter(function(x){return x.type==='audio'})[0];var v=(s.sources||[]).filter(function(x){return x.type==='hls'})[0];return {audio:a,video:v}}
function decide(s){return Promise.resolve(s.on_air===true?true:s.on_air===false?false:!!s.live)}
function mount(){
 if(el)return;el=document.createElement('div');el.id='pit-live-widget';
 el.setAttribute('style','position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:560px;margin:0 auto;background:#120c0c;color:#ffe9e9;border:1px solid #5a1b1b;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;gap:10px;padding:10px 12px');
 el.innerHTML='<span style="width:10px;height:10px;border-radius:50%;background:#ff3b3b;flex:none;box-shadow:0 0 10px #ff3b3b"></span><a id="plw-link" href="'+BASE+'/" target="_blank" rel="noopener" style="color:#ffe9e9;text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><strong>LIVE PIT</strong> <span id="plw-t"></span></a><button id="plw-play" type="button" style="font:inherit;font-weight:700;background:#e8b84a;color:#1b1405;border:0;border-radius:999px;padding:6px 12px;cursor:pointer">▶ Listen</button><button id="plw-x" type="button" aria-label="hide" style="font:inherit;background:transparent;color:#caa;border:0;cursor:pointer;padding:4px 6px">✕</button>';
 document.body.appendChild(el);
 el.querySelector('#plw-x').onclick=function(){el.remove();el=null;try{sessionStorage.setItem('pitlive_hide','1')}catch(e){}};
 el.querySelector('#plw-play').onclick=toggle;
}
var rtpc=null,sess=null;
function toggle(){var b=el.querySelector('#plw-play');var p=pick(st);
 if(audio){audio.pause();audio.src='';audio.srcObject=null;audio=null;if(rtpc){try{rtpc.close()}catch(e){}rtpc=null}b.textContent='▶ Listen';return}
 if(st.webrtc){audio=new Audio();b.textContent='…';var go=function(){window.pitListenRT(audio).then(function(c){rtpc=c;b.textContent='■ Stop'}).catch(function(){window.open(BASE+'/','_blank','noopener');b.textContent='▶ Listen'})};if(window.pitListenRT)go();else{var sc=document.createElement('script');sc.src=BASE+'/listen.js';sc.onload=go;document.head.appendChild(sc)}return}
 if(p.audio){audio=new Audio(p.audio.url+(p.audio.url.indexOf('?')<0?'?':'&')+'t='+Date.now());audio.play().catch(function(){window.open(BASE+'/','_blank','noopener')});b.textContent='■ Stop';return}
 window.open(BASE+'/','_blank','noopener');
}
function tick(){try{if(sessionStorage.getItem('pitlive_hide'))return}catch(e){}
 fetch(BASE+'/live.json',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){st=s;return decide(s)}).then(function(live){on=live;var ss=(st.rt&&st.rt.started_at)||null;if(live){mount();el.querySelector('#plw-t').textContent='· '+((st.rt&&st.rt.message)||st.now_playing||st.subtitle||'');if(audio&&rtpc&&((sess&&ss&&ss!==sess)||/failed|closed/.test(rtpc.connectionState))){toggle();toggle()}}else if(el&&!audio){el.remove();el=null}sess=ss}).catch(function(){});
}
tick();setInterval(tick,20000);
})();`;

// ---------------------------------------------------------------- ADMIN
const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>LIVE PIT · mixer desk</title>
<style>body{font:16px system-ui,sans-serif;background:#0b0a0e;color:#f2eee6;margin:0;padding:18px;max-width:640px;margin:auto}label{display:block;margin:12px 0 4px;color:#b7afa3}input,textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border-radius:10px;border:1px solid #333;background:#15121a;color:#fff}.sec{-webkit-text-security:disc}button{font:inherit;font-weight:700;padding:14px;border-radius:12px;border:0;cursor:pointer;width:100%;margin-top:10px}.on{background:#ff3b3b;color:#fff}.off{background:#444;color:#fff}.save{background:#e8b84a;color:#1b1405}#msg,.m{margin-top:10px;color:#a79f93;font-size:14px}#who{color:#9fe}textarea{min-height:110px;font-family:ui-monospace,monospace;font-size:13px}a{color:#e8b84a}h3{margin:28px 0 4px}.krow{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2a2433;font-variant-numeric:tabular-nums}.mini{width:auto;padding:6px 12px;margin:0;background:#2a2633;color:#eee;font-size:13px}</style></head>
<body><h2>🎚️ LIVE PIT · mixer desk</h2>
<p class="m">Station settings, the kill switch, and who may transmit. To broadcast, open <a href="/broadcast">/broadcast</a>.</p>
<label for="tok">Admin key</label><input id="tok" type="text" class="sec" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="paste once · stays on this device">
<div id="who" class="m"></div>
<label>Title</label><input id="title">
<label>Subtitle</label><input id="subtitle">
<label>Now playing</label><input id="now_playing" placeholder="who is on the floor right now">
<label>Venue</label><input id="venue">
<label>Sources (JSON array: type hls|audio|iframe, url, label)</label><textarea id="sources"></textarea>
<label>Mirrors (JSON array: name, url)</label><textarea id="mirrors"></textarea>
<label>On air</label><select id="on_air"><option value="auto">auto (the transmitter or a live source decides)</option><option value="true">ON AIR (forced)</option><option value="false">OFF AIR (kill switch: hides every door, whatever is transmitting)</option></select>
<button class="save" id="save">Save</button>
<button class="on" id="goauto">↺ back to AUTO</button>
<button class="off" id="gooff">⏹ KILL SWITCH · off air on every door</button>
<div id="msg"></div>
<h3>Transmitter keys</h3>
<p class="m">One key per person. A transmitter key can go on air, stop, and change the on-air text. It cannot change these settings. Only a hash is stored, so the key is shown once. Revoke any time.</p>
<div id="keys" class="m"></div>
<label for="kname">New key for (name)</label><input id="kname" placeholder="e.g. shaka, aakaash, 4seas-pit">
<button class="save" id="mk" type="button">Create key + one-tap sign-in link</button>
<div id="kout" class="m"></div>
<p class="m">Built on LIVE PIT by Open Source Orchestra: Shaka Lei Kaumaka &amp; the AI ʻohana · <a href="https://github.com/Open-Source-Orchestra/pit-live">AGPL-3.0 source</a> · <a href="https://github.com/Open-Source-Orchestra/pit-live/blob/main/PROTOCOL.md">operating protocol</a></p>
<script>
var F=['title','subtitle','now_playing','venue'];var $=function(i){return document.getElementById(i)};
function getTok(){try{var h=location.hash.match(/[#&]k=([^&]+)/);if(h){var t=decodeURIComponent(h[1]);localStorage.setItem('pitlive_admin',t);history.replaceState(null,'',location.pathname);return t}return localStorage.getItem('pitlive_admin')||''}catch(e){return ''}}
$('tok').value=getTok();
function H(){var t=$('tok').value.trim().replace(/^bearer[ ]+/i,'');try{localStorage.setItem('pitlive_admin',t)}catch(e){}return {'content-type':'application/json','authorization':'Bearer '+t}}
function who(){if(!$('tok').value.trim()){$('who').textContent='paste the admin key';return}fetch('/api/rt/whoami',{headers:H()}).then(function(r){return r.json()}).then(function(j){$('who').textContent=j.ok?('✓ signed in as '+j.name+' ('+j.role+')'+(j.role!=='admin'?' · this key can broadcast but cannot change the station':'')):'✗ key not accepted';if(j.ok&&j.role==='admin')keys()}).catch(function(e){$('who').textContent='network: '+e.message})}
$('tok').addEventListener('change',who);
fetch('/live.json?fresh=1',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){F.forEach(function(k){$(k).value=s[k]||''});$('sources').value=JSON.stringify(s.sources||[],null,1);$('mirrors').value=JSON.stringify(s.mirrors||[],null,1);$('on_air').value=String(s.on_air)});
function body(extra){var b={};F.forEach(function(k){b[k]=$(k).value});try{b.sources=JSON.parse($('sources').value||'[]');b.mirrors=JSON.parse($('mirrors').value||'[]')}catch(e){$('msg').textContent='JSON error: '+e.message;return null}var oa=$('on_air').value;b.on_air=oa==='true'?true:oa==='false'?false:'auto';return Object.assign(b,extra||{})}
function send(b){if(!b)return;fetch('/api/state',{method:'POST',headers:H(),body:JSON.stringify(b)}).then(function(r){return r.json()}).then(function(j){$('msg').textContent=j.ok?('saved · on_air='+j.state.on_air+' · '+j.state.updated_at):('✗ '+j.error);if(j.ok){$('on_air').value=String(j.state.on_air)}}).catch(function(e){$('msg').textContent='network error '+e})}
$('save').onclick=function(){send(body())};$('goauto').onclick=function(){send(body({on_air:'auto'}))};$('gooff').onclick=function(){send(body({on_air:false}))};
function keys(){fetch('/api/keys',{headers:H()}).then(function(r){return r.json()}).then(function(j){var K=$('keys');K.innerHTML='';if(!j.ok){K.textContent='';return}
 j.keys.forEach(function(k){var d=document.createElement('div');d.className='krow';var t=document.createElement('span');t.textContent=k.name+' · …'+(k.hint||'')+' · since '+String(k.created||'').slice(0,10);var b=document.createElement('button');b.className='mini';b.type='button';b.textContent='revoke';b.onclick=function(){if(!confirm('Revoke the transmitter key for '+k.name+'?'))return;fetch('/api/keys?name='+encodeURIComponent(k.name),{method:'DELETE',headers:H()}).then(function(){keys()})};d.appendChild(t);d.appendChild(b);K.appendChild(d)});
 if(!j.keys.length)K.textContent='no transmitter keys yet'})}
$('mk').onclick=function(){var n=$('kname').value.trim();if(!n)return;fetch('/api/keys',{method:'POST',headers:H(),body:JSON.stringify({name:n})}).then(function(r){return r.json()}).then(function(j){var o=$('kout');o.innerHTML='';if(!j.ok){o.textContent='✗ '+j.error;return}var a=document.createElement('a');a.href=j.link;a.textContent='📋 copy the sign-in link for '+j.name+' (shown once)';a.onclick=function(e){e.preventDefault();if(navigator.clipboard)navigator.clipboard.writeText(j.link);a.textContent='✓ copied · send it privately (a DM, not a group)'};o.appendChild(a);$('kname').value='';keys()})};
who();
</script></body></html>`;
