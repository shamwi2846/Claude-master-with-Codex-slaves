// Release the live setup into the backup folder, only if it is healthy.
// Usage: node release.js [--backup <dir>] [--allow-unreviewed (the user's override only)] [--gate-only (tests)]
//   1. freeze a complete candidate in <backup>/.candidate: a consistent copy of the setup files (setup-files.js
//      capture), copies of the backup folder's restore.js / README.md / AGENT-SETUP.md, and .claude/RELEASE.txt
//      (date + every file's hash); refused if any project's state still knows a released (or deleted) file as
//      unreviewed;
//   2. check THE CANDIDATE: syntax of every script, its config.json, then its own regression checks in strict
//      mode (nothing skipped) with the candidate as the backup under test (the restore checks restore it); then
//      the unreviewed check again, and the live setup must still be exactly the checked version;
//   3. publish: <backup>/.claude becomes .claude.prev and the candidate's .claude takes its place.
// One release at a time per backup folder: the lock is a listening socket on 127.0.0.1 at a port derived from
// the backup path — held by the OS for exactly as long as this process lives (no stale locks, no races).
// A publish interrupted between its two renames is repaired at the next start (.claude.prev put back).
// restore.js verifies the manifest before restoring.
// Backup folder: --backup, else GPT_BACKUP_DIR, else ~/Desktop/Cloude agent (must already hold restore.js).
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const S = require('./setup-files');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const CLAUDE = path.join(os.homedir(), '.claude');
const backup = path.resolve(opt('--backup') || process.env.GPT_BACKUP_DIR || path.join(os.homedir(), 'Desktop', 'Cloude agent'));
const cand = path.join(backup, '.candidate'), cur = path.join(backup, '.claude'), prev = path.join(backup, '.claude.prev');
let locked = false;
const die = m => {
  try { if (locked) fs.rmSync(cand, { recursive: true, force: true }); } catch {}
  console.error(`Release aborted, backup unchanged: ${m}`); process.exit(1);
};
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
if (!fs.existsSync(path.join(backup, 'restore.js'))) die(`${backup} is not the backup folder (no restore.js)`);

// (below Windows' outgoing-connection port range 49152-65535, where any open connection could hold it)
const lockPort = 20000 + parseInt(crypto.createHash('sha1').update(backup.toLowerCase()).digest('hex').slice(0, 4), 16) % 16000;
const lockServer = require('net').createServer();
lockServer.on('error', e => die(e.code === 'EADDRINUSE' ? `another release is running (it holds 127.0.0.1:${lockPort})` : `release lock: ${e.message}`));
lockServer.listen(lockPort, '127.0.0.1', () => { locked = true; release(); process.exit(0); });

function release() {
// An earlier publish stopped between its renames: put the previous backup back first.
if (!fs.existsSync(cur) && fs.existsSync(prev)) { fs.renameSync(prev, cur); console.log('repaired an interrupted release: restored .claude from .claude.prev'); }

// What a restore needs (restore.js copies the same list) plus the regression checks (setup-files.js); and the
// backup folder's own files, which the manifest also vouches for.
const extras = ['restore.js', 'README.md', 'AGENT-SETUP.md'].filter(f => fs.existsSync(path.join(backup, f)));

// 1. freeze the candidate: a copy that agrees with the live setup before and after copying
fs.rmSync(cand, { recursive: true, force: true });
let snap;
try { snap = S.capture(CLAUDE, path.join(cand, '.claude'), S.listSetup); } catch (e) { die(e.message); }
const files = snap.files.map(([f]) => f), staged = Object.fromEntries(snap.files), extraHash = {};
for (const f of extras) { fs.copyFileSync(path.join(backup, f), path.join(cand, f)); extraHash[f] = hash(path.join(cand, f)); }
// The backstop: nothing a project's state still knows as unreviewed (a pending change or open findings) is
// released — the released files, and files the last release had that are now gone (their deletion). Not proof of
// review (the per-turn Stop hook is the primary control); --allow-unreviewed is the user's override only.
const lastRelease = (() => { try { return fs.readFileSync(path.join(cur, 'RELEASE.txt'), 'utf8'); } catch { return ''; } })();
const deleted = [...lastRelease.matchAll(/^[0-9a-f]{16} {2}\.claude\/(.+)$/gm)].map(m => m[1].trim()).filter(f => !files.includes(f));
const Lc = require(path.join(cand, '.claude', 'gpt', 'lib.js'));
const gate = when => {
  if (args.includes('--allow-unreviewed')) return;
  const { blocked, unreadable } = Lc.knownUnreviewed(files.concat(deleted).map(f => path.join(CLAUDE, f)));
  if (blocked.length || unreadable.length) die(`not released (${when}) — known unreviewed:\n${blocked.map(b => `  ${b.file}: ${b.why} — in ${b.root}`).join('\n')}` +
    (unreadable.length ? `\n  project state that could not be read (its records are unknown): ${unreadable.join(', ')}` : '') +
    '\nReview them, or close them as CLAUDE.md allows, then release again.');
};
gate('before the checks');
if (args.includes('--gate-only')) { fs.rmSync(cand, { recursive: true, force: true }); console.log('release gate passed (--gate-only: nothing released)'); return; }
// Source: the .claude folder released from — restore.js relocates its paths (hook commands, docs) to the
// restoring user's folder, whichever user released.
const manifest = (checks, tested) => `Released ${new Date().toISOString()}\nSource: ${CLAUDE.replace(/\\/g, '/')}\nChecks: ${checks}\n${tested ? `Tested: ${tested}\n` : ''}\n` +
  files.map(f => `${staged[f]}  .claude/${f}`).concat(extras.map(f => `${extraHash[f]}  ${f}`)).join('\n') + '\n';
fs.writeFileSync(path.join(cand, '.claude', 'RELEASE.txt'), manifest('running'));

// 2. check the candidate itself
for (const f of files.filter(f => f.endsWith('.js')).map(f => path.join(cand, '.claude', f)).concat(path.join(cand, 'restore.js'))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) die(`syntax error in ${f}\n${r.stderr}`);
}
let conf;
try { conf = JSON.parse(fs.readFileSync(path.join(cand, '.claude', 'gpt', 'config.json'), 'utf8')); } catch (e) { die(`config.json: ${e.message}`); }
const bad = require(path.join(cand, '.claude', 'gpt', 'lib.js')).validateConfig(conf);
if (bad.length) die(`config.json invalid: ${bad.map(([k, n]) => `${k} must be ${n}`).join(', ')}`);
const r = spawnSync(process.execPath, [path.join(cand, '.claude', 'gpt', 'tests', 'run.js'), '--strict'], { encoding: 'utf8', timeout: 1800000, env: { ...process.env, GPT_BACKUP_DIR: cand } });
const result = (`${r.stdout || ''}`.trim().split('\n').pop() || '').trim();
const tested = ((`${r.stdout || ''}`.match(/^tested: (.+)$/m) || [])[1] || '').trim();
if (r.status !== 0) die(`regression checks failed\n${`${r.stdout || ''}${r.stderr || ''}`.trim()}`);
// The backup folder's own files are published as they are, so they must still be what was checked.
const moved = extras.filter(f => hash(path.join(backup, f)) !== extraHash[f]);
if (moved.length) die(`backup files changed while the checks ran: ${moved.join(', ')} — release again`);
// Findings reported while the checks ran still block.
gate('after the checks');
// Certification: the live setup must still BE the checked version (files added, removed or changed since the
// copy was taken mean the live work isn't what was checked) — refused before anything is published.
const nowLive = S.inventory(CLAUDE, S.listSetup(CLAUDE));
if (S.keyOf(nowLive) !== S.keyOf(snap.files)) {
  const was = new Map(snap.files), now = new Map(nowLive);
  const diff = [...new Set([...was.keys(), ...now.keys()])].filter(f => was.get(f) !== now.get(f))
    .map(f => `${f} ${!now.has(f) ? 'removed' : !was.has(f) ? 'added' : 'changed'}`);
  die(`the live setup changed during the release (${diff.join(', ')}) — release again`);
}
fs.writeFileSync(path.join(cand, '.claude', 'RELEASE.txt'), manifest(result, tested));

// 3. publish (the previous backup is put back if the swap fails)
fs.rmSync(prev, { recursive: true, force: true });
const had = fs.existsSync(cur);
if (had) fs.renameSync(cur, prev);
try { fs.renameSync(path.join(cand, '.claude'), cur); } catch (e) { if (had) fs.renameSync(prev, cur); die(`could not publish: ${e.message}`); }
fs.rmSync(cand, { recursive: true, force: true });
try { fs.rmSync(path.join(backup, 'RELEASE.txt'), { force: true }); } catch {} // manifests now live in .claude/
console.log(`Released ${files.length} files to ${cur}${had ? ' (previous backup kept in .claude.prev)' : ' (first release here)'} — checks: ${result}${tested ? ` (tested ${tested})` : ''}`);
}
