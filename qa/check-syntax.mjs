// Guard rail (SCAR 15 Nov): every script the Worker SERVES must parse. Run before every deploy.
// Extracts template-literal pages from worker.js/realtime.js + broadcast.html, pulls inline <script>s, and parses them.
import fs from 'node:fs'; import vm from 'node:vm';
const dir = new URL('..', import.meta.url).pathname;
const src = fs.readFileSync(dir + 'worker.js', 'utf8') + '\n' + fs.readFileSync(dir + 'realtime.js', 'utf8');
const pages = {};
for (const m of src.matchAll(/(?:export )?const (\w+) = `([\s\S]*?)`;/g)) {
  if (m[2].includes('${') || m[2].includes('\\')) { console.error('HAZARD: template literal', m[1], 'contains ${ or a backslash'); process.exitCode = 1; }
  pages[m[1]] = m[2];
}
pages.BROADCAST_HTML = fs.readFileSync(dir + 'broadcast.html', 'utf8');
pages.PLAYER_HTML = fs.readFileSync(dir + 'player.html', 'utf8');
let bad = 0, n = 0;
const check = (name, js) => { n++; try { new vm.Script(js, { filename: name }); } catch (e) { bad++; console.error('SYNTAX FAIL', name, e.message); } };
for (const [name, body] of Object.entries(pages)) {
  if (/_JS$/.test(name)) { check(name, body); continue; }
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  scripts.forEach((js, i) => check(`${name}#script${i}`, js));
  if (!scripts.length && /_HTML$/.test(name)) console.log('note:', name, 'has no inline script');
}
// also the worker modules themselves
for (const f of ['worker.js', 'realtime.js']) {
  const code = fs.readFileSync(dir + f, 'utf8').replace(/^import .*$/gm, '').replace(/^export \{[^}]*\};?$/gm, '').replace(/^export (default |const |async function |function )/gm, (m, k) => k === 'default ' ? 'const __default = ' : k);
  check(f, code);
}
console.log(bad ? `FAIL ${bad}/${n}` : `OK ${n}/${n} scripts parse`);
if (bad) process.exitCode = 1;
