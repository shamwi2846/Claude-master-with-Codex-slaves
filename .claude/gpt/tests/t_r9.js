// Round-9 gpt.js fixes: findings during edits, follow-up round bases, atomic stage publish, orphan kill, rolling evidence.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawn, spawnSync } = require('child_process');
const L = require(__G + 'lib.js');
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const P = path.join(os.homedir(), 'gpt-final'); fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
const f = n => path.join(P, n);
const K = require('./bridge-kit').at(P);

// A. findings are recorded even if the file was edited after it was frozen
const mr = K.review.markReviewed;
const A = f('a.js'); fs.writeFileSync(A, 'v2\n');
const cutoff = Date.now() - 1000;
L.updateState(P, s => { s.changes[A] = { lines: 5, at: Date.now() }; }); // edited after the freeze
mr('gpt', cutoff, [A], [], { verdict: 'ISSUES_FOUND', log: f('r1.md'), snaps: [], findingFiles: null });
const ca = L.readState(P).changes[A];
ok([].concat(ca.openFindings || []).includes(f('r1.md')) && ca.at > L.reviewedAtFor(L.readState(P), ca), 'findings recorded for a file edited during the review; newer version still pending');

// B. a follow-up diffs against its previous round's frozen copy, not a baseline moved by another review
const mod = K.review;
const B = f('b.js'); fs.writeFileSync(B, 'line1\nbug here\nline3\n');
const snapDir = f('snapx'); fs.mkdirSync(snapDir); fs.copyFileSync(B, path.join(snapDir, '0_b.js'));
const log = f('logs/rA.md'); fs.mkdirSync(path.dirname(log)); fs.writeFileSync(log, '- Round: 1\n');
mod.keepRound(log, [{ abs: B, snap: path.join(snapDir, '0_b.js') }, { abs: f('gone.js'), snap: null }]);
fs.writeFileSync(B, 'line1\nfixed here\nline3\n');
L.setBaseline(P, B, B); // another review acknowledged v2
const mat = mod.reviewMaterial([B], false, true, mod.roundBases(log));
ok(/-bug here/.test(mat.text) && /\+fixed here/.test(mat.text), "follow-up shows the fix against the previous round's frozen copy");
ok(mod.roundBases(log).get(f('gone.js').toLowerCase()) === 'ABSENT', 'a file deleted in the previous round is ABSENT');
const mat2 = mod.reviewMaterial([B], false, true, null);
ok(/unchanged since the last review/.test(mat2.text), 'without round copies the moved baseline shows no diff (the old behaviour)');

// C. publishDir swaps whole directories; a failed publish keeps the old version
const pub = K.write.publishDir;
const W = f('work'), N = f('next');
fs.mkdirSync(W); fs.writeFileSync(path.join(W, 'doc.md'), 'old\n'); fs.mkdirSync(N); fs.writeFileSync(path.join(N, 'doc.md'), 'new\n');
pub(N, W);
ok(fs.readFileSync(path.join(W, 'doc.md'), 'utf8') === 'new\n' && !fs.existsSync(N) && !fs.existsSync(W + '.old'), 'publish replaces work with the complete new version');
let threw = false; try { pub(f('missing'), W); } catch { threw = true; }
ok(threw && fs.readFileSync(path.join(W, 'doc.md'), 'utf8') === 'new\n', 'failed publish leaves the previous version in place');

// D + F. evidence runs: orphans that outlive the shell are killed on timeout; output keeps its real end
const run = K.evidence.runTracked; // runs in the project folder (P)
// `start /b`: the worker outlives cmd.exe and keeps the inherited output pipes open
const orphan = `start "" /b node -e "console.log('PID='+process.pid);setTimeout(()=>{},120000)"`;
(async () => {
  const r = await run(orphan, 4000);
  const pid = Number((r.out.match(/PID=(\d+)/) || [])[1]);
  await new Promise(z => setTimeout(z, 1500));
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  ok(pid && !alive, 'worker that outlived its shell is killed (status ' + r.status + ')');
  if (alive) try { process.kill(pid); } catch {}
  // cmd -> runner -> worker: runner and cmd exit, the worker keeps the pipes
  const chain = `node -e "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'inherit',detached:true});console.log('PID='+c.pid);setTimeout(()=>{},3500)"`;
  const r2 = await run(chain, 9000);
  const pid2 = Number((r2.out.match(/PID=(\d+)/) || [])[1]);
  await new Promise(z => setTimeout(z, 1500));
  let alive2 = false; try { process.kill(pid2, 0); alive2 = true; } catch {}
  ok(pid2 && r2.status === null && !alive2, 'timeout kills a worker whose parent and shell both exited');
  if (alive2) try { process.kill(pid2); } catch {}
  // launcher starts an unref'd detached worker and exits at once (before any poll could see it)
  const quick = `node -e "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'inherit',detached:true});console.log('PID='+c.pid);c.unref()"`;
  const r3 = await run(quick, 6000);
  const pid3 = Number((r3.out.match(/PID=(\d+)/) || [])[1]);
  await new Promise(z => setTimeout(z, 1500));
  let alive3 = false; try { process.kill(pid3, 0); alive3 = true; } catch {}
  ok(pid3 && !alive3, 'worker of a launcher that exited at once is killed (status ' + r3.status + ')');
  if (alive3) try { process.kill(pid3); } catch {}
  const ec = await run('exit /b 7', 20000);
  ok(ec.status === 7, 'exit code is passed through (' + ec.status + ')');
  ok(ec.contained === true && !/containment/.test(ec.out), 'the command ran inside the Job Object (contained, no warning)');
  const big = await run(`node -e "process.stdout.write('x'.repeat(9*1024*1024)); console.log('THE END')"`, 60000);
  ok(/THE END\s*$/.test(big.out) && /earlier output dropped/.test(big.out), 'over-limit output keeps its real final lines');
  fs.rmSync(P, { recursive: true, force: true });
})();


