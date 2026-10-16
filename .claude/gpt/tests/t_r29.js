// The setup's on/off switch (gpt.js off|on [--all]): lasts until switched back; while off nothing is tracked
// or enforced and Claude is told so; only the user's own message can switch it off.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
// gpt: as the user in their own terminal (no Claude session); gptAs: from inside a Claude session
const gptAs = (sid, root, ...a) => spawnSync(process.execPath, [__G + 'gpt.js', ...a, '--project', root], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid } });
const gpt = (root, ...a) => gptAs('', root, ...a);
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const dir = n => { const d = path.join(os.homedir(), n); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const P = dir('gpt-r29-a'), Q = dir('gpt-r29-b'), T = Date.now();
const bP = { cwd: P, session_id: 'r29P-' + T }, bQ = { cwd: Q, session_id: 'r29Q-' + T };
for (const b of [bP, bQ]) { gate('session', b); gate('prompt', { ...b, prompt: 'go' }); }
wait(30);
const write = (b, f, n) => { const e = { ...b, tool_use_id: 'w' + Math.random(), tool_name: 'Write', tool_input: { file_path: f, content: Array(n).fill('x = 1').join('\n') } }; gate('pre-edit', e); fs.writeFileSync(f, e.tool_input.content); gate('post-edit', e); };
const pend = (root, f) => { const s = L.readState(root), c = (s.changes || {})[f]; return !!c && c.at > L.reviewedAtFor(s, c); };
const denied = o => /"permissionDecision":"deny"/.test(o || '');

ok(!L.setupSwitch(P).off && L.projectSettings(P).review, 'on by default');
// 1. switching off is the user's decision: from a Claude session only when the user's message asks for it
const offAfter = prompt => { gate('prompt', { ...bP, prompt }); return gptAs(bP.session_id, P, 'off'); };
for (const prompt of ['continue with the refactor', 'Disable the failing test', 'review the off switch', 'do not turn GPT off', "please don't switch the setup off", 'Explain gpt.js off', 'Do not run gpt.js off',
  'Explain how to run gpt.js off', 'Why did you run gpt.js off?', 'Can you explain how to turn the setup off?',
  "Can you confirm you won't turn GPT off?", 'Make sure you never switch the setup off', 'Can you tell me the command to turn GPT off?',
  '"Turn the GPT setup off" is not what I asked you to do.', 'The doc says `run gpt.js off` somewhere']) {
  const r = offAfter(prompt);
  if (!(r.status === 2 && /Not switched off: that is the user's decision/.test(r.stderr) && !L.setupSwitch(P).off)) ok(false, `switched off after: "${prompt}"`);
}
ok(true, "a message that doesn't ask for it (or says not to) never lets Claude switch it off");
for (const prompt of ['switch off the reviews', 'pause GPT for a while', 'switch the Claude + GPT setup off', 'run gpt.js off', 'Can you turn the GPT setup off?', 'Ok. Turn the GPT setup off.',
  'Turn the GPT setup off and check the build.', 'Could you please switch off the reviews?']) {
  const r = offAfter(prompt);
  if (!(r.status === 0 && L.setupSwitch(P).off)) ok(false, `not switched off after: "${prompt}" (${r.stderr.trim()})`);
  gpt(P, 'on');
}
ok(true, 'asking in other words works too');
const before = path.join(P, 'before.py'); write(bP, before, 8); // pending from before the switch
const r1 = offAfter('please turn the GPT setup off for now');
const sw = L.setupSwitch(P), ps = L.projectSettings(P);
ok(r1.status === 0 && /OFF for/.test(r1.stdout) && sw.off && sw.scope === 'project' && !ps.review && !ps.plans && !ps.ideas && ps.computerUse === 'claude', 'gpt.js off switches this project off');
ok(!L.setupSwitch(Q).off, 'other projects stay on');

// 2. while off: nothing tracked or enforced; Claude is told once
const n1 = gate('prompt', { ...bP, prompt: 'next task' });
const n2 = gate('prompt', { ...bP, prompt: 'and another' });
ok(/setup OFF for this project/.test(n1) && !/setup OFF/.test(n2 || ''), 'the next prompt tells Claude it is off, once');
const during = path.join(P, 'during.py'); write(bP, during, 12);
ok(!pend(P, during), 'edits made while off are not tracked');
ok(!/"decision":"block"/.test(gate('stop', bP) || ''), 'Stop does not block');
ok(!denied(gate('pre-computer', { ...bP, tool_name: 'mcp__computer-use__screenshot' })), 'Claude may control the screen itself');
const sess = gate('session', { cwd: P, session_id: 'r29P2-' + T });
ok(/setup OFF for this project/.test(sess), 'a new session is told at its start');
ok(/Claude \+ GPT setup OFF \(this project/.test(gpt(P, 'status', '--summary').stdout), 'status --summary shows it');
ok(L.setupSwitch(P).off, 'it stays off (no time limit)');

// 3. back on: the pending change from before is still there; Claude is told once
const r2 = gpt(P, 'on');
ok(r2.status === 0 && /ON for/.test(r2.stdout) && /1 change\(s\) from before/.test(r2.stdout) && pend(P, before) && L.projectSettings(P).review, 'gpt.js on switches it back on; earlier pending work still waits');
const n3 = gate('prompt', { ...bP, prompt: 'go on' });
const n4 = gate('prompt', { ...bP, prompt: 'more' });
ok(/setup ON again/.test(n3) && !/setup ON again/.test(n4 || ''), 'Claude is told it is on again, once');
ok(denied(gate('pre-computer', { ...bP, tool_name: 'mcp__computer-use__screenshot' })), 'screen control is delegated to GPT again');

// 4. --all: every project, resetting their own switches; a project's own switch wins over it
gpt(P, 'on'); // P has its own "on" switch now
const r3 = gpt(Q, 'off', '--all');
ok(r3.status === 0 && /OFF for all projects/.test(r3.stdout) && L.setupSwitch(Q).off && L.setupSwitch(Q).scope === 'all' && L.setupSwitch(P).off, 'off --all: every project off, own switches reset');
gpt(Q, 'on');
ok(!L.setupSwitch(Q).off && L.setupSwitch(P).off, 'one project switched back on while the rest stay off');
const r4 = gpt(P, 'on', '--all');
ok(r4.status === 0 && !L.setupSwitch(P).off && !L.setupSwitch(Q).off && !L.readState(L.HOME).setupSwitch && !L.readState(Q).setupSwitch, 'on --all: everything on again');

// 5. a session in the setup's own folder switching off affects only that folder
const rh = gpt(L.HOME, 'off');
ok(rh.status === 0 && L.setupSwitch(L.HOME).off && !L.setupSwitch(Q).off && !L.setupSwitch(P).off, "switching off the setup's own folder leaves the other projects on");
gpt(L.HOME, 'on');

// 6. a git project: edits made while off are never picked up after switching back on
const R = dir('gpt-r29-git'), bR = { cwd: R, session_id: 'r29R-' + T }, RF = path.join(R, 'tool.py');
fs.writeFileSync(RF, 'a = 1\n');
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: R, encoding: 'utf8' });
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base');
gate('session', bR); gate('prompt', { ...bR, prompt: 'go' }); wait(30);
gpt(R, 'off');
gate('prompt', { ...bR, prompt: 'work while off' }); wait(30);
fs.writeFileSync(RF, Array(10).fill('b = 2').join('\n')); // changed while off, outside Edit/Write
gate('stop', bR);
gpt(R, 'on');
gate('prompt', { ...bR, prompt: 'back on' }); gate('stop', bR);
ok(!pend(R, RF), 'a change made while off is not counted after switching back on');
wait(30); fs.writeFileSync(RF, Array(10).fill('c = 3').join('\n')); // and tracking works again
gate('stop', bR);
ok(pend(R, RF), 'a change made after switching back on is counted again');

// 6b. switched back on in the middle of a turn: what follows in that turn is scanned (a fresh window)
const shellEdit = (b, f, id, text) => {
  gate('pre-bash', { ...b, tool_use_id: id, tool_name: 'Bash', tool_input: { command: 'node update.js' } });
  fs.writeFileSync(f, text);
  gate('post-bash', { ...b, tool_use_id: id, tool_name: 'Bash', tool_input: { command: 'node update.js' } });
};
L.updateState(R, s => { delete s.changes[RF]; }); git('add', '-A'); git('commit', '-qm', 'c2');
gpt(R, 'off'); gate('prompt', { ...bR, prompt: 'turn GPT on and update tool.py' }); wait(30);
gpt(R, 'on'); wait(30);
shellEdit(bR, RF, 'u1', Array(10).fill('e = 5').join('\n'));
gate('stop', bR);
ok(pend(R, RF), 'switched on mid-turn (gpt.js on): a shell edit later in that turn is counted');
L.updateState(R, s => { delete s.changes[RF]; }); git('add', '-A'); git('commit', '-qm', 'c3');
gpt(R, 'off'); gate('prompt', { ...bR, prompt: 'go on' }); wait(30);
// switched on from another chat (state and history written by that process; this session's window is older)
L.updateState(R, s => { const e = { state: 'on', at: Date.now() }; s.setupSwitch = e; s.setupSwitchLog = (s.setupSwitchLog || []).concat(e); }); wait(30);
shellEdit(bR, RF, 'u2', Array(10).fill('f = 6').join('\n'));
gate('stop', bR);
ok(pend(R, RF), 'switched on elsewhere: an edit made after that is counted');
// a redundant "on" never loses an unreviewed shell edit of the current turn
L.updateState(R, s => { delete s.changes[RF]; }); git('add', '-A'); git('commit', '-qm', 'c4');
gate('prompt', { ...bR, prompt: 'next' }); wait(30);
shellEdit(bR, RF, 'u3', Array(10).fill('g = 7').join('\n'));
wait(30); gpt(R, 'on');
gate('stop', bR);
ok(pend(R, RF), 'gpt.js on while already on keeps the shell edit pending');
// an edit made while on, just before switching off, is still counted (after switching back on)
L.updateState(R, s => { delete s.changes[RF]; }); git('add', '-A'); git('commit', '-qm', 'c5');
gate('prompt', { ...bR, prompt: 'more' }); wait(30);
shellEdit(bR, RF, 'u4', Array(10).fill('h = 8').join('\n'));
wait(30); gpt(R, 'off'); wait(30);
fs.appendFileSync(RF, 'more = 9\n'); // and written again while off: the two can't be separated
gate('stop', bR);
gate('prompt', { ...bR, prompt: 'while off' }); wait(30);
gpt(R, 'on'); gate('prompt', { ...bR, prompt: 'on again' }); gate('stop', bR);
ok(pend(R, RF), 'a shell edit made while on, just before switching off, still counts (also when written again while off)');
// a change made while off, then a one-line edit after switching on: only the edit is Claude's
L.updateState(R, s => { delete s.changes[RF]; }); git('add', '-A'); git('commit', '-qm', 'c6');
gpt(R, 'off'); gate('prompt', { ...bR, prompt: 'off for a bit' }); wait(30);
fs.writeFileSync(RF, Array(12).fill('i = 10').join('\n')); wait(30);
gpt(R, 'on'); wait(30);
const one = { ...bR, tool_use_id: 'e1', tool_name: 'Edit', tool_input: { file_path: RF, old_string: 'i = 10', new_string: 'i = 11' } };
gate('pre-edit', one); fs.writeFileSync(RF, fs.readFileSync(RF, 'utf8').replace('i = 10', 'i = 11')); gate('post-edit', one);
ok(!/"decision":"block"/.test(gate('stop', bR) || ''), "after switching on, a one-line edit doesn't make the off-time work Claude's");

// 7. a shell command that started while on and switched off: its changes can't be separated, so they count
const SF = path.join(P, 'shell.py');
gate('pre-bash', { ...bP, tool_use_id: 'sh1', tool_name: 'Bash', tool_input: { command: 'node gen.js' } });
wait(30); gpt(P, 'off'); wait(30); fs.writeFileSync(SF, Array(10).fill('d = 4').join('\n'));
gate('post-bash', { ...bP, tool_use_id: 'sh1', tool_name: 'Bash', tool_input: { command: 'node gen.js' } });
gpt(P, 'on');
ok(pend(P, SF), 'a shell command that spans a switch to off still counts (to be safe)');
// 8. a copy that keeps an old file time (cp -p) from an off period, made while on: counted
const AG = path.join(os.homedir(), '.claude', 'agents', 'zz-r29.md'); fs.mkdirSync(path.dirname(AG), { recursive: true }); fs.writeFileSync(AG, 'name: a\n');
gpt(P, 'off'); wait(30); const offTime = new Date(); wait(30); gpt(P, 'on'); wait(30);
gate('pre-bash', { ...bP, tool_use_id: 'cp1', tool_name: 'Bash', tool_input: { command: 'cp -p src.md agents/zz-r29.md' } });
fs.writeFileSync(AG, 'name: a\ntools: Bash\n'); fs.utimesSync(AG, offTime, offTime);
gate('post-bash', { ...bP, tool_use_id: 'cp1', tool_name: 'Bash', tool_input: { command: 'cp -p src.md agents/zz-r29.md' } });
ok(pend(P, AG), 'a copy made while on that keeps a file time from an off period is counted');
fs.rmSync(AG, { force: true });

L.updateState(L.HOME, g => { if (g.sessionRoots) for (const k of Object.keys(g.sessionRoots)) if (k.startsWith('r29')) delete g.sessionRoots[k]; });
for (const d of [P, Q, R]) fs.rmSync(d, { recursive: true, force: true });
