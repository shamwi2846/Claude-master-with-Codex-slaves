// CodeRabbit round 1: output decoded as a stream (split UTF-8 characters), restore takes every released agent.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const K = require('./bridge-kit');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);

(async () => {
  // a multibyte character written in two pieces (separate chunks) reaches the evidence whole
  const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
  const w = path.join(P, 'split.js');
  fs.writeFileSync(w, "process.stdout.write(Buffer.from([0xE2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xAC, 0x0A])), 300);\n");
  const r = await K.at(P).evidence.runTracked(`node "${w}"`, 30000);
  ok(r.out.includes('€') && !r.out.includes('�'), `a character split between output chunks stays whole (${JSON.stringify(r.out.trim().slice(-4))})`);
  fs.rmSync(P, { recursive: true, force: true });

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
