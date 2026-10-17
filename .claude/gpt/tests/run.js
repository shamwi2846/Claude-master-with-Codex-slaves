// Regression checks for the Claude + GPT setup (no GPT calls).
// Usage: node run.js [--strict] [--exact] [name ...]   (no name = every t_*.js script)
//   A name equal to a script's name (with or without .js) selects exactly that script; any other name selects
//   every script containing it; --exact makes every name exact.
// Every run tests a FROZEN copy: the setup this runner belongs to (../..) and the backup folder (GPT_BACKUP_DIR,
// else ~/Desktop/Cloude agent) are copied into ~/.gpt-test-setup-<pid> first (setup-files.js capture), so
// editing the live files while it runs never changes its result. The summary names what was tested by hash.
// Each t_*.js script exercises the setup code (its gate.js, gpt.js, lib.js) and prints PASS/FAIL (or SKIP)
// lines. Scripts run in an isolated profile of their own (~/.gpt-test-profile-<pid>, recreated for every
// script: state, logs, baselines, desktop lock, test projects, and a Codex stub so no real GPT run can start),
// so the live setup's state is never touched and parallel runs don't collide.
// Exit code 1 if any check fails, a script crashes or runs no checks — and with --strict (release.js) if any
// script is skipped.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const S = require('./setup-files');

const REAL_HOME = os.homedir();
// under the real home: files in the temp folder never count as code
const PROFILE = path.join(REAL_HOME, `.gpt-test-profile-${process.pid}`);

// Profiles and frozen copies left behind by runs that were killed.
function cleanStale() {
  for (const n of fs.readdirSync(REAL_HOME)) {
    const m = n.match(/^\.gpt-(?:test-profile|test-setup|prove)-(\d+)$/);
    if (!m || Number(m[1]) === process.pid) continue;
    let alive = false; try { process.kill(Number(m[1]), 0); alive = true; } catch {}
    if (!alive) try { fs.rmSync(path.join(REAL_HOME, n), { recursive: true, force: true }); } catch {}
  }
}

// Which t_*.js scripts in `testsDir` the names select (see Usage). Returns { scripts } or { error }.
function select(testsDir, names, exact) {
  const all = fs.readdirSync(testsDir).filter(f => /^t_.*\.js$/.test(f)).sort();
  if (!all.length) return { error: `no check scripts (t_*.js) in ${testsDir}` };
  if (!names.length) return { scripts: all };
  const picked = new Set();
  for (const n of names) {
    const whole = all.find(f => f === n || f === `${n}.js`);
    if (whole) { picked.add(whole); continue; }
    if (exact) return { error: `no check script named ${n} in ${testsDir}` };
    const some = all.filter(f => f.includes(n));
    if (!some.length) return { error: `no check scripts match "${n}" in ${testsDir}` };
    some.forEach(f => picked.add(f));
  }
  return { scripts: [...picked].sort() };
}

// Runs `scripts` (names in <setupDir>/gpt/tests) against the setup in `setupDir` (a .claude folder, normally a
// frozen copy) with `backupDir` as the backup under test. Returns totals and, per script, what it did.
function runSuite({ setupDir, backupDir, scripts, strict, log = console.log }) {
  if (!scripts || !scripts.length) throw new Error(`no check scripts to run in ${setupDir}`); // (an empty run proves nothing)
  const testsDir = path.join(setupDir, 'gpt', 'tests');
  const config = path.join(setupDir, 'gpt', 'config.json'); // the config of the setup under test
  const freshProfile = () => {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
    const g = path.join(PROFILE, '.claude', 'gpt');
    fs.mkdirSync(g, { recursive: true });
    const stub = path.join(g, 'codex-stub.js');
    fs.writeFileSync(stub, "process.stderr.write('test profile: GPT calls are disabled\\n'); process.exit(2);\n");
    const conf = JSON.parse(fs.readFileSync(config, 'utf8'));
    conf.codexJs = stub;
    fs.writeFileSync(path.join(g, 'config.json'), JSON.stringify(conf, null, 2));
  };
  // GPT_TEST_PROFILE: lets each script check it runs inside this profile (tests/profile-guard.js)
  const env = { ...process.env, USERPROFILE: PROFILE, HOME: PROFILE, GPT_TEST_PROFILE: PROFILE };
  if (backupDir) env.GPT_BACKUP_DIR = backupDir; else delete env.GPT_BACKUP_DIR;
  let pass = 0, fail = 0, skipped = 0;
  const failures = [], details = [];
  for (const f of scripts) {
    freshProfile();
    const r = spawnSync(process.execPath, [path.join(testsDir, f)], { encoding: 'utf8', timeout: 300000, windowsHide: true, env, cwd: PROFILE });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const lines = out.split(/\r?\n/);
    const p = lines.filter(l => l.startsWith('PASS ')).length, failLines = lines.filter(l => l.startsWith('FAIL '));
    const skip = out.match(/^SKIP .*$/m);
    // A script that printed FAIL lines did run its checks (only no PASS, FAIL or SKIP at all is "no checks ran").
    const d = { name: f, pass: p, fail: failLines.length, failLines, skip: skip ? skip[0] : null, crashed: r.status !== 0, timedOut: !!(r.error && /ETIMEDOUT/.test(r.error.code || r.error.message)), noChecks: false, exit: r.status };
    pass += p; fail += failLines.length;
    for (const l of failLines) failures.push(`${f}: ${l}`);
    if (skip) { skipped++; log(`${f}: ${skip[0]}`); if (strict) { fail++; failures.push(`${f}: skipped (not allowed with --strict)`); } }
    if (r.status !== 0) { fail++; failures.push(`${f}: crashed (exit ${r.status}${r.error ? ', ' + r.error.message : ''})\n${out.trim().split('\n').slice(-5).join('\n')}`); }
    else if (!p && !failLines.length && !skip) { fail++; d.noChecks = true; failures.push(`${f}: no checks ran`); }
    details.push(d);
  }
  fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
  return { pass, fail, skipped, failures, details };
}

// A frozen copy of this runner's setup and of the backup folder, in <dir>. Returns { setupDir, backupDir,
// setupHash, backupHash } (backup null when there is no backup folder).
function freeze(dir, setupSrc, backupSrc) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  const setup = S.capture(setupSrc, path.join(dir, '.claude'), S.listSetup);
  const hasBackup = backupSrc && fs.existsSync(path.join(backupSrc, 'restore.js'));
  const backup = hasBackup ? S.capture(backupSrc, path.join(dir, 'backup'), S.listBackup) : null;
  return { setupDir: path.join(dir, '.claude'), backupDir: backup ? path.join(dir, 'backup') : null, setupHash: setup.hash, backupHash: backup ? backup.hash : null };
}

module.exports = { runSuite, select, freeze, cleanStale };

if (require.main === module) {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict'), exact = args.includes('--exact');
  const names = args.filter(a => !a.startsWith('--'));
  cleanStale();
  const t0 = Date.now();
  const FROZEN = path.join(REAL_HOME, `.gpt-test-setup-${process.pid}`);
  let code = 1;
  try {
    let fz;
    try { fz = freeze(FROZEN, path.join(__dirname, '..', '..'), process.env.GPT_BACKUP_DIR || path.join(REAL_HOME, 'Desktop', 'Cloude agent')); }
    catch (e) { console.log(`FAILED: could not take a consistent copy to test: ${e.message}`); process.exitCode = 1; return; }
    const sel = select(path.join(fz.setupDir, 'gpt', 'tests'), names, exact);
    if (sel.error) { console.log(`FAILED: ${sel.error}`); return; }
    const res = runSuite({ setupDir: fz.setupDir, backupDir: fz.backupDir, scripts: sel.scripts, strict });
    for (const l of res.failures) console.log(l);
    console.log(`tested: setup sha256 ${fz.setupHash}, backup sha256 ${fz.backupHash || 'none'}`);
    console.log(`${res.fail ? 'FAILED' : 'OK'}: ${res.pass} passed, ${res.fail} failed, ${res.skipped} skipped, ${sel.scripts.length} scripts, ${Math.round((Date.now() - t0) / 1000)}s`);
    code = res.fail ? 1 : 0;
  } finally {
    fs.rmSync(FROZEN, { recursive: true, force: true, maxRetries: 3 });
    process.exitCode = process.exitCode || code;
  }
}
