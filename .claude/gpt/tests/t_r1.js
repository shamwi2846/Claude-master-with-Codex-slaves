// Throwaway tests for goal-round-1 fixes: plan binding, once-per-turn Stop.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const SID = 'r1-' + Date.now(), b = { cwd: P, session_id: SID };
gate('session', b); gate('prompt', { ...b, prompt: 'go' });
const plan = Array.from({ length: 10 }, (_, i) => `${i + 1}. step ${i} touches module ${i}`).join('\n');
L.updateState(P, s => { s.planReviewedAt = Date.now(); s.planReviewedTurn = s.turnStartedAt; s.planReviewedText = plan; });
ok(gate('pre-plan', { ...b, tool_input: { plan } }) === '', 'reviewed plan passes');
ok(/deny/.test(gate('pre-plan', { ...b, tool_input: { plan: 'A totally different plan\nwith other steps\nand more' } })), 'different plan in the SAME turn is denied');
ok(gate('pre-plan', { ...b, tool_input: {} }) === '', 'no plan text: same-turn review accepted');
// once per turn: block, then a new edit in the same turn -> only a note
const A = path.join(P, 'a.py');
const w = n => { const e = { ...b, tool_use_id: 'w' + n, tool_name: 'Write', tool_input: { file_path: A, content: Array(8).fill('x' + n).join('\n') } }; gate('pre-edit', e); fs.writeFileSync(A, e.tool_input.content); gate('post-edit', e); };
w(1); ok(/decision/.test(gate('stop', b)), 'first stop in the turn blocks');
w(2); const o = gate('stop', b); ok(!/decision/.test(o) && /still pending/.test(o), 'new edit in the same turn: note only, no second block');
gate('prompt', { ...b, prompt: 'next' }); ok(/decision/.test(gate('stop', b)), 'next user turn blocks again');
fs.rmSync(P, { recursive: true, force: true });
L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[SID]; });
