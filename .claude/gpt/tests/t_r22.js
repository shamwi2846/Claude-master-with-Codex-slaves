// Review B fixes: overwritten drafts, ignore precedence, checkout over ignored files, receipts hashed under
// the lock, verified setup writes, strict receipt locks, probe deadline, bulk moves, Stop-note signature.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const K = require('./bridge-kit');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const pendIn = (root, p) => { const s = L.readState(root); const c = Object.entries(s.changes).find(([k]) => k.toLowerCase() === p.toLowerCase()); return c && c[1].at > L.reviewedAtFor(s, c[1]) ? c[1] : null; };
const dir = n => { const d = path.join(os.homedir(), n); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const ackAll = root => K.at(root).review.markReviewed('claude-final', Date.now(), null, L.gitDeleted(root));
const SID = 'r22-' + Date.now();
const gitIn = d => (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
const initRepo = (d, git) => { git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false'); };

// ---- git project
const P = dir('gpt-final'), f = n => path.join(P, n), git = gitIn(P), b = { cwd: P, session_id: SID };
const prompt = () => { wait(30); gate('prompt', { ...b, prompt: 'go' }); wait(30); };
const pend = n => pendIn(P, f(n));
const fresh = () => { git('add', '-A'); git('commit', '-qm', 'x'); ackAll(P); prompt(); };
initRepo(P, git);
put(f('src/a.mq5'), 'void A(){ OrderSend(1); }\n'); put(f('src/old.js'), 'module.exports = 0;\n');
for (let i = 0; i < 20; i++) put(f(`lib/m${i}.js`), `module.exports = ${i};\n`);
put(f('.claude/gpt.json'), JSON.stringify({ ignore: ['gen/**'] }));
git('add', '-A'); git('commit', '-qm', 'init'); wait(1100);
gate('session', b); prompt();

// 1. an untracked draft that existed at turn start, overwritten with committed content, is a change
fresh(); gate('stop', b); wait(30); // the turn ends; the owner writes a draft between turns
put(f('draft.mq5'), 'owner draft\n'); prompt();
const draftBefore = pend('draft.mq5');
fs.copyFileSync(f('src/a.mq5'), f('draft.mq5'));
gate('stop', b);
ok(!draftBefore && pend('draft.mq5'), "git: the owner's untracked draft is not pending; overwriting it with committed content is");

// 9. moving many files (over the bulk threshold) is still a move: the originals are not pending
fresh(); fs.mkdirSync(f('archive'));
for (let i = 0; i < 20; i++) fs.renameSync(f(`lib/m${i}.js`), f(`archive/m${i}.js`));
gate('stop', b);
ok([...Array(20).keys()].every(i => !pend(`lib/m${i}.js`)), 'git: a bulk move leaves no pending deletions');

// 2. an ignored file that already has open findings (or a pending change) stays tracked
fresh(); put(f('gen/out.mq5'), 'void G(){}\n'); git('add', '-A'); git('commit', '-qm', 'g'); ackAll(P); prompt();
L.updateState(P, s => { s.changes[f('gen/out.mq5')] = { lines: 6, at: 1, reviewedAt: 2, openFindings: [f('r.md')] }; });
const eg = { ...b, tool_use_id: 'g1', tool_name: 'Edit', tool_input: { file_path: f('gen/out.mq5'), old_string: 'G', new_string: 'H' } };
gate('pre-edit', eg); put(f('gen/out.mq5'), 'void H(){}\n'); gate('post-edit', eg);
ok(pend('gen/out.mq5'), 'git: editing an ignored file with open findings records a new pending version');
L.updateState(P, s => { delete s.changes[f('gen/out.mq5')].openFindings; });
const atBefore = (pend('gen/out.mq5') || {}).at || 0;
wait(50); put(f('gen/out.mq5'), 'void I(){}\n'); gate('stop', b);
ok(atBefore && (pend('gen/out.mq5') || {}).at > atBefore, 'git: a pending ignored file changed again gets a new version from the turn scan');

// 10. a change that keeps an old file time is not re-noted at every Stop
fresh();
put(f('src/old.js'), 'module.exports = 1; // shell, old time\n'); const t0 = new Date(Date.now() - 5 * 3600e3); fs.utimesSync(f('src/old.js'), t0, t0);
put(f('src/z.js'), Array(8).fill('let z;').join('\n'));
const n1 = gate('stop', b); wait(20); const n2 = gate('stop', b); wait(20); const n3 = gate('stop', b);
ok(/"decision":"block"/.test(n1) && n2 === '' && n3 === '', 'Stop note: an old-time change re-dated by each scan does not repeat the note');
fresh(); // the same for a file too big to hash (over 5 MB)
put(f('reports/big.htm'), '<p>' + 'x'.repeat(6 * 1024 * 1024) + '</p>\n'); fs.utimesSync(f('reports/big.htm'), t0, t0);
const m1 = gate('stop', b); wait(20); const m2 = gate('stop', b); wait(20); const m3 = gate('stop', b);
ok(/"decision":"block"/.test(m1) && m2 === '' && m3 === '', 'Stop note: an unchanged file over 5 MB does not repeat the note');

// ---- 3. a parent session's unreviewed gpt.json change keeps a sub-folder session from applying it
const PP = dir('gpt-final2'), CH = path.join(PP, 'child');
put(path.join(PP, '.claude', 'gpt.json'), JSON.stringify({ ignore: ['**/*.mq5'] }));
fs.mkdirSync(CH, { recursive: true });
const bp = { cwd: PP, session_id: SID + 'p' }, bc = { cwd: CH, session_id: SID + 'c' };
for (const x of [bp, bc]) { gate('session', x); gate('prompt', { ...x, prompt: 'go' }); }
wait(30);
L.updateState(PP, s => { s.changes[path.join(PP, '.claude', 'gpt.json')] = { lines: 1, sensitive: true, at: Date.now() }; }); // widened in the parent session, not reviewed yet
const ec = { ...bc, tool_use_id: 'c1', tool_name: 'Write', tool_input: { file_path: path.join(CH, 'x.mq5'), content: 'void X(){}\n' } };
gate('pre-edit', ec); put(path.join(CH, 'x.mq5'), 'void X(){}\n'); gate('post-edit', ec);
ok(pendIn(CH, path.join(CH, 'x.mq5')), "a parent session's unreviewed ignore list is not applied in a sub-folder session");
K.at(PP).review.markReviewed('claude-final', Date.now(), [path.join(PP, '.claude', 'gpt.json')], []); wait(5);
const ec2 = { ...bc, tool_use_id: 'c2', tool_name: 'Write', tool_input: { file_path: path.join(CH, 'y.mq5'), content: 'void Y(){}\n' } };
gate('pre-edit', ec2); put(path.join(CH, 'y.mq5'), 'void Y(){}\n'); gate('post-edit', ec2);
ok(!pendIn(CH, path.join(CH, 'y.mq5')), 'once reviewed, the inherited ignore list applies');
// a session in an unrelated folder changed this project's gpt.json by its full path: not applied until reviewed
const X = dir('gpt-final7'), bx = { cwd: X, session_id: SID + 'x' }; gate('session', bx); gate('prompt', { ...bx, prompt: 'go' });
L.updateState(X, s => { s.changes[path.join(PP, '.claude', 'gpt.json')] = { lines: 1, sensitive: true, at: Date.now() }; });
const ec3 = { ...bc, tool_use_id: 'c3', tool_name: 'Write', tool_input: { file_path: path.join(CH, 'z.mq5'), content: 'void Z(){}\n' } };
gate('pre-edit', ec3); put(path.join(CH, 'z.mq5'), 'void Z(){}\n'); gate('post-edit', ec3);
ok(pendIn(CH, path.join(CH, 'z.mq5')), "another (unrelated) session's unreviewed change of the gpt.json suspends its ignore list");
fs.rmSync(X, { recursive: true, force: true });

// ---- 4. non-git folder: a checkout that overwrites an ignored local file is a change; 8. probe deadline
const Q = dir('gpt-final3'), NR = path.join(Q, 'repo'), ng = gitIn(NR), bq = { cwd: Q, session_id: SID + 'q' };
fs.mkdirSync(NR); initRepo(NR, ng); ng('checkout', '-q', '-b', 'main');
put(path.join(NR, '.gitignore'), 'conf.mqh\n'); put(path.join(NR, 'e.mq5'), 'void E(){}\n'); ng('add', '-A'); ng('commit', '-qm', 'main');
ng('checkout', '-q', '-b', 'other'); fs.rmSync(path.join(NR, '.gitignore'));
put(path.join(NR, 'conf.mqh'), 'input double Risk = 9;\n'); ng('add', '-A'); ng('commit', '-qm', 'other');
ng('checkout', '-q', 'main'); put(path.join(NR, 'conf.mqh'), "input double Risk = 1; // the owner's local, ignored\n");
wait(1500);
gate('session', bq); gate('prompt', { ...bq, prompt: 'go' }); wait(30);
const cmd = 'git -C repo checkout other';
const mainHead = ng('rev-parse', 'HEAD').stdout.trim(), tc = Date.now();
gate('pre-bash', { ...bq, tool_use_id: 'k1', tool_input: { command: cmd } }); ng('checkout', '-q', 'other'); gate('post-bash', { ...bq, tool_use_id: 'k1', tool_input: { command: cmd } });
ok(/Risk = 9/.test(fs.readFileSync(path.join(NR, 'conf.mqh'), 'utf8')) && pendIn(Q, path.join(NR, 'conf.mqh')), 'nested repo: a checkout overwriting an ignored local file is pending');
// the same probe (a checkout-only reflog window): a test with time to spare, none without
const pre = { head: mainHead, dirty: [] };
ok(typeof L.branchSwitch(NR, pre, tc, Date.now() + 8000) === 'function' && L.branchSwitch(NR, pre, tc, Date.now() + 100) === null, 'branch-switch probe with no time left gives no exemption');

// ---- 6. a setup file is registered as another session's write only when it holds what that tool wrote
const AG = path.join(os.homedir(), '.claude', 'agents', 'zz-r22.md'); put(AG, 'name: t\n');
const PA = dir('gpt-final4'), PB = dir('gpt-final5');
const bA = { cwd: PA, session_id: SID + 'A' }, bB = { cwd: PB, session_id: SID + 'B' };
for (const x of [bA, bB]) { gate('session', x); gate('prompt', { ...x, prompt: 'go' }); }
wait(30);
gate('pre-bash', { ...bB, tool_use_id: 'b1', tool_input: { command: 'run' } });
const wa = { ...bA, tool_use_id: 'a1', tool_name: 'Write', tool_input: { file_path: AG, content: 'name: t\nfrom: A\n' } };
gate('pre-edit', wa); put(AG, 'name: t\nfrom: B (overwrote A before its hook ran)\n'); gate('post-edit', wa);
gate('post-bash', { ...bB, tool_use_id: 'b1', tool_input: { command: 'run' } });
ok(pendIn(PB, AG), "bytes another session didn't write are not registered as its write (the shell change stays tracked)");
put(path.join(PA, '.claude', 'gpt.json'), '{"review":false}'); // a session whose project doesn't review its changes
const wa2 = { ...bA, tool_use_id: 'a2', tool_name: 'Write', tool_input: { file_path: AG, content: 'name: t\nfrom: A2\n' } };
gate('pre-edit', wa2); put(AG, 'name: t\nfrom: A2\n'); gate('post-edit', wa2);
ok(!((L.readState(L.HOME).setupWrites || {})[AG.toLowerCase()] || {}).sid?.startsWith(SID + 'A2') && ((L.readState(L.HOME).setupWrites || {})[AG.toLowerCase()] || {}).hash !== L.printOf(AG), 'a session in a project with reviews off never registers setup writes');
fs.rmSync(AG, { force: true });

// ---- 5. receipts carry the acknowledged content, not what the file holds afterwards; 7. strict locks
const O = dir('gpt-final6'), S = path.join(O, 'sub'), F = path.join(S, 'r.mq5');
put(F, 'content A\n');
for (const root of [O, S]) L.updateState(root, s => { s.changes[F] = { lines: 6, sensitive: true, at: Date.now() - 100 }; });
const realSet = L.setBaseline;
L.setBaseline = (root, abs, from) => { realSet(root, abs, from); if (path.resolve(abs).toLowerCase() === F.toLowerCase() && root === S) fs.writeFileSync(F, 'content B (written right after the acknowledgement)\n'); };
K.at(S).review.markReviewed('claude-final', Date.now(), [F], []);
L.setBaseline = realSet;
ok(pendIn(O, F), 'content written after an acknowledgement is not acknowledged in another project');
put(F, 'content C\n');
L.updateState(O, s => { s.changes[F] = { lines: 6, sensitive: true, at: Date.now() - 100 }; });
L.updateState(S, s => { s.changes[F] = { lines: 6, sensitive: true, at: Date.now() - 100 }; });
const baseBefore = L.baselineOf(O, F), baseText = baseBefore && baseBefore !== 'ABSENT' ? fs.readFileSync(baseBefore, 'utf8') : null;
const lock = L.statePath(O) + '.lock'; fs.mkdirSync(lock);
const keep = setInterval(() => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch {} }, 1000);
setTimeout(() => {
  K.at(S).review.markReviewed('claude-final', Date.now(), [F], []);
  clearInterval(keep); fs.rmSync(lock, { recursive: true, force: true });
  const baseAfter = L.baselineOf(O, F), afterText = baseAfter && baseAfter !== 'ABSENT' ? fs.readFileSync(baseAfter, 'utf8') : null;
  ok(pendIn(O, F) && afterText === baseText, "a busy project's lock is never bypassed when sharing a receipt (its baseline untouched)");
  for (const d of [P, PP, Q, PA, PB, O]) fs.rmSync(d, { recursive: true, force: true });
  L.updateState(L.HOME, g => { if (g.sessionRoots) for (const k of Object.keys(g.sessionRoots)) if (k.startsWith('r22')) delete g.sessionRoots[k]; });
}, 10);
