#!/usr/bin/env node
// Claude <-> GPT (Codex CLI) bridge. GPT reviews and operates the computer; it never writes code.
//
//   gpt.js review   --task "<goal>" [--focus "..."] [--files a,b] [--full] [--evidence "cmd ;; cmd"] [--evidence-file f]
//   gpt.js review   --followup <log.md> --file <claude-response.md> [--evidence ..] [--fresh]
//   gpt.js plan     [--effort ..] --file <plan.md|->
//   gpt.js idea     [--effort ..] --file <draft.md|->  [--question "<user's question>"]
//   gpt.js digest   --question "<what to find out>" --files "<a.log,b.htm>" | --dir <folder> [--max 400]
//   gpt.js digest   --backtest --question "..." --files "<report.htm/.xml>"   (MT5 tester/optimization check)
//   gpt.js research --question "<what to find out>" [--max 350]            (web; sources cited)
//   gpt.js testplan --task "<what the code must do>" [--files ..]          (cases only; Claude writes tests)
//   gpt.js digest   --investigate --question "<symptom>" --files/--dir .. [--expected ..] [--actual ..] [--tried ..] [--evidence-file f]
//   gpt.js computer [--effort ..] --task "<goal>" | --file <task.md>
//   gpt.js write    [--effort ..] --files "<a.md,b.docx>" --brief "..." | --brief-file f  [--data]
//   gpt.js write    --revise <stage-id> --brief-file <feedback.md>      (Claude's review feedback)
//   gpt.js apply <stage-id> [--force]  |  gpt.js discard <stage-id>
//   gpt.js note <log.md> --text "..." | --file f        (append Claude's decisions to a log)
//   gpt.js mark-reviewed --by claude-final|claude-fallback|user-declined [--files a,b] --note "..."
//   gpt.js allow-claude-cu --reason "<why Claude does computer use itself>" [--minutes N]
//   gpt.js lesson [--text "..." | --remove N]    (list / add / remove project lessons)
//   gpt.js doctor [--live]  |  gpt.js stats [--all]  |  gpt.js mql5-compile <file.mq5>
//   gpt.js status
//
// Exit codes: 0 ok, 2 usage error, 3 GPT unavailable (after one retry), 4 max rounds reached, 5 apply conflict.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const L = require('./lib');

const argv = process.argv.slice(2);
const cmd = argv[0];
const opts = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opts[k] = v;
  } else positional.push(argv[i]);
}

const cfg = L.loadConfig();
// Hooks pass --project <session cwd> explicitly; without it, infer from the current directory.
// Explicit --project wins; otherwise the calling Claude session's project; otherwise infer from cwd.
const root = opts.project ? path.resolve(opts.project)
  : L.knownSessionRoot(process.env.CLAUDE_CODE_SESSION_ID) || L.findRoot(process.cwd());
const ps = L.projectSettings(root);

function die(msg, code = 2) { console.error(msg); process.exit(code); }
function readArgFile(f) { return f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8'); }
function stamp() { return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); }

// A project's fixed effort (.claude/gpt.json) wins over Claude's per-call choice. Anything not in
// config.allowedEfforts (e.g. "xhigh" when the user limited GPT to "high") falls back to the default.
function effortFor() {
  const e = ps.effort && ps.effort !== 'auto' ? ps.effort : opts.effort || cfg.defaultEffort;
  return cfg.allowedEfforts.includes(e) ? e : cfg.defaultEffort;
}

function logDir() {
  const d = path.join(L.LOG_DIR, L.slug(root));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Codex's sandbox only covers shell commands, not MCP tools. So every mode except computer use runs
// with the user's Codex config ignored (no MCP servers/plugins at all: no MetaEditor write tools, no
// external text services). Computer use keeps the config but switches off the servers listed in config.
// `resume`: continue an earlier Codex session (follow-up review rounds keep GPT's context). `resume`
// has no -s/-C flags, so the sandbox is forced via config (verified: writes are still denied).
// `persist`: keep the session on disk so a later round can resume it (reviews only).
function codexArgs({ mode, effort, sandbox, cwd, outFile, resume, persist, json }) {
  const a = [cfg.codexJs, 'exec'];
  if (resume) a.push('resume');
  if (json) a.push('--json'); // structured events on stdout (used by doctor to see real tool executions)
  if (mode !== 'computer') a.push('--ignore-user-config');
  a.push('-m', cfg.model, '-c', `model_reasoning_effort=${effort}`, '-c', `windows.sandbox=${cfg.windowsSandbox}`);
  if (mode === 'computer') for (const s of cfg.computerDisableMcp || []) a.push('-c', `mcp_servers.${s}.enabled=false`);
  // workspace-write would otherwise also allow TEMP — the stage dir must be the ONLY writable place.
  if (sandbox === 'workspace-write') a.push('-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true');
  if (resume) a.push('-c', `sandbox_mode=${sandbox}`, '--skip-git-repo-check', '-o', outFile, resume, '-');
  // Saved review sessions are labelled so they can be told apart from the user's own Codex threads.
  else a.push('-s', sandbox, '--skip-git-repo-check', ...(persist ? ['--thread-source', 'claude-gpt-bridge'] : ['--ephemeral']), '-C', cwd, '-o', outFile, '-');
  return a;
}

// Windows process table: [[pid, parent pid, creation ms]] ([] on failure).
const PS_TABLE = ['-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }'];
const parseTable = out => String(out || '').split(/\r?\n/).map(l => l.trim().split(' ').map(Number)).filter(a => a.length === 3 && a.every(Number.isFinite));
function processTable() {
  try { return parseTable(spawnSync('powershell', PS_TABLE, { encoding: 'utf8', windowsHide: true, timeout: 30000 }).stdout); } catch { return []; }
}
// Add the child's current descendants to child.known (pid -> creation ms). A process belongs to the tree
// if its parent is the root or a known member and it was created after that parent — and before the
// parent's pid was taken by a different process (reuse). Members stay known after they exit, so a
// worker whose parents have all exited can still be traced through them.
function learnTree(child, procs) {
  const known = child.known || (child.known = new Map());
  const holder = new Map(procs.map(([pid, , t]) => [pid, t]));
  const window = p => {
    if (p === child.pid) {
      const until = Math.min(child.exitedAt ? child.exitedAt + 1000 : Infinity, holder.has(p) && holder.get(p) > child.startedAt + 5000 ? holder.get(p) : Infinity);
      return [child.startedAt - 2000, until];
    }
    const t = known.get(p);
    return [t - 2000, holder.has(p) && Math.abs(holder.get(p) - t) > 1000 ? holder.get(p) : Infinity];
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid, t] of procs) {
      if (known.has(pid) || pid === process.pid || (ppid !== child.pid && !known.has(ppid))) continue;
      const [from, until] = window(ppid);
      if (t < from || t >= until) continue;
      known.set(pid, t); grew = true;
    }
  }
}
function killTree(child) {
  if (process.platform !== 'win32') { try { child.kill('SIGKILL'); } catch {} return; }
  // The root only while it hasn't exited (node still holds its handle, so its pid can't have been reused);
  // taskkill /T also takes the descendants it can still reach.
  if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  if (!child.startedAt) return;
  // taskkill /T can't walk past exited processes (orphans keep the dead parent's id): kill what is left of
  // the known tree, each process verified by its creation time (never a reused pid).
  try {
    const procs = processTable();
    learnTree(child, procs);
    for (const [pid, , t] of procs) {
      const k = child.known.get(pid);
      if (k !== undefined && Math.abs(k - t) < 1000) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    }
  } catch {}
}

// Codex workers still running. If gpt.js itself is cancelled (Ctrl+C / terminate), their process trees
// are stopped too, so a GPT run never keeps operating after its bridge — and its locks — are gone.
const liveChildren = new Set();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { for (const c of liveChildren) try { killTree(c); } catch {} process.exit(130); }); } catch {}
}

function runCodex({ prompt, effort, sandbox, mode, cwd = root, resume, persist, json, onSpawn }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-'));
  const outFile = path.join(tmp, 'last.txt');
  const args = codexArgs({ mode, effort, sandbox, cwd, outFile, resume, persist, json });
  const timeoutMs = (cfg.timeoutMinutes[effort] || 30) * 60000;
  return new Promise(resolve => {
    let settled = false, hard, timedOut = false;
    const settle = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(hard);
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
      r.sessionId = (String(r.raw || '').match(/session id:\s*([0-9a-f-]{36})/i) || [])[1];
      resolve(r);
    };
    const child = spawn(process.execPath, args, { cwd, windowsHide: true });
    child.startedAt = Date.now(); // lets killTree find descendants that outlive their parent
    liveChildren.add(child);
    child.on('close', () => liveChildren.delete(child));
    if (onSpawn) try { onSpawn(child); } catch {}
    let raw = '';
    child.stdout.on('data', d => { raw += d; });
    child.stderr.on('data', d => { raw += d; });
    child.stdin.on('error', () => {}); // EPIPE if codex dies early; the close/error path reports it
    const timer = setTimeout(() => {
      timedOut = true;
      raw += `\n[gpt.js] TIMEOUT after ${timeoutMs / 60000} min`;
      killTree(child);
      // If orphaned descendants keep the pipes open, 'close' may never fire: give up after 15s.
      hard = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); settle({ ok: false, reason: 'TIMEOUT (process did not exit)', raw }); }, 15000);
    }, timeoutMs);
    child.on('error', e => settle({ ok: false, reason: 'spawn failed: ' + e.message, raw }));
    child.on('close', code => {
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
      // A timeout is always reported as TIMEOUT (never retried), whatever stderr printed afterwards.
      if (timedOut) return settle({ ok: false, reason: `TIMEOUT after ${timeoutMs / 60000} min (codex exit ${code})`, raw });
      if (code === 0 && text) return settle({ ok: true, text, raw });
      const hint = (raw.match(/(error[^\n]*|usage limit[^\n]*|rate limit[^\n]*|not logged in[^\n]*|TIMEOUT[^\n]*)/gi) || [])
        .filter(l => !/rmcp|oauth|grubby|22345|22346/i.test(l)).slice(-1)[0];
      settle({ ok: false, reason: `codex exit ${code}${text ? '' : ', empty answer'}${hint ? ': ' + hint.slice(0, 200) : ''}`, raw });
    });
    child.stdin.end(prompt);
  });
}

// Review-type answers must carry a verdict; anything else (e.g. "I couldn't access the files")
// is treated as NOT performed, so it can never silently satisfy the review gate.
const VERDICTS = {
  review: ['NO_ISSUES', 'ISSUES_FOUND', 'RESOLVED', 'ISSUES_REMAIN'],
  plan: ['SOUND', 'CHANGES_RECOMMENDED', 'RETHINK'],
  idea: ['AGREE', 'AGREE_WITH_CHANGES', 'DISAGREE'],
};
// The answer's FIRST non-empty line must be "VERDICT: <allowed value>"; anything else (no verdict,
// "VERDICT: BLOCKED", a verdict quoted mid-text) means the review was not actually performed.
function checkVerdict(r, kind) {
  if (!r.ok || !VERDICTS[kind]) return r;
  // Strip markdown decoration (**, `, #, >) but keep underscores: they are part of values like NO_ISSUES.
  // Exactly one VERDICT line in the whole answer, and it must be the (unquoted) first line.
  const verdictLines = r.text.split('\n').filter(l => /^[\s*#>`_]*VERDICT[\s*`_]*:/i.test(l)).length;
  const first = (r.text.split('\n').find(l => l.trim()) || '').replace(/[*`#]/g, '').trim();
  const m = first.match(/^VERDICT\s*:\s*([A-Z_]+)\s*$/i);
  if (m && verdictLines === 1 && VERDICTS[kind].includes(m[1].toUpperCase())) return { ...r, verdict: m[1].toUpperCase() };
  return { ...r, ok: false, badVerdict: true, reason: 'GPT gave no valid VERDICT (review not actually performed): ' + r.text.slice(0, 200).replace(/\s+/g, ' ') };
}

// One shared failure policy. Never retried: timeouts (the old process may still run), usage/rate limits
// and login problems (an immediate retry can't succeed), and verdict slips (repaired instead).
const LIMIT_ERR = /usage limit|rate limit|quota|too many requests|\b429\b/i;
const LOGIN_ERR = /not logged in|login required|unauthori[sz]ed|\b401\b/i;
function retryable(r) {
  return !r.ok && !r.badVerdict && !/TIMEOUT/.test(r.reason) && !LIMIT_ERR.test(r.reason) && !LOGIN_ERR.test(r.reason) && !/cooldown/.test(r.reason);
}

// `before` runs before each attempt (write mode uses it to give every attempt a fresh staged copy).
// Computer use is never retried automatically: repeating UI actions (clicks, toggles) is unsafe.
async function ask({ mode, prompt, effort, sandbox, meta = '', cwd, before, resume, persist, noRetry, onSpawn }) {
  const started = Date.now();
  const kind = mode.replace(/-r\d+$/, '');
  const tokensOf = x => Number(((String(x.raw || '').match(/tokens used\s*\n\s*([\d,]+)/i) || [])[1] || '0').replace(/,/g, ''));
  let r, tokens = 0; // tokens summed over all attempts, so stats include retries/repairs
  const g = L.readState(L.HOME);
  if ((g.limitUntil || 0) > Date.now() && !opts['force-gpt']) {
    // Usage/rate limit hit recently: fail fast instead of piling more calls onto the limit.
    r = { ok: false, raw: '', reason: `usage/rate limit cooldown until ${new Date(g.limitUntil).toLocaleTimeString()} (${g.limitReason}) — pass --force-gpt to try anyway` };
  } else {
    // Format slip: one cheap, answer-only repair in the same saved session — never a full re-run, and
    // never a made-up verdict (GPT must say NOT_COMPLETED if it did not actually finish the work).
    const repair = async x => {
      if (!(x.badVerdict && x.sessionId && (persist || resume))) return x; // only saved sessions can be resumed
      const fix = await runCodex({ prompt: `Your previous answer did not start with the required verdict line. Do NOT explore, read files or run commands now. If you completed the work, restate your final answer exactly, with the first line "VERDICT: <one of ${VERDICTS[kind].join(' | ')}>". If you could not complete it, reply only: NOT_COMPLETED: <reason>.`, effort, sandbox, mode: kind, cwd, resume: x.sessionId });
      tokens += tokensOf(fix);
      const fixed = checkVerdict(fix, kind);
      return fixed.ok ? { ...fixed, sessionId: x.sessionId, raw: x.raw + '\n--- format repair ---\n' + fix.raw }
        : { ...x, reason: `review not completed (${String(fix.text || fix.reason || '').slice(0, 160)})`, raw: x.raw + '\n--- format repair ---\n' + fix.raw };
    };
    if (before) before();
    r = checkVerdict(await runCodex({ prompt, effort, sandbox, mode: kind, cwd, resume, persist, onSpawn }), kind);
    tokens += tokensOf(r);
    r = await repair(r);
    if (retryable(r) && !noRetry && kind !== 'computer') {
      console.error(`[gpt.js] attempt 1 failed (${r.reason}); retrying once...`);
      if (before) before();
      r = checkVerdict(await runCodex({ prompt, effort, sandbox, mode: kind, cwd, resume, persist, onSpawn }), kind);
      tokens += tokensOf(r);
      r = await repair(r); // the retry gets the same repair, still only one retry in total
    }
    if (!r.ok && LIMIT_ERR.test(r.reason)) L.updateState(L.HOME, s => { s.limitUntil = Date.now() + 15 * 60000; s.limitReason = r.reason.slice(0, 120); });
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const log = path.join(logDir(), `${stamp()}_${mode}_${Math.random().toString(36).slice(2, 6)}.md`);
  fs.writeFileSync(log,
    `# GPT ${mode} — ${new Date().toLocaleString()}\n\n- Project: ${root}\n- Model: ${cfg.model} | effort: ${effort} | sandbox: ${sandbox} | ${secs}s | ${resume ? 'resumed session' : 'fresh session'}\n` +
    `${r.sessionId ? `- Session: ${r.sessionId}\n` : ''}${meta}\n` +
    `## Prompt\n\n${prompt}\n\n## GPT answer\n\n${r.ok ? r.text : '**FAILED:** ' + r.reason + (r.text ? '\n\n' + r.text : '')}\n\n## Claude's decisions\n\n`);
  fs.writeFileSync(log.replace(/\.md$/, '.raw.log'), r.raw || '');
  // GPT's answer on its own, so follow-ups never have to parse it out of the log (whose prompt part
  // can itself contain "## GPT answer", e.g. when gpt.js reviews its own source).
  if (r.ok) fs.writeFileSync(log.replace(/\.md$/, '.answer.md'), r.text);
  // One line per call for `gpt.js stats` (measure speed/quality before optimising further).
  const verdict = (r.ok && r.verdict) || '-'; // normalised once by checkVerdict
  // Result quality: findings raised, and how follow-ups settled earlier ones (CONCEDE = a withdrawn false alarm).
  const text = r.ok ? String(r.text) : '';
  const findings = (text.match(/^###\s*\[(CRITICAL|HIGH|MEDIUM|LOW)\]/gim) || []).length;
  const settled = ['CONCEDE', 'RESOLVED', 'MAINTAIN', 'OPEN'].map(k => (text.match(new RegExp(`^\\s*\\d+\\.\\s*${k}\\b`, 'gim')) || []).length).join('/');
  try { fs.appendFileSync(path.join(logDir(), 'index.tsv'), [new Date().toISOString(), mode, r.ok ? 'ok' : 'fail', verdict, secs, resume ? 'resume' : 'fresh', path.basename(log), tokens, findings, settled].join('\t') + '\n'); } catch {}
  return { ...r, log, secs, started, verdict, tokens };
}

function markUnavailable(reason, global) {
  L.updateState(global ? L.HOME : root, s => { s.gptUnavailableAt = Date.now(); s.gptUnavailableReason = reason; });
}

function finish(r, onOk) {
  if (r.ok) {
    onOk && onOk();
    console.log(r.text);
    console.log(`\n---\n[gpt.js] log: ${r.log} (${r.secs}s${r.tokens ? `, ${Math.round(r.tokens / 1000)}k tokens` : ''})`);
    process.exit(0);
  }
  console.log(`GPT_UNAVAILABLE: ${r.reason}\n[gpt.js] log: ${r.log}`);
  process.exit(3);
}

const sigOf = (...p) => require('crypto').createHash('sha1').update(JSON.stringify(p)).digest('hex').slice(0, 16);
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
  let changed = false;
  const snapDir = path.join(L.HOME, 'snap', stamp() + '-' + Math.random().toString(36).slice(2, 6));
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

// Build/test/compile output Claude wants GPT to see. --evidence "cmd1 ;; cmd2" runs the commands here
// (cwd = project); --evidence-file attaches output Claude already captured.
// Run one shell command with a timeout that stops the WHOLE process tree (builders the shell started
// too), while the shell is still alive so taskkill /T can find its children.
// Windows: evidence commands run inside a Job Object that kills every process still in it when the job
// helper exits or is killed — workers that outlive their shell or launcher included (process trees can't
// be traced once intermediate processes have exited). The helper (detached, so it is outside node's own
// job, whose silent breakaway would let grandchildren escape) runs `cmd /d /s /c "<command>"` like
// spawn's shell option, forwards its output and exit code. If the job can't be created the command still
// runs, and the output says so (leftover processes are then only ended at a timeout, via killTree).
const JOB_RUNNER = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class GptJob {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT { public BASIC Basic; public IO Io; public UIntPtr p1, p2, p3, p4; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static bool Enter() {
    IntPtr j = CreateJobObject(IntPtr.Zero, null);
    if (j == IntPtr.Zero) return false;
    EXT i = new EXT(); i.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(j, 9, ref i, (uint)Marshal.SizeOf(typeof(EXT)))) return false;
    return AssignProcessToJobObject(j, GetCurrentProcess());
  }
}
'@
if (-not [GptJob]::Enter()) { throw 'job setup failed' }
} catch { [Console]::Out.WriteLine('[gpt.js] warning: process containment unavailable: ' + $_.Exception.Message) }
$si = New-Object System.Diagnostics.ProcessStartInfo
$si.FileName = $env:ComSpec
$si.Arguments = '/d /s /c "' + $env:GPTJS_CMD + '"'
$si.UseShellExecute = $false
$si.CreateNoWindow = $true
$si.RedirectStandardOutput = $true
$si.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($si)
$out = [Console]::OpenStandardOutput()
$t1 = $p.StandardOutput.BaseStream.CopyToAsync($out)
$t2 = $p.StandardError.BaseStream.CopyToAsync($out)
$p.WaitForExit()
[void][System.Threading.Tasks.Task]::WaitAll(@($t1, $t2), 3000)
$out.Flush()
exit $p.ExitCode`;

const CONTAINMENT_WARNING = '[gpt.js] warning: process containment unavailable';
const UNCONTAINED_NOTE = 'process containment unavailable — processes it left behind are only ended at a timeout';

function runTracked(cmd, timeoutMs) {
  return new Promise(resolve => {
    // stdin ignored = immediate EOF (as with spawnSync), so commands that read stdin don't hang.
    const child = process.platform === 'win32'
      ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(JOB_RUNNER, 'utf16le').toString('base64')],
        { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GPTJS_CMD: cmd } })
      : spawn(cmd, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.startedAt = Date.now(); // lets killTree find descendants if the job could not be created
    liveChildren.add(child); // stopped with the rest if gpt.js is cancelled
    child.on('close', () => liveChildren.delete(child));
    let buf = '', timedOut = false, done = false, dropped = false, head = '';
    // `contained`: the Job Object was set up (its warning is the helper's first output line). Reported
    // separately, since the kept output is only the tail.
    const finish = status => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(hard);
      const contained = process.platform === 'win32' && !head.includes(CONTAINMENT_WARNING);
      if (!contained) buf = buf.split('\n').filter(l => !l.includes(CONTAINMENT_WARNING)).join('\n');
      resolve({ out: (dropped ? '[gpt.js] (earlier output dropped: over the capture limit)\n' : '') + buf, status: timedOut ? null : status, contained });
    };
    // Keep a rolling window of the latest output: the END (final errors, summary) is what matters.
    const CAP = 8 * 1024 * 1024;
    const add = d => { if (head.length < 4096) head += d; buf += d; if (buf.length > CAP) { buf = buf.slice(-CAP / 2); dropped = true; } };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let hard;
    const timer = setTimeout(() => {
      timedOut = true; killTree(child);
      hard = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 15000);
    }, timeoutMs);
    child.on('error', e => { buf += `\n${e.message}`; finish(1); });
    child.on('close', code => finish(code));
  });
}

async function evidence() {
  // During a usage-limit cooldown the GPT call will be refused anyway: don't run builds/tests for nothing.
  if ((L.readState(L.HOME).limitUntil || 0) > Date.now() && !opts['force-gpt']) return '';
  let out = '';
  const summary = [];
  for (const c of String(opts.evidence || '').split(';;').map(s => s.trim()).filter(Boolean)) {
    const t = Date.now();
    const r = await runTracked(c, (cfg.evidenceTimeoutMinutes || 10) * 60000);
    const lines = r.out.split(/\r?\n/);
    const tail = lines.slice(-(cfg.evidenceTailLines || 120)).join('\n');
    const status = r.status === null ? 'TIMEOUT/killed' : `exit ${r.status}`;
    summary.push(`${c} -> ${status}${r.contained ? '' : ` (${UNCONTAINED_NOTE})`}`);
    out += `$ ${c}\n(${status}, ${Math.round((Date.now() - t) / 1000)}s${lines.length > (cfg.evidenceTailLines || 120) ? `, last ${cfg.evidenceTailLines || 120} lines` : ''}${r.contained ? '' : `; ${UNCONTAINED_NOTE}`})\n${tail}\n\n`;
  }
  if (opts['evidence-file']) {
    const lines = readArgFile(opts['evidence-file']).split(/\r?\n/);
    out += `(captured output: ${opts['evidence-file']})\n${lines.slice(-(cfg.evidenceTailLines || 120)).join('\n')}\n`;
    summary.push(`file ${opts['evidence-file']}`);
  }
  if (summary.length) console.log(`[gpt.js] evidence: ${summary.join(' | ')}`);
  return out ? `\nEVIDENCE (build/test/compile output — treat failures as facts, check whether the change caused them):\n\`\`\`\n${out.trim()}\n\`\`\`\n` : '';
}

// Announce a running review (pid, frozen files, cutoff) so the Stop hook doesn't nag Claude while this
// review already covers exactly those change versions. Removed when gpt.js exits (success or failure).
// `sig` identifies the request (task, focus, evidence, files): an identical request while one is still
// running — same files, nothing edited since it froze them — is refused instead of paying for it twice.
function registerRunning(files, cutoff, sig, snaps) {
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
      const res = (path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p)).toLowerCase();
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
  const pendingFiles = L.pending(L.readState(root)).map(([f]) => f);
  const mat = pendingFiles.length ? reviewMaterial(pendingFiles, false, true) : null;
  const prompt = `You are diagnosing a bug for Claude (another AI, the only one who writes code), so Claude can skip the exploration. ${READONLY_NOTE}\n\n` +
    `SYMPTOM / QUESTION:\n${opts.question}\n` +
    (opts.expected ? `\nEXPECTED: ${opts.expected}\n` : '') + (opts.actual ? `ACTUAL: ${opts.actual}\n` : '') +
    (opts.tried ? `\nALREADY TRIED (did not fix it): ${opts.tried}\n` : '') +
    `\nLOOK AT:\n${targets.map(t => '- ' + t).join('\n')}\n` +
    (mat ? `\nCLAUDE'S RECENT UNCOMMITTED CHANGES (possible cause):${mat.text}` : '') + (await evidence()) + lessonsBlock() +
    `\nRULES: search first, read only the relevant regions, at most about 10 short read-only commands. Do NOT run tests, builds or scripts and do not build reproductions — recommend checks in words instead. Mark each evidence item [code] (inferred from reading) or [runtime] (seen in logs/output).\n\n` +
    `Answer compactly (under ${opts.max || 350} words):\nDIAGNOSIS: the supported cause, or "UNRESOLVED" plus the competing hypotheses ranked\nEVIDENCE: up to 8 bullets "path:line [code|runtime] — short quote/value"\n` +
    `NEXT CHECK: the single check that best confirms or rules out the diagnosis\nFIX IDEA: in words (Claude writes the code)\nCONFIDENCE: high | medium | low`;
  const r = await ask({ mode: 'investigate', prompt, effort: effortFor(), sandbox: 'read-only' });
  if (mat) try { fs.rmSync(mat.snapDir, { recursive: true, force: true }); } catch {}
  if (!r.ok) markUnavailable(r.reason);
  return finish(r);
}

// The source set an MQL4/5 file compiles from: the file plus its #include files, followed recursively
// ("x.mqh" next to the including file, then <x.mqh> in the terminal's MQL5|MQL4/Include folder).
// Returns { files, hash (one sha256 over every path + content), newest (latest change), missing,
// truncated (stopped at 500 files: the fingerprint doesn't cover the rest) }.
function mqlSources(main) {
  let up = path.dirname(main), inc = null;
  for (; ;) { if (/^mql[45]$/i.test(path.basename(up))) { inc = path.join(up, 'Include'); break; } const p = path.dirname(up); if (p === up) break; up = p; }
  const seen = new Map(), missing = [], queue = [path.resolve(main)];
  while (queue.length && seen.size < 500) {
    const f = queue.shift();
    if (seen.has(f.toLowerCase())) continue;
    let buf; try { buf = fs.readFileSync(f); } catch { missing.push(f); continue; }
    seen.set(f.toLowerCase(), { f, buf, m: fs.statSync(f).mtimeMs });
    const text = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.slice(2).toString('utf16le') : buf.toString('utf8');
    for (const [, q, a] of text.matchAll(/^\s*#include\s+(?:"([^"]+)"|<([^>]+)>)/gm)) {
      const name = (q || a).replace(/[\\/]+/g, path.sep);
      const local = path.resolve(path.dirname(f), name), lib = inc && path.resolve(inc, name);
      queue.push(q && fs.existsSync(local) ? local : lib && fs.existsSync(lib) ? lib : q ? local : (lib || local));
    }
  }
  const all = [...seen.values()].sort((x, y) => (x.f < y.f ? -1 : 1));
  const h = require('crypto').createHash('sha256');
  for (const x of all) h.update(x.f.toLowerCase()).update(x.buf);
  const newest = all.length ? new Date(Math.max(...all.map(x => x.m))).toISOString() : 'n/a';
  return { files: all.length, hash: h.digest('hex').slice(0, 12), newest, missing, truncated: queue.length > 0 };
}

// MQL5 code gets a trading-specific checklist (only when MQL5 files are in the review).
function mql5Block(files) {
  if (!files.some(f => /\.(mq5|mqh|mq4|set)$/i.test(f))) return '';
  return `\nMQL5 CHECKLIST — check what the change touches, skip the rest:\n` +
    `- .set presets: risk %/lot/SL/TP/multiplier values vs the EA's inputs and their safe ranges; martingale/grid multipliers or max-lot caps raised; values that change behaviour silently\n` +
    `- risk/lot sizing: risk limit respected; volume normalised DOWN to SYMBOL_VOLUME_STEP and checked against MIN/MAX — if SYMBOL_VOLUME_MIN would exceed the risk limit, skip the trade instead of clamping up; tick size/value (not just point) used for money per lot\n` +
    `- prices/stops: aligned to SYMBOL_TRADE_TICK_SIZE (rounding to digits alone is not enough on instruments with larger ticks), then NormalizeDouble; SL/TP vs SYMBOL_TRADE_STOPS_LEVEL and FREEZE_LEVEL; correct Bid/Ask side\n` +
    `- account mode: netting vs hedging assumptions; position selection by symbol AND magic number\n` +
    `- execution: OrderSend/CTrade result and retcode checked (requote, rejected, partial fill, no money, market closed); filling mode supported\n` +
    `- lifecycle: restart/recovery rebuilds state from open positions/orders; no logic that assumes it ran since the start\n` +
    `- tester vs live differences (time functions, history access, symbols not in Market Watch)\n`;
}

// One '- Name: value' metadata line from a log. Splits on '\n' only, so values may contain characters
// that JS regex '.' treats as line ends (e.g. U+2028 in a file name).
function metaField(text, name) {
  const line = String(text).split('\n').find(l => l.startsWith(`- ${name}: `));
  return line ? line.slice(name.length + 4).replace(/\r$/, '') : undefined;
}

function lessonsBlock() {
  const l = L.readLessons(root);
  return l.length ? `\nPROJECT LESSONS (confirmed past mistakes in this project — check the change does not repeat them):\n${l.join('\n')}\n` : '';
}

// ---- Document writing: GPT edits staged copies; Claude reviews; `apply` copies back. ----
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
  if (!/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-z0-9]{4}$/.test(String(id))) die(`invalid stage id "${id}"`);
  const dir = path.join(STAGE_DIR, String(id));
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) die(`no staged write "${id}" (see ${STAGE_DIR})`);
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
      if (alive) die(`stage ${id} is busy (another gpt.js run${pid ? ' pid ' + pid : ''} is using it); wait for it to finish`);
      fs.rmSync(lockDir, { recursive: true, force: true }); // abandoned: reclaim and retry once
    }
  }
  die(`could not lock stage ${id}`);
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
      const max = cfg.writeDiffMaxLines || 400;
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
  const effort = effortFor();
  // GPT edits a scratch copy that becomes the staged version only when the run succeeds: a failed or
  // interrupted revision never leaves partial, unreviewed edits where `apply` would pick them up.
  const next = path.join(dir, 'next');
  const r = await ask({
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
  if (r.ok && !unfinished) try { publishDir(next, path.join(dir, 'work')); } catch (e) { publishError = e; if (m.round > 1) m.round -= 1; }
  // (an unfinished attempt stays readable in `next` until the next run replaces it)
  if (!unfinished) try { fs.rmSync(next, { recursive: true, force: true }); } catch {}
  saveManifest(dir, m);
  if (publishError) { console.error(`Could not stage GPT's result (${publishError.message}); the previous staged version is unchanged. Retry the write/revise.`); process.exit(1); }
  if (!r.ok) { markUnavailable(r.reason); finish(r); }
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

const READONLY_NOTE = 'You are in a READ-ONLY sandbox. Never create, edit or delete files. You may read files and run read-only commands (git diff/log, grep, listing) to verify claims.';
// Keeps GPT from burning minutes and tokens on self-built test rigs (measured: 11 of 16 reviews did).
const EFFORT_RULES = `HOW TO VERIFY (efficiency rules):\n` +
  `- Verify by READING the code, its callers and callees. Do not execute tests, builds or scripts by default.\n` +
  `- Run a command only when one concrete claim cannot be settled by reading — at most a few short read-only commands.\n` +
  `- NEVER build simulation harnesses, VMs, mock filesystems or in-memory reproductions.\n` +
  `- Never re-run builds/tests already given as EVIDENCE unless that evidence is stale or does not cover your specific claim.\n` +
  `- Report only failures REACHABLE in this project's actual use (including its own documented workflows, e.g. parallel reviews): state the concrete trigger. Skip contrived scenarios (deliberately planted links in tool folders, multi-day suspended processes, impossible timings). Rate severity by impact x likelihood.\n` +
  `- Read only the line ranges you need (search first, then read around the hits) instead of whole files; never re-read a file you already read in this session unless the diff changed that part.\n` +
  `- Follow applicable AGENTS.md instructions, but don't open optional skill files unrelated to this task.\n` +
  `- Depth proportional to the size and risk of the change.\n`;
const ROLE = 'You are working alongside another AI, Claude, which is the ONLY author of code in this project. You never write the code: describe fixes in words or with a minimal snippet; Claude implements them.';

const FINDING_FORMAT = `### [CRITICAL|HIGH|MEDIUM|LOW] <title>\n- Location: file:line\n- Failure: concrete input/state -> wrong result (one sentence)\n- Fix: <one sentence or a minimal snippet>\n- Test (CRITICAL/HIGH only): <input/state> -> <expected result>  (a regression test Claude should add)\n`;

// A review chain, newest first: the given round's log and the logs it follows (its "- Follows:" line).
function chainLogs(log, max = 10) {
  const out = [];
  for (let l = log; l && out.length < max;) {
    out.push(l);
    try { l = metaField(fs.readFileSync(l, 'utf8'), 'Follows'); } catch { l = null; }
  }
  return out;
}

// A follow-up round (`review --followup <log> --file <response>`): GPT re-checks its open findings against
// Claude's response and the diff since its last round — resuming its own session when possible.
async function reviewFollowup(effort, deletedAtStart) {
  const prevLog = path.resolve(opts.followup);
  const prev = fs.readFileSync(prevLog, 'utf8');
  const round = (Number((prev.match(/- Round: (\d+)/) || [])[1]) || 1) + 1;
  if (round > cfg.maxRounds) {
    console.log(`MAX_ROUNDS_REACHED (${cfg.maxRounds}). Claude makes the final decision now: gpt.js mark-reviewed --by claude-final --files "..." --note "..."`);
    process.exit(4);
  }
  if (!opts.file) die('--followup needs --file <your response to each finding>');
  const response = readArgFile(opts.file);
  const scopeLine = metaField(prev, 'Scope') || 'ALL';
  const scope = scopeLine === 'ALL' ? null : JSON.parse(scopeLine);
  const files = JSON.parse(metaField(prev, 'Files') || 'null') || scope || L.pending(L.readState(root)).map(([f]) => f);
  const cutoff = Date.now(); // edits after this moment (during evidence collection or the run) stay pending
  const mat = reviewMaterial(files, false, true, roundBases(prevLog));
  registerRunning(files, cutoff, sigOf('followup', prevLog, response, opts.evidence || '', opts['evidence-file'] || ''), mat.map);
  const tail = `${mat.text}${await evidence()}\n${EFFORT_RULES}\nFOLLOW-UP SCOPE: re-check ONLY (a) the findings Claude's response disputes or claims fixed and (b) behaviour affected by the new diff. The diff above shows exactly what changed since your last review: start there and read only the specific lines you need — do not re-read whole files. Do not re-verify findings already RESOLVED/CONCEDED earlier unless the new diff touches them. If you maintain a finding, give stronger concrete evidence (exact trigger -> wrong result). Concede when Claude is right.\n\n` +
    `Format (compact):\nVERDICT: RESOLVED | ISSUES_REMAIN — RESOLVED only if EVERY earlier finding is now resolved or conceded; a finding Claude's response does not address is still open (carry it forward without re-verifying it).\n` +
    `One line per earlier finding: "<n>. CONCEDE | RESOLVED | MAINTAIN | OPEN — <one-sentence reason>" (OPEN = not addressed by Claude). For every MAINTAIN and OPEN line add "- Location: file:line". Then NEW confirmed defects only:\n${FINDING_FORMAT}No preamble, no links.`;
  // The whole chain: its open findings are what this round re-checks (and may clear).
  const chain = chainLogs(prevLog);
  // Original requirements travel with every round (needed if a round has to start a fresh session).
  // Older round logs may lack Task/Focus: take them from the nearest earlier round that has them.
  let taskLine = '', focusLine = '';
  for (const l of chain.slice(0, 5)) {
    let t = ''; try { t = fs.readFileSync(l, 'utf8'); } catch { break; }
    taskLine = metaField(t, 'Task') || '';
    focusLine = focusLine || (metaField(t, 'Focus') || (t.match(/^FOCUS AREAS: ([^\n]*)$/m) || [])[1]) || ''; // older logs: prompt line
    if (taskLine) break;
  }
  const meta = `- Round: ${round}\n- Follows: ${prevLog}\n- Task: ${taskLine}\n${focusLine ? `- Focus: ${focusLine}\n` : ''}- Scope: ${scopeLine}\n- Files: ${JSON.stringify(files)}\n`;
  const dropSnap = () => { try { fs.rmSync(mat.snapDir, { recursive: true, force: true }); } catch {} };
  // markReviewed copies the frozen files into the new baselines, so the snapshot is removed after it.
  // Acknowledge exactly the files that were frozen and shown to GPT — nothing else.
  const done = r => { if (!r.ok) dropSnap(); return finish(r, () => { markReviewed('gpt', cutoff, files, deletedAtStart, { verdict: r.verdict, log: r.log, snaps: mat.map, findingFiles: findingFiles(r.text, mat, files), resolves: chain }); keepRound(r.log, mat.map); dropSnap(); }); };
  // Fast path: resume GPT's own session from the previous round (it still has the code in context).
  const sid = (prev.match(/^- Session: (\S+)$/m) || [])[1];
  if (sid && !opts.fresh) {
    const r = await ask({ mode: `review-r${round}`, prompt: `Round ${round} of ${cfg.maxRounds} of our review discussion. ${READONLY_NOTE}\n\nCLAUDE'S RESPONSE (fixes made / findings disputed, with reasoning):\n${response}\n${tail}`, effort, sandbox: 'read-only', resume: sid, noRetry: true, meta });
    if (r.ok || !retryable(r)) return done(r);
    console.error(`[gpt.js] resuming session failed (${r.reason}); running a fresh round instead...`);
  }
  // Fresh session: give it the original task and EVERY earlier round's answer (round 1 holds the full
  // finding details; later rounds hold their status), read from the stored answer files.
  const history = chain.slice(0, 5).map(l => {
    try { return fs.readFileSync(l.replace(/\.md$/, '.answer.md'), 'utf8').trim(); } catch {}
    // Older logs: the answer section starts at the LAST line that is exactly "## GPT answer"
    // (a quote of it inside a finding is never a whole line on its own).
    let lines = []; try { lines = fs.readFileSync(l, 'utf8').split(/\r?\n/); } catch {}
    const at = lines.map(x => x.trim()).lastIndexOf('## GPT answer');
    const end = lines.findIndex((x, i) => i > at && x.trim() === "## Claude's decisions");
    return (at < 0 ? '' : lines.slice(at + 1, end < 0 ? undefined : end).join('\n')).trim();
  }).reverse();
  const prevAnswer = history.map((h, i) => `--- Round ${i + 1} ---\n${h}`).join('\n\n');
  const r = await ask({ mode: `review-r${round}`, prompt: `${ROLE}\n${READONLY_NOTE}\n\nThis is round ${round} of ${cfg.maxRounds} of a review discussion.\n` +
    (taskLine ? `\nORIGINAL TASK / REQUIREMENTS:\n${taskLine}\n` : '') + (focusLine ? `FOCUS: ${focusLine}\n` : '') +
    `\nYOUR EARLIER REVIEW ROUNDS:\n${prevAnswer}\n\nCLAUDE'S RESPONSE (fixes made / findings disputed, with reasoning):\n${response}\n${tail}`, effort, sandbox: 'read-only', persist: true, meta });
  return done(r);
}

const commands = {
  async review() {
    const effort = effortFor();
    const deletedAtStart = L.gitDeleted(root);
    if (opts.followup) return reviewFollowup(effort, deletedAtStart);
    if (!opts.task) die('review needs --task "<what the change is supposed to accomplish>"');
    const s = L.readState(root);
    // --files limits the review AND what it clears; without it, all pending changes are covered.
    const scope = opts.files ? String(opts.files).split(',').map(f => path.resolve(f.trim())).filter(Boolean) : null;
    const files = scope || L.pending(s).map(([f]) => f);
    if (!files.length) {
      const cand = (L.gitStatus(root) || []).filter(e => L.isCode(e.abs)).map(e => e.abs);
      die((s._unreadable ? `Change tracking is unavailable (${L.statePath(root)} is unreadable: ${s._unreadable}), so pending changes are unknown.`
        : 'Nothing tracked to review (no pending changes).') + ` Pass the files explicitly with --files "a,b"` + (cand.length ? `. Changed code files in git: ${cand.slice(0, 20).join(', ')}` : '.'));
    }
    const cutoff = Date.now(); // edits after this moment (during evidence collection or the run) stay pending
    const mat = reviewMaterial(files, !!opts.full);
    registerRunning(files, cutoff, sigOf('review', mat.full ? 'full' : 'diff', opts.task, opts.focus || '', opts.evidence || '', opts['evidence-file'] || ''), mat.map);
    const prompt = `${ROLE}\nYour job: an independent, rigorous code review. ${READONLY_NOTE}\n\nWHAT THE CHANGE IS MEANT TO ACCOMPLISH:\n${opts.task}\n` +
      (opts.focus ? `\nFOCUS AREAS: ${opts.focus}\n` : '') +
      mat.text + (await evidence()) + lessonsBlock() + mql5Block(files) +
      `\nStart from the DIFF. Read surrounding code in the project (callers, callees, definitions) only as needed to verify behaviour; read whole files only when the diff is not enough.\n` +
      `Look for: correctness bugs, unhandled edge cases, error handling, wrong assumptions about APIs, security issues, concurrency/race issues, data loss, resource leaks, and for trading code order/position/lot/stop-loss/risk logic. Also flag a design decision that is clearly wrong or will be hard to undo. Ignore pure style/formatting.\n\n` +
      `${EFFORT_RULES}BEFORE REPORTING: confirm every candidate finding (re-read the code path, check callers, trace the failing input). Drop anything you could not confirm — Claude must re-verify each finding, so false positives are costly.\n\n` +
      `Format (compact — Claude's reading budget is limited):\nVERDICT: NO_ISSUES | ISSUES_FOUND\nThen, most severe first, max 10 CONFIRMED findings, each at most 5 lines:\n${FINDING_FORMAT}` +
      `No preamble, no praise, no summary of what you checked, no links.`;
    const r = await ask({ mode: 'review', prompt, effort, sandbox: 'read-only', persist: true, meta: `- Round: 1\n- Task: ${String(opts.task).replace(/\s+/g, ' ')}\n${opts.focus ? `- Focus: ${String(opts.focus).replace(/\s+/g, ' ')}\n` : ''}- Scope: ${scope ? JSON.stringify(scope) : 'ALL'}\n- Files: ${JSON.stringify(files)}\n` });
    const dropSnap = () => { try { fs.rmSync(mat.snapDir, { recursive: true, force: true }); } catch {} };
    if (!r.ok) { markUnavailable(r.reason); dropSnap(); }
    // Acknowledge exactly the files that were frozen and shown to GPT — nothing else.
    return finish(r, () => { markReviewed('gpt', cutoff, files, deletedAtStart, { verdict: r.verdict, log: r.log, snaps: mat.map, findingFiles: findingFiles(r.text, mat, files) }); keepRound(r.log, mat.map); dropSnap(); });
  },

  async plan() {
    if (!opts.file) die('plan needs --file <plan.md|->');
    const effort = effortFor();
    const st0 = L.readState(root);
    const turnAtStart = st0.userTurnAt || st0.turnStartedAt || null; // the user turn (stable across continuations)
    const planText = readArgFile(opts.file);
    const prompt = `${ROLE}\nClaude drafted the PLAN below and will implement it. Review it as a skeptical senior architect. ${READONLY_NOTE} Check the plan's claims by reading the actual project files: search first, read only the relevant regions, no tests or test rigs.\n\nPLAN:\n${planText}\n\n` +
      `Look for: wrong assumptions, missing steps, risks and failure modes, things that are hard to undo, simpler or more robust alternatives, missing tests/verification, ordering problems.\n\nFormat:\nVERDICT: SOUND | CHANGES_RECOMMENDED | RETHINK\nthen at most 8 numbered points, most important first, each 1-3 sentences with WHY and WHAT TO CHANGE. Be concrete; no praise, no preamble.`;
    const r = await ask({ mode: 'plan', prompt, effort, sandbox: 'read-only', persist: true });
    if (!r.ok) markUnavailable(r.reason);
    // Tie the approval to the turn in which the review STARTED (a late background result must not
    // authorize a plan from a later turn). The reviewed text is kept so a lightly revised version of
    // the SAME plan (user asks for a small tweak) doesn't need a whole new GPT review.
    return finish(r, () => L.updateState(root, s => { s.planReviewedAt = Date.now(); s.planReviewedTurn = turnAtStart; s.planReviewedText = planText.slice(0, 30000); }));
  },

  async idea() {
    if (!opts.file) die('idea needs --file <draft.md|->');
    const effort = effortFor();
    const prompt = `${ROLE}\nClaude is about to give the user the ideas / recommendations / advice below. Give a critical second opinion. ${READONLY_NOTE} Reason from reading (search first, read only relevant regions); no tests or test rigs.\n` +
      (opts.question ? `\nTHE USER'S QUESTION:\n${opts.question}\n` : '') + `\nCLAUDE'S DRAFT:\n${readArgFile(opts.file)}\n\n` +
      `Say which points are wrong or weak and why, what important ideas or risks are missing, and what you would recommend instead. Be concise and concrete.\n\nFormat:\nVERDICT: AGREE | AGREE_WITH_CHANGES | DISAGREE\nthen at most 7 numbered points, each 1-3 sentences. No preamble.`;
    const r = await ask({ mode: 'idea', prompt, effort, sandbox: 'read-only', persist: true });
    if (!r.ok) markUnavailable(r.reason);
    return finish(r);
  },

  // Heavy reading so Claude doesn't have to: big logs, MT5 journals/tester reports, build output, unfamiliar code.
  // --investigate: GPT diagnoses a bug from code + logs (Claude's exploration is usually its biggest cost).
  async digest() {
    if (!opts.question) die('digest needs --question "<what Claude needs to know>" and --files "<a,b>" or --dir <folder>');
    const targets = opts.files ? String(opts.files).split(',').map(f => path.resolve(f.trim())).filter(Boolean) : [];
    if (opts.dir) targets.push(path.resolve(opts.dir) + path.sep + ' (folder — search it)');
    if (!targets.length) die('digest needs --files or --dir');
    if (opts.investigate) return investigate(targets);
    // --backtest: MT5 Strategy Tester / optimization reports, read with a trading checklist.
    const backtest = opts.backtest ? `\nTHIS IS AN MT5 STRATEGY TESTER / OPTIMIZATION REPORT. Also check and report on:\n` +
      `- overfitting: few trades (<100), profit from a handful of trades, best parameter set isolated (neighbours much worse), in-sample only\n` +
      `- risk: max drawdown (money and %), max consecutive losses, largest loss vs average win, recovery factor, profit factor, Sharpe if present\n` +
      `- data quality: modelling quality / tick model, spread setting, period covered, gaps\n` +
      `- suspicious patterns: martingale/grid lot growth, trades clustered in one period, losses hidden by open positions at the end\n` +
      `- keep two questions apart: does the EA behave as coded (errors, rejected orders, wrong lots) vs. is the strategy any good\n` +
      `- a report alone can't prove robustness: say what is missing (forward/out-of-sample period, optimization neighbours, realistic costs/slippage)\n` +
      `Give a VERDICT line: QUESTIONABLE | LIKELY_OVERFIT | INSUFFICIENT_EVIDENCE | NO_RED_FLAGS (never "robust") with the 2-3 numbers that decide it.\n` : '';
    const prompt = `You are doing the heavy reading for Claude (another AI that writes the code) so Claude can save its context. ${READONLY_NOTE}\n\n` +
      `QUESTION FROM CLAUDE:\n${opts.question}\n\nREAD:\n${targets.map(t => '- ' + t).join('\n')}\n${backtest}\n` +
      `Search first (Select-String / grep for the terms the question implies: errors, failed, warnings, names, numbers), then read only the regions around the hits; for counts or patterns, count with a command instead of reading everything. Cover the whole file — not just its beginning — but never dump large parts of it. Do not run tests or builds. Then answer compactly:\n` +
      `ANSWER: the direct answer in 1-5 sentences.\nEVIDENCE: up to 15 bullets, each "path:line — the exact quoted line or value (short)". Quote exact error messages and numbers.\n` +
      `PATTERNS: counts / first and last occurrence / timing, if relevant.\nUNSURE: anything you could not determine.\n` +
      `Keep the whole answer under ${opts.max || 400} words. Never paste large blocks of the files.`;
    const r = await ask({ mode: 'digest', prompt, effort: effortFor(), sandbox: 'read-only' });
    if (!r.ok) markUnavailable(r.reason);
    return finish(r);
  },

  // Web research so Claude doesn't spend its own tokens browsing: docs, API changes, errors, MT5/broker behaviour.
  async research() {
    if (!opts.question) die('research needs --question "<what to find out>"');
    const prompt = `You are doing web research for Claude (another AI that writes the code). ${READONLY_NOTE}\n\nQUESTION:\n${opts.question}\n\n` +
      `RULES (keep it cheap): at most about 5 web searches and only the pages needed to answer; prefer official docs, changelogs and the vendor's own sites; ` +
      `do NOT run code, tests, builds or scripts and do not inspect the local project unless the question names a file. Stop as soon as the question is answered.\n\n` +
      `Answer compactly (under ${opts.max || 350} words):\nANSWER: 1-6 sentences\nDETAILS: up to 8 bullets with exact versions, names, values\n` +
      `SOURCES: the URLs used (official first), with date if shown\nUNSURE: conflicts between sources or anything unverified`;
    const r = await ask({ mode: 'research', prompt, effort: effortFor(), sandbox: 'read-only' });
    if (!r.ok) markUnavailable(r.reason);
    return finish(r);
  },

  // Test design before coding: GPT lists the cases, Claude writes the tests (GPT never writes code).
  async testplan() {
    if (!opts.task) die('testplan needs --task "<what the code must do>" [--files "<relevant code>"]');
    const files = opts.files ? String(opts.files).split(',').map(f => path.resolve(f.trim())).filter(Boolean) : [];
    const prompt = `${ROLE}\nDesign the tests Claude should write. ${READONLY_NOTE}\n\nWHAT THE CODE MUST DO:\n${opts.task}\n` +
      (files.length ? `\nRELEVANT CODE (read selectively):\n${files.map(f => '- ' + f).join('\n')}\n` : '') + lessonsBlock() +
      `\nRULES: reason from the requirements and by reading the code only. Do NOT run, write or build any tests, scripts or reproductions. ` +
      `List only cases that can really happen in this project's use; no duplicates, no trivial getters/setters.\n\n` +
      `Answer compactly: at most ${opts.max || 15} cases, most important first, each one line:\n` +
      `<n>. [CRITICAL|HIGH|MEDIUM] <input / state> -> <expected result>  (why it matters, 5-10 words)\n` +
      `Then "NOT WORTH TESTING:" one line naming what you deliberately skipped.`;
    const r = await ask({ mode: 'testplan', prompt, effort: effortFor(), sandbox: 'read-only' });
    if (!r.ok) markUnavailable(r.reason);
    return finish(r);
  },

  async computer() {
    const task = opts.task || (opts.file && readArgFile(opts.file));
    if (!task) die('computer needs --task "<goal>" or --file <task.md>');
    // One computer agent at a time across ALL projects/sessions (one mouse and keyboard). The lock is
    // owned by this pid, released on exit, and reclaimed if its owner died.
    const busy = L.updateState(L.HOME, g => {
      const o = g.computerLock;
      if (o && o.pid !== process.pid && (L.pidAlive(o.pid) || L.pidAlive(o.childPid))) return o; // bridge OR its Codex worker
      // Claude operated the desktop moments ago (its own computer-use tools): don't take over mid-sequence.
      if (g.claudeCuLastUse && Date.now() - g.claudeCuLastUse < 120000) return { pid: 'Claude', project: 'Claude is using the desktop (last action < 2 min ago)' };
      g.computerLock = { pid: process.pid, at: Date.now(), project: root };
    }, true); // strict: if ownership can't be recorded, don't start
    if (busy && busy.lockFailed) { console.log('BUSY: could not record computer-use ownership (state lock busy); try again shortly.'); process.exit(6); }
    if (busy) { console.log(`BUSY: another computer-use run is active (pid ${busy.pid}, ${busy.project}); wait for it to finish.`); process.exit(6); }
    process.on('exit', () => { try { L.updateState(L.HOME, g => { if (g.computerLock && g.computerLock.pid === process.pid) delete g.computerLock; }); } catch {} });
    const effort = effortFor();
    const prompt = `You are operating the user's Windows computer on behalf of Claude (another AI that coordinates the work). Use your Computer Use plugin (read its SKILL.md first if you have not).\n\nTASK:\n${task}\n\n` +
      `RULES:\n- Do NOT write or edit code or project files — Claude is the only one who writes code. If the task needs a code change, stop and describe what is needed.\n` +
      `- If the information is available in a file or log on disk, read the file instead of driving the UI.\n` +
      `- NEVER place, modify or close trades/orders/positions, move money, enter passwords or payment details, accept terms/purchases, or permanently delete anything. If the task requires that, stop and report it.\n` +
      `- Do only what the task needs; do not close or rearrange unrelated windows.\n\n` +
      `FINAL REPORT (this is all Claude will see):\n1. Steps you took\n2. What you observed — exact error messages, values, window/dialog text\n3. Final state of the app\n4. Anything Claude must follow up on\nStart with STATUS: DONE | PARTIAL | BLOCKED.`;
    // The computer-use runtime can technically write files outside the sandbox: flag any project change.
    // Git projects: compare git status. Other folders: list code files (bounded walk) before/after.
    const isGit = !!L.gitRoot(root);
    let truncated = false;
    const codeFiles = () => {
      const out = new Map();
      let budget = 20000;
      (function walk(d, depth) {
        let names = []; try { names = fs.readdirSync(d); } catch { return; }
        for (const n of names) {
          if (/^(node_modules|\.git|\.venv|venv|__pycache__|dist|build)$/.test(n)) continue;
          if (--budget < 0) { truncated = true; continue; }
          const p = path.join(d, n);
          let st; try { st = fs.lstatSync(p); } catch { continue; }
          if (st.isDirectory() && depth < 8) walk(p, depth + 1);
          else if (st.isFile() && L.isCode(p)) out.set(p, st.mtimeMs);
        }
      })(root, 0);
      return out;
    };
    // Git: content hash of every dirty path before, compared over the union of before/after dirty paths,
    // so changes to already-dirty files (incl. deleting or restoring them) are caught too.
    const hashOf = p => { try { return L.fileHash(p); } catch { return 'unreadable'; } };
    const dirty = () => new Map((L.gitStatus(root) || []).map(e => [e.abs, hashOf(e.abs)]));
    const before = isGit ? dirty() : codeFiles();
    // Record the Codex worker's pid in the desktop lock: ownership lasts as long as the worker lives.
    const r = await ask({ mode: 'computer', prompt, effort, sandbox: 'read-only', onSpawn: child => L.updateState(L.HOME, g => { if (g.computerLock && g.computerLock.pid === process.pid) g.computerLock.childPid = child.pid; }) });
    let touched;
    if (isGit) {
      const after = dirty();
      touched = [...new Set([...before.keys(), ...after.keys()])].filter(p =>
        before.has(p) ? hashOf(p) !== before.get(p) // was dirty: any content change (incl. delete/restore)
          : true);                                   // was clean, is dirty now: changed during the run
    } else {
      const after = codeFiles();
      touched = [...after].filter(([p, t]) => !before.has(p) || t !== before.get(p)).map(([p]) => p)
        .concat([...before.keys()].filter(p => !after.has(p) && !fs.existsSync(p))); // confirm real deletions
    }
    if (truncated) {
      const note = 'NOTE (gpt.js): very large folder — change detection only covered the first 20000 entries.';
      r.text = (r.text || '') + '\n\n' + note;
      if (!r.ok) r.reason += ' — ' + note; // failures print only the reason
    }
    if (touched.length) r.text = (r.text || '') + `\n\nWARNING (gpt.js): project files changed during this computer-use run — inspect them:\n${touched.map(f => '- ' + f).join('\n')}`;
    if (!r.ok) {
      markUnavailable(r.reason, true);
      r.reason += ' — NOT retried automatically: check the app\'s current state before running another computer task' + (touched.length ? `; changed files: ${touched.join(', ')}` : '');
    }
    return finish(r);
  },

  async write() {
    const briefText = opts.brief || (opts['brief-file'] && readArgFile(opts['brief-file']));
    if (!briefText) die('write needs --brief "<instructions>" or --brief-file <file>');
    if (opts.revise) {
      const { dir, m } = loadManifest(opts.revise);
      if (m.applied) die(`stage ${m.id} was already applied`);
      if (m.round >= cfg.maxRounds) {
        console.log(`MAX_ROUNDS_REACHED (${cfg.maxRounds}). Claude decides: apply as-is, apply then fix small issues yourself, or discard.`);
        process.exit(4);
      }
      m.round += 1;
      copyTree(path.join(dir, 'work'), path.join(dir, 'prev'));
      return runWrite(dir, m, path.join(dir, 'prev'), `\nROUND ${m.round}: you already edited these files (current state is in your working directory). Claude reviewed them. CLAUDE'S FEEDBACK — address every point:\n${briefText}\n`);
    }
    if (!opts.files) die('write needs --files "<doc1>,<doc2>"');
    const targets = String(opts.files).split(',').map(f => f.trim()).filter(Boolean).map(f => path.resolve(f));
    for (const t of targets) {
      const p = L.docTargetProblem(t, !!opts.data);
      if (p) die(`REFUSED: ${t} ${p}. Claude must handle this file itself.`);
    }
    const id = stamp() + '-' + Math.random().toString(36).slice(2, 6);
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
    const m = { id, root, round: 1, effort: effortFor(), brief: briefText, entries, created: new Date().toISOString() };
    saveManifest(dir, m);
    return runWrite(dir, m, path.join(dir, 'base'));
  },

  apply() {
    const { dir, m } = loadManifest(positional[0] || die('usage: gpt.js apply <stage-id> [--force]'));
    if (m.applied) die(`stage ${m.id} was already applied`);
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
  },

  discard() {
    const { dir, m } = loadManifest(positional[0] || die('usage: gpt.js discard <stage-id>'));
    for (const log of m.logs || []) try { fs.appendFileSync(log, `- discarded by Claude ${new Date().toLocaleString()}\n`); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('discarded ' + m.id);
  },

  // Curated per-project lessons: only confirmed, recurring mistakes (max 25, newest kept, de-duplicated).
  lesson() {
    const f = L.lessonsFile(root);
    let cur = L.readLessons(root);
    if (opts.remove) {
      const n = Number(opts.remove);
      if (!(n >= 1 && n <= cur.length)) die(`--remove needs 1..${cur.length}`);
      cur.splice(n - 1, 1);
    } else if (opts.text) {
      const norm = t => t.toLowerCase().replace(/^- \d{4}-\d{2}-\d{2}: /, '').replace(/\W+/g, ' ').trim();
      const entry = `- ${new Date().toISOString().slice(0, 10)}: ${String(opts.text).replace(/\s+/g, ' ').slice(0, 300)}`;
      if (cur.some(l => norm(l) === norm(entry))) { console.log('already recorded'); return; }
      cur = cur.concat(entry).slice(-25);
    } else {
      console.log(cur.length ? cur.map((l, i) => `${i + 1}. ${l.slice(2)}`).join('\n') : '(no lessons yet)');
      return;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `# Lessons — ${root}\n\n${cur.join('\n')}\n`);
    console.log(`lessons: ${cur.length}/25 (${f})`);
  },

  // Health check. Quick checks always; --live also makes one tiny model call and proves the sandbox
  // blocks writes. Exit 1 if anything failed.
  async doctor() {
    const checks = L.quickChecks();
    if (opts.live) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-doctor-'));
      const t = Date.now();
      const r = await runCodex({ prompt: 'Reply with exactly: PONG', effort: effortFor(), sandbox: 'read-only', mode: 'doctor', cwd: tmp });
      checks.push({ ok: r.ok && /PONG/.test(r.text), name: 'model responds', info: r.ok ? `${cfg.model}, ${Math.round((Date.now() - t) / 1000)}s` : r.reason });
      const probe = path.join(tmp, 'probe.txt');
      const p = await runCodex({ prompt: `This is an authorized sandbox test. Run exactly this shell command and report the result: Set-Content -LiteralPath '${probe}' -Value x`, effort: effortFor(), sandbox: 'read-only', mode: 'doctor', cwd: tmp, json: true });
      // Only a write that was actually EXECUTED and failed proves the sandbox. Parse Codex's structured
      // events: a completed command_execution item running Set-Content with a non-zero exit code.
      // (Text the model writes arrives as agent_message items, so it can never fake this.)
      const attempted = String(p.raw).split('\n').some(line => {
        try {
          const e = JSON.parse(line), it = e.item || {};
          // the exact probe path, a failed exit, and an access/permission denial in the output
          return e.type === 'item.completed' && it.type === 'command_execution' && /Set-Content/.test(String(it.command)) &&
            [probe, probe.replace(/\\/g, '\\\\'), probe.replace(/\\/g, '/')].some(x => String(it.command).toLowerCase().includes(x.toLowerCase())) &&
            it.exit_code !== 0 && it.exit_code != null &&
            /denied|not permitted|unauthori[sz]ed|read-only|permission/i.test(String(it.aggregated_output || ''));
        } catch { return false; }
      });
      checks.push({
        ok: attempted && !fs.existsSync(probe), name: 'read-only sandbox blocks writes',
        info: fs.existsSync(probe) ? 'WRITE SUCCEEDED — sandbox broken' : attempted ? 'write attempted and denied' : `inconclusive — probe did not run (${p.ok ? 'no write attempt seen' : p.reason})`,
      });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.info}`);
    const failed = checks.filter(c => !c.ok);
    L.updateState(L.HOME, s => { s.doctorAt = Date.now(); s.doctorFailed = failed.map(c => `${c.name}: ${c.info}`); });
    process.exit(failed.length ? 1 : 0);
  },

  // Headless MQL5 compile through MetaEditor (for --evidence). Exit 1 on errors.
  async 'mql5-compile'() {
    const file = positional[0] && path.resolve(positional[0]);
    if (!file || !fs.existsSync(file)) die('usage: gpt.js mql5-compile <file.mq5|.mq4>');
    if (!cfg.metaeditorPath || !fs.existsSync(cfg.metaeditorPath)) die(`MetaEditor not found (config.metaeditorPath = ${cfg.metaeditorPath})`);
    const log = path.join(os.tmpdir(), `mql5-${process.pid}-${Date.now()}.log`);
    // Which version was compiled (evidence must match the code under review): the file and every source
    // it includes, as one fingerprint.
    const before = mqlSources(file);
    const r = await runTracked(`"${cfg.metaeditorPath}" /compile:"${file}" /log:"${log}"`, 300000); // tree-killed on timeout
    const after = mqlSources(file);
    let text = '';
    try { const b = fs.readFileSync(log); text = (b[0] === 0xff && b[1] === 0xfe) ? b.slice(2).toString('utf16le') : b.toString('utf8'); } catch {}
    try { fs.rmSync(log, { force: true }); } catch {}
    const lines = text.split(/\r?\n/).filter(l => /error|warning|result/i.test(l));
    console.log(`compiled: ${file} (${before.files} source file(s), sources sha256 ${before.hash}, newest change ${before.newest})` +
      (after.hash !== before.hash ? ` — SOURCES CHANGED during the compile (now ${after.hash}); results may not match` : '') +
      (before.missing.length ? `; includes not found: ${before.missing.slice(0, 5).join(', ')}` : '') +
      (before.truncated ? '; source set over 500 files — the fingerprint covers only the first 500' : '') +
      (r.status === null ? '; MetaEditor TIMED OUT and was stopped — compile FAILED' : '') + (r.contained ? '' : `; ${UNCONTAINED_NOTE}`));
    console.log(lines.join('\n') || '(no compiler output — MetaEditor did not run?)');
    const m = text.match(/Result:\s*(\d+)\s+errors?/i);
    process.exit(r.status !== null && m && Number(m[1]) === 0 ? 0 : 1); // a timeout is a failure whatever the log says
  },

  // Measurements from logs/<project>/index.tsv (or --all): calls, failures, average time, verdicts, how
  // review findings were settled (withdrawn = GPT conceded a false alarm), and hook latency.
  stats() {
    const dirs = opts.all ? fs.readdirSync(L.LOG_DIR).map(d => path.join(L.LOG_DIR, d)) : [logDir()];
    const rows = [];
    for (const d of dirs) try { rows.push(...fs.readFileSync(path.join(d, 'index.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t'))); } catch {}
    if (!rows.length) console.log('no GPT calls measured yet');
    const by = {}, settled = [0, 0, 0, 0];
    let raised = 0;
    for (const [, mode, ok, verdict, secs, how, , tokens, findings, outcome] of rows) {
      const k = `${mode.replace(/-r\d+$/, '')}${mode.includes('-r') ? ` (follow-up, ${how})` : ''}`;
      const b = by[k] = by[k] || { n: 0, fail: 0, secs: 0, tok: 0, tokN: 0, verdicts: {} };
      b.n++; if (ok !== 'ok') b.fail++; b.secs += Number(secs) || 0;
      if (Number(tokens) > 0) { b.tok += Number(tokens); b.tokN++; }
      if (verdict && verdict !== '-') b.verdicts[verdict] = (b.verdicts[verdict] || 0) + 1;
      if (/^review/.test(mode)) raised += Number(findings) || 0;
      String(outcome || '').split('/').forEach((n, i) => { settled[i] += Number(n) || 0; });
    }
    for (const [k, b] of Object.entries(by)) console.log(`${k.padEnd(28)} calls ${String(b.n).padStart(3)}  failed ${b.fail}  avg ${Math.round(b.secs / b.n)}s  ${b.tokN ? `~${Math.round(b.tok / b.tokN / 1000)}k tokens  ` : ''}${Object.entries(b.verdicts).map(([v, n]) => `${v}:${n}`).join(' ')}`);
    if (raised) console.log(`review findings raised ${raised}; in follow-ups: withdrawn ${settled[0]} (false alarms), resolved ${settled[1]}, maintained ${settled[2]}, not addressed ${settled[3]}`);
    // Hook latency (all projects), from the last 5000 hook runs.
    try {
      const t = fs.readFileSync(L.HOOK_TIMES, 'utf8').trim().split('\n').slice(-5000).map(l => l.split('\t'));
      const ev = {};
      for (const [, e, ms] of t) (ev[e] = ev[e] || []).push(Number(ms) || 0);
      for (const [e, v] of Object.entries(ev)) {
        v.sort((a, b) => a - b);
        console.log(`hook ${String(e).padEnd(13)} runs ${String(v.length).padStart(5)}  avg ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)} ms  p95 ${v[Math.floor(v.length * 0.95)]} ms`);
      }
    } catch {}
  },

  note() {
    const log = positional[0];
    if (!log || !fs.existsSync(log)) die('usage: gpt.js note <log.md> --text "..." | --file f');
    const text = opts.text || (opts.file && readArgFile(opts.file));
    if (!text) die('note needs --text or --file');
    fs.appendFileSync(log, `- ${new Date().toLocaleTimeString()}: ${text}\n`);
    console.log('noted');
  },

  'mark-reviewed'() {
    if (!opts.note) die('mark-reviewed needs --note "<why GPT review was skipped / what reviewed it>"');
    const scope = opts.files ? String(opts.files).split(',').map(f => path.resolve(f.trim())).filter(Boolean) : null;
    markReviewed(opts.by || 'claude-fallback', Date.now(), scope, L.gitDeleted(root));
    fs.writeFileSync(path.join(logDir(), `${stamp()}_skipped_${Math.random().toString(36).slice(2, 6)}.md`), `# GPT review skipped\n\n- By: ${opts.by || 'claude-fallback'}\n- Note: ${opts.note}\n`);
    console.log('marked reviewed');
  },

  'allow-claude-cu'() {
    if (!opts.reason) die('allow-claude-cu needs --reason');
    const mins = Number(opts.minutes) || cfg.claudeComputerUseWindowMinutes;
    L.updateState(L.HOME, g => { g.claudeCuUntil = Date.now() + mins * 60000; });
    fs.writeFileSync(path.join(logDir(), `${stamp()}_claude-computer-use.md`), `# Claude doing computer use itself (${mins} min)\n\nReason: ${opts.reason}\n`);
    console.log(`Claude may use computer use directly for ${mins} minutes.`);
  },

  status() {
    const s = L.readState(root);
    const p = L.pending(s);
    console.log(JSON.stringify({
      root, model: cfg.model, projectSettings: ps,
      pendingReview: p.map(([f, c]) => ({ file: f, ...c })),
      openFindings: Object.entries(s.changes || {}).filter(([, c]) => c.openFindings).map(([f, c]) => ({ file: f, log: c.openFindings })),
      lastReview: s.lastReview ? { ...s.lastReview, at: new Date(s.lastReview.at).toLocaleString() } : null,
      lessons: L.readLessons(root).length,
      lastPlanReview: s.planReviewedAt ? new Date(s.planReviewedAt).toLocaleString() : null,
      gptUnavailable: s.gptUnavailableAt ? `${new Date(s.gptUnavailableAt).toLocaleString()} — ${s.gptUnavailableReason}` : null,
      trackingUnavailable: s._unreadable ? `${L.statePath(root)} is unreadable (${s._unreadable}): pending changes and open findings are UNKNOWN. Move the file aside to restart tracking.` : null,
      configProblems: cfg.problems.length ? cfg.problems : null,
      shellTrackingPartial: s.shellScanPartial ? `${new Date(s.shellScanPartial.at).toLocaleString()}: folder too big to walk; shell commands compared only the first ${s.shellScanPartial.files} code files (new files elsewhere not seen)` : null,
      // problems the hooks survived (e.g. a failed git scan = changes possibly missed), newest last
      hookProblems24h: (i => i.length ? { count: i.length, last: i.slice(-3).map(x => x.slice(1).join(' — ')) } : 0)(L.recentHookIssues(24)),
      logs: path.join(L.LOG_DIR, L.slug(root)),
    }, null, 2));
  },
};

// `scope` (array of paths) = only those files were reviewed; null = everything pending was reviewed.
// Entries are kept (with reviewedAt) so a deleted file isn't re-detected as new; old ones are pruned.
// `deletedAtStart`: files git reported deleted when the review STARTED. Only those deletions count as
// reviewed; anything deleted later stays a fresh change for the Stop hook.
// `info`: { verdict, log, snaps } from a GPT review. Review status per file:
//   clean (NO_ISSUES/RESOLVED) | findings (ISSUES_FOUND/ISSUES_REMAIN: open until fixed+re-reviewed or
//   accepted) | accepted (claude-final) | fallback (claude-fallback) | declined (user-declined).
function markReviewed(by, at, scope, deletedAtStart, info = {}) {
  const startDel = new Set((deletedAtStart || []).map(f => path.resolve(f).toLowerCase()));
  const status = by === 'gpt' ? (/^(ISSUES_FOUND|ISSUES_REMAIN)$/.test(info.verdict || '') ? 'findings' : 'clean')
    : ({ 'claude-final': 'accepted', 'claude-fallback': 'fallback', 'user-declined': 'declined' }[by] || by);
  // New baselines = the versions just reviewed (frozen copies), or for manual acknowledgements the
  // current files, so the next review diff shows only work done after this point.
  const snapOf = new Map((info.snaps || []).map(x => [x.abs.toLowerCase(), x.snap]));
  const resolves = new Set((info.resolves || []).map(l => path.resolve(l).toLowerCase())); // logs a follow-up re-checked
  L.updateState(root, s => {
    const inScope = scope ? new Set(scope.map(f => path.resolve(f).toLowerCase())) : null;
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
      }
      const rev = L.reviewedAtFor(s, c);
      if (!c.openFindings && rev >= c.at && rev < Date.now() - 2 * 86400000) delete s.changes[f]; // reviewed long ago, nothing open: prune
    }
    s.reviewedBy = by;
    s.lastReview = { status, by, verdict: info.verdict || null, log: info.log || null, at };
    if (by === 'gpt') delete s.gptUnavailableAt;
  });
}

try { L.cleanup(); } catch {}
if (!commands[cmd]) die(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 19).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
Promise.resolve(commands[cmd]()).catch(e => die('gpt.js error: ' + e.message, 2));
