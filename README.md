# Claude + GPT setup: backup copy

This folder is a backup of a global Claude Code configuration with these rules:
- **Claude writes all code.** GPT (`gpt-6.1-sol` via the Codex CLI, always at `xhigh` effort) reviews code, plans and ideas. Those runs are read-only and get no MCP tools.
- **GPT writes documents.** It works on staged copies only. Claude reviews the changes and then applies, revises or discards them.
- **GPT does the heavy reading.** Big logs, MT5 journals, tester reports and build output go through `gpt.js digest`, which returns a short summary with line references. This saves Claude's tokens.
- **Computer use goes to GPT.**
- **Reviews are fast and well-grounded:**
  - GPT gets an exact diff of Claude's changes and reviews frozen copies, so reviews can start early in the background.
  - Build and test output is attached, including the headless MQL5 compile.
  - Follow-up rounds resume GPT's own session, which is much faster.
  - GPT suggests regression tests for serious findings.
- **Nothing slips through:**
  - Reported issues stay open until they're fixed and re-reviewed, or explicitly accepted.
  - Confirmed recurring mistakes go into a short per-project lessons list, which is fed into future reviews and shown at session start.
- **Maintenance:**
  - `gpt.js doctor --live` checks the whole setup.
  - `gpt.js stats` shows review speed and results.
  - Old logs are cleaned up automatically after 30 days.

The live copies are in `C:\Users\Shari\.claude\`.

## New PC?
To set up a new PC, give an AI agent (e.g. Claude Code) the file **`AGENT-SETUP.md`** in this folder. It covers installing everything needed and restoring the configuration step by step. You only do the logins.

## Restore
Run this from this folder:

```bash
node restore.js
```

This does three things:
1. Copies the files back into `C:\Users\Shari\.claude\`.
2. Backs up anything it replaces to `~/.claude/backups/before-restore-<date>/`.
3. Merges the GPT hooks into your current `settings.json`. It does not overwrite your other settings.

After restoring, start a new Claude session.

## What's here
| File | Purpose |
|---|---|
| `.claude/CLAUDE.md` | Rules Claude follows in every project |
| `.claude/settings.json` | Full copy of the global settings at backup time, including the hooks |
| `.claude/agents/fallback-reviewer.md` | Claude reviewer used when GPT is unavailable |
| `.claude/gpt/config.json` | Model name, effort levels and timeouts |
| `.claude/gpt/gpt.js` | Launcher Claude uses to call GPT (`review`, `plan`, `idea`, `score`, `computer`) |
| `.claude/gpt/bridge/` | The launcher's modules: GPT calls, reviews, evidence, document writing, commands |
| `.claude/gpt/gate.js` | Hook script that enforces reviews and the computer-use handoff |
| `.claude/gpt/lib.js` | Shared helpers |
| `.claude/gpt/REFERENCE.md` | Detailed command reference, read on demand (keeps `CLAUDE.md` small) |
| `.claude/gpt/tests/` | Regression checks (`run.js`, no GPT calls) and `release.js`, which refreshes this backup only after the checks pass |
| `.claude/RELEASE.txt` | When this backup was released, the check result and the hash of every file (`restore.js` checks them) |
| `.claude.prev/` | The previous release, kept by `release.js` |

**Keeping this backup current:** after changing the setup, run `node "$env:USERPROFILE\.claude\gpt\tests\release.js"` (PowerShell). Don't edit files here by hand: `restore.js` refuses a backup that differs from its release (`--force` overrides).

## Requirements on a new machine
- **Node.js** 22 or newer (CI checks 22 and 24).
- **Git** and **Windows PowerShell** (change tracking, diffs, and containment of evidence commands).
- **Claude Code**, logged in.
- **The Codex CLI, logged in:** run `npm i -g @openai/codex`, then `codex login`.

Versions verified with this backup:
- Codex CLI `0.162.1`. If a newer one breaks a flag, `gpt.js doctor` says which one; install that version with `npm i -g @openai/codex@0.162.1`.
- Claude Code `2.1.299` — **at least 2.1.295 is required**: older versions ignore the desktop hook's `"onFailure": "block"`, so a failed or timed-out desktop check would let the tool run (`gpt.js doctor` checks this).

**Paths are handled automatically:**
- `restore.js` rewrites the paths of the folder the release came from (its `Source:` line in `RELEASE.txt`) to the current user's `.claude` folder.
- The hooks find `gpt.js` by themselves.
- The Codex location is detected automatically if it differs.

## Checks on GitHub
The GitHub copy of this folder checks every pull request and every push to `main`:
- Syntax, config and the full regression suite on Windows, with Node 24 and 22.
- actionlint (workflow files) and ESLint (`eslint.config.mjs`: real mistakes only, no style rules).
- CodeQL, while the repository is public.

The same checks also run weekly, plus a real release → restore round trip in throwaway profiles whose paths contain spaces and non-ASCII letters (`.github/scripts/release-roundtrip.js`). Dependabot keeps the pinned actions current.

## Note
`settings.json` holds no API tokens (the z.ai routing was removed), only personal preferences. The GitHub copy is public, so never add secrets, account numbers or EA code to it.
