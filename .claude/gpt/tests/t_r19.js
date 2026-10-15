// Goal round 9: the desktop check answers in time and fails closed; strict state failures; putting an
// older reviewed version back over the owner's edits is a change.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync, spawn } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const P = path.join(os.homedir(), 'gpt-final'); fs.mkdirSync(path.join(P, '.claude'), { recursive: true });
fs.writeFileSync(path.join(P, '.claude', 'gpt.json'), '{"computerUse":"claude"}'); // Claude may use the desktop here
const desk = sid => spawnSync(process.execPath, [__G + 'gate.js', 'pre-computer'], { input: JSON.stringify({ cwd: P, session_id: sid, tool_name: 'mcp__computer-use__screenshot' }), encoding: 'utf8' }).stdout;

// a free desktop whose ownership can't be recorded (read-only global state) is refused
L.updateState(L.HOME, g => { g.x = 1; });
fs.chmodSync(L.statePath(L.HOME), 0o444);
const d1 = desk('r19a');
fs.chmodSync(L.statePath(L.HOME), 0o666);
ok(/could not be checked/.test(d1), 'free desktop, ownership record fails: denied');

// strict updates turn any failure into lockFailed — even creating the state folder
fs.rmSync(L.STATE_DIR, { recursive: true, force: true }); fs.writeFileSync(L.STATE_DIR, 'not a folder');
let threw = false; try { L.updateState(P, () => {}); } catch { threw = true; }
ok(L.updateState(P, () => 'ran', true).lockFailed === true && threw, 'state folder unusable: strict -> lockFailed, normal update throws (callers fail open)');
fs.rmSync(L.STATE_DIR, { force: true }); fs.mkdirSync(L.STATE_DIR, { recursive: true });

// the desktop check answers within its deadline even while the global state lock is held by a live writer
const lock = L.statePath(L.HOME) + '.lock';
fs.mkdirSync(lock);
const keep = setInterval(() => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch {} }, 1000);
const t0 = Date.now();
const child = spawn(process.execPath, [__G + 'gate.js', 'pre-computer'], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', d => { out += d; });
child.stdin.end(JSON.stringify({ cwd: P, session_id: 'r19b', tool_name: 'mcp__computer-use__screenshot' }));
child.on('close', () => {
  clearInterval(keep); fs.rmSync(lock, { recursive: true, force: true });
  const secs = (Date.now() - t0) / 1000;
  ok(/could not be checked/.test(out) && secs < 13, `busy state lock: denied in ${secs.toFixed(1)} s (hook timeout 15 s)`);
  presets();
});

// putting an older REVIEWED preset back over the owner's newer edits (keeping the old file time) is a change
function presets() {
  fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
  const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
  const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
  const src = fs.readFileSync(__G + 'gpt.js', 'utf8'), i0 = src.indexOf('function markReviewed('), i1 = src.indexOf('\n}\n', i0) + 2;
  const mr = new Function('L', 'root', 'fs', 'path', src.slice(i0, i1) + '; return markReviewed;')(L, P, fs, path);
  const S = path.join(P, 'live.set'), b = { cwd: P, session_id: 'r19c-' + Date.now() };
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(S, 'Risk=1\n'); git('add', '-A'); git('commit', '-qm', 'init');
  gate('session', b); gate('prompt', { ...b, prompt: 'go' }); wait(30);
  fs.writeFileSync(S, 'Risk=2\n'); fs.copyFileSync(S, path.join(P, 'A.bak'));             // Claude's version A...
  const tA = fs.statSync(S).mtime;
  gate('stop', b); mr('claude-final', Date.now(), [S], []); gate('stop', b);               // ...reviewed; turn ends
  wait(30); fs.writeFileSync(S, 'Risk=5  ; owner tuned it\n');                             // the owner's B, between turns
  wait(30); gate('prompt', { ...b, prompt: 'next' }); wait(30);
  fs.copyFileSync(path.join(P, 'A.bak'), S); fs.utimesSync(S, tA, tA);                     // Claude puts A back (old time)
  gate('stop', b);
  const st = L.readState(P), c = Object.entries(st.changes).find(([k]) => k.toLowerCase() === S.toLowerCase());
  ok(c && c[1].at > L.reviewedAtFor(st, c[1]), "putting a reviewed preset back over the owner's edits is pending (git)");
  // ...and its review material says so, even next to another file that has a real diff
  const material = root => new Function('L', 'root', 'path', 'fs', 'spawnSync', 'stamp', 'NULL_DEV',
    src.slice(src.indexOf('function noIndexDiff'), src.indexOf('// Build/test/compile output')) + '; return reviewMaterial;')(L, root, path, fs, spawnSync, () => 'm' + Date.now() + Math.random(), 'NUL');
  const O = path.join(P, 'other.js'); fs.writeFileSync(O, 'let x = 1;\n');
  const m1 = material(P)([S, O], false);
  const partOf = (text, f) => (text.split('### ').find(p => p.startsWith(f)) || '');
  ok(/CHANGED BACK to its last reviewed version/.test(partOf(m1.text, S)) && !/unchanged since/.test(partOf(m1.text, S)), 'git: review material flags the put-back preset, never "unchanged"');
  fs.rmSync(m1.snapDir, { recursive: true, force: true });
  // the same through a shell command in a non-git folder
  const Q = path.join(os.homedir(), 'gpt-final2'); fs.rmSync(Q, { recursive: true, force: true }); fs.mkdirSync(Q);
  const T = path.join(Q, 'live.set'), q = { cwd: Q, session_id: 'r19d-' + Date.now() };
  const mq = new Function('L', 'root', 'fs', 'path', src.slice(i0, i1) + '; return markReviewed;')(L, Q, fs, path);
  gate('session', q); gate('prompt', { ...q, prompt: 'go' });
  fs.writeFileSync(T, 'Risk=2\n'); const tq = fs.statSync(T).mtime; fs.copyFileSync(T, path.join(Q, 'A.bak'));
  mq('claude-final', Date.now(), [T], []);
  wait(30); fs.writeFileSync(T, 'Risk=5  ; owner tuned it\n'); gate('prompt', { ...q, prompt: 'next' }); wait(30);
  gate('pre-bash', { ...q, tool_use_id: 'cp' }); fs.copyFileSync(path.join(Q, 'A.bak'), T); fs.utimesSync(T, tq, tq); gate('post-bash', { ...q, tool_use_id: 'cp' });
  const sq = L.readState(Q), cq = sq.changes[T];
  ok(cq && cq.at > L.reviewedAtFor(sq, cq), "putting a reviewed preset back over the owner's edits is pending (non-git shell)");
  const OQ = path.join(Q, 'other.js'); fs.writeFileSync(OQ, 'let y = 2;\n');
  const m2 = material(Q)([T, OQ], false);
  ok(/CHANGED BACK to its last reviewed version/.test(partOf(m2.text, T)) && !/unchanged since/.test(partOf(m2.text, T)), 'non-git: review material flags the put-back preset, never "unchanged"');
  fs.rmSync(m2.snapDir, { recursive: true, force: true });
  fs.rmSync(P, { recursive: true, force: true }); fs.rmSync(Q, { recursive: true, force: true });
}
