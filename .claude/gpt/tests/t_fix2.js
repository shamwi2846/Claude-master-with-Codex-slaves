// Throwaway tests for the round-2 fixes.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const GATE = __G + 'gate.js';
const gate = (ev, input) => spawnSync(process.execPath, [GATE, ev], { input: JSON.stringify(input), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const proj = path.join(os.homedir(), 'gpt-fix2-test'); fs.rmSync(proj, { recursive: true, force: true }); fs.mkdirSync(proj);

// replace_all deleting 10 occurrences with ""
const C = path.join(proj, 'c.py');
fs.writeFileSync(C, Array.from({ length: 10 }, () => 'debug_check()\n').join('') + 'end\n');
const ev = { cwd: proj, tool_name: 'Edit', tool_input: { file_path: C, old_string: 'debug_check()\n', new_string: '', replace_all: true } };
gate('pre-edit', ev); fs.writeFileSync(C, 'end\n'); gate('post-edit', ev);
const lines = L.readState(proj).changes[C].lines;
ok(lines >= 10, `bulk delete counted: lines=${lines}`);

// binary (UTF-16) change is reported, not "unchanged"
const nid = require('./bridge-kit').review.noIndexDiff;
const b1 = path.join(proj, 'a.ps1'), b2 = path.join(proj, 'b.ps1');
fs.writeFileSync(b1, Buffer.from('\ufeffWrite-Host 1', 'utf16le')); fs.writeFileSync(b2, Buffer.from('\ufeffWrite-Host 2', 'utf16le'));
ok(/binary or non-text change/.test(nid(b1, b2)), 'UTF-16 change reported');
ok(nid(b1, b1) === '', 'identical files -> empty diff');

// pre-existing staged rename is part of the deletion baseline
const g = path.join(proj, 'repo'); fs.mkdirSync(g);
const run = (...a) => spawnSync('git', a, { cwd: g });
run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
fs.writeFileSync(path.join(g, 'helper.js'), 'x'); run('add', '-A'); run('commit', '-qm', 'i'); run('mv', 'helper.js', 'helper.txt');
ok(L.gitDeleted(g).some(f => f.endsWith('helper.js')), 'staged rename source in deletion baseline');

fs.rmSync(proj, { recursive: true, force: true });
for (const x of fs.readdirSync(L.STATE_DIR)) {
  const p = path.join(L.STATE_DIR, x);
  try { if (JSON.parse(fs.readFileSync(p, 'utf8')).root.startsWith(proj)) fs.rmSync(p); } catch {}
}
