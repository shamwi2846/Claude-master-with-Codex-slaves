// Round-12 hook fixes.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const SID = 'r12-' + Date.now(), b = { cwd: P, session_id: SID };
const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
const f = n => path.join(P, n);
const prompt = (text = 'go') => { wait(30); gate('prompt', { ...b, prompt: text }); wait(30); };
const pend = n => { const s = L.readState(P); const c = Object.entries(s.changes).find(([k]) => k.toLowerCase() === f(n).toLowerCase()); return c && c[1].at > L.reviewedAtFor(s, c[1]) ? c[1] : null; };
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
for (const n of ['k.js', 'm.js', 'A.mq5']) fs.writeFileSync(f(n), n + ' v1\n');
git('add', '-A'); git('commit', '-qm', 'init'); wait(1100);
gate('session', b); prompt();

// 6. finished turn, user edit, then a notification with only read-only GPT runs in the background
gate('post-bash', { ...b, tool_use_id: 'g', tool_input: { command: 'node "C:/Users/Shari/.claude/gpt/gpt.js" review --task x', run_in_background: true } });
gate('stop', b); // nothing pending: the turn ends
fs.writeFileSync(f('k.js'), 'user edit after the turn\n');
prompt('<task-notification><task-id>x</task-id></task-notification>');
gate('stop', b);
ok(!pend('k.js'), 'user edit after the turn ended is not attributed when only a GPT review ran in the background');
// the same with a background command that may write files: the window stays, its changes are seen
git('add', '-A'); git('commit', '-qm', 'k'); prompt();
gate('post-bash', { ...b, tool_use_id: 'w', tool_input: { command: 'npm run generate', run_in_background: true } });
gate('stop', b);
fs.writeFileSync(f('m.js'), 'written by the background job\n');
prompt('<task-notification><task-id>y</task-id></task-notification>');
gate('stop', b);
ok(pend('m.js'), "a background writer's later change is still caught after the turn ended");

// LOW. two live reviews cover B; the older froze other content, the newer froze exactly this content
git('add', '-A'); git('commit', '-qm', 'm'); L.updateState(P, s => { s.reviewedAt = Date.now(); }); prompt();
fs.writeFileSync(f('A.mq5'), 'A v2\n'); gate('stop', b);
const cA = L.readState(P).changes[f('A.mq5')];
const k = f('A.mq5').toLowerCase();
L.updateState(P, s => { s.running = {
  o: { pid: process.pid, cutoff: cA.at + 1, files: [k], hashes: ['0'.repeat(64)] },
  n: { pid: process.pid, cutoff: cA.at + 2, files: [k], hashes: [L.fileHash(f('A.mq5'))] } }; });
gate('stop', b);
ok(L.readState(P).changes[f('A.mq5')].at === cA.at, 'a matching newer review keeps covering it despite an older mismatching one');
L.updateState(P, s => { delete s.running; });

// MEDIUM. non-git: a command that grows the project past 1000 code files does not flag untouched files
const Q = path.join(os.homedir(), 'gpt-final2'); fs.rmSync(Q, { recursive: true, force: true }); fs.mkdirSync(Q);
for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(Q, `f${i}.js`), `// ${i}\n`);
const bq = { cwd: Q, session_id: SID + 'q' }; gate('session', bq); gate('prompt', { ...bq, prompt: 'go' });
gate('pre-bash', { ...bq, tool_use_id: 't' });
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(Q, `new${i}.js`), 'x\n');
gate('post-bash', { ...bq, tool_use_id: 't' });
const sq = L.readState(Q);
ok(!sq.changes[path.join(Q, 'f0.js')] && sq.changes[path.join(Q, 'new0.js')], 'crossing 1000 files: untouched files not flagged, new ones are');

fs.rmSync(P, { recursive: true, force: true }); fs.rmSync(Q, { recursive: true, force: true });
L.updateState(L.HOME, g => { if (g.sessionRoots) { delete g.sessionRoots[SID]; delete g.sessionRoots[SID + 'q']; } });
