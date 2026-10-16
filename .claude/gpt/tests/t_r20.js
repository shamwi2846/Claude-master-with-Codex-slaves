// Files Claude didn't author: copies, moves, branch switches in nested repos, and per-project ignore globs.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const K = require('./bridge-kit');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const pendIn = (root, p) => { const s = L.readState(root); const c = Object.entries(s.changes).find(([k]) => k.toLowerCase() === p.toLowerCase()); return c && c[1].at > L.reviewedAtFor(s, c[1]) ? c[1] : null; };
const ackAll = root => K.at(root).review.markReviewed('claude-final', Date.now(), null, L.gitDeleted(root));
const SID = 'r20-' + Date.now();

// ---- git project: copies and moves found by the turn scan
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const f = n => path.join(P, n);
const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
const b = { cwd: P, session_id: SID };
const prompt = () => { wait(30); gate('prompt', { ...b, prompt: 'go' }); wait(30); };
const pend = n => pendIn(P, f(n));
const fresh = () => { git('add', '-A'); git('commit', '-qm', 'x'); ackAll(P); prompt(); };
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
put(f('src/engine.mq5'), 'void Go(){ OrderSend(r,s); }\n');
put(f('src/old.mqh'), 'int Old(){ return OrderSend(a,b); }\n');
put(f('src/helper.js'), 'module.exports = 1;\n');
put(f('presets/a.set'), 'Risk=1\n');
put(f('.claude/gpt.json'), JSON.stringify({ ignore: ['reports/**'] }));
git('add', '-A'); git('commit', '-qm', 'init'); wait(1100);
gate('session', b); prompt();

// a. a verbatim copy of committed code is not a change; new code is
fs.mkdirSync(f('baseline'), { recursive: true }); fs.copyFileSync(f('src/engine.mq5'), f('baseline/engine.mq5'));
put(f('src/new.mq5'), 'void New(){ OrderSend(x,y); }\n');
gate('stop', b);
ok(!pend('baseline/engine.mq5') && pend('src/new.mq5'), 'git: copy of committed code is not pending; new code is');
ok((L.readState(P).notAuthored || []).some(x => /baseline/.test(x.file) && /copy/.test(x.why)), 'git: the skipped copy is listed (notAuthored)');

// b. a move (same extension) is not a change on either side; a move that changes the extension is
fresh();
fs.mkdirSync(f('archive'), { recursive: true }); fs.renameSync(f('src/old.mqh'), f('archive/old.mqh'));
fs.renameSync(f('src/helper.js'), f('src/helper.txt'));
gate('stop', b);
ok(!pend('src/old.mqh') && !pend('archive/old.mqh'), 'git: a moved file is not pending (old or new place)');
ok(pend('src/helper.js') && pend('src/helper.js').deleted, 'git: helper.js -> helper.txt is a pending deletion');

// c. copies that stay changes: config destinations, and copies of unreviewed work
fresh();
fs.copyFileSync(f('presets/a.set'), f('presets/b.set'));
const ev = { ...b, tool_use_id: 'e1', tool_name: 'Edit', tool_input: { file_path: f('src/engine.mq5'), old_string: 'Go', new_string: 'Run' } };
gate('pre-edit', ev); put(f('src/engine.mq5'), 'void Run(){ OrderSend(r,s); }\n'); gate('post-edit', ev);
fs.mkdirSync(f('copy2'), { recursive: true }); fs.copyFileSync(f('src/engine.mq5'), f('copy2/engine.mq5'));
gate('stop', b);
ok(pend('presets/b.set'), 'git: a preset copied into place is pending');
ok(pend('copy2/engine.mq5'), "git: a copy of Claude's unreviewed edit is pending");

// d. ignore globs (gpt.json): generated reports are not tracked
fresh();
put(f('reports/run1.htm'), '<html>generated</html>\n'); put(f('src/z.js'), 'let z = 1;\n');
gate('stop', b);
ok(!pend('reports/run1.htm') && pend('src/z.js'), 'git: a file matching an ignore glob is not tracked; others are');

// ---- non-git folder: shell copies, moves, nested-repo branch switches
const Q = path.join(os.homedir(), 'gpt-final2'); fs.rmSync(Q, { recursive: true, force: true }); fs.mkdirSync(Q);
const q = n => path.join(Q, n);
const bq = { cwd: Q, session_id: SID + 'q' };
const shell = (id, command, run) => { gate('pre-bash', { ...bq, tool_use_id: id, tool_input: { command } }); run(); gate('post-bash', { ...bq, tool_use_id: id, tool_input: { command } }); };
const qp = n => pendIn(Q, q(n));
put(q('a.mq5'), 'void A(){ OrderSend(1); }\n'); put(q('c.mq5'), 'void C(){ OrderSend(3); }\n');
const NR = q('repo');
fs.mkdirSync(NR);
const ng = (...a) => spawnSync('git', a, { cwd: NR, encoding: 'utf8' });
ng('init', '-q'); ng('config', 'user.email', 't@t'); ng('config', 'user.name', 't'); ng('config', 'core.autocrlf', 'false');
ng('checkout', '-q', '-b', 'main');
put(path.join(NR, 'x.mq5'), 'void X(){ OrderSend(1); } // main\n'); ng('add', '-A'); ng('commit', '-qm', 'main');
ng('checkout', '-q', '-b', 'dev');
put(path.join(NR, 'x.mq5'), 'void X(){ OrderSend(2); } // dev\n'); put(path.join(NR, 'y.mq5'), 'void Y(){ OrderSend(3); }\n'); ng('add', '-A'); ng('commit', '-qm', 'dev');
ng('checkout', '-q', 'main');
wait(1500); // setup's reflog entries are older than the commands below
gate('session', bq); gate('prompt', { ...bq, prompt: 'go' }); wait(30);

shell('c1', 'cp a.mq5 b/a.mq5 && mv c.mq5 old/c.mq5', () => {
  fs.mkdirSync(q('b')); fs.copyFileSync(q('a.mq5'), q('b/a.mq5'));
  fs.mkdirSync(q('old')); fs.renameSync(q('c.mq5'), q('old/c.mq5'));
});
ok(!qp('b/a.mq5') && !qp('c.mq5') && !qp('old/c.mq5'), 'non-git: shell copy and move are not pending');

shell('h1', 'git -C repo checkout dev', () => ng('checkout', '-q', 'dev'));
ok(!qp('repo/x.mq5') && !qp('repo/y.mq5'), 'nested repo: files switched by a checkout are not pending');
shell('h2', 'git -C repo checkout main', () => ng('checkout', '-q', 'main'));
ok(!qp('repo/x.mq5') && !qp('repo/y.mq5'), 'nested repo: switching back (file removed by the branch) is not pending');

put(path.join(NR, 'x.mq5'), 'owner edit\n'); // uncommitted work in the nested repo
shell('h3', 'git -C repo checkout -f dev', () => ng('checkout', '-q', '-f', 'dev'));
ok(qp('repo/x.mq5') && !qp('repo/y.mq5'), "nested repo: a forced checkout over uncommitted work is pending (only that file)");

ackAll(Q); wait(20);
put(path.join(NR, 'x.mq5'), 'dirty again\n');
shell('h4', 'git -C repo checkout -- x.mq5', () => ng('checkout', '--', 'x.mq5'));
ok(qp('repo/x.mq5'), 'nested repo: checkout -- <file> (HEAD not moved) discarding work is pending');

ackAll(Q); wait(20);
shell('h5', 'edit && git commit -am x && git checkout main', () => {
  put(path.join(NR, 'x.mq5'), 'void X(){ OrderSend(9); } // claude\n'); ng('commit', '-qam', 'claude'); ng('checkout', '-q', 'main');
});
ok(qp('repo/x.mq5'), 'nested repo: edit + commit + checkout in one command is pending');

// ---- ignore globs in a non-git folder; an unreviewed change to gpt.json switches them off
const R = path.join(os.homedir(), 'gpt-final3'); fs.rmSync(R, { recursive: true, force: true }); fs.mkdirSync(R);
const r = n => path.join(R, n);
const br = { cwd: R, session_id: SID + 'r' };
put(r('.claude/gpt.json'), JSON.stringify({ ignore: ['evidence/**', 'gen/*.mjs'] }));
gate('session', br); gate('prompt', { ...br, prompt: 'go' }); wait(30);
const rsh = (id, run) => { gate('pre-bash', { ...br, tool_use_id: id, tool_input: { command: 'run' } }); run(); gate('post-bash', { ...br, tool_use_id: id, tool_input: { command: 'run' } }); };
rsh('i1', () => { put(r('evidence/t1/r.set'), 'Risk=1\n'); put(r('gen/app.mjs'), 'export default 1;\n'); put(r('src2.mq5'), 'void S(){}\n'); });
ok(!pendIn(R, r('evidence/t1/r.set')) && !pendIn(R, r('gen/app.mjs')) && pendIn(R, r('src2.mq5')), 'non-git: ignore globs skip generated files only');
ok(L.SENSITIVE_PATH.test(r('.claude/gpt.json')), '.claude/gpt.json is sensitive (always reviewed)');
const ej = { ...br, tool_use_id: 'j', tool_name: 'Write', tool_input: { file_path: r('.claude/gpt.json'), content: '{"ignore":["**"]}' } };
gate('pre-edit', ej); put(r('.claude/gpt.json'), '{"ignore":["**"]}'); gate('post-edit', ej);
rsh('i2', () => put(r('evidence/t2/r.set'), 'Risk=2\n'));
ok(pendIn(R, r('.claude/gpt.json')) && pendIn(R, r('evidence/t2/r.set')), 'while gpt.json has an unreviewed change, its ignore list is not applied');

fs.rmSync(P, { recursive: true, force: true }); fs.rmSync(Q, { recursive: true, force: true }); fs.rmSync(R, { recursive: true, force: true });
