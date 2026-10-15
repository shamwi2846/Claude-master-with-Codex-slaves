// Throwaway tests for goal-round-2 fixes.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const G = path.join(os.homedir(), 'gpt-final'); fs.rmSync(G, { recursive: true, force: true }); fs.mkdirSync(G);
const git = (...a) => spawnSync('git', a, { cwd: G, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 'me@x'); git('config', 'user.name', 'me');
fs.mkdirSync(path.join(G, 'presets')); fs.writeFileSync(path.join(G, 'presets', 'default.set'), 'RiskPercent=1\n'); fs.writeFileSync(path.join(G, 'k.js'), 'v1\n');
git('add', '-A'); git('commit', '-qm', 'i'); sleep(1100);
const SID = 'r2-' + Date.now(), b = { cwd: G, session_id: SID };
gate('session', b); gate('prompt', { ...b, prompt: 'go' });
// 1. one-line .set change is sensitive -> blocks
const S = path.join(G, 'presets', 'default.set');
const ev = { ...b, tool_use_id: 's', tool_name: 'Edit', tool_input: { file_path: S, old_string: 'RiskPercent=1', new_string: 'RiskPercent=10' } };
gate('pre-edit', ev); fs.writeFileSync(S, 'RiskPercent=10\n'); gate('post-edit', ev);
ok(L.readState(G).changes[S] && L.readState(G).changes[S].sensitive, '.set change is sensitive');
ok(/default\.set/.test(gate('stop', b)), 'one-line .set change requires review');
// 2. shell edit, then the user interrupts with a new prompt before Stop -> change kept
L.updateState(G, s => { s.changes = {}; });
sleep(20); fs.writeFileSync(path.join(G, 'k.js'), 'v2 shell edit\n');
gate('prompt', { ...b, prompt: 'interrupt' });
const K = path.join(G, 'k.js'), c = L.readState(G).changes[K];
ok(c && c.at > L.reviewedAtFor(L.readState(G), c), 'shell change survives a user interruption');
// 3. relative finding location maps to the right file
const src = fs.readFileSync(__G + 'gpt.js', 'utf8');
const ff = new Function('path', 'root', src.slice(src.indexOf('// File paths in one'), src.indexOf('// Bug diagnosis')) + '; return findingFiles;')(path, G);
const a = path.join(G, 'src', 'a', 'utils.js'), bb = path.join(G, 'src', 'b', 'utils.js');
const r = ff('VERDICT: ISSUES_FOUND\n### [HIGH] x\n- Location: src/a/utils.js:20', { map: [] }, [a, bb]);
ok(r && r.size === 1 && r.has(a.toLowerCase()), 'relative location maps only src/a/utils.js');
fs.rmSync(G, { recursive: true, force: true });
L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[SID]; });
