// Build/test/compile output for reviews: commands run inside a Windows Job Object (the whole process tree
// is stopped at a timeout), captured output, and the MQL source fingerprint used by mql5-compile.
const fs = require('fs');
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

// The source set an MQL4/5 file compiles from: the file plus its #include files, followed recursively
// ("x.mqh" next to the including file, then <x.mqh> in the terminal's MQL5|MQL4/Include folder).
// Returns { files, hash (one sha256 over every path + content), newest (latest change), missing,
// truncated (stopped at 500 files: the fingerprint doesn't cover the rest) }.
function mqlSources(main) {
  let up = path.dirname(main), inc = null;
  for (; ;) { if (/^mql[45]$/i.test(path.basename(up))) { inc = path.join(up, 'Include'); break; } const p = path.dirname(up); if (p === up) break; up = p; }
  const seen = new Map(), missing = [], queue = [path.resolve(main)];
  while (queue.length && seen.size < 500) {
    const f = queue.shift();
    if (seen.has(f.toLowerCase())) continue;
    let buf; try { buf = fs.readFileSync(f); } catch { missing.push(f); continue; }
    seen.set(f.toLowerCase(), { f, buf, m: fs.statSync(f).mtimeMs });
    const text = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.slice(2).toString('utf16le') : buf.toString('utf8');
    for (const [, q, a] of text.matchAll(/^\s*#include\s+(?:"([^"]+)"|<([^>]+)>)/gm)) {
      const name = (q || a).replace(/[\\/]+/g, path.sep);
      const local = path.resolve(path.dirname(f), name), lib = inc && path.resolve(inc, name);
      queue.push(q && fs.existsSync(local) ? local : lib && fs.existsSync(lib) ? lib : q ? local : (lib || local));
    }
  }
  const all = [...seen.values()].sort((x, y) => (x.f < y.f ? -1 : 1));
  const h = require('crypto').createHash('sha256');
  for (const x of all) h.update(x.f.toLowerCase()).update(x.buf);
  const newest = all.length ? new Date(Math.max(...all.map(x => x.m))).toISOString() : 'n/a';
  return { files: all.length, hash: h.digest('hex').slice(0, 12), newest, missing, truncated: queue.length > 0 };
}

module.exports = { JOB_RUNNER, CONTAINMENT_WARNING, UNCONTAINED_NOTE, runTracked, evidence, mqlSources };
