// Session-start health check: runs at most once an hour (shared by every session), again at once after a
// Codex update, and a cached failure is still shown at every session start.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, input) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(input), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-r24-test');
fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P, { recursive: true });
const SID = 'r24-' + Date.now(), b = { cwd: P, session_id: SID };
const g = () => L.readState(L.HOME);
const PROBLEM = /\[GPT setup problem\]/;

// The test profile's Codex is a stub that fails every call, so the checks report problems.
L.updateState(L.HOME, s => { delete s.doctorAt; delete s.doctorFailed; delete s.doctorCodexStamp; });
const o1 = gate('session', b);
const t1 = g().doctorAt;
ok(typeof t1 === 'number' && Math.abs(Date.now() - t1) < 60000, 'first session start runs the health check');
ok(PROBLEM.test(o1) && g().doctorFailed.length > 0, 'its failures are reported');

// Within the hour: no new check, the cached failures are still shown.
const o2 = gate('session', { ...b, session_id: SID + 'b' });
ok(g().doctorAt === t1, 'a second session start within the hour does not run it again');
ok(PROBLEM.test(o2), 'the cached failures are still shown');

// A clean cached result: no message at all (nothing re-checked, so the stub's failures don't appear).
L.updateState(L.HOME, s => { s.doctorFailed = []; });
const o3 = gate('session', { ...b, session_id: SID + 'c' });
ok(!PROBLEM.test(o3) && g().doctorAt === t1, 'a clean cached result shows nothing and is not re-checked');

// Older than an hour: checked again.
L.updateState(L.HOME, s => { s.doctorAt = Date.now() - 2 * 3600000; });
gate('session', { ...b, session_id: SID + 'd' });
const t4 = g().doctorAt;
ok(Date.now() - t4 < 60000 && g().doctorFailed.length > 0, 'a result older than an hour is checked again');

// Codex updated (its entry file changed): checked again at once, even within the hour.
const stub = L.loadConfig().codexJs;
const later = new Date(fs.statSync(stub).mtimeMs + 60000);
fs.utimesSync(stub, later, later);
L.updateState(L.HOME, s => { s.doctorFailed = []; });
const o5 = gate('session', { ...b, session_id: SID + 'e' });
ok(g().doctorCodexStamp === String(fs.statSync(stub).mtimeMs) && PROBLEM.test(o5), 'a Codex update is checked again at once');

L.updateState(L.HOME, s => { if (s.sessionRoots) for (const k of Object.keys(s.sessionRoots)) if (k.startsWith(SID)) delete s.sessionRoots[k]; });
fs.rmSync(P, { recursive: true, force: true });
