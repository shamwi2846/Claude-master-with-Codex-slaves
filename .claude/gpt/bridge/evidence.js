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

async function evidence() {
  const { opts, cfg } = C;
  // During a usage-limit cooldown the GPT call will be refused anyway: don't run builds/tests for nothing.
  if ((L.readState(L.HOME).limitUntil || 0) > Date.now() && !opts['force-gpt']) return '';
  let out = '';
  const summary = [];
  for (const c of String(opts.evidence || '').split(';;').map(s => s.trim()).filter(Boolean)) {
    const t = Date.now();
    const r = await runTracked(c, (cfg.evidenceTimeoutMinutes || 10) * 60000);
    const lines = r.out.split(/\r?\n/);
    const tail = lines.slice(-(cfg.evidenceTailLines || 120)).join('\n');
    const status = r.status === null ? 'TIMEOUT/killed' : `exit ${r.status}`;
    summary.push(`${c} -> ${status}${r.contained ? '' : ` (${UNCONTAINED_NOTE})`}`);
    out += `$ ${c}\n(${status}, ${Math.round((Date.now() - t) / 1000)}s${lines.length > (cfg.evidenceTailLines || 120) ? `, last ${cfg.evidenceTailLines || 120} lines` : ''}${r.contained ? '' : `; ${UNCONTAINED_NOTE}`})\n${tail}\n\n`;
  }
  if (opts['evidence-file']) {
    const lines = C.readArgFile(opts['evidence-file']).split(/\r?\n/);
    out += `(captured output: ${opts['evidence-file']})\n${lines.slice(-(cfg.evidenceTailLines || 120)).join('\n')}\n`;
    summary.push(`file ${opts['evidence-file']}`);
  }
  if (summary.length) console.log(`[gpt.js] evidence: ${summary.join(' | ')}`);
  return out ? `\nEVIDENCE (build/test/compile output — treat failures as facts, check whether the change caused them):\n\`\`\`\n${out.trim()}\n\`\`\`\n` : '';
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

// The source set an MQL4/5 file compiles from: the file, its #include files, followed recursively
// ("x.mqh" next to the including file or the main file, then <x.mqh> in the Include folder of the MQL5|MQL4
// folder the file is in, then of `libRoot`, MetaEditor's own), and the files the compiler embeds (#resource,
// #property icon: "\\x" from those MQL5|MQL4 folders, else next to the file). Returns { files, hash (one
// sha256 over every path + content), newest (latest change), missing, truncated (stopped at 2000 files: the
// fingerprint doesn't cover the rest), root (the enclosing MQL5|MQL4 folder, or null), libRoot, entries
// ([{ f, buf }]: exactly the content fingerprinted), links ([{ from, kind, name, to }]: every directive and
// the file it resolved to, null if none; kind q "x", a <x>, r resource next to the file, rr "\\x") }.
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
    // (a directive continued with "\" at the end of the line is one line; a UTF-8 BOM is not part of line 1)
    const text = ((buf[0] === 0xff && buf[1] === 0xfe) ? buf.slice(2).toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '').replace(/\\\r?\n/g, ' ');
    for (const [, q, a] of text.matchAll(/^[ \t]*#[ \t]*include[ \t]*(?:"([^"\r\n]+)"|<([^>\r\n]+)>)/gm)) {
      const name = (q || a).replace(/[\\/]+/g, path.sep), here = path.resolve(path.dirname(f), name);
      const local = q && [here, path.resolve(path.dirname(main), name)].find(p => fs.existsSync(p));
      const lib = incs.map(d => path.resolve(d, name)).find(p => fs.existsSync(p));
      links.push({ from: f, kind: q ? 'q' : 'a', name, to: local || lib || null });
      queue.push([local || lib || (q || !incs.length ? here : path.resolve(incs[0], name)), true]);
    }
    for (const [, r] of text.matchAll(/^[ \t]*#[ \t]*(?:resource|property[ \t]+icon)[ \t]*"([^"\r\n]+)"/gm)) {
      const name = r.replace(/\\\\/g, '\\').replace(/[\\/]+/g, path.sep), rooted = /^[\\/]/.test(name);
      const found = rooted ? roots.map(d => path.join(d, name)).find(p => fs.existsSync(p)) : [path.resolve(path.dirname(f), name)].find(p => fs.existsSync(p));
      links.push({ from: f, kind: rooted ? 'rr' : 'r', name: rooted ? name.slice(1) : name, to: found || null });
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
// paths ([copy, original] pairs, files and folders) } or { error }. Refused (nothing written) when two files
// would share a place, or when any #include/#resource would find a different file in the copy than in the
// project (e.g. a quoted include that is missing in the project but present in the merged copy).
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
  const mainCopy = copyOf.get(main.toLowerCase());
  // every directive must find the same file in the copy (the same search order as mqlSources, with the
  // copy's include folder standing for both MQL5 folders); MetaEditor's default folder isn't in the copy
  for (const l of src.links || []) {
    if (!includeRoot && (l.kind === 'a' || l.kind === 'rr')) continue;
    const from = copyOf.get(l.from.toLowerCase()), inc = includeRoot && path.join(includeRoot, 'Include', l.name);
    const cands = l.kind === 'q' ? [path.join(path.dirname(from), l.name), path.join(path.dirname(mainCopy), l.name), inc]
      : l.kind === 'a' ? [inc] : l.kind === 'r' ? [path.join(path.dirname(from), l.name)] : [path.join(includeRoot, l.name)];
    const got = cands.find(c => c && placed.has(c.toLowerCase())) || null, want = l.to ? copyOf.get(l.to.toLowerCase()) || null : null;
    if ((got || '').toLowerCase() !== (want || '').toLowerCase()) {
      const what = `${l.kind === 'q' ? `#include "${l.name}"` : l.kind === 'a' ? `#include <${l.name}>` : `#resource "${l.name}"`} in ${l.from}`;
      // (directives are read without the preprocessor: one in an inactive #ifdef branch counts too)
      return { error: `in the copy, ${what} would find ${got ? placed.get(got.toLowerCase()) : 'nothing'} instead of ${l.to || 'nothing'} (even if it sits in an inactive #ifdef branch)` };
    }
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
  return { dir, main: mainCopy, includeRoot, paths };
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

module.exports = { JOB_RUNNER, CONTAINMENT_WARNING, UNCONTAINED_NOTE, runTracked, evidence, metaeditorRoot, mqlSources, mqlCopy, fromCopy, sweepCopies };
