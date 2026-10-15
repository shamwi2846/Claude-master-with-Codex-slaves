// Throwaway tests for the bug-hunt fixes (hooks).
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const SID = 'bug-' + Date.now(), b = { cwd: P, session_id: SID };
gate('session', b); gate('prompt', { ...b, prompt: 'go' });

// 1. later edit keeps a pending commit's diff base
const A = path.join(P, 'a.js'); fs.writeFileSync(A, 'x\n');
L.updateState(P, s => { s.changes[A] = { lines: 5, at: Date.now(), committed: true, sinceRev: 'abc123', shellTouched: true }; });
const ev = { ...b, tool_use_id: 'e', tool_name: 'Edit', tool_input: { file_path: A, old_string: 'x', new_string: 'y' } };
gate('pre-edit', ev); fs.writeFileSync(A, 'y\n'); gate('post-edit', ev);
const c = L.readState(P).changes[A];
ok(c.committed && c.sinceRev === 'abc123', 'edit after a pending commit keeps committed + sinceRev');

// 2. bulk new files: a generic name with OrderSend inside is still tracked
gate('pre-bash', { ...b, tool_use_id: 'bk' });
fs.mkdirSync(path.join(P, 'gen'));
for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(P, 'gen', `f${i}.mq5`), 'int x;');
fs.writeFileSync(path.join(P, 'gen', 'helpers.mq5'), 'void Go(){ OrderSend(req,res); }');
gate('post-bash', { ...b, tool_use_id: 'bk', tool_input: { command: 'unzip pack.zip' } });
const keys = Object.keys(L.readState(P).changes);
ok(keys.some(k => k.endsWith('helpers.mq5')) && !keys.some(k => /f\d+\.mq5$/.test(k)), 'bulk: OrderSend file kept, plain generated files skipped');

// 3. cp -p style change (old mtime) over a reviewed file is pending
const S = path.join(P, 'p.set'); fs.writeFileSync(S, 'Risk=1\n');
const old = new Date(Date.now() - 3600 * 1000); fs.utimesSync(S, old, old);
L.updateState(P, s => { s.changes[S] = { lines: 1, at: old.getTime() - 1000, reviewedAt: Date.now() - 1000 }; });
gate('pre-bash', { ...b, tool_use_id: 'cp' });
fs.writeFileSync(S, 'Risk=10\n'); const older = new Date(Date.now() - 7200 * 1000); fs.utimesSync(S, older, older); // content changed, older mtime
gate('post-bash', { ...b, tool_use_id: 'cp' });
const st = L.readState(P), cs = st.changes[S];
ok(cs && cs.at > L.reviewedAtFor(st, cs), 'changed preset with an older timestamp is pending');

fs.rmSync(P, { recursive: true, force: true });
L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[SID]; });
