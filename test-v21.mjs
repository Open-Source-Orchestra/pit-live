// pit-live v2.1 end-to-end. PIT_BASE (default local dev), PIT_TX_FILE (transmitter key file), PIT_ADMIN_FILE (admin key, for revoke test).
// PIT_LIVE=0 skips the on-air step (use on PRODUCTION: rehearsal only, so 1,205 doors never light up for a test tone).
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const base = process.env.PIT_BASE || 'http://127.0.0.1:8787';
const TX = readFileSync(process.env.PIT_TX_FILE || '/tmp/.pit_local_tx', 'utf8').trim();
const ADMIN = process.env.PIT_ADMIN_FILE ? readFileSync(process.env.PIT_ADMIN_FILE, 'utf8').trim() : '';
const DO_LIVE = process.env.PIT_LIVE !== '0';
const DO_REVOKE = process.env.PIT_REVOKE === '1';
const results = []; const ok = (name, pass, info = '') => { results.push({ name, pass }); console.log((pass ? 'PASS' : 'FAIL'), name, info); };
const j = (u, o) => fetch(base + u, o).then(r => r.json());
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errs = [];
const watch = (pg, tag) => { pg.on('pageerror', e => errs.push(`[${tag}] ${e.message}`)); pg.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_FAILED|status of 404/.test(m.text()) && !(tag === 'wrongkey' && /status of 401/.test(m.text()))) errs.push(`[${tag} console] ${m.text()}`); }); };
async function inboundBytes(pg, ms = 5000) {
  await pg.waitForTimeout(ms);
  return pg.evaluate(async () => {
    const a = document.getElementById('audio'); if (!a || !a.srcObject) return { bytes: 0, note: 'no srcObject' };
    const pcs = window.__pcs || []; return { bytes: -1, tracks: a.srcObject.getAudioTracks().map(t => t.readyState) };
  });
}
// hook RTCPeerConnection so the test can read stats from any page
const hook = () => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const p = new O(...a); window.__pcs.push(p); return p; }; window.RTCPeerConnection.prototype = O.prototype; };
async function rxBytes(pg) { return pg.evaluate(async () => { let n = 0; for (const p of (window.__pcs || [])) { try { (await p.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') n += s.bytesReceived; }); } catch {} } return n; }); }
async function candType(pg) { return pg.evaluate(async () => { const out = []; for (const p of (window.__pcs || [])) { try { const st = await p.getStats(); let pair = null; st.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = st.get(s.selectedCandidatePairId); }); if (!pair) st.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; }); if (pair) { const l = st.get(pair.localCandidateId); out.push(l && (l.candidateType + '/' + (l.relayProtocol || l.protocol))); } } catch {} } return out; }); }

// A · wrong key → helpful hint
{
  const ctx = await b.newContext(); const pg = await ctx.newPage(); watch(pg, 'wrongkey');
  await pg.goto(base + '/broadcast', { waitUntil: 'domcontentloaded' });
  await pg.fill('#tok', 'cfut_FAKE_TEST'); await pg.click('#saveTok');
  await pg.waitForFunction(() => /Cloudflare/.test(document.getElementById('m1').textContent), null, { timeout: 8000 }).catch(() => {});
  ok('A wrong key → Cloudflare hint', /Cloudflare/.test(await pg.textContent('#m1')), JSON.stringify((await pg.textContent('#m1')).slice(0, 90)));
  await pg.fill('#tok', '"Bearer ' + TX + '"'); await pg.click('#saveTok');
  await pg.waitForSelector('#signedin:not(.hid)', { timeout: 8000 }).catch(() => {});
  ok('A2 messy paste ("Bearer <key>" in quotes) still signs in', !(await pg.$eval('#signedin', e => e.classList.contains('hid'))));
  await ctx.close();
}

// B · one-tap link
const ctx = await b.newContext(); await ctx.addInitScript(hook);
const pub = await ctx.newPage(); watch(pub, 'pub');
await pub.goto(base + '/broadcast#k=' + encodeURIComponent(TX), { waitUntil: 'domcontentloaded' });
await pub.waitForSelector('#signedin:not(.hid)', { timeout: 15000 }).catch(() => {});
ok('B #k= link signs in', !(await pub.$eval('#signedin', e => e.classList.contains('hid'))), JSON.stringify(await pub.textContent('#who')));
ok('B fragment wiped from the address bar', !(await pub.evaluate(() => location.hash)));
ok('B key remembered on this device', (await pub.evaluate(() => localStorage.getItem('pitlive_tx'))) === TX);

// C · rehearsal (doors stay dark)
await pub.click('#c-mic details summary'); await pub.click('#tone');
await pub.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 10000 });
ok('C default = rehearsal button', /REHEARSAL/.test(await pub.textContent('#go')));
await pub.click('#go');
await pub.waitForFunction(() => /REHEARSAL/.test(document.getElementById('state').textContent) || /✗/.test(document.getElementById('m4').textContent), null, { timeout: 20000 }).catch(() => {});
ok('C rehearsal connected', /REHEARSAL/.test(await pub.textContent('#state')), JSON.stringify(await pub.textContent('#m4')));
let st = await j('/api/rt/status?channel=rehearsal');
ok('C status(rehearsal) on_air + by', st.on_air === true && !!st.by, JSON.stringify({ on_air: st.on_air, by: st.by, via: st.via }));
let live = await j('/live.json?fresh=1');
ok('C doors stay DARK during rehearsal', live.live === false || live.live === undefined ? live.webrtc === false : false, JSON.stringify({ live: live.live, webrtc: live.webrtc }));
const lisR = await ctx.newPage(); watch(lisR, 'lisR');
await lisR.goto(base + '/?ch=rehearsal', { waitUntil: 'domcontentloaded' });
await lisR.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 15000 }).catch(() => {});
await lisR.click('#play'); await lisR.waitForTimeout(6000);
const rB = await rxBytes(lisR);
ok('C rehearsal listener hears it', rB > 2000, rB + ' bytes');
await lisR.close();

if (DO_LIVE) {
  // D · promote to ON AIR
  await pub.click('#golive');
  await pub.waitForFunction(() => document.getElementById('state').textContent === 'ON AIR' || /✗/.test(document.getElementById('m4').textContent), null, { timeout: 20000 }).catch(() => {});
  ok('D promoted → ON AIR', (await pub.textContent('#state')) === 'ON AIR', JSON.stringify(await pub.textContent('#m4')));
  st = await j('/api/rt/status?channel=rehearsal');
  ok('D rehearsal pointer cleared after promote', st.on_air === false && !st.session, JSON.stringify(st));
  live = await j('/live.json?fresh=1');
  ok('D live.json live+webrtc, rt.by', live.live === true && live.webrtc === true && !!(live.rt && live.rt.by), JSON.stringify({ live: live.live, webrtc: live.webrtc, rt: live.rt }));
  const lis = await ctx.newPage(); watch(lis, 'lis');
  await lis.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await lis.waitForFunction(() => !document.getElementById('play').disabled, null, { timeout: 20000 }).catch(() => {});
  await lis.click('#play'); await lis.waitForTimeout(6000);
  const rL = await rxBytes(lis);
  ok('D public listener hears it', rL > 2000, rL + ' bytes');
  await pub.click('#selfcheck'); await pub.waitForTimeout(7500);
  ok('D page self-check ✅', /✅/.test(await pub.textContent('#m4')), JSON.stringify((await pub.textContent('#m4')).slice(0, 100)));
  await lis.close();
}

// E · stop
await pub.click('#stop'); await pub.waitForTimeout(1500);
live = await j('/live.json?fresh=1'); st = await j('/api/rt/status'); const st2 = await j('/api/rt/status?channel=rehearsal');
ok('E stop → everything off', live.webrtc === false && st.on_air === false && st2.on_air === false, JSON.stringify({ live: live.live, webrtc: live.webrtc, s: st.on_air, r: st2.on_air }));

// F · relay-only (strict venue wifi): force TURN over TCP/TLS
{
  const pr = await ctx.newPage(); watch(pr, 'relay');
  await pr.goto(base + '/broadcast?relay=1', { waitUntil: 'domcontentloaded' });
  await pr.waitForSelector('#signedin:not(.hid)', { timeout: 10000 }).catch(() => {});
  await pr.click('#c-mic details summary'); await pr.click('#tone');
  await pr.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 10000 });
  await pr.click('#go');
  await pr.waitForFunction(() => /REHEARSAL/.test(document.getElementById('state').textContent) || /✗/.test(document.getElementById('m4').textContent), null, { timeout: 25000 }).catch(() => {});
  const ct = await candType(pr);
  ok('F relay-only transmitter connects through TURN', /REHEARSAL/.test(await pr.textContent('#state')) && ct.some(c => /^relay/.test(c)), JSON.stringify(ct));
  await pr.click('#stop'); await pr.waitForTimeout(1200); await pr.close();
}

// G · revoke (local only)
if (DO_REVOKE && ADMIN) {
  const nm = (await j('/api/rt/whoami', { headers: { authorization: 'Bearer ' + TX } })).name;
  const rv = await j('/api/keys?name=' + encodeURIComponent(nm), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });
  const w = await fetch(base + '/api/rt/whoami', { headers: { authorization: 'Bearer ' + TX } });
  ok('G revoked key → 401', rv.revoked === 1 && w.status === 401, JSON.stringify(rv));
}

ok('no page errors', errs.length === 0, errs.slice(0, 6).join(' | '));
await b.close();
const failed = results.filter(r => !r.pass).length;
console.log(failed ? `\n${failed} FAILED of ${results.length}` : `\nALL ${results.length} PASS`);
process.exitCode = failed ? 1 : 0;
