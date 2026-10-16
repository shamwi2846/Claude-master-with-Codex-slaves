require('./profile-guard'); const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const __B = (process.env.GPT_BACKUP_DIR || require('path').join(require('os').homedir(), 'Desktop', 'Cloude agent')).replace(/\\/g, '/') + '/';
if (!require('fs').existsSync(__B + 'restore.js')) { console.log('SKIP no backup folder (set GPT_BACKUP_DIR)'); process.exit(0); }
const fs=require('fs'),path=require('path'),os=require('os'),{spawnSync}=require('child_process');
const ok=(c,m)=>console.log(c?'PASS':'FAIL',m);
const H=path.join(os.tmpdir(),'rh-'+Date.now());fs.mkdirSync(path.join(H,'.claude'),{recursive:true});
const hereGate=path.join(H,'.claude','gpt','gate.js');
fs.writeFileSync(path.join(H,'.claude','settings.json'),JSON.stringify({model:'x',hooks:{PreToolUse:[
 {matcher:'Bash',hooks:[{type:'command',command:'node "D:/tools/mygpt/gate.js" check'}]},
 {matcher:'Bash',hooks:[{type:'command',command:`node "${hereGate}" pre-bash-old`}]}]}}));
const r=spawnSync(process.execPath,[__B + 'restore.js'],{env:{...process.env,USERPROFILE:H,HOME:H},encoding:'utf8'});
const st=JSON.parse(fs.readFileSync(path.join(H,'.claude','settings.json'),'utf8'));
const cmds=Object.values(st.hooks).flat().flatMap(g=>g.hooks.map(h=>h.command));
ok(r.status===0,'restore ran '+(r.stderr||''));
ok(cmds.includes('node "D:/tools/mygpt/gate.js" check'),'unrelated gate.js hook kept');
ok(!cmds.some(c=>c.includes('pre-bash-old')),'old own hook replaced');
ok(cmds.some(c=>c.replace(/\\/g,'/').toLowerCase().includes(hereGate.replace(/\\/g,'/').toLowerCase()+'" pre-bash')),'own hooks relocated to this user');
ok(st.model==='x','other settings kept');
fs.rmSync(H,{recursive:true,force:true});
