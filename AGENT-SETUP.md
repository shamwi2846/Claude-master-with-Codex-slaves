# Agent handoff: install the Claude + GPT setup on this PC

**For the AI agent** (e.g. Claude Code) helping the user set this up on a new Windows PC. Follow the steps in order and verify each one.

- **Logins are the user's job.** Never type passwords or tokens yourself. When a step needs a login, ask the user to do it and wait.
- **Ask before installing.** Before installing software, tell the user what will be installed and get a yes.

## What this is
A global Claude Code configuration:
- **Claude** writes all code.
- **GPT** (via the OpenAI Codex CLI, model `gpt-6.1-sol`, effort `xhigh`) reviews code, plans and ideas, diagnoses bugs, reads big logs, writes documents and does computer use.

The files are in `.claude/` next to this file, and `restore.js` installs them into `%USERPROFILE%\.claude`.

## Step 1: Check what's already installed
Run these and note which ones fail:
```bash
node --version
npm --version
git --version
claude --version
codex --version
```
`claude --version` must be **2.1.295 or newer** (older versions ignore the desktop hook's `"onFailure": "block"`); if it is older, update Claude Code (with the user's OK) before restoring.

## Step 2: Install what's missing (ask the user first)
Use `winget`, which is built into Windows 10 and 11:
```bash
winget install -e --id OpenJS.NodeJS.LTS
```
```bash
winget install -e --id Git.Git
```
After installing Node.js or Git, the user must open a **new** terminal so PATH updates. Re-check the versions.

Then install the two command-line tools with npm:
```bash
npm install -g @anthropic-ai/claude-code
```
```bash
npm install -g @openai/codex
```
The Claude desktop app works too. Its Code tab uses the same `%USERPROFILE%\.claude` settings.

## Step 3: Logins (the user does these)
- **Claude Code:** the user runs `claude`, then `/login` with their Anthropic account.
- **Codex:** the user runs `codex login` with their ChatGPT account. The account must have access to `gpt-6.1-sol`.

Verify Codex with:
```bash
codex login status
```
It must report "Logged in".

## Step 4: Restore the configuration
From this folder:
```bash
node restore.js
```
What it does:
- It backs up any existing files to `%USERPROFILE%\.claude\backups\before-restore-*`.
- It copies `CLAUDE.md`, the agent, and `gpt/*.js` + `gpt/config.json`.
- It merges **only** the GPT hooks into the existing `settings.json`. Other settings are kept.
- It rewrites `C:/Users/Shari/...` paths to this PC's user folder automatically.

## Step 5: Verify
PowerShell:
```powershell
node "$env:USERPROFILE/.claude/gpt/gpt.js" doctor --live
```
Git Bash: `node "$HOME/.claude/gpt/gpt.js" doctor --live`
Every line must start with `OK`.
- **`hook input fields: match (not seen yet: ...)`** is normal on a new PC. Those fields get recorded during real use.
- **`codex CLI` fails:** check `npm root -g` and set `codexJs` in `%USERPROFILE%\.claude\gpt\config.json` to `<that path>/@openai/codex/bin/codex.js`.
- **`codex login` fails:** go back to Step 3.
- **`MetaEditor (optional)` says "not installed":** only matters for MQL5 work. Set `metaeditorPath` in `config.json` to the real `metaeditor64.exe` path if MT5 is installed elsewhere.
- **`model responds` fails:** the account may lack access to `gpt-6.1-sol`. Ask the user which model to use and set `"model"` in `config.json`.

## Step 5b: Computer use (optional — only if the user wants GPT to operate apps)
GPT's computer use comes from the **ChatGPT Codex desktop app** and its bundled "Computer Use" plugin, not from the Codex CLI. Ask the user whether they want it; if yes:
1. The user installs the Codex desktop app (chatgpt.com / OpenAI download page), signs in, and enables the **Computer Use** plugin there (Settings → Plugins).
2. Verify with a harmless task (observation only):
```powershell
node "$env:USERPROFILE/.claude/gpt/gpt.js" computer --task "Observation only: list the open app windows (name + title). Do not click or type."
```
It must start with `STATUS: DONE`. If it says it has no computer-use tool, the plugin isn't enabled.

## Step 6: Finish
- **Restart:** tell the user to restart the Claude desktop app and any open `claude` terminals so the hooks load.
- **Hand over:** point the user to `%USERPROFILE%\.claude\CLAUDE.md` for how the setup works, and to `README.md` in this folder.

## Notes
- **Windows only.** The setup uses Windows-specific Codex sandbox settings and `taskkill`.
- **Logs and state are not transferred.** Review logs, lessons and state from the old PC stay there.
- **Undo:** in the backup folder `%USERPROFILE%\.claude\backups\before-restore-*`, copy the saved files back, then delete every file listed in its `new-files.txt` (files the restore created that didn't exist before).
