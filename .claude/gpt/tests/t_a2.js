require('./profile-guard');
const K = require('./bridge-kit');
// Throwaway tests: legacy log parsing + task recovery + tree-kill on timeout.
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gpta2-'));
const l1 = path.join(d, 'r1.md'), l2 = path.join(d, 'r2.md');
fs.writeFileSync(l1, '- Round: 1\n- Task: ORIGINAL TASK\n- Focus: F1\n## Prompt\nx\n\n## GPT answer\n\nVERDICT: ISSUES_FOUND\n### [HIGH] quotes ## GPT answer inside\n- Location: a.js:1\n\n## Claude\'s decisions\n\n');
fs.writeFileSync(l2, `- Round: 2\n- Follows: ${l1}\n## Prompt\ny\n\n## GPT answer\n\nVERDICT: ISSUES_REMAIN\n1. MAINTAIN\n\n## Claude's decisions\n\n`);
const chain = K.review.chainLogs(l2);
const tf = K.review.followupContext(chain);
ok(tf.task === 'ORIGINAL TASK' && tf.focus === 'F1', `task/focus recovered from round 1: ${tf.task} / ${tf.focus}`);
const h = K.review.roundHistory(chain);
ok(/VERDICT: ISSUES_FOUND/.test(h[0]) && /quotes ## GPT answer inside/.test(h[0]) && /Location: a\.js:1/.test(h[0]), 'legacy answer keeps verdict, title and location');
fs.rmSync(d, { recursive: true, force: true });

// tree-kill: evidence command that starts a long child, with a 2-second timeout
const script = path.join(os.tmpdir(), 'gpt-evid-' + Date.now() + '.js');
fs.writeFileSync(script, `
const K=require(${JSON.stringify(path.join(__dirname, 'bridge-kit.js'))});
K.at(process.cwd());
const t=Date.now();
K.evidence.runTracked('powershell -NoProfile -Command "Start-Process -NoNewWindow -Wait ping -ArgumentList \\'-n\\',\\'60\\',\\'127.0.0.1\\'"',2000).then(r=>{console.log(JSON.stringify({status:r.status,secs:Math.round((Date.now()-t)/1000)}));});
`);
const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 });
let res = {}; try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); // the job's kill completes asynchronously
const pings = spawnSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE'], { encoding: 'utf8' }).stdout;
ok(res.status === null && res.secs < 20 && !/PING\.EXE/i.test(pings), `timeout kills the tree (status=${res.status}, ${res.secs}s, ping left: ${/PING\.EXE/i.test(pings)})`);
fs.rmSync(script, { force: true });
