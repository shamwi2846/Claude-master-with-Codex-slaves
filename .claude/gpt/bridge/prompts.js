// Prompt parts shared by the GPT modes.
const L = require('../lib');
const C = require('./ctx');

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

function lessonsBlock() {
  const l = L.readLessons(C.root);
  return l.length ? `\nPROJECT LESSONS (confirmed past mistakes in this project — check the change does not repeat them):\n${l.join('\n')}\n` : '';
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

module.exports = { READONLY_NOTE, EFFORT_RULES, ROLE, FINDING_FORMAT, lessonsBlock, mql5Block };
