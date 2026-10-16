// Goal round 1 changes: diff failures, write status, config/project validation, hook trace, partial walks.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const K = require('./bridge-kit');

// a git diff that fails is "unknown", never "unchanged"
const nid = K.review.noIndexDiff;
ok(nid(path.join(os.homedir(), 'no-such-file-' + Date.now()), path.join(os.homedir(), 'no-such-either')) === null, 'failed diff returns null (read the whole file)');

// config validation (shared by the runtime loader and restore.js)
const good = JSON.parse(fs.readFileSync(__G + 'config.json', 'utf8'));
ok(!L.validateConfig(good).length, 'the live config is valid');
const badCfg = { ...good, timeoutMinutes: { xhigh: '45m' }, computerDisableMcp: {}, defaultEffort: 'low' };
const fields = L.validateConfig(badCfg).map(([k]) => k);
ok(['timeoutMinutes', 'computerDisableMcp', 'defaultEffort'].every(k => fields.includes(k)), 'invalid fields are named');
ok(L.loadConfig().problems.length === 0, 'runtime loader reports no problems for the live config');

// project switches: invalid values are ignored and listed
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(path.join(P, '.claude'), { recursive: true });
fs.writeFileSync(path.join(P, '.claude', 'gpt.json'), JSON.stringify({ review: 'no', computerUse: 'claude', bogus: 1 }));
const ps = L.projectSettings(P);
ok(ps.review === true && ps.computerUse === 'claude' && ps._problems.length === 2, 'gpt.json: invalid/unknown values ignored and listed');
fs.rmSync(path.join(P, '.claude'), { recursive: true, force: true });

// every hook run is timed; survived problems are traceable
const before = fs.existsSync(L.HOOK_TIMES) ? fs.readFileSync(L.HOOK_TIMES, 'utf8').length : 0;
gate('pre-plan', { cwd: P, session_id: 'r14-' + Date.now(), tool_input: { plan: 'x' } });
ok(fs.readFileSync(L.HOOK_TIMES, 'utf8').length > before, 'hook run recorded in hook-times.tsv');

// a write result without STATUS: DONE is not staged
const SD = path.join(P, 'stage'); fs.mkdirSync(path.join(SD, 'work'), { recursive: true }); fs.writeFileSync(path.join(SD, 'work', 'doc.md'), 'reviewed\n');
K.at(P);
K.codex.ask = async o => { o.before(); fs.writeFileSync(path.join(o.cwd, 'doc.md'), 'new\n'); return { ok: true, text: '- did it (forgot the status line)', log: 'l', secs: 1 }; };
K.codex.markUnavailable = () => {}; K.codex.finish = () => {};
let published = false; K.write.publishDir = () => { published = true; throw new Error('should not publish'); };
const realExit = process.exit; process.exit = () => { throw new Error('EXIT'); };
const rw = K.write.runWrite;
const log0 = console.log; console.log = () => {};
(async () => {
  try { await rw(SD, { id: 'x', round: 1, entries: [] }, path.join(SD, 'work')); } catch {}
  console.log = log0; process.exit = realExit;
  ok(!published && fs.readFileSync(path.join(SD, 'work', 'doc.md'), 'utf8') === 'reviewed\n', 'a write result without STATUS: DONE is not staged');

  // huge non-git folder: the files the walk reaches are still compared, and the partial coverage is recorded
  const Q = path.join(os.homedir(), 'gpt-final2'); fs.rmSync(Q, { recursive: true, force: true });
  fs.mkdirSync(path.join(Q, 'aaa'), { recursive: true });
  fs.writeFileSync(path.join(Q, 'aaa', '0.js'), 'x\n');
  for (let i = 1; i < 5100; i++) fs.writeFileSync(path.join(Q, 'aaa', `${i}.txt`), '');
  const b = { cwd: Q, session_id: 'r14q-' + Date.now() };
  gate('session', b); gate('prompt', { ...b, prompt: 'go' });
  gate('pre-bash', { ...b, tool_use_id: 'h' }); fs.writeFileSync(path.join(Q, 'aaa', '0.js'), 'changed\n'); gate('post-bash', { ...b, tool_use_id: 'h' });
  const sq = L.readState(Q);
  ok(sq.changes[path.join(Q, 'aaa', '0.js')] && sq.shellScanPartial, 'huge folder: reached files still tracked, partial coverage recorded');
  fs.rmSync(Q, { recursive: true, force: true }); fs.rmSync(P, { recursive: true, force: true });
  L.updateState(L.HOME, g => { if (g.sessionRoots) delete g.sessionRoots[b.session_id]; });
})();
