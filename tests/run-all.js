// Runs every suite (or those matching the arguments) and prints a summary.
//   npm test                 → everything
//   npm test -- structure    → only suites whose name contains "structure"
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'suites');
const filters = process.argv.slice(2);
const suites = fs.readdirSync(dir).filter(f => /\.test\.m?js$/.test(f)).sort()
  .filter(f => !filters.length || filters.some(k => f.includes(k)));

const results = [];
for (const s of suites) {
  console.log(`\n━━ ${s} ${'━'.repeat(Math.max(0, 60 - s.length))}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, s)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);
  const ko = (out.match(/✘/g) || []).length;
  const ok = (out.match(/✔/g) || []).length;
  results.push({ s, ok, ko, code: r.status, secs: Math.round((Date.now() - t0) / 1000) });
}

console.log('\n━━ Summary ' + '━'.repeat(50));
let failed = 0;
for (const r of results) {
  const bad = r.code !== 0 || r.ko > 0;
  if (bad) failed++;
  console.log(`${bad ? '✘' : '✔'} ${r.s.padEnd(24)} ${String(r.ok).padStart(4)} ok  ${String(r.ko).padStart(3)} failed  (${r.secs}s${r.code ? ', exit ' + r.code : ''})`);
}
process.exit(failed ? 1 : 0);
