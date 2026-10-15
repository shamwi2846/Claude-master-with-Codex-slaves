const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const MF = new Function(require('fs').readFileSync(__G + 'gpt.js','utf8').slice(require('fs').readFileSync(__G + 'gpt.js','utf8').indexOf('function metaField'), require('fs').readFileSync(__G + 'gpt.js','utf8').indexOf('function lessonsBlock')) + '; return metaField;')();
// Throwaway tests: legacy log parsing + task recovery + tree-kill on timeout.
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const src = fs.readFileSync(__G + 'gpt.js', 'utf8');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gpta2-'));
const l1 = path.join(d, 'r1.md'), l2 = path.join(d, 'r2.md');
fs.writeFileSync(l1, '- Round: 1\n- Task: ORIGINAL TASK\n- Focus: F1\n## Prompt\nx\n\n## GPT answer\n\nVERDICT: ISSUES_FOUND\n### [HIGH] quotes ## GPT answer inside\n- Location: a.js:1\n\n## Claude\'s decisions\n\n');
fs.writeFileSync(l2, `- Round: 2\n- Follows: ${l1}\n## Prompt\ny\n\n## GPT answer\n\nVERDICT: ISSUES_REMAIN\n1. MAINTAIN\n\n## Claude's decisions\n\n`);
const chainLogs = new Function('fs', 'metaField', src.slice(src.indexOf('function chainLogs'), src.indexOf('\n// A follow-up round')) + '; return chainLogs;')(fs, MF);
const tb = src.slice(src.indexOf("let taskLine = '', focusLine = '';"), src.indexOf('const meta = `- Round: ${round}'));
const tf = new Function('fs', 'chain', 'metaField', tb + '; return [taskLine, focusLine];')(fs, chainLogs(l2), MF);
ok(tf[0] === 'ORIGINAL TASK' && tf[1] === 'F1', `task/focus recovered from round 1: ${tf.join(' / ')}`);
const hb = src.slice(src.indexOf('const history = chain'), src.indexOf('const prevAnswer = history'));
const h = new Function('fs', 'chain', hb + '; return history;')(fs, chainLogs(l2));
ok(/VERDICT: ISSUES_FOUND/.test(h[0]) && /quotes ## GPT answer inside/.test(h[0]) && /Location: a\.js:1/.test(h[0]), 'legacy answer keeps verdict, title and location');
fs.rmSync(d, { recursive: true, force: true });

// tree-kill: evidence command that starts a long child, with a 2-second timeout
const script = path.join(os.tmpdir(), 'gpt-evid-' + Date.now() + '.js');
fs.writeFileSync(script, `
const src=require('fs').readFileSync('${__G}gpt.js','utf8');
const {spawn,spawnSync}=require('child_process');
const K=new Function('spawnSync',src.slice(src.indexOf('// Windows process table'),src.indexOf('// Codex workers still running'))+';return {killTree,PS_TABLE,parseTable,learnTree};')(spawnSync);
const run=new Function('spawn','killTree','root','liveChildren','PS_TABLE','parseTable','learnTree',src.slice(src.indexOf('// Windows: evidence commands run inside a Job Object'),src.indexOf('async function evidence'))+';return runTracked;')(spawn,K.killTree,process.cwd(),new Set(),K.PS_TABLE,K.parseTable,K.learnTree);
const t=Date.now();
run('powershell -NoProfile -Command "Start-Process -NoNewWindow -Wait ping -ArgumentList \\'-n\\',\\'60\\',\\'127.0.0.1\\'"',2000).then(r=>{console.log(JSON.stringify({status:r.status,secs:Math.round((Date.now()-t)/1000)}));});
`);
const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 });
let res = {}; try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); // the job's kill completes asynchronously
const pings = spawnSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE'], { encoding: 'utf8' }).stdout;
ok(res.status === null && res.secs < 20 && !/PING\.EXE/i.test(pings), `timeout kills the tree (status=${res.status}, ${res.secs}s, ping left: ${/PING\.EXE/i.test(pings)})`);
fs.rmSync(script, { force: true });



