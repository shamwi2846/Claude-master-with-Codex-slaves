const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path=require('path'),fs=require('fs'),os=require('os'),{spawnSync}=require('child_process');const L=require(__G + 'lib.js');
const gate=(ev,i)=>spawnSync(process.execPath,[__G + 'gate.js',ev],{input:JSON.stringify(i),encoding:'utf8'}).stdout;
const p=path.join(os.homedir(),'gpt-bulk');fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p);const SID='bulk-'+Date.now();
gate('session',{cwd:p,session_id:SID});gate('prompt',{cwd:p,session_id:SID,prompt:'go'});
gate('pre-bash',{cwd:p,session_id:SID,tool_use_id:'b1'});for(let i=0;i<40;i++)fs.writeFileSync(path.join(p,'f'+i+'.js'),'x');gate('post-bash',{cwd:p,session_id:SID,tool_use_id:'b1',tool_input:{command:'cp -r repo/* .'}});
const s=L.readState(p);console.log(Object.keys(s.changes||{}).length===0&&s.lastBulkShell?'PASS':'FAIL','bulk copy of 40 files not flagged; noted:',JSON.stringify(s.lastBulkShell&&s.lastBulkShell.files));
gate('pre-bash',{cwd:p,session_id:SID,tool_use_id:'b2'});fs.writeFileSync(path.join(p,'f1.js'),'changed by sed');gate('post-bash',{cwd:p,session_id:SID,tool_use_id:'b2'});
console.log(L.readState(p).changes[path.join(p,'f1.js')]?'PASS':'FAIL','single shell edit still tracked');
fs.rmSync(p,{recursive:true,force:true});for(const x of fs.readdirSync(L.STATE_DIR)){try{if(JSON.parse(fs.readFileSync(path.join(L.STATE_DIR,x),'utf8')).root.startsWith(p))fs.rmSync(path.join(L.STATE_DIR,x))}catch{}}
L.updateState(L.HOME,g=>{if(g.sessionRoots)delete g.sessionRoots[SID]});
