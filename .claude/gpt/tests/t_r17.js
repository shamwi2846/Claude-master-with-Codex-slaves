// Goal round 5: config value sets, git scan failures traced, empty test discovery, release lock, restore fallback.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);

// config: values Codex would reject are named
const good = JSON.parse(fs.readFileSync(path.join(L.HOME, 'config.json'), 'utf8'));
const f1 = L.validateConfig({ ...good, windowsSandbox: 'unelavated', allowedEfforts: ['xhigh', 'ultra'] }).map(([k]) => k);
ok(f1.includes('windowsSandbox') && f1.includes('allowedEfforts'), 'sandbox typo and unknown effort are rejected');
const P = path.join(os.homedir(), 'gpt-final'); fs.mkdirSync(path.join(P, '.claude'), { recursive: true });
fs.writeFileSync(path.join(P, '.claude', 'gpt.json'), JSON.stringify({ effort: 'ultra' }));
ok(L.projectSettings(P).effort === 'auto' && L.projectSettings(P)._problems.length === 1, 'gpt.json: unknown effort ignored and listed');
fs.rmSync(P, { recursive: true, force: true });

// a git command that fails inside a repo is traced (not silently "nothing changed")
fs.mkdirSync(P, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: P });
fs.writeFileSync(path.join(P, '.git', 'index'), 'garbage'); // a corrupt index makes `git status` fail
const before = L.recentHookIssues(1).length;
const st = L.gitStatus(P);
ok(st === null && L.recentHookIssues(1).length > before && /git status/.test(L.recentHookIssues(1).pop()[2]), 'failed git status is recorded as a hook problem');
fs.rmSync(P, { recursive: true, force: true });

// git itself unusable (here: not on PATH) is traced too — repo detection is then off, not silently "no repo"
fs.mkdirSync(P, { recursive: true });
const noGit = spawnSync(process.execPath, ['-e', `const L=require(${JSON.stringify(__G + 'lib.js')});console.log(L.gitRoot(${JSON.stringify(P)}), L.gitHead(${JSON.stringify(P)}))`],
  { encoding: 'utf8', env: { ...process.env, PATH: '', Path: '' } });
const last = L.recentHookIssues(1).slice(-2).map(x => x[2]).join(' | ');
ok(/null null/.test(noGit.stdout) && /git rev-parse in/.test(last) && /git rev-parse HEAD in/.test(last), 'git missing: rev-parse failures are recorded');
fs.rmSync(P, { recursive: true, force: true });

// config roots that aren't objects are reported, not silently defaulted
const cfPath = path.join(L.HOME, 'config.json'), cfOrig = fs.readFileSync(cfPath, 'utf8');
for (const bad of ['[]', 'null', '"x"']) {
  fs.writeFileSync(cfPath, bad);
  const c = L.loadConfig();
  ok(c.model === L.CONFIG_DEFAULTS.model && c.problems.some(p => /config\.json must be a JSON object/.test(p)), `config.json ${bad}: defaults used and reported`);
}
fs.writeFileSync(cfPath, cfOrig);
fs.mkdirSync(path.join(P, '.claude'), { recursive: true });
for (const bad of ['null', '[1]', '"auto"']) {
  fs.writeFileSync(path.join(P, '.claude', 'gpt.json'), bad);
  const ps = L.projectSettings(P);
  ok(ps.review === true && ps._problems.some(p => /must be a JSON object/.test(p)), `gpt.json ${bad}: defaults apply and reported`);
}
fs.rmSync(P, { recursive: true, force: true });

// run.js: a filter that matches no script is a failure, not "OK"
const rr = spawnSync(process.execPath, [__G + 'tests/run.js', 'zz-no-such-check'], { encoding: 'utf8' });
ok(rr.status === 1 && /no check scripts/.test(rr.stdout), 'empty test discovery fails');

// release.js: one release per backup folder — the lock is a socket the OS holds while a release runs
const BK = path.join(os.homedir(), 'bk-' + Date.now()); fs.mkdirSync(BK); fs.writeFileSync(path.join(BK, 'restore.js'), '// stub\n');
const port = 20000 + parseInt(require('crypto').createHash('sha1').update(path.resolve(BK).toLowerCase()).digest('hex').slice(0, 4), 16) % 16000;
const holder = require('net').createServer().listen(port, '127.0.0.1', () => {
  const r = spawnSync(process.execPath, [__G + 'tests/release.js', '--backup', BK], { encoding: 'utf8', timeout: 60000 });
  holder.close();
  ok(r.status === 1 && /another release is running/.test(r.stderr) && !fs.existsSync(path.join(BK, '.candidate')), 'a second release is refused while one holds the lock, and touches nothing');
  fs.rmSync(BK, { recursive: true, force: true });
  restoreCheck();
});

function restoreCheck() {

// restore.js: with .claude missing (interrupted release), restores the previous release from .claude.prev
const SRC = process.env.GPT_BACKUP_DIR;
if (SRC && fs.existsSync(path.join(SRC, '.claude', 'RELEASE.txt'))) {
  const B = path.join(os.homedir(), 'rb-' + Date.now()), H = path.join(os.homedir(), 'rh-' + Date.now());
  fs.cpSync(path.join(SRC, '.claude'), path.join(B, '.claude.prev'), { recursive: true });
  // an OLDER release: its manifest recorded a different restore.js/README than the ones in the folder now
  const mf = path.join(B, '.claude.prev', 'RELEASE.txt');
  fs.writeFileSync(mf, fs.readFileSync(mf, 'utf8').replace(/^[0-9a-f]{16}(  (restore\.js|README\.md|AGENT-SETUP\.md))$/gm, '0123456789abcdef$1'));
  for (const f of ['restore.js', 'README.md', 'AGENT-SETUP.md']) if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(B, f));
  fs.mkdirSync(path.join(H, '.claude'), { recursive: true });
  const rs = spawnSync(process.execPath, [path.join(B, 'restore.js')], { env: { ...process.env, USERPROFILE: H, HOME: H }, encoding: 'utf8' });
  ok(rs.status === 0 && /\.claude\.prev/.test(rs.stdout) && fs.existsSync(path.join(H, '.claude', 'gpt', 'gate.js')), 'restore uses .claude.prev when .claude is missing');
  fs.rmSync(B, { recursive: true, force: true }); fs.rmSync(H, { recursive: true, force: true });
} else console.log('SKIP no released backup (GPT_BACKUP_DIR with .claude/RELEASE.txt)');
}
