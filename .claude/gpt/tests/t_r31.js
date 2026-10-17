// Quality loop: frozen test runs (consistent capture, exact filters, FAIL-only scripts counted), the release
// backstop and certification, prove.js, chain-scoped closing and bound acknowledgements, complete reviews with a
// validated COVERAGE line and consistent verdicts, evidence labels, and the Stop texts. Fixture setups only.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync, spawn } = require('child_process');
const K = require('./bridge-kit'), L = K.L, X = K.codex, P = require(__G + 'bridge/prompts.js');
const S = require('./setup-files');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const W = path.join(os.homedir(), 'gpt-r31-test');
fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(W, { recursive: true });
const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); return p; };
const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env || {}) } });
const TOOLS = ['run.js', 'setup-files.js', 'prove.js', 'release.js'];
// A tiny setup: <dir>/.claude with the real test tools and config, plus `files` ({ rel: content }).
const fixture = (dir, files = {}) => {
  const C = path.join(dir, '.claude');
  for (const t of TOOLS) put(path.join(C, 'gpt', 'tests', t), fs.readFileSync(path.join(__dirname, t)));
  put(path.join(C, 'gpt', 'config.json'), fs.readFileSync(__G + 'config.json'));
  for (const [rel, text] of Object.entries(files)) put(path.join(C, rel), text);
  return C;
};

// 1. capture: the copy agrees with the source before and after copying, else it retries, then refuses
const SRC = path.join(W, 'cap-src'), DST = path.join(W, 'cap-dst');
const listDir = d => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const HOOK = put(path.join(W, 'hook.js'), `const fs = require('fs'), path = require('path'); const [src, dest, n] = process.argv.slice(2), m = process.env.CAP_MODE;
if (m === 'always' || n === '1') {
  if (m === 'edit' || m === 'always') fs.appendFileSync(path.join(src, 'a.txt'), 'x');
  if (m === 'add') fs.writeFileSync(path.join(src, 'new.txt'), 'n');
  if (m === 'del') fs.rmSync(path.join(src, 'b.txt'));
  if (m === 'copy') fs.writeFileSync(path.join(dest, 'a.txt'), 'a transient version');
}\n`);
// (each result is checked right away: the next capture replaces the copy)
const cap = mode => {
  fs.rmSync(SRC, { recursive: true, force: true }); put(path.join(SRC, 'a.txt'), 'A'); put(path.join(SRC, 'b.txt'), 'B');
  process.env.GPT_TEST_CAPTURE_HOOK = HOOK; process.env.CAP_MODE = mode;
  try {
    const r = S.capture(SRC, DST, listDir);
    return { r, same: S.keyOf(S.inventory(DST, listDir(DST))) === S.keyOf(S.inventory(SRC, listDir(SRC))), names: listDir(DST), a: fs.readFileSync(path.join(DST, 'a.txt'), 'utf8') };
  } catch (e) { return { error: e.message }; } finally { delete process.env.GPT_TEST_CAPTURE_HOOK; delete process.env.CAP_MODE; }
};
const ce = cap('edit');
ok(ce.same && ce.a === 'Ax', 'capture: a source edited during the copy is copied again; the copy equals the source');
const ca = cap('add');
ok(ca.same && ca.names.includes('new.txt'), '... a file added meanwhile is in the copy (membership re-discovered)');
const cd = cap('del');
ok(cd.same && !cd.names.includes('b.txt'), '... a file deleted meanwhile is not');
const cc = cap('copy');
ok(cc.same && cc.a === 'A', '... a copy that read a transient version is copied again');
const cx = cap('always');
ok(/kept changing/.test(cx.error || '') && !fs.existsSync(DST), 'a source that keeps changing is refused, no copy left');
fs.mkdirSync(path.join(SRC, 'd.txt')); // a listed entry that can't be read (a folder)
let unreadable = ''; try { S.capture(SRC, DST, listDir); } catch (e) { unreadable = e.message; }
ok(/cannot read d\.txt \(EISDIR\)/.test(unreadable) && !fs.existsSync(DST), 'a listed file that exists but cannot be read refuses the capture (never silently missing from the copy)');
const BADSET = fixture(path.join(W, 'badlist')); put(path.join(BADSET, 'agents'), 'a file where a folder belongs');
let listErr = ''; try { S.capture(BADSET, path.join(W, 'badlist-copy'), S.listSetup); } catch (e) { listErr = e.message; }
ok(/cannot list agents .*\(ENOTDIR\)/.test(listErr) && !fs.existsSync(path.join(W, 'badlist-copy')), 'a setup folder that exists but cannot be listed refuses the capture (a missing one has no files)');

// 2. run.js: a frozen copy, exact filters, FAIL-only scripts counted, both inputs hashed, cleanup
const RS = fixture(path.join(W, 'rs'), {
  'gpt/tests/data.js': "module.exports = 'A';\n",
  'gpt/tests/t_a.js': "console.log('PASS a');\n",
  'gpt/tests/t_ab.js': "console.log('PASS ab');\n",
  'gpt/tests/t_b.js': "console.log('PASS b');\n",
  'gpt/tests/t_failonly.js': "console.log('FAIL the only check');\n",
  'gpt/tests/t_slow.js': "const fs = require('fs'), path = require('path'); fs.writeFileSync(process.env.STARTED, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);\n" +
    "const rb = process.env.GPT_BACKUP_DIR ? fs.readFileSync(path.join(process.env.GPT_BACKUP_DIR, 'restore.js'), 'utf8') : '';\n" +
    "console.log(require('./data.js') === 'A' ? 'PASS frozen setup' : 'FAIL setup changed under the run'); console.log(rb === '// v1\\n' ? 'PASS frozen backup' : 'FAIL backup changed under the run: ' + JSON.stringify(rb));\n",
});
const BK = path.join(W, 'rs-backup'); put(path.join(BK, 'restore.js'), '// v1\n'); put(path.join(BK, '.claude', 'RELEASE.txt'), 'x\n');
const runIn = (...a) => node([path.join(RS, 'gpt', 'tests', 'run.js'), ...a], { env: { GPT_BACKUP_DIR: BK } });
const scripts = o => Number((o.stdout.match(/, (\d+) scripts,/) || [])[1]);
ok(scripts(runIn('t_a')) === 1 && scripts(runIn('t_a', 't_b')) === 2 && scripts(runIn('t_')) === 5, 'run.js: an exact name selects that script only (t_a, not t_ab); several names; other names are substrings');
const ex = runIn('--exact', 't_');
ok(ex.status === 1 && /no check script named t_/.test(ex.stdout), '--exact refuses a name that is not a script');
const fo = runIn('t_failonly');
ok(fo.status === 1 && /t_failonly\.js: FAIL the only check/.test(fo.stdout) && !/no checks ran/.test(fo.stdout), 'a script with only FAIL lines ran its checks (not "no checks ran")');
const EMPTY = fixture(path.join(W, 'rs-empty'));
const em = node([path.join(EMPTY, 'gpt', 'tests', 'run.js'), '--strict']);
let emptyThrew = false; try { require(path.join(EMPTY, 'gpt', 'tests', 'run.js')).runSuite({ setupDir: EMPTY, scripts: [] }); } catch { emptyThrew = true; }
ok(em.status === 1 && /no check scripts/.test(em.stdout) && emptyThrew, 'a setup with no check scripts fails (an empty run proves nothing)');
const stale = path.join(os.homedir(), '.gpt-test-setup-999999'); fs.mkdirSync(stale, { recursive: true });
const STARTED = path.join(W, 'started');
const expSetup = S.hashOf(S.keyOf(S.inventory(RS, S.listSetup(RS)))), expBackup = S.hashOf(S.keyOf(S.inventory(BK, S.listBackup(BK))));
const child = spawn(process.execPath, [path.join(RS, 'gpt', 'tests', 'run.js'), 't_slow'], { env: { ...process.env, GPT_BACKUP_DIR: BK, STARTED } });
let outSlow = ''; child.stdout.on('data', d => { outSlow += d; });
const done = new Promise(res => child.on('close', res));
(async () => {
  for (let i = 0; i < 200 && !fs.existsSync(STARTED); i++) await new Promise(r => setTimeout(r, 50));
  fs.writeFileSync(path.join(RS, 'gpt', 'tests', 'data.js'), "module.exports = 'B';\n"); fs.writeFileSync(path.join(BK, 'restore.js'), '// v2\n');
  const code = await done;
  ok(code === 0 && /OK: 2 passed, 0 failed/.test(outSlow), `editing the live setup and backup while a run is going does not change its result (frozen copies)${code === 0 ? '' : `: ${outSlow.trim().split('\n').slice(-3).join(' | ')}`}`);
  ok(outSlow.includes(`tested: setup sha256 ${expSetup}, backup sha256 ${expBackup}`), 'the summary names the tested setup and backup by their hashes (the versions captured at the start)');
  ok(!fs.existsSync(stale) && !fs.readdirSync(os.homedir()).some(n => /^\.gpt-test-setup-\d+$/.test(n)), 'stale and own frozen copies are removed');
  rest();
})();

function rest() {
  // 3. the release backstop and certification (a fixture setup in this profile's .claude; a fake check run)
  const LIVE = path.join(os.homedir(), '.claude');
  const profileConfig = fs.readFileSync(path.join(LIVE, 'gpt', 'config.json')); // (its Codex stub: no real GPT call)
  for (const rel of S.listSetup(path.join(__G, '..'))) put(path.join(LIVE, rel), fs.readFileSync(path.join(__G, '..', rel)));
  fs.writeFileSync(path.join(LIVE, 'gpt', 'config.json'), profileConfig);
  put(path.join(LIVE, 'gpt', 'tests', 'run.js'), "const fs = require('fs'); const L = require('../lib.js');\n" +
    "if (process.env.FAKE_FINDING) L.updateState(process.env.FAKE_FINDING, s => { s.root = process.env.FAKE_FINDING; s.changes[process.env.FAKE_FILE] = { lines: 1, at: 1, reviewedAt: 2, openFindings: ['late.md'] }; });\n" +
    "if (process.env.FAKE_TOUCH) fs.appendFileSync(process.env.FAKE_TOUCH, '\\n// edited during the release\\n');\n" +
    "console.log('tested: setup sha256 1234567890abcdef, backup sha256 none'); console.log('OK: 1 passed, 0 failed, 0 skipped, 1 scripts, 0s');\n");
  const RB = path.join(W, 'backup'); put(path.join(RB, 'restore.js'), '// restore\n');
  const rel = (env = {}, ...a) => node([path.join(__dirname, 'release.js'), '--backup', RB, ...a], { env: { GPT_BACKUP_DIR: '', ...env } });
  const LIB = path.join(LIVE, 'gpt', 'lib.js'), ROOT = path.join(W, 'proj-rel');
  const setRec = c => L.updateState(ROOT, s => { s.root = ROOT; s.changes = { [LIB]: c }; });
  setRec({ lines: 3, at: Date.now() + 1000, reviewedAt: 0 });
  let r = rel({}, '--gate-only');
  ok(r.status === 1 && /not released \(before the checks\)/.test(r.stderr) && r.stderr.includes(LIB) && /unreviewed change/.test(r.stderr) && !fs.existsSync(path.join(RB, '.claude')), 'release: a released file some project still has pending is refused before the checks, backup untouched');
  setRec({ lines: 3, at: 1, reviewedAt: 2, openFindings: ['r1.md'] });
  r = rel({}, '--gate-only');
  ok(r.status === 1 && /open findings \(r1\.md\)/.test(r.stderr), '... and one with open findings, even if unchanged');
  setRec({ lines: 3, at: 1, reviewedAt: 2 });
  const BAD = put(path.join(L.STATE_DIR, 'abcdef012345.json'), '{ not json');
  r = rel({}, '--gate-only');
  ok(r.status === 1 && /could not be read/.test(r.stderr) && r.stderr.includes(BAD), '... and an unreadable project state is refused and listed separately');
  fs.rmSync(BAD);
  r = rel({}, '--gate-only');
  ok(r.status === 0 && /release gate passed/.test(r.stdout), 'nothing known unreviewed: the gate passes');
  const libWas = fs.readFileSync(LIB); fs.appendFileSync(LIB, '\nthis is not javascript (\n');
  r = rel({}, '--gate-only');
  fs.writeFileSync(LIB, libWas);
  ok(r.status === 1 && /candidate's gpt\/lib\.js does not load/.test(r.stderr) && !fs.existsSync(path.join(RB, '.candidate')), "a candidate lib.js that doesn't load is reported and the candidate removed");
  r = rel({ FAKE_FINDING: path.join(W, 'proj-late'), FAKE_FILE: LIB });
  ok(r.status === 1 && /not released \(after the checks\)/.test(r.stderr) && /late\.md/.test(r.stderr) && !fs.existsSync(path.join(RB, '.claude')), 'findings reported while the checks ran block publishing');
  L.updateState(path.join(W, 'proj-late'), s => { s.changes = {}; });
  const TOUCH = path.join(LIVE, 'gpt', 'REFERENCE.md'), refWas = fs.readFileSync(TOUCH);
  r = rel({ FAKE_TOUCH: TOUCH });
  ok(r.status === 1 && /live setup changed during the release \(gpt\/REFERENCE\.md changed\)/.test(r.stderr) && /release again/.test(r.stderr) && !fs.existsSync(path.join(RB, '.claude')), 'a live change during the release is refused before publishing ("release again")');
  fs.writeFileSync(TOUCH, refWas);
  r = rel({});
  ok(r.status === 0 && /^Tested: setup sha256 1234567890abcdef, backup sha256 none$/m.test(fs.readFileSync(path.join(RB, '.claude', 'RELEASE.txt'), 'utf8')), 'a clean release publishes, and its manifest records exactly what the checks tested');
  // a file the last release had that is now deleted: its unreviewed deletion blocks too, before and after the checks
  const DELETED = path.join(LIVE, 'gpt', 'gone.js');
  fs.appendFileSync(path.join(RB, '.claude', 'RELEASE.txt'), `${S.hashOf(Buffer.from('x'))}  .claude/gpt/gone.js\n`);
  L.updateState(ROOT, s => { s.changes = { [DELETED]: { lines: 3, at: Date.now() + 1000, reviewedAt: 0, deleted: true } }; });
  r = rel({}, '--gate-only');
  ok(r.status === 1 && r.stderr.includes(DELETED) && /before the checks/.test(r.stderr), "a released file's unreviewed deletion is refused before the checks");
  L.updateState(ROOT, s => { s.changes = {}; });
  r = rel({ FAKE_FINDING: path.join(W, 'proj-late'), FAKE_FILE: DELETED });
  ok(r.status === 1 && /after the checks/.test(r.stderr) && r.stderr.includes(DELETED), '... and after them');
  L.updateState(path.join(W, 'proj-late'), s => { s.changes = {}; });

  // 4. prove.js: fails on the old production code (the named assertion), passes on the new
  const T = "const L = require(require('path').join(__dirname, '..', 'lib.js'));\n";
  const mk = (name, lib, test) => fixture(path.join(W, name), { 'gpt/lib.js': lib, 'gpt/tests/t_p.js': T + test });
  const goodTest = "console.log(L.v() === 2 ? 'PASS v is 2' : 'FAIL v is not 2');\n";
  const NEW = mk('pnew', 'module.exports = { v: () => 2 };\n', goodTest);
  const prove = (oldDir, expect = 'v is not 2', live = NEW) => node([path.join(live, 'gpt', 'tests', 'prove.js'), 't_p', '--expect', expect, '--old', oldDir], { env: { GPT_BACKUP_DIR: path.join(W, 'none') } });
  r = prove(mk('pold', 'module.exports = { v: () => 1 };\n', goodTest));
  ok(r.status === 0 && /^PROVEN: t_p\.js fails on the old code \(FAIL v is not 2\)/m.test(r.stdout) && /checks and tools sha256 [0-9a-f]{16} \(the same in both\)/.test(r.stdout), 'prove.js: proven when the old code fails on the named assertion and the new passes (one test snapshot for both)');
  r = prove(mk('psame', 'module.exports = { v: () => 2 };\n', goodTest));
  ok(r.status === 1 && /production code is the same/.test(r.stdout), 'not proven: the old version has the same production code');
  r = prove(mk('pcrash', "throw new Error('old code broken');\n", goodTest));
  ok(r.status === 1 && /NOT PROVEN/.test(r.stdout) && /crashed/.test(r.stdout), 'not proven: the old run crashed');
  const NEW2 = mk('pnew2', 'module.exports = { v: () => 2 };\n', goodTest + "if (L.v() !== 2) throw new Error('then crash');\n");
  r = prove(mk('pmixed', 'module.exports = { v: () => 1 };\n', goodTest), 'v is not 2', NEW2);
  ok(r.status === 1 && /crashed/.test(r.stdout), 'not proven: the expected FAIL followed by a crash');
  r = prove(path.join(W, 'pold', '.claude'), 'some other assertion');
  ok(r.status === 1 && /not with "some other assertion"/.test(r.stdout), 'not proven: the old run fails, but not on the named assertion');
  const NEW3 = mk('pnew3', 'module.exports = { v: () => 3 };\n', goodTest);
  r = prove(path.join(W, 'pold', '.claude'), 'v is not 2', NEW3);
  ok(r.status === 1 && /on the fixed code it did not pass cleanly/.test(r.stdout), 'not proven: the new code fails too');
  r = node([path.join(NEW, 'gpt', 'tests', 'prove.js'), 't_p']);
  ok(r.status === 1 && /usage/.test(r.stdout), '--expect is required');

  // 5. mark-reviewed: --chain closes one chain only; manual acknowledgements keep findings and are bound
  const MP = path.join(W, 'mr'); fs.mkdirSync(MP, { recursive: true });
  const F1 = put(path.join(MP, 'a.js'), 'a\n'), F2 = put(path.join(MP, 'b.js'), 'b\n');
  const LA = put(path.join(MP, 'la.md'), '# A\n- Round: 1\n\n## Claude\'s decisions\n\n'), LB = put(path.join(MP, 'lb.md'), '- Round: 1\n');
  const now = Date.now();
  L.updateState(MP, s => { s.changes = { [F1]: { lines: 1, at: now - 100, reviewedAt: now - 50, openFindings: [LA, LB] }, [F2]: { lines: 1, at: now + 60000, reviewedAt: now - 50, openFindings: [LA] } }; });
  const gpt = (...a) => node([__G + 'gpt.js', ...a, '--project', MP], { cwd: MP });
  const ch = c => (L.readState(MP).changes || {})[c] || {};
  r = gpt('mark-reviewed', '--chain', LA, '--files', `${F1},${F2}`, '--note', 'GPT conceded nothing; trigger impossible: x is validated at entry');
  ok(r.status === 0 && JSON.stringify(ch(F1).openFindings) === JSON.stringify([LB]) && !ch(F2).openFindings && ch(F2).at > L.reviewedAtFor(L.readState(MP), ch(F2)) && /CHAIN CLOSED by Claude/.test(fs.readFileSync(LA, 'utf8')),
    '--chain closes only that chain: another chain on the same file stays open, a newer edit stays pending, the decision is in the chain log');
  r = gpt('mark-reviewed', '--chain', LA, '--files', F1, '--note', 'again');
  ok(r.status !== 0 && /nothing was closed/.test(r.stderr), '--chain with nothing open to close is refused');
  ok(gpt('mark-reviewed', '--chain', LB, '--note', 'x').status !== 0 && gpt('mark-reviewed', '--by', 'claude-fallback', '--note', 'x').status !== 0, '--files is required (no project-wide clearing)');
  r = gpt('mark-reviewed', '--by', 'someone', '--files', F1, '--note', 'x');
  ok(r.status !== 0 && /must be one of/.test(r.stderr) && gpt('mark-reviewed', '--files', F1, '--note', 'x').status !== 0, 'an unknown or missing --by is refused');
  r = gpt('mark-reviewed', '--by', 'claude-fallback', '--files', F1, '--note', 'fallback review clean');
  ok(r.status === 0 && JSON.stringify(ch(F1).openFindings) === JSON.stringify([LB]), 'a manual acknowledgement keeps open findings');
  const RC = path.join(W, 'mirror', '.claude'), MF = put(path.join(RC, 'gpt', 'lib.js'), 'released\n'), GONE = path.join(RC, 'gpt', 'old.js');
  const h = S.hashOf(Buffer.from('released\n'));
  const MAN = put(path.join(W, 'RELEASE.txt'), `Released x\n\n${h}  .claude/gpt/lib.js\n`), MAN2 = put(path.join(W, 'RELEASE2.txt'), `${h}  .claude/gpt/lib.js\n${h}  .claude/gpt/old.js\n`);
  ok(gpt('mark-reviewed', '--by', 'claude-final', '--release', MAN, '--files', `${MF},${GONE}`, '--note', 'mirror').status === 0, 'claude-final --release: copies matching the release, and a deletion the release agrees with, are accepted');
  const MANCOPY = put(path.join(RC, 'RELEASE.txt'), fs.readFileSync(MAN));
  ok(gpt('mark-reviewed', '--by', 'claude-final', '--release', MAN, '--files', MANCOPY, '--note', 'mirror').status === 0, '... the mirrored manifest itself is accepted when it is the --release file byte for byte');
  fs.appendFileSync(MANCOPY, 'x');
  r = gpt('mark-reviewed', '--by', 'claude-final', '--release', MAN, '--files', MANCOPY, '--note', 'mirror');
  ok(r.status !== 0 && /differs from the release manifest/.test(r.stderr), '... and refused when it differs');
  r = gpt('mark-reviewed', '--by', 'claude-final', '--release', MAN, '--files', path.join(W, 'nomirror', '.claude', 'RELEASE.txt'), '--note', 'mirror');
  ok(r.status !== 0 && /the release manifest is missing/.test(r.stderr), '... and a missing mirrored manifest is refused (never a verified deletion)');
  const RAWMAN = put(path.join(W, 'RAW.txt'), Buffer.concat([Buffer.from('Released \xff\n\n', 'latin1'), Buffer.from(`${h}  .claude/gpt/lib.js\n`)])); // (malformed UTF-8 in its metadata)
  fs.writeFileSync(MF, 'released\n'); fs.writeFileSync(MANCOPY, fs.readFileSync(RAWMAN));
  ok(gpt('mark-reviewed', '--by', 'claude-final', '--release', RAWMAN, '--files', MANCOPY, '--note', 'mirror').status === 0, '... compared as raw bytes: an identical copy of a manifest with malformed UTF-8 is accepted');
  fs.writeFileSync(MANCOPY, Buffer.from(fs.readFileSync(RAWMAN).toString('utf8'), 'utf8'));
  r = gpt('mark-reviewed', '--by', 'claude-final', '--release', RAWMAN, '--files', MANCOPY, '--note', 'mirror');
  ok(r.status !== 0 && /differs from the release manifest/.test(r.stderr), '... and a copy whose bytes were re-encoded (U+FFFD) is refused');
  const base = L.baselineOf(MP, MF);
  ok(base && base !== 'ABSENT' && fs.readFileSync(base, 'utf8') === 'released\n', '... and what it acknowledges is exactly the bytes it verified');
  const UNREAD = path.join(RC, 'gpt', 'locked.js'); fs.mkdirSync(UNREAD, { recursive: true }); // (exists, can't be read as a file)
  r = gpt('mark-reviewed', '--by', 'claude-final', '--release', MAN, '--files', UNREAD, '--note', 'mirror');
  ok(r.status !== 0 && /locked\.js: cannot be read \(EISDIR\)/.test(r.stderr), 'a file that exists but cannot be read is refused, never taken as a verified deletion');
  const EMPTYMAN = put(path.join(W, 'EMPTY.txt'), 'Released x\n\n');
  r = gpt('mark-reviewed', '--by', 'claude-final', '--release', EMPTYMAN, '--files', GONE, '--note', 'mirror');
  ok(r.status !== 0 && /lists no released \.claude files/.test(r.stderr), 'an empty or foreign manifest is refused (it would authorize any deletion)');
  if (process.platform === 'win32') {
    r = gpt('mark-reviewed', '--by', 'claude-final', '--release', MAN2, '--files', path.join(W, 'mirror', '.claude', 'GPT', 'OLD.js'), '--note', 'mirror');
    ok(r.status !== 0 && /deleted, but the release still has it/.test(r.stderr), 'on Windows a different letter case is the same file (no deletion check bypass)');
  }
  fs.writeFileSync(MF, 'edited\n');
  r = gpt('mark-reviewed', '--by', 'claude-final', '--release', MAN, '--files', MF, '--note', 'mirror');
  ok(r.status !== 0 && /lib\.js: differs from the release/.test(r.stderr), '... a file that differs is refused, named');
  r = gpt('mark-reviewed', '--by', 'claude-final', '--release', MAN2, '--files', GONE, '--note', 'mirror');
  ok(r.status !== 0 && /deleted, but the release still has it/.test(r.stderr) && gpt('mark-reviewed', '--by', 'claude-final', '--files', MF, '--note', 'x').status !== 0, '... a deletion the release contradicts is refused; no --release is refused');

  // 6. reviews: every confirmed finding, a validated COVERAGE line, a verdict that agrees with its items
  const COV = 'COVERAGE: inputs/encodings=checked; failure/timeout/cleanup=checked; concurrency/stale state=n/a; callers/interfaces=checked; tests=not examined';
  const cv = (text, kind = 'review', req = true) => X.checkVerdict({ ok: true, text }, kind, req);
  ok(cv(`VERDICT: NO_ISSUES\n${COV}`).ok && cv(`VERDICT: NO_ISSUES\n${COV}`).verdict === 'NO_ISSUES', 'a review with a valid COVERAGE line passes');
  ok(/COVERAGE line is missing/.test(cv('VERDICT: NO_ISSUES').badFormat) && /field "tests" is missing/.test(cv('VERDICT: NO_ISSUES\nCOVERAGE: inputs/encodings=checked; failure/timeout/cleanup=checked; concurrency/stale state=n/a; callers/interfaces=checked').badFormat) &&
    /value "maybe"/.test(cv(`VERDICT: NO_ISSUES\n${COV.replace('tests=not examined', 'tests=maybe')}`).badFormat) && /more than one/.test(cv(`VERDICT: NO_ISSUES\n${COV}\n${COV}`).badFormat), 'a missing, incomplete, invalid or repeated COVERAGE line is a format defect');
  ok(/contradicts the MAINTAIN\/OPEN/.test(cv(`VERDICT: RESOLVED\n1. MAINTAIN — still broken\n${COV}`).badFormat) && /contradicts the findings/.test(cv(`VERDICT: NO_ISSUES\n### [HIGH] a bug\n${COV}`).badFormat), 'a verdict that contradicts its own items is a format defect (it would clear open findings)');
  ok(cv('VERDICT: ALL_10\narea: 10/10', 'score', false).ok && cv('VERDICT: SOUND', 'plan', false).ok, 'score without files and plans need no COVERAGE line');
  ok(['### **[HIGH]** a bug', '#### [HIGH] a bug', '## `[LOW]` a nit', '# [HIGH] a bug', '> ### [HIGH] a quoted bug', '> > ## **[MEDIUM]** nested quote'].every(hd => ['RESOLVED', 'NO_ISSUES'].every(v => /contradicts the findings/.test(cv(`VERDICT: ${v}\n${hd}\n- Location: a.js:1\n${COV}`).badFormat || ''))) &&
    /contradicts the MAINTAIN\/OPEN/.test(cv(`VERDICT: RESOLVED\n> 1. OPEN — quoted\n${COV}`).badFormat || '') &&
    ['1) MAINTAIN — x', '**1. MAINTAIN** — x', '- 2. OPEN — x', '(3) OPEN — x', '1. OPEN still broken', '1. **MAINTAIN** because x', '1. OPEN **still broken**', '1. OPEN`x`', '1.OPEN', '1. _OPEN_ — still broken', '1. __MAINTAIN__ — x', '* 1. ~~OPEN~~ x']
      .every(it => ['RESOLVED', 'NO_ISSUES'].every(v => /contradicts the MAINTAIN\/OPEN/.test(cv(`VERDICT: ${v}\n${it}\n${COV}`).badFormat || ''))),
  'finding headings at any level or decoration, and open items in any list style or emphasis (* _ ` ~), are recognised next to NO_ISSUES or RESOLVED');
  const raw = `VERDICT: ISSUES_FOUND\n#### **[HIGH]** a bug\n- Location: a.js:1\n**1) MAINTAIN** — x\n2. _CONCEDE_ — ok\n${COV}`, kept = cv(raw);
  ok(kept.ok && kept.text === raw && ['#### **[HIGH]** a bug', '**1) MAINTAIN** — x', '2. _CONCEDE_ — ok', 'plain prose'].map(P.lineKind).join(',') === 'finding,open,item,',
    'the answer text is never rewritten; one line parser classifies findings, open items and closed items for every reader');
  const MR = path.join(W, 'mapf'), MFX = put(path.join(MR, 'm.js'), 'x\n');
  const ff = K.at(MR).review.findingFiles(`VERDICT: ISSUES_FOUND\n## **[HIGH]** decorated\n- Location: ${MFX}:1\n1. _OPEN_ — carried\n- Location: m.js:2\n${COV}`, { map: [] }, [MFX]);
  ok(ff instanceof Set && ff.has(MFX.toLowerCase()) && ff.size === 1, 'findingFiles maps decorated findings and open items with the same parser');
  ok(P.settlement('VERDICT: ISSUES_REMAIN\n1) MAINTAIN — x\n**2. CONCEDE** — y\n(3) _OPEN_ — z\n4. RESOLVED — w\n5. RESOLVED — v') === '1/2/1/1', 'stats count how decorated follow-up items settled (the same parser)');
  ok(/contradicts the findings/.test(cv(`VERDICT: ALL_10\nx: 10/10\n### [MEDIUM] a defect\n${COV}`, 'score', true).badFormat || ''), 'a score-with-files ALL_10 next to a listed finding is a contradiction');
  ok(/appears twice/.test(cv(`VERDICT: NO_ISSUES\n${COV.replace('tests=not examined', 'tests=checked; tests=checked')}`).badFormat || '') &&
    /not allowed/.test(cv(`VERDICT: NO_ISSUES\n${COV.replace('tests=not examined', 'tests=maybe; tests=checked')}`).badFormat || '') &&
    /not one of/.test(cv(`VERDICT: NO_ISSUES\n${COV}; extra=checked`).badFormat || '') && /not field=value/.test(cv(`VERDICT: NO_ISSUES\n${COV}; whatever`).badFormat || '') &&
    /not the last line/.test(cv(`VERDICT: NO_ISSUES\n${COV}\nthanks`).badFormat || ''), 'COVERAGE: exactly the five fields once each, nothing else, on the last line');
  const src = fs.readFileSync(__G + 'bridge/review.js', 'utf8'), fb = fs.readFileSync(path.join(__G, '..', 'agents', 'fallback-reviewer.md'), 'utf8');
  ok((src.match(/EVERY (?:confirmed finding|new confirmed defect|confirmed defect)/g) || []).length === 3 && (src.match(/P\.COVERAGE_RULE/g) || []).length === 3 && !/max 10/.test(src) &&
    !/at most 15/.test(fb) && /Report every finding/.test(fb) && /^COVERAGE: inputs\/encodings=/m.test(fb), 'initial, follow-up and score-with-files prompts and the fallback reviewer ask for every confirmed finding and the COVERAGE line, with no cap');
  // end to end with a Codex stub: a missing COVERAGE line is repaired once, else the review is not acknowledged
  const REC = path.join(W, 'calls.jsonl');
  const STUB = put(path.join(W, 'codex-cov.js'), `const fs = require('fs'); const a = process.argv.slice(2); let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(REC)}, JSON.stringify({ resume: a[1] === 'resume', input }) + '\\n');
  const m = process.env.STUB_MODE, cov = ${JSON.stringify('\n' + COV)};
  const text = process.env.STUB_TEXT ? process.env.STUB_TEXT : a[1] === 'resume' ? (m === 'never' ? 'VERDICT: NO_ISSUES' : 'VERDICT: NO_ISSUES' + cov) : 'VERDICT: NO_ISSUES';
  fs.writeFileSync(a[a.indexOf('-o') + 1], text); console.log('session id: 11111111-2222-3333-4444-555555555555'); });\n`);
  const cf = path.join(L.HOME, 'config.json'), orig = fs.readFileSync(cf, 'utf8');
  fs.writeFileSync(cf, JSON.stringify({ ...JSON.parse(orig), codexJs: STUB }));
  try {
    const RP = path.join(W, 'rev'), RF = put(path.join(RP, 'tool.js'), 'module.exports = 1;\n');
    const review = (mode, ...a) => node([__G + 'gpt.js', 'review', '--project', RP, '--task', 't', '--files', RF, ...a], { cwd: RP, env: { STUB_MODE: mode } });
    const calls = () => fs.readFileSync(REC, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    fs.rmSync(REC, { force: true });
    r = review('repair');
    const c1 = calls();
    ok(r.status === 0 && c1.length === 2 && c1[1].resume && /format defect: the COVERAGE line is missing/.test(c1[1].input) && /EVERY confirmed finding/.test(c1[0].input) && c1[0].input.includes(P.COVERAGE_LINE),
      'a review answer without COVERAGE gets one repair naming the defect, and then counts');
    fs.rmSync(REC, { force: true });
    fs.writeFileSync(RF, 'module.exports = 3;\n');
    const OPENLOG = path.join(RP, 'open.md');
    L.updateState(RP, s => { s.changes[RF] = { ...s.changes[RF], lines: 1, at: Date.now() + 5000, openFindings: [OPENLOG] }; });
    const pre = JSON.stringify(L.readState(RP).changes[RF]), preBase = fs.readFileSync(L.baselineOf(RP, RF), 'utf8');
    r = review('never');
    const after = L.readState(RP).changes[RF];
    ok(r.status === 3 && /GPT_UNAVAILABLE/.test(r.stdout) && calls().length === 2 && JSON.stringify(after) === pre && fs.readFileSync(L.baselineOf(RP, RF), 'utf8') === preBase &&
      after.at > L.reviewedAtFor(L.readState(RP), after) && [].concat(after.openFindings).includes(OPENLOG), 'still without it after the repair: nothing is acknowledged (pending, findings, review time and baseline unchanged)');
    // evidence labels
    fs.rmSync(REC, { force: true });
    review('repair', '--evidence', 'node -e "process.exit(0)"');
    ok(/matched the reviewed version before and after them/.test(calls()[0].input), 'evidence commands that leave the reviewed files alone: "matched"');
    fs.rmSync(REC, { force: true });
    const TOUCHER = put(path.join(W, 'touch.js'), `require('fs').appendFileSync(${JSON.stringify(RF)}, '// touched\\n');\n`);
    review('repair', '--evidence', `node "${TOUCHER}"`);
    ok(/DIFFERED from the reviewed version/.test(calls()[0].input), 'evidence commands that change a reviewed file: "DIFFERED"');
    const EVF = put(path.join(W, 'ev.txt'), 'tests passed\n'); const old = new Date(Date.now() - 3600000); fs.utimesSync(EVF, old, old);
    fs.writeFileSync(RF, 'module.exports = 2;\n');
    fs.rmSync(REC, { force: true });
    review('repair', '--evidence-file', EVF);
    ok(/supplied by Claude: what it tested is unverified, and these reviewed files changed after it was written: .*tool\.js/.test(calls()[0].input), 'an evidence file: "unverified", plus the reviewed files changed after it');
    // scoring: an open item next to a clean score is refused; next to BELOW_10 it stays tracked as a finding
    const RUB = put(path.join(W, 'rubric.md'), '- correctness\n');
    const score = text => node([__G + 'gpt.js', 'score', '--project', RP, '--file', RUB, '--files', RF], { cwd: RP, env: { STUB_TEXT: text } });
    fs.rmSync(REC, { force: true });
    const sPre = JSON.stringify(L.readState(RP).changes[RF]), sBase = fs.readFileSync(L.baselineOf(RP, RF), 'utf8');
    r = score(`VERDICT: ALL_10\ncorrectness: 10/10\n1. OPEN — still broken\n- Location: tool.js:1\n${COV}`);
    const sCalls = calls();
    ok(r.status === 3 && /GPT_UNAVAILABLE/.test(r.stdout) && sCalls.length === 2 && /format defect: the verdict ALL_10 contradicts the MAINTAIN\/OPEN items/.test(sCalls[1].input) &&
      JSON.stringify(L.readState(RP).changes[RF]) === sPre && fs.readFileSync(L.baselineOf(RP, RF), 'utf8') === sBase,
      'score --files: ALL_10 next to an open item is refused (repair asked, still contradictory) and nothing is acknowledged (state and baseline unchanged)');
    L.updateState(RP, s => { s.changes[RF] = { ...s.changes[RF], openFindings: undefined }; });
    r = score(`VERDICT: BELOW_10\ncorrectness: 9/10 — one open item\n1. OPEN — still broken\n- Location: tool.js:1\n${COV}`);
    const sc = L.readState(RP).changes[RF];
    ok(r.status === 0 && [].concat(sc.openFindings || []).length === 1 && sc.reviewStatus === 'findings', '... and next to BELOW_10 the open item stays an open finding on its file');
    // MAX_ROUNDS text: no "accept" route
    const L3 = put(path.join(RP, 'r3.md'), `- Round: 3\n- Files: ${JSON.stringify([RF])}\n`), RESP = put(path.join(W, 'resp.md'), 'x');
    r = node([__G + 'gpt.js', 'review', '--project', RP, '--followup', L3, '--file', RESP], { cwd: RP });
    ok(r.status === 4 && /fresh review of the fixed files/.test(r.stdout) && /--chain/.test(r.stdout) && !/--by claude-final/.test(r.stdout), 'at the round cap: a fresh review of the fixes, then close the chain — never "accept"');
  } finally { fs.writeFileSync(cf, orig); }

  // 7. Stop: restricted guidance; later Stops tell the user once what is still open
  const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
  const SP = path.join(W, 'stop'); fs.mkdirSync(SP, { recursive: true });
  const b = { cwd: SP, session_id: 'r31s-' + Date.now() };
  gate('session', b); gate('prompt', { ...b, prompt: 'go' }); wait(20);
  const SF = put(path.join(SP, 'x.js'), 'x\n'), LOG1 = path.join(SP, 'l1.md'), LOG2 = path.join(SP, 'l2.md');
  L.updateState(SP, s => { s.changes[SF] = { lines: 9, at: 1, reviewedAt: 2, openFindings: [LOG1] }; });
  const s1 = gate('stop', b), s2 = gate('stop', b), s3 = gate('stop', b);
  ok(/"decision":"block"/.test(s1) && /--chain/.test(s1) && !/accept|Final-round fixes/.test(s1), 'open findings block once, with the restricted dispositions (no "accept")');
  ok(!/decision/.test(s2) && /GPT findings still open .*the work isn't finished: .*x\.js \(.*l1\.md\)/.test(s2) && s3 === '', 'the next Stop tells the user once what is still open, without blocking; then it is quiet');
  L.updateState(SP, s => { s.changes[SF].openFindings = [LOG1, LOG2]; });
  ok(/l2\.md/.test(gate('stop', b)), '... and again when the open set changes');
  const w = n => { const e = { ...b, tool_use_id: 'w' + n, tool_name: 'Write', tool_input: { file_path: path.join(SP, 'y.py'), content: Array(9).fill('y' + n).join('\n') } }; gate('pre-edit', e); fs.writeFileSync(e.tool_input.file_path, e.tool_input.content); gate('post-edit', e); };
  gate('prompt', { ...b, prompt: 'more' }); wait(20); w(1);
  const p1 = gate('stop', b);
  ok(/"decision":"block"/.test(p1) && /--release/.test(p1) && !/Final-round fixes/.test(p1), 'the review-needed block names mirror acknowledgement with --release, no "Final-round fixes"');

  fs.rmSync(W, { recursive: true, force: true });
}
