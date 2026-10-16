// Attribution across projects and sessions, Stop notes, the usage-limit message, score mode, status --summary.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const K = require('./bridge-kit');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const pendIn = (root, p) => { const s = L.readState(root); const c = Object.entries(s.changes).find(([k]) => k.toLowerCase() === p.toLowerCase()); return c && c[1].at > L.reviewedAtFor(s, c[1]) ? c[1] : null; };
const dir = n => { const d = path.join(os.homedir(), n); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const T = Date.now();

// a. a review's acknowledgement reaches other projects that track the same content
const O = dir('gpt-final'), S = path.join(O, 'sub');
const F = path.join(S, 'x.mq5'), G = path.join(S, 'y.mq5'), H = path.join(S, 'z.mq5');
put(F, 'F v2\n'); put(G, 'G v2\n'); put(H, 'H v2\n');
for (const root of [O, S]) L.updateState(root, s => { for (const p of [F, G, H]) s.changes[p] = { lines: 6, sensitive: true, at: T }; });
K.at(S).review.markReviewed('claude-final', T + 5, [F], []);
ok(!pendIn(O, F) && L.readState(O).changes[F].sharedFrom === path.resolve(S), 'acknowledging a file in one project acknowledges the same content in another');
const oldG = path.join(O, 'g-frozen.mq5'); put(oldG, 'G v1\n');
K.at(S).review.markReviewed('gpt', T + 5, [G], [], { verdict: 'NO_ISSUES', log: path.join(O, 'l1.md'), snaps: [{ abs: G, snap: oldG }], findingFiles: new Set() });
ok(pendIn(O, G), 'a review of other content (an older frozen copy) is not shared');
const snapH = path.join(O, 'h-frozen.mq5'); fs.copyFileSync(H, snapH);
K.at(S).review.markReviewed('gpt', T + 5, [H], [], { verdict: 'ISSUES_FOUND', log: path.join(O, 'l2.md'), snaps: [{ abs: H, snap: snapH }], findingFiles: null });
ok(pendIn(O, H), 'a review with open findings is not shared');
// an unscoped acknowledgement (mark-reviewed without --files) shares its receipts too
const S9 = path.join(O, 'sub9'), F9 = path.join(S9, 'w.mq5'); put(F9, 'W v2\n');
for (const root of [O, S9]) L.updateState(root, s => { s.changes[F9] = { lines: 6, sensitive: true, at: T }; });
K.at(S9).review.markReviewed('claude-final', T + 5, null, []);
ok(!pendIn(S9, F9) && !pendIn(O, F9), 'an unscoped acknowledgement is shared as well');

// b. this setup's file written through Edit by another session while a shell command ran
const AG = path.join(os.homedir(), '.claude', 'agents', 'zz-r21.md'); put(AG, 'name: t\n');
const PA = dir('gpt-final3'), PB = dir('gpt-final2');
const bA = { cwd: PA, session_id: 'r21A-' + T }, bB = { cwd: PB, session_id: 'r21B-' + T };
for (const x of [bA, bB]) { gate('session', x); gate('prompt', { ...x, prompt: 'go' }); }
wait(30);
gate('pre-bash', { ...bB, tool_use_id: 'b1', tool_input: { command: 'npm test' } });
const ea = { ...bA, tool_use_id: 'a1', tool_name: 'Write', tool_input: { file_path: AG, content: 'name: t\ntools: Bash\n' } };
gate('pre-edit', ea); put(AG, 'name: t\ntools: Bash\n'); gate('post-edit', ea);
gate('post-bash', { ...bB, tool_use_id: 'b1', tool_input: { command: 'npm test' } });
ok(!pendIn(PB, AG) && pendIn(PA, AG), "another session's Edit of a setup file is not taken for this session's shell change");
gate('pre-bash', { ...bB, tool_use_id: 'b2', tool_input: { command: 'node restore.js' } });
put(AG, 'name: t\ntools: Bash, Read\n');
gate('post-bash', { ...bB, tool_use_id: 'b2', tool_input: { command: 'node restore.js' } });
ok(pendIn(PB, AG), "this session's own shell change of a setup file is tracked");
fs.rmSync(AG, { force: true });

// c. the Stop note: after the block, only when the pending files change — never repeated for the same set
const PN = dir('gpt-final4'), bN = { cwd: PN, session_id: 'r21N-' + T };
gate('session', bN); gate('prompt', { ...bN, prompt: 'go' }); wait(30);
const N1 = path.join(PN, 'n.py');
const wN = n => { const e = { ...bN, tool_use_id: 'n' + n, tool_name: 'Write', tool_input: { file_path: N1, content: Array(8).fill('x' + n).join('\n') } }; gate('pre-edit', e); fs.writeFileSync(N1, e.tool_input.content); gate('post-edit', e); };
wN(1);
const s1 = gate('stop', bN), s2 = gate('stop', bN), s3 = gate('stop', bN);
wN(2); const s4 = gate('stop', bN), s5 = gate('stop', bN);
ok(/"decision":"block"/.test(s1) && s2 === '' && s3 === '' && /still pending/.test(s4) && !/decision/.test(s4) && s5 === '', 'Stop note only when the pending set changes');

// d. "model is not supported ... ChatGPT account" (plan usage used up) is a usage limit
const msg = 'codex exit 1: ERROR: {"detail":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}';
ok(K.codex.LIMIT_ERR.test(msg) && !K.codex.retryable({ ok: false, reason: msg }), 'model-not-supported counts as a usage limit (no retry; cooldown)');

// e. score: applies the rubric; with --files the files are reviewed and recorded like a review
const PS = dir('gpt-final5');
const S1 = path.join(PS, 'a.js'), S2 = path.join(PS, 'b.js'), rubric = path.join(PS, 'rubric.md'), other = path.join(PS, 'other-review.md');
put(S1, 'let a = 1;\n'); put(S2, 'let b = 2;\n'); put(rubric, '1. Correctness\n2. Tests\n');
L.updateState(PS, s => { s.changes[S1] = { lines: 6, at: Date.now() - 50, openFindings: [other] }; s.changes[S2] = { lines: 6, at: Date.now() - 50 }; });
let seen = '';
const answer = t => async o => { seen = o.prompt; return { ok: true, text: t, verdict: (t.match(/VERDICT: (\w+)/) || [])[1], log: path.join(PS, `score-${Math.random().toString(36).slice(2)}.md`), secs: 1, tokens: 0 }; };
K.codex.finish = (r, onOk) => { if (r.ok && onOk) onOk(); };
(async () => {
  K.at(PS, { opts: { file: rubric, files: `${S1},${S2}` } });
  K.codex.ask = answer('VERDICT: ALL_10\n1. Correctness: 10/10 — nothing worth its cost');
  await K.review.score();
  const st = L.readState(PS);
  ok(/Apply the rubric as written/.test(seen) && /ALSO REVIEW/.test(seen) && /a\.js/.test(seen), 'score prompt applies the rubric and reviews the frozen files');
  ok(!pendIn(PS, S1) && !pendIn(PS, S2) && [].concat(st.changes[S1].openFindings || []).includes(other), 'score without findings: files reviewed clean; other open findings stay');
  L.updateState(PS, s => { s.changes[S2].at = Date.now(); }); wait(5);
  K.at(PS, { opts: { file: rubric, files: S2 } });
  K.codex.ask = answer(`VERDICT: BELOW_10\n1. Correctness: 8/10 — a bug\n### [HIGH] off by one\n- Location: ${S2}:1\n- Failure: x\n- Fix: y`);
  await K.review.score();
  const c2 = L.readState(PS).changes[S2];
  ok(c2.reviewStatus === 'findings' && [].concat(c2.openFindings || []).length === 1, 'score findings stay open on the file they point at');
  K.at(PS, { opts: { file: rubric } }); K.codex.ask = answer('VERDICT: BELOW_10\n1. Tests: 7/10');
  L.updateState(PS, s => { s.changes[S1].at = Date.now(); }); wait(5);
  await K.review.score();
  ok(pendIn(PS, S1) && !/ALSO REVIEW/.test(seen), 'score without --files changes nothing (informational)');
  ok(K.codex.checkVerdict({ ok: true, text: 'VERDICT: ALL_10\nx' }, 'score').verdict === 'ALL_10' && !K.codex.checkVerdict({ ok: true, text: 'VERDICT: AGREE\nx' }, 'score').ok, 'score verdicts are ALL_10 | BELOW_10');

  // f. status --summary: pending files grouped by folder
  const PM = dir('gpt-final6');
  L.updateState(PM, s => {
    for (const n of ['src/a/x.js', 'src/a/y.js', 'src/b/z.js', 'top.js']) s.changes[path.join(PM, n)] = { lines: 6, at: Date.now(), sensitive: n === 'top.js' };
    s.notAuthored = [{ file: path.join(PM, 'c.js'), why: 'copy of existing content', at: Date.now() }];
  });
  const sum = spawnSync(process.execPath, [__G + 'gpt.js', 'status', '--summary', '--project', PM], { encoding: 'utf8' }).stdout;
  ok(/4 file\(s\) waiting/.test(sum) && /src\/a\/\s+2\b/.test(sum) && /src\/b\/\s+1\b/.test(sum) && /\.\/\s+1 \(1 sensitive\)/.test(sum) && /not tracked .*copy of existing content/.test(sum), 'status --summary groups pending files by folder');

  // g. a usage limit hit during the verdict repair still starts the cooldown (whole reason kept)
  const PL = dir('gpt-final7'), stub = path.join(PL, 'codex-stub.js');
  fs.writeFileSync(stub, `const a = process.argv.slice(2), o = a[a.indexOf('-o') + 1];
if (a.includes('resume')) { process.stderr.write('ERROR: {"detail":"The \\'gpt-6.1-sol-with-a-much-longer-model-name-so-the-phrase-ends-past-160-characters-x\\' model is not supported when using Codex with a ChatGPT account."}\\n'); process.exit(1); }
process.stderr.write('session id: 0123abcd-0123-0123-0123-0123456789ab\\n'); require('fs').writeFileSync(o, 'an answer without a verdict line'); process.exit(0);`);
  L.updateState(L.HOME, g => { delete g.limitUntil; });
  delete require.cache[require.resolve(path.join(__G, 'bridge', 'codex.js'))];
  const freshCodex = require(path.join(__G, 'bridge', 'codex.js')); // the real ask (K.codex.ask is replaced above)
  K.at(PL, { opts: {}, cfg: { ...K.C.cfg, codexJs: stub } });
  const rl = await freshCodex.ask({ mode: 'review', prompt: 'x', effort: K.C.cfg.defaultEffort, sandbox: 'read-only', persist: true });
  ok(!rl.ok && (L.readState(L.HOME).limitUntil || 0) > Date.now(), `usage limit during the verdict repair starts the cooldown (${String(rl.reason).slice(0, 60)}...)`);
  L.updateState(L.HOME, g => { delete g.limitUntil; delete g.limitReason; });

  for (const d of [O, PA, PB, PN, PS, PM, PL]) fs.rmSync(d, { recursive: true, force: true });
  L.updateState(L.HOME, g => { if (g.sessionRoots) for (const k of Object.keys(g.sessionRoots)) if (k.startsWith('r21')) delete g.sessionRoots[k]; });
})();
