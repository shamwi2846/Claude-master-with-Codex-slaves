// Throwaway tests for audit-B round-2 fixes.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const P = path.join(os.homedir(), 'gpt-b2'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const sids = [];
const session = (cwd) => { const sid = 'b2-' + Math.random().toString(36).slice(2); sids.push(sid); const b = { cwd, session_id: sid }; gate('session', b); gate('prompt', { ...b, prompt: 'go' }); return b; };
const pend = (root, f) => { const s = L.readState(root), c = s.changes[f]; return !!c && c.at > L.reviewedAtFor(s, c); };

// git repo
const G = path.join(P, 'repo'); fs.mkdirSync(G);
const git = (...a) => spawnSync('git', a, { cwd: G, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 'me@x'); git('config', 'user.name', 'me');
for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(G, `s${i}.js`), 'v1');
git('add', '-A'); git('commit', '-qm', 'i'); git('branch', 'other');
git('checkout', '-q', 'other'); for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(G, `s${i}.js`), 'other-branch'); git('commit', '-qam', 'o');
sleep(1100); git('checkout', '-q', 'master');

// 1. git: shell edit, then Edit, then undo Edit -> still pending
let b = session(G);
sleep(20); const F = path.join(G, 's0.js'); fs.writeFileSync(F, 'shell-changed');
const ev = { ...b, tool_use_id: 'e1', tool_name: 'Edit', tool_input: { file_path: F, old_string: 'shell-changed', new_string: 'edited' } };
gate('pre-edit', ev); fs.writeFileSync(F, 'edited'); gate('post-edit', ev); fs.writeFileSync(F, 'shell-changed');
gate('stop', b);
ok(pend(G, F), 'git: shell edit before an Edit stays pending after the Edit is undone');
git('checkout', '-q', '--', '.');

// 2. branch switch is not authored code; a 16-file commit made in the turn is
L.updateState(G, s => { s.changes = {}; });
b = session(G);
git('checkout', '-q', 'other');
let o = gate('stop', b);
ok(!/s\d+\.js/.test(o), 'branch switch alone does not demand a review');
git('checkout', '-q', 'master');
b = session(G);
for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(G, `s${i}.js`), 'refactor');
git('commit', '-qam', 'refactor');
o = gate('stop', b);
ok((o.match(/s\d+\.js/g) || []).length >= 16, 'commit of a 16-file refactor in the turn needs review');

// 3. mixed MultiEdit: 3 bulk (1 occurrence each) + 2 plain edits = 5 lines
const N = path.join(P, 'n'); fs.mkdirSync(N); b = session(N);
const M = path.join(N, 'm.py'); fs.writeFileSync(M, 'a\nb\nc\nd\ne\n');
const mev = { ...b, tool_use_id: 'm', tool_name: 'MultiEdit', tool_input: { file_path: M, edits: [
  { old_string: 'a', new_string: 'A', replace_all: true }, { old_string: 'b', new_string: 'B', replace_all: true }, { old_string: 'c', new_string: 'C', replace_all: true },
  { old_string: 'd', new_string: 'D' }, { old_string: 'e', new_string: 'E' }] } };
gate('pre-edit', mev); fs.writeFileSync(M, 'A\nB\nC\nD\nE\n'); gate('post-edit', mev);
ok(L.readState(N).changes[M].lines >= 5, `mixed MultiEdit lines=${L.readState(N).changes[M].lines}`);

// 4. failed big Write, then one-occurrence replace_all Edit: not inflated
const W = path.join(N, 'w.py'); fs.writeFileSync(W, 'q\n'.repeat(60));
gate('pre-edit', { ...b, tool_use_id: 'fail', tool_name: 'Write', tool_input: { file_path: W, content: 'z' } });
fs.writeFileSync(W, 'q\n'.repeat(59) + 'zz\n');
const rev = { ...b, tool_use_id: 'r', tool_name: 'Edit', tool_input: { file_path: W, old_string: 'zz', new_string: 'yy', replace_all: true } };
gate('pre-edit', rev); fs.writeFileSync(W, 'q\n'.repeat(59) + 'yy\n'); gate('post-edit', rev);
ok(L.readState(N).changes[W].lines < 10, `failed Write not transferred: lines=${L.readState(N).changes[W].lines}`);

// 5. non-git: Edit, then shell restores original bytes -> cleared
const R = path.join(N, 'r.py'); fs.writeFileSync(R, 'orig\n');
const b5 = session(N);
const e5 = { ...b5, tool_use_id: 'e5', tool_name: 'Write', tool_input: { file_path: R, content: Array(9).fill('x').join('\n') } };
gate('pre-edit', e5); fs.writeFileSync(R, Array(9).fill('x').join('\n')); gate('post-edit', e5);
gate('pre-bash', { ...b5, tool_use_id: 'sh5' }); sleep(20); fs.writeFileSync(R, 'orig\n'); gate('post-bash', { ...b5, tool_use_id: 'sh5' });
gate('stop', b5);
ok(!pend(N, R), 'Edit undone by a shell restore is no longer pending');

fs.rmSync(P, { recursive: true, force: true });
for (const x of fs.readdirSync(L.STATE_DIR)) { const p = path.join(L.STATE_DIR, x); try { if (JSON.parse(fs.readFileSync(p, 'utf8')).root.startsWith(P)) fs.rmSync(p); } catch {} }
L.updateState(L.HOME, g => { for (const s of sids) if (g.sessionRoots) delete g.sessionRoots[s]; });
