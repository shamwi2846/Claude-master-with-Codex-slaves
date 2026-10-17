// Build/test/compile output for reviews: commands run inside a Windows Job Object (the whole process tree
// is stopped at a timeout), captured output, and the MQL source fingerprint used by mql5-compile.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const L = require('../lib');
const C = require('./ctx');
const X = require('./codex');

// Build/test/compile output Claude wants GPT to see. --evidence "cmd1 ;; cmd2" runs the commands here
// (cwd = project); --evidence-file attaches output Claude already captured.
// Run one shell command with a timeout that stops the WHOLE process tree (builders the shell started
// too), while the shell is still alive so taskkill /T can find its children.
// Windows: evidence commands run inside a Job Object that kills every process still in it when the job
// helper exits or is killed — workers that outlive their shell or launcher included (process trees can't
// be traced once intermediate processes have exited). The helper (detached, so it is outside node's own
// job, whose silent breakaway would let grandchildren escape) runs `cmd /d /s /c "<command>"` like
// spawn's shell option, forwards its output and exit code. If the job can't be created the command still
// runs, and the output says so (leftover processes are then only ended at a timeout, via killTree).
const JOB_RUNNER = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class GptJob {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT { public BASIC Basic; public IO Io; public UIntPtr p1, p2, p3, p4; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static bool Enter() {
    IntPtr j = CreateJobObject(IntPtr.Zero, null);
    if (j == IntPtr.Zero) return false;
    EXT i = new EXT(); i.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(j, 9, ref i, (uint)Marshal.SizeOf(typeof(EXT)))) return false;
    return AssignProcessToJobObject(j, GetCurrentProcess());
  }
}
'@
if (-not [GptJob]::Enter()) { throw 'job setup failed' }
} catch { [Console]::Out.WriteLine('[gpt.js] warning: process containment unavailable: ' + $_.Exception.Message) }
$si = New-Object System.Diagnostics.ProcessStartInfo
$si.FileName = $env:ComSpec
$si.Arguments = '/d /s /c "' + $env:GPTJS_CMD + '"'
$si.UseShellExecute = $false
$si.CreateNoWindow = $true
$si.RedirectStandardOutput = $true
$si.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($si)
$out = [Console]::OpenStandardOutput()
$t1 = $p.StandardOutput.BaseStream.CopyToAsync($out)
$t2 = $p.StandardError.BaseStream.CopyToAsync($out)
$p.WaitForExit()
[void][System.Threading.Tasks.Task]::WaitAll(@($t1, $t2), 3000)
$out.Flush()
exit $p.ExitCode`;

const CONTAINMENT_WARNING = '[gpt.js] warning: process containment unavailable';
const UNCONTAINED_NOTE = 'process containment unavailable — processes it left behind are only ended at a timeout';

function runTracked(cmd, timeoutMs) {
  return new Promise(resolve => {
    // stdin ignored = immediate EOF (as with spawnSync), so commands that read stdin don't hang.
    const child = process.platform === 'win32'
      ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(JOB_RUNNER, 'utf16le').toString('base64')],
        { cwd: C.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GPTJS_CMD: cmd } })
      : spawn(cmd, { cwd: C.root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.startedAt = Date.now(); // lets killTree find descendants if the job could not be created
    X.liveChildren.add(child); // stopped with the rest if gpt.js is cancelled
    child.on('close', () => X.liveChildren.delete(child));
    let buf = '', timedOut = false, done = false, dropped = false, head = '';
    // `contained`: the Job Object was set up (its warning is the helper's first output line). Reported
    // separately, since the kept output is only the tail.
    const finish = status => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(hard);
      const contained = process.platform === 'win32' && !head.includes(CONTAINMENT_WARNING);
      if (!contained) buf = buf.split('\n').filter(l => !l.includes(CONTAINMENT_WARNING)).join('\n');
      resolve({ out: (dropped ? '[gpt.js] (earlier output dropped: over the capture limit)\n' : '') + buf, status: timedOut ? null : status, contained });
    };
    // Keep a rolling window of the latest output: the END (final errors, summary) is what matters.
    const CAP = 8 * 1024 * 1024;
    const add = d => { if (head.length < 4096) head += d; buf += d; if (buf.length > CAP) { buf = buf.slice(-CAP / 2); dropped = true; } };
    // (decoded as one stream: a character split between two chunks stays whole)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let hard;
    const timer = setTimeout(() => {
      timedOut = true; X.killTree(child);
      hard = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 15000);
    }, timeoutMs);
    child.on('error', e => { buf += `\n${e.message}`; finish(1); });
    child.on('close', code => finish(code));
  });
}

// The files under review (`frozen`: [{ abs, snap }] from reviewMaterial — snap = the frozen copy GPT reads, null =
// deleted) whose live version differs from what GPT reviews.
function differsFromReviewed(frozen) {
  const same = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };
  return (frozen || []).filter(({ abs, snap }) => (snap ? !fs.existsSync(abs) || !same(abs, snap) : fs.existsSync(abs))).map(({ abs }) => abs);
}

// `frozen`: the review's frozen files, so every piece of evidence says how it relates to the reviewed version.
// Evidence commands run on the live project, not the frozen copy: the reviewed files are compared before and
// after them ("matched" says nothing about the time in between). An evidence file Claude captured carries no
// record of what it tested: it is marked unverified, plus the reviewed files that changed after it was written.
async function evidence(frozen = null) {
  const { opts, cfg } = C;
  // During a usage-limit cooldown the GPT call will be refused anyway: don't run builds/tests for nothing.
  if ((L.readState(L.HOME).limitUntil || 0) > Date.now() && !opts['force-gpt']) return '';
  let out = '';
  const summary = [], labels = [];
  const cmds = String(opts.evidence || '').split(';;').map(s => s.trim()).filter(Boolean);
  const before = frozen && cmds.length ? differsFromReviewed(frozen) : [];
  for (const c of cmds) {
    const t = Date.now();
    const r = await runTracked(c, (cfg.evidenceTimeoutMinutes || 10) * 60000);
    const lines = r.out.split(/\r?\n/);
    const tail = lines.slice(-(cfg.evidenceTailLines || 120)).join('\n');
    const status = r.status === null ? 'TIMEOUT/killed' : `exit ${r.status}`;
    summary.push(`${c} -> ${status}${r.contained ? '' : ` (${UNCONTAINED_NOTE})`}`);
    out += `$ ${c}\n(${status}, ${Math.round((Date.now() - t) / 1000)}s${lines.length > (cfg.evidenceTailLines || 120) ? `, last ${cfg.evidenceTailLines || 120} lines` : ''}${r.contained ? '' : `; ${UNCONTAINED_NOTE}`})\n${tail}\n\n`;
  }
  if (cmds.length && frozen) {
    const changed = [...new Set(before.concat(differsFromReviewed(frozen)))];
    labels.push(changed.length
      ? `The commands ran on the live project, which DIFFERED from the reviewed version (${changed.join(', ')}): this output may not match the code you review.`
      : 'The commands ran on the live project, which matched the reviewed version before and after them (not verified in between).');
  }
  if (opts['evidence-file']) {
    const lines = C.readArgFile(opts['evidence-file']).split(/\r?\n/);
    let at = 0; try { at = fs.statSync(path.resolve(opts['evidence-file'])).mtimeMs; } catch {}
    const newer = (frozen || []).filter(({ abs }) => { try { return fs.statSync(abs).mtimeMs > at; } catch { return false; } }).map(({ abs }) => abs);
    out += `(captured output: ${opts['evidence-file']})\n${lines.slice(-(cfg.evidenceTailLines || 120)).join('\n')}\n`;
    summary.push(`file ${opts['evidence-file']}`);
    labels.push(`The captured output was supplied by Claude: what it tested is unverified${newer.length ? `, and these reviewed files changed after it was written: ${newer.join(', ')}` : ''}.`);
  }
  if (summary.length) console.log(`[gpt.js] evidence: ${summary.join(' | ')}${labels.length ? `\n[gpt.js] ${labels.join('\n[gpt.js] ')}` : ''}`);
  return out ? `\nEVIDENCE (build/test/compile output — treat failures as facts, check whether the change caused them; weigh it by how it relates to the reviewed version):\n${labels.map(l => `- ${l}\n`).join('')}\`\`\`\n${out.trim()}\n\`\`\`\n` : '';
}

// MetaEditor's own MQL5|MQL4 folder (for `file`'s language): <library> includes the folder a source is in
// doesn't have come from here. A terminal's data folder is %APPDATA%\MetaQuotes\Terminal\<MD5 of its
// upper-cased install path as UTF-16LE>; a portable install keeps it in the install folder. null if neither.
function metaeditorRoot(metaeditorPath, file) {
  if (!metaeditorPath) return null;
  const name = /\.mq4$/i.test(file || '') ? 'MQL4' : 'MQL5', install = path.dirname(path.resolve(metaeditorPath));
  const id = crypto.createHash('md5').update(Buffer.from(install.toUpperCase(), 'utf16le')).digest('hex').toUpperCase();
  return [process.env.APPDATA && path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal', id, name), path.join(install, name)]
    .find(d => d && fs.existsSync(path.join(d, 'Include'))) || null;
}

// The source set an MQL4/5 file compiles from: the file, its #include files, followed recursively ("x.mqh"
// only next to the including file — MetaEditor searches nowhere else, measured; <x.mqh> in the Include
// folder of the MQL5|MQL4 folder the file is in, then of `libRoot`, MetaEditor's own), and the files the
// compiler embeds (#resource, #property icon: "\\x" from those MQL5|MQL4 folders, else next to the file).
// Returns { files, hash (one sha256 over every path + content), newest (latest change), missing, truncated
// (stopped at 2000 files: the fingerprint doesn't cover the rest), root (the enclosing MQL5|MQL4 folder, or
// null), libRoot, entries ([{ f, buf }]: exactly the content fingerprinted), links ([{ from, kind, name,
// raw, to }]: every directive, its name as written, and the file it resolved to, null if none; kind q "x",
// a <x>, r resource next to the file, rr "\\x") }.
// A source file's text (UTF-16 with its BOM, else UTF-8).
function sourceText(buf) { return (buf[0] === 0xff && buf[1] === 0xfe) ? buf.slice(2).toString('utf16le') : buf.toString('utf8'); }
// The #include, #resource and #property icon directives in source text, read like MetaEditor reads lines (a
// "\" at a line end continues the line; a UTF-8 BOM is not part of line 1): [{ type, quoted, raw }].
function directives(text) {
  text = text.replace(/^﻿/, '').replace(/\\\r?\n/g, ' ');
  const out = [];
  for (const [, q, a] of text.matchAll(/^[ \t]*#[ \t]*include[ \t]*(?:"([^"\r\n]+)"|<([^>\r\n]+)>)/gm)) out.push({ type: 'include', quoted: q !== undefined, raw: q || a });
  for (const [, r] of text.matchAll(/^[ \t]*#[ \t]*(?:resource|property[ \t]+icon)[ \t]*"([^"\r\n]+)"/gm)) out.push({ type: 'resource', quoted: true, raw: r });
  return out;
}

function mqlSources(main, libRoot = null, cap = 2000) {
  main = path.resolve(main);
  let up = path.dirname(main), root = null;
  for (; ;) { if (/^mql[45]$/i.test(path.basename(up))) { root = up; break; } const p = path.dirname(up); if (p === up) break; up = p; }
  const roots = [root, libRoot].filter(Boolean), incs = roots.map(r => path.join(r, 'Include'));
  const seen = new Map(), missing = [], links = [], queue = [[main, true]];
  while (queue.length && seen.size < cap) {
    const [f, source] = queue.shift();
    if (seen.has(f.toLowerCase())) continue;
    let buf; try { buf = fs.readFileSync(f); } catch { missing.push(f); continue; }
    seen.set(f.toLowerCase(), { f, buf, m: fs.statSync(f).mtimeMs });
    if (!source) continue; // an embedded file (image, sound, model): not parsed
    const dirs = directives(sourceText(buf));
    for (const { quoted: q, raw } of dirs.filter(d => d.type === 'include')) {
      const name = raw.replace(/[\\/]+/g, path.sep), here = path.resolve(path.dirname(f), name);
      const found = q ? (fs.existsSync(here) ? here : null) : incs.map(d => path.resolve(d, name)).find(p => fs.existsSync(p)) || null;
      links.push({ from: f, kind: q ? 'q' : 'a', name, raw, to: found });
      queue.push([found || (q || !incs.length ? here : path.resolve(incs[0], name)), true]);
    }
    for (const { raw: r } of dirs.filter(d => d.type === 'resource')) {
      const name = r.replace(/\\\\/g, '\\').replace(/[\\/]+/g, path.sep), rooted = /^[\\/]/.test(name);
      const found = rooted ? roots.map(d => path.join(d, name)).find(p => fs.existsSync(p)) : [path.resolve(path.dirname(f), name)].find(p => fs.existsSync(p));
      links.push({ from: f, kind: rooted ? 'rr' : 'r', name: rooted ? name.slice(1) : name, raw: r, to: found || null });
      const abs = found || (rooted ? roots[0] && path.join(roots[0], name) : path.resolve(path.dirname(f), name));
      if (abs) queue.push([abs, false]); else missing.push(r);
    }
  }
  const all = [...seen.values()].sort((x, y) => (x.f < y.f ? -1 : 1));
  const h = crypto.createHash('sha256');
  for (const x of all) h.update(x.f.toLowerCase()).update(x.buf);
  const newest = all.length ? new Date(Math.max(...all.map(x => x.m))).toISOString() : 'n/a';
  return { files: all.length, hash: h.digest('hex').slice(0, 12), newest, missing, truncated: queue.length > 0, root, libRoot, entries: all.map(({ f, buf }) => ({ f, buf })), links };
}

// A private copy of a source set (mqlSources) to compile, so MetaEditor's output (.ex5, log) never lands in
// the project, where a running tester or a compile receipt may be using it. The copy is self-contained, for
// `/include:<includeRoot>`: an MQL5|MQL4 folder holding the project's files in their layout (quoted includes
// and resources resolve as in place) and the library files it uses from MetaEditor's own folder. (Without
// /include, MetaEditor picks up the Include folder of an MQL5 folder a file is in only on some paths — it
// depends on the path's length — so a copy can't rely on that.) The project's files: the enclosing MQL5|MQL4
// folder's layout when there is one, else under <copy>/MQL5/Experts/<project folder>. Returns { dir (remove
// it afterwards), main (the copy of `main`), includeRoot (null: no MQL5 folder known, MetaEditor's default),
// paths ([copy, original] pairs, files and folders), copyOf (original -> copy), conflicts } or { error }
// (two files would share a place: nothing written). `conflicts`: directives that would find a different file
// in the copy than in the project, read without the preprocessor ([{ link, what, got, probe }]); `probe`:
// missing in the project but supplied by the merged copy — harmless only if MetaEditor never opens it
// (an inactive #ifdef branch, a comment), which mqlProbe can show.
function mqlCopy(src, main) {
  main = path.resolve(main);
  const inside = (d, f) => { const r = path.relative(d, f); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
  const same = (a, b) => !!a && !!b && path.relative(a, b) === '';
  const lib = src.libRoot && !same(src.libRoot, src.root) ? src.libRoot : null;
  const isLib = e => !!lib && inside(lib, e.f) && !(src.root && inside(src.root, e.f));
  const project = src.entries.filter(e => !isLib(e));
  let base = src.root || path.dirname(main);
  while (!project.every(e => inside(base, e.f))) {
    const p = path.dirname(base);
    if (p === base) return { error: 'the source files are on different drives' };
    base = p;
  }
  const dir = path.join(os.tmpdir(), `gpt-compile-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const kind = /\.mq4$/i.test(main) ? 'MQL4' : 'MQL5', name = path.basename(base) || 'src';
  let mirror, includeRoot = null;
  if (src.root) { mirror = path.join(dir, name); includeRoot = path.join(mirror, path.relative(base, src.root)); }
  else if (lib) { includeRoot = path.join(dir, kind); mirror = path.join(includeRoot, 'Experts', name); }
  else mirror = path.join(dir, name);
  // where each file goes
  const copyOf = new Map(), placed = new Map();
  for (const e of src.entries) {
    const to = isLib(e) ? path.join(includeRoot, path.relative(lib, e.f)) : path.join(mirror, path.relative(base, e.f));
    if (placed.has(to.toLowerCase())) return { error: `${e.f} and ${placed.get(to.toLowerCase())} would share one place in the copy` };
    placed.set(to.toLowerCase(), e.f); copyOf.set(e.f.toLowerCase(), to);
  }
  // every directive should find the same file in the copy (MetaEditor's search: "x" next to the including
  // file only, <x> and "\\x" in the copy's include folder, which stands for both MQL5 folders; MetaEditor's
  // default folder isn't in the copy)
  const conflicts = [];
  for (const l of src.links || []) {
    if (!includeRoot && (l.kind === 'a' || l.kind === 'rr')) continue;
    const from = copyOf.get(l.from.toLowerCase());
    const cand = l.kind === 'q' || l.kind === 'r' ? path.join(path.dirname(from), l.name) : path.join(includeRoot, ...(l.kind === 'a' ? ['Include'] : []), l.name);
    const got = placed.has(cand.toLowerCase()) ? cand : null, want = l.to ? copyOf.get(l.to.toLowerCase()) || null : null;
    if ((got || '').toLowerCase() === (want || '').toLowerCase()) continue;
    const what = `${l.kind === 'q' ? `#include "${l.raw}"` : l.kind === 'a' ? `#include <${l.raw}>` : `#resource "${l.raw}"`} in ${l.from}`;
    conflicts.push({ link: l, what, got: got && placed.get(got.toLowerCase()), probe: !!got && !want });
  }
  const paths = [[mirror, base]].concat(includeRoot && lib ? [[includeRoot, src.root ? src.root : lib]] : []);
  try {
    for (const e of src.entries) {
      const to = copyOf.get(e.f.toLowerCase());
      paths.push([to, e.f]);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, e.buf);
    }
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); return { error: `could not copy the sources (${e.message})` }; }
  return { dir, main: copyOf.get(main.toLowerCase()), includeRoot, paths, copyOf, conflicts };
}

// Prepares a written copy (mqlCopy) to show that its `probe` conflicts are never opened. In the copy of each
// file that holds one, that directive's name is replaced by one that exists nowhere, with every other byte
// kept: UTF-16 is re-encoded as UTF-16, anything else is edited byte for byte. If the probe then compiles
// cleanly, MetaEditor skipped them; a directive it does open fails with "not found". Every edited file is
// read again with the same scanner (`directives`) before anything is written: a directive still naming a
// conflict's file means it wasn't marked. Returns { marks ([{ mark, conflict }]), restore() (puts the copied
// files back) } or { error } (a directive that couldn't be marked: nothing is changed).
function mqlProbe(copy, src) {
  const tag = `__gpt_probe_${crypto.randomBytes(4).toString('hex')}`, edits = new Map(), marks = [], done = new Set();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sp = '[ \\t]*(?:\\\\\\r?\\n[ \\t]*)*', gap = '(?:[ \\t]|\\\\\\r?\\n)+'; // blanks and "\" line continuations
  const typeOf = l => (l.kind === 'q' || l.kind === 'a' ? 'include' : 'resource'), keyOf = (type, quoted, raw) => `${type}|${quoted}|${raw}`;
  for (const c of copy.conflicts.filter(x => x.probe)) {
    const l = c.link, to = copy.copyOf.get(l.from.toLowerCase()), key = keyOf(typeOf(l), l.kind !== 'a', l.raw);
    let ed = edits.get(to);
    if (!ed) {
      const orig = src.entries.find(e => e.f.toLowerCase() === l.from.toLowerCase()).buf, utf16 = orig[0] === 0xff && orig[1] === 0xfe;
      edits.set(to, ed = { orig, utf16, text: utf16 ? orig.slice(2).toString('utf16le') : orig.toString('latin1'), keys: new Set(), what: new Map() });
    }
    if (done.has(`${to.toLowerCase()}|${key}`)) continue; // (one replacement marks every directive in that file naming it)
    done.add(`${to.toLowerCase()}|${key}`);
    const mark = `${tag}_${marks.length}${typeOf(l) === 'include' ? '.mqh' : '.bin'}`;
    const raw = ed.utf16 ? l.raw : Buffer.from(l.raw, 'utf8').toString('latin1');
    const [open, close] = l.kind === 'a' ? ['<', '>'] : ['"', '"'];
    const re = new RegExp(`(#${sp}${typeOf(l) === 'include' ? 'include' : `(?:resource|property${gap}icon)`}${sp}${open})${esc(raw)}(${close})`, 'g');
    let n = 0;
    ed.text = ed.text.replace(re, (m, a, b) => { n++; return a + mark + b; });
    if (!n) return { error: `${c.what} could not be marked for a probe compile` };
    ed.keys.add(key); ed.what.set(key, c.what);
    marks.push({ mark, conflict: c });
  }
  const encoded = new Map();
  for (const [to, ed] of edits) {
    const buf = ed.utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ed.text, 'utf16le')]) : Buffer.from(ed.text, 'latin1');
    const left = directives(sourceText(buf)).find(d => ed.keys.has(keyOf(d.type, d.quoted, d.raw)));
    if (left) return { error: `${ed.what.get(keyOf(left.type, left.quoted, left.raw))} could not be marked for a probe compile` };
    encoded.set(to, buf);
  }
  for (const [to, buf] of encoded) fs.writeFileSync(to, buf);
  return { marks, restore() { for (const [to, ed] of edits) fs.writeFileSync(to, ed.orig); } };
}

// Copies left behind by a compile that was killed (a compile is stopped after 5 minutes): removed once
// they are an hour old. (Real folders only: a link is never followed.)
function sweepCopies(maxAgeMs = 3600000) {
  let names = []; try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const n of names) {
    if (!n.startsWith('gpt-compile-')) continue;
    const p = path.join(os.tmpdir(), n);
    try { const st = fs.lstatSync(p); if (st.isDirectory() && Date.now() - st.mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

// `text` with the copy's paths (mqlCopy) replaced by the project's.
function fromCopy(text, copy) {
  const pairs = copy.paths.slice().sort((a, b) => b[0].length - a[0].length), to = new Map(pairs.map(([c, o]) => [c.toLowerCase(), o]));
  const re = new RegExp(pairs.map(([c]) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return pairs.length ? text.replace(re, m => to.get(m.toLowerCase())) : text;
}

module.exports = { JOB_RUNNER, CONTAINMENT_WARNING, UNCONTAINED_NOTE, runTracked, evidence, metaeditorRoot, directives, mqlSources, mqlCopy, mqlProbe, fromCopy, sweepCopies };
