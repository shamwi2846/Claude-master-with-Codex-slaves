// Throwaway tests for audit B fixes.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const GATE = __G + 'gate.js';
const gate = (ev, i) => spawnSync(process.execPath, [GATE, ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-b-test'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const SID = 'b-' + Date.now();
const base = { cwd: P, session_id: SID };
gate('session', base); gate('prompt', { ...base, prompt: 'go' });

// 1. shell refactor of 20 EXISTING files is tracked; 20 NEW files from one command are not
for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(P, `e${i}.js`), 'old');
gate('pre-bash', { ...base, tool_use_id: 'r1' });
for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(P, `e${i}.js`), 'refactored');
gate('post-bash', { ...base, tool_use_id: 'r1' });
ok(Object.keys(L.readState(P).changes).length === 20, 'shell refactor of 20 existing files tracked');
gate('pre-bash', { ...base, tool_use_id: 'r2' });
fs.mkdirSync(path.join(P, 'copy'));
for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(P, 'copy', `n${i}.js`), 'copied');
gate('post-bash', { ...base, tool_use_id: 'r2', tool_input: { command: 'cp -r x copy' } });
ok(!Object.keys(L.readState(P).changes).some(k => k.includes('copy')), '20 new copied files not flagged');

// 2. shell-changed file then Edit + revert: still pending (no fake baseline)
const F = path.join(P, 'e0.js');
const ev = { ...base, tool_use_id: 'w1', tool_name: 'Edit', tool_input: { file_path: F, old_string: 'refactored', new_string: 'edited' } };
gate('pre-edit', ev); fs.writeFileSync(F, 'edited'); gate('post-edit', ev);
fs.writeFileSync(F, 'refactored'); // Claude reverts its Edit
gate('stop', base);
const c = L.readState(P).changes[F];
ok(c && c.at > L.reviewedAtFor(L.readState(P), c), 'shell change stays pending after edit+revert');

// 3. MultiEdit replace_all counted
const M = path.join(P, 'm.py'); fs.writeFileSync(M, 'a=1\n'.repeat(12));
const mev = { ...base, tool_use_id: 'm1', tool_name: 'MultiEdit', tool_input: { file_path: M, edits: [{ old_string: 'a=1', new_string: 'a=2', replace_all: true }] } };
gate('pre-edit', mev); fs.writeFileSync(M, 'a=2\n'.repeat(12)); gate('post-edit', mev);
ok(L.readState(P).changes[M].lines >= 12, `MultiEdit replace_all lines=${L.readState(P).changes[M].lines}`);

// 4. failed Write's snapshot not charged to a later Edit
const W = path.join(P, 'w.py'); fs.writeFileSync(W, 'x\n'.repeat(50));
gate('pre-edit', { ...base, tool_use_id: 'failed', tool_name: 'Write', tool_input: { file_path: W, content: 'y' } }); // no post-edit (failed)
const e2 = { ...base, tool_use_id: 'ok2', tool_name: 'Edit', tool_input: { file_path: W, old_string: 'x', new_string: 'z' } };
gate('pre-edit', e2); gate('post-edit', e2);
ok(L.readState(P).changes[W].lines < 10, `later edit not charged with failed write: lines=${L.readState(P).changes[W].lines}`);

// 5. commit during the turn still found
const G = path.join(P, 'repo'); fs.mkdirSync(G);
const git = (...a) => spawnSync('git', a, { cwd: G });
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(G, 'k.js'), 'v1'); git('add', '-A'); git('commit', '-qm', 'i');
const SID2 = SID + 'g', gb = { cwd: G, session_id: SID2 };
gate('session', gb); gate('prompt', { ...gb, prompt: 'go' });
fs.writeFileSync(path.join(G, 'k.js'), Array(8).fill('v2').join('\n')); git('commit', '-qam', 'c');
const o = gate('stop', gb);
ok(/k\.js/.test(o), 'shell edit + commit within the turn still needs review');

fs.rmSync(P, { recursive: true, force: true });
for (const x of fs.readdirSync(L.STATE_DIR)) { const p = path.join(L.STATE_DIR, x); try { if (JSON.parse(fs.readFileSync(p, 'utf8')).root.startsWith(P)) fs.rmSync(p); } catch {} }
L.updateState(L.HOME, g => { if (g.sessionRoots) { delete g.sessionRoots[SID]; delete g.sessionRoots[SID2]; } });
