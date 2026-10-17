// Round-7 bug fixes: content fingerprints, committed base, ignored presets, re-deletion, findings, staged writes.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const SID = 'r7-' + Date.now(), b = { cwd: P, session_id: SID };
const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
const f = n => path.join(P, n);
const old = (p, h = 1) => { const t = new Date(Date.now() - h * 3600e3); fs.utimesSync(p, t, t); };
const prompt = () => { wait(30); gate('prompt', { ...b, prompt: 'go' }); wait(30); };
const stop = () => gate('stop', b);
const pend = n => { const s = L.readState(P); const c = Object.entries(s.changes).find(([k]) => k.toLowerCase() === f(n).toLowerCase()); return c && c[1].at > L.reviewedAtFor(s, c[1]) ? c[1] : null; };
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
fs.writeFileSync(f('.gitignore'), 'ign/\n');
for (const n of ['p.set', 'u.js', 'u2.js', 'c.js', 'h.js', 'q.js', 'del.js']) fs.writeFileSync(f(n), n + ' v1\n');
git('add', '-A'); git('commit', '-qm', 'init');
fs.writeFileSync(f('c.js'), 'c.js v2\n'); git('commit', '-qam', 'c2'); // committed before the turns
fs.mkdirSync(f('ign')); fs.writeFileSync(f('ign/a.set'), 'A=1\n'); fs.writeFileSync(f('ign/c.set'), 'C=1\n');
fs.writeFileSync(f('u.js'), 'user work\n'); fs.writeFileSync(f('u2.js'), 'user work 2\n'); old(f('u.js')); old(f('u2.js'));
const K = require('./bridge-kit').at(P);
const mr = K.review.markReviewed;
const ack = () => mr('claude-final', Date.now(), null, L.gitDeleted(P));
gate('session', b); prompt();

// 1. preset overwritten with an older timestamp (Copy-Item / cp -p) during the turn
fs.writeFileSync(f('p.set'), 'Risk=9\n'); old(f('p.set'), 5);
// 2. user's dirty file rewritten with identical content (new time): no change
fs.writeFileSync(f('u.js'), 'user work\n');
// 3. user's own dirty work committed unchanged during the turn
git('commit', '-qm', 'user work 2', '--', 'u2.js');
// 6. ignored presets: changed with an old time, created with an old time, deleted
fs.writeFileSync(f('ign/a.set'), 'A=2\n'); old(f('ign/a.set'), 5);
fs.writeFileSync(f('ign/b.set'), 'B=1\n'); old(f('ign/b.set'), 5);
fs.rmSync(f('ign/c.set'));
stop();
ok(pend('p.set'), 'tracked preset changed with an old timestamp is pending');
ok(!pend('u.js'), "user's dirty file rewritten identically is not pending");
ok(!pend('u2.js'), "user's work committed unchanged during the turn is not pending");
ok(pend('ign/a.set') && pend('ign/b.set'), 'ignored presets changed/created with old timestamps are pending');
ok(pend('ign/c.set') && pend('ign/c.set').deleted, 'ignored preset deleted during the turn is pending (deleted)');

// 4b. git reset HEAD~1 of a commit made before the turn: not a change
git('add', '-A'); git('commit', '-qm', 'snap'); ack(); prompt();
git('reset', '-q', 'HEAD~1'); // the snapshot commit's files become dirty with old times, content = turn start
stop();
ok(!L.pending(L.readState(P)).length, 'reset HEAD~1 (and commits made just before the turn) create no new changes');

// 5. shell edit + commit + shell edit, then a new prompt: the record keeps the turn-start diff base
git('add', '-A'); git('commit', '-qm', 'clean'); ack(); prompt();
const head0 = git('rev-parse', 'HEAD').stdout.trim();
fs.writeFileSync(f('h.js'), 'h.js v2\n'); git('commit', '-qam', 'h2'); wait(20); fs.writeFileSync(f('h.js'), 'h.js v3\n');
prompt();
const ch = pend('h.js');
ok(ch && ch.committed && ch.sinceRev === head0, 'shell edit + commit + edit keeps committed + turn-start sinceRev');

// 7. reviewed deletion, file restored between turns, deleted again: detected
git('add', '-A'); git('commit', '-qm', 'c3'); ack(); L.updateState(P, s => { s.changes[f('del.js')] = { lines: 0, at: 1, reviewedAt: 2, deleted: true }; }); prompt();
ok(L.readState(P).changes[f('del.js')].deleted === false, 'a restored file loses its stale deleted flag at turn start');
fs.rmSync(f('del.js')); stop();
ok(pend('del.js') && pend('del.js').deleted, 'deleting it again is a new pending deletion');

// 8. preserved-time copy, then an Edit in the same turn: the copy is recorded, the baseline not captured
git('add', '-A'); git('commit', '-qm', 'c4'); ack(); prompt();
fs.writeFileSync(f('q.js'), 'copied\n'); old(f('q.js'), 5);
const ev = { ...b, tool_use_id: 'q', tool_name: 'Edit', tool_input: { file_path: f('q.js'), old_string: 'copied', new_string: 'edited' } };
gate('pre-edit', ev);
const cq = pend('q.js');
ok(cq && cq.shellTouched && !L.baselineOf(P, f('q.js')), 'pre-edit records a same-turn copy with an old time; no baseline captured');

// 9. a live review that froze exactly this content keeps the change acknowledgeable
git('add', '-A'); git('commit', '-qm', 'c5'); ack(); prompt();
fs.writeFileSync(f('p.set'), 'Risk=3\n'); old(f('p.set'), 5);
const cutoff = Date.now() - 5;
L.updateState(P, s => { s.running = { x: { pid: process.pid, cutoff, files: [f('p.set').toLowerCase()], hashes: [L.fileHash(f('p.set'))] } }; });
stop();
const cp = L.readState(P).changes[f('p.set')];
ok(cp && cp.at === cutoff, 'content change already frozen by a running review is dated at its cutoff');
L.updateState(P, s => { delete s.running; });

// 10. open findings: a fresh clean review keeps them; a follow-up of their chain clears them
const F = f('u.js'), X = path.join(P, 'r1.md');
fs.writeFileSync(X, '- Round: 1\n'); const X2 = path.join(P, 'r2.md'); fs.writeFileSync(X2, `- Round: 2\n- Follows: ${X}\n`);
L.updateState(P, s => { s.changes[F] = { lines: 5, at: Date.now() - 10, openFindings: X }; });
mr('gpt', Date.now(), [F], [], { verdict: 'NO_ISSUES', log: path.join(P, 'fresh.md'), snaps: [], findingFiles: new Set() });
ok([].concat(L.readState(P).changes[F].openFindings || []).includes(X), 'fresh clean review keeps earlier open findings');
mr('gpt', Date.now(), [F], [], { verdict: 'ISSUES_FOUND', log: path.join(P, 'other.md'), snaps: [], findingFiles: null });
mr('gpt', Date.now(), [F], [], { verdict: 'RESOLVED', log: path.join(P, 'r3.md'), snaps: [], findingFiles: new Set(), resolves: [X2, X] });
const of = [].concat(L.readState(P).changes[F].openFindings || []);
ok(!of.includes(X) && of.includes(path.join(P, 'other.md')), "follow-up clears its own chain's findings, keeps another review's");
mr('claude-final', Date.now(), [F], []);
ok([].concat(L.readState(P).changes[F].openFindings || []).includes(path.join(P, 'other.md')), 'a manual acknowledgement keeps open findings (only a follow-up or closing that chain removes them)');

// 11. a failed revision leaves the reviewed staged version untouched
const SD = path.join(P, 'stage'); fs.mkdirSync(path.join(SD, 'work'), { recursive: true }); fs.writeFileSync(path.join(SD, 'work', 'doc.md'), 'reviewed\n');
fs.mkdirSync(path.join(SD, 'prev')); fs.writeFileSync(path.join(SD, 'prev', 'doc.md'), 'reviewed\n');
// GPT fails after writing a partial result into its scratch copy
K.codex.ask = async o => { o.before(); fs.writeFileSync(path.join(o.cwd, 'doc.md'), 'PARTIAL\n'); return { ok: false, reason: 'timeout', log: 'l' }; };
K.codex.markUnavailable = () => {}; K.codex.finish = () => { throw new Error('FIN'); };
const rw = K.write.runWrite;
rw(SD, { id: 'x', round: 2, entries: [] }, path.join(SD, 'prev')).catch(() => {}).then(() => {
  ok(fs.readFileSync(path.join(SD, 'work', 'doc.md'), 'utf8') === 'reviewed\n' && !fs.existsSync(path.join(SD, 'next')), 'failed revision keeps the reviewed staged copy');
  fs.rmSync(P, { recursive: true, force: true });
  L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[SID]; });
});

