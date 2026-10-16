// Round-10 hook fixes.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const SID = 'r10-' + Date.now(), b = { cwd: P, session_id: SID };
const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
const f = n => path.join(P, n);
const old = (p, h = 1) => { const t = new Date(Date.now() - h * 3600e3); fs.utimesSync(p, t, t); };
const prompt = () => { wait(30); gate('prompt', { ...b, prompt: 'go' }); wait(30); };
const pend = n => { const s = L.readState(P); const c = Object.entries(s.changes).find(([k]) => k.toLowerCase() === f(n).toLowerCase()); return c && c[1].at > L.reviewedAtFor(s, c[1]) ? c[1] : null; };
const mr = require('./bridge-kit').at(P).review.markReviewed;
const ack = () => mr('claude-final', Date.now(), null, L.gitDeleted(P));
const fresh = () => { git('add', '-A'); git('commit', '-qm', 'x'); ack(); prompt(); };
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
fs.mkdirSync(f('.claude'));
fs.writeFileSync(f('.gitignore'), '.claude/settings.local.json\n');
fs.writeFileSync(f('engine.mqh'), 'double Lots(){ return 0.01; }\nvoid Go(){ OrderSend(r,s); }\n');
for (const n of ['calc.mqh', 'a.set', 'b.set', 'k.js', 'gone.js', 'old.js']) fs.writeFileSync(f(n), n + ' v1\n');
git('add', '-A'); git('commit', '-qm', 'init'); wait(1100);
gate('session', b); prompt();

// a. one-line edit in a generically named file that calls OrderSend elsewhere
const ev = { ...b, tool_use_id: 'a', tool_name: 'Edit', tool_input: { file_path: f('engine.mqh'), old_string: '0.01', new_string: '0.1' } };
gate('pre-edit', ev); fs.writeFileSync(f('engine.mqh'), 'double Lots(){ return 0.1; }\nvoid Go(){ OrderSend(r,s); }\n'); gate('post-edit', ev);
ok(pend('engine.mqh') && pend('engine.mqh').sensitive && /engine\.mqh/.test(gate('stop', b)), '1-line edit in an OrderSend file is sensitive and needs review');

// b. user's uncommitted work restored to HEAD by a shell command / untracked user file deleted
fresh(); fs.writeFileSync(f('calc.mqh'), 'user change\n'); fs.writeFileSync(f('notes.js'), 'user file\n'); prompt();
git('restore', 'calc.mqh'); fs.rmSync(f('notes.js')); gate('stop', b);
ok(pend('calc.mqh') && pend('notes.js') && pend('notes.js').deleted, "discarding the user's uncommitted work is pending review");

// c. ignored .claude/settings.local.json changed by a shell command -> tracked; written outside a shell -> not
fresh(); fs.writeFileSync(f('.claude/settings.local.json'), '{}\n'); prompt();
gate('pre-bash', { ...b, tool_use_id: 'c' });
fs.writeFileSync(f('.claude/settings.local.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');
gate('post-bash', { ...b, tool_use_id: 'c' });
ok(pend('.claude/settings.local.json'), 'shell edit of ignored settings.local.json is pending');
fresh(); fs.writeFileSync(f('.claude/settings.local.json'), '{"permissions":{"allow":["Read"]}}\n'); gate('stop', b);
ok(!pend('.claude/settings.local.json'), 'Claude Code writing settings.local.json itself (no shell) is not flagged');

// d. two reviewed presets; the earlier-modified one copied over the other keeping its time
fresh(); fs.writeFileSync(f('a.set'), 'A=2\n'); wait(50); fs.writeFileSync(f('b.set'), 'B=2\n'); gate('stop', b); ack();
const ta = fs.statSync(f('a.set')).mtime; fs.copyFileSync(f('a.set'), f('b.set')); fs.utimesSync(f('b.set'), ta, ta);
gate('stop', b);
ok(pend('b.set'), 'reviewed preset overwritten by a copy with an older in-turn time is pending');

// f. the user's edits after a completed turn are not attributed to it
fresh(); gate('stop', b); fs.writeFileSync(f('k.js'), 'user edit between turns\n'); prompt();
ok(!pend('k.js'), "edits made after the turn ended are the user's, not pending");

// g. git rm --cached: file still on disk, not a deletion and not a new change
fresh(); git('rm', '-q', '--cached', 'old.js'); gate('stop', b);
ok(!pend('old.js'), 'index-only removal is not a pending change'); git('reset', '-q', 'old.js');

// h. a running review that froze a deletion acknowledges its later discovery
fresh(); fs.rmSync(f('gone.js'));
const cutoff = Date.now() - 5;
L.updateState(P, s => { s.running = { x: { pid: process.pid, cutoff, files: [f('gone.js').toLowerCase()], hashes: ['absent'] } }; });
gate('stop', b);
ok(L.readState(P).changes[f('gone.js')].at === cutoff, 'deletion frozen by a running review is dated at its cutoff');
L.updateState(P, s => { delete s.running; });

// i. committing a deletion that existed before the turn
git('add', '-A'); git('commit', '-qm', 'y'); ack(); fs.rmSync(f('k.js')); prompt();
git('commit', '-qam', 'remove k'); gate('stop', b);
ok(!pend('k.js'), 'committing a pre-turn deletion is not a new change');

// e. non-git: same-size overwrite keeping the old time is caught for presets
const Q = path.join(os.homedir(), 'gpt-final2'); fs.rmSync(Q, { recursive: true, force: true }); fs.mkdirSync(Q);
const bq = { cwd: Q, session_id: SID + 'q' }; gate('session', bq); gate('prompt', { ...bq, prompt: 'go' });
fs.writeFileSync(path.join(Q, 'p.set'), 'R=1\n'); old(path.join(Q, 'p.set'));
const tq = fs.statSync(path.join(Q, 'p.set')).mtime;
gate('pre-bash', { ...bq, tool_use_id: 'e' });
fs.writeFileSync(path.join(Q, 'p.set'), 'R=9\n'); fs.utimesSync(path.join(Q, 'p.set'), tq, tq);
gate('post-bash', { ...bq, tool_use_id: 'e' });
const sq = L.readState(Q), cq = sq.changes[path.join(Q, 'p.set')];
ok(cq && cq.at > L.reviewedAtFor(sq, cq), 'non-git preset overwritten with same size and time is pending');

fs.rmSync(P, { recursive: true, force: true }); fs.rmSync(Q, { recursive: true, force: true });
L.updateState(L.HOME, g => { if (g.sessionRoots) { delete g.sessionRoots[SID]; delete g.sessionRoots[SID + 'q']; } });
