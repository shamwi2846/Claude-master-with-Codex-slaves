// Throwaway tests: first commit in a new repo; message-only amend.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const P = path.join(os.homedir(), 'gpt-b3'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 'me@x'); git('config', 'user.name', 'me');
fs.writeFileSync(path.join(P, 'first.js'), 'v1');
const t0 = Date.now(); sleep(1100);
git('add', '-A'); git('commit', '-qm', 'first');
ok(L.gitCommittedSince(P, null, t0).some(d => d.abs.endsWith('first.js')), 'first commit in a new repo detected (turnHead null)');
sleep(1100);
const head = L.gitHead(P), t1 = Date.now(); sleep(1100);
git('commit', '-q', '--amend', '-m', 'better message');
ok(L.gitCommittedSince(P, head, t1).length === 0, 'message-only amend changes nothing');
fs.writeFileSync(path.join(P, 'first.js'), 'v2'); git('commit', '-q', '-a', '--amend', '-m', 'with code');
ok(L.gitCommittedSince(P, head, t1).some(d => d.abs.endsWith('first.js')), 'amend with code changes detected');
fs.rmSync(P, { recursive: true, force: true });
