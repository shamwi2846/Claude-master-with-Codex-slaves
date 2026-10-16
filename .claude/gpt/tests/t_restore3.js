// restore.js refuses a backup config.json that lacks required fields, and changes nothing.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const __B = (process.env.GPT_BACKUP_DIR || require('path').join(require('os').homedir(), 'Desktop', 'Cloude agent')).replace(/\\/g, '/') + '/';
if (!require('fs').existsSync(__B + 'restore.js')) { console.log('SKIP no backup folder (set GPT_BACKUP_DIR)'); process.exit(0); }
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const B = path.join(os.homedir(), 'rb-' + Date.now()), H = path.join(os.homedir(), 'rh-' + Date.now());
fs.cpSync(__B + '.claude', path.join(B, '.claude'), { recursive: true });
fs.copyFileSync(__B + 'restore.js', path.join(B, 'restore.js'));
const cf = path.join(B, '.claude', 'gpt', 'config.json');
const conf = JSON.parse(fs.readFileSync(cf, 'utf8')); delete conf.allowedEfforts; fs.writeFileSync(cf, JSON.stringify(conf));
fs.mkdirSync(path.join(H, '.claude'), { recursive: true }); fs.writeFileSync(path.join(H, '.claude', 'settings.json'), '{"model":"x"}');
// the edited config no longer matches the release manifest: --force gets past that check to config validation
const run = () => spawnSync(process.execPath, [path.join(B, 'restore.js'), '--force'], { env: { ...process.env, USERPROFILE: H, HOME: H }, encoding: 'utf8' });
let r = run();
ok(r.status === 1 && /allowedEfforts/.test(r.stderr) && !fs.existsSync(path.join(H, '.claude', 'gpt')) && fs.readFileSync(path.join(H, '.claude', 'settings.json'), 'utf8') === '{"model":"x"}', 'config without allowedEfforts: aborted, nothing changed');
conf.allowedEfforts = ['high']; fs.writeFileSync(cf, JSON.stringify(conf));
r = run();
ok(r.status === 1 && /defaultEffort/.test(r.stderr), 'defaultEffort outside allowedEfforts: aborted');
conf.allowedEfforts = ['xhigh']; conf.timeoutMinutes = { xhigh: '45m' }; fs.writeFileSync(cf, JSON.stringify(conf));
r = run();
ok(r.status === 1 && /timeoutMinutes/.test(r.stderr), 'non-numeric timeout: aborted');
conf.timeoutMinutes = { xhigh: 45 }; conf.evidenceTailLines = 'x'; fs.writeFileSync(cf, JSON.stringify(conf));
r = run();
ok(r.status === 1 && /evidenceTailLines/.test(r.stderr), 'invalid optional number: aborted');
conf.evidenceTailLines = 120; const mcp = conf.computerDisableMcp; conf.computerDisableMcp = {}; fs.writeFileSync(cf, JSON.stringify(conf));
r = run();
ok(r.status === 1 && /computerDisableMcp/.test(r.stderr), 'non-list computerDisableMcp: aborted');
conf.computerDisableMcp = mcp; fs.writeFileSync(cf, JSON.stringify(conf));
r = run();
ok(r.status === 0, 'valid config restores');
fs.rmSync(B, { recursive: true, force: true }); fs.rmSync(H, { recursive: true, force: true });
