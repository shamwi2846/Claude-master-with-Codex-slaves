# Goal: rate the Claude + GPT setup 10/10 in every area

You are a principal engineer auditing a global Claude Code configuration on Windows. Judge whether it is **10/10** in every area below, and say exactly what would make it 10/10 where it isn't.

## What the project is (read the files; don't trust this summary)
A global setup in which **Claude writes all code** and **GPT-6.1 (Codex CLI, effort xhigh)** reviews code, plans and ideas, digests big material, writes staged documents and operates the screen. Hooks enforce it in every Claude Code session.
- `C:/Users/Shari/.claude/CLAUDE.md`: rules loaded into every session (its size costs tokens); details in `C:/Users/Shari/.claude/gpt/REFERENCE.md`.
- `C:/Users/Shari/.claude/gpt/gpt.js`: the bridge — reviews (frozen snapshots, follow-ups, per-round copies, verdict checks, open findings), plan/idea/digest/investigate/backtest/research/testplan, staged writes (write/apply/discard), computer use (desktop lock), evidence commands (Windows Job Object), mql5-compile, doctor/status/stats/lessons/notes, mark-reviewed.
- `C:/Users/Shari/.claude/gpt/gate.js`: the hooks — change discovery (Edit/Write, shell, git status, commits in the turn, turn-start content fingerprints, ignored config), the Stop gate, plan gate, computer-use gate, reminders.
- `C:/Users/Shari/.claude/gpt/lib.js`: state + locking, baselines, fingerprints, git helpers, health checks, cleanup.
- `C:/Users/Shari/.claude/gpt/config.json`, `C:/Users/Shari/.claude/settings.json` (hook registration), `C:/Users/Shari/.claude/agents/fallback-reviewer.md`.
- `C:/Users/Shari/.claude/gpt/tests/`: regression checks (`t_*.js`, runner `run.js`, no GPT calls) and `release.js` (syntax + config check, runs the checks, then refreshes the backup with a `RELEASE.txt` manifest).
- `C:/Users/Shari/Desktop/Cloude agent/`: backup copy, `restore.js`, `README.md`, `AGENT-SETUP.md`, `RELEASE.txt`.

## The owner's priorities
1. **Highest quality:** no unreviewed change by Claude slips through, above all trading/sensitive code.
2. **No false alarms; never block the owner's work.**
3. **Best value per dollar:** GPT usage itself isn't a concern, but no wasted tokens, runs or Claude turns.
4. **Easy to restore** on another PC.
5. Main work: MT5/MQL5 trading development plus tooling.

## Areas (1–10 each; N/A if it truly doesn't apply; these definitions stay fixed between rounds) — what each means here
1. **Correctness & reliability:** every change Claude makes (Edit/Write, shell, commits, ignored config) is caught and reviewed exactly once; the owner's own work is never attributed to Claude; reviews acknowledge exactly what GPT saw; state updates are atomic; no silent failure that skips a review.
2. **Maintainability:** a future Claude can change behaviour safely: clear module boundaries, a stable state contract between gate.js and gpt.js, functions of reasonable size.
3. **Duplication:** the same rule implemented once (e.g. change-record construction, fingerprint rules, git spawning, path keys).
4. **Cleanliness & readability:** names, comments that match the code, no dead or stale code.
5. **Error handling & observability:** hooks fail open but leave a trace; GPT failures are clear (GPT_UNAVAILABLE, cooldowns); doctor/status/stats/logs show what happened.
6. **Testability:** behaviour can be checked without calling GPT; a kept, re-runnable regression set.
7. **Security & secrets:** no credentials handled or stored; read-only, no-MCP sandboxes for review runs; nothing writes outside its scope.
8. **Configuration:** config fields validated with sensible defaults, per-project overrides (`.claude/gpt.json`), nothing hard-coded that should be configurable (and nothing configurable that shouldn't be).
9. **Performance & efficiency per dollar:** hook latency per tool call (walks, git spawns, hashing), Claude tokens (CLAUDE.md, hook messages), GPT tokens (diff-first reviews, resumed follow-ups), avoided duplicate runs.
10. **Usefulness of results:** GPT outputs find real problems with little noise; prompts steer to concrete, verified findings.
11. **Usability:** low friction, few false blocks, clear messages and instructions.
12. **Safety:** GPT can't write code; no trading, money or credentials; one desktop operator at a time; no destructive side effects; leftover processes are ended.
13. **Portability & recovery:** backup, `restore.js`, new-PC setup, relocation to another user path.
14. **Dependency health:** Node built-ins only; reliance on Codex CLI, git, PowerShell, MetaEditor is checked (doctor) and degrades gracefully.
15. **Domain value:** how well it serves MT5/MQL5 trading work (MQL5 checklist, compile evidence, backtest digests, `.set` presets, trading-sensitive detection).
16. **Build & release:** changes to the live setup reach the backup only through a repeatable, checked step (syntax, config, regression checks), and what was released is recorded.

## Rules
- **Verify by reading the files.** Search first, then read only the relevant regions. Run no tests or builds and build no test rigs.
- **10 means** no realistic improvement left that's worth its cost. Count only problems reachable in real use.
- **Don't** ask to break what works, weaken safety, or remove features to raise a score.
- **Decided** (below): accepted on purpose. Don't re-raise them without new evidence.

## Decided (accepted on purpose)
1. While GPT is unavailable (recent failure, 30-min cooldown) Claude may use computer-use tools itself; the shared desktop lock still applies. (Never block the owner's work.)
2. Stop blocks at most once per user turn per kind (pending reviews / open findings); after that only a note.
3. Review threshold: 5 changed lines, or any sensitive file (path or content); effort always xhigh; follow-ups max 3 rounds, then Claude's decision is final.
4. Git-ignored ordinary code files (mostly build output) are not tracked; git-ignored reviewable config (.set presets, Claude/Codex settings, gpt.json) is.
5. Non-git projects with more than 1000 code files: ordinary code files are fingerprinted by time+size per shell command; config, sensitive-path and MQL files are hashed.
6. After a background command that may write files, the turn's discovery window stays open, so an owner edit made in that gap may be counted once (a background job's own changes are only visible there).
7. Evidence commands run inside a Job Object: processes they leave behind (build servers, daemons) end when the command finishes.
8. The project's own `.claude/settings.local.json` is watched only around shell commands (Claude Code writes it itself on permission approvals).
9. Reviews read frozen copies; a file edited during a review stays pending for the newer version.
10. Bulk rule: more than 15 new non-sensitive files from one shell command are treated as scaffold/extract/clone output and not reviewed one by one (sensitive ones always are). Claude authors code with Edit/Write, which is always tracked.
11. Non-git projects: shell tracking is per foreground command; files a background command writes later in a non-git folder are not tracked (rare; would need persistent reconciliation machinery).
12. No secret redaction in logs, frozen copies or review prompts: the owner keeps no real secrets in these projects (demo accounts) and reviews must see the exact content.
13. In a non-git folder too big to walk (over 5000 entries), shell commands compare only the files the walk reaches; new files elsewhere aren't seen. This is recorded and shown by `gpt.js status`.
14. Computer-use runs keep the owner's Codex config with a denylist of MCP servers (write-capable or external-text ones), not an allowlist: GPT needs the owner's desktop tooling there, and an allowlist would break computer use whenever that tooling changes. New write-capable servers go on the denylist.
15. A deleted file with no known previous version (no baseline, not in git) is reviewed with an explicit "REVIEW COVERAGE INCOMPLETE" note and is then acknowledged; it is not kept pending (nothing could ever review it, so it would block every turn).

## Answer format
VERDICT: AGREE (all 10/10 or N/A) | AGREE_WITH_CHANGES

Scorecard, one line per area: `<n>. <area>: <score>/10 — <one-sentence reason>`

Then up to 10 numbered changes, highest value for cost first: one to three sentences each, plus a location and which areas it raises.

Then "Don't do:" — a short list.

