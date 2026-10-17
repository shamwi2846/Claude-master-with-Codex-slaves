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

// Every code review (initial, follow-up, score with files, the fallback reviewer) ends with one COVERAGE line:
// which areas it actually checked. codex.js refuses an answer without a valid one (coverageDefect).
const COVERAGE_FIELDS = ['inputs/encodings', 'failure/timeout/cleanup', 'concurrency/stale state', 'callers/interfaces', 'tests'];
const COVERAGE_VALUES = ['checked', 'n/a', 'not examined'];
const COVERAGE_LINE = `COVERAGE: ${COVERAGE_FIELDS.map(f => `${f}=<${COVERAGE_VALUES.join('|')}>`).join('; ')}`;
const COVERAGE_RULE = `Last line, exactly once: ${COVERAGE_LINE}\n(what you actually examined: "not examined" is an honest answer; "n/a" only when the area can't apply to this change)\n`;
// What is wrong with an answer's COVERAGE line, or null when it is valid: exactly one, the last non-empty line,
// exactly the five fields once each (field=value, separated by ";"), each with an allowed value.
function coverageDefect(text) {
  const all = String(text || '').split('\n'), isCov = l => /^[\s*`>#_-]*COVERAGE[\s*`_]*:/i.test(l);
  const lines = all.filter(isCov);
  if (lines.length !== 1) return lines.length ? 'more than one COVERAGE line' : 'the COVERAGE line is missing';
  if (!isCov([...all].reverse().find(l => l.trim()) || '')) return 'the COVERAGE line is not the last line';
  const segs = lines[0].replace(/^[\s*`>#_-]*COVERAGE[\s*`_]*:/i, '').replace(/[*`]/g, '').split(';').map(p => p.trim()).filter(Boolean);
  const seen = new Map();
  for (const seg of segs) {
    const m = seg.match(/^([^=]+)=(.*)$/);
    if (!m) return `COVERAGE part "${seg}" is not field=value`;
    const f = m[1].trim().toLowerCase(), v = m[2].trim().toLowerCase();
    if (!COVERAGE_FIELDS.includes(f)) return `COVERAGE field "${f}" is not one of ${COVERAGE_FIELDS.join(', ')}`;
    if (seen.has(f)) return `COVERAGE field "${f}" appears twice`;
    if (!COVERAGE_VALUES.includes(v)) return `COVERAGE value "${v}" for "${f}" is not allowed (use ${COVERAGE_VALUES.join(', ')})`;
    seen.set(f, v);
  }
  const absent = COVERAGE_FIELDS.find(f => !seen.has(f));
  return absent ? `COVERAGE field "${absent}" is missing` : null;
}

// The ONE parser of GPT's answer structure, used by every reader (codex.js checks, findingFiles, scoring, stats).
// A line is read with Markdown decoration (* _ ` ~) taken as blanks, so no decoration can hide anything:
// 'finding' = a finding heading at any level ("### [HIGH] title", "## **[HIGH]**", "# `[LOW]`"); 'open' = a follow-up
// item still open ("1. MAINTAIN", "1) OPEN", "(1) __OPEN__", "- 1. _MAINTAIN_"); 'item' = a closed one (CONCEDE /
// RESOLVED); null = anything else. The answer text itself is never rewritten.
// (lineStatus: a follow-up item's status word, CONCEDE / RESOLVED / MAINTAIN / OPEN, or null)
function lineStatus(line) {
  const m = String(line).replace(/[*_`~]/g, ' ').match(/^\s*[-+]?\s*\(?\s*\d+\s*[.):]\s*(CONCEDE|RESOLVED|MAINTAIN|OPEN)\b/i);
  return m ? m[1].toUpperCase() : null;
}
function lineKind(line) {
  if (/^\s*#+\s*\[\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\]/i.test(String(line).replace(/[*_`~]/g, ' '))) return 'finding';
  const st = lineStatus(line);
  return st ? (st === 'MAINTAIN' || st === 'OPEN' ? 'open' : 'item') : null;
}
// How a follow-up settled earlier findings, for `gpt.js stats`: "<CONCEDE>/<RESOLVED>/<MAINTAIN>/<OPEN>" counts.
const settlement = text => ['CONCEDE', 'RESOLVED', 'MAINTAIN', 'OPEN'].map(s => String(text || '').split('\n').filter(l => lineStatus(l) === s).length).join('/');
const lineKinds = text => String(text || '').split('\n').map(lineKind);
const hasFinding = text => lineKinds(text).includes('finding');
const hasOpenItem = text => lineKinds(text).includes('open');
const findingCount = text => lineKinds(text).filter(k => k === 'finding').length;

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

// How to use the offline MQL5 reference (codex.js docsFor's result; '' for runs that don't need it).
function docsBlock(d) {
  if (!d) return '';
  const facts = 'an MQL5 API fact (function behaviour, return values, error or trade retcodes, enums, Strategy Tester behaviour)';
  if (!d.def) return `\nMQL5 DOCS: the offline MQL5 reference is not available in this run (${d.problem}). Mark any finding or claim that rests on ${facts} as "unverified against the MQL5 docs".\n`;
  return `\nMQL5 DOCS — read-only tools of the offline MQL5 reference (MCP server "mql5-chm"); use them for nothing else. Before you report anything that rests on ${facts}:\n` +
    `1. call mql5_chm_status once (note the index revision);\n` +
    `2. find the exact identifier with mql5_chm_lookup_identifiers (source "mql5", limit 1; up to 16 names per call), or mql5_chm_search for a concept;\n` +
    `3. read a supporting passage with mql5_chm_read (that topic_id, with section_id or focus; include_related false, include_images false) — an exact match or a search hit alone is no support;\n` +
    `4. cite it in the finding: (MQL5 docs: <title>, topic_id <id>, section <id> if used).\n` +
    `If the reference can't support a claim, write "unverified against the MQL5 docs" instead of asserting it. A passage verified earlier in this session can be reused.\n`;
}

module.exports = { READONLY_NOTE, EFFORT_RULES, ROLE, FINDING_FORMAT, COVERAGE_FIELDS, COVERAGE_VALUES, COVERAGE_LINE, COVERAGE_RULE, coverageDefect, lineKind, lineStatus, hasFinding, hasOpenItem, findingCount, settlement, lessonsBlock, mql5Block, docsBlock };
