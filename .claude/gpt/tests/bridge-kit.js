// Test access to the bridge modules (../bridge): the modules themselves, their shared context (point it at
// a test project with `at(root)`), and their source text (for checks on how the code is written).
const fs = require('fs'), path = require('path');
const B = path.join(__dirname, '..', 'bridge');
const C = require(path.join(B, 'ctx.js'));
const L = require(path.join(__dirname, '..', 'lib.js'));
// A config for code that needs one (tests normally load the profile's config).
C.set({ cfg: L.loadConfig(false), opts: {}, positional: [], ps: {} });
module.exports = {
  C, L,
  codex: require(path.join(B, 'codex.js')),
  evidence: require(path.join(B, 'evidence.js')),
  review: require(path.join(B, 'review.js')),
  write: require(path.join(B, 'write.js')),
  // all of the bridge's source, gpt.js included
  src: [path.join(__dirname, '..', 'gpt.js'), ...fs.readdirSync(B).filter(n => n.endsWith('.js')).map(n => path.join(B, n))]
    .map(f => fs.readFileSync(f, 'utf8')).join('\n'),
  at(root, extra) { C.set({ root, ...extra }); return module.exports; },
};
