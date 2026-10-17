// The files that make up this setup, and consistent copies of them, for run.js (every suite tests a frozen
// copy), release.js (the release candidate) and prove.js (old and new versions side by side).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const hashOf = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

// Every setup file, relative to the .claude folder (forward slashes). Folder membership is read again on every
// call, so a file added or removed meanwhile is seen. (Same set restore.js restores, plus settings.json.)
// A setup folder that doesn't exist has no files; one that exists but can't be listed (or an entry that can't be
// examined) is an error, never an empty list — a copy would otherwise silently lack its files.
function listSetup(claudeDir) {
  const ls = (rel, re) => {
    let names;
    try { names = fs.readdirSync(path.join(claudeDir, rel)); } catch (e) { if (e.code === 'ENOENT') return []; throw new Error(`cannot list ${rel} in ${claudeDir} (${e.code || e.message})`); }
    return names.filter(n => re.test(n) && fs.statSync(path.join(claudeDir, rel, n)).isFile()).map(n => `${rel}/${n}`);
  };
  return ['CLAUDE.md', 'settings.json', 'gpt/config.json', 'gpt/gpt.js', 'gpt/gate.js', 'gpt/lib.js', 'gpt/REFERENCE.md']
    .concat(ls('gpt/bridge', /\.js$/), ls('agents', /./), ls('gpt/tests', /\.js$/)).sort();
}
// A backup folder's published files: its .claude folder (everything in it) and the three root files.
function listBackup(dir) {
  const out = [];
  (function walk(rel) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, rel)); } catch (e) { if (e.code === 'ENOENT') return; throw new Error(`cannot list ${rel} in ${dir} (${e.code || e.message})`); }
    for (const n of names) {
      const r = `${rel}/${n}`, st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) walk(r); else if (st.isFile()) out.push(r);
    }
  })('.claude');
  return out.concat(['restore.js', 'README.md', 'AGENT-SETUP.md'].filter(f => fs.existsSync(path.join(dir, f)))).sort();
}
// The tools that run the checks (not checks themselves): prove.js keeps one fixed copy of them.
const isTool = rel => /^gpt\/tests\/(run|release|setup-files|prove)\.js$/.test(rel);
const isProduction = rel => /^gpt\/(gpt|gate|lib)\.js$|^gpt\/config\.json$|^gpt\/bridge\/[^/]+\.js$/.test(rel);

// [rel, hash] for each listed file that exists (sorted by rel). A file that exists but can't be read is an error
// (it would otherwise vanish from a copy unnoticed): its hash is "unreadable: <code>", which never matches a copy.
function inventory(root, rels) {
  const out = [];
  for (const r of [...rels].sort()) {
    try { out.push([r, hashOf(fs.readFileSync(path.join(root, r)))]); }
    catch (e) { if (e.code !== 'ENOENT') out.push([r, `unreadable: ${e.code || e.message}`]); }
  }
  return out;
}
const keyOf = inv => inv.map(([r, h]) => `${r}\t${h}`).join('\n');

// Copies the files `list(src)` names from `src` to `dest` (replacing dest) so that the copy agrees with the
// source: the source is inventoried (paths re-discovered, contents hashed) before and after copying and the
// copy is hashed too; all three must be equal, else it tries again (3 times), then throws.
// What this guarantees: the copy matches the source as inventoried just before and just after the copy — every
// change that persists across the copy, and any change that reaches the copied bytes, is caught. (Reading many
// files is not atomic, so a change made and undone between those reads that never reaches the copy isn't seen.)
// GPT_TEST_CAPTURE_HOOK (tests only): a script run between copying and re-checking, as <hook> <src> <dest> <try>.
function capture(src, dest, list, tries = 3) {
  let lastBad = [];
  for (let attempt = 1; attempt <= tries; attempt++) {
    const before = inventory(src, list(src));
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
    for (const [r] of before) {
      fs.mkdirSync(path.dirname(path.join(dest, r)), { recursive: true });
      try { fs.copyFileSync(path.join(src, r), path.join(dest, r)); } catch {} // (gone meanwhile: the check below fails)
    }
    if (process.env.GPT_TEST_CAPTURE_HOOK) spawnSync(process.execPath, [process.env.GPT_TEST_CAPTURE_HOOK, src, dest, String(attempt)], { stdio: 'ignore' });
    const copied = inventory(dest, before.map(([r]) => r)), after = inventory(src, list(src));
    if (keyOf(before) === keyOf(copied) && keyOf(before) === keyOf(after)) return { files: before, hash: hashOf(keyOf(before)) };
    lastBad = before.filter(([, h]) => h.startsWith('unreadable')).map(([r, h]) => `${r} (${h.replace(/^unreadable: /, '')})`);
  }
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
  throw new Error(lastBad.length ? `${src}: cannot read ${lastBad.join(', ')}` : `${src} kept changing while it was copied (${tries} tries)`);
}

module.exports = { hashOf, listSetup, listBackup, isTool, isProduction, inventory, keyOf, capture };
