// Round-11 hook fixes.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const SID = 'r11-' + Date.now(), b = { cwd: P, session_id: SID };
const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
const f = n => path.join(P, n);
const old = (p, h = 1) => { const t = new Date(Date.now() - h * 3600e3); fs.utimesSync(p, t, t); };
const prompt = () => { wait(30); gate('prompt', { ...b, prompt: 'go' }); wait(30); };
const pend = n => { const s = L.readState(P); const c = Object.entries(s.changes).find(([k]) => k.toLowerCase() === f(n).toLowerCase()); return c && c[1].at > L.reviewedAtFor(s, c[1]) ? c[1] : null; };
const mr = require('./bridge-kit').at(P).review.markReviewed;
const ack = () => mr('claude-final', Date.now(), null, L.gitDeleted(P));
const fresh = () => { git('add', '-A'); git('commit', '-qm', 'x'); ack(); prompt(); };
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
fs.writeFileSync(f('.gitignore'), '*.set\n.claude/settings.local.json\n**/.claude/settings.local.json\n');
for (const n of ['A.mq5', 'B.mq5']) fs.writeFileSync(f(n), n + ' v1\n');
fs.writeFileSync(f('p.set'), 'R=1\n');
git('add', '-A'); git('add', '-f', 'p.set'); git('commit', '-qm', 'init'); wait(1100);
gate('session', b); prompt();

// a. a running review froze B; then A is copied over B keeping A's older in-turn time -> B not covered
fs.writeFileSync(f('A.mq5'), 'A v2\n'); wait(50); fs.writeFileSync(f('B.mq5'), 'B v2\n'); gate('stop', b);
const cB = pend('B.mq5');
L.updateState(P, s => { s.running = { x: { pid: process.pid, cutoff: Date.now(), files: [f('A.mq5').toLowerCase(), f('B.mq5').toLowerCase()].sort(), hashes: [f('A.mq5'), f('B.mq5')].sort((x, y) => x.toLowerCase() < y.toLowerCase() ? -1 : 1).map(L.fileHash) } }; });
const cut = L.readState(P).running.x.cutoff;
const ta = fs.statSync(f('A.mq5')).mtime; fs.copyFileSync(f('A.mq5'), f('B.mq5')); fs.utimesSync(f('B.mq5'), ta, ta);
gate('stop', b);
ok(cB && pend('B.mq5').at > cut, 'copy after a running review froze the file is a newer version (not covered)');
L.updateState(P, s => { delete s.running; });

// b. tracked preset matched by an ignore rule: git rm --cached + modify in one go
fresh(); git('rm', '-q', '--cached', 'p.set'); fs.writeFileSync(f('p.set'), 'R=99\n'); old(f('p.set'), 5);
gate('stop', b);
ok(pend('p.set'), 'index removal + modification of an ignored-pattern preset is pending');
git('add', '-f', 'p.set');

// c. nested ignored local settings created by a shell during the turn; root one written by Claude Code is not
fresh(); fs.mkdirSync(f('packages/app/.claude'), { recursive: true });
fs.writeFileSync(f('packages/app/.claude/settings.local.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');
fs.mkdirSync(f('.claude'), { recursive: true }); fs.writeFileSync(f('.claude/settings.local.json'), '{}\n');
gate('stop', b);
ok(pend('packages/app/.claude/settings.local.json'), 'new nested ignored settings.local.json is pending');
ok(!pend('.claude/settings.local.json'), "the project's own settings.local.json written outside a shell is not");

// 5. non-git: a non-sensitive-named MQL file with OrderSend, overwritten keeping size and time
const Q = path.join(os.homedir(), 'gpt-final2'); fs.rmSync(Q, { recursive: true, force: true }); fs.mkdirSync(Q);
const bq = { cwd: Q, session_id: SID + 'q' }; gate('session', bq); gate('prompt', { ...bq, prompt: 'go' });
const E = path.join(Q, 'engine.mqh'); fs.writeFileSync(E, 'OrderSend(a); lots=1;\n'); old(E);
const te = fs.statSync(E).mtime;
gate('pre-bash', { ...bq, tool_use_id: 'e' }); fs.writeFileSync(E, 'OrderSend(a); lots=9;\n'); fs.utimesSync(E, te, te); gate('post-bash', { ...bq, tool_use_id: 'e' });
const sq = L.readState(Q), cq = sq.changes[E];
ok(cq && cq.at > L.reviewedAtFor(sq, cq), 'non-git engine.mqh overwritten with same size and time is pending');

fs.rmSync(P, { recursive: true, force: true }); fs.rmSync(Q, { recursive: true, force: true });
L.updateState(L.HOME, g => { if (g.sessionRoots) { delete g.sessionRoots[SID]; delete g.sessionRoots[SID + 'q']; } });
