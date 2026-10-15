// Throwaway tests: desktop ownership follows the Codex worker; Claude's handoff is atomic.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync, spawn } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-final'); fs.mkdirSync(path.join(P, '.claude'), { recursive: true });
fs.writeFileSync(path.join(P, '.claude', 'gpt.json'), JSON.stringify({ computerUse: 'claude' }));
const worker = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']); // stands in for a live Codex worker
// bridge pid dead, worker alive -> desktop still owned
L.updateState(L.HOME, g => { g.computerLock = { pid: 999999, childPid: worker.pid, at: Date.now(), project: 'A' }; delete g.claudeCuLastUse; });
ok(/deny/.test(gate('pre-computer', { cwd: P, session_id: 'cu6' })), 'Claude denied while the orphaned Codex worker still runs');
const r = spawnSync(process.execPath, [__G + 'gpt.js', 'computer', '--task', 'noop'], { encoding: 'utf8', timeout: 30000 });
ok(r.status === 6, 'second GPT computer run refused while the worker lives');
worker.kill();
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
ok(gate('pre-computer', { cwd: P, session_id: 'cu6' }) === '' && !!L.readState(L.HOME).claudeCuLastUse, 'after the worker dies: Claude allowed and use recorded in the same step');
// strict: state lock busy -> retryable denial instead of an unrecorded allow
L.updateState(L.HOME, g => { delete g.computerLock; delete g.claudeCuLastUse; });
const lock = path.join(L.STATE_DIR, require('crypto').createHash('sha1').update(L.HOME.split(path.sep).join('/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 12) + '.json.lock');
fs.mkdirSync(lock);
const o = gate('pre-computer', { cwd: P, session_id: 'cu6' });
fs.rmSync(lock, { recursive: true, force: true });
ok(/could not be checked/.test(o), 'state busy -> short retryable denial');
L.updateState(L.HOME, g => { delete g.claudeCuLastUse; delete g.computerLock; if (g.sessionRoots) delete g.sessionRoots['cu6']; });
fs.rmSync(P, { recursive: true, force: true });
