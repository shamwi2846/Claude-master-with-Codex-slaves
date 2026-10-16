// A project's .claude/gpt.json written from another chat (session A, in another project) is A's change:
// tracked and reviewed in A, not counted by the project's own chat (session B) when its turn ends. B's own
// write, or a later edit of A's write by someone else, still counts in B. Its ignore list applies in B once
// A's write is reviewed.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const K = require('./bridge-kit');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const pendIn = (root, p) => { const s = L.readState(root); const c = Object.entries(s.changes || {}).find(([k]) => k.toLowerCase() === p.toLowerCase()); return c && c[1].at > L.reviewedAtFor(s, c[1]) ? c[1] : null; };
const dir = n => { const d = path.join(os.homedir(), n); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const T = Date.now();
const PA = dir('gpt-r27-setup'), PB = dir('gpt-r27-tools'), PC = dir('gpt-r27-nogit');
const GJ = path.join(PB, '.claude', 'gpt.json'), BUNDLE = path.join(PB, 'app', 'server.mjs');
put(BUNDLE, 'export const v = 0;\n');
// B is a git repo (the turn-end scan reads git status); its bundle is committed, as in MQL5-CHM-MCP
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: PB, encoding: 'utf8' });
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base');
const bA = { cwd: PA, session_id: 'r27A-' + T }, bB = { cwd: PB, session_id: 'r27B-' + T };
for (const x of [bA, bB]) { gate('session', x); gate('prompt', { ...x, prompt: 'go' }); }
wait(30);
const write = (b, id, content) => { const e = { ...b, tool_use_id: id, tool_name: 'Write', tool_input: { file_path: GJ, content } }; gate('pre-edit', e); put(GJ, content); gate('post-edit', e); };
const turn = b => { gate('prompt', { ...b, prompt: 'next' }); wait(30); };

// 1. A writes B's gpt.json while B's turn is open
const C1 = JSON.stringify({ ignore: ['app/**'] }, null, 2) + '\n';
write(bA, 'a1', C1);
ok(pendIn(PA, GJ), "the chat that wrote another project's gpt.json tracks it");
const s1 = gate('stop', bB);
ok(!pendIn(PB, GJ) && !/gpt\.json/.test(s1), "the project's own chat does not count it when its turn ends");

// 2. while A's write is unreviewed, B's ignore list is not applied yet (a pending gpt.json is never trusted)
turn(bB); put(BUNDLE, 'export const v = 1;\n' + 'x();\n'.repeat(8));
gate('stop', bB);
ok(pendIn(PB, BUNDLE), 'its ignore list waits until the write is reviewed');
L.updateState(PB, s => { delete s.changes[BUNDLE]; });

// 3. A's review acknowledges it: B's ignore list now applies
K.at(PA).review.markReviewed('claude-final', Date.now(), [GJ], []);
turn(bB); put(BUNDLE, 'export const v = 2;\n' + 'y();\n'.repeat(8));
gate('stop', bB);
ok(!pendIn(PA, GJ) && !pendIn(PB, BUNDLE), 'once reviewed, the ignored bundle is not flagged in the project');

// 4. A writes again, then someone edits the file by hand: B counts the edit (it is not A's write any more)
turn(bB);
write(bA, 'a2', JSON.stringify({ ignore: ['app/**', 'dist/**'] }, null, 2) + '\n');
put(GJ, JSON.stringify({ ignore: ['**'] }, null, 2) + '\n');
gate('stop', bB);
ok(pendIn(PB, GJ), "a hand edit after another chat's write is counted");
L.updateState(PB, s => { delete s.changes[GJ]; });

// 5. B writes its own gpt.json: tracked in B
turn(bB);
write(bB, 'b1', JSON.stringify({ ignore: ['app/**'], effort: 'auto' }, null, 2) + '\n');
gate('stop', bB);
ok(pendIn(PB, GJ), "the project's own write of its gpt.json is tracked there");

// 6. a non-git project (like MQL5 TOOLS, which holds nested repos): A's write lands while a shell command of
// the project's chat runs, and is not taken for that command's change
const GC = path.join(PC, '.claude', 'gpt.json'), bC = { cwd: PC, session_id: 'r27C-' + T };
put(path.join(PC, 'tool.py'), 'x = 1\n');
gate('session', bC); gate('prompt', { ...bC, prompt: 'go' }); wait(30);
gate('pre-bash', { ...bC, tool_use_id: 'c1', tool_input: { command: 'npm run build' } });
const eC = { ...bA, tool_use_id: 'a3', tool_name: 'Write', tool_input: { file_path: GC, content: '{ "ignore": ["app/**"] }\n' } };
gate('pre-edit', eC); put(GC, eC.tool_input.content); gate('post-edit', eC);
gate('post-bash', { ...bC, tool_use_id: 'c1', tool_input: { command: 'npm run build' } });
ok(!pendIn(PC, GC) && pendIn(PA, GC), "in a non-git project, another chat's write of its gpt.json during a shell command is not that command's change");

// 7. the project's own shell command changes gpt.json, then the other chat edits it before that command
// ends: the other chat's baseline already holds that change, so it must still count here
gate('pre-bash', { ...bC, tool_use_id: 'c2', tool_input: { command: 'node setup.js' } });
put(GC, '{ "ignore": ["app/**", "dist/**"] }\n'); // the command's own change
const eC2 = { ...bA, tool_use_id: 'a4', tool_name: 'Write', tool_input: { file_path: GC, content: '{ "ignore": ["app/**", "dist/**"], "effort": "auto" }\n' } };
gate('pre-edit', eC2); put(GC, eC2.tool_input.content); gate('post-edit', eC2);
gate('post-bash', { ...bC, tool_use_id: 'c2', tool_input: { command: 'node setup.js' } });
ok(pendIn(PC, GC), "a change made here before the other chat's write is still counted here");

// 8. an Edit that only deletes text is the other chat's write too (git project, turn end)
K.at(PB).review.markReviewed('claude-final', Date.now(), [GJ], []); // B's own write (5) is reviewed
gate('stop', bB); turn(bB);
const eDel = { ...bA, tool_use_id: 'a5', tool_name: 'Edit', tool_input: { file_path: GJ, old_string: ',\n  "effort": "auto"', new_string: '' } };
gate('pre-edit', eDel); put(GJ, fs.readFileSync(GJ, 'utf8').replace(',\n  "effort": "auto"', '')); gate('post-edit', eDel);
gate('stop', bB);
ok(!pendIn(PB, GJ) && pendIn(PA, GJ), "another chat's deletion-only Edit is not counted here");

// 9. two writes in a row by the other chat during one turn: both are its own
turn(bB);
write(bA, 'a6', JSON.stringify({ ignore: ['app/**'] }, null, 2) + '\n');
write(bA, 'a7', JSON.stringify({ ignore: ['app/**', 'build/**'] }, null, 2) + '\n');
gate('stop', bB);
ok(!pendIn(PB, GJ), "another chat's consecutive writes in one turn are not counted here");

L.updateState(L.HOME, g => {
  if (g.sessionRoots) for (const b of [bA, bB, bC]) delete g.sessionRoots[b.session_id];
  if (g.setupWrites) for (const f of [GJ, GC]) delete g.setupWrites[f.toLowerCase()];
});
for (const d of [PA, PB, PC]) fs.rmSync(d, { recursive: true, force: true });
