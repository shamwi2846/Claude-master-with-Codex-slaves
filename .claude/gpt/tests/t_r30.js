// MetaTrader output is not code to review: Strategy Tester reports are never tracked. mql5-compile compiles
// a self-contained temporary copy, so the project's .ex5 and logs are never written (a tester run or a
// compile receipt may be using them), and its output still names the project's files.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), { spawnSync } = require('child_process');
const L = require(__G + 'lib.js'), E = require('./bridge-kit').evidence;
const gate = (ev, i) => spawnSync(process.execPath, [__G + 'gate.js', ev], { input: JSON.stringify(i), encoding: 'utf8' }).stdout;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const W = path.join(os.homedir(), 'gpt-r30-test');
fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(W, { recursive: true });
const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); return p; };
const utf16 = s => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const REPORT = '<!DOCTYPE html>\r\n<html>\r\n  <head>\r\n    <title>Strategy Tester Report</title>\r\n    <meta name="generator" content="strategy tester">\r\n  </head>\r\n<body><table><tr><td>Orders</td></tr></table></body></html>\r\n';

// 1. Strategy Tester reports are output, not code
const R = path.join(W, 'reports');
const rep = put(path.join(R, 'run-1.htm'), utf16(REPORT)); // the tester's own report, renamed: known by its content
const rep8 = put(path.join(R, 'mt4.html'), '<html>\n  <head>\n    <title>Strategy Tester: My EA</title>\n    <meta name="version" content="Build 1420">\n    <meta name="server" content="Demo">\n');
const page = put(path.join(R, 'page.html'), '<html><head><title>Strategy Tester guide</title></head><body>docs</body></html>');
const quick = put(path.join(R, 'quick.html'), '<html><head><title>Strategy Tester: Quickstart</title></head><body>docs</body></html>');
const guide = put(path.join(R, 'ReportTester-guide.html'), '<p>how to read a report</p>');
ok(!L.isCode(rep) && !L.isCode(rep8), "a tester report (MT5's generator tag, UTF-16; MT4's title with its version and server tags) is not code");
ok(!L.isCode(path.join(R, 'CodexSmokeReport-20261011T064121Z-9f5e8fd9c7c7.htm')) && !L.isCode(path.join(R, 'ReportTester-5039.html')) && !L.isCode(path.join(R, 'ReportOptimizer-1.htm')),
  'the names the tester and the tester script give reports are not code, even once deleted (nothing left to read)');
ok(L.isCode(page) && L.isCode(quick) && L.isCode(guide) && L.isCode(path.join(R, 'CodexSmokeReport-1.htm')) && L.isCode(path.join(R, 'index.html')) && L.isCode(path.join(R, 'Report.htm')),
  'other HTML is still code: a page titled like a report, a name that only starts like one');

// ... so a shell command that writes reports leaves nothing to review, while a page it writes is tracked
const P = path.join(W, 'proj'); fs.mkdirSync(P, { recursive: true });
const bP = { cwd: P, session_id: 'r30-' + Date.now() };
gate('session', bP); gate('prompt', { ...bP, prompt: 'run the tester' });
const pend = f => { const s = L.readState(P), c = (s.changes || {})[f]; return !!c && c.at > L.reviewedAtFor(s, c); };
gate('pre-bash', { ...bP, tool_use_id: 'b1', tool_name: 'Bash', tool_input: { command: 'pwsh Invoke-Mt5TesterSmoke.ps1' } });
wait(30);
const pr1 = put(path.join(P, 'compare', 'runs', 'r1', 'CodexSmokeReport-20261017T101500Z-0123456789ab.htm'), ''); // still being written: known by its name
const pr2 = put(path.join(P, 'compare', 'runs', 'r2', 'result.htm'), utf16(REPORT));
const pr3 = put(path.join(P, 'compare', 'runs', 'r3', 'partial.htm'), ''); // still being written, and a name of its own
const pp = put(path.join(P, 'view.html'), Array(10).fill('<p>x</p>').join('\n'));
gate('post-bash', { ...bP, tool_use_id: 'b1', tool_name: 'Bash', tool_input: { command: 'pwsh Invoke-Mt5TesterSmoke.ps1' } });
ok(!pend(pr1) && !pend(pr2) && pend(pp), 'tester reports written by a command are not tracked; a page written with them is');
ok(pend(pr3), '(a report with a name of its own, seen before its content: tracked for now)');
fs.writeFileSync(pr3, utf16(REPORT)); gate('stop', bP);
ok(!pend(pr3) && pend(pp), '... and cleared at the end of the turn, once its content shows it is a report');
// deleted from git: judged by the version git last had
const G = path.join(W, 'gitproj'); fs.mkdirSync(G, { recursive: true });
const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: G, encoding: 'utf8' });
const gr = put(path.join(G, 'runs', 'r1', 'result.htm'), utf16(REPORT)), gp = put(path.join(G, 'page.html'), '<p>page</p>\n');
git('init', '-q'); git('add', '.'); git('commit', '-qm', 'reports');
const bG = { cwd: G, session_id: 'r30g-' + Date.now() };
gate('session', bG); gate('prompt', { ...bG, prompt: 'clean up' });
gate('pre-bash', { ...bG, tool_use_id: 'g1', tool_name: 'Bash', tool_input: { command: 'rm -r runs page.html' } });
wait(30); fs.rmSync(path.join(G, 'runs'), { recursive: true }); fs.rmSync(gp);
gate('post-bash', { ...bG, tool_use_id: 'g1', tool_name: 'Bash', tool_input: { command: 'rm -r runs page.html' } });
gate('stop', bG);
const pendG = f => { const s = L.readState(G), c = (s.changes || {})[f]; return !!c && c.at > L.reviewedAtFor(s, c); };
ok(!pendG(gr) && pendG(gp), 'deleting a committed report (any name, its folder gone too) is not a change to review; deleting a page is');
// ... also when the deletion is committed in the same turn (HEAD no longer has it: the commit before does)
const gr2 = put(path.join(G, 'runs2', 'r', 'out.htm'), utf16(REPORT)), gp2 = put(path.join(G, 'page2.html'), '<p>page</p>\n');
git('add', '.'); git('commit', '-qm', 'more');
gate('prompt', { ...bG, prompt: 'clean up and commit' });
gate('pre-bash', { ...bG, tool_use_id: 'g2', tool_name: 'Bash', tool_input: { command: 'git rm -rq runs2 page2.html && git commit -m gone' } });
wait(30); git('rm', '-rq', 'runs2', 'page2.html'); git('commit', '-qm', 'gone');
gate('post-bash', { ...bG, tool_use_id: 'g2', tool_name: 'Bash', tool_input: { command: 'git rm -rq runs2 page2.html && git commit -m gone' } });
gate('stop', bG);
ok(!fs.existsSync(gr2) && !pendG(gr2) && pendG(gp2), 'a report deletion committed in the same turn is not a change to review; a page deletion is');
// a report still pending from an earlier turn (seen before its content), committed complete, then deleted
// and the deletion committed in the next turn: judged by the turn-start commit, which still had it
gate('prompt', { ...bG, prompt: 'run the tester' });
gate('pre-bash', { ...bG, tool_use_id: 'g3', tool_name: 'Bash', tool_input: { command: 'node smoke.js' } });
wait(30); const gr3 = put(path.join(G, 'runs3', 'part.htm'), '');
gate('post-bash', { ...bG, tool_use_id: 'g3', tool_name: 'Bash', tool_input: { command: 'node smoke.js' } });
gate('stop', bG);
const stillPending = pendG(gr3);
fs.writeFileSync(gr3, utf16(REPORT)); git('add', '.'); git('commit', '-qm', 'report'); // (between turns)
gate('prompt', { ...bG, prompt: 'remove the old run' });
gate('pre-bash', { ...bG, tool_use_id: 'g4', tool_name: 'Bash', tool_input: { command: 'git rm -rq runs3 && git commit -m gone' } });
wait(30); git('rm', '-rq', 'runs3'); git('commit', '-qm', 'gone');
gate('post-bash', { ...bG, tool_use_id: 'g4', tool_name: 'Bash', tool_input: { command: 'git rm -rq runs3 && git commit -m gone' } });
gate('stop', bG);
ok(stillPending && !fs.existsSync(gr3) && pendG(gr3), 'a pending report whose deletion was committed in an earlier commit stays pending (shown for review: older history is never trusted)');
// a path reused: hand-written HTML recreated where a committed report was deleted, edited, then deleted
put(gr3, '<p>hand-written</p>\n'); // (between turns, untracked)
gate('prompt', { ...bG, prompt: 'edit and drop the page' });
gate('pre-bash', { ...bG, tool_use_id: 'g5', tool_name: 'Bash', tool_input: { command: 'node edit.js && rm runs3/part.htm' } });
wait(30); fs.writeFileSync(gr3, '<p>hand-written, edited</p>\n'); fs.rmSync(path.join(G, 'runs3'), { recursive: true });
gate('post-bash', { ...bG, tool_use_id: 'g5', tool_name: 'Bash', tool_input: { command: 'node edit.js && rm runs3/part.htm' } });
gate('stop', bG);
ok(pendG(gr3), "... and an old report in the history never clears a hand-written file deleted at the same path");
// the same in a git repository nested in a non-git session folder
const NP = path.join(W, 'nested'), NS = path.join(NP, 'sub'); fs.mkdirSync(NS, { recursive: true });
const gitN = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: NS, encoding: 'utf8' });
put(path.join(NS, 'readme.txt'), 'x'); gitN('init', '-q'); gitN('add', '.'); gitN('commit', '-qm', 'init');
const bN = { cwd: NP, session_id: 'r30n-' + Date.now() };
gate('session', bN); gate('prompt', { ...bN, prompt: 'run the tester' });
gate('pre-bash', { ...bN, tool_use_id: 'n1', tool_name: 'Bash', tool_input: { command: 'node smoke.js' } });
wait(30); const nr = put(path.join(NS, 'runs', 'part.htm'), '');
gate('post-bash', { ...bN, tool_use_id: 'n1', tool_name: 'Bash', tool_input: { command: 'node smoke.js' } });
gate('stop', bN);
const pendN = f => { const s = L.readState(NP), c = (s.changes || {})[f]; return !!c && c.at > L.reviewedAtFor(s, c); };
const nStill = pendN(nr);
fs.writeFileSync(nr, utf16(REPORT)); gitN('add', '.'); gitN('commit', '-qm', 'report');
gate('prompt', { ...bN, prompt: 'remove the old run' });
gate('pre-bash', { ...bN, tool_use_id: 'n2', tool_name: 'Bash', tool_input: { command: 'cd sub && git rm -rq runs && git commit -m gone' } });
wait(30); gitN('rm', '-rq', 'runs'); gitN('commit', '-qm', 'gone');
gate('post-bash', { ...bN, tool_use_id: 'n2', tool_name: 'Bash', tool_input: { command: 'cd sub && git rm -rq runs && git commit -m gone' } });
gate('stop', bN);
ok(nStill && !fs.existsSync(nr) && pendN(nr), '... the same in a repository nested in a non-git session folder (stays pending, no history search)');

// 2. MetaEditor's own MQL5 folder: %APPDATA%\MetaQuotes\Terminal\<MD5 of the upper-cased install path, UTF-16LE>
const ME_DIR = path.join(W, 'fake me'), APPDATA = path.join(W, 'appdata');
const id = crypto.createHash('md5').update(Buffer.from(ME_DIR.toUpperCase(), 'utf16le')).digest('hex').toUpperCase();
const LIB = path.join(APPDATA, 'MetaQuotes', 'Terminal', id, 'MQL5');
put(path.join(LIB, 'Include', 'Lib', 'L.mqh'), '#include "Base.mqh"\nint L(){return 0;}\n');
put(path.join(LIB, 'Include', 'Lib', 'Base.mqh'), 'int Base(){return 0;}\n');
put(path.join(LIB, 'Files', 'lib.bin'), 'L');
const ME = put(path.join(ME_DIR, 'metaeditor64.cmd'), `@"${process.execPath}" "%~dp0me.js" %*\r\n`);
const appdata0 = process.env.APPDATA;
process.env.APPDATA = APPDATA;
ok(E.metaeditorRoot(ME, 'x.mq5') === LIB, "MetaEditor's own MQL5 folder is found from its install path");
process.env.APPDATA = path.join(W, 'nowhere');
const portable = path.join(ME_DIR, 'MQL5'); fs.mkdirSync(path.join(portable, 'Include'), { recursive: true });
ok(E.metaeditorRoot(ME, 'x.mq5') === portable, 'a portable install: its own install folder');
fs.rmSync(portable, { recursive: true, force: true });
ok(E.metaeditorRoot(ME, 'x.mq5') === null && E.metaeditorRoot('', 'x.mq5') === null, 'none: null');
if (appdata0 === undefined) delete process.env.APPDATA; else process.env.APPDATA = appdata0;

// 3. The source set: "x" next to the including file only (as MetaEditor: not the main file's folder, not an
// Include folder), <x> from the MQL5 folders, resources
const A = path.join(W, 'proj a'), EA = put(path.join(A, 'EA.mq5'),
  '#include <Lib\\L.mqh>\n#include "inc\\a.mqh"\n#resource "\\\\Files\\\\lib.bin" as uchar D[]\n#resource "data\\\\near.bin" as uchar N[]\nint OnInit(){return 0;}\n');
put(path.join(A, 'inc', 'a.mqh'), '#include "shared.mqh"\nint A(){return 0;}\n');
put(path.join(A, 'inc', 'shared.mqh'), 'int S(){return 0;}\n');
put(path.join(A, 'data', 'near.bin'), 'N');
const sa = E.mqlSources(EA, LIB);
const names = s => s.entries.map(e => path.relative(W, e.f).replace(/\\/g, '/')).sort();
ok(JSON.stringify(names(sa)) === JSON.stringify(['appdata/MetaQuotes/Terminal/' + id + '/MQL5/Files/lib.bin', 'appdata/MetaQuotes/Terminal/' + id + '/MQL5/Include/Lib/Base.mqh',
  'appdata/MetaQuotes/Terminal/' + id + '/MQL5/Include/Lib/L.mqh', 'proj a/EA.mq5', 'proj a/data/near.bin', 'proj a/inc/a.mqh', 'proj a/inc/shared.mqh'].sort()) && !sa.missing.length && sa.root === null,
  `library includes and resources from MetaEditor's folder, nested quoted includes, embedded files: all in the fingerprint (${names(sa).join(', ')})`);
const QM = path.join(W, 'qmain'), QE = put(path.join(QM, 'E.mq5'), '#include "sub\\a.mqh"\n#include "Lib\\L.mqh"\n');
put(path.join(QM, 'sub', 'a.mqh'), '#include "s.mqh"\n'); put(path.join(QM, 's.mqh'), ''); // s.mqh only next to the main file
const sq = E.mqlSources(QE, LIB);
ok(sq.files === 2 && sq.missing.some(m => /sub[\\/]s\.mqh$/.test(m)) && sq.missing.some(m => /qmain[\\/]Lib[\\/]L\.mqh$/.test(m)),
  'a quoted include found only next to the main file, or only in an Include folder, is missing (MetaEditor looks nowhere else)');
const sNone = E.mqlSources(EA, null);
ok(sNone.missing.some(m => /Lib[\\/]L\.mqh$/.test(m)) && sNone.missing.includes('\\\\Files\\\\lib.bin') && sNone.files === 4, 'without a known MQL5 folder those are reported missing');
fs.writeFileSync(path.join(A, 'data', 'near.bin'), 'M');
ok(E.mqlSources(EA, LIB).hash !== sa.hash, 'the fingerprint changes with an embedded file');
const CT = path.join(W, 'cont'), CE = put(path.join(CT, 'C.mq5'), '#include \\\r\n  "cont.mqh"\n  #  include<Lib\\L.mqh>\n#resource \\\n"r.bin"\n'); put(path.join(CT, 'cont.mqh'), ''); put(path.join(CT, 'r.bin'), 'R');
ok(E.mqlSources(CE, LIB).files === 5, 'a directive continued on the next line, or written "#  include<x>", is followed too');
const BE = put(path.join(CT, 'B.mq5'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#include "cont.mqh"\n#resource "r.bin"\n')]));
ok(E.mqlSources(BE, LIB).files === 3, 'a directive on the first line of a UTF-8 file with a BOM is followed');
ok(E.mqlSources(EA, LIB, 3).truncated && !E.mqlSources(EA, LIB).truncated, 'a source set over the limit is reported as truncated');

// 4. The copy: self-contained, laid out as the project, never inside it
const tmp = os.tmpdir().toLowerCase();
const ca = E.mqlCopy(sa, EA);
const rd = f => fs.readFileSync(f, 'utf8');
ok(ca.includeRoot === path.join(ca.dir, 'MQL5') && ca.main === path.join(ca.includeRoot, 'Experts', 'proj a', 'EA.mq5') && rd(ca.main) === rd(EA) &&
  rd(path.join(ca.includeRoot, 'Include', 'Lib', 'Base.mqh')) === rd(path.join(LIB, 'Include', 'Lib', 'Base.mqh')) && fs.existsSync(path.join(ca.includeRoot, 'Files', 'lib.bin')) &&
  fs.readFileSync(path.join(ca.includeRoot, 'Experts', 'proj a', 'data', 'near.bin'), 'utf8') === 'N' && ca.dir.toLowerCase().startsWith(tmp),
  "a project outside any MQL5 folder: under a private MQL5 folder with the library files it uses, copied from the fingerprinted content (the later edit isn't in it)");
ok(E.fromCopy(`${ca.main}(2,1) : error 100: x | ${path.join(ca.includeRoot, 'Include', 'Lib', 'L.mqh')}(1,1) | ${path.join(ca.includeRoot, 'Include', 'Nope.mqh')}`, ca) ===
  `${EA}(2,1) : error 100: x | ${path.join(LIB, 'Include', 'Lib', 'L.mqh')}(1,1) | ${path.join(LIB, 'Include', 'Nope.mqh')}`, "compiler messages name the project's (and MetaEditor's) files, not the copy");
fs.rmSync(ca.dir, { recursive: true, force: true });
const cNone = E.mqlCopy(sNone, EA);
ok(cNone.includeRoot === null && cNone.main === path.join(cNone.dir, 'proj a', 'EA.mq5'), "no MQL5 folder known: a plain copy, MetaEditor's default include folder");
fs.rmSync(cNone.dir, { recursive: true, force: true });
// a project in an MQL5 folder layout: that folder is the copy's include folder
const M = path.join(W, 'repo', 'MQL5'), X = put(path.join(M, 'Experts', 'X', 'X.mq5'), '#include <Mine\\m.mqh>\n#include <Lib\\L.mqh>\n#resource "\\\\Images\\\\i.bmp"\n');
put(path.join(M, 'Include', 'Mine', 'm.mqh'), 'int M(){return 0;}\n'); put(path.join(M, 'Images', 'i.bmp'), 'BM');
const sx = E.mqlSources(X, LIB), cx = E.mqlCopy(sx, X);
const under = (d, f) => fs.existsSync(path.join(d, ...f.split('/')));
ok(sx.root === M && cx.includeRoot === path.join(cx.dir, 'MQL5') && cx.main === path.join(cx.includeRoot, 'Experts', 'X', 'X.mq5') &&
  ['Include/Mine/m.mqh', 'Include/Lib/L.mqh', 'Include/Lib/Base.mqh', 'Images/i.bmp'].every(f => under(cx.includeRoot, f)) && !sx.entries.some(e => /lib\.bin$/.test(e.f)),
  "a project in an MQL5 folder: copied with that folder's layout, its own library files and MetaEditor's together");
fs.rmSync(cx.dir, { recursive: true, force: true });
// two different files that would land on one place: refused, nothing left behind
put(path.join(M, 'Include', 'Base.mqh'), 'int Mine(){return 1;}\n'); put(path.join(LIB, 'Include', 'Base.mqh'), 'int Theirs(){return 2;}\n');
put(path.join(LIB, 'Include', 'Only.mqh'), '#include "Base.mqh"\n');
const Y = put(path.join(M, 'Experts', 'Y.mq5'), '#include <Base.mqh>\n#include <Only.mqh>\n');
const cy = E.mqlCopy(E.mqlSources(Y, LIB), Y);
ok(/would share one place in the copy/.test(cy.error || '') && !cy.dir, 'files that would collide in the copy: refused');
// a quoted include missing in the project that the merged copy would supply (MetaEditor's file next to it)
put(path.join(M, 'Include', 'Pkg', 'A.mqh'), '#include "B.mqh"\n'); put(path.join(LIB, 'Include', 'Pkg', 'B.mqh'), 'int B(){return 0;}\n');
const Z = put(path.join(M, 'Experts', 'Z.mq5'), '#include <Pkg\\A.mqh>\n#include <Pkg\\B.mqh>\n');
const cz = E.mqlCopy(E.mqlSources(Z, LIB), Z);
ok(cz.conflicts.length === 1 && cz.conflicts[0].probe && /^#include "B\.mqh" in .*A\.mqh$/.test(cz.conflicts[0].what) && /Pkg[\\/]B\.mqh$/.test(cz.conflicts[0].got),
  'an include the merged copy would supply where the project has none: reported as a conflict to probe');
fs.rmSync(cz.dir, { recursive: true, force: true });
// the probe marks exactly that directive, keeps every other byte (UTF-16 as UTF-16, other files byte for byte), and restores
const ansi = Buffer.concat([Buffer.from('// caf'), Buffer.from([0xe9]), Buffer.from('\n#ifdef __MQL4__\n#  include \\\n "B.mqh"\n#endif\nint A2(){return 0;}\n')]);
put(path.join(M, 'Include', 'Pkg', 'A2.mqh'), ansi);
put(path.join(M, 'Include', 'Pkg', 'A3.mqh'), utf16('#ifdef __MQL4__\r\n#include "B.mqh"\r\n#endif\r\nint A3(){return 0;}\r\n'));
const Z2 = put(path.join(M, 'Experts', 'Z2.mq5'), '#include <Pkg\\A2.mqh>\n#include <Pkg\\A3.mqh>\n#include <Pkg\\B.mqh>\nint OnInit(){return A2()+A3();}\n');
const s2 = E.mqlSources(Z2, LIB), c2 = E.mqlCopy(s2, Z2), p2 = E.mqlProbe(c2, s2);
const a2c = c2.copyOf.get(path.join(M, 'Include', 'Pkg', 'A2.mqh').toLowerCase()), a3c = c2.copyOf.get(path.join(M, 'Include', 'Pkg', 'A3.mqh').toLowerCase());
const probed2 = fs.readFileSync(a2c), probed3 = fs.readFileSync(a3c), mk = p2.marks.map(m => m.mark);
ok(p2.marks.length === 2 && probed2.equals(Buffer.from(ansi.toString('latin1').replace('"B.mqh"', `"${mk[0]}"`), 'latin1')) && probed3[0] === 0xff && probed3[1] === 0xfe &&
  probed3.slice(2).toString('utf16le').includes(`#include "${mk[1]}"`) && !probed3.slice(2).toString('utf16le').includes('"B.mqh"'),
  'the probe marks each conflicting directive (continued line, ANSI bytes, UTF-16 file) and keeps every other byte');
p2.restore();
ok(fs.readFileSync(a2c).equals(ansi) && fs.readFileSync(a3c).equals(fs.readFileSync(path.join(M, 'Include', 'Pkg', 'A3.mqh'))), '... and puts the copied files back exactly');
// an icon MetaEditor's folder supplies in the copy, named by an active directive continued between
// "property" and "icon" and by a commented-out one: both are marked, and the edited file is read again
put(path.join(LIB, 'Experts', 'x.ico'), 'ICO');
const IC = put(path.join(M, 'Experts', 'I.mq5'), '#resource "\\\\Experts\\\\x.ico"\n/*\n#property icon "x.ico"\n*/\n#property \\\n  icon "x.ico"\nint OnInit(){return 0;}\n');
const si = E.mqlSources(IC, LIB), ci = E.mqlCopy(si, IC), pi = E.mqlProbe(ci, si);
const icoText = fs.readFileSync(ci.main, 'latin1');
ok(ci.conflicts.filter(c => c.probe).length === 2 && pi.marks.length === 1 && icoText.split(pi.marks[0].mark).length === 3 && !E.directives(icoText).some(d => d.raw === 'x.ico'),
  'a resource named twice (one directive continued between "property" and "icon"): every occurrence is marked, checked by reading the file again');
pi.restore(); fs.rmSync(ci.dir, { recursive: true, force: true });
c2.conflicts[0].link = { ...c2.conflicts[0].link, raw: 'C.mqh' };
ok(/could not be marked for a probe compile/.test(E.mqlProbe(c2, s2).error || '') && fs.readFileSync(a2c).equals(ansi), 'a directive that cannot be marked: refused, nothing changed');
fs.rmSync(c2.dir, { recursive: true, force: true });
// copies a killed compile left behind are removed once an hour old
const oldCopy = path.join(os.tmpdir(), `gpt-compile-r30old-${process.pid}`), newCopy = path.join(os.tmpdir(), `gpt-compile-r30new-${process.pid}`);
put(path.join(oldCopy, 'MQL5', 'x.mq5'), ''); put(path.join(newCopy, 'MQL5', 'x.mq5'), '');
const hourAgo = new Date(Date.now() - 2 * 3600000); fs.utimesSync(oldCopy, hourAgo, hourAgo);
E.sweepCopies();
ok(!fs.existsSync(oldCopy) && fs.existsSync(newCopy), 'stale copies (over an hour old) are swept; a fresh one is kept');
fs.rmSync(newCopy, { recursive: true, force: true });
ok(/process\.once\('exit', removeCopy\)/.test(require('./bridge-kit').src), 'a cancelled compile removes its copy too (on exit, after MetaEditor is stopped)');

// 5. gpt.js mql5-compile end to end, with a fake MetaEditor. It records what it was given, then "compiles":
// it opens includes as MetaEditor does ("x" next to the including file, <x> in the /include folder's
// Include; lines inside #ifdef __MQL4__ ... #endif are skipped), reports a missing one as error 106 and a
// file saying BOOM as error 100, and writes <name>.ex5 next to the file and a UTF-16 log.
const REC = path.join(W, 'rec.json');
put(path.join(ME_DIR, 'me.js'), `const fs = require('fs'), path = require('path');
const arg = k => (process.argv.slice(2).find(a => a.toLowerCase().startsWith('/' + k + ':')) || '').slice(k.length + 2);
const src = arg('compile'), log = arg('log'), inc = arg('include'), text = fs.readFileSync(src, 'utf8'), files = [], errors = [], opened = [];
const read = f => { const b = fs.readFileSync(f); return b[0] === 0xff && b[1] === 0xfe ? b.slice(2).toString('utf16le') : b.toString('latin1'); };
(function walk(d, rel) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p, rel + n + '/'); else files.push(rel + n); } })(inc || path.dirname(src), '');
const probeLeft = files.some(f => read(path.join(inc || path.dirname(src), f)).includes('__gpt_probe'));
(function visit(f) {
  if (opened.includes(f.toLowerCase())) return; opened.push(f.toLowerCase());
  let skip = 0;
  for (const line of read(f).replace(/\\\\\\r?\\n/g, ' ').split(/\\r?\\n/)) {
    if (/^\\s*#ifdef\\s+__MQL4__/.test(line)) { skip++; continue; }
    if (skip && /^\\s*#endif/.test(line)) { skip--; continue; }
    if (skip) continue;
    const m = line.match(/^\\s*#\\s*include\\s*(?:"([^"]+)"|<([^>]+)>)/);
    if (m) { const t = m[1] ? path.join(path.dirname(f), m[1]) : path.join(inc || 'none', 'Include', m[2]); if (fs.existsSync(t)) visit(t); else errors.push(f + "(1,10) : error 106: file '" + t + "' not found"); }
    const r = line.match(/^\\s*#\\s*(?:resource|property\\s+icon)\\s*"([^"]+)"/);
    if (r) { const n = r[1].replace(/\\\\\\\\/g, '\\\\'), t = /^[\\\\/]/.test(n) ? path.join(inc || 'none', n) : path.join(path.dirname(f), n); if (!fs.existsSync(t)) errors.push(f + "(1,1) : error 313: invalid resource path '" + n + "'"); }
    if (/BOOM/.test(line)) errors.push(f + '(2,1) : error 100: boom');
  }
})(src);
if (process.env.FAKE_ME_MUTATE) fs.appendFileSync(process.env.FAKE_ME_MUTATE, '// edited during the compile\\n');
fs.writeFileSync(src.replace(/\\.mq5$/i, '.ex5'), 'EX5');
fs.writeFileSync(log, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(errors.map(e => e + '\\r\\n').join('') + 'Result: ' + errors.length + ' errors, 0 warnings\\r\\n', 'utf16le')]));
fs.appendFileSync(process.env.FAKE_ME_REC, JSON.stringify({ src, log, inc, text, files, errors, probeLeft }) + '\\n');
`);
const cf = path.join(L.HOME, 'config.json'), orig = fs.readFileSync(cf, 'utf8');
fs.writeFileSync(cf, JSON.stringify({ ...JSON.parse(orig), metaeditorPath: ME }));
const list = d => { const out = []; (function walk(x) { for (const n of fs.readdirSync(x)) { const p = path.join(x, n), st = fs.statSync(p); if (st.isDirectory()) walk(p); else out.push(`${path.relative(d, p)} ${st.size} ${st.mtimeMs}`); } })(d); return out.sort().join('\n'); };
const compile = (file, extra = {}) => {
  fs.rmSync(REC, { force: true });
  const r = spawnSync(process.execPath, [__G + 'gpt.js', 'mql5-compile', file], { cwd: W, encoding: 'utf8', env: { ...process.env, APPDATA, FAKE_ME_REC: REC, ...extra } });
  let calls = []; try { calls = fs.readFileSync(REC, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch {}
  const rec = calls[calls.length - 1] || {};
  const top = rec.src ? path.join(os.tmpdir(), path.relative(os.tmpdir(), rec.src).split(/[\\/]/)[0]) : null;
  return { ...r, rec, calls, gone: !!top && !fs.existsSync(top) };
};
try {
  const b0 = list(A), r1 = compile(EA);
  ok(r1.status === 0 && /^compiled: .*EA\.mq5 \(from a temporary copy — the project's \.ex5 is not updated; 7 source file/.test(r1.stdout) && /Result: 0 errors/.test(r1.stdout) && !/includes not found/.test(r1.stdout),
    `a clean compile: exit 0, the result shown (${(r1.stdout + r1.stderr).trim().split('\n')[0]})`);
  ok(list(A) === b0 && r1.rec.src && r1.rec.src.toLowerCase().startsWith(tmp) && r1.gone, 'the project is untouched (no .ex5, no log); MetaEditor compiled a temporary copy, removed afterwards');
  ok(r1.rec.inc === path.join(path.dirname(path.dirname(path.dirname(r1.rec.src)))) && ['Include/Lib/L.mqh', 'Include/Lib/Base.mqh', 'Files/lib.bin', 'Experts/proj a/inc/a.mqh', 'Experts/proj a/inc/shared.mqh', 'Experts/proj a/data/near.bin'].every(f => r1.rec.files.includes(f)) && r1.calls.length === 1 && !r1.rec.errors.length,
    'MetaEditor gets /include: the copy, with every file the compile needs (one compile, no probe)');
  fs.writeFileSync(EA, rd(EA).replace('int OnInit', 'BOOM\nint OnInit'));
  const r2 = compile(EA);
  ok(r2.status === 1 && r2.stdout.includes(`${EA}(2,1) : error 100: boom`) && !r2.stdout.toLowerCase().includes(tmp) && r2.gone, "a failed compile: exit 1, errors name the project's file");
  const r3 = compile(EA, { FAKE_ME_MUTATE: EA });
  ok(/SOURCES CHANGED during the compile .*this result is for the earlier version/.test(r3.stdout) && !/edited during the compile/.test(r3.rec.text || 'edited during the compile'), 'an edit during the compile: reported; the copy had the earlier version');
  const bx = list(path.join(W, 'repo')), r4 = compile(X);
  ok(r4.status === 0 && list(path.join(W, 'repo')) === bx && path.basename(r4.rec.inc) === 'MQL5' && ['Include/Mine/m.mqh', 'Include/Lib/L.mqh', 'Images/i.bmp', 'Experts/X/X.mq5'].every(f => r4.rec.files.includes(f)) && r4.gone,
    'a project in an MQL5 folder: compiled from a copy of that folder, the project untouched');
  const r5 = compile(Z);
  ok(r5.status === 1 && /^not compiled: .*Z\.mq5 — #include "B\.mqh" in .*A\.mqh finds no file in the project, and MetaEditor does open it/.test(r5.stdout) && r5.calls.length === 1 && r5.gone,
    'an include the merged copy would supply, and MetaEditor opens: the probe shows it; not compiled, said why (the project fails there)');
  const bz = list(path.join(W, 'repo')), r7 = compile(Z2);
  ok(r7.status === 0 && r7.calls.length === 2 && /2 directive\(s\) that would find MetaEditor's own file in the copy, where the project has none, are never opened \(shown by a probe compile\)/.test(r7.stdout) &&
    !r7.calls[1].probeLeft && r7.calls[0].probeLeft && r7.calls[0].log !== r7.calls[1].log && /Result: 0 errors/.test(r7.stdout) && list(path.join(W, 'repo')) === bz && r7.gone,
    'such includes in inactive #ifdef branches: the probe shows MetaEditor skips them, then the real compile runs on the restored copy (with a log of its own)');
  const ri = compile(IC);
  ok(ri.status === 1 && /^not compiled: .*I\.mq5 — #resource "x\.ico" in .*I\.mq5 finds no file in the project, and MetaEditor does open it/.test(ri.stdout) && ri.calls.length === 1,
    'the active icon directive is opened by the probe: never compiled as if the project had the icon');
  fs.writeFileSync(Z2, rd(Z2) + 'BOOM\n');
  const r8 = compile(Z2);
  ok(r8.status === 1 && r8.calls.length === 1 && /could not show that MetaEditor never opens it \(the probe: .*Z2\.mq5\(2,1\) : error 100: boom\)/.test(r8.stdout) && r8.gone,
    "a probe that fails for another reason proves nothing: not compiled, said why (naming the project's file)");
  const BIG = path.join(W, 'big'), lines = [];
  for (let i = 0; i <= 2000; i++) { put(path.join(BIG, 'inc', `f${i}.mqh`), ''); lines.push(`#include "inc\\f${i}.mqh"`); }
  const r6 = compile(put(path.join(BIG, 'Big.mq5'), lines.join('\n') + '\n'));
  ok(r6.status === 1 && /not compiled: .*over 2000 files/.test(r6.stdout) && !r6.rec.src, 'a source set too big to copy completely: not compiled (no misleading errors from a partial copy)');
} finally { fs.writeFileSync(cf, orig); }

fs.rmSync(W, { recursive: true, force: true });
