// Restores the Claude + GPT setup into %USERPROFILE%\.claude
// Usage:  node restore.js [--force]
// Everything is validated before anything is changed (including the RELEASE.txt file hashes). Existing files are backed up to a unique
// folder in ~/.claude/backups/ first. GPT hook handlers are MERGED into your current settings.json
// (all other settings and hooks are kept), not overwritten.
const fs = require('fs');
const path = require('path');
const os = require('os');

// A release interrupted between its two folder renames leaves only .claude.prev (the previous complete
// release, with its own manifest): restore from that.
const src = !fs.existsSync(path.join(__dirname, '.claude')) && fs.existsSync(path.join(__dirname, '.claude.prev'))
  ? path.join(__dirname, '.claude.prev') : path.join(__dirname, '.claude');
if (src.endsWith('.prev')) console.log('note: .claude is missing (an interrupted release) — restoring the previous release from .claude.prev');
const dst = path.join(os.homedir(), '.claude');
// The .js files of a backup folder ([] when the backup has none, e.g. one made before that folder existed).
const scripts = dir => { try { return fs.readdirSync(path.join(src, dir)).filter(n => n.endsWith('.js')).map(n => `${dir}/${n}`); } catch { return []; } };
// Written in this order: the bridge modules (gpt/bridge) and lib.js before gpt.js and gate.js, which need
// them — a restore that stops midway never leaves a gpt.js without its modules. Then the regression checks
// and release script (gpt/tests), when the backup has them.
// Every agent file the release packed (release.js takes the whole agents folder).
const agents = (() => { try { return fs.readdirSync(path.join(src, 'agents')).filter(n => fs.statSync(path.join(src, 'agents', n)).isFile()).map(n => `agents/${n}`); } catch { return []; } })();
const files = ['CLAUDE.md', ...agents, 'gpt/config.json', ...scripts('gpt/bridge'), 'gpt/lib.js', 'gpt/gpt.js', 'gpt/gate.js', 'gpt/REFERENCE.md']
  .concat(scripts('gpt/tests'));

function fail(msg) { console.error('Restore aborted, nothing was changed: ' + msg); process.exit(1); }
function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { fail(`cannot parse ${f}: ${e.message}`); }
}

// 1. Validate all inputs and build the merged settings before touching anything.
// The release manifest (.claude/RELEASE.txt; at the folder root in older backups).
let manifestText = '';
for (const m of [path.join(src, 'RELEASE.txt'), path.join(__dirname, 'RELEASE.txt')]) { try { manifestText = fs.readFileSync(m, 'utf8'); break; } catch {} }
// Paths of the .claude folder the backup was released from (its "Source:" line; backups made before that
// line existed came from C:/Users/Shari) are pointed at this user's .claude.
const ORIG_CLAUDE = ((manifestText.match(/^Source: (.+)$/m) || [])[1] || 'C:/Users/Shari/.claude').trim().replace(/\\/g, '/');
const HERE_CLAUDE = dst.replace(/\\/g, '/');
// Our hook = a command whose script argument IS this setup's gate.js (original or this user's path), however
// the path is written (quotes, forward/back slashes, any casing); other tools' hooks are left alone.
const OWN_GATES = [ORIG_CLAUDE, HERE_CLAUDE].map(d => (d + '/gpt/gate.js').toLowerCase());
const isGpt = h => {
  if (typeof (h && h.command) !== 'string') return false;
  const args = [...h.command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => (m[1] ?? m[2] ?? m[3]).replace(/\\+/g, '/').toLowerCase());
  return args.some(a => OWN_GATES.includes(a));
};
const relocate = text => ORIG_CLAUDE === HERE_CLAUDE ? text
  : text.split(ORIG_CLAUDE).join(HERE_CLAUDE).split(ORIG_CLAUDE.replace(/\//g, '\\')).join(dst);
const sources = {};
for (const rel of files) {
  try { sources[rel] = fs.readFileSync(path.join(src, rel)); } catch (e) { fail(`cannot read source ${rel}: ${e.message}`); }
}
// The backup must be exactly what release.js released: .claude/RELEASE.txt lists the hash of every released
// file (and of restore.js, README.md, AGENT-SETUP.md). A missing manifest, a file that differs, or a file
// restore would copy that the manifest doesn't list stops the restore — unless --force.
{
  const listed = new Map([...manifestText.matchAll(/^([0-9a-f]{16})  (.+)$/gm)].map(([, h, p]) => [p.trim(), h]));
  const hash = b => require('crypto').createHash('sha256').update(b).digest('hex').slice(0, 16);
  const problems = [];
  if (!listed.size) problems.push('no RELEASE.txt manifest (make backups with release.js)');
  else {
    for (const rel of [...files, 'settings.json']) {
      const h = listed.get(`.claude/${rel}`);
      let now; try { now = hash(sources[rel] || fs.readFileSync(path.join(src, rel))); } catch { now = 'missing'; }
      if (!h) problems.push(`.claude/${rel} not in the release`); else if (h !== now) problems.push(`.claude/${rel} differs from the release`);
    }
    // Every released file must still be there, unchanged (e.g. a deleted test script would silently shrink
    // the restored regression checks).
    const checked = new Set([...files, 'settings.json'].map(rel => `.claude/${rel}`));
    const fromPrev = src.endsWith('.prev');
    for (const [p, h] of listed) {
      if (checked.has(p)) continue;
      // The previous release's manifest also lists the restore.js/README of ITS day; those in this folder
      // belong to the newer release, so only the release payload itself is verified then.
      if (fromPrev && !p.startsWith('.claude/')) continue;
      const file = p.startsWith('.claude/') ? path.join(src, p.slice('.claude/'.length)) : path.join(__dirname, p);
      let now; try { now = hash(fs.readFileSync(file)); } catch { now = 'missing'; }
      if (now === 'missing') problems.push(`${p} is missing`); else if (h !== now) problems.push(`${p} differs from the release`);
    }
  }
  if (problems.length && !process.argv.includes('--force')) fail(`the backup is not exactly a release: ${problems.join('; ')}. Release again on the source PC, or run with --force.`);
  if (problems.length) console.log(`warning (--force): ${problems.join('; ')}`);
}
for (const doc of ['CLAUDE.md', 'gpt/REFERENCE.md']) sources[doc] = Buffer.from(relocate(sources[doc].toString('utf8')));
// The bridge config must be valid before it replaces a working one — checked by the same rules the bridge
// uses at runtime (validateConfig in the backup's lib.js).
let conf, validateConfig;
try { ({ validateConfig } = require(path.join(src, 'gpt', 'lib.js'))); } catch (e) { fail(`cannot load the backup's gpt/lib.js: ${e.message}`); }
try { conf = JSON.parse(sources['gpt/config.json'].toString('utf8')); } catch (e) { fail(`backup gpt/config.json is not valid JSON: ${e.message}`); }
const bad = validateConfig(conf);
if (bad.length) fail(`backup gpt/config.json is missing or has invalid: ${bad.map(([k, need]) => `${k} (must be ${need})`).join(', ')}`);
const settingsPath = path.join(dst, 'settings.json');
// Parse first, then relocate each decoded hook command (raw JSON would hide paths as escaped "\\").
const saved = readJson(path.join(src, 'settings.json'));
for (const groups of Object.values(saved.hooks || {})) {
  for (const g of groups) for (const h of g.hooks || []) if (typeof h.command === 'string') h.command = relocate(h.command);
}
const liveRaw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
const live = liveRaw === null ? {} : readJson(settingsPath);

live.hooks = live.hooks || {};
for (const [event, savedGroups] of Object.entries(saved.hooks || {})) {
  // Remove only GPT handlers from live groups; keep everything else (and drop groups left empty).
  const kept = (live.hooks[event] || [])
    .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isGpt(h)) }))
    .filter(g => g.hooks.length);
  // Import only the GPT handlers from the saved groups.
  const ours = savedGroups
    .map(g => ({ ...g, hooks: (g.hooks || []).filter(isGpt) }))
    .filter(g => g.hooks.length);
  live.hooks[event] = kept.concat(ours);
}
const mergedText = JSON.stringify(live, null, 2);

// 2. Back up existing files into a unique folder.
fs.mkdirSync(path.join(dst, 'backups'), { recursive: true });
const backupDir = fs.mkdtempSync(path.join(dst, 'backups', 'before-restore-' + new Date().toISOString().slice(0, 10) + '-'));
const created = [];
for (const rel of [...files, 'settings.json']) {
  const target = path.join(dst, rel);
  if (fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(path.join(backupDir, rel)), { recursive: true });
    fs.copyFileSync(target, path.join(backupDir, rel), fs.constants.COPYFILE_EXCL);
  } else created.push(target);
}
// For undo: files this restore creates that did not exist before (delete these to roll back fully).
fs.writeFileSync(path.join(backupDir, 'new-files.txt'), created.join('\n') + (created.length ? '\n' : ''));

// 3. Write each file via a unique temp file + rename so a failure never leaves a half-written file.
function atomicWrite(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.restore-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data, { flag: 'wx' });
  fs.renameSync(tmp, target);
}
try {
  for (const rel of files) {
    atomicWrite(path.join(dst, rel), sources[rel]);
    console.log('restored', rel);
  }
  const nowRaw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
  if (nowRaw !== liveRaw) throw new Error('settings.json was changed by another program during restore; settings not modified, run restore again');
  atomicWrite(settingsPath, mergedText);
  console.log('merged GPT hooks into settings.json');
} catch (e) {
  console.error(`Restore failed midway (${e.message}). Your previous files are in: ${backupDir}`);
  process.exit(1);
}
console.log('previous files backed up to', backupDir);
console.log('Start a new Claude session for the hooks to take effect.');
