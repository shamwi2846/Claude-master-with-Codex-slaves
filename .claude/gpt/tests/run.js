// Regression checks for the Claude + GPT setup (no GPT calls). Usage: node run.js [--strict] [name-filter]
// Each t_*.js script exercises the live setup code (../gate.js, ../gpt.js, ../lib.js) and prints PASS/FAIL
// (or SKIP) lines. Scripts run in an isolated profile of their own (~/.gpt-test-profile-<pid>, recreated for
// every script: state, logs, baselines, desktop lock, test projects, and a Codex stub so no real GPT run can
// start), so the live setup's state is never touched and parallel runs don't collide.
// Exit code 1 if any check fails, a script crashes or runs no checks — and with --strict (release.js) if
// any script is skipped.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REAL_HOME = os.homedir();
// under the real home: files in the temp folder never count as code
const PROFILE = path.join(REAL_HOME, `.gpt-test-profile-${process.pid}`);
const LIVE_CONFIG = path.join(__dirname, '..', 'config.json'); // the config of the setup under test (live or a release candidate)
const BACKUP = process.env.GPT_BACKUP_DIR || path.join(REAL_HOME, 'Desktop', 'Cloude agent');
// Profiles left behind by runs that were killed.
for (const n of fs.readdirSync(REAL_HOME)) {
  const m = n.match(/^\.gpt-test-profile-(\d+)$/);
  if (!m) continue;
  let alive = false; try { process.kill(Number(m[1]), 0); alive = true; } catch {}
  if (!alive) try { fs.rmSync(path.join(REAL_HOME, n), { recursive: true, force: true }); } catch {}
}
function freshProfile() {
  fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
  const g = path.join(PROFILE, '.claude', 'gpt');
  fs.mkdirSync(g, { recursive: true });
  const stub = path.join(g, 'codex-stub.js');
  fs.writeFileSync(stub, "process.stderr.write('test profile: GPT calls are disabled\\n'); process.exit(2);\n");
  const conf = JSON.parse(fs.readFileSync(LIVE_CONFIG, 'utf8'));
  conf.codexJs = stub;
  fs.writeFileSync(path.join(g, 'config.json'), JSON.stringify(conf, null, 2));
}
const env = { ...process.env, USERPROFILE: PROFILE, HOME: PROFILE, GPT_BACKUP_DIR: BACKUP };

const strict = process.argv.includes('--strict');
const filter = process.argv.slice(2).find(a => !a.startsWith('--')) || '';
const files = fs.readdirSync(__dirname).filter(f => /^t_.*\.js$/.test(f) && f.includes(filter)).sort();
if (!files.length) { console.log(`FAILED: no check scripts${filter ? ` match "${filter}"` : ''} in ${__dirname}`); process.exit(1); }
let pass = 0, fail = 0, skipped = 0;
const failures = [];
const t0 = Date.now();
for (const f of files) {
  freshProfile();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 300000, windowsHide: true, env, cwd: PROFILE });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const p = (out.match(/^PASS /gm) || []).length, x = (out.match(/^FAIL /gm) || []).length;
  const skip = out.match(/^SKIP .*$/m);
  pass += p; fail += x;
  for (const l of out.split(/\r?\n/)) if (l.startsWith('FAIL ')) failures.push(`${f}: ${l}`);
  if (skip) { skipped++; console.log(`${f}: ${skip[0]}`); if (strict) { fail++; failures.push(`${f}: skipped (not allowed with --strict)`); } }
  if (r.status !== 0) { fail++; failures.push(`${f}: crashed (exit ${r.status}${r.error ? ', ' + r.error.message : ''})\n${out.trim().split('\n').slice(-5).join('\n')}`); }
  else if (!p && !skip) { fail++; failures.push(`${f}: no checks ran`); }
}
fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
for (const l of failures) console.log(l);
console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed, ${skipped} skipped, ${files.length} scripts, ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(fail ? 1 : 0);
