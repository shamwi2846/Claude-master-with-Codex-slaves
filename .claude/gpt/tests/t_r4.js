// Computer run refuses when ownership can't be recorded (state lock held by a live owner).
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const lock = path.join(L.STATE_DIR, require('crypto').createHash('sha1').update(L.HOME.split(path.sep).join('/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 12) + '.json.lock');
ok(L.updateState(L.HOME, () => 'ran', true) === 'ran', 'strict update runs normally when the lock is free');
fs.mkdirSync(lock); // another process holds the state lock...
const keepFresh = setInterval(() => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch {} }, 2000); // ...and is alive (never reclaimed)
const t = Date.now();
const child = spawn(process.execPath, [__G + 'gpt.js', 'computer', '--task', 'noop'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d; });
const kill = setTimeout(() => child.kill(), 90000);
child.on('close', code => {
  clearInterval(keepFresh); clearTimeout(kill);
  fs.rmSync(lock, { recursive: true, force: true });
  ok(code === 6 && /could not record/.test(out), `refuses without recorded ownership (exit ${code}, ${Math.round((Date.now() - t) / 1000)}s)`);
  ok(!L.readState(L.HOME).computerLock, 'no stale lock left behind');
});
