// Read-only GPT runs: Codex features that reach outside the sandbox (app connectors, plugins, sub-agents,
// image generation, web except for research) are off; runs on MQL5 code get only the offline MQL5 reference
// (mql5-chm) with its five read-only tools, read strictly from the Codex config and proven by a handshake.
require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const K = require('./bridge-kit'), L = K.L, X = K.codex;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const W = path.join(os.homedir(), 'gpt-r28-test');
fs.rmSync(W, { recursive: true, force: true }); fs.mkdirSync(W, { recursive: true });
const put = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); return p; };
const TOOLS = L.DOCS_TOOLS;

// A fake docs server (MCP over stdio): offers the tools named in its first argument, counts its starts;
// second argument: "notready" (status reports an error) or "die" (exits after listing its tools).
const COUNT = path.join(W, 'starts.txt');
const FAKE = put(path.join(W, 'fake docs', 'server.mjs'),
  `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(COUNT)}, 'x');\n` +
  `const tools = (process.argv[2] || ${JSON.stringify(TOOLS.join(','))}).split(','), mode = process.argv[3] || '';\nlet buf = '';\n` +
  `const say = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');\n` +
  `process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l);\n` +
  `  if (m.id === 1) say({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });\n` +
  `  if (m.id === 2) { say({ id: 2, result: { tools: tools.map(name => ({ name, inputSchema: { type: 'object' } })) } }); if (mode === 'die') process.exit(3); }\n` +
  `  if (m.id === 3) setTimeout(() => say({ id: 3, result: { content: [{ type: 'text', text: mode === 'notready' ? 'index missing' : 'ready' }], isError: mode === 'notready' } }), 200); } });\n` +
  `process.stdin.on('end', () => process.exit(0));\n`);
const tomlStr = s => JSON.stringify(s); // a JSON string is a TOML basic string
const home = (name, section) => { const d = path.join(W, name); put(path.join(d, 'config.toml'), section); return d; };
const sectionFor = (args = [FAKE]) => `model = "x"\n[mcp_servers.mql5-chm]\ncommand = ${tomlStr(process.execPath)}\nargs = [${args.map(tomlStr).join(', ')}]\n\n[features]\nmulti_agent = true\n`;
const GOOD = home('good', sectionFor());
const read = text => L.readDocsServer(put(path.join(W, 'cfg', `c${Math.random().toString(36).slice(2)}.toml`), text));

// 1. the strict config reader
let d = read(`[mcp_servers.mql5-chm]\ncommand = 'C:\\Tools\\node.exe'\nargs = ['C:\\Tools\\server.mjs']\n[other]\nx = 1\n`);
ok(d.command === 'C:\\Tools\\node.exe' && d.args.length === 1 && d.args[0] === 'C:\\Tools\\server.mjs', 'literal strings, section ends at the next table');
d = read(`[mcp_servers."mql5-chm"] # docs\ncommand = "C:\\\\a b\\\\node.exe"\nargs = [\n  "C:\\\\x\\\\s.mjs", # the server\n  "--flag",\n]\nstartup_timeout_sec = 20\nrequired = true\n`);
ok(d.command === 'C:\\a b\\node.exe' && d.args.join('|') === 'C:\\x\\s.mjs|--flag', 'quoted table name, escapes, multi-line list with comments, harmless keys ignored');
const prob = (text, re, what) => { const r = read(text); ok(!!r.problem && re.test(r.problem), `${what} -> docs off (${r.problem || 'no problem reported'})`); };
prob('[features]\nx = true\n', /no \[mcp_servers\.mql5-chm\]/, 'no section');
prob(`[mcp_servers.mql5-chm]\ncommand = 'n'\nenabled = false\n`, /switched off/, 'enabled = false');
prob(`[mcp_servers.mql5-chm]\ncommand = 'n'\n[mcp_servers.mql5-chm.env]\nA = "1"\n`, /not passed on/, 'an env sub-table');
prob(`[mcp_servers.mql5-chm]\ncommand = 'n'\ncwd = 'C:\\x'\n`, /sets cwd/, 'a cwd setting');
prob(`[mcp_servers.mql5-chm]\nurl = "http://127.0.0.1:1/mcp"\n`, /sets url/, 'a URL transport');
prob(`[mcp_servers.mql5-chm]\ncommand = "C:\\Users\\node.exe"\n`, /bad escape/, 'an invalid escape');
prob(`[mcp_servers.mql5-chm]\ncommand = '''n'''\n`, /multi-line/, 'a multi-line string');
prob(`[mcp_servers.mql5-chm]\ncommand = 'n'\nargs = [1, 2]\n`, /lists of strings/, 'a list of numbers');
prob(`mcp_servers.mql5-chm.env = { A = "1" }\n[mcp_servers.mql5-chm]\ncommand = 'n'\n`, /outside its section/, 'settings outside its section');

// 2. files and handshake (cached per installation for an hour)
const withHome = (h, fn) => { const was = process.env.CODEX_HOME; process.env.CODEX_HOME = h; try { return fn(); } finally { if (was === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = was; } };
L.updateState(L.HOME, s => { delete s.docsCheck; });
fs.rmSync(COUNT, { force: true });
ok(withHome(GOOD, () => L.mql5DocsServer(false)) === null, 'the session-start check never starts the server (no result yet)');
d = withHome(GOOD, () => L.mql5DocsServer());
ok(!d.problem && d.args[0] === FAKE && fs.readFileSync(COUNT, 'utf8').length === 1, 'a working server passes the handshake');
withHome(GOOD, () => L.mql5DocsServer());
ok(fs.readFileSync(COUNT, 'utf8').length === 1 && !withHome(GOOD, () => L.mql5DocsServer(false)).problem, 'the result is reused (no second start)');
const later = new Date(Date.now() + 5000); fs.utimesSync(FAKE, later, later);
withHome(GOOD, () => L.mql5DocsServer());
ok(fs.readFileSync(COUNT, 'utf8').length === 2, 'an updated installation is checked again');
const FOUR = home('four', sectionFor([FAKE, TOOLS.slice(0, 4).join(',')]));
d = withHome(FOUR, () => L.mql5DocsServer());
ok(/did not offer mql5_chm_read_image/.test(d.problem || ''), 'a server missing a docs tool is refused');
d = withHome(home('notready', sectionFor([FAKE, TOOLS.join(','), 'notready'])), () => L.mql5DocsServer());
ok(/index as not ready/.test(d.problem || ''), 'a server whose status call fails (no usable index) is refused');
d = withHome(home('die', sectionFor([FAKE, TOOLS.join(','), 'die'])), () => L.mql5DocsServer());
ok(/stopped \(exit 3\)/.test(d.problem || ''), 'a server that stops before answering the status call is refused');
const GONE = home('gone', `[mcp_servers.mql5-chm]\ncommand = ${tomlStr(process.execPath)}\nargs = [${tomlStr(path.join(W, 'no-such', 'server.mjs'))}]\n`);
d = withHome(GONE, () => L.mql5DocsServer());
ok(/server\.mjs not found/.test(d.problem || ''), 'a missing server script is refused before starting anything');

// 3. Codex arguments per mode
const base = { effort: 'xhigh', sandbox: 'read-only', cwd: 'C:/p', outFile: 'C:/o.txt', persist: true };
const has = (a, v) => a.some((x, i) => x === v && a[i - 1] === '-c');
const lock = a => X.LOCKDOWN.every(v => has(a, v));
for (const mode of ['review', 'plan', 'idea', 'digest', 'investigate', 'testplan', 'score', 'write', 'doctor']) {
  const a = X.codexArgs({ ...base, mode });
  if (!(lock(a) && has(a, 'web_search="disabled"') && a.includes('--ignore-user-config') && !a.some(x => /^mcp_servers\./.test(x)))) ok(false, `${mode}: read-only lockdown`);
}
ok(true, 'every read-only mode: no user config, connectors/plugins/sub-agents/images off, no web, no MCP server');
const ra = X.codexArgs({ ...base, mode: 'research' });
ok(lock(ra) && !ra.some(x => /^web_search/.test(x)), 'research keeps web search, nothing else');
const ca = X.codexArgs({ ...base, mode: 'computer', docs: { command: 'n', args: [] } });
ok(!ca.includes('--ignore-user-config') && !X.LOCKDOWN.some(v => has(ca, v)) && !ca.some(x => /^mcp_servers\.mql5-chm\./.test(x)), 'computer use is unchanged (its own config, no extra server)');
const def = { command: 'C:\\a "b"\\node.exe', args: ['C:\\x\\s.mjs'] };
const da = X.codexArgs({ ...base, mode: 'review', docs: def });
const k = 'mcp_servers.mql5-chm';
ok(has(da, `${k}.command="C:\\\\a \\"b\\"\\\\node.exe"`) && has(da, `${k}.args=["C:\\\\x\\\\s.mjs"]`) && has(da, `${k}.required=false`)
  && has(da, `${k}.enabled_tools=[${TOOLS.map(t => JSON.stringify(t)).join(',')}]`) && TOOLS.every(t => has(da, `${k}.tools.${t}.approval_mode="approve"`)) && lock(da),
  'a docs run adds only mql5-chm: TOML-safe paths, exactly its five tools, auto-approved, not required');
const rsa = X.codexArgs({ ...base, mode: 'review', resume: 'sess-1', docs: def });
ok(rsa[2] === 'resume' && has(rsa, `${k}.required=false`) && lock(rsa), 'a resumed session gets the same flags');

// 4. which runs get the docs
K.at(W);
const df = (files, force) => withHome(GOOD, () => X.docsFor(files, force));
ok(df(['a.mq5']).def && df(['b.mqh']).def && df(['p.set']).def && df(['x.js', 'a.MQ5']).def, '.mq5/.mqh source and .set presets get the docs');
ok(df(['old.mq4']) === null && df(['x.js']) === null && df([]) === null, '.mq4 and other code do not');
ok(df(['report.htm'], true).def, '--mql5-docs (or a backtest digest) asks for them');
const e0 = console.error; let said = ''; console.error = m => { said += m; };
K.C.cfg.mql5Docs = false;
const sw = df(['a.mq5']);
ok(/switched off in config\.json/.test((sw && sw.problem) || '') && df(['x.js']) === null, '"mql5Docs": false: MQL5 runs are told the docs are off (API facts unverified), other runs unaffected');
K.C.cfg.mql5Docs = true;
const off = withHome(path.join(W, 'empty'), () => X.docsFor(['a.mq5']));
console.error = e0;
ok(off && off.problem && /MQL5 docs unavailable/.test(said) && /off \(/.test(X.docsLine(off)), 'unavailable docs are reported in the output and the run log');

// 5. end to end through gpt.js, with a Codex stub that records every call (no GPT)
const REC = path.join(W, 'calls.jsonl');
const STUB = put(path.join(W, 'codex-rec.js'),
  `const fs = require('fs'); const a = process.argv.slice(2); let input = '';\n` +
  `process.stdin.on('data', d => input += d).on('end', () => {\n` +
  `  const n = fs.existsSync(${JSON.stringify(REC)}) ? fs.readFileSync(${JSON.stringify(REC)}, 'utf8').split('\\n').filter(Boolean).length : 0;\n` +
  `  fs.appendFileSync(${JSON.stringify(REC)}, JSON.stringify({ a, input }) + '\\n');\n` +
  `  const mode = process.env.STUB_MODE || '', resume = a[1] === 'resume';\n` +
  `  if (mode === 'failfirst' && n === 0) { process.stderr.write('error: stream disconnected\\n'); process.exit(1); }\n` +
  `  const cov = '\\nCOVERAGE: inputs/encodings=checked; failure/timeout/cleanup=checked; concurrency/stale state=n/a; callers/interfaces=checked; tests=not examined';\n` +
  `  const text = mode === 'badfirst' && n === 0 ? 'I looked around.' : (resume ? 'VERDICT: RESOLVED\\n1. RESOLVED — ok' : 'VERDICT: NO_ISSUES') + cov;\n` +
  `  fs.writeFileSync(a[a.indexOf('-o') + 1], text); console.log('session id: 11111111-2222-3333-4444-555555555555'); });\n`);
const cf = path.join(L.HOME, 'config.json'), orig = fs.readFileSync(cf, 'utf8');
fs.writeFileSync(cf, JSON.stringify({ ...JSON.parse(orig), codexJs: STUB }));
const P = path.join(W, 'proj'), EA = put(path.join(P, 'ea.mq5'), 'void OnTick(){}\n'), JS = put(path.join(P, 'tool.js'), 'module.exports = 1;\n');
const gpt = (env, ...args) => spawnSync(process.execPath, [__G + 'gpt.js', ...args, '--project', P], { cwd: P, encoding: 'utf8', timeout: 120000, env: { ...process.env, CODEX_HOME: GOOD, ...env } });
const calls = () => { try { return fs.readFileSync(REC, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const docsIn = c => c.a.some(x => x === `${k}.required=false`) && /MQL5 DOCS — read-only tools/.test(c.input);
try {
  fs.rmSync(REC, { force: true });
  const r1 = gpt({}, 'review', '--task', 'check the EA', '--files', EA);
  const c1 = calls();
  ok(r1.status === 0 && c1.length === 1 && docsIn(c1[0]) && lock(c1[0].a), `an MQL5 review runs with the docs and the lockdown (exit ${r1.status})`);
  const logOf = out => (out.match(/\[gpt\.js\] log: (.+?\.md)(?: \(|$)/m) || [])[1]; // (a path may contain spaces)
  const log1 = logOf(r1.stdout);
  ok(!!log1 && /- MQL5 docs: on/.test(fs.readFileSync(log1, 'utf8')), 'the run log records the docs as on');
  const resp = put(path.join(W, 'resp.md'), '1. fixed\n');
  const r2 = gpt({}, 'review', '--followup', log1, '--file', resp);
  const c2 = calls()[1];
  ok(r2.status === 0 && c2 && c2.a[1] === 'resume' && docsIn(c2), 'its resumed follow-up keeps the docs');
  // --mql5-docs on other files: kept by its follow-up, also a fresh one (no flag repeated)
  fs.rmSync(REC, { force: true });
  const rf = gpt({}, 'review', '--task', 'check the tool', '--files', JS, '--mql5-docs');
  const logF = logOf(rf.stdout);
  const rf2 = gpt({}, 'review', '--followup', logF, '--file', resp, '--fresh');
  const cf2 = calls();
  ok(rf.status === 0 && rf2.status === 0 && cf2.length === 2 && docsIn(cf2[0]) && cf2[1].a[1] !== 'resume' && docsIn(cf2[1]), 'a forced docs run keeps them in its follow-ups (fresh session too)');
  fs.rmSync(REC, { force: true });
  const r3 = gpt({}, 'review', '--task', 'check the tool', '--files', JS);
  const c3 = calls()[0];
  ok(r3.status === 0 && c3 && lock(c3.a) && !c3.a.some(x => /^mcp_servers\./.test(x)) && !/MQL5 DOCS/.test(c3.input), 'a review of other code: lockdown, no docs');
  fs.rmSync(REC, { force: true });
  const r4 = gpt({ CODEX_HOME: path.join(W, 'empty') }, 'review', '--task', 'check the EA', '--files', EA);
  const c4 = calls()[0];
  ok(r4.status === 0 && c4 && !c4.a.some(x => /^mcp_servers\./.test(x)) && /not available in this run/.test(c4.input) && /MQL5 docs unavailable/.test(r4.stderr),
    'without the docs the review still runs, and GPT is told to mark API facts unverified');
  fs.rmSync(REC, { force: true });
  gpt({ STUB_MODE: 'badfirst' }, 'review', '--task', 'check the EA', '--files', EA);
  const c5 = calls();
  ok(c5.length === 2 && c5[1].a[1] === 'resume' && c5[1].a.includes(`${k}.required=false`), 'the format repair keeps the docs');
  fs.rmSync(REC, { force: true });
  gpt({ STUB_MODE: 'failfirst' }, 'review', '--task', 'check the EA', '--files', EA);
  const c6 = calls();
  ok(c6.length === 2 && docsIn(c6[1]), 'the retry keeps the docs');
} finally { fs.writeFileSync(cf, orig); }
L.updateState(L.HOME, s => { delete s.docsCheck; });
fs.rmSync(W, { recursive: true, force: true });
