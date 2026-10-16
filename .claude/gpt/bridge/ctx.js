// The bridge's run context: what one gpt.js command works with (its arguments, config, project root and
// project switches). gpt.js fills it from the command line (init); tests set what they need (set). Modules
// read it when they run (C.root, C.cfg, ...) and call its helpers through it (C.die, C.effortFor, ...), so
// a test can point everything at its own project or replace a helper.
const fs = require('fs');
const path = require('path');
const L = require('../lib');

const C = module.exports = { cmd: undefined, opts: {}, positional: [], cfg: null, root: null, ps: {} };

C.set = o => Object.assign(C, o);

C.init = argv => {
  const opts = {}, positional = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      opts[k] = v;
    } else positional.push(argv[i]);
  }
  const cfg = L.loadConfig();
  // Hooks pass --project <session cwd> explicitly; without it, infer from the current directory.
  // Explicit --project wins; otherwise the calling Claude session's project; otherwise infer from cwd.
  const root = opts.project ? path.resolve(opts.project)
    : L.knownSessionRoot(process.env.CLAUDE_CODE_SESSION_ID) || L.findRoot(process.cwd());
  return C.set({ cmd: argv[0], opts, positional, cfg, root, ps: L.projectSettings(root) });
};

C.die = (msg, code = 2) => { console.error(msg); process.exit(code); };

// The paths of a --files list. Absolute paths are taken as given. A relative path is looked up from the
// project root and from the current folder (Claude's shell is often in a subfolder): whichever exists wins,
// the call stops if both exist and differ, and a path found in neither (a deleted or new file) is taken
// from the project root. mustExist: stop on a path that doesn't exist, before anything is sent to GPT.
C.files = (value = C.opts.files, mustExist = false) => {
  if (!value || value === true) return [];
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const out = String(value).split(',').map(f => f.trim()).filter(Boolean).map(f => {
    if (path.isAbsolute(f)) return path.resolve(f);
    const fromRoot = path.resolve(C.root, f), fromCwd = path.resolve(f);
    const inRoot = fs.existsSync(fromRoot), inCwd = fs.existsSync(fromCwd);
    if (inRoot && inCwd && !same(fromRoot, fromCwd)) C.die(`--files: "${f}" matches both ${fromRoot} and ${fromCwd}; pass the full path.`);
    return inCwd && !inRoot ? fromCwd : fromRoot;
  });
  const missing = mustExist ? out.filter(f => !fs.existsSync(f)) : [];
  if (missing.length) C.die(`--files: not found: ${missing.join(', ')} (relative paths are looked up from ${C.root} and the current folder). Nothing was sent to GPT.`);
  return out;
};
C.readArgFile = f => (f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8'));
C.stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

// A project's fixed effort (.claude/gpt.json) wins over Claude's per-call choice. Anything not in
// config.allowedEfforts (e.g. "xhigh" when the user limited GPT to "high") falls back to the default.
C.effortFor = () => {
  const e = C.ps.effort && C.ps.effort !== 'auto' ? C.ps.effort : C.opts.effort || C.cfg.defaultEffort;
  return C.cfg.allowedEfforts.includes(e) ? e : C.cfg.defaultEffort;
};

C.logDir = () => {
  const d = path.join(L.LOG_DIR, L.slug(C.root));
  fs.mkdirSync(d, { recursive: true });
  return d;
};
