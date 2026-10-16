// Goal round 3: a deleted file's previous version is frozen for review (diff and whole-file audits).
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const git = (...a) => spawnSync('git', a, { cwd: P, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
const F = path.join(P, 'risk.mq5'), N = path.join(P, 'never.js');
fs.writeFileSync(F, 'double Risk(){ return 0.01; }\n'); git('add', '-A'); git('commit', '-qm', 'init');
fs.rmSync(F);
const mod = require('./bridge-kit').at(P).review;
for (const full of [false, true]) {
  const mat = mod.reviewMaterial([F, N], full);
  const m = mat.map.find(x => x.abs === F), n = mat.map.find(x => x.abs === N);
  ok(m.prior && fs.readFileSync(m.prior, 'utf8').includes('Risk') && /DELETED — its previous version, frozen/.test(mat.text),
    `${full ? 'whole-file audit' : 'diff review'}: deleted file's previous version is frozen and listed`);
  ok(!n.prior && /REVIEW COVERAGE INCOMPLETE/.test(mat.text), `${full ? 'whole-file audit' : 'diff review'}: unknown deleted file is flagged as incomplete coverage`);
  fs.rmSync(mat.snapDir, { recursive: true, force: true });
}
// a deletion committed during the turn: even a whole-file audit takes the previous version from the turn's
// starting revision (HEAD no longer has the file)
const G = path.join(P, 'orders.mq5');
fs.writeFileSync(G, 'void Buy(){ OrderSend(r,s); }\n'); git('add', '-A'); git('commit', '-qm', 'orders');
const head0 = git('rev-parse', 'HEAD').stdout.trim();
L.updateState(P, s => { s.turnStartedAt = Date.now() - 2000; s.turnHead = head0; });
git('rm', '-q', 'orders.mq5'); git('commit', '-qm', 'remove orders');
const matG = mod.reviewMaterial([G], true);
const g = matG.map[0];
ok(g.prior && fs.readFileSync(g.prior, 'utf8').includes('OrderSend'), 'whole-file audit of a committed deletion freezes the turn-start version');
fs.rmSync(matG.snapDir, { recursive: true, force: true });
fs.rmSync(P, { recursive: true, force: true });
