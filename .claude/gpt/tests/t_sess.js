// Throwaway tests: session root, combined Stop block, reverted edits, notification prompts.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const GATE = __G + 'gate.js';
const gate = (ev, input, env) => spawnSync(process.execPath, [GATE, ev], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const proj = path.join(os.homedir(), 'gpt-sess-test'), sub = path.join(proj, 'sub');
fs.rmSync(proj, { recursive: true, force: true }); fs.mkdirSync(sub, { recursive: true });
const SID = 'test-session-' + Date.now();

// 1. session root: first event from proj, later events from sub -> same state (proj)
gate('session', { cwd: proj, session_id: SID });
gate('prompt', { cwd: proj, session_id: SID, prompt: 'start' });
const A = path.join(sub, 'a.py');
fs.writeFileSync(A, 'x = 1\n');
const ev = { cwd: sub, session_id: SID, tool_name: 'Write', tool_input: { file_path: A, content: Array(8).fill('y = 2').join('\n') } };
gate('pre-edit', ev); fs.writeFileSync(A, Array(8).fill('y = 2').join('\n')); gate('post-edit', ev);
ok(!!L.readState(proj).changes[A], 'edit made after cd into sub is tracked under the session project');
ok(!L.readState(sub).changes || !L.readState(sub).changes[A], 'no separate state for the sub folder');
// gpt.js resolves the same root from CLAUDE_CODE_SESSION_ID
const st = spawnSync(process.execPath, [__G + 'gpt.js', 'status'], { cwd: sub, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: SID } }).stdout;
ok(JSON.parse(st).root === proj, 'gpt.js uses the session project from CLAUDE_CODE_SESSION_ID');

// 2. combined block: open findings + pending in ONE message
const B = path.join(proj, 'b.py'); fs.writeFileSync(B, 'b');
L.updateState(proj, s => { s.changes[B] = { lines: 6, at: 1, reviewedAt: 10, openFindings: 'LOG_B' }; });
let o = gate('stop', { cwd: sub, session_id: SID });
ok(/Open GPT findings/.test(o) && /GPT review needed/.test(o), 'findings and pending changes in one block');
const o2 = gate('stop', { cwd: sub, session_id: SID });
ok(!/"decision":"block"/.test(o2) && !/still pending/.test(o2), 'second stop, same pending files: no second block and no repeated note');

// 3. reverted edit -> no longer pending
const C = path.join(proj, 'c.py'); fs.writeFileSync(C, 'orig = 1\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
gate('prompt', { cwd: proj, session_id: SID, prompt: 'next' });
L.updateState(proj, s => { delete s.changes[B]; });
const ev2 = { cwd: proj, session_id: SID, tool_name: 'Write', tool_input: { file_path: C, content: Array(9).fill('new').join('\n') } };
gate('pre-edit', ev2); fs.writeFileSync(C, Array(9).fill('new').join('\n')); gate('post-edit', ev2);
fs.writeFileSync(C, 'orig = 1\n'); // reverted
L.updateState(proj, s => { delete s.changes[A]; });
o = gate('stop', { cwd: proj, session_id: SID });
ok(!/c\.py/.test(o), 'reverted edit does not demand a review');

// 4. task notification is not a new turn and gets no reminders
// (after an ended turn it may open a fresh discovery window, but this user turn's Stop blocks carry over)
const s0 = L.readState(proj), blocked0 = s0.stopBlockedTurn === s0.turnStartedAt;
o = gate('prompt', { cwd: proj, session_id: SID, prompt: '<task-notification> <task-id>x</task-id> log failed output </task-notification>' });
const s1 = L.readState(proj);
ok(o === '' && (s1.stopBlockedTurn === s1.turnStartedAt) === blocked0, 'notification: no reminder, once-per-turn blocks unchanged');

fs.rmSync(proj, { recursive: true, force: true });
for (const x of fs.readdirSync(L.STATE_DIR)) {
  const p = path.join(L.STATE_DIR, x);
  try { if (JSON.parse(fs.readFileSync(p, 'utf8')).root.startsWith(proj)) fs.rmSync(p); } catch {}
}
L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[SID]; if (g.reminders) delete g.reminders[SID]; });
fs.rmSync(path.join(L.HOME, 'baseline', require('crypto').createHash('sha1').update(proj.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 12)), { recursive: true, force: true });
