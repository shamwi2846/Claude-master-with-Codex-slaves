// Code review: frozen snapshots and exact diffs (review material), review rounds and follow-ups, which
// files GPT's findings point at, and recording the result (markReviewed). Also bug diagnosis (investigate).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../lib');
const C = require('./ctx');
const X = require('./codex');
const E = require('./evidence');
const P = require('./prompts');

const NULL_DEV = process.platform === 'win32' ? 'NUL' : '/dev/null';

function noIndexDiff(a, b) {
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U5', a, b], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  // Drop only the file header (everything before the first hunk); inside hunks a code line like
  // "-- count;" becomes "--- count;" and must be kept.
  const lines = (r.stdout || '').split('\n');
  const first = lines.findIndex(l => l.startsWith('@@'));
  // Exit 0 = identical, 1 = different (always with output). Anything else — git missing, or exit 1 with no
  // output ("Could not access" a file) — means no diff is known: null, so the caller has GPT read the whole
  // file instead of calling it "unchanged".
  if ((r.status !== 0 && r.status !== 1) || (r.status === 1 && !r.stdout)) return null;
  // Output without hunks (e.g. a UTF-16 script git treats as binary) is still a change: say so.
  if (first < 0) return r.status === 1 ? '(binary or non-text change — read the whole frozen file)' : '';
  return lines.slice(first).join('\n').trim();
}

// Freeze the reviewed versions (GPT reviews a consistent snapshot even if Claude keeps working) and
// build exact diffs: baseline (version before Claude's edits since the last review) -> frozen copy.
// `full`: a whole-file audit — no diff, GPT reads the frozen files completely (explicit --full, or a
// first-round review whose files are all unchanged, which otherwise would have nothing to look at).
// `noAutoFull`: follow-up rounds — unchanged files there are fine (GPT already read them).
// `bases`: follow-ups diff against the previous round's own frozen copies (see keepRound).
// A deleted file's last known content — its baseline, else its version in git revision `rev` — frozen next
// to the snapshots, so GPT can read what was removed. null = no previous version known.
function freezePrior(abs, i, snapDir, base, rev = 'HEAD') {
  const out = path.join(snapDir, `${i}_DELETED-PREVIOUS_${path.basename(abs)}`);
  try {
    if (base && base !== 'ABSENT' && fs.existsSync(base)) { fs.mkdirSync(snapDir, { recursive: true }); fs.copyFileSync(base, out); return out; }
    let anc = path.dirname(abs);
    while (!fs.existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
    const top = L.gitRoot(anc);
    if (!top) return null;
    const r = spawnSync('git', ['show', `${rev}:${path.relative(top, abs).replace(/\\/g, '/')}`], { cwd: top, maxBuffer: 50 * 1024 * 1024 });
    if (r.status !== 0) return null;
    fs.mkdirSync(snapDir, { recursive: true }); fs.writeFileSync(out, r.stdout); return out;
  } catch { return null; }
}
const frozenList = map => map.map(x => `- ${x.abs}${x.snap ? `\n    frozen copy: ${x.snap}`
  : x.prior ? `  (DELETED — its previous version, frozen: ${x.prior})`
  : '  (DELETED — no previous version known: REVIEW COVERAGE INCOMPLETE for this file; say so in your answer)'}`).join('\n');

function reviewMaterial(files, full, noAutoFull, bases) {
  const root = C.root;
  let changed = false;
  const snapDir = path.join(L.HOME, 'snap', C.stamp() + '-' + Math.random().toString(36).slice(2, 6));
  const map = [], parts = [];
  const stateNow = L.readState(root);
  // Commits created during this turn, found now (not only by Stop), so a review run before Stop still
  // diffs them against the turn-start revision instead of HEAD.
  const committedNow = new Set(stateNow.turnStartedAt
    ? L.gitCommittedSince(root, stateNow.turnHead, stateNow.turnStartedAt).map(d => d.abs.toLowerCase()) : []);
  // The git revision a file's change is measured from: HEAD, or — committed during a turn — the revision
  // that turn started from (HEAD already contains the change). rev null = committed with no earlier
  // revision known (the whole file must be read).
  const baseRev = abs => {
    const entry = stateNow.changes && Object.entries(stateNow.changes).find(([k]) => k.toLowerCase() === abs.toLowerCase());
    const storedCommit = entry && entry[1].committed && entry[1].at > L.reviewedAtFor(stateNow, entry[1]);
    if (!storedCommit && !committedNow.has(abs.toLowerCase())) return 'HEAD';
    // A stored pending commit keeps its own base; only commits found in the current turn use this turn's start.
    return (storedCommit ? entry[1].sinceRev : stateNow.turnHead) || null;
  };
  if (full) {
    for (const [i, f] of files.entries()) {
      const abs = path.resolve(f);
      const snap = fs.existsSync(abs) ? path.join(snapDir, `${i}_${path.basename(abs)}`) : null;
      if (snap) { fs.mkdirSync(snapDir, { recursive: true }); fs.copyFileSync(abs, snap); }
      map.push({ abs, snap, prior: snap ? null : freezePrior(abs, i, snapDir, L.baselineOf(root, abs), baseRev(abs) || 'HEAD') });
    }
    return { snapDir, map, full: true, text: `\nFILES TO AUDIT IN FULL — read the FROZEN copies completely (there is no diff; this is a whole-file audit):\n${frozenList(map)}\n` };
  }
  const mustRead = new Set(); // files whose change can't be shown as a diff: GPT reads them whole
  files.forEach((f, i) => {
    const abs = path.resolve(f);
    const exists = fs.existsSync(abs);
    const snap = exists ? path.join(snapDir, `${i}_${path.basename(abs)}`) : null;
    if (exists) { fs.mkdirSync(snapDir, { recursive: true }); fs.copyFileSync(abs, snap); }
    map.push({ abs, snap });
    const base = bases && bases.has(abs.toLowerCase()) ? bases.get(abs.toLowerCase()) : L.baselineOf(root, abs);
    // Git repo of the nearest folder that still exists (the file's own folder may have been deleted).
    let anc = path.dirname(abs);
    while (!fs.existsSync(anc) && path.dirname(anc) !== anc) anc = path.dirname(anc);
    const gitTop = base ? null : L.gitRoot(anc);
    let diff = '', rev = 'HEAD';
    if (base) diff = noIndexDiff(base === 'ABSENT' ? NULL_DEV : base, snap || NULL_DEV);
    else if (gitTop) {
      // No baseline: diff git's committed version against the FROZEN copy (never the live file).
      // Repo-relative path from the repo top, so files in deleted folders still resolve.
      const rel = path.relative(gitTop, abs).replace(/\\/g, '/');
      rev = baseRev(abs);
      if (!rev) { mustRead.add(abs); rev = 'HEAD'; }
      const head = spawnSync('git', ['show', `${rev}:${rel}`], { cwd: gitTop, maxBuffer: 50 * 1024 * 1024 });
      let headFile = NULL_DEV;
      if (head.status === 0) { fs.mkdirSync(snapDir, { recursive: true }); headFile = path.join(snapDir, `${i}_BASE_${path.basename(abs)}`); fs.writeFileSync(headFile, head.stdout); }
      diff = noIndexDiff(headFile, snap || NULL_DEV);
    }
    const noDiff = diff === null; // the diff itself failed: never report "unchanged"
    // No diff against its last reviewed version, yet a pending change: the file was put back to that version
    // over different content (e.g. the owner's newer edits) that is no longer available. Never "unchanged".
    const rec = !diff && !noDiff && !noAutoFull && stateNow.changes && Object.entries(stateNow.changes).find(([k]) => k.toLowerCase() === abs.toLowerCase());
    const revertedOver = !!rec && rec[1].at > L.reviewedAtFor(stateNow, rec[1]);
    if (diff || noDiff || revertedOver || !(base || gitTop) || mustRead.has(abs)) changed = true; // something to read
    // A deleted file has no frozen copy: its previous version is frozen instead (or coverage is incomplete).
    if (!exists) map[map.length - 1].prior = freezePrior(abs, i, snapDir, base, rev);
    // A file that must be read whole wins over any partial diff (e.g. a HEAD diff after an initial commit).
    parts.push(noDiff ? (exists ? `### ${abs}: the diff could not be computed — read the whole frozen file`
      : `### ${abs} (DELETED): the diff could not be computed — review the removal using its previous version (listed above)`)
      : revertedOver ? `### ${abs}: CHANGED BACK to its last reviewed version, replacing different content that is no longer available (e.g. the owner's newer edits) — read the whole frozen file and say whether putting this version back is right`
      : mustRead.has(abs) ? `### ${abs}: changed and committed during this turn (no diff base) — read the whole frozen file`
      : diff ? `### ${abs}${exists ? '' : ' (DELETED)'}\n${diff}`
      : base || gitTop ? `### ${abs}: unchanged since the last review — no need to re-read it`
      : `### ${abs}: no baseline — read the whole frozen file`);
  });
  if (!changed && !noAutoFull) { try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {} return reviewMaterial(files, true); }
  let diffText = parts.join('\n\n');
  if (diffText.length > 150000) diffText = '(Diff too large to inline — read the frozen files listed above.)';
  const list = frozenList(map);
  return {
    snapDir, map,
    text: `\nCHANGED FILES — review the FROZEN copies (the live files may still change while you work):\n${list}\n\n` +
      `DIFF (baseline before Claude's edits -> frozen version):\n\`\`\`diff\n${diffText}\n\`\`\`\n`,
  };
}

// Each review round keeps its frozen copies next to its log (pruned with the logs), so a follow-up diffs
// against exactly what GPT saw last round — even if another review has moved the file's baseline since.
function keepRound(log, map) {
  if (!log) return;
  try {
    const dir = log.replace(/\.md$/, '.frozen');
    fs.mkdirSync(dir, { recursive: true });
    const index = {};
    map.forEach((x, i) => {
      if (!x.snap) index[x.abs.toLowerCase()] = null; // deleted when frozen
      else if (fs.existsSync(x.snap)) { const n = `${i}_${path.basename(x.abs)}`; fs.copyFileSync(x.snap, path.join(dir, n)); index[x.abs.toLowerCase()] = n; }
    });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  } catch {}
}
// The previous round's frozen copies: lower-case path -> copy (or 'ABSENT'); null when not kept.
function roundBases(log) {
  try {
    const dir = log.replace(/\.md$/, '.frozen');
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    return new Map(Object.entries(index).map(([k, n]) => [k, n === null ? 'ABSENT' : path.join(dir, n)])
      .filter(([, p]) => p === 'ABSENT' || fs.existsSync(p)));
  } catch { return null; }
}

// Announce a running review (pid, frozen files, cutoff) so the Stop hook doesn't nag Claude while this
// review already covers exactly those change versions. Removed when gpt.js exits (success or failure).
// `sig` identifies the request (task, focus, evidence, files): an identical request while one is still
// running — same files, nothing edited since it froze them — is refused instead of paying for it twice.
function registerRunning(files, cutoff, sig, snaps) {
  const root = C.root;
  const key = String(process.pid);
  const lower = files.map(f => path.resolve(f).toLowerCase()).sort();
  // Content hashes of the FROZEN copies (not the live files, which may change right after freezing):
  // a duplicate means the same reviewed content, however it was edited. Deleted files hash as 'absent'.
  const snapOf = new Map((snaps || []).map(x => [path.resolve(x.abs).toLowerCase(), x.snap]));
  const hashes = lower.map(f => { const s = snapOf.get(f); try { return s ? L.fileHash(s) : 'absent'; } catch { return 'unreadable'; } });
  const dup = L.updateState(root, s => {
    const live = Object.values(s.running || {}).find(r => {
      try { process.kill(r.pid, 0); } catch { return false; }
      return r.sig === sig && JSON.stringify(r.files) === JSON.stringify(lower) && JSON.stringify(r.hashes) === JSON.stringify(hashes);
    });
    if (live) return live;
    s.running = s.running || {};
    s.running[key] = { pid: process.pid, cutoff, files: lower, sig, hashes };
  });
  if (dup) { console.log(`DUPLICATE: an identical review of these files is already running (pid ${dup.pid}); wait for its result instead.`); process.exit(6); }
  process.on('exit', () => { try { L.updateState(root, s => { if (s.running) delete s.running[key]; }); } catch {} });
}

// File paths in one "Location:" line. Paths may contain spaces (e.g. "C:\...\T3 MQL5\x.mq5:12"), may be
// wrapped in backticks/quotes/markdown links, and several may be separated by ", " or "; ".
function locationPaths(line) {
  const out = [];
  let rest = String(line);
  // markdown links [label](target:line) — take the target
  rest = rest.replace(/\[[^\]]*\]\(<?([^)>]+?)>?\)/g, (m, t) => { out.push(t); return ' '; });
  // quoted / backticked chunks
  rest = rest.replace(/[`"']([^`"']+)[`"']/g, (m, t) => { out.push(t); return ' '; });
  for (const part of rest.split(/\s*[,;]\s+|\s+and\s+/)) if (part.trim()) out.push(part.trim());
  return out.map(x => (x.match(/^(.*?\S):\d+(?:[-–]\d+)?(?::\d+)?\)?\s*$/) || [])[1]).filter(Boolean).map(x => x.trim());
}

// Which files do the findings point at? Returns a Set of lowercase paths, or null when any finding's
// location can't be mapped confidently (then every reviewed file stays open — the safe default).
function findingFiles(text, mat, files) {
  // Open items: new findings (### headers) and follow-up lines marked MAINTAIN or OPEN (carried forward).
  const blocks = text.split(/\n(?=###\s|\d+\.\s+(?:MAINTAIN|OPEN)\b)/).filter(b => /^(###\s|\d+\.\s+(?:MAINTAIN|OPEN)\b)/.test(b.trim()));
  if (!blocks.length) return null;
  const bySnap = new Map(mat.map.filter(x => x.snap).map(x => [path.resolve(x.snap).toLowerCase(), x.abs]));
  const inFiles = new Map(files.map(f => [path.resolve(f).toLowerCase(), path.resolve(f)]));
  const byBase = {};
  for (const f of files) (byBase[path.basename(f).toLowerCase()] = byBase[path.basename(f).toLowerCase()] || []).push(path.resolve(f));
  const out = new Set();
  for (const b of blocks) {
    // Every path:line reference on every Location line (a finding may span several files).
    const lines = [...b.matchAll(/Location:([^\n]*)/gi)].map(m => m[1]);
    const locs = lines.flatMap(locationPaths);
    if (!locs.length) return null;
    for (const p of locs) {
      // absolute path, or relative to the project root (src/a/utils.js), before falling back to basenames
      const res = (path.isAbsolute(p) ? path.resolve(p) : path.resolve(C.root, p)).toLowerCase();
      let abs = bySnap.get(res) || inFiles.get(res);
      if (!abs) { const c = byBase[path.basename(p).toLowerCase().replace(/^\d+_/, '')]; if (c && c.length === 1) abs = c[0]; }
      if (!abs) return null;
      out.add(abs.toLowerCase());
    }
  }
  return out;
}

// Bug diagnosis. GPT gets what Claude already knows (symptom, expected vs actual, attempted fixes,
// Claude's uncommitted changes as a frozen diff, captured output) so it doesn't redo that exploration.
async function investigate(targets) {
  const { opts } = C;
  const pendingFiles = L.pending(L.readState(C.root)).map(([f]) => f);
  const mat = pendingFiles.length ? reviewMaterial(pendingFiles, false, true) : null;
  const prompt = `You are diagnosing a bug for Claude (another AI, the only one who writes code), so Claude can skip the exploration. ${P.READONLY_NOTE}\n\n` +
    `SYMPTOM / QUESTION:\n${opts.question}\n` +
    (opts.expected ? `\nEXPECTED: ${opts.expected}\n` : '') + (opts.actual ? `ACTUAL: ${opts.actual}\n` : '') +
    (opts.tried ? `\nALREADY TRIED (did not fix it): ${opts.tried}\n` : '') +
    `\nLOOK AT:\n${targets.map(t => '- ' + t).join('\n')}\n` +
    (mat ? `\nCLAUDE'S RECENT UNCOMMITTED CHANGES (possible cause):${mat.text}` : '') + (await E.evidence()) + P.lessonsBlock() +
    `\nRULES: search first, read only the relevant regions, at most about 10 short read-only commands. Do NOT run tests, builds or scripts and do not build reproductions — recommend checks in words instead. Mark each evidence item [code] (inferred from reading) or [runtime] (seen in logs/output).\n\n` +
    `Answer compactly (under ${opts.max || 350} words):\nDIAGNOSIS: the supported cause, or "UNRESOLVED" plus the competing hypotheses ranked\nEVIDENCE: up to 8 bullets "path:line [code|runtime] — short quote/value"\n` +
    `NEXT CHECK: the single check that best confirms or rules out the diagnosis\nFIX IDEA: in words (Claude writes the code)\nCONFIDENCE: high | medium | low`;
  const r = await X.ask({ mode: 'investigate', prompt, effort: C.effortFor(), sandbox: 'read-only' });
  if (mat) try { fs.rmSync(mat.snapDir, { recursive: true, force: true }); } catch {}
  if (!r.ok) X.markUnavailable(r.reason);
  return X.finish(r);
}

// One '- Name: value' metadata line from a log. Splits on '\n' only, so values may contain characters
// that JS regex '.' treats as line ends (e.g. U+2028 in a file name).
function metaField(text, name) {
  const line = String(text).split('\n').find(l => l.startsWith(`- ${name}: `));
  return line ? line.slice(name.length + 4).replace(/\r$/, '') : undefined;
}

// A review chain, newest first: the given round's log and the logs it follows (its "- Follows:" line).
function chainLogs(log, max = 10) {
  const out = [];
  for (let l = log; l && out.length < max;) {
    out.push(l);
    try { l = metaField(fs.readFileSync(l, 'utf8'), 'Follows'); } catch { l = null; }
  }
  return out;
}

// The original requirements of a review chain: they travel with every round (needed if a round has to start
// a fresh session). Older round logs may lack Task/Focus: taken from the nearest earlier round that has them.
function followupContext(chain) {
  let task = '', focus = '';
  for (const l of chain.slice(0, 5)) {
    let t = ''; try { t = fs.readFileSync(l, 'utf8'); } catch { break; }
    task = metaField(t, 'Task') || '';
    focus = focus || (metaField(t, 'Focus') || (t.match(/^FOCUS AREAS: ([^\n]*)$/m) || [])[1]) || ''; // older logs: prompt line
    if (task) break;
  }
  return { task, focus };
}

// GPT's answers in a review chain, oldest first (round 1 holds the full finding details; later rounds hold
// their status), read from the stored answer files.
function roundHistory(chain) {
  return chain.slice(0, 5).map(l => {
    try { return fs.readFileSync(l.replace(/\.md$/, '.answer.md'), 'utf8').trim(); } catch {}
    // Older logs: the answer section starts at the LAST line that is exactly "## GPT answer"
    // (a quote of it inside a finding is never a whole line on its own).
    let lines = []; try { lines = fs.readFileSync(l, 'utf8').split(/\r?\n/); } catch {}
    const at = lines.map(x => x.trim()).lastIndexOf('## GPT answer');
    const end = lines.findIndex((x, i) => i > at && x.trim() === "## Claude's decisions");
    return (at < 0 ? '' : lines.slice(at + 1, end < 0 ? undefined : end).join('\n')).trim();
  }).reverse();
}

// A follow-up round (`review --followup <log> --file <response>`): GPT re-checks its open findings against
// Claude's response and the diff since its last round — resuming its own session when possible.
async function reviewFollowup(effort, deletedAtStart) {
  const { opts, cfg } = C;
  const prevLog = path.resolve(opts.followup);
  const prev = fs.readFileSync(prevLog, 'utf8');
  const round = (Number((prev.match(/- Round: (\d+)/) || [])[1]) || 1) + 1;
  if (round > cfg.maxRounds) {
    console.log(`MAX_ROUNDS_REACHED (${cfg.maxRounds}). Claude makes the final decision now: gpt.js mark-reviewed --by claude-final --files "..." --note "..."`);
    process.exit(4);
  }
  if (!opts.file) C.die('--followup needs --file <your response to each finding>');
  const response = C.readArgFile(opts.file);
  const scopeLine = metaField(prev, 'Scope') || 'ALL';
  const scope = scopeLine === 'ALL' ? null : JSON.parse(scopeLine);
  const files = JSON.parse(metaField(prev, 'Files') || 'null') || scope || L.pending(L.readState(C.root)).map(([f]) => f);
  const cutoff = Date.now(); // edits after this moment (during evidence collection or the run) stay pending
  const mat = reviewMaterial(files, false, true, roundBases(prevLog));
  registerRunning(files, cutoff, X.sigOf('followup', prevLog, response, opts.evidence || '', opts['evidence-file'] || ''), mat.map);
  const tail = `${mat.text}${await E.evidence()}\n${P.EFFORT_RULES}\nFOLLOW-UP SCOPE: re-check ONLY (a) the findings Claude's response disputes or claims fixed and (b) behaviour affected by the new diff. The diff above shows exactly what changed since your last review: start there and read only the specific lines you need — do not re-read whole files. Do not re-verify findings already RESOLVED/CONCEDED earlier unless the new diff touches them. If you maintain a finding, give stronger concrete evidence (exact trigger -> wrong result). Concede when Claude is right.\n\n` +
    `Format (compact):\nVERDICT: RESOLVED | ISSUES_REMAIN — RESOLVED only if EVERY earlier finding is now resolved or conceded; a finding Claude's response does not address is still open (carry it forward without re-verifying it).\n` +
    `One line per earlier finding: "<n>. CONCEDE | RESOLVED | MAINTAIN | OPEN — <one-sentence reason>" (OPEN = not addressed by Claude). For every MAINTAIN and OPEN line add "- Location: file:line". Then NEW confirmed defects only:\n${P.FINDING_FORMAT}No preamble, no links.`;
  // The whole chain: its open findings are what this round re-checks (and may clear).
  const chain = chainLogs(prevLog);
  const { task: taskLine, focus: focusLine } = followupContext(chain);
  const meta = `- Round: ${round}\n- Follows: ${prevLog}\n- Task: ${taskLine}\n${focusLine ? `- Focus: ${focusLine}\n` : ''}- Scope: ${scopeLine}\n- Files: ${JSON.stringify(files)}\n`;
  const dropSnap = () => { try { fs.rmSync(mat.snapDir, { recursive: true, force: true }); } catch {} };
  // markReviewed copies the frozen files into the new baselines, so the snapshot is removed after it.
  // Acknowledge exactly the files that were frozen and shown to GPT — nothing else.
  const done = r => { if (!r.ok) dropSnap(); return X.finish(r, () => { markReviewed('gpt', cutoff, files, deletedAtStart, { verdict: r.verdict, log: r.log, snaps: mat.map, findingFiles: findingFiles(r.text, mat, files), resolves: chain }); keepRound(r.log, mat.map); dropSnap(); }); };
  // Fast path: resume GPT's own session from the previous round (it still has the code in context).
  const sid = (prev.match(/^- Session: (\S+)$/m) || [])[1];
  if (sid && !opts.fresh) {
    const r = await X.ask({ mode: `review-r${round}`, prompt: `Round ${round} of ${cfg.maxRounds} of our review discussion. ${P.READONLY_NOTE}\n\nCLAUDE'S RESPONSE (fixes made / findings disputed, with reasoning):\n${response}\n${tail}`, effort, sandbox: 'read-only', resume: sid, noRetry: true, meta });
    if (r.ok || !X.retryable(r)) return done(r);
    console.error(`[gpt.js] resuming session failed (${r.reason}); running a fresh round instead...`);
  }
  // Fresh session: give it the original task and EVERY earlier round's answer.
  const prevAnswer = roundHistory(chain).map((h, i) => `--- Round ${i + 1} ---\n${h}`).join('\n\n');
  const r = await X.ask({ mode: `review-r${round}`, prompt: `${P.ROLE}\n${P.READONLY_NOTE}\n\nThis is round ${round} of ${cfg.maxRounds} of a review discussion.\n` +
    (taskLine ? `\nORIGINAL TASK / REQUIREMENTS:\n${taskLine}\n` : '') + (focusLine ? `FOCUS: ${focusLine}\n` : '') +
    `\nYOUR EARLIER REVIEW ROUNDS:\n${prevAnswer}\n\nCLAUDE'S RESPONSE (fixes made / findings disputed, with reasoning):\n${response}\n${tail}`, effort, sandbox: 'read-only', persist: true, meta });
  return done(r);
}

async function review() {
  const { opts } = C;
  const root = C.root;
  const effort = C.effortFor();
  const deletedAtStart = L.gitDeleted(root);
  if (opts.followup) return reviewFollowup(effort, deletedAtStart);
  if (!opts.task) C.die('review needs --task "<what the change is supposed to accomplish>"');
  const s = L.readState(root);
  // --files limits the review AND what it clears; without it, all pending changes are covered.
  const scope = opts.files ? String(opts.files).split(',').map(f => path.resolve(f.trim())).filter(Boolean) : null;
  const files = scope || L.pending(s).map(([f]) => f);
  if (!files.length) {
    const cand = (L.gitStatus(root) || []).filter(e => L.isCode(e.abs)).map(e => e.abs);
    C.die((s._unreadable ? `Change tracking is unavailable (${L.statePath(root)} is unreadable: ${s._unreadable}), so pending changes are unknown.`
      : 'Nothing tracked to review (no pending changes).') + ` Pass the files explicitly with --files "a,b"` + (cand.length ? `. Changed code files in git: ${cand.slice(0, 20).join(', ')}` : '.'));
  }
  const cutoff = Date.now(); // edits after this moment (during evidence collection or the run) stay pending
  const mat = reviewMaterial(files, !!opts.full);
  registerRunning(files, cutoff, X.sigOf('review', mat.full ? 'full' : 'diff', opts.task, opts.focus || '', opts.evidence || '', opts['evidence-file'] || ''), mat.map);
  const prompt = `${P.ROLE}\nYour job: an independent, rigorous code review. ${P.READONLY_NOTE}\n\nWHAT THE CHANGE IS MEANT TO ACCOMPLISH:\n${opts.task}\n` +
    (opts.focus ? `\nFOCUS AREAS: ${opts.focus}\n` : '') +
    mat.text + (await E.evidence()) + P.lessonsBlock() + P.mql5Block(files) +
    `\nStart from the DIFF. Read surrounding code in the project (callers, callees, definitions) only as needed to verify behaviour; read whole files only when the diff is not enough.\n` +
    `Look for: correctness bugs, unhandled edge cases, error handling, wrong assumptions about APIs, security issues, concurrency/race issues, data loss, resource leaks, and for trading code order/position/lot/stop-loss/risk logic. Also flag a design decision that is clearly wrong or will be hard to undo. Ignore pure style/formatting.\n\n` +
    `${P.EFFORT_RULES}BEFORE REPORTING: confirm every candidate finding (re-read the code path, check callers, trace the failing input). Drop anything you could not confirm — Claude must re-verify each finding, so false positives are costly.\n\n` +
    `Format (compact — Claude's reading budget is limited):\nVERDICT: NO_ISSUES | ISSUES_FOUND\nThen, most severe first, max 10 CONFIRMED findings, each at most 5 lines:\n${P.FINDING_FORMAT}` +
    `No preamble, no praise, no summary of what you checked, no links.`;
  const r = await X.ask({ mode: 'review', prompt, effort, sandbox: 'read-only', persist: true, meta: `- Round: 1\n- Task: ${String(opts.task).replace(/\s+/g, ' ')}\n${opts.focus ? `- Focus: ${String(opts.focus).replace(/\s+/g, ' ')}\n` : ''}- Scope: ${scope ? JSON.stringify(scope) : 'ALL'}\n- Files: ${JSON.stringify(files)}\n` });
  const dropSnap = () => { try { fs.rmSync(mat.snapDir, { recursive: true, force: true }); } catch {} };
  if (!r.ok) { X.markUnavailable(r.reason); dropSnap(); }
  // Acknowledge exactly the files that were frozen and shown to GPT — nothing else.
  return X.finish(r, () => { markReviewed('gpt', cutoff, files, deletedAtStart, { verdict: r.verdict, log: r.log, snaps: mat.map, findingFiles: findingFiles(r.text, mat, files) }); keepRound(r.log, mat.map); dropSnap(); });
}

// `scope` (array of paths) = only those files were reviewed; null = everything pending was reviewed.
// Entries are kept (with reviewedAt) so a deleted file isn't re-detected as new; old ones are pruned.
// `deletedAtStart`: files git reported deleted when the review STARTED. Only those deletions count as
// reviewed; anything deleted later stays a fresh change for the Stop hook.
// `info`: { verdict, log, snaps } from a GPT review. Review status per file:
//   clean (NO_ISSUES/RESOLVED) | findings (ISSUES_FOUND/ISSUES_REMAIN: open until fixed+re-reviewed or
//   accepted) | accepted (claude-final) | fallback (claude-fallback) | declined (user-declined).
function markReviewed(by, at, scope, deletedAtStart, info = {}) {
  const root = C.root;
  const startDel = new Set((deletedAtStart || []).map(f => path.resolve(f).toLowerCase()));
  const status = by === 'gpt' ? (/^(ISSUES_FOUND|ISSUES_REMAIN)$/.test(info.verdict || '') ? 'findings' : 'clean')
    : ({ 'claude-final': 'accepted', 'claude-fallback': 'fallback', 'user-declined': 'declined' }[by] || by);
  // New baselines = the versions just reviewed (frozen copies), or for manual acknowledgements the
  // current files, so the next review diff shows only work done after this point.
  const snapOf = new Map((info.snaps || []).map(x => [x.abs.toLowerCase(), x.snap]));
  const resolves = new Set((info.resolves || []).map(l => path.resolve(l).toLowerCase())); // logs a follow-up re-checked
  const acked = []; // { abs, snap (copy of the acknowledged content; null = absent), hash, status }: shared with other projects
  L.updateState(root, s => {
    const inScope = scope ? new Set(scope.map(f => path.resolve(f).toLowerCase())) : null;
    const pendingBefore = new Set(L.pending(s).map(([f]) => f.toLowerCase())); // (before the project-wide time moves)
    if (!inScope) s.reviewedAt = at;
    const covered = f => !inScope || inScope.has(f.toLowerCase());
    const byLower = new Map(Object.keys(s.changes).map(f => [f.toLowerCase(), f]));
    // Files reviewed but not yet tracked (changed via Bash, or deleted) get an entry now, so a later
    // Stop disk scan recognises them as already reviewed instead of asking again.
    for (const f of scope || []) {
      const abs = path.resolve(f);
      if (!byLower.has(abs.toLowerCase())) s.changes[abs] = { lines: 0, sensitive: false, at: 0, reviewedAt: at, deleted: startDel.has(abs.toLowerCase()) };
    }
    for (const f of deletedAtStart || []) {
      if (!covered(f)) continue;
      const known = byLower.get(f.toLowerCase());
      if (known) { if (s.changes[known].at <= at) s.changes[known].deleted = true; }
      else s.changes[f] = { lines: 0, sensitive: true, at: 0, reviewedAt: at, deleted: true };
    }
    for (const [f, c] of Object.entries(s.changes)) {
      if (!inScope || inScope.has(f.toLowerCase())) {
        const wasPending = pendingBefore.has(f.toLowerCase());
        c.reviewedAt = Math.max(c.reviewedAt || 0, at);
        // Findings are about what GPT saw, so they are recorded even if the file was edited again after
        // it was frozen (that newer version simply stays pending).
        // Findings stay open only on files the still-open items point at. Follow-ups carry every unresolved
        // earlier finding forward (MAINTAIN/OPEN lines with locations), so this list is complete; when the
        // mapping is unsure, findingFiles is null and every reviewed file stays open.
        const hit = status === 'findings' && (!info.findingFiles || info.findingFiles.has(f.toLowerCase()));
        // Earlier open findings (one log per review chain) are cleared only by what re-checked them: a
        // follow-up of their own chain, or an explicit decision (mark-reviewed). A fresh or concurrent
        // review never saw them, so they stay open.
        let open = by === 'gpt' ? [].concat(c.openFindings || []).filter(l => !resolves.has(path.resolve(l).toLowerCase())) : [];
        if (hit) open = [...new Set(open.concat(info.log))];
        c.reviewStatus = open.length ? 'findings' : status === 'findings' ? 'clean' : status;
        if (open.length) c.openFindings = open; else delete c.openFindings;
        delete c.openFindingsAt;
        // The reviewed version becomes the baseline, so the next diff shows only work after it — also when
        // the file was edited again after it was frozen (that newer version stays pending against it), but
        // never replacing a baseline that a later-frozen review already set.
        if ((c.baseAt || 0) <= at) try {
          const k = f.toLowerCase(), snap = snapOf.get(k);
          // A file that was deleted when frozen (snap = null) gets an "absent" baseline; a snapshot that
          // has vanished (cleaned up) keeps the previous baseline instead of recording a false "absent".
          // The reviewed version's existence is the truth now (a restored file is no longer "deleted").
          if (c.at <= at && snapOf.has(k)) c.deleted = snap === null;
          if (snapOf.has(k) && (snap === null || fs.existsSync(snap))) {
            L.setBaseline(root, f, snap); c.baseAt = at;
            if (c.at > at) c.basePre = true; // the reviewed copy predates the pending newer edits
          } else if (by !== 'gpt' && c.at <= at) { c.deleted = !fs.existsSync(f); L.setBaseline(root, f, f); c.baseAt = at; } // manual ack: current file is the truth
        } catch {}
        // What was acknowledged without open findings — the frozen copy GPT read, or (manual) the copy just
        // saved as the baseline — hashed now, under the lock, for other projects (L.shareReceipt).
        const k = f.toLowerCase();
        if (!open.length && c.reviewStatus !== 'findings' && (inScope || wasPending)) try {
          const copy = by === 'gpt' ? (snapOf.has(k) ? snapOf.get(k) : undefined) : c.baseAt === at ? L.baselineOf(root, f) : undefined;
          if (copy === null || copy === 'ABSENT') acked.push({ abs: f, snap: null, status: c.reviewStatus, hash: 'absent' });
          else if (copy && fs.existsSync(copy)) acked.push({ abs: f, snap: copy, status: c.reviewStatus, hash: L.fileHash(copy) });
        } catch {}
      }
      const rev = L.reviewedAtFor(s, c);
      if (!c.openFindings && rev >= c.at && rev < Date.now() - 2 * 86400000) delete s.changes[f]; // reviewed long ago, nothing open: prune
    }
    s.reviewedBy = by;
    s.lastReview = { status, by, verdict: info.verdict || null, log: info.log || null, at };
    if (by === 'gpt') delete s.gptUnavailableAt;
  });
  // Other projects tracking the same files with exactly this content get the same acknowledgement.
  try { if (acked.length) L.shareReceipt(root, acked, at); } catch {}
}

// Scoring rounds (goal loops): GPT rates the project against Claude's rubric — it applies the rubric and
// does not critique it. With --files those files are frozen and reviewed as in `review` (same coverage and
// finding format) and the result is recorded like a review: no findings = clean; findings stay open on the
// files they point at; open findings of other reviews stay open.
async function score() {
  const { opts } = C;
  if (!opts.file) C.die('score needs --file <rubric.md|->');
  const rubric = C.readArgFile(opts.file);
  const effort = C.effortFor();
  const files = opts.files ? String(opts.files).split(',').map(f => path.resolve(f.trim())).filter(Boolean) : [];
  const deletedAtStart = files.length ? L.gitDeleted(C.root) : [];
  const cutoff = Date.now();
  const mat = files.length ? reviewMaterial(files, !!opts.full) : null;
  if (mat) registerRunning(files, cutoff, X.sigOf('score', mat.full ? 'full' : 'diff', rubric, opts.evidence || '', opts['evidence-file'] || ''), mat.map);
  const prompt = `${P.ROLE}\nYour job: SCORE this project against the rubric below. Apply the rubric as written — do not critique, rewrite or extend it. ${P.READONLY_NOTE}\n\nRUBRIC FROM CLAUDE:\n${rubric}\n` +
    (mat ? `\nALSO REVIEW these files as an independent, rigorous code reviewer (correctness, edge cases, error handling, security, concurrency, data loss, trading order/position/lot/stop-loss/risk logic); each confirmed defect lowers the score of its area.${mat.text}` : '') +
    (await E.evidence()) + P.lessonsBlock() + (mat ? P.mql5Block(files) : '') +
    `\n${P.EFFORT_RULES}\nFormat (compact):\nVERDICT: ALL_10 | BELOW_10 — ALL_10 only if every area scores 10${mat ? ' and you found no defect in the reviewed files' : ''}.\n` +
    `Then one line per area: "<area>: <score>/10 — <what keeps it below 10, or: nothing worth its cost>".\n` +
    (mat ? `Then the confirmed defects, most severe first (max 10, each at most 5 lines):\n${P.FINDING_FORMAT}` : '') + `No preamble, no praise.`;
  const r = await X.ask({ mode: 'score', prompt, effort, sandbox: 'read-only', persist: true,
    meta: mat ? `- Round: 1\n- Task: score against the rubric (${opts.file}) and review the files\n- Scope: ${JSON.stringify(files)}\n- Files: ${JSON.stringify(files)}\n` : '' });
  const dropSnap = () => { if (mat) try { fs.rmSync(mat.snapDir, { recursive: true, force: true }); } catch {} };
  if (!r.ok) { X.markUnavailable(r.reason); dropSnap(); }
  return X.finish(r, () => {
    if (!mat) return;
    const found = /^###\s*\[(CRITICAL|HIGH|MEDIUM|LOW)\]/im.test(r.text);
    markReviewed('gpt', cutoff, files, deletedAtStart, { verdict: found ? 'ISSUES_FOUND' : 'NO_ISSUES', log: r.log, snaps: mat.map, findingFiles: found ? findingFiles(r.text, mat, files) : new Set() });
    keepRound(r.log, mat.map); dropSnap();
  });
}

module.exports = {
  NULL_DEV, noIndexDiff, freezePrior, frozenList, reviewMaterial, keepRound, roundBases, registerRunning,
  locationPaths, findingFiles, investigate, metaField, chainLogs, followupContext, roundHistory, reviewFollowup, review, markReviewed, score,
};
