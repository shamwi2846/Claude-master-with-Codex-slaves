// Claude Code hook handler. Usage: node gate.js <post-edit|stop|pre-plan|pre-computer|prompt>
// Must never crash or hang Claude: every path exits 0, and errors fail open.
// The project root for hooks is exactly the session cwd (gpt.js resolves to the same tracked root).
const path = require('path');
const L = require('./lib');

// Derived from this file's location, so a restored copy works under any user folder.
const GPT = `node "${path.join(__dirname, 'gpt.js').replace(/\\/g, '/')}"`;

function readInput() {
  try { return JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}
// Every exit records how long the hook took (`gpt.js stats` shows it).
const EVENT = process.argv[2], T0 = Date.now();
function out(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  L.hookTime(EVENT, Date.now() - T0);
  process.exit(0);
}
// A failure a hook survives (it fails open) still leaves a trace for `gpt.js doctor`.
function survived(where, e) { L.hookIssue(`${EVENT}: ${where}`, (e && e.message) || e); }
function deny(reason) {
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
// The session's fixed project folder (not the current `cd` location), cached per process.
let rootCache;
const rootOf = inp => rootCache || (rootCache = L.sessionRoot(inp.session_id, inp.cwd));

// Record (once per tool) which input fields Claude Code really sends, so `gpt.js doctor` can flag a
// mismatch with the fields these hooks rely on (e.g. after a Claude Code update).
function noteFields(inp) {
  try {
    const tool = inp.tool_name || inp.hook_event_name;
    if (!tool) return;
    // Recorded immediately if a required field is missing in THIS input; otherwise refreshed weekly.
    const fields = Object.keys(inp.tool_input || inp).sort();
    const missing = (L.HOOK_FIELDS[tool] || []).some(f => !fields.includes(f));
    const g = L.readState(L.HOME);
    if (!missing && g.seenFields && g.seenFields[tool] && Date.now() - ((g.seenFieldsAt || {})[tool] || 0) < 7 * 86400000) return;
    L.updateState(L.HOME, s => {
      s.seenFields = s.seenFields || {}; s.seenFieldsAt = s.seenFieldsAt || {};
      s.seenFields[tool] = fields; s.seenFieldsAt[tool] = Date.now();
    });
  } catch {}
}

// Live gpt.js reviews in this project's state (dead entries pruned in place). Only this project's:
// a review's result is recorded in the state it runs under, which the session root keeps identical.
function liveRunning(s) {
  const alive = r => { try { process.kill(r.pid, 0); return true; } catch { return false; } };
  const out = [];
  for (const [k, r] of Object.entries(s.running || {})) { if (alive(r)) out.push(r); else delete s.running[k]; }
  return out;
}

// The record for a change made outside Edit/Write (shell, disk, git): a new pending version that counts
// as a full change and keeps what must survive — the pending size/sensitivity/diff base/commit, the review
// time, the baseline's review time and open findings. `commit` overrides the kept commit details.
function outsideChange(c, pending, cfg, { abs, at, deleted = false, via = 'viaDisk', commit }) {
  return {
    lines: Math.max(pending ? c.lines : 0, cfg.minChangedLines),
    sensitive: deleted || (pending && c.sensitive) || L.SENSITIVE_PATH.test(abs),
    at, [via]: true, shellTouched: true, basePre: !!(pending && c.basePre), deleted, reviewedAt: c && c.reviewedAt,
    ...(commit || L.keepCommit(c, pending)),
    ...(c && c.baseAt ? { baseAt: c.baseAt } : {}),
    ...(c && c.openFindings ? { openFindings: c.openFindings } : {}),
  };
}

// The file holds exactly the version a review acknowledged at or after `since` (this turn's window, or the
// start of a shell command) — e.g. a review that finished while the command ran. An OLDER reviewed version
// doesn't count: putting it back over the owner's newer edits is a change that needs review.
function reviewedAsIs(root, abs, c, since) {
  return !!c && (c.baseAt || 0) >= (since || 0) && L.sameAsBaseline(root, abs);
}

// Time of a change whose file time is unreliable (e.g. a copy that kept its source's time) or that has
// none (a deletion): "now" — unless a live review already froze exactly this content (a deleted file
// hashes as 'absent', as frozen); then that review's freeze time, so its result acknowledges the change
// instead of leaving it pending.
function contentTime(s, abs, now) {
  let h; try { h = L.fileHash(abs); } catch { return now; }
  const k = path.resolve(abs).toLowerCase();
  for (const r of liveRunning(s)) {
    const i = (r.files || []).indexOf(k);
    if (i >= 0 && r.hashes && r.hashes[i] === h) return Math.min(r.cutoff, now);
  }
  return now;
}

// The project's ignore list (.claude/gpt.json) — not while gpt.json itself has an unreviewed change or open
// findings (here, or in any other session's project: another session may have changed it), or is among the
// files being recorded: a widened list must be reviewed before it hides anything.
function ignoreRules(root, s, changing = []) {
  const ps = L.projectSettings(root);
  if (!ps.ignore || !ps.ignore.length) return null;
  const k = ps._file.toLowerCase();
  if (changing.some(p => path.resolve(p).toLowerCase() === k)) return null;
  const c = s.changes && s.changes[L.changeKey(s, ps._file)];
  if (c && (c.at > L.reviewedAtFor(s, c) || c.openFindings)) return null;
  return L.pendingAnywhere(ps._file) ? null : ps;
}
// A file the ignore list hides — unless it already has a pending change or open findings (keep tracking it).
const ignoredIn = (ps, s, abs) => {
  if (!ps || !L.ignoredByProject(ps, abs)) return false;
  const c = s.changes && s.changes[L.changeKey(s, abs)];
  return !(c && (c.at > L.reviewedAtFor(s, c) || c.openFindings));
};
const ignoredNow = (root, abs) => { const s = L.readState(root); return ignoredIn(ignoreRules(root, s, [abs]), s, abs); };
// This setup's files: its global files and a project's .claude/gpt.json (the setup's per-project switches).
const isSetupFile = abs => /[\\/]\.claude[\\/]gpt\.json$/i.test(abs) || L.globalSetupFiles().some(x => x.toLowerCase() === path.resolve(abs).toLowerCase());
// A file's content print: its hash, 'absent', or null (too big or unreadable: unknown).
const contentPrint = p => (require('fs').existsSync(p) ? L.printOf(p) : 'absent');
// A setup file another session wrote through Edit/Write since `since` (see post-edit): that session's
// change, tracked and reviewed there — only if the file still holds exactly that write AND this session's
// window began from content that session's writes started from (`start`), so a change made here before
// that write (which its baseline then contains) is never skipped.
const otherSessionWrite = (writes, p, sid, since, start) => {
  const w = writes[p.toLowerCase()];
  return w && start && w.sid !== (sid || '') && w.at >= since && (w.from || []).includes(start) && w.hash === L.printOf(p) ? w : null;
};
// Git probes for not-authored checks end by this time, and recording after them waits at most until
// RECORD_DEADLINE for the state lock: together they stay inside the 15-s hook timeout.
const PROBE_DEADLINE = T0 + 6000, RECORD_DEADLINE = T0 + 13500;
const lockWait = () => Math.max(1000, Math.min(8000, RECORD_DEADLINE - Date.now()));

// Changes a shell command's author didn't write, or that aren't tracked: lower-case path -> why.
//   ignored     matches the project's ignore list
//   another session's write   this setup's own file, written through Edit/Write by another session while the
//               command ran (its fingerprints only saw the result)
//   copy / move a created file whose content existed before the command (not as an unreviewed change), or
//               a deleted file whose content reappears in a created file with the same extension
//   branch switch   nested repo (non-git folder): see L.branchSwitch
// Config destinations stay changes (see L.gitNotAuthored). `created`: every file the command created, also
// those the bulk rule drops (a move's destination). The caller still tracks a file that is already pending.
function shellSkips(root, inp, snap, before, after, changed, repoTops, created) {
  const skip = new Map();
  const s = L.readState(root);
  const ign = ignoreRules(root, s, changed.map(x => x.p));
  if (ign) for (const { p } of changed) if (L.ignoredByProject(ign, p)) skip.set(p.toLowerCase(), 'ignored');
  const writes = L.readState(L.HOME).setupWrites || {};
  const hashOf = fp => (fp && String(fp.f).split('|')[2]) || null;
  for (const { p, deleted } of changed) {
    const w = !deleted && otherSessionWrite(writes, p, inp.session_id, snap.at, before[p] ? hashOf(before[p]) : 'absent');
    if (w) skip.set(p.toLowerCase(), `written by another session (${w.sid})`);
  }
  const unreviewed = new Set(L.pending(s).map(([f]) => f.toLowerCase()));
  const known = new Set(Object.entries(before).filter(([p, v]) => v && !unreviewed.has(p.toLowerCase())).map(([, v]) => hashOf(v)).filter(Boolean));
  for (const { p, deleted } of changed) {
    if (deleted || before[p] || L.REVIEWABLE_CONFIG.test(p) || skip.has(p.toLowerCase())) continue;
    const h = hashOf(after[p]) || L.printOf(p);
    if (h && known.has(h)) skip.set(p.toLowerCase(), 'copy of existing content');
  }
  // Moves: content of a deleted file that reappears in a created file with the same extension.
  const gone = changed.filter(x => x.deleted && !L.REVIEWABLE_CONFIG.test(x.p) && !skip.has(x.p.toLowerCase()) && hashOf(before[x.p]));
  if (gone.length) {
    const exts = new Set(gone.map(x => path.extname(x.p).toLowerCase()));
    const createdBy = new Map(); // content hash -> created files
    for (const p of created || []) {
      if (!exts.has(path.extname(p).toLowerCase()) || Date.now() > PROBE_DEADLINE) continue;
      const h = hashOf(after[p]) || L.printOf(p);
      if (h) (createdBy.get(h) || createdBy.set(h, []).get(h)).push(p);
    }
    for (const { p } of gone) {
      const to = (createdBy.get(hashOf(before[p])) || []).find(n => path.extname(n).toLowerCase() === path.extname(p).toLowerCase());
      if (to) skip.set(p.toLowerCase(), `moved to ${to}`);
    }
  }
  if (snap.repos) {
    const tops = [...new Set(Object.keys(snap.repos).concat(repoTops || []))].sort((a, b) => b.length - a.length); // deepest first
    const tests = new Map();
    for (const { p } of changed) {
      if (skip.has(p.toLowerCase())) continue;
      const top = tops.find(t => p.toLowerCase().startsWith(t.toLowerCase() + path.sep));
      if (!top || snap.repos[top] === false) continue;
      // (a repo that can't be checked before PROBE_DEADLINE gets no exemption)
      if (!tests.has(top)) tests.set(top, L.branchSwitch(top, snap.repos[top] || null, snap.at, PROBE_DEADLINE));
      const t = tests.get(top);
      if (t && t(p, !!before[p])) skip.set(p.toLowerCase(), `branch switch in ${top}`);
    }
  }
  return skip;
}

// Record code changes made on disk during the current turn but not through Edit/Write (shell edits,
// deletions, commits created in the turn) as pending changes. Called at Stop, and by the prompt hook
// BEFORE it starts a new turn — so an interrupting user message can't erase the turn's discovery window.
// The slow git scan runs outside the state lock; only this turn counts, so the user's own uncommitted
// work never triggers a review.
// `ctx` (prompt hook) shares the git status and walk it already fetched.
function absorbTurnChanges(root, cfg, ctx = {}) {
  const snap = L.readState(root);
  if (!snap.turnStartedAt) return;
  const prints = L.readTurnPrints(root, snap.turnStartedAt);
  ctx.turnHead = snap.turnHead;
  let disk = L.gitChangedCode(root, snap.turnStartedAt, snap.turnBaselineDeleted, prints, ctx);
  const scanned = disk; // everything the scan saw: move detection needs the new files the bulk rule drops
  // Bulk rule: many NEW untracked files (copy, extract, generator) are not flagged one by one;
  // modified or deleted tracked files always are.
  // (Sensitive files, e.g. .set presets or risk/order code, are always kept.)
  if (disk.filter(d => d.untracked).length > (cfg.bulkShellFiles || 15)) disk = disk.filter(d => !d.untracked || L.isSensitiveFile(d.abs));
  // Edit + `git commit` in one shell command no longer shows in git status: take commits the local user
  // CREATED during the turn (branch switches and pulls don't count — see gitCommittedSince).
  if (L.gitRoot(root)) { // turnHead may be null in a brand-new repo
    const byAbs = new Map(disk.map(d => [d.abs.toLowerCase(), d]));
    const dirty = new Map(Object.entries((prints && prints.dirty) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const deletedAtStart = new Set((snap.turnBaselineDeleted || []).map(f => require('path').resolve(f).toLowerCase()));
    for (const d of L.gitCommittedSince(root, snap.turnHead, snap.turnStartedAt)) {
      const k = d.abs.toLowerCase();
      // changed again after its commit: the review must still diff from before the commit
      if (byAbs.has(k)) { byAbs.get(k).committed = true; continue; }
      // a deletion that already existed at turn start, now only committed: not a change of this turn
      if (d.deleted && deletedAtStart.has(k)) { disk.push({ ...d, commitOnly: true }); continue; }
      let byContent = false;
      if (prints && !d.deleted) {
        const was = dirty.get(k);
        // Committed exactly as it was at turn start (e.g. the user's own work): not a change of this turn —
        // but a still-pending earlier change of it keeps a diff base from before this commit.
        if (was && was === L.printOf(d.abs)) { disk.push({ ...d, commitOnly: true }); continue; }
        if (d.mtime <= snap.turnStartedAt) {
          // Old file time: clean at turn start, it counts only if it differs from the turn-start revision
          // (reflog times have 1 s resolution, so a commit made just before the turn can be listed).
          if (!dirty.has(k) && !L.differsFromRev(root, snap.turnHead, d.abs)) continue;
          byContent = !dirty.has(k) || !!was; // dirty at turn start but not hashed: file-time rule
        }
      }
      disk.push({ ...d, byContent });
    }
  }
  // Not tracked: files on the project's ignore list, and changes the turn didn't author (copies, moves).
  const ign = ignoreRules(root, snap, disk.map(d => d.abs));
  if (ign) disk = disk.filter(d => !ignoredIn(ign, snap, d.abs));
  // A setup file another session wrote during this turn (e.g. this project's .claude/gpt.json, written from
  // another chat): reviewed in that session, not counted here.
  const writes = L.readState(L.HOME).setupWrites || {};
  const lower = o => new Map(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const dirtyAt = lower(prints && prints.dirty), confsAt = lower(prints && prints.configs);
  // The file's content at the turn start: as fingerprinted then (changed in git, or git-ignored config the
  // walk saw), else as in the turn-start commit — 'absent' if not there and not git-ignored (an untracked
  // file would have been fingerprinted); null = unknown (never skipped).
  const startOf = p => {
    const k = p.toLowerCase();
    if (!prints) return null;
    if (dirtyAt.has(k)) return dirtyAt.get(k);
    if (confsAt.has(k)) return confsAt.get(k);
    const inRev = L.revPrint(root, snap.turnHead, p);
    return inRev !== 'absent' ? inRev : L.gitIgnored(root, [p]).has(k) ? null : 'absent';
  };
  disk = disk.filter(d => d.deleted || !writes[d.abs.toLowerCase()] || !otherSessionWrite(writes, d.abs, ctx.sid, snap.turnStartedAt, startOf(d.abs)));
  // A change made while the setup was off (gpt.js off) the whole time from the window's start is not
  // counted; anything else is — undated ones (deletions, changes found by content) too, to be safe.
  const offThroughout = L.setupOffThroughout(root);
  disk = disk.filter(d => d.deleted || d.byContent || !(d.mtime > snap.turnStartedAt) || !offThroughout(snap.turnStartedAt, d.mtime));
  if (!disk.length) return;
  const notAuthored = L.gitNotAuthored(root, [...new Set(scanned.concat(disk))].filter(d => !d.commitOnly), prints, PROBE_DEADLINE);
  L.updateState(root, s => {
    const now = Date.now();
    const skipped = [];
    for (const { abs: found, deleted, mtime, committed, byContent, commitOnly } of disk) {
      const abs = L.changeKey(s, found);
      const c = s.changes[abs];
      const reviewed = L.reviewedAtFor(s, c);
      const isPending = c && c.at > reviewed;
      const why = !commitOnly && notAuthored.get(found.toLowerCase());
      if (why && !isPending && !(c && c.openFindings)) { skipped.push([found, why]); continue; } // (a pending file is always tracked)
      // A newly observed deletion, or a disk modification newer than both the tracked change and the
      // last review, becomes a NEW change version that an earlier-started review cannot acknowledge.
      // A change found by content (old file time) is new unless it is exactly the last reviewed version;
      // on a pending record it is re-recorded too (it may be bigger than the pending edit, and newer than
      // what a running review froze).
      const timeNew = !deleted && mtime > Math.max(c ? c.at : 0, reviewed);
      // file time not after the last change/review, yet different from the reviewed version: a copy that
      // kept an older time (e.g. one reviewed preset copied over another)
      const contentNew = !deleted && !byContent && !timeNew && !!c && !isPending && !reviewedAsIs(root, abs, c, snap.turnStartedAt);
      const fresh = commitOnly ? false
        : deleted ? !(c && c.deleted)
        : byContent ? isPending || !reviewedAsIs(root, abs, c, snap.turnStartedAt)
        : timeNew || contentNew;
      if (!fresh) {
        // a pending change committed later in the turn: its review diffs from the turn-start revision
        if (committed && isPending && !c.committed) Object.assign(c, { committed: true, sinceRev: snap.turnHead || null });
        continue;
      }
      s.changes[abs] = outsideChange(c, isPending, cfg, {
        abs, deleted,
        // A modification is dated by its file time, so a review that froze the file after the edit can
        // still acknowledge it; a deletion, or a change whose file time is unreliable, gets "now" (or the
        // cutoff of a running review that froze exactly this state).
        at: deleted || byContent || contentNew ? contentTime(s, abs, now) : Math.min(mtime, now),
        // committed during the turn: review diffs it against the revision the turn started from
        // a commit found now starts from this turn's revision; an older pending commit keeps its earlier base
        commit: isPending && c.committed ? L.keepCommit(c, true) : committed ? { committed: true, sinceRev: snap.turnHead || null } : {},
      });
    }
    L.noteNotAuthored(s, skipped);
  }, false, lockWait());
}

// Start a turn's discovery window: changes on disk from now on count as this turn's. First save what the
// outgoing window changed (if no Stop ended it — e.g. the user interrupted); the same git status then
// fingerprints the new starting point. `carry`: a continuation of the same user turn (not a new user
// request): the user turn (userTurnAt — once-per-turn Stop blocks, same-turn plan review) stays.
function startWindow(root, ps, carry, sid) {
  const startedAt = Date.now();
  // Switched off (gpt.js off) in a project that reviews: the previous window is still scanned, for its
  // changes from while the setup was on (absorbTurnChanges counts only those).
  const track = ps.review || (ps.off && L.projectFileSettings(root).review);
  const ctx = track ? { entries: L.gitStatus(root), sid } : null;
  const prev = L.readState(root);
  const ended = prev.turnClosedAt && prev.turnClosedAt >= (prev.turnStartedAt || 0); // Stop already absorbed it
  // A background job that may write files keeps working after the Stop: its changes are absorbed too.
  const bgWriter = prev.turnStartedAt && prev.bgWriterTurn === prev.turnStartedAt;
  if (ctx && (!ended || bgWriter)) try { absorbTurnChanges(root, L.loadConfig(), ctx); } catch (e) { survived('absorb', e); }
  const e = L.startDiscoveryWindow(root, ctx, carry, startedAt);
  if (e) survived('fingerprints', e);
}

// A background shell command that may write files (anything but a read-only GPT run).
const READONLY_GPT = /[\\/]gpt\.js["']?\s+(review|plan|idea|digest|research|testplan|score|status|stats|doctor)\b/i;
// The on/off switch. A user message that asks to switch THIS setup off — an off verb with the setup named
// ("turn the GPT setup off", "disable the reviews", "pause GPT") — lets gpt.js off run in that turn; one that
// only mentions "off" or "disable" ("disable the failing test", "review the off switch") or says not to
// ("do not turn GPT off") does not.
const SETUP_WORDS = String.raw`(?:the\s+|this\s+)?(?:claude\s*(?:\+|and|&)\s*gpt(?:\s+setup)?|gpt(?:\s+(?:setup|reviews?|checks?))?|setup|configuration|config|reviews?|hooks?)`;
const OFF_ASK = new RegExp(String.raw`\b(?:(?:turn|switch|shut|set|put)\s+${SETUP_WORDS}\s+off|(?:turn|switch|shut)\s+off\s+${SETUP_WORDS}|(?:disable|deactivate|pause|suspend)\s+${SETUP_WORDS}|(?:run|execute|use)\s+(?:the\s+)?gpt\.js\s+off)\b`, 'i');
// (a negation within the same sentence; a dot inside a name like gpt.js doesn't end it)
const NOT_OFF = /\b(?:don'?t|do not|never|not|no need to|without|won'?t|wouldn'?t|shouldn'?t|mustn'?t|can'?t|cannot)\b(?:[^.?!\n]|\.(?!\s)){0,40}\b(?:off|disable|deactivate|pause|suspend)/i;
// Per sentence (a dot inside a name like gpt.js doesn't end one), judged by what comes BEFORE the off phrase:
// no negation, no question/explanation/confirmation lead-in ("how to", "explain", "why", "confirm", "tell me
// the command to"); a question only as a plain polite request ("can/could you (please) turn ... off?").
// What follows the phrase doesn't matter ("turn the GPT setup off and check the build").
const LEAD_NOT = /\b(?:how|explain\w*|why|what|whether|if|when|confirm|check|make sure|ensure|verify|tell me|show me|commands?|instructions?|steps?)\b/i;
const POLITE_LEAD = /^(?:ok(?:ay)?[,.]?\s+)?(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?$/i;
// Any negated off phrase in the message withdraws it — a later "actually, do not, under any circumstances,
// turn the GPT setup off" too (a negation anywhere before an off phrase in its sentence, at any distance).
const NEGATION = /\b(?:don'?t|do not|never|not|no need to|without|won'?t|wouldn'?t|shouldn'?t|mustn'?t|can'?t|cannot)\b/i;
const sentencesOf = p => String(p).split(/(?<=[.?!])\s+|\n+/).map(s => s.trim());
// (every off phrase of a sentence, each with the text since the previous one)
const OFF_ASK_ALL = new RegExp(OFF_ASK.source, 'gi');
const withdrawn = p => sentencesOf(p).some(s => {
  if (NOT_OFF.test(s)) return true;
  let last = 0;
  for (const m of s.matchAll(OFF_ASK_ALL)) { if (NEGATION.test(s.slice(last, m.index))) return true; last = m.index + m[0].length; }
  return false;
});
const asksOff = p => !withdrawn(p) && sentencesOf(p).some(s => {
  const m = OFF_ASK.exec(s);
  if (!m) return false;
  const lead = s.slice(0, m.index);
  if (NOT_OFF.test(s.slice(0, m.index + m[0].length)) || LEAD_NOT.test(lead)) return false;
  // quoted (e.g. "Turn the GPT setup off" is not what I asked): a mention, not a request
  if ((lead.match(/"/g) || []).length % 2 === 1 || (lead.match(/“/g) || []).length > (lead.match(/”/g) || []).length || (lead.match(/`/g) || []).length % 2 === 1) return false;
  return !/\?\s*$/.test(s) || POLITE_LEAD.test(lead);
});
// What Claude is told about the switch (CLAUDE.md's rules assume "on").
const switchNote = sw => sw.off
  ? `[Claude + GPT setup OFF ${sw.scope === 'all' ? 'for all projects' : 'for this project'} (gpt.js off, ${new Date(sw.at).toLocaleString()}): the hooks track and enforce nothing. Don't consult GPT (reviews, plans, ideas, digests) unless the user asks; you may use computer-use tools yourself. Only the user turns it back on: ${GPT} on${sw.scope === 'all' ? ' --all' : ''}.]`
  : '[Claude + GPT setup ON again: the CLAUDE.md rules apply (GPT review before a coding task is done, plan and idea checks).]';

const handlers = {
  'post-edit'(inp) {
    const ti = inp.tool_input || {};
    const file = ti.file_path || ti.notebook_path;
    if (!file) return out();
    const abs = path.resolve(inp.cwd || '.', file);
    if (!L.isCode(abs)) return out();
    // Reviews off (.claude/gpt.json, or gpt.js off): nothing is tracked, so switching back on doesn't flood
    // reviews with work done while off.
    if (!L.projectSettings(rootOf(inp)).review) return out();
    try { if (ignoredNow(rootOf(inp), abs)) return out(); } catch (e) { survived('ignore list', e); }
    // Non-bulk edits are counted here; replace_all edits are counted by pre-edit (occurrences x lines).
    const plain = inp.tool_name === 'MultiEdit' ? (ti.edits || []).filter(e => !e.replace_all)
      : inp.tool_name === 'Edit' && !ti.replace_all ? [ti] : [];
    let added = '', removed = '', lines = 0;
    if (inp.tool_name === 'Write') { added = ti.content || ''; lines = L.countLines(added); }
    else if (inp.tool_name === 'NotebookEdit') { added = ti.new_source || ''; lines = L.countLines(added); }
    else {
      const all = inp.tool_name === 'MultiEdit' ? (ti.edits || []) : [ti];
      added = all.map(e => e.new_string || '').join('\n');
      removed = all.map(e => e.old_string || '').join('\n');
      lines = plain.reduce((n, e) => n + Math.max(L.countLines(e.new_string || ''), L.countLines(e.old_string || '')), 0);
    }
    // Removing a sensitive operation (e.g. an OrderSend or auth check) is as sensitive as adding one, and
    // any edit inside a file that contains one (a lot-size line in an EA that calls OrderSend elsewhere).
    const sensitive = L.SENSITIVE_CONTENT.test(added) || L.SENSITIVE_CONTENT.test(removed) || L.isSensitiveFile(abs);
    const hash = L.printOf(abs); // content after this edit: a later edit can tell if something else changed it
    let setupBefore = null; // a setup file's content before this call (pre-edit)
    L.updateState(rootOf(inp), s => {
      const rec = L.changeKey(s, abs);
      const c = s.changes[rec];
      // What THIS call's pre-edit captured (keyed by file + tool_use_id; leftovers of failed calls are
      // never picked up and expire).
      const key = `${abs}|${inp.tool_use_id || 'x'}`;
      const pre = s.preWrite && s.preWrite[key];
      if (pre) delete s.preWrite[key];
      const sp = s.setupPre && s.setupPre[key];
      if (sp) { delete s.setupPre[key]; setupBefore = sp.before; }
      const prev = c && c.at > L.reviewedAtFor(s, c) ? c : { lines: 0, sensitive: false };
      // Write/NotebookEdit: whichever is bigger, the old or the new text. Bulk edits: added on top.
      const counted = !pre ? lines : pre.kind === 'bulk' ? lines + pre.lines : Math.max(lines, pre.lines);
      s.changes[rec] = {
        lines: prev.lines + counted,
        sensitive: prev.sensitive || sensitive || !!(pre && pre.sensitive),
        at: Date.now(), reviewedAt: c && c.reviewedAt, hash,
        ...(prev.shellTouched ? { shellTouched: true } : {}),
        // basePre: the saved baseline predates every pending change (a fresh change here starts one).
        basePre: prev.lines === 0 && !prev.shellTouched ? true : !!prev.basePre,
        ...L.keepCommit(prev, prev.lines > 0), // a pending commit keeps its diff base
        ...(c && c.baseAt ? { baseAt: c.baseAt } : {}), // which review set the current baseline
        // Open GPT findings survive edits: only a follow-up review or an explicit acceptance clears them.
        ...(c && c.openFindings ? { openFindings: c.openFindings } : {}),
      };
    });
    // This setup's own file written here: another session must not take this write for its own change
    // (see otherSessionWrite). Registered only when the file holds what this tool wrote (Write: exactly its
    // content; Edit: every replacement text, and the content changed — an Edit that only deletes has no
    // replacement text) and its content before the call is known — and only in a project that reviews its
    // changes (whatever this session's record holds is then reviewed here, diffed from a baseline taken
    // before this call). `from`: the contents this session's consecutive writes started from.
    let wrote = false;
    try {
      const now = require('fs').readFileSync(abs);
      if (inp.tool_name === 'Write') wrote = typeof ti.content === 'string' && now.equals(Buffer.from(ti.content, 'utf8'));
      else if (inp.tool_name === 'Edit' || inp.tool_name === 'MultiEdit') {
        const text = now.toString('utf8'), news = (inp.tool_name === 'Edit' ? [ti] : ti.edits || []).map(e => e.new_string || '').filter(Boolean);
        wrote = news.every(n => text.includes(n)) && hash !== setupBefore;
      }
    } catch {}
    if (wrote && hash && setupBefore && isSetupFile(abs) && L.projectSettings(rootOf(inp)).review) try {
      L.updateState(L.HOME, g => {
        const w = g.setupWrites = g.setupWrites || {};
        for (const [k, v] of Object.entries(w)) if (Date.now() - v.at > 86400000) delete w[k];
        const k = abs.toLowerCase(), sid = inp.session_id || '', old = w[k];
        const from = old && old.sid === sid && old.hash === setupBefore ? (old.from || []).concat(setupBefore).slice(-20) : [setupBefore];
        w[k] = { sid, hash, from, at: Date.now() };
      });
    } catch (e) { survived('setup write', e); }
    return out();
  },

  // Before Edit/Write/MultiEdit touches a code file: save its baseline (version before Claude's first
  // edit since the last review) for exact review diffs. For Write, also remember how big/sensitive the
  // old content was, so replacing e.g. a large auth module with one harmless line still counts.
  'pre-edit'(inp) {
    const ti = inp.tool_input || {};
    const file = ti.file_path || ti.notebook_path;
    if (!file) return out();
    const abs = path.resolve(inp.cwd || '.', file);
    if (!L.isCode(abs)) return out();
    if (!L.projectSettings(rootOf(inp)).review) return out(); // reviews off: nothing is tracked (see post-edit)
    try { if (ignoredNow(rootOf(inp), abs)) return out(); } catch (e) { survived('ignore list', e); }
    try {
      const s = L.readState(rootOf(inp));
      const c = s.changes && s.changes[L.changeKey(s, abs)];
      const pending = c && c.at > L.reviewedAtFor(s, c);
      // Changed during this turn but not by Edit/Write (a shell command, not yet seen by Stop's scan)?
      let mtime = 0;
      try { mtime = require('fs').statSync(abs).mtimeMs; } catch {}
      // Already pending from an edit, but the file no longer holds what that edit left: something else
      // (a shell command) changed it in between — count it as a full change, not just the edits.
      if (pending && c.hash && L.printOf(abs) !== c.hash) {
        const cfg = L.loadConfig();
        L.updateState(rootOf(inp), st => {
          const cc = st.changes[L.changeKey(st, abs)];
          if (!cc) return;
          Object.assign(cc, { lines: Math.max(cc.lines || 0, cfg.minChangedLines), shellTouched: true, at: Date.now() });
          delete cc.hash;
        });
      }
      // Newer than the turn start, or (file time kept by a copy) different from the turn-start content —
      // and not simply the last reviewed version.
      const byContent = !pending && s.turnStartedAt && mtime > 0 && mtime <= s.turnStartedAt
        && L.changedByContentThisTurn(rootOf(inp), abs, s.turnStartedAt, s.turnHead);
      // (a change made while the setup was off the whole time since the window began is not Claude's to review)
      const offTime = !byContent && mtime > (s.turnStartedAt || 0) && L.setupOffThroughout(rootOf(inp))(s.turnStartedAt, mtime);
      const shellBefore = !pending && s.turnStartedAt && (mtime > s.turnStartedAt || byContent) && !offTime && !reviewedAsIs(rootOf(inp), abs, c, s.turnStartedAt);
      if (shellBefore) {
        // Record that change now (otherwise this edit's baseline would silently absorb it).
        const cfg = L.loadConfig();
        L.updateState(rootOf(inp), st => {
          const k = L.changeKey(st, abs);
          st.changes[k] = outsideChange(st.changes[k], false, cfg, { abs, at: byContent ? contentTime(st, abs, Date.now()) : Math.min(mtime, Date.now()) });
        });
      }
      // A file already changed outside Edit/Write has no trustworthy "before" version: don't capture its
      // current content as the baseline (review then uses git or reads the whole file).
      const untrusted = shellBefore || (pending && c.shellTouched && !L.baselineOf(rootOf(inp), abs));
      if (!untrusted) L.captureBaseline(rootOf(inp), abs, !pending);
    } catch (e) { survived('baseline', e); }
    // This setup's own file: its content before this call, for post-edit's setup-write record (another
    // session skips the write only if its window began from this content — see otherSessionWrite).
    if (isSetupFile(abs)) try {
      const before = contentPrint(abs);
      L.updateState(rootOf(inp), s => {
        s.setupPre = s.setupPre || {};
        for (const [k, v] of Object.entries(s.setupPre)) if (!v.at || Date.now() - v.at > 10 * 60000) delete s.setupPre[k];
        s.setupPre[`${abs}|${inp.tool_use_id || 'x'}`] = { before, at: Date.now() };
      });
    } catch (e) { survived('setup write', e); }
    // replace_all edits (Edit, or any MultiEdit entry) change every occurrence, not just one.
    const bulkEdits = inp.tool_name === 'Edit' ? (ti.replace_all && ti.old_string ? [ti] : [])
      : inp.tool_name === 'MultiEdit' ? (ti.edits || []).filter(e => e.replace_all && e.old_string) : [];
    if (inp.tool_name !== 'Write' && inp.tool_name !== 'NotebookEdit' && !bulkEdits.length) return out();
    let old;
    try {
      old = require('fs').readFileSync(abs, 'utf8');
      if (bulkEdits.length) {
        // stand-in text with (occurrences x lines per occurrence) lines, keeping each old_string for the
        // sensitivity check (also correct when deleting with "")
        old = bulkEdits.map(e => {
          const n = Math.max(old.split(e.old_string).length - 1, 1);
          const per = Math.max(L.countLines(e.old_string), L.countLines(e.new_string || ''));
          return e.old_string + '\n'.repeat(Math.max(n * per - L.countLines(e.old_string), 0));
        }).join('\n');
      } else if (inp.tool_name === 'NotebookEdit') { // only the cell being replaced/deleted matters
        const cell = (JSON.parse(old).cells || []).find(x => x.id === ti.cell_id);
        if (!cell || ti.edit_mode === 'insert') return out();
        old = [].concat(cell.source || []).join('');
      }
    } catch { return out(); }
    L.updateState(rootOf(inp), s => {
      s.preWrite = s.preWrite || {};
      // One snapshot per tool call (file + tool_use_id): a call that fails never fires post-edit, so its
      // snapshot is never charged to another edit; stale ones expire after 10 minutes.
      for (const [k, v] of Object.entries(s.preWrite)) if (!v.at || Date.now() - v.at > 10 * 60000) delete s.preWrite[k];
      s.preWrite[`${abs}|${inp.tool_use_id || 'x'}`] = {
        lines: L.countLines(old), sensitive: L.SENSITIVE_CONTENT.test(old),
        kind: bulkEdits.length ? 'bulk' : 'replace', at: Date.now(),
      };
    });
    return out();
  },

  // Shell commands: fingerprint files before and compare after, so edits and deletions made through
  // Bash/PowerShell are tracked too. Always this setup's own files (hooks, bridge, settings — a project's
  // scans never see them). Non-git folders: every code file (`walk`, which also finds new files). In a huge
  // folder (walk cut off at 5000 entries) only the files reached are compared — new files elsewhere can't
  // be told apart from the cut-off, so that partial coverage is recorded for `gpt.js status`. Git folders
  // (Stop's scan covers what git status shows): git-ignored config and Claude/Codex settings.
  'pre-bash'(inp) {
    const root = rootOf(inp);
    if (!L.projectSettings(root).review) return out();
    let paths = L.globalSetupFiles(), stats = null, all = true, walk = false, repos;
    if (L.gitRoot(root)) paths = paths.concat(L.watchedIgnored(root, L.readState(root).turnStartedAt));
    else {
      const snap = L.codeSnapshot(root, 5000, true);
      stats = snap.files; all = Object.keys(snap.files).length <= 1000;
      paths = paths.concat(Object.keys(snap.files));
      walk = !snap.truncated;
      // A command that may switch branches in a nested repo: each repo's HEAD and dirty files beforehand.
      const cmd = String((inp.tool_input || {}).command || '');
      if (/\bgit\b/i.test(cmd) && /\b(checkout|switch|pull|merge|rebase|clone)\b/i.test(cmd)) repos = L.repoStates(snap.repos, T0 + 8000);
      if (snap.truncated) {
        const st = L.readState(root);
        if (!st.shellScanPartial || Date.now() - st.shellScanPartial.at > 86400000) {
          L.updateState(root, s => { s.shellScanPartial = { at: Date.now(), files: Object.keys(snap.files).length }; });
        }
      }
    }
    const files = L.shellPrints([...new Set(paths)], stats, all);
    require('fs').writeFileSync(`${L.statePath(root)}.bash-${inp.tool_use_id || 'x'}.json`, JSON.stringify({ at: Date.now(), walk, all, files, repos }));
    return out();
  },

  'post-bash'(inp) {
    const root = rootOf(inp);
    const fs = require('fs');
    const ti = inp.tool_input || {};
    // A background command keeps running after this hook: remember that this turn started a possible
    // writer, so a later notification keeps the turn's discovery window open (see the prompt hook).
    if (ti.run_in_background && !READONLY_GPT.test(String(ti.command || ''))) {
      try { L.updateState(root, s => { s.bgWriterTurn = s.turnStartedAt; }); } catch (e) { survived('background writer', e); }
    }
    const f = `${L.statePath(root)}.bash-${inp.tool_use_id || 'x'}.json`;
    let snapBefore;
    try { snapBefore = JSON.parse(fs.readFileSync(f, 'utf8')); fs.rmSync(f, { force: true }); } catch { return out(); }
    if (!snapBefore || !snapBefore.files) return out(); // written by an older version of this hook
    const before = snapBefore.files;
    let after;
    // same file set rule and hashing policy as the first snapshot, so untouched files compare equal
    const walk = snapBefore.walk !== undefined ? snapBefore.walk : !snapBefore.git; // (older snapshot format)
    let repoTops = [];
    if (!walk) after = L.shellPrints(Object.keys(before), null, snapBefore.all !== false);
    else {
      const snap = L.codeSnapshot(root, 5000, true);
      after = L.shellPrints([...new Set(L.globalSetupFiles().concat(Object.keys(snap.files)))], snap.files, snapBefore.all);
      repoTops = snap.repos;
    }
    const cfg = L.loadConfig();
    const created = Object.keys(after).filter(p => after[p] && !before[p]);
    let changed = Object.keys(after).filter(p => after[p] && before[p] && after[p].f !== before[p].f).map(p => ({ p, deleted: false }))
      .concat(Object.keys(before).filter(p => before[p] && !after[p] && !fs.existsSync(p)).map(p => ({ p, deleted: true })));
    // Many NEW files from one command = copy/extract/clone/generate, not hand-written code: skip those
    // (noted for `gpt.js status`). Modified or deleted existing files are always tracked (a shell
    // refactor across many files still needs review).
    if (created.length > (cfg.bulkShellFiles || 15)) {
      L.updateState(root, s => { s.lastBulkShell = { at: Date.now(), files: created.length, command: String((inp.tool_input || {}).command || '').slice(0, 200) }; });
      // sensitive new files (.set presets, risk/order code) are still tracked individually
      changed = changed.concat(created.filter(p => L.isSensitiveFile(p)).map(p => ({ p, deleted: false })));
    } else changed = changed.concat(created.map(p => ({ p, deleted: false })));
    // A change made while the setup was off the whole time since this command started (switched off during
    // it) is not counted. A deletion, or a file time not after the command's start (cp -p, restored
    // copies), is undated and counts, to be safe.
    const offThroughout = L.setupOffThroughout(root);
    changed = changed.filter(({ p, deleted }) => deleted || !after[p] || !(after[p].m > snapBefore.at) || !offThroughout(snapBefore.at, after[p].m));
    if (!changed.length) return out();
    let skip = new Map();
    try { skip = shellSkips(root, inp, snapBefore, before, after, changed, repoTops, created); } catch (e) { survived('not-authored check', e); }
    L.updateState(root, s => {
      const skipped = [];
      for (const { p: found, deleted } of changed) {
        const rec = L.changeKey(s, found), p = found;
        const c = s.changes[rec];
        const reviewed = L.reviewedAtFor(s, c);
        const pending = c && c.at > reviewed;
        const why = skip.get(found.toLowerCase());
        if (why && !pending && !(c && c.openFindings)) { if (why !== 'ignored') skipped.push([found, why]); continue; } // (a pending file is always tracked)
        // file time unreliable: not after the last review, or not after its own previous time (a copy that
        // kept its source's time)
        const oldTime = !deleted && (after[p].m <= reviewed || (before[p] && after[p].m <= before[p].m));
        // Content identical to the version a review acknowledged while this command ran: not a new change.
        if (oldTime && !pending && reviewedAsIs(root, p, c, snapBefore.at)) continue;
        s.changes[rec] = outsideChange(c, pending, cfg, {
          abs: p, deleted, via: 'viaShell',
          // dated by the file time, so a review frozen after the change can still acknowledge it — unless
          // that time is unreliable (cp -p, restored backups): then the content changed now, so it is a NEW
          // version that an older review can't cover (unless a running review froze exactly this content,
          // also for a deletion)
          at: deleted || oldTime ? contentTime(s, p, Date.now()) : Math.min(after[p].m, Date.now()),
        });
      }
      L.noteNotAuthored(s, skipped);
    }, false, lockWait());
    return out();
  },

  stop(inp) {
    const cfg = L.loadConfig();
    const root = rootOf(inp);
    if (!L.projectSettings(root).review) return out();
    // Damaged state: nothing can be tracked or blocked — say so (once per Stop) instead of a silent "all clear".
    const s0 = L.readState(root);
    if (s0._unreadable) return out({ systemMessage: `GPT review tracking is OFF for ${path.basename(root)}: ${L.statePath(root)} is unreadable (${s0._unreadable}), so unreviewed changes are unknown. Move that file aside (tracking restarts) and review your changes with ${GPT} review --files "...".` });
    absorbTurnChanges(root, cfg, { sid: inp.session_id });
    const res = L.updateState(root, s => {
      // Edits that were reverted (content equals the pre-edit baseline again) are no change at all.
      // (Only the pending change is cleared; open findings stay until resolved or accepted.)
      for (const [f, c] of L.pending(s)) {
        // A file first seen while still being written that turned out to be a Strategy Tester report: output.
        if (/\.html?$/i.test(f) && L.isTesterReport(f)) { c.reviewedAt = Math.max(c.reviewedAt || 0, c.at); continue; }
        // Changed outside Edit/Write: compare only if the saved baseline predates ALL pending changes.
        if (c.shellTouched && !c.basePre) continue;
        const base = L.baselineOf(root, f);
        // Judge by the file system now (a deleted file may have been restored since).
        const exists = require('fs').existsSync(f);
        let same = false; // created then deleted again = absent before and after
        try { same = base === 'ABSENT' ? !exists : !!base && exists && L.fileHash(base) === L.fileHash(f); } catch {}
        if (same) { c.reviewedAt = Math.max(c.reviewedAt || 0, c.at); if (exists) c.deleted = false; }
      }
      // A live gpt.js review that froze these exact change versions is already handling them.
      const running = liveRunning(s);
      // ...unless the file changed after it was frozen in a way that kept its recorded time (e.g. a copy
      // that preserved an older time): then it is a newer version that review can't acknowledge.
      for (const [f, c] of L.pending(s)) {
        const k = path.resolve(f).toLowerCase();
        const covering = running.filter(r => r.cutoff >= c.at && r.hashes && (r.files || []).includes(k));
        if (!covering.length) continue;
        let h; try { h = L.fileHash(f); } catch { continue; }
        // newer than every covering review's frozen copy (one matching review is enough to cover it)
        if (!covering.some(r => r.hashes[r.files.indexOf(k)] === h)) c.at = Date.now();
      }
      const allPending = L.pending(s);
      const coveredByRunning = ([f, c]) => running.some(r => r.cutoff >= c.at && r.files.includes(f.toLowerCase()));
      // Each kind of block is raised at most once per user turn, and both go out in ONE message.
      // Open findings on a file a running review (e.g. the follow-up) already covers wait for its result.
      const open = Object.entries(s.changes).filter(e => e[1].openFindings && e[1].at <= L.reviewedAtFor(s, e[1]) && !coveredByRunning(e));
      // Strictly once per user turn per block kind (owner: never block my work); after that, only a note.
      const turn = s.userTurnAt || s.turnStartedAt || 0;
      const findings = open.length && s.findingsBlockedTurn !== turn ? open : null;
      if (findings) s.findingsBlockedTurn = turn;
      // Changes a running review already covers neither block nor count toward significance.
      const list = allPending.filter(e => !coveredByRunning(e));
      let pendingList = null, warn = 0;
      if (list.length && L.isSignificant(list, cfg)) {
        // Already blocked this turn: a one-line note — only when the pending set (files and their content)
        // differs from the one the last note named, so it isn't repeated at every Stop (a file whose old file
        // time makes each scan re-date it keeps its content, so it doesn't count as new).
        // (a file too big to hash: its size and file time, which a re-dating scan doesn't change either)
        const version = (f, c) => { if (c.deleted) return 'deleted'; const h = L.printOf(f); if (h) return h; try { const st = require('fs').statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return c.at; } };
        const sig = require('crypto').createHash('sha1').update(list.map(([f, c]) => `${f.toLowerCase()}@${version(f, c)}`).sort().join('|')).digest('hex').slice(0, 16);
        if (s.stopBlockedTurn !== turn) { s.stopBlockedTurn = turn; pendingList = list; s.pendingNoteSig = sig; }
        else if (s.pendingNoteSig !== sig) { s.pendingNoteSig = sig; warn = list.length; }
      }
      if (!findings && !pendingList) {
        // The turn ends here: its discovery window closes, so edits the user makes before the next prompt
        // are never attributed to it (the prompt hook only absorbs turns that ended without a Stop).
        s.turnClosedAt = Date.now();
        return warn ? { warn } : null;
      }
      return { findings, list: pendingList, unavailable: L.minutesAgo(s.gptUnavailableAt, cfg.unavailableCooldownMinutes), why: s.gptUnavailableReason };
    });
    if (!res) return out();
    if (res.warn) return out({ systemMessage: `GPT review still pending for ${res.warn} changed file(s) in ${path.basename(root)}.` });
    const P = `--project "${root}"`;
    const parts = [];
    if (res.findings) {
      const logs = [...new Set(res.findings.flatMap(([, c]) => [].concat(c.openFindings)))];
      const files = res.findings.map(([f]) => f);
      parts.push(`Open GPT findings (${logs.join(', ')}) on: ${files.join(', ')}. Fix + follow-up review, or accept: ${GPT} mark-reviewed ${P} --by claude-final --files "${files.join(',')}" --note "<why>".`);
    }
    if (res.list) {
      const files = res.list.map(([f, c]) => `  - ${f} (${c.deleted ? 'DELETED' : `~${c.lines} lines`}${c.sensitive ? ', SENSITIVE' : ''})`).join('\n');
      const how = res.unavailable
        ? `GPT failed recently (${String(res.why || 'unknown').slice(0, 120)}). Try once: ${GPT} review ${P} --task "<goal>"; if it fails again use the fallback-reviewer agent, then mark-reviewed --by claude-fallback --files "..." and tell the user.`
        : `Run (background): ${GPT} review ${P} --task "<goal + user requirements>".`;
      parts.push(`GPT review needed — unreviewed changes:\n${files}\n${how}\nFinal-round fixes: mark-reviewed ${P} --by claude-final --files "..." --note "...". User declined: --by user-declined.`);
    }
    return out({ decision: 'block', reason: parts.join('\n\n') + '\nPausing mid-task or waiting on the user? Say so in one line and stop.' });
  },

  'pre-plan'(inp) {
    const cfg = L.loadConfig();
    const root = rootOf(inp);
    if (!L.projectSettings(root).plans) return out();
    const s = L.readState(root);
    const fresh = L.minutesAgo(s.planReviewedAt, cfg.planReviewValidMinutes);
    const presented = (inp.tool_input || {}).plan;
    if (presented) {
      // Plan text available: it must be the reviewed plan or a light revision of it (>= 80% identical
      // lines) — whichever turn the review ran in.
      if (fresh && L.textSimilarity(presented, s.planReviewedText) >= 0.8) return out();
    } else if (fresh && s.planReviewedTurn && s.planReviewedTurn === (s.userTurnAt || s.turnStartedAt)) {
      // No plan text from Claude Code: accept a review started in this same turn.
      return out();
    }
    if (L.minutesAgo(s.gptUnavailableAt, cfg.unavailableCooldownMinutes)) return out();
    return deny(`Plans must be reviewed by GPT before presenting them. Save the plan to a temp file and run: ${GPT} plan --project "${root}" --file <plan.md>  (run_in_background). Weigh GPT's points, revise the plan (you make the final call), mention notable GPT input in the plan, then call ExitPlanMode again.`);
  },

  // The one hook that fails CLOSED: any unexpected error while checking desktop ownership denies the tool
  // (fail-open here could let Claude and GPT drive the same desktop).
  'pre-computer'(inp) {
    try { return computerGate(inp); } catch (e) {
      survived('ownership check', e);
      return deny(`Desktop ownership could not be checked (${e.message}). Retry in a moment; if it persists run ${GPT} doctor.`);
    }
  },
};

// Everything here finishes well inside the hook's 15-s timeout (a timed-out hook would let the tool run;
// the registration also says onFailure: block): no waiting writes before the ownership step, which itself
// waits at most until DESKTOP_DEADLINE.
const DESKTOP_DEADLINE = T0 + 10000;
function computerGate(inp) {
    const cfg = L.loadConfig(false); // (no Codex discovery: it can take seconds)
    // read-only project lookup (sessionRoot may wait to record a new session)
    const root = L.knownSessionRoot(inp.session_id) || path.resolve(inp.cwd || '.');
    const g = L.readState(L.HOME); // global (cross-project) computer-use state
    // One operator at a time. Claude's use is allowed only through ONE locked step that checks that no
    // GPT computer run (bridge or its Codex worker) owns the desktop and records Claude's use — so a GPT
    // run can't slip in between the check and the record.
    // Another Claude session that used the desktop in the last 2 minutes also owns it.
    const sid = inp.session_id || 'unknown';
    const allow = () => {
      const r = L.updateState(L.HOME, s => {
        const o = s.computerLock;
        if (o && (L.pidAlive(o.pid) || L.pidAlive(o.childPid))) return o;
        if (s.claudeCuSession && s.claudeCuSession !== sid && Date.now() - (s.claudeCuLastUse || 0) < 120000) return { claude: true };
        s.claudeCuLastUse = Date.now(); s.claudeCuSession = sid;
      }, true, Math.max(0, DESKTOP_DEADLINE - Date.now()));
      if (r && r.lockFailed) return deny('Desktop ownership could not be checked right now (state busy). Retry in a moment.');
      if (r && r.claude) return deny('Another Claude session is operating the desktop (last action < 2 min ago). Wait for it to finish, then retry.');
      if (r) return deny(`GPT is operating the desktop right now (${r.project}). Wait for that run to finish, then retry.`);
      return out();
    };
    if (L.projectSettings(root).computerUse === 'claude') return allow();
    if ((g.claudeCuUntil || 0) > Date.now()) return allow();
    if (L.minutesAgo(g.gptUnavailableAt, cfg.unavailableCooldownMinutes)) return allow();
    return deny(`Computer use is delegated to GPT. First check whether files/logs/CLI/API/browser tools can do it instead (e.g. MT5 logs and tester reports are files). If computer use is really needed, run: ${GPT} computer --task "<precise goal, app name, what to report back>" (run_in_background). ` +
      `Only if delegating is clearly worse here (tight see-act loop with your own edits, GPT already failed this task, or the user asked you personally) run: ${GPT} allow-claude-cu --reason "<why>" and retry.`);
}

Object.assign(handlers, {
  // Session start: surface setup problems early (cached for an hour) and show the project's lessons.
  session(inp) {
    const root = rootOf(inp);
    const msgs = [];
    const g = L.readState(L.HOME);
    let failed = g.doctorFailed || [];
    // Re-check hourly, and immediately after Codex was updated (its entry file changed).
    let codexStamp = '';
    try { codexStamp = String(require('fs').statSync(L.loadConfig().codexJs).mtimeMs); } catch {}
    if (!g.doctorAt || Date.now() - g.doctorAt > 3600000 || g.doctorCodexStamp !== codexStamp) {
      failed = L.quickChecks().filter(c => !c.ok).map(c => `${c.name}: ${c.info}`);
      L.updateState(L.HOME, s => { s.doctorAt = Date.now(); s.doctorFailed = failed; s.doctorCodexStamp = codexStamp; });
    }
    const sw = L.setupSwitch(root);
    if (sw.off) {
      msgs.push(switchNote(sw));
      if (inp.session_id) try { L.updateState(L.HOME, s => { s.reminders = s.reminders || {}; (s.reminders[inp.session_id] = s.reminders[inp.session_id] || { at: Date.now(), shown: [] }).switchTold = 'off'; }); } catch (e) { survived('switch note', e); }
    } else if (failed.length) msgs.push(`[GPT setup problem] ${failed.join('; ')}. GPT calls may fail; run: ${GPT} doctor --live, and tell the user.`);
    const lessons = L.readLessons(root);
    if (lessons.length) msgs.push(`[Project lessons — confirmed past mistakes in this project; avoid repeating them]\n${lessons.join('\n')}`);
    try { L.cleanup(); } catch (e) { survived('cleanup', e); }
    if (!msgs.length) return out();
    return out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msgs.join('\n') } });
  },

  prompt(inp) {
    const root = rootOf(inp);
    const ps = L.projectSettings(root);
    const p = String(inp.prompt || '');
    // Automatic messages (background-task notifications, system reminders) are not a new user request:
    // no reminders, and no new turn (otherwise every notification re-arms the Stop blocks).
    if (/^\s*(<task-notification>|<system-reminder>|<cross-session-message|\[SYSTEM NOTIFICATION|\[MESSAGE FROM NON-USER SOURCE|\[Cross-session (delivery|idle) notice\])/i.test(p)) {
      // A notification that re-activates a turn which already ended: if that turn started nothing in the
      // background that could write files (only read-only GPT runs), open a fresh discovery window, so
      // edits the user made after the turn ended aren't taken for Claude's. Otherwise keep the window: a
      // background job's own changes are only visible there.
      if (ps.review) try {
        const s0 = L.readState(root);
        if (s0.turnClosedAt && s0.turnClosedAt >= (s0.turnStartedAt || 0) && s0.bgWriterTurn !== s0.turnStartedAt) startWindow(root, ps, true, inp.session_id);
      } catch (e) { survived('continuation', e); }
      return out();
    }
    startWindow(root, ps, false, inp.session_id);
    // The on/off switch: tell this session when it differs from what it was last told (a session starts
    // out on, from CLAUDE.md), and remember whether this user message asks to switch off (see pre-bash).
    const sw = L.setupSwitch(root), now = sw.off ? 'off' : 'on';
    let switchMsg = null;
    if (inp.session_id) try {
      const r0 = ((L.readState(L.HOME).reminders || {})[inp.session_id]) || {}, asked = asksOff(p);
      if ((r0.switchTold || 'on') !== now) switchMsg = switchNote(sw);
      // offAskedFor: the user turn the request belongs to (startWindow just set it); gpt.js off accepts the
      // flag only for the current turn, so a failed write here can never leave an old "yes" usable.
      if (switchMsg || asked || r0.offAsked) L.updateState(L.HOME, g => {
        g.reminders = g.reminders || {};
        const r = g.reminders[inp.session_id] = g.reminders[inp.session_id] || { at: Date.now(), shown: [] };
        r.switchTold = now; r.offAsked = asked; r.offAskedFor = asked ? L.readState(root).userTurnAt : null;
      });
    } catch (e) { survived('switch note', e); }
    const msgs = [];
    if (ps.ideas && /\b(plan|plans|planning|idea|ideas|suggest|suggestions?|advice|advise|recommend\w*|should (i|we)|approach|architect\w*|design|brainstorm|strategy|better way|improve\w*|opinion|what do you think|pros and cons|trade-?offs?)\b/i.test(p)) {
      msgs.push(`[GPT consult] This request may call for plans/ideas/recommendations. If your answer will contain substantive ones, get a second opinion first: ${GPT} idea --file <draft.md> (or plan). You make the final call; mention useful GPT input. Skip for trivial answers.`);
    }
    if (/\b(computer use|screen|click|desktop app|metatrader|mt5|mt4|terminal window|gui)\b/i.test(p) && ps.computerUse !== 'claude') {
      msgs.push(`[Computer use] Prefer files/logs/CLI/APIs first. If screen control is needed, delegate to GPT: ${GPT} computer --task "...".`);
    }
    if (!sw.off && /\b(readme|document\w*|docs?|guide|report|write-?up|manual|proposal|presentation|slides?|changelog|word file|docx)\b/i.test(p)) {
      msgs.push(`[GPT writer] Medium/long document work goes to GPT: ${GPT} write --files "<exact doc paths>" --brief-file <brief.md>, then review the diff and apply/revise/discard. Small edits: do them yourself.`);
    }
    if (!sw.off && /\b(logs?|journal|tester|backtest|report|stack ?trace|build output|errors?|crash\w*|why (is|does|did)|not working|failing|fails?)\b/i.test(p)) {
      msgs.push(`[GPT digest] Large logs/reports/build output: let GPT read them first — ${GPT} digest --question "..." --files "<paths>" — then read only the lines it cites.`);
    }
    // Each reminder type at most once per session: the rules are already in CLAUDE.md, so repeating
    // them on every matching prompt only costs Claude tokens.
    let fresh = msgs;
    if (inp.session_id && msgs.length) {
      fresh = L.updateState(L.HOME, g => {
        g.reminders = g.reminders || {};
        for (const [sid, r] of Object.entries(g.reminders)) if (Date.now() - r.at > 2 * 86400000) delete g.reminders[sid];
        const r = g.reminders[inp.session_id] = g.reminders[inp.session_id] || { at: Date.now(), shown: [] };
        const kind = m => m.slice(0, m.indexOf(']') + 1);
        const show = msgs.filter(m => !r.shown.includes(kind(m)));
        r.shown.push(...show.map(kind));
        return show;
      }) || msgs;
    }
    if (switchMsg) fresh = [switchMsg, ...fresh];
    if (!fresh.length) return out();
    return out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: fresh.join('\n') } });
  },
});

try {
  handlers['pre-write'] = handlers['pre-edit']; // older settings.json used this name
  const h = handlers[process.argv[2]];
  if (!h) out();
  const input = readInput();
  if (EVENT !== 'pre-computer') noteFields(input); // (its state write could wait; the desktop check must not)
  h(input);
} catch (e) {
  survived('error', e);
  process.stderr.write('gpt gate error (ignored): ' + e.message + '\n');
  process.exit(0);
}
