// Document writing: GPT edits staged copies; Claude reviews the diff; `apply` copies them back.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../lib');
const C = require('./ctx');
const X = require('./codex');

const W = module.exports; // runWrite calls publishDir through it, so a test can replace it
const STAGE_DIR = path.join(L.HOME, 'stage');
const TEXT_DOC = /\.(md|markdown|txt|rst|adoc|csv)$/i;

function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

// Replace directory `to` with the complete directory `from` by renames (same volume): `to` is either
// the old or the new version, never a partial copy; on failure the old version is put back.
function publishDir(from, to) {
  const old = `${to}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  // Windows: a just-exited process or a virus scanner can hold a handle for a moment — retry briefly.
  const rename = (a, b) => {
    for (let i = 0; ; i++) {
      try { return fs.renameSync(a, b); } catch (e) {
        if (i >= 9 || !/EPERM|EBUSY|EACCES/.test(e.code || '')) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  };
  const had = fs.existsSync(to);
  if (had) rename(to, old);
  try { rename(from, to); } catch (e) { if (had) rename(old, to); throw e; }
  // Published. Removing the old copy is housekeeping (retried at the next publish), never a failure.
  try { fs.rmSync(old, { recursive: true, force: true }); } catch {}
}

function loadManifest(id) {
  // Only IDs gpt.js generates are accepted — no paths, so a GPT-created nested manifest can't be selected.
  if (!/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-z0-9]{4}$/.test(String(id))) C.die(`invalid stage id "${id}"`);
  const dir = path.join(STAGE_DIR, String(id));
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) C.die(`no staged write "${id}" (see ${STAGE_DIR})`);
  lockStage(id); // lock BEFORE reading, so the manifest can't go stale under us
  return { dir, m: JSON.parse(fs.readFileSync(f, 'utf8')) };
}

// Exclusive per-stage lock for write/revise/apply/discard (atomic mkdir + owner pid). A lock whose
// owner process is dead (or that has no owner after 60s) is reclaimed. Released on process exit.
function lockStage(id) {
  const lockDir = path.join(STAGE_DIR, String(id), '.lock');
  const ownerFile = path.join(lockDir, 'pid');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile, String(process.pid));
      process.on('exit', () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} });
      return;
    } catch {
      let pid = 0, alive = false;
      try { pid = Number(fs.readFileSync(ownerFile, 'utf8')); } catch {}
      if (pid) { try { process.kill(pid, 0); alive = true; } catch {} }
      else { try { alive = Date.now() - fs.statSync(lockDir).mtimeMs < 60000; } catch {} }
      if (alive) C.die(`stage ${id} is busy (another gpt.js run${pid ? ' pid ' + pid : ''} is using it); wait for it to finish`);
      fs.rmSync(lockDir, { recursive: true, force: true }); // abandoned: reclaim and retry once
    }
  }
  C.die(`could not lock stage ${id}`);
}

function saveManifest(dir, m) { fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2)); }

// What changed in the staged work dir vs the round's starting point; diffs only (saves Claude tokens).
function stageReport(dir, m, startDir, workDir = path.join(dir, 'work')) {
  const lines = [];
  for (const e of m.entries) {
    const work = path.join(workDir, e.rel);
    const start = path.join(startDir, e.rel);
    if (!fs.existsSync(work)) { lines.push(`- ${e.target}: NOT WRITTEN by GPT`); continue; }
    if (L.fileHash(work) === L.fileHash(start)) { lines.push(`- ${e.target}: unchanged`); continue; }
    lines.push(`- ${e.target}  <=  staged: ${work}`);
    if (TEXT_DOC.test(e.rel)) {
      const d = spawnSync('git', ['diff', '--no-index', '--no-color', '-U2', fs.existsSync(start) ? start : (process.platform === 'win32' ? 'NUL' : '/dev/null'), work],
        { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).stdout || '';
      const dl = d.split('\n');
      const max = C.cfg.writeDiffMaxLines || 400;
      lines.push('```diff\n' + dl.slice(0, max).join('\n') + (dl.length > max ? `\n... (${dl.length - max} more diff lines — read the staged file)` : '') + '\n```');
    } else lines.push('  (binary document — open the staged file with your docx/pptx/xlsx tooling to review)');
  }
  const known = new Set(m.entries.map(e => path.normalize(e.rel)));
  const extra = [];
  (function walk(d, rel) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), r = rel ? path.join(rel, n) : n;
      if (fs.statSync(p).isDirectory()) walk(p, r); else if (!known.has(path.normalize(r))) extra.push(r);
    }
  })(workDir, '');
  if (extra.length) lines.push(`- Ignored extra files GPT created (never applied): ${extra.slice(0, 10).join(', ')}`);
  return lines.join('\n');
}

function writePrompt(m, extra) {
  return `You are a professional technical writer working for Claude, the coordinating AI and the ONLY author of code. Claude delegated this document work to you.\n\n` +
    `WRITE ONLY these files, relative to your current working directory (create them if they do not exist yet):\n` +
    m.entries.map(e => `- ${e.rel}   (real location: ${e.target}; ${e.origHash === 'absent' ? 'new file' : 'existing file'})`).join('\n') +
    `\n\nBRIEF FROM CLAUDE:\n${m.brief}\n${extra || ''}\n` +
    `PROJECT for facts (read-only for you): ${m.root}\nVerify every factual claim about the code or project against the actual source before writing it.\n\n` +
    `RULES:\n- Edit only the listed files; create no other files. Never write or modify code.\n` +
    `- Preserve existing content, structure and formatting unless the brief asks for changes.\n` +
    `- For .docx/.pptx/.xlsx/.odt use a proper library/tool so styles survive; do not convert formats.\n` +
    `- Do not send, publish or upload anything.\n\n` +
    `FINAL MESSAGE (Claude reads only this plus a diff):\nSTATUS: DONE | PARTIAL | BLOCKED\n- 3-8 bullets summarising the changes\n- Facts you could NOT verify\n- Questions for Claude`;
}

async function runWrite(dir, m, startDir, extraPrompt) {
  const cfg = C.cfg;
  const effort = C.effortFor();
  // GPT edits a scratch copy that becomes the staged version only when the run succeeds: a failed or
  // interrupted revision never leaves partial, unreviewed edits where `apply` would pick them up.
  const next = path.join(dir, 'next');
  const r = await X.ask({
    mode: m.round > 1 ? `write-r${m.round}` : 'write', prompt: writePrompt(m, extraPrompt), effort, sandbox: 'workspace-write',
    cwd: next, before: () => copyTree(startDir, next),
    meta: `- Stage: ${m.id}\n- Round: ${m.round}\n- Targets: ${m.entries.map(e => e.target).join(', ')}\n`,
  });
  m.logs = (m.logs || []).concat(r.log);
  // A revision that didn't happen (GPT failed, or a cooldown refused it) must not use up a round.
  if (!r.ok && m.round > 1) m.round -= 1;
  // Only a result GPT reports as finished (STATUS: DONE) is staged. PARTIAL, BLOCKED or a missing status
  // is shown but leaves the previous staged version in place, so `apply` never picks up an unfinished document.
  const status = r.ok ? ((String(r.text).match(/^\s*STATUS:\s*(DONE|PARTIAL|BLOCKED)\b/im) || [])[1] || 'NO STATUS').toUpperCase() : null;
  const unfinished = r.ok && status !== 'DONE';
  if (unfinished && m.round > 1) m.round -= 1;
  const attempt = unfinished ? stageReport(dir, m, startDir, next) : '';
  let publishError = null;
  if (r.ok && !unfinished) try { W.publishDir(next, path.join(dir, 'work')); } catch (e) { publishError = e; if (m.round > 1) m.round -= 1; }
  // (an unfinished attempt stays readable in `next` until the next run replaces it)
  if (!unfinished) try { fs.rmSync(next, { recursive: true, force: true }); } catch {}
  saveManifest(dir, m);
  if (publishError) { console.error(`Could not stage GPT's result (${publishError.message}); the previous staged version is unchanged. Retry the write/revise.`); process.exit(1); }
  if (!r.ok) { X.markUnavailable(r.reason); X.finish(r); }
  console.log(r.text);
  if (unfinished) {
    console.log(`\n---\nGPT reported ${status}: NOT staged — stage ${m.id} keeps its previous version (round ${m.round}/${cfg.maxRounds}).\nWhat it attempted (for your feedback):\n${attempt}\n`);
    console.log(`Next: gpt.js write --revise ${m.id} --brief-file <feedback.md>, or apply/discard the previous version.\n[gpt.js] log: ${r.log}  (${r.secs}s)`);
    process.exit(0);
  }
  console.log(`\n---\nSTAGE: ${m.id} (round ${m.round}/${cfg.maxRounds})\n${stageReport(dir, m, startDir)}\n`);
  console.log(`Next: review the changes, then either\n  gpt.js apply ${m.id}\n  gpt.js write --revise ${m.id} --brief-file <feedback.md>\n  gpt.js discard ${m.id}\n[gpt.js] log: ${r.log}  (${r.secs}s)`);
  process.exit(0);
}

async function write() {
  const { opts, cfg, root } = C;
  const briefText = opts.brief || (opts['brief-file'] && C.readArgFile(opts['brief-file']));
  if (!briefText) C.die('write needs --brief "<instructions>" or --brief-file <file>');
  if (opts.revise) {
    const { dir, m } = loadManifest(opts.revise);
    if (m.applied) C.die(`stage ${m.id} was already applied`);
    if (m.round >= cfg.maxRounds) {
      console.log(`MAX_ROUNDS_REACHED (${cfg.maxRounds}). Claude decides: apply as-is, apply then fix small issues yourself, or discard.`);
      process.exit(4);
    }
    m.round += 1;
    copyTree(path.join(dir, 'work'), path.join(dir, 'prev'));
    return runWrite(dir, m, path.join(dir, 'prev'), `\nROUND ${m.round}: you already edited these files (current state is in your working directory). Claude reviewed them. CLAUDE'S FEEDBACK — address every point:\n${briefText}\n`);
  }
  if (!opts.files) C.die('write needs --files "<doc1>,<doc2>"');
  const targets = String(opts.files).split(',').map(f => f.trim()).filter(Boolean).map(f => path.resolve(f));
  for (const t of targets) {
    const p = L.docTargetProblem(t, !!opts.data);
    if (p) C.die(`REFUSED: ${t} ${p}. Claude must handle this file itself.`);
  }
  const id = C.stamp() + '-' + Math.random().toString(36).slice(2, 6);
  const dir = path.join(STAGE_DIR, id);
  const used = new Set();
  const entries = targets.map((t, i) => {
    const inside = !path.relative(root, t).startsWith('..') && !path.isAbsolute(path.relative(root, t));
    let rel = inside ? path.relative(root, t) : path.join('_external', String(i), path.basename(t));
    if (used.has(rel.toLowerCase())) rel = path.join('_dup', String(i), path.basename(t));
    used.add(rel.toLowerCase());
    return { target: t, rel, origHash: L.fileHash(t) };
  });
  for (const e of entries) {
    if (e.origHash === 'absent') continue;
    fs.mkdirSync(path.dirname(path.join(dir, 'base', e.rel)), { recursive: true });
    fs.copyFileSync(e.target, path.join(dir, 'base', e.rel));
  }
  fs.mkdirSync(path.join(dir, 'base'), { recursive: true });
  lockStage(id);
  const m = { id, root, round: 1, effort: C.effortFor(), brief: briefText, entries, created: new Date().toISOString() };
  saveManifest(dir, m);
  return runWrite(dir, m, path.join(dir, 'base'));
}

function apply() {
  const { opts, positional } = C;
  const { dir, m } = loadManifest(positional[0] || C.die('usage: gpt.js apply <stage-id> [--force]'));
  if (m.applied) C.die(`stage ${m.id} was already applied`);
  const results = [];
  let conflicts = 0;
  for (const e of m.entries) {
    const problem = L.docTargetProblem(e.target, true); // re-check: never apply to code/config
    if (problem) { conflicts++; results.push(`REFUSED — ${e.target} ${problem}`); continue; }
    const work = path.join(dir, 'work', e.rel);
    if (!fs.existsSync(work)) { results.push(`skipped (not written): ${e.target}`); continue; }
    const staged = L.fileHash(work);
    // What the target should contain if nobody else touched it: what we applied last time, else the original.
    const expected = e.appliedHash || e.origHash;
    if (staged === expected && !e.appliedHash) { results.push(`unchanged: ${e.target}`); continue; }
    // Stage the copy next to the target first, then check the target as late as possible before the swap.
    fs.mkdirSync(path.dirname(e.target), { recursive: true });
    const tmp = `${e.target}.gpt-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    fs.copyFileSync(work, tmp, fs.constants.COPYFILE_EXCL);
    let current;
    try { current = L.fileHash(e.target); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
    if (current === staged) { fs.rmSync(tmp, { force: true }); e.appliedHash = staged; results.push(`already applied: ${e.target}`); continue; }
    if (current !== expected && !opts.force) {
      fs.rmSync(tmp, { force: true });
      conflicts++;
      results.push(`CONFLICT — ${e.target} changed since GPT started; not overwritten (re-run with --force to overwrite)`);
      continue;
    }
    try { fs.renameSync(tmp, e.target); }
    catch (err) { fs.rmSync(tmp, { force: true }); throw err; } // e.g. Word has the file open: no leftover copy
    e.appliedHash = staged; // a later revision (even back to the original) is compared against this
    saveManifest(dir, m);   // persist immediately: a later target may throw (e.g. a file locked by Word)
    results.push(`applied: ${e.target}`);
  }
  for (const log of m.logs || []) try { fs.appendFileSync(log, `- applied ${new Date().toLocaleString()}:\n${results.map(r => '  - ' + r).join('\n')}\n`); } catch {}
  console.log(results.join('\n'));
  if (conflicts) { saveManifest(dir, m); console.log(`\n${conflicts} conflict(s); stage kept at ${dir}`); process.exit(5); }
  m.applied = true;
  fs.rmSync(dir, { recursive: true, force: true });
}

function discard() {
  const { dir, m } = loadManifest(C.positional[0] || C.die('usage: gpt.js discard <stage-id>'));
  for (const log of m.logs || []) try { fs.appendFileSync(log, `- discarded by Claude ${new Date().toLocaleString()}\n`); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('discarded ' + m.id);
}

Object.assign(W, { STAGE_DIR, TEXT_DOC, copyTree, publishDir, loadManifest, lockStage, saveManifest, stageReport, writePrompt, runWrite, write, apply, discard });
