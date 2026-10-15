// A review that already covered the content while the shell command ran: no new pending change.
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path=require('path'),fs=require('fs'),os=require('os'),{spawnSync}=require('child_process');const L=require(__G + 'lib.js');
const gate=(ev,i)=>spawnSync(process.execPath,[__G + 'gate.js',ev],{input:JSON.stringify(i),encoding:'utf8'}).stdout;
const ok=(c,m)=>console.log(c?'PASS':'FAIL',m);
const P=path.join(os.homedir(),'gpt-final');fs.rmSync(P,{recursive:true,force:true});fs.mkdirSync(P);const SID='p2-'+Date.now(),b={cwd:P,session_id:SID};
gate('session',b);gate('prompt',{...b,prompt:'go'});const F=path.join(P,'f.js');fs.writeFileSync(F,'v1\n');
gate('pre-bash',{...b,tool_use_id:'x'});fs.writeFileSync(F,'v2\n');
// a review freezes v2 and acknowledges it before the command finishes
L.setBaseline(P,F,F);L.updateState(P,s=>{s.changes[F]={lines:5,at:Date.now()-50,reviewedAt:Date.now()+10,baseAt:Date.now()+10};});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);
gate('post-bash',{...b,tool_use_id:'x'});const st=L.readState(P),c=st.changes[F];
ok(!(c.at>L.reviewedAtFor(st,c)),'content already reviewed during the command is not reopened');
fs.rmSync(P,{recursive:true,force:true});L.updateState(L.HOME,g=>{if(g.sessionRoots)delete g.sessionRoots[SID];});
