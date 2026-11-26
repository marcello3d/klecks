// Takes the machine's browser-suite turn once (2draw.net's e2e lock) and runs, in it: the .klr
// unit tests, test-klr.mjs, test-klr-draft.mjs --measure, perf-klr-canvas.mjs.
//   node scripts/test-klr-all.mjs [--build] [--no-perf]
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--build') || !existsSync(join(root, 'dist/embed.js'))) execSync('node scripts/build-2draw.mjs', { cwd: root, stdio: 'inherit' });
const lockPath = '/Users/marcello/github/2draw.net/worker/scripts/lib/e2e-lock.ts';
if (existsSync(lockPath) && process.env.E2E_LOCK !== '0') await (await import(lockPath)).e2eLock('klecks test-klr-all', 40);
const runs = [
    ['node', ['--test', 'scripts/test-klr-unit.mjs']],
    ['node', ['scripts/test-klr.mjs']],
    ['node', ['scripts/test-klr-draft.mjs', '--measure']],
    ...(args.includes('--no-perf') ? [] : [['node', ['scripts/perf-klr-canvas.mjs']]]),
];
let failed = 0;
for (const [cmd, a] of runs) {
    console.log(`\n=== ${a.join(' ')}`);
    const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit' }); // children inherit E2E_LOCK_HELD
    if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} run(s) failed` : '\nall runs passed');
process.exit(failed ? 1 : 0);
