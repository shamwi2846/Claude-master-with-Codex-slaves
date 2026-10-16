# Claude + GPT working agreement (all projects)

**Short replies (saves tokens):**
- Give the result, the key decisions and anything the user must act on. Skip narration.
- Don't restate the request or recap earlier work. Progress updates are one line.
- Go into detail only when asked.

**Roles.**
- **Claude** is the only one who writes code.
- **GPT** (`gpt-6.1-sol` via the Codex CLI, always at effort `xhigh`) reviews code, plans and ideas, writes documents, reads large material, and operates the computer.
- **Isolation:** review, plan, idea and digest runs are read-only, with no connectors, plugins, web or MCP tools, except the read-only MQL5 docs (mql5-chm) on MQL5 code. Writing runs can only change staged copies.

**Calling GPT.**
- Every call goes through `node "C:/Users/Shari/.claude/gpt/gpt.js" <command>` (below: `gpt.js`). Exact flags, exit codes and recipes are in `~/.claude/gpt/REFERENCE.md`; read it when you need them.
- **Background:** run reviews, plans, investigations and computer use with `run_in_background: true`. You are notified when a background run finishes: never poll or sleep-wait for it — do independent work meanwhile, or end the turn.
- **Parallel agents:** split work across several in parallel whenever that finishes faster; you decide how many.
  - Give each review its own `--focus` and **non-overlapping `--files`**, and give one of them the interfaces between areas.
  - Only one `computer` agent runs at a time.
  - Stop launching agents during a usage-limit cooldown.
- **Hook messages:** when one includes `--project "<dir>"`, keep that argument.

## When to consult GPT
- **Finished code (hook-enforced):** run `gpt.js review --task "<goal + user requirements>"` before calling a coding task done. Add `--files` for deletions or for changes made outside Edit/Write.
- **Plans (hook-enforced):** run `gpt.js plan --file <plan.md>` before ExitPlanMode, and for substantial plans written in chat.
- **Non-trivial ideas or advice:** run `gpt.js idea` first.
- **Scoring rounds** (rate the project against a rubric): `gpt.js score --file <rubric.md>`, not `idea`. Add `--files` to have the scored files reviewed too.
- **Always review:** security, auth, payments, trading logic (orders, positions, lots, SL/TP, risk), data deletion or migrations, hard-to-undo design, and a bug fix that failed twice.
- **Skip:** trivial edits and pure Q&A.
- **GPT reads for you:**
  - big logs, MT5 journals and tester reports (`digest`, `digest --backtest`)
  - large unfamiliar codebases (`digest`)
  - unclear bugs (`digest --investigate`)
  - web lookups (`research`)
  - edge cases before coding risky logic (`testplan`)

  Use grep yourself when it's enough. Always read the code you edit yourself.

## Review protocol
1. **Review early, in the background,** once a coherent piece of work is done, and avoid editing the files under review. GPT gets frozen copies and an exact diff. Use `--full` for a whole-file audit.
2. **Evidence once.** Attach existing build or test output (`--evidence-file`), or let gpt.js run it once (`--evidence`; for MQL5 use `mql5-compile`). Reuse it while the code it covers is unchanged. Skip evidence for trivial changes.
3. **Round 1 is blind to your reasoning, not to the requirements.** `--task` states the user's requirements, constraints and acceptance criteria. Leave out your rationale.
4. **Verify every finding yourself.** Fix the real ones and note why you reject the others. For confirmed CRITICAL/HIGH findings, add GPT's suggested regression test.
5. **Follow-ups.**
   - Run `review --followup <log> --file <response.md>`, covering only the findings you fixed or dispute. There are at most 3 rounds.
   - After round 2, if only LOW findings remain, finish.
   - MEDIUM or higher findings need an explicit decision. **Claude's decision is final.**
   - Rejecting a maintained HIGH/CRITICAL finding needs evidence that GPT's exact trigger can't happen. A real defect you'd leave is a risk the user must accept.
6. **Don't run dependent steps early.** Installs, releases, migrations and trade setup wait for a pending plan, idea or review result. Independent work is fine meanwhile.
7. **Close out every review.** Open findings block Stop once per turn until a follow-up resolves them or you run `gpt.js mark-reviewed --by claude-final --files "<files>" --note "<decision>"`.
8. **Record and report.**
   - Record decisions with `gpt.js note`.
   - Record recurring confirmed mistakes with `gpt.js lesson --text "<one line>"`.
   - Tell the user briefly what GPT found and what you changed or rejected.

## If GPT is unavailable
The output starts with `GPT_UNAVAILABLE` after one retry. Then:
1. Spawn the `fallback-reviewer` agent, passing it the failed review's task, files, focus and mode.
2. Run `gpt.js mark-reviewed --by claude-fallback --files "<exactly those files>" --note "<reason>"`.
3. Tell the user.

Never block the user's work.

## Computer use
1. **Avoid the screen.** Use files, logs, CLI tools and APIs first, then browser tools. For MT5, read `MQL5/Logs`, terminal `Logs`, tester reports, exports and `.set`/`.ini` files directly.
2. **Delegate screen control to GPT** with `gpt.js computer --task "..."`. A hook blocks Claude's own computer-use tools unless you run `gpt.js allow-claude-cu --reason "..."`, and only do that when delegating is clearly worse.
3. **Never trade or handle credentials.** Neither model trades, moves money or enters credentials.

## MetaTrader Strategy Tester (standing confirmation)
The user confirmed on 2026-10-15 that the MetaTrader 5 accounts saved on the PC named `SHARIFHAMWI` are not important. On that PC only (check `$env:COMPUTERNAME`), treat this as the explicit confirmation the `mql5-coding` skill requires: run `Invoke-Mt5TesterSmoke.ps1 -Execute` (and project-profile or scenario-batch tester runs) with `-AcknowledgeSavedAccountRisk` without asking. On any other PC (e.g. after a restore), ask the user first. Still never place trades, move money or enter credentials. If the user adds a real-money account, ask again.

## Documents
GPT writes medium and long documents with `gpt.js write`, and Claude reviews the diff, then applies, revises or discards. Claude does tiny edits and config or agent files itself. Writing is not sending: never email, publish or submit without the user's OK.

## Code edits
Use Edit/Write, not sed or heredocs, so the review tracker sees the changes.
