// Proves that a regression check catches the bug it was written for: it must FAIL on the code before the fix
// (on the identified assertion — not a crash, timeout, skip or "no checks ran") and PASS on the fixed code.
// Usage: node prove.js <t_script> --expect "<text of its FAIL line>" [--old <.claude folder>]
//   --old: the version before the fix (default: the last release, <backup>/.claude — prove before releasing).
// Scope: fixes to the setup's production code (gpt.js, gate.js, lib.js, bridge/*.js, config.json). Both versions
// run the SAME test cases, helpers and test tools (one consistent copy of the live ones) against the same backup
// copy; only the production files differ. Fixes to the test tools themselves (run.js, release.js, ...) are not
// covered here: their own fixture checks (t_r31) show the old behaviour and the new.
const fs = require('fs'), path = require('path'), os = require('os');
const S = require('./setup-files'), R = require('./run');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const valued = new Set(['--expect', '--old']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const name = positional[0], expect = opt('--expect');
const LIVE = path.join(__dirname, '..', '..');
const BACKUP = process.env.GPT_BACKUP_DIR || path.join(os.homedir(), 'Desktop', 'Cloude agent');
const OLD = path.resolve(opt('--old') || path.join(BACKUP, '.claude'));

class Stop extends Error {}
const stop = m => { throw new Stop(m); };

function prove() {
  if (!name || !expect) stop('usage: node prove.js <t_script> --expect "<text of its FAIL line>" [--old <.claude folder>]');
  R.cleanStale();
  const W = path.join(os.homedir(), `.gpt-prove-${process.pid}`);
  try {
    const NEW = path.join(W, 'new', '.claude'), OLDD = path.join(W, 'old', '.claude');
    const newSnap = S.capture(LIVE, NEW, S.listSetup);
    const sel = R.select(path.join(NEW, 'gpt', 'tests'), [name], true);
    if (sel.error) stop(sel.error);
    const script = sel.scripts[0];
    // OLD = the same copy with the old production files in place of the new ones
    const oldProd = S.capture(OLD, path.join(W, 'oldprod'), d => S.listSetup(d).filter(S.isProduction));
    if (!oldProd.files.length) stop(`${OLD} holds no setup production files`);
    const newProd = newSnap.files.filter(([f]) => S.isProduction(f));
    if (S.keyOf(oldProd.files) === S.keyOf(newProd)) stop(`the old version's production code is the same as the live one: pass --old <the version before the fix>`);
    fs.cpSync(NEW, OLDD, { recursive: true });
    for (const [f] of newProd) fs.rmSync(path.join(OLDD, f), { force: true });
    for (const [f] of oldProd.files) { fs.mkdirSync(path.dirname(path.join(OLDD, f)), { recursive: true }); fs.copyFileSync(path.join(W, 'oldprod', f), path.join(OLDD, f)); }
    const hasBackup = fs.existsSync(path.join(BACKUP, 'restore.js'));
    const bk = hasBackup ? S.capture(BACKUP, path.join(W, 'backup'), S.listBackup) : null;
    const tests = S.hashOf(S.keyOf(newSnap.files.filter(([f]) => f.startsWith('gpt/tests/'))));
    console.log(`checks and tools sha256 ${tests} (the same in both); old production sha256 ${S.hashOf(S.keyOf(oldProd.files))}; new production sha256 ${S.hashOf(S.keyOf(newProd))}; backup sha256 ${bk ? bk.hash : 'none'}`);
    const run = dir => R.runSuite({ setupDir: dir, backupDir: bk ? path.join(W, 'backup') : null, scripts: [script], strict: true, log: () => {} }).details[0];
    const o = run(OLDD), n = run(NEW);
    const why = [];
    const hit = o.failLines.filter(l => l.includes(expect));
    if (!hit.length) why.push(o.fail ? `on the old code it failed, but not with "${expect}" (${o.failLines.slice(0, 3).join(' | ')})` : 'on the old code it did not fail');
    if (o.crashed) why.push(`on the old code it crashed or timed out (exit ${o.exit})`);
    if (o.skip) why.push(`on the old code it was skipped (${o.skip})`);
    if (o.noChecks) why.push('on the old code no checks ran');
    if (n.fail || n.crashed || n.skip || n.noChecks || !n.pass) why.push(`on the fixed code it did not pass cleanly (${n.pass} passed, ${n.fail} failed${n.crashed ? ', crashed' : ''}${n.skip ? ', skipped' : ''}${n.failLines.length ? `: ${n.failLines.slice(0, 3).join(' | ')}` : ''})`);
    if (why.length) stop(`NOT PROVEN: ${script} — ${why.join('; ')}`);
    console.log(`PROVEN: ${script} fails on the old code (${hit.join(' | ')}) and passes on the fixed code (${n.pass} checks).`);
  } finally {
    fs.rmSync(W, { recursive: true, force: true, maxRetries: 3 });
  }
}

try { prove(); } catch (e) {
  console.log(e instanceof Stop ? e.message : `NOT PROVEN: ${e.message}`);
  process.exitCode = 1;
}
