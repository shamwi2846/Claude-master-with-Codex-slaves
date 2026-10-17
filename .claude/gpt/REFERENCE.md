# gpt.js reference (read when you need the details; the rules live in ~/.claude/CLAUDE.md)

`gpt.js` = `node "C:/Users/Shari/.claude/gpt/gpt.js"`. Run `gpt.js` with no arguments for the full usage list.

## Reviews
- **First round:** `review --task "<goal + user requirements + acceptance criteria>" [--focus ".."] [--files a,b] [--full] [--evidence "<cmd> ;; <cmd>" | --evidence-file <out>]`
  - `--files` limits what is reviewed and acknowledged.
    - A relative path is looked up from the project root and from the current folder. The call stops if both match different files.
    - A path that exists in neither place must be a known deletion; otherwise the call stops before GPT is called (the same applies to `score`, `digest` and `testplan`).
  - `--full` does a whole-file audit; it's automatic when nothing changed.
- **Follow-up:** `review --followup <log.md> --file <response.md> [--fresh]`. It resumes GPT's session, so it's fast. Unaddressed findings come back marked OPEN.
- **MQL5 evidence:** `--evidence 'node "C:/Users/Shari/.claude/gpt/gpt.js" mql5-compile "<file.mq5>"'`. Keep the inner quotes.
  - It compiles a temporary copy of the file, its includes and resources, so the project's `.ex5` and logs are never touched (a tester run can keep going).
- **MQL5 docs:** runs on `.mq5`/`.mqh`/`.set` files get the read-only MQL5 reference (the `mql5-chm` server, as `~/.codex/config.toml` defines it).
  - This covers review, follow-ups, score, digest, investigate and testplan. `digest --backtest` and `--mql5-docs` ask for it too.
  - GPT cites the topic it checked. Without the reference, GPT marks API facts "unverified against the MQL5 docs", and the run's output and log say why.
  - Turn it off with `"mql5Docs": false` in config.json. MQL5 runs then still mark API facts unverified.
  - A follow-up round keeps the previous round's docs setting.
- **Close out:** `mark-reviewed --by claude-final|claude-fallback|user-declined --files "<exact files>" --note "<why>"`. Always pass `--files`; without it, every pending file and open finding in the project is cleared.
- **Decisions:** `note [<log.md>] --text ".." | --file <f>`. Without a log, the note goes to the project's latest GPT log.
- **On/off switch:** `off` / `on` affects this project; `off --all` / `on --all` affects every project and resets their own switches. It lasts until switched again (kept in state, no settings file).
  - While off: no change tracking, reviews, plan or idea checks; Claude may control the screen itself (the one-operator desktop lock still applies). Session start and the next prompt tell Claude.
  - Changes made before switching off stay pending for when it's back on. Changes from a discovery window or shell command that spans a switch are not counted.
  - From a Claude session, `gpt.js off` works only when the user's current message asks to switch the setup off, e.g. "turn the GPT setup off" or "pause GPT". Otherwise it refuses with exit 2. From the user's own terminal it always works.
  - `status --summary` shows the switch.
- **Exit codes:**
  - `0` ok
  - `3` GPT_UNAVAILABLE (after one retry; usage limits start a 15-minute cooldown, override with `--force-gpt`)
  - `4` MAX_ROUNDS_REACHED
  - `5` apply conflict
  - `6` DUPLICATE: an identical review is already running, so wait for it

## Other helpers (all read-only, no test runs)
- **Ideas:** `idea --file <draft.md> --question "<user question>"`
- **Scoring rounds:** `score --file <rubric.md> [--files a,b] [--full]`. GPT applies the rubric (it doesn't critique it); verdict ALL_10 or BELOW_10. With `--files` the files are frozen and reviewed in the same call and recorded like a review: no findings means clean; findings stay open on their files.
- **Plans:** `plan --file <plan.md>`. Needed before ExitPlanMode; a light revision (at least 80% identical lines, within 30 minutes) reuses the review.
- **Heavy reading:** `digest --question ".." --files ..|--dir ..`
- **Debugging:** `digest --investigate --question "<symptom>" --files/--dir .. --expected ".." --actual ".." --tried "<failed fixes>" [--evidence-file f]`. The answer gives DIAGNOSIS, EVIDENCE [code|runtime], NEXT CHECK, FIX IDEA and CONFIDENCE. Read the cited code yourself and run the NEXT CHECK before fixing.
- **Backtests:** `digest --backtest --question ".." --files "<tester/optimization report>"`. Verdicts: QUESTIONABLE, LIKELY_OVERFIT, INSUFFICIENT_EVIDENCE or NO_RED_FLAGS.
- **Web research:** `research --question ".."`, with sources.
- **Test cases:** `testplan --task "<what the code must do>" [--files ..]`. GPT lists edge cases and expected results; Claude writes the tests.

## Documents (GPT writes, Claude reviews)
1. **Write:** `write --files "<exact doc paths>" --brief-file <brief.md>`. The brief covers the session facts, audience, what to change and keep, and acceptance criteria.
2. **Review:** check the printed diff for facts, requirements, formatting and invented features. Open binary documents directly.
3. **Finish with one of:**
   - `apply <id>`: refuses if the original changed
   - `write --revise <id> --brief-file <feedback.md>`: at most 3 rounds
   - `discard <id>`
4. **Refused targets:**
   - config files (`.set`, `.ini`, `.json`, `.yaml`, `requirements.txt`)
   - agent files (`CLAUDE.md`, `AGENTS.md`, `skills/`)
   - tool folders (`.claude/`, `.github/`)
   - data files that code reads (`--data` only if no code reads them)

## Computer use
- **Delegate:** `computer --task "<goal, app, what to report back>"`. Never retried automatically; check the app's state before another run.
- **Claude doing it itself:** only after `allow-claude-cu --reason ".."`, which opens a 30-minute window.
- **One operator at a time, across all projects:**
  - A second `computer` run exits `BUSY` (6).
  - Claude's own computer-use tools are refused while a GPT run owns the desktop.
  - A GPT run is refused within 2 minutes of Claude's last desktop action.

## Maintenance
- `doctor [--live]` checks the setup (config, Codex, git, PowerShell, hook registration, problems the hooks survived — `logs/hooks.log`).
- `stats [--all]` shows speed, tokens, verdicts, how review findings were settled (withdrawn = false alarm) and hook latency.
- `lesson [--text ".." | --remove N]` manages project lessons.
- `status` shows pending changes, open findings, the last review, config problems and partial shell tracking. `status --summary` gives a few lines: pending files grouped by folder with their kinds, open findings, untracked changes and problems.
- **Not tracked** (listed by `status`): copies of existing content, moves (same extension), and files a branch switch changed in a nested repo (only clean → clean, HEAD moved, no commit/reset in the command). Config files copied or moved, and files that already have a pending change, are always tracked.
- **Setup files edited by another session** (Edit/Write) while this session's shell command runs are left to that session.
- **Cross-project receipts:** a review or `mark-reviewed` also acknowledges pending records of the same files in other projects, but only when their content is exactly what was acknowledged and no findings are open.
- **After changing the setup itself:** `node ~/.claude/gpt/tests/run.js` runs the regression checks (no GPT calls);
  `node ~/.claude/gpt/tests/release.js` checks syntax and config, runs them, then copies the setup to the backup folder (`--backup <dir>` or `GPT_BACKUP_DIR`) with a `RELEASE.txt` manifest.

## Configuration
- **Per-project overrides** go in `<project>/.claude/gpt.json`, e.g. `{"review": false, "plans": true, "ideas": true, "computerUse": "gpt", "effort": "auto", "ignore": ["evidence/**", "app/server.mjs"]}`.
  - `ignore`: globs relative to the project folder for generated files the hooks shouldn't track. `**` spans folders; a name without `/` matches in any folder; a folder covers its contents. `.claude/` and `.codex/` are never ignored.
  - `gpt.json` is always reviewed (sensitive), and its `ignore` list is suspended while it has an unreviewed change.
- **Model, timeouts, thresholds and the MetaEditor path** are set in `~/.claude/gpt/config.json`. Invalid values fall back to their defaults (`lib.js` CONFIG_DEFAULTS) and are reported by `doctor` and `status`; unknown or invalid `gpt.json` values are ignored and listed by `status`.
