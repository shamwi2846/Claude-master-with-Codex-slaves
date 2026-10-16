// Goal round 2 changes: config fallback without defaults, MQL source fingerprints, release manifest check.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);

// invalid optional settings without a default are dropped, never crash the loader (runs in the test profile)
const cf = path.join(L.HOME, 'config.json'), orig = fs.readFileSync(cf, 'utf8');
fs.writeFileSync(cf, JSON.stringify({ ...JSON.parse(orig), codexJs: null, metaeditorPath: 5 }));
let cfg, threw = false;
try { cfg = L.loadConfig(); } catch { threw = true; }
fs.writeFileSync(cf, orig);
ok(!threw && cfg.problems.some(p => /codexJs/.test(p)) && cfg.problems.some(p => /metaeditorPath/.test(p)) && !('metaeditorPath' in cfg), 'invalid codexJs/metaeditorPath: dropped and reported, no crash');

// MQL source fingerprint covers included files
const mqlSources = require('./bridge-kit').evidence.mqlSources;
const M = path.join(os.homedir(), 'gpt-final', 'MQL5');
fs.mkdirSync(path.join(M, 'Include', 'Trade'), { recursive: true }); fs.mkdirSync(path.join(M, 'Experts'), { recursive: true });
fs.writeFileSync(path.join(M, 'Include', 'Trade', 'Lib.mqh'), 'int Lots(){return 1;}\n');
fs.writeFileSync(path.join(M, 'Experts', 'local.mqh'), '#include <Trade\\Lib.mqh>\n');
const E = path.join(M, 'Experts', 'E.mq5');
fs.writeFileSync(E, '#include "local.mqh"\n#include <Trade\\Lib.mqh>\n#include <Missing.mqh>\nvoid OnTick(){}\n');
const a = mqlSources(E);
fs.writeFileSync(path.join(M, 'Include', 'Trade', 'Lib.mqh'), 'int Lots(){return 2;}\n');
const b = mqlSources(E);
ok(a.files === 3 && a.missing.length === 1 && a.hash !== b.hash, 'fingerprint covers includes (local and <library>), reports missing ones, changes with an include');
fs.rmSync(path.join(os.homedir(), 'gpt-final'), { recursive: true, force: true });

// restore refuses a backup that differs from its release manifest (unless --force)
const BK = process.env.GPT_BACKUP_DIR;
if (BK && fs.existsSync(path.join(BK, '.claude', 'RELEASE.txt'))) {
  const B = path.join(os.homedir(), 'rb-' + Date.now()), H = path.join(os.homedir(), 'rh-' + Date.now());
  fs.cpSync(path.join(BK, '.claude'), path.join(B, '.claude'), { recursive: true });
  for (const f of ['restore.js', 'README.md', 'AGENT-SETUP.md']) if (fs.existsSync(path.join(BK, f))) fs.copyFileSync(path.join(BK, f), path.join(B, f));
  fs.mkdirSync(path.join(H, '.claude'), { recursive: true });
  const run = (...a2) => spawnSync(process.execPath, [path.join(B, 'restore.js'), ...a2], { env: { ...process.env, USERPROFILE: H, HOME: H }, encoding: 'utf8' });
  ok(run().status === 0, 'restore of an intact released backup succeeds');
  fs.appendFileSync(path.join(B, '.claude', 'gpt', 'lib.js'), '\n// edited after release\n');
  const r1 = run();
  ok(r1.status === 1 && /gpt\/lib\.js differs from the release/.test(r1.stderr), 'restore refuses a backup edited after its release');
  ok(run('--force').status === 0, '--force restores anyway');
  const tests = path.join(B, '.claude', 'gpt', 'tests'), one = fs.readdirSync(tests).find(n => /^t_.*\.js$/.test(n));
  fs.rmSync(path.join(tests, one));
  const r3 = run();
  ok(r3.status === 1 && new RegExp(`gpt/tests/${one.replace('.', '\\.')} is missing`).test(r3.stderr), 'restore refuses a backup missing a released file');
  fs.rmSync(path.join(B, '.claude', 'RELEASE.txt'));
  const r2 = run();
  ok(r2.status === 1 && /no RELEASE\.txt manifest/.test(r2.stderr), 'restore refuses a backup without a release manifest');
  fs.rmSync(B, { recursive: true, force: true }); fs.rmSync(H, { recursive: true, force: true });
} else console.log('SKIP no released backup (GPT_BACKUP_DIR with .claude/RELEASE.txt)');
