// Throwaway tests: desktop handoff between GPT computer runs and Claude's own computer-use tools.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-final'); fs.mkdirSync(path.join(P, '.claude'), { recursive: true });
fs.writeFileSync(path.join(P, '.claude', 'gpt.json'), JSON.stringify({ computerUse: 'claude' })); // project override allows Claude
const live = Number(spawnSync('powershell', ['-NoProfile', '-c', '(Get-Process explorer | Select -First 1).Id'], { encoding: 'utf8' }).stdout.trim());
L.updateState(L.HOME, g => { g.computerLock = { pid: live, at: Date.now(), project: 'A' }; delete g.claudeCuLastUse; });
ok(/deny/.test(gate('pre-computer', { cwd: P, session_id: 'cu-test' })), 'Claude blocked while GPT owns the desktop (even with override)');
L.updateState(L.HOME, g => { delete g.computerLock; });
ok(gate('pre-computer', { cwd: P, session_id: 'cu-test' }) === '' && L.readState(L.HOME).claudeCuLastUse, 'Claude allowed when free; use recorded');
const r = spawnSync(process.execPath, [__G + 'gpt.js', 'computer', '--task', 'noop'], { encoding: 'utf8', timeout: 30000 });
ok(r.status === 6 && /Claude is using the desktop/.test(r.stdout), 'GPT run refused right after Claude used the desktop');
L.updateState(L.HOME, g => { delete g.claudeCuLastUse; delete g.computerLock; if (g.sessionRoots) delete g.sessionRoots['cu-test']; });
fs.rmSync(P, { recursive: true, force: true });
