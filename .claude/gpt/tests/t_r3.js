// Throwaway tests for goal-round-3 fixes.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const K = require('./bridge-kit');

// 1. locations with spaces / links / several refs
const root = 'C:\\Users\\Shari\\Desktop\\T3 MQL5\\MQL5 TOOLS';
const ff = K.at(root).review.findingFiles;
const a = path.join(root, 'src', 'a', 'utils.js'), b = path.join(root, 'src', 'b', 'utils.js');
const t = (loc) => { const r = ff(`VERDICT: ISSUES_FOUND\n### [HIGH] x\n- Location: ${loc}\n- Failure: y`, { map: [] }, [a, b]); return r ? [...r].map(x => x.includes('\\a\\') ? 'a' : 'b').sort().join(',') : 'ALL'; };
ok(t(`${a}:20`) === 'a', 'absolute path with spaces');
ok(t(`[utils.js:20](${a}:20)`) === 'a', 'markdown link with spaces');
ok(t('`src/b/utils.js:5`') === 'b', 'backticked relative path');
ok(t(`${a}:20, ${b}:7`) === 'a,b', 'two paths with spaces on one line');
ok(t('utils.js:3') === 'ALL', 'ambiguous basename stays safe (all open)');

// 2. metadata with U+2028 in a file name
const mf = K.review.metaField;
const files = ['C:/x/a\u2028b.js', 'C:/x/c.js'];
const log = `- Round: 1\n- Files: ${JSON.stringify(files)}\n- Task: t\n`;
ok(JSON.stringify(JSON.parse(mf(log, 'Files'))) === JSON.stringify(files), 'Files metadata survives U+2028');

// 3. computer lock: a live owner makes a second run BUSY
const live = Number(spawnSync('powershell', ['-NoProfile', '-c', '(Get-Process explorer | Select -First 1).Id'], { encoding: 'utf8' }).stdout.trim());
L.updateState(L.HOME, g => { g.computerLock = { pid: live, at: Date.now(), project: 'other' }; });
const r = spawnSync(process.execPath, [__G + 'gpt.js', 'computer', '--task', 'noop'], { encoding: 'utf8', timeout: 30000 });
ok(r.status === 6 && /BUSY/.test(r.stdout), 'second computer run is refused while one is active');
L.updateState(L.HOME, g => { g.computerLock = { pid: 999999, at: Date.now(), project: 'dead' }; g.limitUntil = Date.now() + 60000; g.limitReason = 'test'; });
const r2 = spawnSync(process.execPath, [__G + 'gpt.js', 'computer', '--task', 'noop'], { encoding: 'utf8', timeout: 30000 });
ok(r2.status !== 6 && !L.readState(L.HOME).computerLock, `dead owner's lock reclaimed and released (exit ${r2.status})`);
L.updateState(L.HOME, g => { delete g.limitUntil; delete g.limitReason; delete g.computerLock; });
