// --files paths: relative ones are looked up from the project root and the current folder, and a wrong path
// stops the call before GPT reviews nothing. `note` without a log goes to the project's latest GPT log.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const K = require('./bridge-kit'), L = K.L;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-r26-test'), SUB = path.join(P, 'skill');
fs.rmSync(P, { recursive: true, force: true });
for (const d of ['mcp/app', 'skill/mcp/app', 'skill/only']) fs.mkdirSync(path.join(P, d), { recursive: true });
fs.writeFileSync(path.join(P, 'mcp', 'app', 'server.mjs'), 'export const a = 1;\n');
fs.writeFileSync(path.join(P, 'both.js'), 'root\n'); fs.writeFileSync(path.join(SUB, 'both.js'), 'sub\n');
fs.writeFileSync(path.join(SUB, 'only', 'here.js'), 'x\n');
const gpt = (cwd, ...a) => spawnSync(process.execPath, [__G + 'gpt.js', ...a], { cwd, encoding: 'utf8', timeout: 60000 });

// 1. C.files, with Claude's shell in a subfolder of the project
K.at(P); const cwd0 = process.cwd(); process.chdir(SUB);
const die0 = K.C.die; K.C.die = m => { throw new Error('DIE ' + m); };
const tryFiles = (v, must) => { try { return K.C.files(v, must); } catch (e) { return e.message; } };
ok(tryFiles('mcp/app/server.mjs')[0] === path.join(P, 'mcp', 'app', 'server.mjs'), 'a path relative to the project root is found from a subfolder');
ok(tryFiles('only/here.js')[0] === path.join(SUB, 'only', 'here.js'), 'a path relative to the current folder still works');
ok(/^DIE --files: "both\.js" matches both/.test(tryFiles('both.js')), 'a path matching different files in both places stops the call');
ok(tryFiles('gone/old.js')[0] === path.join(P, 'gone', 'old.js'), 'a path found nowhere (a deletion) is taken from the project root');
ok(/^DIE --files: not found: .*gone/.test(tryFiles('gone/old.js', true)), 'with mustExist, a missing path stops the call');
ok(tryFiles(path.join(SUB, 'both.js'))[0] === path.join(SUB, 'both.js') && tryFiles(undefined).length === 0, 'absolute paths are taken as given; no --files is an empty list');
K.C.die = die0; process.chdir(cwd0);

// 2. review / digest with a wrong path: stopped before GPT (the test profile's GPT stub would fail with exit 3)
const r1 = gpt(SUB, 'review', '--task', 'x', '--project', P, '--files', 'skill/mcp/app/nothing.mjs');
ok(r1.status === 2 && /not found and not a tracked deletion/.test(r1.stderr) && /Nothing was sent to GPT/.test(r1.stderr), 'review stops on a path that is neither a file nor a tracked deletion');
const r2 = gpt(SUB, 'digest', '--question', 'x', '--project', P, '--files', 'nope.log');
ok(r2.status === 2 && /Nothing was sent to GPT/.test(r2.stderr), 'digest stops on a missing file');
// a deleted file the tracker knows is still reviewed (it reaches GPT: the stub's failure, not the path check)
const gone = path.join(P, 'mcp', 'app', 'old.mjs');
L.updateState(P, s => { s.changes[gone] = { lines: 6, at: Date.now(), deleted: true }; });
const r3 = gpt(SUB, 'review', '--task', 'x', '--project', P, '--files', 'mcp/app/old.mjs');
ok(r3.status !== 2 && !/not found/.test(r3.stderr), `a tracked deletion passes the path check (exit ${r3.status})`);
L.updateState(P, s => { delete s.changes[gone]; });

// 3. note without a log: the latest GPT run log, never an answer copy or a skipped-review record
const D = K.at(P).C.logDir();
for (const f of fs.readdirSync(D)) fs.rmSync(path.join(D, f), { recursive: true, force: true });
const n0 = gpt(SUB, 'note', '--project', P, '--text', 'x');
ok(n0.status === 2 && /no GPT log yet/.test(n0.stderr), 'note without a log in a project with no GPT log says so');
fs.writeFileSync(path.join(D, '2026-10-16-10-00-00_idea_aaaa.md'), '# idea\n');
fs.writeFileSync(path.join(D, '2026-10-16-11-00-00_review-r2_bbbb.md'), '# review r2\n');
fs.writeFileSync(path.join(D, '2026-10-16-11-00-00_review-r2_bbbb.answer.md'), 'answer\n');
fs.writeFileSync(path.join(D, '2026-10-16-12-00-00_skipped_cccc.md'), '# skipped\n');
const n1 = gpt(SUB, 'note', '--project', P, '--text', 'decided: keep it');
ok(n1.status === 0 && /decided: keep it/.test(fs.readFileSync(path.join(D, '2026-10-16-11-00-00_review-r2_bbbb.md'), 'utf8')), 'note without a log goes to the latest GPT run log');
ok(!/decided/.test(fs.readFileSync(path.join(D, '2026-10-16-12-00-00_skipped_cccc.md'), 'utf8') + fs.readFileSync(path.join(D, '2026-10-16-11-00-00_review-r2_bbbb.answer.md'), 'utf8')), 'never to a skipped-review record or an answer copy');
const n2 = gpt(SUB, 'note', path.join(D, '2026-10-16-10-00-00_idea_aaaa.md'), '--project', P, '--text', 'on the idea');
ok(n2.status === 0 && /on the idea/.test(fs.readFileSync(path.join(D, '2026-10-16-10-00-00_idea_aaaa.md'), 'utf8')), 'an explicit log is still used');
const n3 = gpt(SUB, 'note', path.join(D, 'missing.md'), '--project', P, '--text', 'x');
ok(n3.status === 2 && /no such log/.test(n3.stderr), 'a missing explicit log is reported');
// two runs started in the same second: the one that finished last per index.tsv (by name, review_zzzz
// would win), even after an explicit note touched the other one
const tA = path.join(D, '2026-10-16-13-00-00_review_zzzz.md'), tB = path.join(D, '2026-10-16-13-00-00_idea_aaaa.md');
fs.writeFileSync(tA, '# a\n'); fs.writeFileSync(tB, '# b\n');
const row = n => ['2026-10-16T13:00:05.000Z', 'x', 'ok', '-', '5', 'fresh', n, '0', '0', '0/0/0/0'].join('\t') + '\n';
fs.writeFileSync(path.join(D, 'index.tsv'), row('2026-10-16-13-00-00_review_zzzz.md') + row('2026-10-16-13-00-00_idea_aaaa.md') + row('gone_review_x.md'));
gpt(SUB, 'note', tA, '--project', P, '--text', 'explicit');
const n4 = gpt(SUB, 'note', '--project', P, '--text', 'same second');
ok(n4.status === 0 && /same second/.test(fs.readFileSync(tB, 'utf8')) && !/same second/.test(fs.readFileSync(tA, 'utf8')), 'of two runs started in the same second, the one that finished last');
fs.rmSync(P, { recursive: true, force: true });
