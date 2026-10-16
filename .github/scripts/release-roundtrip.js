// Weekly CI check: a real release -> restore round trip, in throwaway profiles whose paths hold spaces and
// non-ASCII letters. Run from anywhere: node .github/scripts/release-roundtrip.js
//   1. restore this repository's release into profile A (restore.js, as on a new PC);
//   2. release A's setup for real into backup folder B (release.js: candidate, strict checks, publish);
//   3. restore B into profile C, then check C: the same files as this repository's release (paths relocated
//      to C), every registered hook points at C's gate.js, and the hooks run and track an edit there.
// Kept out of tests/run.js: release.js itself runs that suite. Nothing outside the throwaway folder changes.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
// Short names: the checks nest folders several levels deep under each profile (Windows paths stop at 260).
const base = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'rt é '));
// The children get their own temp folder: the setup never tracks files under the temp folder, and the
// profiles below must look like ordinary home folders.
const TMP = path.join(base, 'tmp');
const A = path.join(base, 'home A ü'), B = path.join(base, 'backup B ø'), C = path.join(base, 'home C ñ');
for (const d of [TMP, A, B, C]) fs.mkdirSync(d, { recursive: true });
const envFor = home => ({ ...process.env, USERPROFILE: home, HOME: home, TEMP: TMP, TMP, GPT_BACKUP_DIR: '' });
let failed = 0;
const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) failed++; };
const run = (what, file, args, home, timeout = 600000) => {
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env: envFor(home), cwd: home, timeout });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  ok(r.status === 0, `${what}${r.status === 0 ? '' : ` (exit ${r.status}${r.error ? ', ' + r.error.message : ''})\n${out.split('\n').slice(-15).join('\n')}`}`);
  return r.status === 0 ? r.stdout : null; // stdout only: a warning on stderr must not break parsing
};
const finish = () => {
  if (!failed) fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  console.log(failed ? `FAILED: ${failed} check(s); files kept in ${base}` : 'OK: release -> restore round trip');
  process.exit(failed ? 1 : 0);
};
const manifestOf = dir => {
  const t = fs.readFileSync(path.join(dir, '.claude', 'RELEASE.txt'), 'utf8');
  return { source: (t.match(/^Source: (.+)$/m) || [])[1].trim(), files: [...t.matchAll(/^[0-9a-f]{16} {2}\.claude\/(.+)$/gm)].map(m => m[1].trim()).sort() };
};
// A released file as restore.js writes it: only these docs get their .claude paths (either slash style)
// relocated, so only they are compared with the folder replaced by a placeholder; all else byte for byte.
const RELOCATED = new Set(['CLAUDE.md', 'gpt/REFERENCE.md']);
const norm = (file, rel, claudeDir) => {
  if (!RELOCATED.has(rel)) return fs.readFileSync(file).toString('base64');
  const fwd = claudeDir.replace(/\\/g, '/');
  return fs.readFileSync(file, 'utf8').split(fwd).join('<CLAUDE>').split(fwd.replace(/\//g, '\\')).join('<CLAUDE>');
};

// 1. this repository's release -> profile A
if (run('restore into profile A', path.join(REPO, 'restore.js'), [], A) === null) finish();

// 2. a real release from profile A into backup folder B (which needs the backup folder's own files)
for (const f of ['restore.js', 'README.md', 'AGENT-SETUP.md']) fs.copyFileSync(path.join(REPO, f), path.join(B, f));
const rel = run('release from profile A into backup B', path.join(A, '.claude', 'gpt', 'tests', 'release.js'), ['--backup', B], A, 1800000);
if (rel === null) finish();
ok(/^Released \d+ files .* checks: OK: \d+ passed, 0 failed, 0 skipped/m.test(rel), `the release ran every check: ${rel.split('\n').pop()}`);

// 3. backup B -> profile C
if (run('restore backup B into profile C', path.join(B, 'restore.js'), [], C) === null) finish();
const orig = manifestOf(REPO), back = manifestOf(B), CC = path.join(C, '.claude');
ok(back.source.replace(/\\/g, '/') === path.join(A, '.claude').replace(/\\/g, '/'), 'backup B records profile A as its source');
ok(JSON.stringify(back.files) === JSON.stringify(orig.files), `backup B releases the same ${orig.files.length} files as this repository`);
const differ = orig.files.filter(f => f !== 'settings.json' && (!fs.existsSync(path.join(CC, f)) || norm(path.join(CC, f), f, CC) !== norm(path.join(REPO, '.claude', f), f, orig.source)));
ok(!differ.length, `profile C holds every released file unchanged (paths relocated)${differ.length ? ': differ ' + differ.join(', ') : ''}`);

// Registered hooks: same events and handlers as this repository's settings, each pointing at C's gate.js.
const hooks = s => Object.entries(s.hooks || {}).flatMap(([ev, gs]) => gs.flatMap(g => (g.hooks || []).map(h => ({ ev, matcher: g.matcher || '', command: String(h.command || '') }))))
  .filter(h => /gate\.js/i.test(h.command));
const want = hooks(JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8')));
const got = hooks(JSON.parse(fs.readFileSync(path.join(CC, 'settings.json'), 'utf8')));
const gateOf = h => ((h.command.match(/"([^"]*gate\.js)"/i) || [])[1] || '').replace(/\\/g, '/').toLowerCase();
const key = h => `${h.ev}|${h.matcher}|${h.command.split(/gate\.js"?\s+/i)[1]}`;
ok(JSON.stringify(got.map(key).sort()) === JSON.stringify(want.map(key).sort()), `profile C registers the same ${want.length} hooks`);
ok(got.length && got.every(h => gateOf(h) === path.join(CC, 'gpt', 'gate.js').replace(/\\/g, '/').toLowerCase()), "every hook runs profile C's gate.js");

// Run the registered commands as Claude Code would (through the shell, JSON on stdin) for one edit.
const P = path.join(C, 'project ç'); fs.mkdirSync(P);
const target = path.join(P, 'app.js'), content = Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
const sid = 'roundtrip-' + Date.now();
const cmdFor = (ev, tool) => (got.find(h => h.command.endsWith(` ${ev}`) && (!tool || new RegExp(`^(${h.matcher})$`).test(tool))) || {}).command;
const fire = (ev, tool, extra) => {
  const command = cmdFor(ev, tool);
  if (!command) { ok(false, `no registered hook for ${ev}${tool ? ' / ' + tool : ''}`); return ''; }
  const r = spawnSync(command, { shell: true, encoding: 'utf8', env: envFor(C), cwd: P, timeout: 60000,
    input: JSON.stringify({ cwd: P, session_id: sid, hook_event_name: ev, ...(tool ? { tool_name: tool } : {}), ...extra }) });
  let json = true; try { if (r.stdout.trim()) JSON.parse(r.stdout); } catch { json = false; }
  ok(r.status === 0 && json, `${ev}${tool ? ' (' + tool + ')' : ''} hook runs${r.status === 0 && json ? '' : `: exit ${r.status} ${(r.stdout + r.stderr).trim().slice(0, 300)}`}`);
  return r.stdout || '';
};
fire('session'); fire('prompt', null, { prompt: 'write app.js' });
const edit = { tool_input: { file_path: target, content }, tool_use_id: 'w1' };
fire('pre-edit', 'Write', edit); fs.writeFileSync(target, content); fire('post-edit', 'Write', edit);
const shell = { tool_input: { command: 'echo hi' }, tool_use_id: 'b1' };
fire('pre-bash', 'Bash', shell); fire('post-bash', 'Bash', { ...shell, tool_response: { stdout: 'hi', stderr: '' } });
const status = run('gpt.js status in profile C', path.join(CC, 'gpt', 'gpt.js'), ['status', '--project', P], C);
let pending = [];
// (the JSON object only: a PC without Codex, like CI, may print a note before it)
try { pending = JSON.parse(String(status).slice(String(status).indexOf('{'))).pendingReview.map(x => path.resolve(x.file).toLowerCase()); } catch {}
ok(pending.includes(path.resolve(target).toLowerCase()), `the restored hooks track Claude's edit in profile C${pending.includes(path.resolve(target).toLowerCase()) ? '' : `: status said ${String(status).slice(0, 600)}`}`);
ok(/GPT review needed/.test(fire('stop')), 'the Stop hook asks for its review');
ok(/"permissionDecision":"deny"/.test(fire('pre-computer', 'mcp__computer-use__screenshot', { tool_input: {} })), "Claude's own desktop control is delegated to GPT");
let issues = ''; try { issues = fs.readFileSync(path.join(CC, 'gpt', 'logs', 'hooks.log'), 'utf8').trim(); } catch {}
ok(!issues, `no hook recorded a failure${issues ? ': ' + issues.split('\n').slice(-3).join(' | ') : ''}`);
finish();
