// No Node deprecation warnings from the setup's own child processes: an args list together with shell: true
// (DEP0190) printed a warning on every gpt.js call on a PC without Codex at its configured path (the Codex
// lookup), and in every health check (the Claude Code version check).
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-r25-test');
fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P, { recursive: true });
const gpt = (...a) => spawnSync(process.execPath, [__G + 'gpt.js', ...a], { cwd: P, encoding: 'utf8', timeout: 60000 });
const WARN = /DeprecationWarning|DEP0\d{3}/;

// Codex missing at its configured path: gpt.js looks it up (npm root -g), silently.
const cf = path.join(L.HOME, 'config.json'), orig = fs.readFileSync(cf, 'utf8');
fs.writeFileSync(cf, JSON.stringify({ ...JSON.parse(orig), codexJs: path.join(P, 'no-such-codex.js') }));
let st;
try { st = gpt('status', '--project', P); } finally { fs.writeFileSync(cf, orig); }
let parsed = false; try { parsed = JSON.parse(st.stdout).root === P; } catch {}
ok(st.status === 0 && parsed, 'gpt.js status works with Codex missing at its configured path');
ok(!WARN.test(st.stderr), `no deprecation warning while looking Codex up${WARN.test(st.stderr) ? ': ' + st.stderr.trim().split('\n')[0] : ''}`);

// Node prints the warning on the next tick, so a command that exits right after the call (doctor's Claude Code
// version check) never shows it: check the source instead. No child process call in the setup passes an args
// list together with shell: true.
const sources = ['gpt.js', 'gate.js', 'lib.js', ...fs.readdirSync(__G + 'bridge').filter(n => n.endsWith('.js')).map(n => 'bridge/' + n)];
const MIXED = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*[^,()]+,\s*\[[^\]]*\]\s*,\s*\{[^}]*\bshell:\s*true/g;
const mixed = sources.flatMap(f => (fs.readFileSync(__G + f, 'utf8').match(MIXED) || []).map(m => `${f}: ${m.slice(0, 60)}`));
ok(sources.length > 5 && !mixed.length, `no child process call combines an args list with shell: true${mixed.length ? ': ' + mixed.join(' | ') : ''}`);
ok(new RegExp(MIXED.source).test("spawnSync('claude', ['--version'], { encoding: 'utf8', shell: true })"), 'the source check recognises such a call');
fs.rmSync(P, { recursive: true, force: true });
