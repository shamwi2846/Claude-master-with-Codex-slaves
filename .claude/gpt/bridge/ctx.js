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
