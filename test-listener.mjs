// Headless listener: opens the player, presses play, reports whether WebRTC audio arrives (inbound-rtp bytes).
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage();
pg.on('console', m => console.log('[page]', m.text()));
await pg.goto('https://live.zuchiangmai.app/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1500);
const state = await pg.evaluate(() => fetch('/live.json').then(r => r.json()));
console.log('state live/webrtc:', state.live, state.webrtc);
await pg.click('#play');
await pg.waitForTimeout(6000);
const stats = await pg.evaluate(async () => {
  const a = document.getElementById('audio');
  const out = { hasSrcObject: !!a.srcObject, paused: a.paused, readyState: a.readyState, bytes: null, state: null };
  const pc = window.__pc; return out;
});
const rtc = await pg.evaluate(async () => {
  // reach into the pitListenRT pc via a global set by the page? fallback: use getStats on any RTCPeerConnection via audio srcObject tracks
  const a = document.getElementById('audio'); if (!a.srcObject) return 'no srcObject';
  const t = a.srcObject.getAudioTracks()[0]; return t ? { label: t.label, readyState: t.readyState, muted: t.muted } : 'no track';
});
console.log('audio el:', JSON.stringify(stats), 'track:', JSON.stringify(rtc));
await b.close();
