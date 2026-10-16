// CodeRabbit round 1: output decoded as a stream (split UTF-8 characters), restore takes every released agent.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const K = require('./bridge-kit');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);

(async () => {
  // a multibyte character written in two pieces (separate chunks) reaches the evidence whole
  const P = fs.mkdtempSync(path.join(os.homedir(), 'gpt-r23-')); // (only this folder is removed afterwards)
  const w = path.join(P, 'split.js');
  fs.writeFileSync(w, "process.stdout.write(Buffer.from([0xE2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xAC, 0x0A])), 300);\n");
  const r = await K.at(P).evidence.runTracked(`node "${w}"`, 30000);
  ok(r.out.includes('€') && !r.out.includes('�'), `a character split between output chunks stays whole (${JSON.stringify(r.out.trim().slice(-4))})`);
  fs.rmSync(P, { recursive: true, force: true });

  // a check script started directly (outside the test profile) never touches that home: it hands itself to run.js
  const F = fs.mkdtempSync(path.join(os.homedir(), 'fakehome-'));
  const d = spawnSync(process.execPath, [path.join(__dirname, 't_must.js')], { env: { ...process.env, USERPROFILE: F, HOME: F }, encoding: 'utf8', timeout: 120000 });
  ok(d.status === 0 && /runs only inside the test profile/.test(d.stderr) && /^OK: \d+ passed/m.test(d.stdout) && !fs.existsSync(path.join(F, 'gpt-final')),
    'a check started directly runs inside a fresh test profile, never in the real home');
  fs.rmSync(F, { recursive: true, force: true });
  // ...and every check script loads the guard before anything else (comments and blank lines aside)
  const unguarded = fs.readdirSync(__dirname).filter(n => /^t_.*\.js$/.test(n)).filter(n => {
    const code = fs.readFileSync(path.join(__dirname, n), 'utf8').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('//'));
    return !code || !code.startsWith("require('./profile-guard');");
  });
  ok(!unguarded.length, `every check script loads the profile guard first${unguarded.length ? ` (missing: ${unguarded.join(', ')})` : ''}`);

  // every agent file in the backup is restored (release.js packs the whole agents folder)
  const BK = process.env.GPT_BACKUP_DIR;
  if (!BK || !fs.existsSync(path.join(BK, '.claude', 'RELEASE.txt'))) return console.log('SKIP no released backup (GPT_BACKUP_DIR with .claude/RELEASE.txt)');
  const B = path.join(os.homedir(), 'rb-' + Date.now()), H = path.join(os.homedir(), 'rh-' + Date.now());
  fs.cpSync(path.join(BK, '.claude'), path.join(B, '.claude'), { recursive: true });
  for (const f of ['restore.js', 'README.md', 'AGENT-SETUP.md']) if (fs.existsSync(path.join(BK, f))) fs.copyFileSync(path.join(BK, f), path.join(B, f));
  fs.writeFileSync(path.join(B, '.claude', 'agents', 'zz-second-agent.md'), '---\nname: zz\n---\n');
  fs.mkdirSync(path.join(H, '.claude'), { recursive: true });
  const rr = spawnSync(process.execPath, [path.join(B, 'restore.js'), '--force'], { env: { ...process.env, USERPROFILE: H, HOME: H }, encoding: 'utf8' });
  const agents = fs.readdirSync(path.join(B, '.claude', 'agents'));
  ok(rr.status === 0 && agents.length > 1 && agents.every(n => fs.existsSync(path.join(H, '.claude', 'agents', n))), `restore copies every agent in the backup (${agents.join(', ')})`);
  fs.rmSync(B, { recursive: true, force: true }); fs.rmSync(H, { recursive: true, force: true });
})();
