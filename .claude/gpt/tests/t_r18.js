// Goal round 7: damaged state is never overwritten and ownership can't look free; restore -> release under
// another user -> restore keeps every hook.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);

// a damaged project state file keeps its bytes; the update is dropped and traced
const P = path.join(os.homedir(), 'gpt-final'); fs.mkdirSync(P, { recursive: true });
fs.mkdirSync(L.STATE_DIR, { recursive: true });
fs.writeFileSync(L.statePath(P), '{"changes": {"x": BROKEN');
const r1 = L.updateState(P, s => { s.changes.y = { at: 1 }; return 'ran'; });
ok(r1 === 'ran' && fs.readFileSync(L.statePath(P), 'utf8') === '{"changes": {"x": BROKEN' && /unreadable/.test(L.recentHookIssues(1).pop()[2]), 'damaged state: update not written, file kept, traced');
ok(L.updateState(P, () => 'ran', true).lockFailed === true, 'damaged state: strict (ownership) update refused');
ok(L.quickChecks().some(c => c.name === 'state files readable' && !c.ok), 'doctor reports the damaged state file');
// ...and it is said, not hidden: Stop, status and review all report tracking as unavailable
const sid = 'r18-' + Date.now();
const stop = spawnSync(process.execPath, [__G + 'gate.js', 'stop'], { input: JSON.stringify({ cwd: P, session_id: sid }), encoding: 'utf8' }).stdout;
const status = JSON.parse(spawnSync(process.execPath, [__G + 'gpt.js', 'status', '--project', P], { encoding: 'utf8' }).stdout);
const rev = spawnSync(process.execPath, [__G + 'gpt.js', 'review', '--task', 'x', '--project', P], { encoding: 'utf8' });
ok(/tracking is OFF/.test(stop) && !/"decision":"block"/.test(stop) && /UNKNOWN/.test(status.trackingUnavailable || '') && /tracking is unavailable/.test(rev.stderr),
  'damaged state: Stop (no block), status and review all say tracking is unavailable');
L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[sid]; });
fs.rmSync(L.statePath(P), { force: true });

// damaged global state: desktop ownership can't be verified, so nobody gets the desktop
fs.writeFileSync(L.statePath(L.HOME), 'garbage');
L.updateState(L.HOME, () => {}); // (would have reset it before)
const pc = spawnSync(process.execPath, [__G + 'gate.js', 'pre-computer'], { input: JSON.stringify({ cwd: P, session_id: 'r18', tool_name: 'mcp__computer-use__screenshot' }), encoding: 'utf8' }).stdout;
const gc = spawnSync(process.execPath, [__G + 'gpt.js', 'computer', '--task', 'noop', '--project', P], { encoding: 'utf8', timeout: 90000 });
ok(/"permissionDecision":"deny"/.test(pc) && gc.status === 6 && fs.readFileSync(L.statePath(L.HOME), 'utf8') === 'garbage', 'damaged global state: Claude and GPT both refused the desktop; file kept');
// ...even where Claude is allowed the desktop (project override computerUse: claude): the strict check refuses
fs.mkdirSync(path.join(P, '.claude'), { recursive: true }); fs.writeFileSync(path.join(P, '.claude', 'gpt.json'), '{"computerUse":"claude"}');
const pc2 = spawnSync(process.execPath, [__G + 'gate.js', 'pre-computer'], { input: JSON.stringify({ cwd: P, session_id: 'r18b', tool_name: 'mcp__computer-use__screenshot' }), encoding: 'utf8' }).stdout;
ok(/"permissionDecision":"deny"/.test(pc2) && /could not be checked/.test(pc2), 'allowed-Claude path with damaged global state: denied (ownership unverifiable)');
fs.rmSync(L.statePath(L.HOME), { force: true });

// a state WRITE that fails while GPT owns the desktop never lets Claude in (the hook fails closed)
L.updateState(L.HOME, g => { g.computerLock = { pid: process.pid, at: Date.now(), project: 'test' }; g.sessionRoots = { r18c: { root: P, at: Date.now() } }; });
fs.chmodSync(L.statePath(L.HOME), 0o444); // read-only: the atomic replace fails
const pc3 = spawnSync(process.execPath, [__G + 'gate.js', 'pre-computer'], { input: JSON.stringify({ cwd: P, session_id: 'r18c', tool_name: 'mcp__computer-use__screenshot' }), encoding: 'utf8' }).stdout;
fs.chmodSync(L.statePath(L.HOME), 0o666);
ok(/"permissionDecision":"deny"/.test(pc3) && /could not be checked/.test(pc3) && !/GPT is operating/.test(pc3), 'state write failure while GPT owns the desktop: denied because the record failed');
fs.rmSync(L.statePath(L.HOME), { force: true });
fs.rmSync(P, { recursive: true, force: true });

// restore -> "release" from that user -> restore as a third user: hooks point at the third user's setup
const SRC = process.env.GPT_BACKUP_DIR;
if (SRC && fs.existsSync(path.join(SRC, '.claude', 'RELEASE.txt'))) {
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  const H1 = path.join(os.homedir(), 'user1'), H2 = path.join(os.homedir(), 'user2'), B2 = path.join(os.homedir(), 'bk2');
  const restore = (from, H) => { fs.mkdirSync(path.join(H, '.claude'), { recursive: true }); return spawnSync(process.execPath, [path.join(from, 'restore.js')], { env: { ...process.env, USERPROFILE: H, HOME: H }, encoding: 'utf8' }); };
  const r = restore(SRC, H1);
  if (r.status !== 0) console.log(`(restore from ${SRC} failed: ${String(r.stderr).trim().slice(0, 300)})`);
  fs.mkdirSync(B2, { recursive: true });
  // what release.js would publish from user1: the restored files (hooks now name user1's folder)
  const rels = [];
  (function walk(d, rel) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), q = rel ? `${rel}/${n}` : n; if (fs.statSync(p).isDirectory()) { if (!/^(state|logs|baseline|snap|stage|backups)$/.test(n)) walk(p, q); } else rels.push(q); } })(path.join(H1, '.claude'), '');
  for (const rel of rels) { const to = path.join(B2, '.claude', rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(H1, '.claude', rel), to); }
  for (const f of ['restore.js', 'README.md', 'AGENT-SETUP.md']) if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(B2, f));
  const lines = rels.map(rel => `${sha(path.join(B2, '.claude', rel))}  .claude/${rel}`)
    .concat(['restore.js', 'README.md', 'AGENT-SETUP.md'].filter(f => fs.existsSync(path.join(B2, f))).map(f => `${sha(path.join(B2, f))}  ${f}`));
  fs.writeFileSync(path.join(B2, '.claude', 'RELEASE.txt'), `Released ${new Date().toISOString()}\nSource: ${path.join(H1, '.claude').replace(/\\/g, '/')}\nChecks: test\n\n${lines.join('\n')}\n`);
  const r2 = restore(B2, H2);
  const hooks = JSON.stringify(JSON.parse(fs.readFileSync(path.join(H2, '.claude', 'settings.json'), 'utf8')).hooks || {});
  const mine = (hooks.match(/gate\.js/g) || []).length;
  const want = path.join(H2, '.claude', 'gpt', 'gate.js').replace(/\\/g, '/');
  ok(r.status === 0 && r2.status === 0 && mine >= 9 && hooks.split(want).length - 1 === mine && !hooks.includes('user1'), 'a backup released by another user restores with every hook pointing at the new user');
  for (const d of [H1, H2, B2]) fs.rmSync(d, { recursive: true, force: true });
} else console.log('SKIP no released backup (GPT_BACKUP_DIR with .claude/RELEASE.txt)');
