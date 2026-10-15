// Round-8: pending small edit + old-time shell overwrite; pending shell change committed unchanged next turn.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const SID = 'r8-' + Date.now(), b = { cwd: P, session_id: SID };
const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
const f = n => path.join(P, n);
const old = (p, h = 1) => { const t = new Date(Date.now() - h * 3600e3); fs.utimesSync(p, t, t); };
const prompt = () => { wait(30); gate('prompt', { ...b, prompt: 'go' }); wait(30); };
const rec = n => L.readState(P).changes[f(n)];
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(f('x.js'), 'a\nb\n'); fs.writeFileSync(f('y.js'), 'y1\n'); git('add', '-A'); git('commit', '-qm', 'init');
wait(1100); gate('session', b); prompt();

// 1. a 1-line Edit (pending, below the threshold), then a big shell overwrite that keeps an old file time
const ev = { ...b, tool_use_id: 'e1', tool_name: 'Edit', tool_input: { file_path: f('x.js'), old_string: 'a', new_string: 'A' } };
gate('pre-edit', ev); fs.writeFileSync(f('x.js'), 'A\nb\n'); gate('post-edit', ev);
ok(rec('x.js').lines === 1, 'precondition: 1-line pending edit');
fs.writeFileSync(f('x.js'), 'one\ntwo\nthree\nfour\nfive\nsix\n'); old(f('x.js'), 5);
const out = gate('stop', b);
ok(rec('x.js').lines >= 5 && /x\.js/.test(out), 'old-time overwrite of a pending small edit raises it to a review');

// 2. shell change (no baseline) in one turn, committed unchanged in the next: keeps a pre-commit diff base
fs.writeFileSync(f('y.js'), 'y2 shell\n');
gate('stop', b);
ok(rec('y.js') && rec('y.js').shellTouched && !rec('y.js').committed, 'precondition: pending shell change, not committed');
prompt();
const head2 = git('rev-parse', 'HEAD').stdout.trim();
git('commit', '-qm', 'y', '--', 'y.js');
prompt();
const cy = rec('y.js');
ok(cy.committed && cy.sinceRev === head2, 'pending change committed unchanged next turn keeps committed + sinceRev');

fs.rmSync(P, { recursive: true, force: true });
L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[SID]; });
