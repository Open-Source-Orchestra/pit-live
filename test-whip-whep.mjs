// Standards check: publish with WHIP (as OBS would), pull with WHEP (as any WHEP player would), DELETE the WHIP resource.
// Default channel = rehearsal (doors stay dark). PIT_CH=live to test the public air. PIT_TX_FILE = transmitter key.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const TOK = readFileSync(process.env.PIT_TX_FILE || '/workspace/vault/pit-live/tx-office-test', 'utf8').trim();
const base = process.env.PIT_BASE || 'https://live.zuchiangmai.app';
const CHQ = process.env.PIT_CH === 'live' ? '' : '?channel=rehearsal';
const res = []; const ok = (n, p, i = '') => { res.push(p); console.log(p ? 'PASS' : 'FAIL', n, i); };
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const pg = await b.newPage();
await pg.goto(base + '/robots.txt');

const opt = await fetch(base + '/whip', { method: 'OPTIONS' });
ok('OPTIONS /whip advertises application/sdp + ICE', opt.status === 204 && opt.headers.get('accept-post') === 'application/sdp', `${opt.status} ${opt.headers.get('link')}`);
const noauth = await fetch(base + '/whip' + CHQ, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: 'v=0\r\n' });
ok('POST /whip without key → 401 + WWW-Authenticate', noauth.status === 401 && /Bearer/.test(noauth.headers.get('www-authenticate') || ''));

const whip = await pg.evaluate(async (o) => {
  const ice = (pc) => new Promise(r => { if (pc.iceGatheringState === 'complete') r(); else { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); }; setTimeout(r, 1500); } });
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  pc.addTransceiver(s.getAudioTracks()[0], { direction: 'sendonly' });
  await pc.setLocalDescription(await pc.createOffer()); await ice(pc);
  const r = await fetch(o.base + '/whip' + (o.CHQ ? o.CHQ + '&' : '?') + 'label=whip-test', { method: 'POST', headers: { 'content-type': 'application/sdp', authorization: 'Bearer ' + o.tok }, body: pc.localDescription.sdp });
  const txt = await r.text();
  if (r.status !== 201) return { status: r.status, txt: txt.slice(0, 200) };
  await pc.setRemoteDescription({ type: 'answer', sdp: txt });
  window.__whip = pc;
  await new Promise(r => setTimeout(r, 3000));
  return { status: r.status, location: r.headers.get('location'), etag: r.headers.get('etag'), turnInLink: /turn:/.test(r.headers.get('link') || ''), state: pc.connectionState };
}, { base, tok: TOK, CHQ });
ok('WHIP publish 201 + Location + connected', whip.status === 201 && !!whip.location && whip.state === 'connected', JSON.stringify(whip));
const st1 = await fetch(base + '/api/rt/status' + CHQ).then(r => r.json());
ok('status shows the WHIP transmitter', st1.on_air === true && st1.via === 'whip', JSON.stringify({ on_air: st1.on_air, via: st1.via, by: st1.by }));
if (CHQ) { const lj = await fetch(base + '/live.json?fresh=1').then(r => r.json()); ok('doors stay dark (rehearsal)', lj.webrtc === false, JSON.stringify({ live: lj.live, webrtc: lj.webrtc })); }

const whep = await pg.evaluate(async (o) => {
  const ice = (pc) => new Promise(r => { if (pc.iceGatheringState === 'complete') r(); else { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); }; setTimeout(r, 1500); } });
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  let got = 0; pc.ontrack = () => { got++; };
  await pc.setLocalDescription(await pc.createOffer()); await ice(pc);
  const r = await fetch(o.base + '/whep' + o.CHQ, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp });
  const txt = await r.text();
  if (r.status !== 201) return { status: r.status, txt: txt.slice(0, 200) };
  await pc.setRemoteDescription({ type: 'answer', sdp: txt });
  await new Promise(r => setTimeout(r, 5000));
  let bytes = 0; (await pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes = s.bytesReceived; });
  const st = pc.connectionState; pc.close();
  return { status: r.status, location: r.headers.get('location'), state: st, tracks: got, bytesIn5s: bytes };
}, { base, CHQ });
ok('WHEP play 201 + audio bytes', whep.status === 201 && whep.bytesIn5s > 2000, JSON.stringify(whep));

if (whip.location) {
  const del = await fetch(base + whip.location, { method: 'DELETE' });
  ok('DELETE WHIP resource → off', del.status === 200, (await del.text()).slice(0, 120));
}
await new Promise(r => setTimeout(r, 1000));
const st2 = await fetch(base + '/api/rt/status' + CHQ).then(r => r.json());
ok('status off after DELETE', st2.on_air === false, JSON.stringify(st2));
const stale = await fetch(base + '/whip/not-a-session', { method: 'DELETE' });
ok('DELETE unknown id is harmless', stale.status === 200, (await stale.text()).slice(0, 80));
await b.close();
const f = res.filter(x => !x).length; console.log(f ? `\n${f} FAILED of ${res.length}` : `\nALL ${res.length} PASS`); process.exitCode = f ? 1 : 0;
