// Running Codex (GPT): command line, process trees, one call with its failure policy (ask), and the result.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const L = require('../lib');
const C = require('./ctx');
const P = require('./prompts');

// Codex's sandbox only covers shell commands, not MCP tools. So every mode except computer use runs
// with the user's Codex config ignored (no MCP servers/plugins at all: no MetaEditor write tools, no
// external text services). Computer use keeps the config but switches off the servers listed in config.
// `resume`: continue an earlier Codex session (follow-up review rounds keep GPT's context). `resume`
// has no -s/-C flags, so the sandbox is forced via config (verified: writes are still denied).
// `persist`: keep the session on disk so a later round can resume it (reviews only).
// Read-only runs (every mode but computer use) skip the owner's Codex config, and these Codex features too:
// --ignore-user-config alone still offered GPT every ChatGPT app connector (about 1,100 tools through code
// mode's ALL_TOOLS, many of them writes to Airtable, GitHub, Vercel, ...), plugins, sub-agents and image
// generation. Web search stays only for research.
const LOCKDOWN = ['apps', 'plugins', 'multi_agent', 'image_generation', 'tool_suggest', 'computer_use', 'browser_use', 'in_app_browser'].map(f => `features.${f}=false`);
// The one MCP server a read-only run may get: the offline MQL5 reference (L.mql5DocsServer), with exactly
// its read-only tools, auto-approved, never required (a failure never stops the run). JSON strings are valid
// TOML basic strings (lone surrogates and control characters are refused by readDocsServer).
function docsArgs(def) {
  const k = `mcp_servers.${L.DOCS_SERVER}`, q = JSON.stringify;
  return [`${k}.command=${q(def.command)}`, `${k}.args=[${def.args.map(q).join(',')}]`, `${k}.required=false`, `${k}.startup_timeout_sec=20`,
    `${k}.tool_timeout_sec=60`, `${k}.enabled_tools=[${L.DOCS_TOOLS.map(q).join(',')}]`, ...L.DOCS_TOOLS.map(t => `${k}.tools.${t}.approval_mode="approve"`)];
}
// The MQL5 reference for a run on MQL5 code (.mq5/.mqh source, .set presets) or one asked for it
// (--mql5-docs, digest --backtest, a follow-up of such a run): { def } when it works on this PC, { problem }
// when it can't be used (also when config.json switches it off: GPT then still marks API facts
// unverified), null when the run doesn't need it.
function docsFor(files, force) {
  if (!(force || (files || []).some(f => /\.(mq5|mqh|set)$/i.test(String(f))))) return null;
  let d;
  if (C.cfg.mql5Docs === false) d = { problem: 'switched off in config.json ("mql5Docs": false)' };
  else try { d = L.mql5DocsServer(); } catch (e) { d = { problem: e.message }; }
  if (!d.problem) return { def: d };
  console.error(`[gpt.js] MQL5 docs unavailable for this run (${d.problem}); GPT marks MQL5 API facts as unverified.`);
  return { problem: d.problem };
}

function codexArgs({ mode, effort, sandbox, cwd, outFile, resume, persist, json, docs }) {
  const a = [C.cfg.codexJs, 'exec'];
  if (resume) a.push('resume');
  if (json) a.push('--json'); // structured events on stdout (used by doctor to see real tool executions)
  if (mode !== 'computer') a.push('--ignore-user-config');
  a.push('-m', C.cfg.model, '-c', `model_reasoning_effort=${effort}`, '-c', `windows.sandbox=${C.cfg.windowsSandbox}`);
  if (mode === 'computer') for (const s of C.cfg.computerDisableMcp || []) a.push('-c', `mcp_servers.${s}.enabled=false`);
  else for (const v of [...LOCKDOWN, ...(mode === 'research' ? [] : ['web_search="disabled"']), ...(docs ? docsArgs(docs) : [])]) a.push('-c', v);
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
function stopChildrenOnSignal() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => { for (const c of liveChildren) try { killTree(c); } catch {} process.exit(130); }); } catch {}
  }
}

function runCodex({ prompt, effort, sandbox, mode, cwd = C.root, resume, persist, json, onSpawn, docs }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-'));
  const outFile = path.join(tmp, 'last.txt');
  const args = codexArgs({ mode, effort, sandbox, cwd, outFile, resume, persist, json, docs });
  const timeoutMs = (C.cfg.timeoutMinutes[effort] || 30) * 60000;
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
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); // (a character split between chunks stays whole)
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
      const hint = (raw.match(/(error[^\n]*|usage limit[^\n]*|rate limit[^\n]*|not logged in[^\n]*|model is not supported[^\n]*|TIMEOUT[^\n]*)/gi) || [])
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
  score: ['ALL_10', 'BELOW_10'],
};
// The answer's FIRST non-empty line must be "VERDICT: <allowed value>"; anything else (no verdict,
// "VERDICT: BLOCKED", a verdict quoted mid-text) means the review was not actually performed.
// A review verdict must also agree with its own items (NO_ISSUES/RESOLVED next to listed findings or MAINTAIN/OPEN
// items would clear findings that are still open), and with `requireCoverage` (code reviews) the answer needs a
// valid COVERAGE line. Such a defect is repaired once (`badFormat` names it), else the review counts as not done.
function checkVerdict(r, kind, requireCoverage) {
  if (!r.ok || !VERDICTS[kind]) return r;
  // Strip markdown decoration (**, `, #, >) but keep underscores: they are part of values like NO_ISSUES.
  // Exactly one VERDICT line in the whole answer, and it must be the (unquoted) first line.
  const verdictLines = r.text.split('\n').filter(l => /^[\s*#>`_]*VERDICT[\s*`_]*:/i.test(l)).length;
  const first = (r.text.split('\n').find(l => l.trim()) || '').replace(/[*`#]/g, '').trim();
  const m = first.match(/^VERDICT\s*:\s*([A-Z0-9_]+)\s*$/i);
  if (!(m && verdictLines === 1 && VERDICTS[kind].includes(m[1].toUpperCase()))) {
    return { ...r, ok: false, badVerdict: true, reason: 'GPT gave no valid VERDICT (review not actually performed): ' + r.text.slice(0, 200).replace(/\s+/g, ' ') };
  }
  const verdict = m[1].toUpperCase();
  const bad = defect => ({ ...r, ok: false, badVerdict: true, badFormat: defect, reason: `GPT's answer is malformed: ${defect}` });
  // (P.lineKind is the one structure parser: the same that findingFiles, scoring and stats use)
  const clean = (kind === 'review' && (verdict === 'NO_ISSUES' || verdict === 'RESOLVED')) || (kind === 'score' && requireCoverage && verdict === 'ALL_10');
  if (clean) {
    if (P.hasFinding(r.text)) return bad(`the verdict ${verdict} contradicts the findings the answer lists`);
    if (P.hasOpenItem(r.text)) return bad(`the verdict ${verdict} contradicts the MAINTAIN/OPEN items the answer lists`);
  }
  if (requireCoverage) { const d = P.coverageDefect(r.text); if (d) return bad(d); }
  return { ...r, verdict };
}

// One shared failure policy. Never retried: timeouts (the old process may still run), usage/rate limits
// and login problems (an immediate retry can't succeed), and verdict slips (repaired instead).
// ("model is not supported ... ChatGPT account" is what Codex reports when the plan's usage is used up.)
const LIMIT_ERR = /usage limit|rate limit|quota|too many requests|\b429\b|model is not supported when using codex with a chatgpt account/i;
const LOGIN_ERR = /not logged in|login required|unauthori[sz]ed|\b401\b/i;
function retryable(r) {
  return !r.ok && !r.badVerdict && !/TIMEOUT/.test(r.reason) && !LIMIT_ERR.test(r.reason) && !LOGIN_ERR.test(r.reason) && !/cooldown/.test(r.reason);
}

// `before` runs before each attempt (write mode uses it to give every attempt a fresh staged copy).
// Computer use is never retried automatically: repeating UI actions (clicks, toggles) is unsafe.
// `docs`: the MQL5 reference server for this run (docsFor(...).def), passed to every attempt and repair.
// `requireCoverage`: a code review — its answer must carry a valid COVERAGE line (checkVerdict).
async function ask({ mode, prompt, effort, sandbox, meta = '', cwd, before, resume, persist, noRetry, onSpawn, docs, requireCoverage }) {
  const started = Date.now();
  const kind = mode.replace(/-r\d+$/, '');
  const tokensOf = x => Number(((String(x.raw || '').match(/tokens used\s*\n\s*([\d,]+)/i) || [])[1] || '0').replace(/,/g, ''));
  let r, tokens = 0; // tokens summed over all attempts, so stats include retries/repairs
  const g = L.readState(L.HOME);
  if ((g.limitUntil || 0) > Date.now() && !C.opts['force-gpt']) {
    // Usage/rate limit hit recently: fail fast instead of piling more calls onto the limit.
    r = { ok: false, raw: '', reason: `usage/rate limit cooldown until ${new Date(g.limitUntil).toLocaleTimeString()} (${g.limitReason}) — the GPT plan's usage may be used up; pass --force-gpt to try anyway` };
  } else {
    // Format slip: one cheap, answer-only repair in the same saved session — never a full re-run, and
    // never a made-up verdict (GPT must say NOT_COMPLETED if it did not actually finish the work).
    const repair = async x => {
      if (!(x.badVerdict && x.sessionId && (persist || resume))) return x; // only saved sessions can be resumed
      const cov = requireCoverage ? ` and, as its last line, exactly one ${P.COVERAGE_LINE}` : '';
      const fix = await runCodex({ prompt: (x.badFormat
        ? `Your previous answer has a format defect: ${x.badFormat}. Do NOT explore, read files or run commands now. If you completed the work, restate your final answer with that defect corrected — the first line "VERDICT: <one of ${VERDICTS[kind].join(' | ')}>" agreeing with the items you list${cov}.`
        : `Your previous answer did not start with the required verdict line. Do NOT explore, read files or run commands now. If you completed the work, restate your final answer exactly, with the first line "VERDICT: <one of ${VERDICTS[kind].join(' | ')}>"${cov}.`) +
        ' If you could not complete it, reply only: NOT_COMPLETED: <reason>.', effort, sandbox, mode: kind, cwd, resume: x.sessionId, docs });
      tokens += tokensOf(fix);
      const fixed = checkVerdict(fix, kind, requireCoverage);
      // A usage limit or login problem during the repair keeps its whole reason (the cooldown below matches it).
      const limit = !fix.ok && (LIMIT_ERR.test(fix.reason || '') || LOGIN_ERR.test(fix.reason || ''));
      return fixed.ok ? { ...fixed, sessionId: x.sessionId, raw: x.raw + '\n--- format repair ---\n' + fix.raw }
        : { ...x, reason: limit ? `review not completed: ${fix.reason}` : `review not completed (${String(fix.text || fix.reason || '').slice(0, 160)})`, raw: x.raw + '\n--- format repair ---\n' + fix.raw };
    };
    if (before) before();
    r = checkVerdict(await runCodex({ prompt, effort, sandbox, mode: kind, cwd, resume, persist, onSpawn, docs }), kind, requireCoverage);
    tokens += tokensOf(r);
    r = await repair(r);
    if (retryable(r) && !noRetry && kind !== 'computer') {
      console.error(`[gpt.js] attempt 1 failed (${r.reason}); retrying once...`);
      if (before) before();
      r = checkVerdict(await runCodex({ prompt, effort, sandbox, mode: kind, cwd, resume, persist, onSpawn, docs }), kind, requireCoverage);
      tokens += tokensOf(r);
      r = await repair(r); // the retry gets the same repair, still only one retry in total
    }
    if (!r.ok && LIMIT_ERR.test(r.reason)) L.updateState(L.HOME, s => { s.limitUntil = Date.now() + 15 * 60000; s.limitReason = r.reason.slice(0, 120); });
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const log = path.join(C.logDir(), `${C.stamp()}_${mode}_${Math.random().toString(36).slice(2, 6)}.md`);
  fs.writeFileSync(log,
    `# GPT ${mode} — ${new Date().toLocaleString()}\n\n- Project: ${C.root}\n- Model: ${C.cfg.model} | effort: ${effort} | sandbox: ${sandbox} | ${secs}s | ${resume ? 'resumed session' : 'fresh session'}\n` +
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
  const findings = P.findingCount(text);
  const settled = P.settlement(text);
  try { fs.appendFileSync(path.join(C.logDir(), 'index.tsv'), [new Date().toISOString(), mode, r.ok ? 'ok' : 'fail', verdict, secs, resume ? 'resume' : 'fresh', path.basename(log), tokens, findings, settled].join('\t') + '\n'); } catch {}
  return { ...r, log, secs, started, verdict, tokens };
}

function markUnavailable(reason, global) {
  L.updateState(global ? L.HOME : C.root, s => { s.gptUnavailableAt = Date.now(); s.gptUnavailableReason = reason; });
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

// The run log's line on the MQL5 reference (docsFor's result).
const docsLine = d => (d ? `- MQL5 docs: ${d.def ? 'on' : `off (${d.problem})`}\n` : '');

module.exports = {
  codexArgs, LOCKDOWN, docsArgs, docsFor, docsLine, PS_TABLE, parseTable, processTable, learnTree, killTree, liveChildren, stopChildrenOnSignal, runCodex,
  VERDICTS, checkVerdict, LIMIT_ERR, LOGIN_ERR, retryable, ask, markUnavailable, finish, sigOf,
};
