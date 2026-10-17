// Shared helpers for gpt.js (CLI) and gate.js (hooks).
//
// STATE CONTRACT — per project: state/<key>.json, changed only through updateState (locked, atomic).
//   changes[file]        one record per file. Pending = at > max(reviewedAt, top-level reviewedAt).
//     lines, sensitive   size/sensitivity of the pending change (decide whether Stop asks for a review)
//     at                 time of the current version; reviewedAt: last review covering the file
//     deleted            the file is absent in the tracked version
//     basePre, baseAt    the saved baseline predates every pending change / which review set it
//     shellTouched, viaShell, viaDisk   changed outside Edit/Write; hash: content after Claude's last edit
//     committed, sinceRev  committed during a turn; diff base for the review
//     openFindings       [review logs] still open; reviewStatus: last outcome
//   reviewedAt, reviewedBy, lastReview   last acknowledgement (gpt.js markReviewed)
//   running[pid]         live gpt.js reviews: cutoff, files (lower-case), hashes of the frozen copies, sig
//   userTurnAt           the user's turn (once-per-turn Stop blocks: stopBlockedTurn / findingsBlockedTurn;
//                        planReviewedTurn); turnStartedAt: the discovery window (a continuation may restart it)
//   turnHead, turnBaselineDeleted   git HEAD / deletions at window start; turnClosedAt: an allowed Stop
//   bgWriterTurn         window in which a possibly-writing background command started
//   preWrite             pre-edit snapshots per tool call; planReviewedAt/Text; gptUnavailableAt/Reason;
//                        shellScanPartial; lastBulkShell; pendingNoteSig (the pending set the last Stop note named)
//   notAuthored          [{file, why, at}] newest 50 disk changes not tracked: copies, moves, branch switches
//   setupSwitch          {state: 'on'|'off', at} this project's own on/off switch (gpt.js on|off);
//                        setupSwitchLog: its last 50 switches (when the setup was on, for dating changes)
//   Side files: <key>.json.turn.json (turn-start fingerprints), <key>.json.bash-<tool id>.json (shell snapshots);
//   baseline/<key>/ (reviewed versions); logs/<project>/ (logs, answers, .frozen round copies, index.tsv).
// Global state (HOME): sessionRoots, computerLock, claudeCuUntil/LastUse/Session, limitUntil, seenFields,
//   reminders, doctor cache, lastCleanup, setupWrites (this setup's files written via Edit/Write: session,
//   content, time), docsCheck (the MQL5 docs server's last handshake), setupSwitchAll (+ setupSwitchAllLog:
//   gpt.js on|off --all).
//   Writers: gate.js (hooks) and gpt.js;
//   both read everything.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = path.join(os.homedir(), '.claude', 'gpt');
const STATE_DIR = path.join(HOME, 'state');
const LOG_DIR = path.join(HOME, 'logs');

const PROJECT_DEFAULTS = { review: true, plans: true, ideas: true, computerUse: 'gpt', effort: 'auto' };

const CODE_EXT = new Set(('js mjs cjs ts tsx jsx py pyw mq4 mq5 mqh cs cpp cc cxx c h hpp java kt kts go rs rb php ' +
  'swift m mm scala dart lua r jl sql sh bash zsh ps1 psm1 bat cmd vue svelte astro html htm css scss sass less ' +
  'ex exs erl hs ml fs fsx clj groovy pl pm sol ipynb zig nim v vb gd').split(' '));

// Sensitive file names are matched as WHOLE WORDS of the file/folder name (split on separators and
// camelCase), so "plotting.py", "border.css" or "session_view.js" no longer force a review of every
// tiny edit — only e.g. "risk.py", "OrderManager.mq5", "auth/login.py".
const SENSITIVE_WORDS = new Set(('auth authentication authorization login logout password passwd credential credentials token tokens ' +
  'secret secrets payment payments billing checkout wallet money balance trade trades trading trader order orders position ' +
  'positions risk lot lots stoploss sl tp takeprofit expert experts ea delete purge migrate migration migrations schema ' +
  'security crypto permission permissions admin').split(' '));
const HOME_PREFIX = path.resolve(os.homedir()).toLowerCase() + path.sep;
const SENSITIVE_PATH = {
  test(p) {
    // MT5 presets (.set) hold live trading parameters (risk %, lots, SL/TP): a one-line change matters.
    if (/\.set$/i.test(p)) return true;
    // A project's review switches and ignore list: one line can switch reviews off.
    if (/[\\/]\.claude[\\/]gpt\.json$/i.test(p)) return true;
    // Every folder below the user's home (so src/auth/providers/x.js counts) plus the file name; the
    // home path itself (e.g. a user named "admin") never makes everything sensitive.
    let abs = path.resolve(p);
    if (abs.toLowerCase().startsWith(HOME_PREFIX)) abs = abs.slice(HOME_PREFIX.length);
    const parts = abs.split(/[\\/]/).filter(x => x && !/^[a-z]:$/i.test(x));
    return parts.some(part => {
      const w = part.replace(/\.[^.]+$/, '')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // acronyms: "SLManager" -> "SL Manager"
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')    // camelCase: "stopLoss" -> "stop Loss"
        .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      // single words, plus adjacent pairs so "stopLoss"/"take_profit" match "stoploss"/"takeprofit"
      return w.some((x, i) => SENSITIVE_WORDS.has(x) || SENSITIVE_WORDS.has(x + (w[i + 1] || '')));
    });
  },
};
// Content signals of trading, destructive data operations, auth/secrets and dynamic code execution.
// (No generic `exec(` — that is mostly regex.exec — and no plain unlink/rmSync temp-file cleanup.)
const SENSITIVE_CONTENT = /(OrderSend|OrderModify|OrderClose|PositionOpen|PositionClose|PositionModify|CTrade|trade\.(Buy|Sell)|DELETE\s+FROM|DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|rm\s+-rf|shutil\.rmtree|password|bcrypt|jwt|oauth|api[_-]?key|private[_-]?key|\beval\(|child_process|subprocess|os\.system|shell\s*=\s*True)/i;

// Document work GPT may author (gpt.js write). Data formats need --data (Claude confirms no code consumes them).
const DOC_EXT = new Set('md markdown txt rst adoc docx odt rtf pptx odp'.split(' '));
const DATA_EXT = new Set('csv xlsx xls ods'.split(' '));
// Files that look like documents but steer builds, installs or agents — never delegated.
const BLOCKED_NAME = /^(claude|agents|gemini|skill|copilot-instructions|cursorrules|requirements.*|constraints.*|cmakelists|robots|license|licence|notice|codeowners|makefile|dockerfile|procfile)(\.|$)/i;
const BLOCKED_DIR = /[\\/](\.claude|\.codex|\.agents|\.github|\.gitlab|\.vscode|\.idea|\.cursor|\.windsurf|node_modules|\.git|skills)([\\/]|$)/i;

function docTargetProblem(file, allowData) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const name = path.basename(file);
  // Resolve symlink/junction aliases of blocked folders — via the nearest EXISTING ancestor, so a
  // not-yet-created file inside an aliased folder is caught too.
  let real = path.resolve(file), rest = '';
  for (;;) {
    try { real = path.join(fs.realpathSync.native(real), rest); break; } catch {} // .native follows Windows junctions
    const up = path.dirname(real);
    if (up === real) break;
    rest = path.join(path.basename(real), rest);
    real = up;
  }
  if (BLOCKED_DIR.test(path.resolve(file)) || BLOCKED_DIR.test(real)) return 'is inside a tool/agent config folder';
  if (BLOCKED_NAME.test(name)) return 'is a build/agent/legal control file';
  if (DATA_EXT.has(ext)) return allowData ? null : 'is a data file (pass --data only if no code reads it)';
  if (!DOC_EXT.has(ext)) return `has a non-document extension (.${ext || 'none'})`;
  return null;
}

// 'absent' only for a genuinely missing file; permission/sharing/IO errors propagate (abort, don't overwrite).
function fileHash(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (e) { if (e.code === 'ENOENT') return 'absent'; throw e; }
}

// ---- Configuration: every field gpt.js / gate.js read, with its default. validateConfig is shared by the
// runtime loader (an invalid value falls back to its default and is reported by doctor and at session
// start) and restore.js (refuses a bad backup before changing anything).
const CONFIG_DEFAULTS = {
  model: 'gpt-6.1-sol', defaultEffort: 'xhigh', allowedEfforts: ['xhigh'], windowsSandbox: 'unelevated',
  timeoutMinutes: { xhigh: 45 }, maxRounds: 3, minChangedLines: 5, planReviewValidMinutes: 30,
  unavailableCooldownMinutes: 30, claudeComputerUseWindowMinutes: 30,
  // optional
  computerDisableMcp: [], writeDiffMaxLines: 400, evidenceTimeoutMinutes: 10, evidenceTailLines: 120, bulkShellFiles: 15,
  mql5Docs: true, // GPT's runs on MQL5 code get the read-only MQL5 reference (mql5-chm) when it is installed
};
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'], SANDBOXES = ['unelevated', 'elevated'];
// [[field, what it must be]] for every invalid field ([] = valid).
function validateConfig(conf) {
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) return [['config', 'a JSON object']];
  const bad = [];
  const str = v => typeof v === 'string' && v.trim() !== '';
  const num = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!str(conf.model)) bad.push(['model', 'text']);
  // Values Codex accepts (model_reasoning_effort, windows.sandbox) — a typo would only fail inside Codex.
  if (!EFFORTS.includes(conf.defaultEffort)) bad.push(['defaultEffort', `one of ${EFFORTS.join('/')}`]);
  if (!SANDBOXES.includes(conf.windowsSandbox)) bad.push(['windowsSandbox', `one of ${SANDBOXES.join('/')}`]);
  if (!Array.isArray(conf.allowedEfforts) || !conf.allowedEfforts.length || !conf.allowedEfforts.every(e => EFFORTS.includes(e))) bad.push(['allowedEfforts', `a list of ${EFFORTS.join('/')}`]);
  else if (EFFORTS.includes(conf.defaultEffort) && !conf.allowedEfforts.includes(conf.defaultEffort)) bad.push(['defaultEffort', 'one of allowedEfforts']);
  const t = conf.timeoutMinutes;
  if (!t || typeof t !== 'object' || Array.isArray(t) || !Object.values(t).every(num)) bad.push(['timeoutMinutes', 'an object of positive numbers']);
  for (const k of ['maxRounds', 'minChangedLines', 'planReviewValidMinutes', 'unavailableCooldownMinutes', 'claudeComputerUseWindowMinutes']) if (!num(conf[k])) bad.push([k, 'a positive number']);
  for (const k of ['evidenceTimeoutMinutes', 'evidenceTailLines', 'writeDiffMaxLines', 'bulkShellFiles']) if (k in conf && !num(conf[k])) bad.push([k, 'a positive number']);
  for (const k of ['codexJs', 'metaeditorPath']) if (k in conf && typeof conf[k] !== 'string') bad.push([k, 'text']);
  if ('computerDisableMcp' in conf && !(Array.isArray(conf.computerDisableMcp) && conf.computerDisableMcp.every(str))) bad.push(['computerDisableMcp', 'a list of MCP server names']);
  if ('mql5Docs' in conf && typeof conf.mql5Docs !== 'boolean') bad.push(['mql5Docs', 'true or false']);
  return bad;
}

// `findCodex` false: skip looking for a moved Codex install (`npm root -g` can take seconds).
function loadConfig(findCodex = true) {
  let cfg, problems = [];
  try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); }
  catch (e) { cfg = {}; problems.push(`config.json unreadable (${e.message}) — using defaults`); }
  for (const [k, need] of validateConfig(cfg)) {
    if (k === 'config') { cfg = {}; problems.push(`config.json must be ${need} — using defaults`); continue; }
    if (!(k in CONFIG_DEFAULTS) && k !== 'defaultEffort') { // optional, no default (codexJs, metaeditorPath): drop it
      delete cfg[k]; problems.push(`${k} must be ${need} — ignored`); continue;
    }
    cfg[k] = k === 'defaultEffort' && Array.isArray(cfg.allowedEfforts) && cfg.allowedEfforts.length ? cfg.allowedEfforts[0]
      : JSON.parse(JSON.stringify(CONFIG_DEFAULTS[k]));
    problems.push(`${k} must be ${need} — using ${JSON.stringify(cfg[k])}`);
  }
  for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) if (!(k in cfg)) cfg[k] = JSON.parse(JSON.stringify(v));
  if (!cfg.allowedEfforts.includes(cfg.defaultEffort)) { problems.push(`defaultEffort ${cfg.defaultEffort} not allowed — using ${cfg.allowedEfforts[0]}`); cfg.defaultEffort = cfg.allowedEfforts[0]; }
  cfg.problems = problems;
  // Configured Codex path missing (other machine/user, reinstalled npm)? Find the global install.
  if (findCodex && (!cfg.codexJs || !fs.existsSync(cfg.codexJs))) {
    const candidates = [path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')];
    try {
      // (one command string: Node warns about an args list with shell: true, DEP0190)
      const g = spawnSync('npm root -g', { encoding: 'utf8', shell: true, timeout: 8000, windowsHide: true });
      if (g.status === 0) candidates.push(path.join(g.stdout.trim(), '@openai', 'codex', 'bin', 'codex.js'));
    } catch {}
    const found = candidates.find(c => c && fs.existsSync(c));
    if (found) cfg.codexJs = found;
  }
  return cfg;
}

// ---- Hook trace: problems the hooks survived (they fail open, so nothing else would show them) and
// per-hook timings — read by `gpt.js doctor` / `stats`. Both files are capped (oldest half dropped).
const HOOK_LOG = path.join(LOG_DIR, 'hooks.log'), HOOK_TIMES = path.join(LOG_DIR, 'hook-times.tsv');
function appendCapped(f, line, max = 512 * 1024) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(f).size > max) { const t = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, t.slice(t.indexOf('\n', t.length / 2) + 1)); } } catch {}
    fs.appendFileSync(f, line + '\n');
  } catch {}
}
function hookIssue(where, msg) { appendCapped(HOOK_LOG, `${new Date().toISOString()}\t${where}\t${String(msg).replace(/\s+/g, ' ').slice(0, 300)}`); }
function hookTime(event, ms) { appendCapped(HOOK_TIMES, `${Date.now()}\t${event}\t${ms}`); }
function recentHookIssues(hours = 24) {
  try {
    const since = Date.now() - hours * 3600000;
    return fs.readFileSync(HOOK_LOG, 'utf8').trim().split('\n').map(l => l.split('\t')).filter(([t]) => Date.parse(t) >= since);
  } catch { return []; }
}

function norm(p) { return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function key(root) { return crypto.createHash('sha1').update(norm(root)).digest('hex').slice(0, 12); }
function slug(root) {
  return (path.basename(path.resolve(root)) || 'root').replace(/[^\w.-]+/g, '_') + '-' + key(root).slice(0, 6);
}

// Remembered per process (a hook asks several times; each git call costs tens of ms on Windows).
const gitRoots = new Map();
function gitRoot(dir) {
  const k = path.resolve(dir || '.').toLowerCase();
  if (gitRoots.has(k)) return gitRoots.get(k);
  let top = null;
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) top = path.resolve(r.stdout.trim());
    // "not a git repository" (or a folder that's gone) is a normal answer; anything else — git missing, a
    // timeout, "dubious ownership" — means repo tracking is off here without anyone knowing: trace it.
    else if (fs.existsSync(dir || '.') && (r.error || !/not a git repository/i.test(r.stderr || ''))) gitFailed(`git rev-parse in ${dir}`, r);
  } catch {}
  gitRoots.set(k, top);
  return top;
}

function statePath(root) { return path.join(STATE_DIR, key(root) + '.json'); }

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// A missing file is a fresh project. A file that stays unreadable or invalid after retries (a virus scanner
// holding it, damage) is NOT treated as empty: the result carries `_unreadable`, so updateState never writes
// over it, ownership checks refuse, and doctor reports the file.
function readState(root) {
  let err = null;
  for (let i = 0; i < 5; i++) {
    try {
      const s = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
      if (s && typeof s === 'object' && !Array.isArray(s)) return s;
      err = new Error('not a JSON object');
    } catch (e) { if (e.code === 'ENOENT') return { root: path.resolve(root), changes: {} }; err = e; }
    sleep(20 * (i + 1));
  }
  const s = { root: path.resolve(root), changes: {} };
  Object.defineProperty(s, '_unreadable', { value: err ? err.message : 'unreadable' }); // not saved with the state
  return s;
}

// Atomic replace so readers never see a half-written file.
function writeState(root, s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  s.root = path.resolve(root);
  s.changes = s.changes || {};
  const tmp = `${statePath(root)}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, statePath(root));
}

// Read-modify-write under a per-project lock (parallel hooks must not lose each other's updates).
// Callers keep slow work (git scans) OUTSIDE fn so the lock is held for milliseconds. If the lock
// still can't be taken within `waitMs` (8 s) — or the state file can't be read — fn runs on a fresh copy but
// nothing is written (fail open, never clobber; traced for doctor).
// `strict`: for ownership records (e.g. the computer lock) — without the lock, a readable state or a
// successful save (any failure, from creating the folder to releasing the lock), the result is
// { lockFailed: true }, so the caller refuses instead of proceeding unrecorded.
function updateState(root, fn, strict, waitMs = 8000) {
  const lock = statePath(root) + '.lock';
  let got = false;
  const release = () => {
    if (!got) return;
    got = false;
    try { fs.rmSync(lock, { recursive: true, force: true }); }
    catch (e) { hookIssue('state lock', `could not release ${path.basename(lock)} (${e.message}); it is reclaimed after 15 s`); }
  };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      try { fs.mkdirSync(lock); got = true; break; } catch {
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 15000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
        sleep(25);
      }
    }
    if (!got && strict) return { lockFailed: true };
    if (!got) hookIssue('state lock', `busy for ${Math.round(waitMs / 1000)} s — update of ${path.basename(statePath(root))} not saved`);
    const s = readState(root);
    if (s._unreadable) {
      hookIssue('state', `${statePath(root)} unreadable (${s._unreadable}) — left as it is, update not saved; move it aside to start fresh`);
      if (strict) return { lockFailed: true, unreadable: true };
    }
    const result = fn(s);
    if (got && !s._unreadable) writeState(root, s);
    return result;
  } catch (e) {
    // An ownership record that can't be saved must never count as recorded.
    if (!strict) throw e;
    hookIssue('state', `${path.basename(statePath(root))}: ownership update failed (${e.message})`);
    return { lockFailed: true, error: e.message };
  } finally { release(); }
}

// Resolve the project root for a directory: the deepest already-tracked root that
// contains it (so gpt.js run from a subfolder hits the session's state), else git root, else dir.
// One project per Claude session: the first directory a session reports (normally its project folder)
// is kept for the whole session, so `cd` inside the session can't split its tracking into several
// projects. Hooks pass the session id; gpt.js reads CLAUDE_CODE_SESSION_ID from its environment.
function sessionRoot(sessionId, cwd) {
  const fallback = path.resolve(process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd());
  if (!sessionId) return fallback;
  const known = (readState(HOME).sessionRoots || {})[sessionId];
  if (known) return known.root;
  return updateState(HOME, g => {
    g.sessionRoots = g.sessionRoots || {};
    for (const [k, v] of Object.entries(g.sessionRoots)) if (Date.now() - v.at > 14 * 86400000) delete g.sessionRoots[k];
    if (!g.sessionRoots[sessionId]) g.sessionRoots[sessionId] = { root: fallback, at: Date.now() };
    return g.sessionRoots[sessionId].root;
  }) || fallback;
}
function knownSessionRoot(sessionId) {
  return sessionId ? ((readState(HOME).sessionRoots || {})[sessionId] || {}).root : undefined;
}

function findRoot(dir) {
  const d = norm(dir);
  let best = null;
  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')).root;
        const n = norm(r);
        if ((d === n || d.startsWith(n + '/')) && (!best || n.length > norm(best).length)) best = r;
      } catch {}
    }
  } catch {}
  return best || gitRoot(dir) || path.resolve(dir);
}

// Per-project switches: <project or ancestor>/.claude/gpt.json. Unknown or invalid values are ignored
// (the default applies) and listed in `_problems` (shown by `gpt.js status`).
const PROJECT_RULES = { review: v => typeof v === 'boolean', plans: v => typeof v === 'boolean', ideas: v => typeof v === 'boolean',
  computerUse: v => v === 'gpt' || v === 'claude', effort: v => v === 'auto' || EFFORTS.includes(v),
  ignore: v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim()) };
// The setup's on/off switch (gpt.js on|off [--all]), kept in state so it lasts until switched back, with no
// settings file to change (nothing to review or release): a project's own `setupSwitch`, else the global
// `setupSwitchAll` (gpt.js on|off --all resets the projects' own).
function setupSwitch(root) {
  const own = root ? readState(root).setupSwitch : null, all = readState(HOME).setupSwitchAll;
  const s = own || all;
  return { off: !!s && s.state === 'off', scope: own ? 'project' : all ? 'all' : null, at: (s && s.at) || null };
}
// (from, to) => whether the setup was off for the WHOLE time from `from` to `to`, from the switch histories
// (setupSwitchLog, with a 'reset' entry where an --all switch cleared it / setupSwitchAllLog). Only a change made
// within such a span is left uncounted: one whose file changed while on and again while off can't be
// separated, so it counts.
function setupOffThroughout(root) {
  const ownLog = (root && readState(root).setupSwitchLog) || [], allLog = readState(HOME).setupSwitchAllLog || [];
  const own = ownLog.map(e => ({ ...e, own: true }));
  const ev = own.concat(allLog).sort((a, b) => a.at - b.at);
  // a span starting before a full (so possibly pruned, 50-entry) history can't be judged: count it
  const known = t => !(ownLog.length >= 50 && t < ownLog[0].at) && !(allLog.length >= 50 && t < allLog[0].at);
  // A history that disagrees with the live switch now (an older format, a hand edit) can't be trusted:
  // then every change counts.
  let ro = null, rg = null;
  for (const e of ev) { if (e.own) ro = e.state === 'reset' ? null : e.state; else rg = e.state; }
  if (((ro || rg || 'on') === 'on') === setupSwitch(root).off) return () => false;
  return (from, to) => {
    if (!known(from)) return false;
    let o = null, g = null, i = 0;
    const on = () => (o || g || 'on') === 'on';
    // own events: on / off, or 'reset' (cleared by an --all switch, at the moment that reset happened)
    const apply = e => { if (e.own) o = e.state === 'reset' ? null : e.state; else g = e.state; };
    for (; i < ev.length && ev[i].at <= from; i++) apply(ev[i]);
    if (on()) return false;
    for (; i < ev.length && ev[i].at <= to; i++) { apply(ev[i]); if (on()) return false; }
    return true;
  };
}
// A fresh discovery window from `startedAt`: turn-start fingerprints (when `ctx` has git status entries),
// HEAD and deletions. The prompt hook starts one per user message (after scanning the previous one); switching
// the setup on starts one too, so a scan never spans a switch. `carry`: the same user turn continues.
// Returns an error from fingerprinting, if any (the caller logs it).
function startDiscoveryWindow(root, ctx, carry, startedAt = Date.now()) {
  const deleted = gitDeleted(root), head = gitHead(root);
  let printsError = null;
  if (ctx && ctx.entries) try { saveTurnPrints(root, startedAt, ctx); } catch (e) { printsError = e; }
  updateState(root, s => {
    s.turnStartedAt = startedAt;
    if (!carry || !s.userTurnAt) s.userTurnAt = startedAt;
    s.turnBaselineDeleted = deleted;
    s.turnHead = head; // commits made during the turn are found from here
    // A file marked deleted that exists again was restored outside the hooks' view: a later deletion
    // of it is a new change.
    for (const [f, c] of Object.entries(s.changes || {})) if (c.deleted && fs.existsSync(f)) c.deleted = false;
    delete s.stopBlockedFor; // fields of an older version of these hooks
    delete s.findingsBlockedFor;
  });
  return printsError;
}

// Switched off: no tracking, reviews, plan or idea checks, and Claude may control the screen itself (the
// one-operator desktop lock still applies).
function projectSettings(root) {
  const ps = projectFileSettings(root), sw = setupSwitch(root);
  return sw.off ? { ...ps, review: false, plans: false, ideas: false, computerUse: 'claude', off: sw } : ps;
}
function projectFileSettings(root) {
  let dir = path.resolve(root);
  for (;;) {
    const f = path.join(dir, '.claude', 'gpt.json');
    if (fs.existsSync(f)) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const out = { ...PROJECT_DEFAULTS, _file: f, _problems: [] };
        const isObj = raw && typeof raw === 'object' && !Array.isArray(raw);
        if (!isObj) out._problems.push(`must be a JSON object, not ${JSON.stringify(raw).slice(0, 40)} — defaults apply`);
        for (const [k, v] of Object.entries(isObj ? raw : {})) {
          if (PROJECT_RULES[k] && PROJECT_RULES[k](v)) out[k] = v; else out._problems.push(`${k}: ${JSON.stringify(v)} ignored`);
        }
        return out;
      } catch (e) { return { ...PROJECT_DEFAULTS, _file: f, _problems: [`unreadable (${e.message}) — defaults apply`] }; }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { ...PROJECT_DEFAULTS };
}

// Per-project `ignore` globs (.claude/gpt.json), e.g. ["evidence/**", "app/server.mjs"]: files the hooks
// don't track (generated reports, bundles). Patterns are relative to the folder that holds .claude/gpt.json;
// "**" spans folders, "*" and "?" stay within one name, a pattern without "/" matches that name in any
// folder, and a pattern that matches a folder covers everything in it. Never ignored: files outside that
// folder, and tool config (.claude/, .codex/ — the switches themselves). The hooks also stop applying the
// list while gpt.json itself has an unreviewed change (see gate.js).
function globRegex(g) {
  let pat = g.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  const anyDir = !pat.includes('/');
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '*' && pat[i + 1] === '*') {
      if (pat[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anyDir ? '(?:.*/)?' : ''}${re}$`, 'i');
}
function ignoredByProject(ps, abs) {
  if (!ps || !ps._file || !Array.isArray(ps.ignore) || !ps.ignore.length) return false;
  const rel = path.relative(path.dirname(path.dirname(ps._file)), path.resolve(abs)).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) || /(^|\/)\.(claude|codex)\//i.test(rel)) return false;
  if (!ps._ignoreRe) Object.defineProperty(ps, '_ignoreRe', { value: ps.ignore.map(globRegex) }); // (not saved/printed)
  const res = ps._ignoreRe;
  // the file itself, or one of its folders
  const parts = rel.split('/'), cands = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  return res.some(re => cands.some(c => re.test(c)));
}

// Config that executes or controls behaviour is reviewed like code.
const REVIEWABLE_CONFIG = /((^|[\\/])(dockerfile|docker-compose[^\\/]*\.ya?ml|makefile|package\.json|pyproject\.toml|requirements[^\\/]*\.txt|cargo\.toml|go\.mod|[^\\/]+\.set)$)|([\\/]\.github[\\/]workflows[\\/])|([\\/]\.claude[\\/](settings[^\\/]*\.json|gpt\.json|gpt[\\/]config\.json|agents[\\/]))|([\\/]\.codex[\\/]config\.toml$)/i;

// MetaTrader Strategy Tester reports (generated .htm/.html) are output, not code: the names the tester and
// the mql5-coding skill's tester script give them (ReportTester-<login>.html, CodexSmokeReport-<UTC time>-
// <12 hex>.htm), or the tester's own markers in the first 4 KB (the tester writes UTF-16): MT5's generator
// tag, MT4's "Strategy Tester:" title with its version and server tags. A deleted file: the version git
// last had — HEAD's, or with `at` ({ top, revs }) the first of those revisions that has it (a deletion
// committed in the turn: the commit, then the revision before it). Older history is not searched: a path
// can be reused, so an old report there says nothing about the file that was deleted (unknown = code).
const TESTER_REPORT_NAME = /^(Report(Tester|Optimizer)-\d+\.html?|CodexSmokeReport-\d{8}T\d{6}Z-[0-9a-f]{12}\.htm)$/i;
function isTesterReport(abs, at) {
  if (TESTER_REPORT_NAME.test(path.basename(abs))) return true;
  let buf = Buffer.alloc(4096);
  try { const fd = fs.openSync(abs, 'r'); try { buf = buf.slice(0, fs.readSync(fd, buf, 0, buf.length, 0)); } finally { fs.closeSync(fd); } } catch {
    // gone: from the repository top, or the nearest folder that still exists
    let d = at ? at.top : path.dirname(abs);
    while (!fs.existsSync(d)) { const p = path.dirname(d); if (p === d) return false; d = p; }
    const rel = path.relative(d, abs).replace(/\\/g, '/');
    const show = rev => spawnSync('git', ['show', `${rev}:./${rel}`], { cwd: d, timeout: 5000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const r = (at ? at.revs : ['HEAD']).map(show).find(x => x.status === 0 && x.stdout);
    if (!r) return false;
    buf = r.stdout.slice(0, 4096);
  }
  const text = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[1] === 0 && buf[0] > 0) ? buf.toString('utf16le') : buf.toString('utf8');
  return /<meta\s+name="generator"\s+content="strategy tester"/i.test(text) ||
    (/<title>\s*Strategy Tester:/i.test(text) && /<meta\s+name="version"/i.test(text) && /<meta\s+name="server"/i.test(text));
}

// Throwaway files in the OS temp folder (test scaffolding, scratch scripts) are never review material.
const TMP = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
function isCode(file, at) {
  const abs = path.resolve(file || '.');
  if (abs.toLowerCase().startsWith(TMP)) return false;
  const ext = path.extname(abs).slice(1).toLowerCase();
  if ((ext === 'htm' || ext === 'html') && isTesterReport(abs, at)) return false;
  return CODE_EXT.has(ext) || REVIEWABLE_CONFIG.test(abs);
}

function countLines(s) { return s ? String(s).split('\n').length : 0; }

// A change is reviewed when either a full review (s.reviewedAt) or a scoped one (c.reviewedAt) came after it.
function reviewedAtFor(s, c) { return Math.max(s.reviewedAt || 0, (c && c.reviewedAt) || 0); }

function pending(s) {
  return Object.entries(s.changes || {}).filter(([, c]) => c.at > reviewedAtFor(s, c));
}

// Any change to a file with open GPT findings is significant: even a one-line "fix" needs a follow-up review.
function isSignificant(list, cfg) {
  const lines = list.reduce((n, [, c]) => n + (c.lines || 0), 0);
  return lines >= cfg.minChangedLines || list.some(([, c]) => c.sensitive || c.openFindings);
}

// A git command that failed inside a repo: the scan that needed it saw nothing, which must not pass for
// "nothing changed" unnoticed — it is recorded for `gpt.js doctor` / `status` (the hooks still fail open).
function gitFailed(what, r) {
  const why = r.error ? r.error.message : `exit ${r.status}${r.stderr ? ': ' + String(r.stderr).trim().split('\n')[0] : ''}`;
  hookIssue('git', `${what} failed (${why}) — changes in that repo may have been missed`);
}

// `git status -z` entries for a repo: [{xy, abs}] or null when not a git repo (or git failed: recorded).
function gitStatus(root) {
  try {
    const top = gitRoot(root);
    if (!top) return null;
    const r = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: top, encoding: 'utf8', timeout: 8000, maxBuffer: 20 * 1024 * 1024 });
    if (r.status !== 0) { gitFailed(`git status in ${top}`, r); return null; }
    const parts = r.stdout.split('\0');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.length < 4) continue;
      const xy = p.slice(0, 2);
      out.push({ xy, abs: path.join(top, p.slice(3)) });
      // A rename's source counts as a deletion (e.g. helper.js -> helper.txt removes reviewable code).
      if (xy[0] === 'R') { i++; if (parts[i]) out.push({ xy: 'D ', abs: path.join(top, parts[i]) }); }
      else if (xy[0] === 'C') i++; // copy: source is unchanged
    }
    return out;
  } catch { return null; }
}

// Tracked files deleted from the working tree. `ls-files --deleted` skips the untracked-file scan of
// `git status -uall`, so it stays fast in big repos (this runs on every user prompt).
function gitDeleted(root) {
  try {
    const top = gitRoot(root);
    if (!top) return [];
    const run = args => {
      const r = spawnSync('git', args, { cwd: top, encoding: 'utf8', timeout: 8000, maxBuffer: 20 * 1024 * 1024 });
      if (r.status !== 0) { gitFailed(`git ${args.slice(0, 2).join(' ')} in ${top}`, r); return []; }
      return r.stdout.split('\0').filter(Boolean);
    };
    // Unstaged deletions + staged ones (`git rm`), without scanning untracked files.
    // Staged renames: "R100\0old\0new" — the old name counts as deleted (same as gitStatus does).
    const ren = run(['diff', '--cached', '--name-status', '--diff-filter=R', '-z']);
    const renSources = ren.filter((x, i) => i > 0 && /^R\d*$/.test(ren[i - 1]));
    const rel = new Set([...run(['ls-files', '--deleted', '-z']), ...run(['diff', '--cached', '--name-only', '--diff-filter=D', '-z']), ...renSources]);
    return [...rel].map(f => path.join(top, f));
  } catch { return []; }
}

// Reviewable files changed on disk (git repos only) — catches edits/deletions made via Bash.
// Modified: mtime after `since`. Deleted: not already deleted at turn start (`baselineDeleted`).
function gitHead(root) {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) return r.stdout.trim();
    // no repo, or a repo without commits yet: normal (null); anything else is traced
    if (fs.existsSync(root) && (r.error || !/not a git repository|unknown revision|ambiguous argument 'HEAD'|needed a single revision/i.test(r.stderr || ''))) gitFailed(`git rev-parse HEAD in ${root}`, r);
    return null;
  } catch { return null; }
}

// Reviewable files changed by commits CREATED during the turn: HEAD moved forward from `rev`, and the
// commit was authored by this machine's git user at/after `since`. Branch switches (HEAD not ahead of
// rev), pulls/rebases of other people's work, and merge commits are ignored.
function gitCommittedSince(root, rev, since) {
  try {
    const top = gitRoot(root);
    // `rev` null = no commit existed at turn start (new repo): the reflog time filter alone decides.
    if (!top || (rev && gitHead(top) === rev)) return [];
    const git = (...a) => spawnSync('git', a, { cwd: top, encoding: 'utf8', timeout: 8000, maxBuffer: 20 * 1024 * 1024 });
    // HEAD's reflog says exactly which commits were CREATED here ("commit: ...", also amend/initial)
    // and when — unlike checkouts, pulls, merges or rebases, which have other reflog subjects.
    const log = git('reflog', '--date=unix', '--format=%H%x09%gd%x09%gs', '-n', '200');
    // (a repo without any commit has no reflog yet: nothing to find, not a failure)
    if (log.status !== 0) { if (gitHead(top)) gitFailed(`git reflog in ${top}`, log); return []; }
    const entries = log.stdout.split('\n').map(l => l.split('\t')).filter(([h]) => h);
    const mine = []; // [commit, what to compare it against]
    entries.forEach(([h, gd, subj], i) => {
      const t = Number(((gd || '').match(/\{(\d+)\}/) || [])[1]) * 1000;
      if (!t || t < (since || 0) - 1000 || !/^commit( \((amend|initial)\))?:/.test(subj || '')) return;
      // An amend is compared with the commit it replaced (previous HEAD), not its parent, so a
      // message-only amend changes nothing; other commits are compared with their parent.
      mine.push([h, /^commit \(amend\)/.test(subj) && entries[i + 1] ? entries[i + 1][0] : null]);
    });
    const seen = new Map();
    for (const [h, against] of mine) {
      const r = against ? git('diff', '--name-status', '-z', '--no-renames', against, h)
        : git('diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', h);
      if (r.status !== 0) { gitFailed(`listing the files of commit ${h.slice(0, 8)} in ${top}`, r); continue; }
      const parts = r.stdout.split('\0').filter(Boolean);
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const abs = path.join(top, parts[i + 1]);
        // (a file gone from disk: judged by its version in the commit, or before it for a deletion)
        if (seen.has(abs.toLowerCase()) || !isCode(abs, { top, revs: [h, against || `${h}^`] })) continue;
        const deleted = !fs.existsSync(abs);
        let mtime = Date.now();
        try { if (!deleted) mtime = fs.statSync(abs).mtimeMs; } catch {}
        seen.set(abs.toLowerCase(), { abs, deleted, mtime, committed: true });
      }
    }
    return [...seen.values()];
  } catch { return []; }
}

// Modified: file time after `since`. With turn-start fingerprints (`prints`, see saveTurnPrints) content
// decides instead: a file dirty at turn start changed only if its content differs now; a file clean at
// turn start that is dirty now changed even with an old file time (`byContent`: copies that keep the
// source's time). Git-ignored reviewable config (never in git status) is compared by content too.
// `ctx` may carry the already-fetched git status entries and walk, and the turn-start revision (turnHead).
function gitChangedCode(root, since, baselineDeleted, prints, ctx = {}) {
  const base = new Set((baselineDeleted || []).map(f => path.resolve(f).toLowerCase()));
  const dirty = lowerKeys(prints && prints.dirty);
  const out = [], inStatus = new Set();
  for (const e of ctx.entries || gitStatus(root) || []) {
    if (!isCode(e.abs)) continue;
    const k = e.abs.toLowerCase();
    inStatus.add(k);
    if (e.xy.includes('D')) {
      if (!fs.existsSync(e.abs)) { if (!base.has(k)) out.push({ abs: e.abs, deleted: true, mtime: 0 }); continue; }
      // Still on disk: only removed from the index (`git rm --cached`) — a change only if its content
      // changed too (the file may now be ignored, so nothing else would show it).
      if (!prints) continue;
      const was = dirty.get(k);
      if (dirty.has(k) ? !was || was === printOf(e.abs) : !differsFromRev(root, ctx.turnHead, e.abs)) continue;
      let mtime = 0; try { mtime = fs.statSync(e.abs).mtimeMs; } catch {}
      out.push({ abs: e.abs, deleted: false, mtime, byContent: mtime <= since });
      continue;
    }
    let mtime; try { mtime = fs.statSync(e.abs).mtimeMs; } catch { continue; }
    const entry = { abs: e.abs, deleted: false, mtime, untracked: e.xy === '??' };
    if (prints && dirty.has(k) && dirty.get(k)) { // dirty at turn start: changed only if the content differs
      if (dirty.get(k) !== printOf(e.abs)) out.push({ ...entry, byContent: mtime <= since });
    } else if (mtime > since) out.push(entry);
    // clean at turn start, dirty now with an old file time: changed only if it differs from the turn-start
    // commit (not just a moved HEAD/index, e.g. `git reset HEAD~1` or `git rm --cached`)
    else if (prints && !dirty.has(k) && differsFromRev(root, ctx.turnHead, e.abs)) out.push({ ...entry, byContent: true });
  }
  if (prints) {
    // Dirty at turn start, clean or gone now: the user's uncommitted work was restored to HEAD (`git
    // restore`/`checkout`) or an untracked file was deleted. (Committed unchanged: same content, no change.)
    for (const [k, p] of dirty.originals) {
      if (inStatus.has(k) || !isCode(p)) continue;
      if (!fs.existsSync(p)) { out.push({ abs: p, deleted: true, mtime: 0 }); continue; }
      const was = dirty.get(k);
      if (!was || was === printOf(p)) continue;
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
      out.push({ abs: p, deleted: false, mtime, byContent: mtime <= since });
    }
    // Git-ignored reviewable config (presets, settings): created, changed (by content, any file time) or
    // deleted since the turn start. Turn files from before config tracking only knew .set presets.
    const watched = prints.configs ? p => isTurnConfig(p, root) : p => /\.set$/i.test(p);
    const confs = lowerKeys(prints.configs || prints.sets);
    const complete = prints.configs ? prints.configsComplete : prints.setsComplete;
    const walk = ctx.walk || (ctx.walk = codeSnapshot(root));
    const now = new Map(Object.keys(walk.files).filter(watched).map(p => [p.toLowerCase(), p]));
    const cand = new Map([...now].filter(([k]) => !inStatus.has(k)));
    // gone since the turn start (only knowable when both walks were complete)
    if (complete && !walk.truncated) for (const [k, p] of confs.originals) if (!now.has(k) && !inStatus.has(k) && watched(p)) cand.set(k, p);
    const ignored = gitIgnored(root, [...cand.values()]);
    for (const [k, p] of cand) {
      if (!ignored.has(k)) continue; // tracked config is covered by git status
      if (!now.has(k)) { if (!fs.existsSync(p)) out.push({ abs: p, deleted: true, mtime: 0 }); continue; }
      let mtime; try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
      const was = confs.get(k);
      const changed = confs.has(k) ? (was ? was !== printOf(p) : mtime > since) : complete || mtime > since;
      if (changed) out.push({ abs: p, deleted: false, mtime, untracked: true, byContent: mtime <= since });
    }
  }
  const seen = new Set(); // one entry per file (an index removal also lists the file as untracked)
  return out.filter(d => !seen.has(d.abs.toLowerCase()) && seen.add(d.abs.toLowerCase()));
}

// Reviewable config watched by the turn-level scan. Claude Code itself writes the session project's
// .claude/settings.local.json when the user approves a permission, so that one file is watched only around
// shell commands (pre/post-bash); nested ones (other packages) are watched like any config.
function isTurnConfig(p, root) {
  return REVIEWABLE_CONFIG.test(p) && path.resolve(p).toLowerCase() !== path.join(path.resolve(root), '.claude', 'settings.local.json').toLowerCase();
}

// Shell-command fingerprints: "mtime|size", plus a content hash (a copy can keep both time and size) —
// for every file in projects of up to 1000 code files; in bigger ones for config, sensitive paths and
// MQL trading code. null = absent. `stats` (from codeSnapshot detail) saves stat calls. `all`: the policy
// chosen for the command's first snapshot (the second must use the same one to be comparable).
function shellPrints(paths, stats, all = paths.length <= 1000) {
  const out = {};
  for (const p of paths) {
    let st = stats && stats[p];
    if (!st) { try { const x = fs.statSync(p); st = { m: x.mtimeMs, s: x.size }; } catch { out[p] = null; continue; } }
    const deep = all || REVIEWABLE_CONFIG.test(p) || SENSITIVE_PATH.test(p) || /\.(mq4|mq5|mqh)$/i.test(p) || p.toLowerCase().startsWith(CLAUDE_DIR);
    out[p] = { m: st.m, f: `${st.m}|${st.s}${deep ? '|' + (printOf(p) || '') : ''}` };
  }
  return out;
}
// Git projects: files a shell command may change that git status can't show — the git-ignored config
// found at turn start, plus Claude/Codex settings (e.g. permissions granted via a shell edit).
function watchedIgnored(root, turnStartedAt) {
  const t = readTurnPrints(root, turnStartedAt);
  const known = ['.claude/settings.json', '.claude/settings.local.json', '.claude/gpt.json', '.codex/config.toml'].map(r => path.join(root, r));
  return [...new Set([...((t && t.ignoredConfigs) || []), ...known])];
}
// This setup's own code and config (hooks, bridge, settings, agents) — watched around every shell command
// from any project, since a project's scans never see them.
const CLAUDE_DIR = path.join(os.homedir(), '.claude').toLowerCase() + path.sep;
function globalSetupFiles() {
  const c = path.join(os.homedir(), '.claude');
  const out = ['gpt.js', 'gate.js', 'lib.js', 'config.json'].map(n => path.join(HOME, n)).concat(path.join(c, 'settings.json'));
  try { for (const n of fs.readdirSync(path.join(HOME, 'bridge'))) if (n.endsWith('.js')) out.push(path.join(HOME, 'bridge', n)); } catch {}
  try { for (const n of fs.readdirSync(path.join(c, 'agents'))) out.push(path.join(c, 'agents', n)); } catch {}
  return out;
}
// ---- The offline MQL5 reference (the mql5-chm MCP server) for GPT's read-only runs on MQL5 code.
// The only MCP server those runs may get, with exactly these read-only tools.
const DOCS_SERVER = 'mql5-chm';
const DOCS_TOOLS = ['mql5_chm_status', 'mql5_chm_lookup_identifiers', 'mql5_chm_search', 'mql5_chm_read', 'mql5_chm_read_image'];
// A strict reader for the few TOML forms that section uses: one-line basic ("...") or literal ('...')
// strings, arrays of them, booleans and numbers. Anything else throws (the docs then stay off).
function tomlSpace(src, i, newlines) {
  for (;;) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || (newlines && (src[i] === '\n' || src[i] === '\r')))) i++;
    if (src[i] !== '#') return i;
    while (i < src.length && src[i] !== '\n') i++;
    if (!newlines) return i;
  }
}
function tomlValue(src, i) {
  const c = src[i];
  if (c === '"' || c === "'") {
    if (src.startsWith(c.repeat(3), i)) throw new Error('multi-line strings are not supported');
    let out = '';
    for (let j = i + 1; ; ) {
      const ch = src[j];
      if (ch === undefined || ch === '\n' || ch === '\r') throw new Error('unterminated string');
      if (ch === c) return [out, j + 1];
      if (ch < ' ' && ch !== '\t') throw new Error('control character in a string');
      if (c === '"' && ch === '\\') {
        const e = src[j + 1], simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (Object.prototype.hasOwnProperty.call(simple, e)) { out += simple[e]; j += 2; continue; }
        const n = e === 'u' ? 4 : e === 'U' ? 8 : 0, hex = src.slice(j + 2, j + 2 + n), cp = parseInt(hex, 16);
        if (!n || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('bad escape in a string');
        out += String.fromCodePoint(cp); j += 2 + n; continue;
      }
      out += ch; j++;
    }
  }
  if (c === '[') {
    const arr = [];
    for (let j = tomlSpace(src, i + 1, true); ; j = tomlSpace(src, j, true)) {
      if (src[j] === ']') return [arr, j + 1];
      const [v, k] = tomlValue(src, j);
      if (typeof v !== 'string') throw new Error('only lists of strings are supported');
      arr.push(v); j = tomlSpace(src, k, true);
      if (src[j] === ']') return [arr, j + 1];
      if (src[j] !== ',') throw new Error('bad list');
      j++;
    }
  }
  const m = /^(true|false|[+-]?\d[\d_]*(\.\d+)?)(?![\w.])/.exec(src.slice(i, i + 40));
  if (!m) throw new Error('unsupported value');
  return [m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1].replace(/_/g, '')), i + m[1].length];
}
// The server as the owner's Codex config defines it ([mcp_servers.mql5-chm] in $CODEX_HOME/config.toml,
// kept current by its installer): { command, args } or { problem }. Settings the bridge would not pass on
// (env, cwd, a URL transport, sub-tables) or `enabled = false` leave the docs off.
function readDocsServer(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return { problem: `no Codex config at ${file}` }; }
  const own = h => h.replace(/\s+/g, '').replace(/^mcp_servers\.(?:"mql5-chm"|'mql5-chm'|mql5-chm)(?=\.|$)/, 'mcp_servers.mql5-chm');
  const where = `[mcp_servers.${DOCS_SERVER}] in ${file}`;
  const HEAD = /^[ \t]*\[([^[\]\n]*)\][ \t]*(?:#.*)?$/gm;
  let m, start = -1, end = src.length;
  while ((m = HEAD.exec(src))) {
    const n = own(m[1]);
    if (n.startsWith(`mcp_servers.${DOCS_SERVER}.`)) return { problem: `${where}: its [${m[1].trim()}] settings are not passed on` };
    if (n === `mcp_servers.${DOCS_SERVER}`) { if (start >= 0) return { problem: `${where}: defined twice` }; start = HEAD.lastIndex; }
    else if (start >= 0 && end === src.length) end = m.index;
  }
  if (start < 0) return { problem: `no [mcp_servers.${DOCS_SERVER}] in ${file}` };
  if (/^[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"mql5-chm"|'mql5-chm'|mql5-chm)[ \t]*\./m.test(src)) return { problem: `${where}: settings outside its section are not passed on` };
  const body = src.slice(start, end), got = {};
  try {
    for (let i = tomlSpace(body, 0, true); i < body.length; i = tomlSpace(body, i, true)) {
      const km = /^([A-Za-z0-9_-]+|"[^"\\\n]*"|'[^'\n]*')[ \t]*=[ \t]*/.exec(body.slice(i));
      if (!km) throw new Error('unsupported key');
      const key = km[1].replace(/^["']|["']$/g, '');
      if (key in got) throw new Error(`${key} given twice`);
      const [v, j] = tomlValue(body, i + km[0].length);
      got[key] = v;
      i = tomlSpace(body, j, false);
      if (i < body.length && body[i] !== '\n' && body[i] !== '\r') throw new Error('extra text after a value');
    }
  } catch (e) { return { problem: `${where}: ${e.message}` }; }
  const other = Object.keys(got).filter(k => !['command', 'args', 'enabled', 'required', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools'].includes(k));
  if (other.length) return { problem: `${where}: sets ${other.join(', ')}, which the bridge does not pass on` };
  if (got.enabled === false) return { problem: `${where}: switched off (enabled = false)` };
  const args = got.args === undefined ? [] : got.args;
  if (typeof got.command !== 'string' || !got.command || !Array.isArray(args)) return { problem: `${where}: needs a command and a list of args` };
  if ([got.command, ...args].some(s => !s.isWellFormed() || /[\u0000-\u001f\u007f]/.test(s))) return { problem: `${where}: unusable characters` };
  return { command: got.command, args };
}
// The server for this PC, proven to work: its files exist and a real handshake (initialize + tools/list)
// lists every docs tool. The handshake result is kept for an hour per installation (paths + file times).
// `probe` false (session-start health check): no handshake, only a cached result (null if none yet).
function mql5DocsServer(probe = true) {
  const d = readDocsServer(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'));
  if (d.problem) return d;
  const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  for (const f of [d.command, ...d.args.filter(a => /\.[cm]?js$/i.test(a))]) if (!isFile(f)) return { problem: `${f} not found (reinstall or update the MQL5 CHM MCP)` };
  const stamp = [d.command, ...d.args].map(f => { try { return `${f}@${fs.statSync(f).mtimeMs}`; } catch { return f; } }).join('|');
  const last = readState(HOME).docsCheck;
  if (last && last.stamp === stamp && (Date.now() - last.at < 3600000 || !probe)) return last.problem ? { problem: last.problem } : d;
  if (!probe) return null;
  let problem = null;
  try {
    const r = spawnSync(process.execPath, ['-e', DOCS_HANDSHAKE, JSON.stringify([d.command, ...d.args]), JSON.stringify(DOCS_TOOLS)],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    let res = null; try { res = JSON.parse(String(r.stdout || '').trim()); } catch {}
    problem = !res ? `the docs check failed (${r.error ? r.error.message : `exit ${r.status}`})` : res.problem ? `the docs server ${res.problem}` : null;
  } catch (e) { problem = `the docs check failed (${e.message})`; }
  try { updateState(HOME, s => { s.docsCheck = { stamp, at: Date.now(), problem }; }); } catch {}
  return problem ? { problem } : d;
}
// The handshake, in a helper process (so mql5DocsServer stays synchronous): start the server, initialize,
// list its tools (every docs tool must be there) and call mql5_chm_status, which needs the loaded index —
// each reply validated. Prints {} when all is well, else { problem }.
const DOCS_HANDSHAKE = `
const { spawn } = require('child_process');
const [cmd, ...args] = JSON.parse(process.argv[1]), need = JSON.parse(process.argv[2]);
let ended = false, buf = '';
const done = problem => { if (ended) return; ended = true; try { p.kill(); } catch {} process.stdout.write(JSON.stringify(problem ? { problem } : {})); process.exit(0); };
const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
const send = o => { try { p.stdin.write(JSON.stringify(o) + '\\n'); } catch (e) { done('did not accept input (' + e.message + ')'); } };
p.on('error', e => done('did not start (' + e.message + ')'));
p.on('exit', c => done('stopped (exit ' + c + ') before it answered'));
p.stdin.on('error', () => {});
p.stdout.setEncoding('utf8');
p.stdout.on('data', d => {
  buf += d;
  for (let i; (i = buf.indexOf('\\n')) >= 0; ) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { return done('sent a reply that is not JSON'); }
    if (m.jsonrpc !== '2.0' || m.id === undefined) continue; // notifications, logs
    if (m.error || !m.result) return done('failed request ' + m.id + (m.error ? ' (' + String(m.error.message || '').slice(0, 120) + ')' : ''));
    if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
    else if (m.id === 2) {
      const names = Array.isArray(m.result.tools) ? m.result.tools.map(t => t && t.name) : [];
      const missing = need.filter(t => !names.includes(t));
      if (missing.length) return done('did not offer ' + missing.join(', '));
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mql5_chm_status', arguments: {} } });
    } else if (m.id === 3) return done(m.result.isError ? 'reported its index as not ready (' + JSON.stringify(m.result.content || '').slice(0, 160) + ')' : null);
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-gpt-bridge', version: '1' } } });
setTimeout(() => done('did not answer within 15 s'), 15000);
`;

// The record key of a file: an existing record's spelling when one matches case-insensitively (Windows
// paths are; Edit, git and the folder walk may spell the same file differently).
function changeKey(s, abs) {
  if (!s.changes || s.changes[abs]) return abs;
  const lower = abs.toLowerCase();
  return Object.keys(s.changes).find(k => k.toLowerCase() === lower) || abs;
}

// A file's content differs from its version in commit `rev` (compared as git blobs, so git's filters such
// as line endings apply), tracked or not. Not in `rev`, no revision, or a git error: "differs".
// A file's content print in a commit, as a checkout writes it (eol and filters applied, so it compares with
// printOf of the working file): its hash, 'absent' if the commit doesn't hold it (or there is no commit
// yet), null if unknown (not a git project, too big, git failed).
function revPrint(root, rev, abs) {
  const top = gitRoot(root);
  if (!top) return null;
  if (!rev) return 'absent';
  try {
    const rel = path.relative(top, abs).replace(/\\/g, '/');
    const r = spawnSync('git', ['cat-file', '--filters', `${rev}:${rel}`], { cwd: top, timeout: 8000, maxBuffer: PRINT_MAX_BYTES + 1 });
    if (r.status === 0) return crypto.createHash('sha256').update(r.stdout).digest('hex');
    return spawnSync('git', ['rev-parse', '-q', '--verify', `${rev}:${rel}`], { cwd: top, timeout: 8000 }).status === 1 ? 'absent' : null;
  } catch { return null; }
}

function differsFromRev(root, rev, abs) {
  const top = rev && gitRoot(root);
  if (!top) return true;
  try {
    const rel = path.relative(top, abs).replace(/\\/g, '/');
    const inRev = spawnSync('git', ['rev-parse', '-q', '--verify', `${rev}:${rel}`], { cwd: top, encoding: 'utf8', timeout: 8000 });
    if (inRev.status !== 0) return true;
    const now = spawnSync('git', ['hash-object', `--path=${rel}`, '--', abs], { cwd: top, encoding: 'utf8', timeout: 8000 });
    return now.status !== 0 || now.stdout.trim() !== inRev.stdout.trim();
  } catch { return true; }
}

// Paths (lower-cased) among `files` that git ignores.
function gitIgnored(root, files) {
  const top = files.length && gitRoot(root);
  if (!top) return new Set();
  try {
    const r = spawnSync('git', ['check-ignore', '-z', '--stdin'], { cwd: top, input: files.join('\0') + '\0', encoding: 'utf8', timeout: 8000, maxBuffer: 20 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) { gitFailed(`git check-ignore in ${top}`, r); return new Set(); } // 1 = none ignored
    return new Set(r.stdout.split('\0').filter(Boolean).map(f => path.resolve(top, f).toLowerCase()));
  } catch { return new Set(); }
}

// ---- Turn-start content fingerprints (git projects). File times alone miss copies that keep the
// source's time (Windows Copy-Item/copy, cp -p), so hashes taken when a turn starts decide what changed:
//   dirty: reviewable files git reports as changed/untracked at turn start (the user's own work)
//   sets:  .set presets found by a bounded walk (also git-ignored ones, which git status never shows)
// Kept next to the state file (the main state stays small); null = not hashed (cap/size) = unknown.
const PRINT_CAP = 500, PRINT_MAX_BYTES = 5 * 1024 * 1024;
function printOf(p) {
  try { return fs.statSync(p).size > PRINT_MAX_BYTES ? null : fileHash(p); } catch { return null; }
}
function lowerKeys(obj) {
  const m = new Map(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), v]));
  m.originals = Object.keys(obj || {}).map(k => [k.toLowerCase(), k]);
  return m;
}
function saveTurnPrints(root, at, ctx = {}) {
  let n = 0;
  const hash = p => (n++ < PRINT_CAP ? printOf(p) : null);
  const dirty = {}, configs = {};
  // (a 'D' entry still on disk = only removed from the index: its content is the user's too)
  for (const e of ctx.entries || []) if (isCode(e.abs) && (!e.xy.includes('D') || fs.existsSync(e.abs))) dirty[e.abs] = hash(e.abs);
  const walk = ctx.walk || (ctx.walk = codeSnapshot(root));
  const confPaths = Object.keys(walk.files).filter(p => REVIEWABLE_CONFIG.test(p));
  for (const p of confPaths) if (isTurnConfig(p, root)) configs[p] = hash(p);
  const ignored = gitIgnored(root, confPaths);
  const ignoredConfigs = confPaths.filter(p => ignored.has(p.toLowerCase())); // watched around shell commands
  const f = statePath(root) + '.turn.json', tmp = `${f}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ at, dirty, configs, configsComplete: !walk.truncated, ignoredConfigs }));
  fs.renameSync(tmp, f);
}
// The fingerprints of the turn that started at `at` (null if missing or from another turn).
function readTurnPrints(root, at) {
  try { const t = JSON.parse(fs.readFileSync(statePath(root) + '.turn.json', 'utf8')); return at && t.at === at ? t : null; } catch { return null; }
}
// Before an edit captures its baseline: did the file's content change during this turn although its file
// time is older? false when unknown.
function changedByContentThisTurn(root, abs, turnStartedAt, turnHead) {
  const prints = readTurnPrints(root, turnStartedAt);
  if (!prints) return false;
  const k = abs.toLowerCase(), h = printOf(abs);
  const dirty = lowerKeys(prints.dirty);
  if (dirty.has(k)) return !!dirty.get(k) && dirty.get(k) !== h;
  const top = gitRoot(root);
  if (!top) return false;
  const st = spawnSync('git', ['status', '--porcelain', '-z', '--', abs], { cwd: top, encoding: 'utf8', timeout: 8000 });
  if (st.status !== 0) { gitFailed(`git status of ${abs}`, st); return false; }
  // clean (or absent) at turn start, dirty now: new, or differs from the turn-start commit
  if (st.stdout) return differsFromRev(root, turnHead, abs);
  // clean now: an ignored config file compares with its turn-start hash (new = changed); anything else is unchanged
  if (!prints.configs || !isTurnConfig(abs, root) || !gitIgnored(root, [abs]).has(k)) return false;
  const confs = lowerKeys(prints.configs);
  return confs.has(k) ? !!confs.get(k) && confs.get(k) !== h : !!prints.configsComplete;
}
// The file's content equals its last reviewed/acknowledged version (its baseline).
function sameAsBaseline(root, abs) {
  const base = baselineOf(root, abs);
  try { return !!base && base !== 'ABSENT' && fileHash(base) === fileHash(abs); } catch { return false; }
}

// Reviewable files under `root` -> mtime (`detail`: {m: mtime, s: size}), bounded (used where git can't
// tell us what changed). `repos`: the git repositories found on the way (folders holding a .git entry).
function codeSnapshot(root, budget = 5000, detail = false) {
  const out = {}, repos = [];
  let truncated = false;
  (function walk(d, depth) {
    let names = []; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n === '.git') { repos.push(d); continue; }
      if (/^(node_modules|\.git|\.venv|venv|__pycache__|dist|build|\.next|target)$/.test(n)) continue;
      if (--budget < 0) { truncated = true; return; }
      const p = path.join(d, n);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isDirectory() && depth < 8) walk(p, depth + 1);
      else if (st.isFile() && isCode(p)) out[p] = detail ? { m: st.mtimeMs, s: st.size } : st.mtimeMs;
    }
  })(root, 0);
  return { files: out, truncated, repos };
}

// ---- Changes on disk the turn's author didn't write: they are not tracked, only listed (notAuthored).
// Config destinations stay changes (a copied preset or settings file takes effect where it lands), and so
// does moving config away; a file that already has a pending change is always tracked (callers check).

// A git call bounded by an absolute deadline (hooks must finish in time); null when no time is left.
function gitBy(deadline, cwd, args, input) {
  const left = Math.min(8000, deadline - Date.now());
  return left < 300 ? null : spawnSync('git', args, { cwd, encoding: 'utf8', input, timeout: left, maxBuffer: 100 * 1024 * 1024 });
}

// Git projects (Stop's scan): a NEW file (absent at turn start, not in HEAD) whose content is already in HEAD
// or was in the working tree at turn start is a copy; a deleted file whose HEAD/turn-start content reappears
// in a new file with the same extension was moved (helper.js -> helper.txt stays a deletion). Without the
// turn-start fingerprints nothing is exempt. `disk` must hold every new file the scan saw (also those the
// bulk rule drops: they can be a move's destination). Map(lower-case path -> why).
function gitNotAuthored(root, disk, prints, deadline = Date.now() + 8000) {
  const out = new Map();
  const top = gitRoot(root);
  // (only new untracked files can be copies, and only a deletion can be the other half of a move)
  if (!top || !prints || !disk.some(d => d.deleted || d.untracked)) return out;
  const git = (args, input) => gitBy(deadline, top, args, input);
  const rel = abs => path.relative(top, abs).replace(/\\/g, '/');
  const inHead = new Map(); // lower-case repo path -> blob id
  const ls = git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  if (!ls) return out;
  if (ls.status === 0) for (const e of ls.stdout.split('\0')) { const m = e.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/s); if (m) inHead.set(m[2].toLowerCase(), m[1]); }
  else if (gitHead(top)) { gitFailed(`git ls-tree in ${top}`, ls); return out; }
  const blobs = new Set(inHead.values());
  const dirty = lowerKeys(prints.dirty);
  const startPrints = new Set([...dirty.values()].filter(Boolean));
  // new = not in HEAD and not in the working tree at turn start (an overwritten untracked draft is a change)
  const fresh = disk.filter(d => !d.deleted && !inHead.has(rel(d.abs).toLowerCase()) && !dirty.has(d.abs.toLowerCase()) && !/[\r\n]/.test(d.abs));
  const newBy = new Map(); // blob id / content hash -> new files
  if (fresh.length) {
    const ids = git(['hash-object', '--stdin-paths'], fresh.map(d => rel(d.abs)).join('\n') + '\n');
    if (!ids) return out;
    const idList = ids.status === 0 ? ids.stdout.trim().split('\n') : [];
    if (ids.status !== 0) gitFailed(`git hash-object in ${top}`, ids);
    fresh.forEach((d, i) => {
      const id = idList.length === fresh.length ? idList[i] : null, p = printOf(d.abs);
      for (const k of [id, p]) if (k) (newBy.get(k) || newBy.set(k, []).get(k)).push(d.abs);
      if (!REVIEWABLE_CONFIG.test(d.abs) && ((id && blobs.has(id)) || (p && startPrints.has(p)))) out.set(d.abs.toLowerCase(), 'copy of existing content');
    });
  }
  for (const d of disk) {
    if (!d.deleted || REVIEWABLE_CONFIG.test(d.abs)) continue;
    const k = d.abs.toLowerCase();
    const before = dirty.has(k) ? dirty.get(k) : inHead.get(rel(d.abs).toLowerCase()); // turn-start content
    const to = before && (newBy.get(before) || []).find(n => path.extname(n).toLowerCase() === path.extname(d.abs).toLowerCase());
    if (to) out.set(k, `moved to ${to}`);
  }
  return out;
}

// Paths (lower-case, repo-relative) in `git status --porcelain -z` output, both sides of renames/copies.
function statusPaths(out) {
  const set = new Set(), parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    set.add(p.slice(3).toLowerCase());
    if (p[0] === 'R' || p[0] === 'C') { i++; if (parts[i]) set.add(parts[i].toLowerCase()); }
  }
  return set;
}
// Nested git repositories in a non-git session folder, before a shell command that may switch branches:
// HEAD and dirty files of each (false = unknown: no exemption for that repo). At most 20 repos, all done by
// `deadline` (the shell hooks have 15 s).
function repoStates(tops, deadline) {
  const out = {};
  tops.forEach((top, i) => {
    const st = i < 20 && gitBy(deadline, top, ['status', '--porcelain', '-z', '-uall']);
    const head = st && st.status === 0 && gitBy(deadline, top, ['rev-parse', 'HEAD']);
    out[top] = head ? { head: head.status === 0 ? head.stdout.trim() : null, dirty: [...statusPaths(st.stdout)] } : false;
  });
  return out;
}
// After that command: a test (abs, existed before the command) for files a branch switch changed in repo
// `top` — tracked and clean before (they equalled the old HEAD; an untracked or git-ignored file a checkout
// overwrote is a change), clean after (they equal the new HEAD) and part of either tree. Only when HEAD moved
// and every HEAD reflog entry since `since` is a checkout, pull, merge or rebase (a repo that didn't exist
// before — `pre` null — only a clone): never a commit, reset, cherry-pick or revert, which can carry the
// author's own changes or discard work. null = nothing qualifies (also when `deadline` is too close).
function branchSwitch(top, pre, since, deadline = Date.now() + 8000) {
  const git = (...a) => gitBy(deadline, top, a);
  const h = git('rev-parse', 'HEAD');
  const head = h && h.status === 0 ? h.stdout.trim() : null;
  if (!head || (pre && pre.head === head)) return null;
  const log = git('reflog', '--date=unix', '--format=%gd%x09%gs', '-n', '100');
  if (!log || log.status !== 0) return null;
  const recent = log.stdout.split('\n').filter(Boolean).map(l => l.split('\t'))
    .filter(([gd]) => Number(((gd || '').match(/\{(\d+)\}/) || [])[1]) * 1000 >= since - 1000);
  const allowed = pre ? /^(checkout|pull|merge|rebase)\b/i : /^(clone|checkout)\b/i;
  if (!recent.length || !recent.every(([, subj]) => allowed.test(subj || ''))) return null;
  const st = git('status', '--porcelain', '-z', '-uall');
  if (!st || st.status !== 0) return null;
  const dirtyNow = statusPaths(st.stdout), preDirty = new Set((pre && pre.dirty) || []);
  const tree = rev => { const r = git('ls-tree', '-r', '-z', '--name-only', '--full-tree', rev); return r && r.status === 0 ? new Set(r.stdout.split('\0').filter(Boolean).map(x => x.toLowerCase())) : null; };
  const newTree = tree(head), oldTree = pre && pre.head ? tree(pre.head) : new Set();
  if (!newTree || !oldTree) return null;
  return (abs, existed) => {
    const rel = path.relative(top, abs).replace(/\\/g, '/').toLowerCase();
    return !rel.startsWith('../') && !preDirty.has(rel) && !dirtyNow.has(rel) && (newTree.has(rel) || oldTree.has(rel)) && (!existed || oldTree.has(rel));
  };
}
// Is `file` (a project's .claude/gpt.json) pending review or carrying open findings in any known session
// project? Another session may have changed it (one opened in a parent folder, or anywhere else, editing it
// by its full path): its ignore list must not take effect before that change is reviewed. An unreadable
// state counts. (Sessions of the last 14 days — a handful of small state files.)
function pendingAnywhere(file) {
  const k = path.resolve(file).toLowerCase();
  const roots = new Set(Object.values(readState(HOME).sessionRoots || {}).map(v => v && v.root && norm(v.root)).filter(Boolean));
  for (const r of roots) {
    const s = readState(r);
    if (s._unreadable) return true;
    const e = Object.entries(s.changes || {}).find(([f]) => f.toLowerCase() === k);
    if (e && (e[1].at > reviewedAtFor(s, e[1]) || e[1].openFindings)) return true;
  }
  return false;
}

// Record changes that are not tracked (newest 50), for `gpt.js status`. items: [[file, why]].
function noteNotAuthored(s, items) {
  const listed = new Set((s.notAuthored || []).map(x => `${x.file.toLowerCase()}|${x.why}`)); // (later scans see it again)
  const add = items.filter(([file, why]) => !listed.has(`${file.toLowerCase()}|${why}`));
  if (add.length) s.notAuthored = (s.notAuthored || []).concat(add.map(([file, why]) => ({ file, why, at: Date.now() }))).slice(-50);
}

// A review's acknowledgement, shared with other projects that track the same files (e.g. a session in a
// folder and one in its sub-repo): each of their PENDING records whose file holds exactly the acknowledged
// content gets the same acknowledgement (and that content as its baseline, unless a later review set one).
// Their own open findings stay. One project's lock at a time (taken strictly: a busy or unreadable project
// is skipped); the file is re-hashed under that lock. items: [{ abs, hash (of the acknowledged content,
// taken when it was acknowledged; 'absent' = deleted), snap (copy of it; null = absent), status }].
// Returns how many records were acknowledged.
function shareReceipt(fromRoot, items, at) {
  const want = new Map(items.map(x => [path.resolve(x.abs).toLowerCase(), x]));
  const own = path.basename(statePath(fromRoot)).toLowerCase();
  let names = [];
  try { names = fs.readdirSync(STATE_DIR).filter(n => /^[0-9a-f]{12}\.json$/i.test(n) && n.toLowerCase() !== own); } catch { return 0; }
  let shared = 0;
  for (const n of names) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, n), 'utf8')); } catch { continue; }
    if (!s || !s.root || !s.changes || !Object.entries(s.changes).some(([f, c]) => want.has(f.toLowerCase()) && c.at > reviewedAtFor(s, c))) continue;
    try {
      updateState(s.root, st => {
        for (const [f, c] of Object.entries(st.changes)) {
          const x = want.get(f.toLowerCase());
          if (!x || !(c.at > reviewedAtFor(st, c))) continue;
          let h; try { h = fileHash(f); } catch { continue; }
          if (h !== x.hash) continue;
          c.reviewedAt = Math.max(c.reviewedAt || 0, c.at, at);
          c.reviewStatus = c.openFindings ? 'findings' : x.status;
          c.sharedFrom = path.resolve(fromRoot);
          // (no copy of exactly that content left: the previous baseline stays)
          let base; try { base = h === 'absent' ? null : x.snap && fileHash(x.snap) === x.hash ? x.snap : undefined; } catch {}
          if (base !== undefined && (c.baseAt || 0) <= at) try { setBaseline(st.root, f, base); c.baseAt = at; c.deleted = h === 'absent'; delete c.basePre; } catch {}
          shared++;
        }
      }, true);
    } catch {}
  }
  return shared;
}

// Sensitive by name OR by content (e.g. a generic "helpers.js" that calls OrderSend). Reads at most 1 MB.
function isSensitiveFile(p) {
  if (SENSITIVE_PATH.test(p)) return true;
  try {
    const fd = fs.openSync(p, 'r'), buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    return SENSITIVE_CONTENT.test(buf.toString('utf8'));
  } catch { return false; }
}

// Pending-commit details (committed + earliest diff base) that every later change record must keep.
function keepCommit(c, pending) {
  return pending && c && c.committed ? { committed: true, sinceRev: c.sinceRev === undefined ? null : c.sinceRev } : {};
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function minutesAgo(ts, mins) { return ts && Date.now() - ts < mins * 60000; }

// Share of identical lines (normalised, order-insensitive, duplicates counted) relative to the longer
// text: replacing 2 of 10 lines -> 0.8. 1 = same plan, ~0 = different.
function textSimilarity(a, b) {
  const lines = t => String(t || '').split('\n').map(l => l.trim().toLowerCase().replace(/\s+/g, ' ')).filter(l => l.length > 2);
  const A = lines(a), B = lines(b);
  if (!A.length || !B.length) return 0;
  const count = new Map();
  for (const l of B) count.set(l, (count.get(l) || 0) + 1);
  let common = 0;
  for (const l of A) if (count.get(l) > 0) { common++; count.set(l, count.get(l) - 1); }
  return common / Math.max(A.length, B.length);
}

// ---- Baselines: the version of each code file before Claude's first edit since its last review.
// Lets gpt.js hand GPT an exact diff (also in non-git folders, and without the user's unrelated edits).
const BASE_DIR = path.join(HOME, 'baseline');
function baselinePath(root, abs) {
  return path.join(BASE_DIR, key(root), crypto.createHash('sha1').update(path.resolve(abs).toLowerCase()).digest('hex').slice(0, 16));
}
// `fresh`: no unreviewed change is pending for this file, so the current content (which may include
// the user's own edits since the last review) becomes the baseline — those edits are not Claude's.
function captureBaseline(root, abs, fresh) {
  const p = baselinePath(root, abs);
  if (fresh) { fs.rmSync(p, { force: true }); fs.rmSync(p + '.absent', { force: true }); }
  if (fs.existsSync(p) || fs.existsSync(p + '.absent')) return; // keep the oldest unreviewed version
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // COPYFILE_EXCL / 'wx': a concurrent capture that already published a baseline is never overwritten.
  try { fs.copyFileSync(abs, p, fs.constants.COPYFILE_EXCL); }
  catch (e) { if (e.code === 'ENOENT') try { fs.writeFileSync(p + '.absent', '', { flag: 'wx' }); } catch {} }
}
// After a review, the reviewed content becomes the new baseline (so the next diff shows only new work).
function setBaseline(root, abs, fromFile) {
  const p = baselinePath(root, abs);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.rmSync(p, { force: true }); fs.rmSync(p + '.absent', { force: true });
  if (fromFile && fs.existsSync(fromFile)) fs.copyFileSync(fromFile, p); else fs.writeFileSync(p + '.absent', '');
}
function baselineOf(root, abs) {
  const p = baselinePath(root, abs);
  if (fs.existsSync(p)) return p;
  if (fs.existsSync(p + '.absent')) return 'ABSENT';
  return null;
}

// ---- Lessons: short, Claude-curated list of confirmed recurring mistakes per project.
const LESSON_DIR = path.join(HOME, 'lessons');
function lessonsFile(root) { return path.join(LESSON_DIR, slug(root) + '.md'); }
function readLessons(root) {
  try { return fs.readFileSync(lessonsFile(root), 'utf8').split('\n').filter(l => l.startsWith('- ')); } catch { return []; }
}

// Input fields the hooks rely on, per tool / hook event. (ExitPlanMode's plan text is optional.)
const HOOK_FIELDS = {
  Edit: ['file_path', 'old_string', 'new_string'], Write: ['file_path', 'content'], MultiEdit: ['file_path', 'edits'],
  NotebookEdit: ['notebook_path', 'new_source'],
  UserPromptSubmit: ['cwd', 'prompt', 'session_id'], SessionStart: ['cwd'], Stop: ['cwd'],
};

// ---- Quick health checks (fast, no model call) — used by `gpt.js doctor` and the SessionStart hook.
function quickChecks() {
  const out = [];
  const add = (ok, name, info) => out.push({ ok, name, info });
  let cfg;
  try { cfg = loadConfig(); add(!cfg.problems.length, 'config.json', cfg.problems.length ? cfg.problems.join('; ') : cfg.model); } catch (e) { add(false, 'config.json', e.message); return out; }
  add(!!cfg.codexJs && fs.existsSync(cfg.codexJs), 'codex CLI', cfg.codexJs || 'not found');
  // Tools the hooks and bridge depend on: git (change tracking, diffs), PowerShell (Job Object, process table).
  for (const [name, cmd, args] of [['git', 'git', ['--version']], ['PowerShell', 'powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']]]) {
    try { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true }); add(r.status === 0, name, r.status === 0 ? r.stdout.trim().split('\n')[0] : `not usable (${r.error ? r.error.message : 'exit ' + r.status})`); }
    catch (e) { add(false, name, e.message); }
  }
  try {
    // Normally ~0.2s; capped at 3s so a stalled check can never hold up session start for long.
    const r = spawnSync(process.execPath, [cfg.codexJs, 'login', 'status'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const t = ((r.stdout || '') + (r.stderr || '')).trim();
    add(r.status === 0 && /logged in/i.test(t), 'codex login', t.split('\n')[0] || `exit ${r.status}`);
  } catch (e) { add(false, 'codex login', e.message); }
  // Flags gpt.js relies on — a Codex update that drops one would otherwise break every call.
  for (const [sub, need] of [
    [['exec'], ['--ignore-user-config', '--thread-source', '--json', '--ephemeral', '--output-last-message', '--skip-git-repo-check', '--sandbox']],
    [['exec', 'resume'], ['--ignore-user-config', '--json', '--output-last-message', '--skip-git-repo-check']],
  ]) {
    try {
      const r = spawnSync(process.execPath, [cfg.codexJs, ...sub, '--help'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const missing = need.filter(f => !String(r.stdout || '').includes(f));
      add(!missing.length, `codex ${sub.join(' ')} flags`, missing.length ? 'missing: ' + missing.join(', ') : 'all present');
    } catch (e) { add(false, `codex ${sub.join(' ')} flags`, e.message); }
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const h = JSON.stringify(s.hooks || {});
    const missing = ['post-edit', 'stop', 'pre-plan', 'pre-computer', 'prompt', 'pre-edit', 'pre-bash', 'post-bash', 'session'].filter(n => !h.includes(`gate.js\\" ${n}`));
    add(!missing.length, 'hooks in settings.json', missing.length ? 'missing: ' + missing.join(', ') : 'all present');
    // The desktop hook must fail closed: a crashed or timed-out check may never let the tool run. That needs
    // "onFailure": "block" on its registration AND a Claude Code that honours it (2.1.295+; older versions
    // ignore the field). Checked against the `claude` CLI (the desktop app bundles its own, usually newer).
    const desk = Object.values(s.hooks || {}).flat().flatMap(g => g.hooks || []).find(x => /gate\.js"?\s+pre-computer/.test(String(x.command || '')));
    let ver = null;
    try { ver = (spawnSync('claude --version', { encoding: 'utf8', timeout: 8000, windowsHide: true, shell: true }).stdout || '').match(/(\d+)\.(\d+)\.(\d+)/); } catch {}
    const verOk = !!ver && (Number(ver[1]) * 1e6 + Number(ver[2]) * 1e3 + Number(ver[3])) >= 2001295;
    add(!!desk && desk.onFailure === 'block' && verOk, 'desktop hook fails closed',
      !desk || desk.onFailure !== 'block' ? 'pre-computer hook needs "onFailure": "block" in settings.json'
      : verOk ? `onFailure: block, Claude Code ${ver[0]}` : `needs Claude Code 2.1.295+ to honour onFailure (found ${ver ? ver[0] : 'no claude CLI'})`);
  } catch (e) { add(false, 'hooks in settings.json', e.message); }
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.accessSync(STATE_DIR, fs.constants.W_OK); add(true, 'state dir writable', STATE_DIR); }
  catch (e) { add(false, 'state dir writable', e.message); }
  // A damaged state file is never overwritten (records would be lost), so tracking for that project is off
  // until it is moved aside.
  try {
    const bad = fs.readdirSync(STATE_DIR).filter(f => /^[0-9a-f]{12}\.json$/.test(f)).filter(f => {
      try { const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); return !s || typeof s !== 'object' || Array.isArray(s); } catch { return true; }
    });
    add(!bad.length, 'state files readable', bad.length ? `damaged: ${bad.map(f => path.join(STATE_DIR, f)).join(', ')} — move aside to start fresh` : 'all');
  } catch (e) { add(false, 'state files readable', e.message); }
  // Optional: a PC without MT5 is fine (only MQL5 compile evidence is unavailable), so never a failure.
  if (cfg.metaeditorPath) add(true, 'MetaEditor (optional)', fs.existsSync(cfg.metaeditorPath) ? cfg.metaeditorPath : 'not installed — MQL5 compile evidence unavailable');
  // Optional too: without it GPT's MQL5 runs mark API-fact claims as unverified.
  if (cfg.mql5Docs !== false) try {
    const d = mql5DocsServer(false);
    add(true, 'MQL5 docs for GPT (optional)', !d ? 'configured; checked on the first MQL5 run' : d.problem ? `off — ${d.problem}` : `on (${d.args.find(a => /\.[cm]?js$/i.test(a)) || d.command})`);
  } catch (e) { add(true, 'MQL5 docs for GPT (optional)', `off — ${e.message}`); }
  // Fields the hooks rely on vs. what Claude Code actually sent (recorded by gate.js on first use).
  const need = HOOK_FIELDS;
  const seen = readState(HOME).seenFields || {};
  const bad = Object.entries(need).filter(([t]) => seen[t]).map(([t, f]) => [t, f.filter(x => !seen[t].includes(x))]).filter(([, m]) => m.length);
  const unseen = Object.keys(need).filter(t => !seen[t]);
  add(!bad.length, 'hook input fields', bad.length ? bad.map(([t, m]) => `${t} missing ${m.join('/')}`).join('; ')
    : `match${unseen.length ? ` (not seen yet: ${unseen.join(', ')})` : ''}`);
  // Informational (never a failure): problems the hooks survived in the last 24 h.
  const issues = recentHookIssues(24);
  add(true, 'hook problems (24 h)', issues.length ? `${issues.length}, last: ${issues[issues.length - 1].slice(1).join(' — ')} (see ${HOOK_LOG})` : 'none');
  return out;
}

// ---- Retention: at most once a day. Logs > 30 days; stages > 30 days and not locked; baselines of
// projects untouched for 30 days. Never touches unapplied recent stages or Codex's own sessions.
function cleanup() {
  const g = readState(HOME);
  if (g.lastCleanup && Date.now() - g.lastCleanup < 86400000) return;
  // lstat: symlinks/junctions are never followed or deleted through (they could point at user data).
  const real = p => { try { const st = fs.lstatSync(p); return st.isSymbolicLink() ? null : st; } catch { return null; } };
  const old = p => { const st = real(p); return !!st && Date.now() - st.mtimeMs > 30 * 86400000; };
  const sweep = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const n of entries) {
      const p = path.join(dir, n);
      const st = real(p);
      if (!st) continue;
      if (st.isDirectory() && depth > 0) sweep(p, depth - 1);
      else if (old(p)) try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  };
  if (real(LOG_DIR)) sweep(LOG_DIR, 1); // the roots themselves must not be links either
  if (real(BASE_DIR)) sweep(BASE_DIR, 0);
  try {
    for (const d of fs.readdirSync(path.join(HOME, 'stage'))) {
      const p = path.join(HOME, 'stage', d);
      if (d.includes('.deleting-')) { // a deletion that was interrupted: finish it once its owner is gone
        const owner = Number(d.split('.deleting-')[1]);
        let alive = false;
        try { process.kill(owner, 0); alive = true; } catch {}
        if (!alive && real(p)) fs.rmSync(p, { recursive: true, force: true });
        continue;
      }
      if (!old(p)) continue;
      // Take the stage lock with our pid (same protocol as gpt.js lockStage, so it is never reclaimed
      // while we live), then move the stage out of the selectable namespace before deleting it.
      try { fs.mkdirSync(path.join(p, '.lock')); fs.writeFileSync(path.join(p, '.lock', 'pid'), String(process.pid)); } catch { continue; }
      const gone = `${p}.deleting-${process.pid}`;
      try { fs.renameSync(p, gone); } catch { fs.rmSync(path.join(p, '.lock'), { recursive: true, force: true }); continue; }
      fs.rmSync(gone, { recursive: true, force: true });
    }
  } catch {}
  try { // review snapshots are per-run; anything older than a day is leftover from a crash
    if (!real(path.join(HOME, 'snap'))) throw new Error('snap root is a link or missing');
    for (const d of fs.readdirSync(path.join(HOME, 'snap'))) {
      const p = path.join(HOME, 'snap', d);
      const st = real(p);
      if (st && Date.now() - st.mtimeMs > 86400000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {}
  updateState(HOME, s => { s.lastCleanup = Date.now(); });
}

module.exports = {
  HOME, STATE_DIR, LOG_DIR, loadConfig, slug, gitRoot, readState, writeState, updateState, findRoot,
  projectSettings, projectFileSettings, setupSwitch, setupOffThroughout, startDiscoveryWindow, isCode, countLines, pending, reviewedAtFor, isSignificant, gitStatus, gitDeleted, gitChangedCode, minutesAgo,
  SENSITIVE_PATH, SENSITIVE_CONTENT, docTargetProblem, fileHash,
  codeSnapshot, statePath, pidAlive, isSensitiveFile, keepCommit, printOf, saveTurnPrints, readTurnPrints, changedByContentThisTurn, validateConfig, CONFIG_DEFAULTS, hookIssue, hookTime, recentHookIssues, HOOK_TIMES, sameAsBaseline, differsFromRev, revPrint, gitIgnored, DOCS_SERVER, DOCS_TOOLS, readDocsServer, mql5DocsServer, shellPrints, watchedIgnored, globalSetupFiles, changeKey, gitHead, gitCommittedSince, sessionRoot, knownSessionRoot, captureBaseline, setBaseline, baselineOf, lessonsFile, readLessons, quickChecks, cleanup, textSimilarity, HOOK_FIELDS,
  REVIEWABLE_CONFIG, isTesterReport, ignoredByProject, gitNotAuthored, repoStates, branchSwitch, noteNotAuthored, shareReceipt, pendingAnywhere,
};
