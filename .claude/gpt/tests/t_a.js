require('./profile-guard');
const K = require('./bridge-kit');
// Throwaway tests for audit-A fixes (no GPT calls).
const path = require('path'), fs = require('fs'), os = require('os');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const src = K.src;

// 1. follow-up history reads .answer.md, not a "## GPT answer" inside the prompt
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gpta-'));
const l1 = path.join(d, 'r1.md'), l2 = path.join(d, 'r2.md');
fs.writeFileSync(l1, '- Round: 1\n- Task: T\n## Prompt\ncode with "## GPT answer" inside\n## GPT answer\nWRONG\n');
fs.writeFileSync(l1.replace('.md', '.answer.md'), 'ROUND1 FINDINGS');
fs.writeFileSync(l2, `- Round: 2\n- Follows: ${l1}\n## GPT answer\nx\n`);
fs.writeFileSync(l2.replace('.md', '.answer.md'), 'ROUND2 STATUS');
const history = K.review.roundHistory(K.review.chainLogs(l2));
ok(history.join('|') === 'ROUND1 FINDINGS|ROUND2 STATUS', `history from answer files: ${history.join(' | ')}`);
fs.rmSync(d, { recursive: true, force: true });

// 2. round decrement on failure present; temp cleanup present; union-based computer check present
ok(/if \(!r\.ok && m\.round > 1\) m\.round -= 1;/.test(src), 'failed revision does not consume a round');
ok(/catch \(err\) \{ fs\.rmSync\(tmp, \{ force: true \}\); throw err; \}/.test(src), 'failed replace removes temp copy');
ok(/before\.has\(p\) \? hashOf\(p\) !== before\.get\(p\)/.test(src), 'computer check compares content of already-dirty files');
