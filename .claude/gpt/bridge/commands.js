// The gpt.js commands (one function each). Reviews and document writing live in review.js / write.js.
const fs = require('fs');
const path = require('path');
const os = require('os');
const L = require('../lib');
const C = require('./ctx');
const X = require('./codex');
const E = require('./evidence');
const P = require('./prompts');
const R = require('./review');
const W = require('./write');

const commands = {
  review: R.review,
  score: R.score,

  async plan() {
    const { opts } = C;
    if (!opts.file) C.die('plan needs --file <plan.md|->');
    const effort = C.effortFor();
    const st0 = L.readState(C.root);
    const turnAtStart = st0.userTurnAt || st0.turnStartedAt || null; // the user turn (stable across continuations)
    const planText = C.readArgFile(opts.file);
    const prompt = `${P.ROLE}\nClaude drafted the PLAN below and will implement it. Review it as a skeptical senior architect. ${P.READONLY_NOTE} Check the plan's claims by reading the actual project files: search first, read only the relevant regions, no tests or test rigs.\n\nPLAN:\n${planText}\n\n` +
      `Look for: wrong assumptions, missing steps, risks and failure modes, things that are hard to undo, simpler or more robust alternatives, missing tests/verification, ordering problems.\n\nFormat:\nVERDICT: SOUND | CHANGES_RECOMMENDED | RETHINK\nthen at most 8 numbered points, most important first, each 1-3 sentences with WHY and WHAT TO CHANGE. Be concrete; no praise, no preamble.`;
    const r = await X.ask({ mode: 'plan', prompt, effort, sandbox: 'read-only', persist: true });
    if (!r.ok) X.markUnavailable(r.reason);
    // Tie the approval to the turn in which the review STARTED (a late background result must not
    // authorize a plan from a later turn). The reviewed text is kept so a lightly revised version of
    // the SAME plan (user asks for a small tweak) doesn't need a whole new GPT review.
    return X.finish(r, () => L.updateState(C.root, s => { s.planReviewedAt = Date.now(); s.planReviewedTurn = turnAtStart; s.planReviewedText = planText.slice(0, 30000); }));
  },

  async idea() {
    const { opts } = C;
    if (!opts.file) C.die('idea needs --file <draft.md|->');
    const effort = C.effortFor();
    const prompt = `${P.ROLE}\nClaude is about to give the user the ideas / recommendations / advice below. Give a critical second opinion. ${P.READONLY_NOTE} Reason from reading (search first, read only relevant regions); no tests or test rigs.\n` +
      (opts.question ? `\nTHE USER'S QUESTION:\n${opts.question}\n` : '') + `\nCLAUDE'S DRAFT:\n${C.readArgFile(opts.file)}\n\n` +
      `Say which points are wrong or weak and why, what important ideas or risks are missing, and what you would recommend instead. Be concise and concrete.\n\nFormat:\nVERDICT: AGREE | AGREE_WITH_CHANGES | DISAGREE\nthen at most 7 numbered points, each 1-3 sentences. No preamble.`;
    const r = await X.ask({ mode: 'idea', prompt, effort, sandbox: 'read-only', persist: true });
    if (!r.ok) X.markUnavailable(r.reason);
    return X.finish(r);
  },

  // Heavy reading so Claude doesn't have to: big logs, MT5 journals/tester reports, build output, unfamiliar code.
  // --investigate: GPT diagnoses a bug from code + logs (Claude's exploration is usually its biggest cost).
  async digest() {
    const { opts } = C;
    if (!opts.question) C.die('digest needs --question "<what Claude needs to know>" and --files "<a,b>" or --dir <folder>');
    const targets = C.files(opts.files, true);
    if (opts.dir) targets.push(path.resolve(opts.dir) + path.sep + ' (folder — search it)');
    if (!targets.length) C.die('digest needs --files or --dir');
    if (opts.investigate) return R.investigate(targets);
    // --backtest: MT5 Strategy Tester / optimization reports, read with a trading checklist.
    const backtest = opts.backtest ? `\nTHIS IS AN MT5 STRATEGY TESTER / OPTIMIZATION REPORT. Also check and report on:\n` +
      `- overfitting: few trades (<100), profit from a handful of trades, best parameter set isolated (neighbours much worse), in-sample only\n` +
      `- risk: max drawdown (money and %), max consecutive losses, largest loss vs average win, recovery factor, profit factor, Sharpe if present\n` +
      `- data quality: modelling quality / tick model, spread setting, period covered, gaps\n` +
      `- suspicious patterns: martingale/grid lot growth, trades clustered in one period, losses hidden by open positions at the end\n` +
      `- keep two questions apart: does the EA behave as coded (errors, rejected orders, wrong lots) vs. is the strategy any good\n` +
      `- a report alone can't prove robustness: say what is missing (forward/out-of-sample period, optimization neighbours, realistic costs/slippage)\n` +
      `Give a VERDICT line: QUESTIONABLE | LIKELY_OVERFIT | INSUFFICIENT_EVIDENCE | NO_RED_FLAGS (never "robust") with the 2-3 numbers that decide it.\n` : '';
    const docs = X.docsFor(targets, opts['mql5-docs'] || opts.backtest);
    const prompt = `You are doing the heavy reading for Claude (another AI that writes the code) so Claude can save its context. ${P.READONLY_NOTE}\n\n` +
      `QUESTION FROM CLAUDE:\n${opts.question}\n\nREAD:\n${targets.map(t => '- ' + t).join('\n')}\n${backtest}${P.docsBlock(docs)}\n` +
      `Search first (Select-String / grep for the terms the question implies: errors, failed, warnings, names, numbers), then read only the regions around the hits; for counts or patterns, count with a command instead of reading everything. Cover the whole file — not just its beginning — but never dump large parts of it. Do not run tests or builds. Then answer compactly:\n` +
      `ANSWER: the direct answer in 1-5 sentences.\nEVIDENCE: up to 15 bullets, each "path:line — the exact quoted line or value (short)". Quote exact error messages and numbers.\n` +
      `PATTERNS: counts / first and last occurrence / timing, if relevant.\nUNSURE: anything you could not determine.\n` +
      `Keep the whole answer under ${opts.max || 400} words. Never paste large blocks of the files.`;
    const r = await X.ask({ mode: 'digest', prompt, effort: C.effortFor(), sandbox: 'read-only', docs: docs && docs.def, meta: X.docsLine(docs) });
    if (!r.ok) X.markUnavailable(r.reason);
    return X.finish(r);
  },

  // Web research so Claude doesn't spend its own tokens browsing: docs, API changes, errors, MT5/broker behaviour.
  async research() {
    const { opts } = C;
    if (!opts.question) C.die('research needs --question "<what to find out>"');
    const prompt = `You are doing web research for Claude (another AI that writes the code). ${P.READONLY_NOTE}\n\nQUESTION:\n${opts.question}\n\n` +
      `RULES (keep it cheap): at most about 5 web searches and only the pages needed to answer; prefer official docs, changelogs and the vendor's own sites; ` +
      `do NOT run code, tests, builds or scripts and do not inspect the local project unless the question names a file. Stop as soon as the question is answered.\n\n` +
      `Answer compactly (under ${opts.max || 350} words):\nANSWER: 1-6 sentences\nDETAILS: up to 8 bullets with exact versions, names, values\n` +
      `SOURCES: the URLs used (official first), with date if shown\nUNSURE: conflicts between sources or anything unverified`;
    const r = await X.ask({ mode: 'research', prompt, effort: C.effortFor(), sandbox: 'read-only' });
    if (!r.ok) X.markUnavailable(r.reason);
    return X.finish(r);
  },

  // Test design before coding: GPT lists the cases, Claude writes the tests (GPT never writes code).
  async testplan() {
    const { opts } = C;
    if (!opts.task) C.die('testplan needs --task "<what the code must do>" [--files "<relevant code>"]');
    const files = C.files(opts.files, true);
    const docs = X.docsFor(files, opts['mql5-docs']);
    const prompt = `${P.ROLE}\nDesign the tests Claude should write. ${P.READONLY_NOTE}\n\nWHAT THE CODE MUST DO:\n${opts.task}\n` +
      (files.length ? `\nRELEVANT CODE (read selectively):\n${files.map(f => '- ' + f).join('\n')}\n` : '') + P.lessonsBlock() + P.docsBlock(docs) +
      `\nRULES: reason from the requirements and by reading the code only. Do NOT run, write or build any tests, scripts or reproductions. ` +
      `List only cases that can really happen in this project's use; no duplicates, no trivial getters/setters.\n\n` +
      `Answer compactly: at most ${opts.max || 15} cases, most important first, each one line:\n` +
      `<n>. [CRITICAL|HIGH|MEDIUM] <input / state> -> <expected result>  (why it matters, 5-10 words)\n` +
      `Then "NOT WORTH TESTING:" one line naming what you deliberately skipped.`;
    const r = await X.ask({ mode: 'testplan', prompt, effort: C.effortFor(), sandbox: 'read-only', docs: docs && docs.def, meta: X.docsLine(docs) });
    if (!r.ok) X.markUnavailable(r.reason);
    return X.finish(r);
  },

  async computer() {
    const { opts } = C;
    const root = C.root;
    const task = opts.task || (opts.file && C.readArgFile(opts.file));
    if (!task) C.die('computer needs --task "<goal>" or --file <task.md>');
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
    const effort = C.effortFor();
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
    const r = await X.ask({ mode: 'computer', prompt, effort, sandbox: 'read-only', onSpawn: child => L.updateState(L.HOME, g => { if (g.computerLock && g.computerLock.pid === process.pid) g.computerLock.childPid = child.pid; }) });
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
      X.markUnavailable(r.reason, true);
      r.reason += ' — NOT retried automatically: check the app\'s current state before running another computer task' + (touched.length ? `; changed files: ${touched.join(', ')}` : '');
    }
    return X.finish(r);
  },

  write: W.write,
  apply: W.apply,
  discard: W.discard,

  // Curated per-project lessons: only confirmed, recurring mistakes (max 25, newest kept, de-duplicated).
  lesson() {
    const { opts, root } = C;
    const f = L.lessonsFile(root);
    let cur = L.readLessons(root);
    if (opts.remove) {
      const n = Number(opts.remove);
      if (!(n >= 1 && n <= cur.length)) C.die(`--remove needs 1..${cur.length}`);
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
    if (C.opts.live) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-doctor-'));
      const t = Date.now();
      const r = await X.runCodex({ prompt: 'Reply with exactly: PONG', effort: C.effortFor(), sandbox: 'read-only', mode: 'doctor', cwd: tmp });
      checks.push({ ok: r.ok && /PONG/.test(r.text), name: 'model responds', info: r.ok ? `${C.cfg.model}, ${Math.round((Date.now() - t) / 1000)}s` : r.reason });
      const probe = path.join(tmp, 'probe.txt');
      const p = await X.runCodex({ prompt: `This is an authorized sandbox test. Run exactly this shell command and report the result: Set-Content -LiteralPath '${probe}' -Value x`, effort: C.effortFor(), sandbox: 'read-only', mode: 'doctor', cwd: tmp, json: true });
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
    const { cfg, positional } = C;
    const file = positional[0] && path.resolve(positional[0]);
    if (!file || !fs.existsSync(file)) C.die('usage: gpt.js mql5-compile <file.mq5|.mq4>');
    if (!cfg.metaeditorPath || !fs.existsSync(cfg.metaeditorPath)) C.die(`MetaEditor not found (config.metaeditorPath = ${cfg.metaeditorPath})`);
    // Which version was compiled (evidence must match the code under review): the file and every source
    // it includes or embeds, as one fingerprint. MetaEditor compiles a temporary copy of exactly that
    // content (self-contained, see mqlCopy), so the project's .ex5 and logs are never written.
    E.sweepCopies();
    const libRoot = E.metaeditorRoot(cfg.metaeditorPath, file);
    const before = E.mqlSources(file, libRoot);
    const notCompiled = why => { console.log(`not compiled: ${file} — ${why}; nothing in the project was changed`); process.exit(1); };
    if (before.truncated) notCompiled('its source set is over 2000 files, too many to copy completely');
    const copy = E.mqlCopy(before, file);
    if (copy.error) notCompiled(copy.error);
    // removed however this ends (a cancelled gpt.js stops MetaEditor, then exits)
    const removeCopy = () => { try { fs.rmSync(copy.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} };
    process.once('exit', removeCopy);
    // one log per run (a probe's result can never be read as the real compile's); a log that can't be
    // cleared stops it
    const compile = async (kind = '') => {
      const log = copy.main.replace(/\.[^.\\/]+$/, '') + kind + '.log'; // (the real one: also where a plain /log would put it)
      try { fs.rmSync(log, { force: true }); } catch {}
      if (fs.existsSync(log)) notCompiled(`the old compiler log ${log} could not be removed`);
      const res = await E.runTracked(`"${cfg.metaeditorPath}" /compile:"${copy.main}"${copy.includeRoot ? ` /include:"${copy.includeRoot}"` : ''} /log:"${log}"`, 300000); // tree-killed on timeout
      let out = '';
      try { const b = fs.readFileSync(log); out = (b[0] === 0xff && b[1] === 0xfe) ? b.slice(2).toString('utf16le') : b.toString('utf8'); } catch {}
      return { r: res, text: out };
    };
    // A directive the merged copy would resolve differently from the project makes the copy unfaithful —
    // unless MetaEditor never opens it (an inactive #ifdef branch, a comment): a probe compile shows that.
    const blocking = copy.conflicts.find(c => !c.probe);
    if (blocking) notCompiled(`in the copy, ${blocking.what} would find ${blocking.got || 'nothing'} instead of ${blocking.link.to || 'nothing'}`);
    let probeNote = '';
    if (copy.conflicts.length) {
      const p = E.mqlProbe(copy, before);
      if (p.error) notCompiled(p.error);
      const pr = await compile('.probe');
      p.restore();
      const opened = p.marks.find(m => pr.text.toLowerCase().includes(m.mark.toLowerCase()));
      if (opened) notCompiled(`${opened.conflict.what} finds no file in the project, and MetaEditor does open it (a probe compile reported it missing): the project's compile fails there with "not found"; its other results are unknown`);
      if (pr.r.status === null || !/Result:\s*0\s+errors?/i.test(pr.text)) {
        const c0 = p.marks[0].conflict, why = pr.r.status === null ? 'it timed out' : E.fromCopy((pr.text.split(/\r?\n/).find(x => /error/i.test(x)) || 'no compiler result').trim(), copy);
        notCompiled(`in the copy, ${c0.what} would find ${c0.got} instead of nothing, and a probe compile could not show that MetaEditor never opens it (the probe: ${why})`);
      }
      probeNote = `; ${p.marks.length} directive(s) that would find MetaEditor's own file in the copy, where the project has none, are never opened (shown by a probe compile)`;
    }
    let r, text;
    try { ({ r, text } = await compile()); } finally { removeCopy(); process.removeListener('exit', removeCopy); }
    const after = E.mqlSources(file, libRoot);
    // compiler messages name the copy: show the project's paths
    // (selected first — a path may contain "error" — then mapped in one pass)
    const selected = text.split(/\r?\n/).filter(l => /error|warning|result/i.test(l));
    const lines = selected.length ? E.fromCopy(selected.join('\n'), copy).split('\n') : [];
    console.log(`compiled: ${file} (from a temporary copy — the project's .ex5 is not updated; ${before.files} source file(s), sources sha256 ${before.hash}, newest change ${before.newest})` +
      (after.hash !== before.hash ? ` — SOURCES CHANGED during the compile (now ${after.hash}); this result is for the earlier version` : '') +
      (before.missing.length ? `; includes not found: ${before.missing.slice(0, 5).join(', ')}` : '') + probeNote +
      (r.status === null ? '; MetaEditor TIMED OUT and was stopped — compile FAILED' : '') + (r.contained ? '' : `; ${E.UNCONTAINED_NOTE}`));
    console.log(lines.join('\n') || '(no compiler output — MetaEditor did not run?)');
    const m = text.match(/Result:\s*(\d+)\s+errors?/i);
    process.exit(r.status !== null && m && Number(m[1]) === 0 ? 0 : 1); // a timeout is a failure whatever the log says
  },

  // Measurements from logs/<project>/index.tsv (or --all): calls, failures, average time, verdicts, how
  // review findings were settled (withdrawn = GPT conceded a false alarm), and hook latency.
  stats() {
    const dirs = C.opts.all ? fs.readdirSync(L.LOG_DIR).map(d => path.join(L.LOG_DIR, d)) : [C.logDir()];
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
    const { opts, positional } = C;
    // Without a log: the project's latest GPT run log (review, plan, idea, score, ...), not an answer copy
    // or a skipped-review record.
    // (the last finished run in index.tsv, which lists runs as they finish; without one, the newest name)
    let latest; try {
      const D = C.logDir(), RUN = /^\d{4}-.*_(review|plan|idea|score|digest|investigate|backtest|research|testplan|write|computer)[^.]*\.md$/;
      let rows = []; try { rows = fs.readFileSync(path.join(D, 'index.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t')[6]); } catch {}
      latest = rows.reverse().find(n => n && RUN.test(n) && fs.existsSync(path.join(D, n))) || fs.readdirSync(D).filter(n => RUN.test(n)).sort().pop();
    } catch {}
    const log = positional[0] || (latest && path.join(C.logDir(), latest));
    if (!log || !fs.existsSync(log)) C.die(positional[0] ? `note: no such log ${positional[0]}` : 'note: this project has no GPT log yet; usage: gpt.js note [<log.md>] --text "..." | --file f');
    const text = opts.text || (opts.file && C.readArgFile(opts.file));
    if (!text) C.die('note needs --text or --file');
    fs.appendFileSync(log, `- ${new Date().toLocaleTimeString()}: ${text}\n`);
    console.log('noted');
  },

  'mark-reviewed'() {
    const { opts } = C;
    if (!opts.note) C.die('mark-reviewed needs --note "<why GPT review was skipped / what reviewed it>"');
    const scope = opts.files ? C.files(opts.files) : null;
    R.markReviewed(opts.by || 'claude-fallback', Date.now(), scope, L.gitDeleted(C.root));
    fs.writeFileSync(path.join(C.logDir(), `${C.stamp()}_skipped_${Math.random().toString(36).slice(2, 6)}.md`), `# GPT review skipped\n\n- By: ${opts.by || 'claude-fallback'}\n- Note: ${opts.note}\n`);
    console.log('marked reviewed');
  },

  'allow-claude-cu'() {
    const { opts, cfg } = C;
    if (!opts.reason) C.die('allow-claude-cu needs --reason');
    const mins = Number(opts.minutes) || cfg.claudeComputerUseWindowMinutes;
    L.updateState(L.HOME, g => { g.claudeCuUntil = Date.now() + mins * 60000; });
    fs.writeFileSync(path.join(C.logDir(), `${C.stamp()}_claude-computer-use.md`), `# Claude doing computer use itself (${mins} min)\n\nReason: ${opts.reason}\n`);
    console.log(`Claude may use computer use directly for ${mins} minutes.`);
  },

  status() {
    const { root, cfg, ps } = C;
    const s = L.readState(root);
    const p = L.pending(s);
    if (C.opts.summary) return statusSummary(s, p);
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
      notTracked: (s.notAuthored || []).length ? s.notAuthored.slice(-10).map(x => ({ ...x, at: new Date(x.at).toLocaleString() })) : null,
      shellTrackingPartial: s.shellScanPartial ? `${new Date(s.shellScanPartial.at).toLocaleString()}: folder too big to walk; shell commands compared only the first ${s.shellScanPartial.files} code files (new files elsewhere not seen)` : null,
      // problems the hooks survived (e.g. a failed git scan = changes possibly missed), newest last
      hookProblems24h: (i => i.length ? { count: i.length, last: i.slice(-3).map(x => x.slice(1).join(' — ')) } : 0)(L.recentHookIssues(24)),
      logs: path.join(L.LOG_DIR, L.slug(root)),
    }, null, 2));
  },

  // The setup's on/off switch, lasting until switched again: this project, or --all (every project; their
  // own switches are reset). Switching off is the user's decision: inside a Claude session
  // (CLAUDE_CODE_SESSION_ID) only when the user's current message asks for it (the prompt hook records
  // that); from the user's own terminal, always.
  off() {
    // (recorded for THIS user turn: a flag left from an earlier message never counts)
    const sid = process.env.CLAUDE_CODE_SESSION_ID, r = ((L.readState(L.HOME).reminders || {})[sid]) || {};
    if (sid && !(r.offAsked && r.offAskedFor && r.offAskedFor === L.readState(C.root).userTurnAt)) {
      C.die(`Not switched off: that is the user's decision, and their current message doesn't ask for it. Ask them to say "turn the GPT setup off" (or to run gpt.js off in their own terminal).`);
    }
    setSwitch('off');
  },
  on() { setSwitch('on'); },
};

function setSwitch(state) {
  const at = Date.now(), back = `gpt.js ${state === 'off' ? 'on' : 'off'}${C.opts.all ? ' --all' : ''}`;
  if (C.opts.all) {
    // (strict: if the global switch can't be saved, nothing else changes)
    const saved = L.updateState(L.HOME, g => { g.setupSwitchAll = { state, at }; g.setupSwitchAllLog = (g.setupSwitchAllLog || []).concat({ state, at }).slice(-50); }, true);
    if (saved && saved.lockFailed) C.die(`Not switched: the setup's state was busy, so the global switch could not be saved and nothing was changed. Run gpt.js ${state} --all again.`);
    let reset = 0;
    // A reset is logged in the project's own history at the moment it happens (a failed one isn't), so the
    // history always matches what the project's switch really was.
    const resetOwn = root => {
      const r = L.updateState(root, s => { delete s.setupSwitch; s.setupSwitchLog = (s.setupSwitchLog || []).concat({ state: 'reset', at: Date.now() }).slice(-50); }, true);
      if (r && r.lockFailed) console.log(`WARNING: ${root} kept its own switch (its state was busy): run gpt.js ${state} --project "${root}".`);
      else reset++;
    };
    for (const f of fs.readdirSync(L.STATE_DIR).filter(n => /^[0-9a-f]{12}\.json$/.test(n))) {
      let root = null; try { root = JSON.parse(fs.readFileSync(path.join(L.STATE_DIR, f), 'utf8')).root; } catch {}
      if (root && L.readState(root).setupSwitch) resetOwn(root);
    }
    if (L.readState(L.HOME).setupSwitch) resetOwn(L.HOME); // (a session in the setup's own folder)
    console.log(`Claude + GPT setup ${state.toUpperCase()} for all projects until \`${back}\`${reset ? ` (${reset} project switch(es) reset)` : ''}.`);
  } else {
    const saved = L.updateState(C.root, s => { s.setupSwitch = { state, at }; s.setupSwitchLog = (s.setupSwitchLog || []).concat({ state, at }).slice(-50); }, true);
    if (saved && saved.lockFailed) C.die(`Not switched: this project's state was busy, so the switch could not be saved. Run gpt.js ${state} again.`);
    console.log(`Claude + GPT setup ${state.toUpperCase()} for ${C.root} until \`${back}\`.`);
  }
  if (state === 'off') console.log('While off: no change tracking, GPT reviews, plan or idea checks, and Claude may control the screen itself. Changes made before stay pending for when it is back on.');
  else {
    // (tracking simply resumes: the hooks count a change only if the setup was on when it was made)
    const n = L.pending(L.readState(C.root)).length;
    if (n) console.log(`${n} change(s) from before it was off still wait for review here.`);
  }
}

// `status --summary`: what is pending, grouped by folder (two levels below the project) with counts and
// kinds, plus open findings, untracked changes and problems — a few lines instead of every record.
function statusSummary(s, p) {
  const root = C.root;
  const groups = new Map();
  for (const [f, c] of p) {
    const rel = path.relative(root, f), parts = rel.split(/[\\/]/);
    const g = rel.startsWith('..') || path.isAbsolute(rel) ? `(outside) ${path.dirname(f)}` : parts.length > 2 ? `${parts.slice(0, 2).join('/')}/` : parts.length > 1 ? `${parts[0]}/` : './';
    const e = groups.get(g) || groups.set(g, { n: 0, deleted: 0, sensitive: 0, shell: 0, findings: 0 }).get(g);
    e.n++; if (c.deleted) e.deleted++; if (c.sensitive) e.sensitive++; if (c.shellTouched) e.shell++; if (c.openFindings) e.findings++;
  }
  const kinds = e => ['deleted', 'sensitive', 'shell', 'findings'].filter(k => e[k]).map(k => `${e[k]} ${k}`).join(', ');
  const out = [`${root}: ${p.length} file(s) waiting for review`];
  const sw = L.setupSwitch(root);
  if (sw.off) out.unshift(`Claude + GPT setup OFF (${sw.scope === 'all' ? 'all projects' : 'this project'}, since ${new Date(sw.at).toLocaleString()}): gpt.js on${sw.scope === 'all' ? ' --all' : ''} turns it back on`);
  for (const [g, e] of [...groups].sort((a, b) => b[1].n - a[1].n)) out.push(`  ${g}  ${e.n}${kinds(e) ? ` (${kinds(e)})` : ''}`);
  const open = Object.entries(s.changes || {}).filter(([, c]) => c.openFindings);
  if (open.length) out.push(`open findings on ${open.length} file(s): ${[...new Set(open.flatMap(([, c]) => [].concat(c.openFindings)))].map(l => path.basename(l)).join(', ')}`);
  const na = s.notAuthored || [];
  if (na.length) out.push(`not tracked (not authored here): ${na.length}, latest: ${na.slice(-3).map(x => `${path.relative(root, x.file) || x.file} (${x.why})`).join('; ')}`);
  const problems = [
    s._unreadable && `tracking OFF: ${L.statePath(root)} unreadable`,
    C.cfg.problems.length && `config: ${C.cfg.problems.join('; ')}`,
    s.shellScanPartial && 'folder too big: shell tracking partial',
    s.gptUnavailableAt && L.minutesAgo(s.gptUnavailableAt, C.cfg.unavailableCooldownMinutes) && `GPT failed recently: ${s.gptUnavailableReason}`,
    (n => n && `${n} hook problem(s) in 24 h (gpt.js doctor)`)(L.recentHookIssues(24).length),
  ].filter(Boolean);
  if (problems.length) out.push(`problems: ${problems.join(' | ')}`);
  console.log(out.join('\n'));
}

module.exports = commands;
