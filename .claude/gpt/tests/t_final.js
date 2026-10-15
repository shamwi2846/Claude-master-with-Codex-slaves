// Throwaway tests: committed shell change shown as a real diff; restored file clears deleted flag.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const G = path.join(os.homedir(), 'gpt-final'); fs.rmSync(G, { recursive: true, force: true }); fs.mkdirSync(G);
const git = (...a) => spawnSync('git', a, { cwd: G, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 'me@x'); git('config', 'user.name', 'me');
fs.writeFileSync(path.join(G, 'a.js'), 'const a = 1;\n'); fs.writeFileSync(path.join(G, 'b.js'), 'const b = 1;\n');
git('add', '-A'); git('commit', '-qm', 'i'); sleep(1100);
const SID = 'fin-' + Date.now(), b = { cwd: G, session_id: SID };
gate('session', b); gate('prompt', { ...b, prompt: 'go' });
// shell edits A and commits it; B left dirty
fs.writeFileSync(path.join(G, 'a.js'), 'const a = 2; // committed shell change\n'); git('commit', '-qam', 'a'); fs.writeFileSync(path.join(G, 'b.js'), 'const b = 2;\n');
const A = path.join(G, 'a.js');
{ const m0 = new Function('L','root','path','fs','spawnSync','stamp','NULL_DEV', fs.readFileSync(__G + 'gpt.js','utf8').slice(fs.readFileSync(__G + 'gpt.js','utf8').indexOf('function noIndexDiff'), fs.readFileSync(__G + 'gpt.js','utf8').indexOf('// Build/test/compile output')) + '; return reviewMaterial;')(L, G, path, fs, spawnSync, () => 'y' + Date.now(), 'NUL'); const mm = m0([A, path.join(G, 'b.js')]); ok(/committed shell change/.test(mm.text), 'BEFORE Stop: committed A shows its real diff'); fs.rmSync(mm.snapDir, { recursive: true, force: true }); }
gate('stop', b);
ok(L.readState(G).changes[A] && L.readState(G).changes[A].sinceRev, 'committed change records the turn-start revision');
// build review material exactly as gpt.js does (no GPT call)
const src = fs.readFileSync(__G + 'gpt.js', 'utf8');
const rm = new Function('L', 'root', 'path', 'fs', 'spawnSync', 'stamp', 'NULL_DEV',
  src.slice(src.indexOf('function noIndexDiff'), src.indexOf('// Build/test/compile output')) + '; return reviewMaterial;')(L, G, path, fs, spawnSync, () => 'x' + Date.now(), 'NUL');
const mat = rm([A, path.join(G, 'b.js')]);
ok(/committed shell change/.test(mat.text), 'committed file A shows its real diff in a mixed review');
fs.rmSync(mat.snapDir, { recursive: true, force: true });
// restored file: reviewed deletion, then restore + review -> deleted flag cleared
const mr = new Function('L', 'root', 'path', 'fs', src.slice(src.indexOf('function markReviewed'), src.indexOf('try { L.cleanup(); } catch {}')) + '; return markReviewed;')(L, G, path, fs);
L.updateState(G, s => { s.changes[A] = { lines: 5, at: Date.now() - 5000, deleted: true }; });
mr('gpt', Date.now(), [A], [], { verdict: 'NO_ISSUES', log: 'x', snaps: [{ abs: A, snap: A }] });
ok(L.readState(G).changes[A].deleted === false, 'review of a restored file clears its deleted flag');
L.updateState(G, s => { s.changes[A].deleted = true; s.changes[A].at = Date.now() - 1000; });
mr('claude-final', Date.now(), [A], [], {});
ok(L.readState(G).changes[A].deleted === false, 'manual acknowledgement of a restored file clears deleted flag');
fs.rmSync(G, { recursive: true, force: true });
for (const x of fs.readdirSync(L.STATE_DIR)) { const p = path.join(L.STATE_DIR, x); try { if (JSON.parse(fs.readFileSync(p, 'utf8')).root.startsWith(G)) fs.rmSync(p); } catch {} }
L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[SID]; });
