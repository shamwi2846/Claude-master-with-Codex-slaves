#!/usr/bin/env node
// Claude <-> GPT (Codex CLI) bridge. GPT reviews and operates the computer; it never writes code.
//
//   gpt.js review   --task "<goal>" [--focus "..."] [--files a,b] [--full] [--evidence "cmd ;; cmd"] [--evidence-file f]
//   gpt.js review   --followup <log.md> --file <claude-response.md> [--evidence ..] [--fresh]
//   gpt.js plan     [--effort ..] --file <plan.md|->
//   gpt.js idea     [--effort ..] --file <draft.md|->  [--question "<user's question>"]
//   gpt.js score    --file <rubric.md|-> [--files a,b] [--full]       (scoring rounds; --files: also reviewed)
//   gpt.js digest   --question "<what to find out>" --files "<a.log,b.htm>" | --dir <folder> [--max 400]
//   gpt.js digest   --backtest --question "..." --files "<report.htm/.xml>"   (MT5 tester/optimization check)
//   gpt.js research --question "<what to find out>" [--max 350]            (web; sources cited)
//   gpt.js testplan --task "<what the code must do>" [--files ..]          (cases only; Claude writes tests)
//   gpt.js digest   --investigate --question "<symptom>" --files/--dir .. [--expected ..] [--actual ..] [--tried ..] [--evidence-file f]
//   gpt.js computer [--effort ..] --task "<goal>" | --file <task.md>
//   gpt.js write    [--effort ..] --files "<a.md,b.docx>" --brief "..." | --brief-file f  [--data]
//   gpt.js write    --revise <stage-id> --brief-file <feedback.md>      (Claude's review feedback)
//   gpt.js apply <stage-id> [--force]  |  gpt.js discard <stage-id>
//   gpt.js note [<log.md>] --text "..." | --file f      (append Claude's decisions to a log; default: the latest)
//   gpt.js mark-reviewed --chain <log> --files a,b --note "..."   (close one review chain on those files)
//   gpt.js mark-reviewed --by claude-final --release <RELEASE.txt> | claude-fallback | user-declined --files a,b --note "..."
//   gpt.js allow-claude-cu --reason "<why Claude does computer use itself>" [--minutes N]
//   gpt.js lesson [--text "..." | --remove N]    (list / add / remove project lessons)
//   gpt.js doctor [--live]  |  gpt.js stats [--all]  |  gpt.js mql5-compile <file.mq5>
//   gpt.js status [--summary]                    (--summary: pending files grouped by folder)
//   gpt.js off [--all]  |  gpt.js on [--all]     (the whole setup off/on until switched again; --all: every project)
//
// Exit codes: 0 ok, 2 usage error, 3 GPT unavailable (after one retry), 4 max rounds reached, 5 apply conflict.
//
// This file is the command line; the work is done by the modules in bridge/ (ctx: the run context, codex:
// GPT calls, evidence: build/test output, prompts, review, write: staged documents, commands).
const fs = require('fs');
const L = require('./lib');
const C = require('./bridge/ctx');

C.init(process.argv.slice(2));
const commands = require('./bridge/commands');
require('./bridge/codex').stopChildrenOnSignal();

try { L.cleanup(); } catch {}
if (!commands[C.cmd]) {
  const head = fs.readFileSync(__filename, 'utf8').split('\n');
  C.die(head.slice(1, head.findIndex(l => l.startsWith('// Exit codes')) + 1).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}
Promise.resolve(commands[C.cmd]()).catch(e => C.die('gpt.js error: ' + e.message, 2));
