// pit-live widget.js — hidden-tab etiquette (28 Nov 2026, "flow like water" mobile pass).
// The embed widget (https://live.zuchiangmai.app/widget.js, on every door) used to poll /live.json every 20 s FOREVER, even in a hidden tab
// (a radio wake-up every 20 s on a phone). Now: no poll while document.hidden (unless audio is playing — a listener must keep following the
// session), an immediate catch-up poll on visibilitychange→visible, a 4 s minimum gap, and the SAME 20 s cadence while visible.
//
//   node qa/test-widget-visibility.mjs                      # widget text from PIT_BASE (default local `wrangler dev`, http://127.0.0.1:8787)
//   PIT_BASE=https://live.zuchiangmai.app node qa/test-widget-visibility.mjs        # the SERVED bytes
//   PIT_DOOR=https://shakaleikaumaka.com/ node qa/test-widget-visibility.mjs        # + a REAL door loads the real widget; only /live.json is routed locally
// Nothing here talks to the real live state: /live.json is ALWAYS fulfilled locally by Playwright (never published, never broadcast).
import { chromium } from 'playwright';

const base = process.env.PIT_BASE || 'http://127.0.0.1:8787';
const DOOR = process.env.PIT_DOOR || '';
const WIDGET = await (await fetch(base + '/widget.js')).text();
const results = [];
const ok = (name, pass, info = '') => { results.push({ name, pass }); console.log(pass ? 'PASS' : 'FAIL', name, info); };

// the real shape of /live.json (copied from the live Worker, 28 Nov 2026); on_air:true = the widget's "on air" branch
const OFF = { on_air: 'auto', title: 'LIVE PIT', subtitle: 'test', now_playing: '', venue: 'test', sources: [], mirrors: [], links: [], live: false, rt: null, webrtc: false };
const ON = { ...OFF, on_air: true, live: true, now_playing: 'local route · nothing is broadcast', sources: [{ type: 'audio', url: 'https://door.test/tone.wav', label: 'tone' }] };
// 0.1 s of silence, valid 8 kHz mono 8-bit WAV
const wav = (() => { const n = 800, b = Buffer.alloc(44 + n, 128); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; })();

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errs = [];

async function mk({ state = OFF, door = false, hiddenAtStart = false, preHide = false, clock = true } = {}) {
  const ctx = await browser.newContext();
  const st = { n: 0, state, urls: [] };
  await ctx.route('https://live.zuchiangmai.app/live.json*', r => { st.n++; st.urls.push(r.request().url()); r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, body: JSON.stringify(st.state) }); });
  await ctx.route('https://door.test/tone.wav*', r => r.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'access-control-allow-origin': '*' }, body: wav }));
  if (!door) await ctx.route('https://door.test/', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset=utf-8><title>door</title><body><p>a door</p>' }));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  // a controllable document.hidden (Playwright's headless page is always "visible"; the widget only reads document.hidden)
  await page.addInitScript(h0 => { window.__h = h0; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__h }); window.__vis = h => { window.__h = h; document.dispatchEvent(new Event('visibilitychange')); }; }, hiddenAtStart);
  if (preHide) await page.addInitScript(() => { try { sessionStorage.setItem('pitlive_hide', '1'); } catch (e) {} });
  if (clock) await page.clock.install({ time: 1800000000000 });   // a realistic Date.now(): the widget's 4 s gap guard compares Date.now() values
  return { ctx, page, st };
}
const settle = page => page.waitForTimeout(120);                          // let fetch().then() chains finish (real time)
const run = async (page, ms) => { await page.clock.runFor(ms); await settle(page); };

// ── S1 visible: 1 poll at load, then the SAME 20 s cadence (100 s → 6 polls total)
{ const { ctx, page, st } = await mk(); await page.goto('https://door.test/');
  await page.addScriptTag({ content: WIDGET }); await settle(page);
  ok('S1 visible: one poll at load', st.n === 1, `n=${st.n}`);
  for (let i = 0; i < 5; i++) await run(page, 20000);
  ok('S1 visible: 20 s cadence kept (6 polls in 100 s)', st.n === 6, `n=${st.n}`);
  await ctx.close(); }

// ── S2 hidden from the start, nobody listening: zero polls in 2 minutes
{ const { ctx, page, st } = await mk({ hiddenAtStart: true }); await page.goto('https://door.test/');
  await page.addScriptTag({ content: WIDGET }); await settle(page);
  for (let i = 0; i < 6; i++) await run(page, 20000);
  ok('S2 hidden: no poll at load and none in 120 s', st.n === 0, `n=${st.n}`);
  await page.evaluate(() => window.__vis(false)); await settle(page);
  ok('S2 hidden→visible: immediate catch-up poll (exactly one)', st.n === 1, `n=${st.n}`);
  await run(page, 20000);
  ok('S2 after catch-up the 20 s cadence resumes', st.n === 2, `n=${st.n}`);
  await ctx.close(); }

// ── S3 visible → hidden → visible
{ const { ctx, page, st } = await mk(); await page.goto('https://door.test/');
  await page.addScriptTag({ content: WIDGET }); await settle(page); await run(page, 20000);
  const before = st.n;
  await page.evaluate(() => window.__vis(true));
  for (let i = 0; i < 5; i++) await run(page, 20000);
  ok('S3 hidden for 100 s: zero new polls', st.n === before, `before=${before} now=${st.n}`);
  await page.evaluate(() => window.__vis(false)); await settle(page);
  ok('S3 back to visible: immediate poll', st.n === before + 1, `n=${st.n}`);
  await ctx.close(); }

// ── S4 flip storm: 6 hidden/visible flips inside one second → at most one poll (4 s minimum gap)
{ const { ctx, page, st } = await mk(); await page.goto('https://door.test/');
  await page.addScriptTag({ content: WIDGET }); await settle(page); await run(page, 20000);
  const before = st.n;
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.__vis(true)); await page.evaluate(() => window.__vis(false)); await run(page, 100); }
  ok('S4 flip storm: ≤ 1 poll inside 1 s', st.n - before <= 1, `polls=${st.n - before}`);
  await ctx.close(); }

// ── S5 ON AIR still shows; listening in a hidden tab keeps polling (a listener must follow the session); a hidden tab with a stale bar clears on return
{ const { ctx, page, st } = await mk({ state: ON }); await page.goto('https://door.test/');
  await page.addScriptTag({ content: WIDGET }); await settle(page);
  const bar = await page.evaluate(() => { const e = document.getElementById('pit-live-widget'); return e ? e.textContent : null; });
  ok('S5 on air: the ON AIR bar mounts', !!bar && /LIVE PIT/.test(bar), String(bar).slice(0, 60));
  await page.click('#plw-play'); await settle(page);
  const label = await page.evaluate(() => document.getElementById('plw-play').textContent);
  ok('S5 ▶ Listen starts the stream (button says Stop)', /Stop/.test(label), label);
  await page.evaluate(() => window.__vis(true));
  const n0 = st.n; for (let i = 0; i < 3; i++) await run(page, 20000);
  ok('S5 hidden WHILE LISTENING: polls continue every 20 s', st.n - n0 === 3, `polls=${st.n - n0}`);
  await page.click('#plw-play').catch(() => {});   // (page is "hidden" only by our flag — the click still works) stop listening
  await settle(page);
  const n1 = st.n; for (let i = 0; i < 3; i++) await run(page, 20000);
  ok('S5 hidden, listening stopped: polls stop', st.n === n1, `polls=${st.n - n1}`);
  st.state = OFF; await page.evaluate(() => window.__vis(false)); await settle(page);
  const gone = await page.evaluate(() => !document.getElementById('pit-live-widget'));
  ok('S5 hidden→visible after the show ended: catch-up poll clears the stale bar', gone, '');
  await ctx.close(); }

// ── S6 "hide" choice is respected (sessionStorage pitlive_hide) → no polls at all
{ const { ctx, page, st } = await mk({ state: ON, preHide: true }); await page.goto('https://door.test/');
  await page.addScriptTag({ content: WIDGET }); await settle(page);
  for (let i = 0; i < 3; i++) await run(page, 20000);
  ok('S6 pitlive_hide: zero polls', st.n === 0, `n=${st.n}`); await ctx.close(); }

// ── S7 a REAL door loads the REAL widget (only /live.json routed locally, real timers): the ON AIR bar appears; hidden pauses; visible resumes at once
if (DOOR) {
  const { ctx, page, st } = await mk({ state: ON, door: true, clock: false });
  await page.goto(DOOR, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('pit-live-widget'), null, { timeout: 25000 }).catch(() => {});
  const bar = await page.evaluate(() => { const e = document.getElementById('pit-live-widget'); return e ? e.textContent : null; });
  ok(`S7 real door ${DOOR}: widget.js loaded from ${base} and the ON AIR bar shows`, !!bar && /LIVE PIT/.test(bar), String(bar).slice(0, 50));
  const src = await page.evaluate(() => [...document.scripts].map(s => s.src).filter(s => /widget\.js/.test(s)));
  ok('S7 the door carries the live widget tag', src.length >= 1, src.join(','));
  const text = await page.evaluate(() => fetch('https://live.zuchiangmai.app/widget.js').then(r => r.text()).catch(() => ''));
  ok('S7 the widget the door runs has the visibility guard', /document\.hidden/.test(text) && /visibilitychange/.test(text), `len=${text.length}`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__vis(true));
  const n0 = st.n; await page.waitForTimeout(23000);
  ok('S7 real door hidden for 23 s (one full 20 s interval): zero polls', st.n === n0, `polls=${st.n - n0}`);
  await page.evaluate(() => window.__vis(false)); await page.waitForTimeout(1500);
  ok('S7 real door visible again: immediate catch-up poll', st.n === n0 + 1, `polls=${st.n - n0}`);
  await page.waitForTimeout(21000);
  ok('S7 real door visible: the 20 s cadence continues', st.n === n0 + 2, `polls=${st.n - n0}`);
  await ctx.close();
}

await browser.close();
const pageErrs = errs.filter(e => !/net::|Failed to load|play\(\)|NotSupported|AbortError/.test(e));
ok('no uncaught page errors', pageErrs.length === 0, pageErrs.slice(0, 2).join(' | '));
const bad = results.filter(r => !r.pass);
console.log(bad.length ? `FAIL ${bad.length}/${results.length}` : `OK ${results.length}/${results.length} widget visibility checks`);
process.exit(bad.length ? 1 : 0);
