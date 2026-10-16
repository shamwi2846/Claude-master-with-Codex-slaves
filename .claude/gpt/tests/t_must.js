// mustRead wins over a partial diff (initial commit then another edit, no baseline).
const __G = require('path').join(__dirname, '..').replace(/\\/g, '/') + '/'; // the setup under test
const path=require('path'),fs=require('fs'),os=require('os'),{spawnSync}=require('child_process');const L=require(__G + 'lib.js');
const K=require('./bridge-kit');
const ok=(c,m)=>console.log(c?'PASS':'FAIL',m);
const G=path.join(os.homedir(),'gpt-final');fs.rmSync(G,{recursive:true,force:true});fs.mkdirSync(G);const git=(...a)=>spawnSync('git',a,{cwd:G,encoding:'utf8'});
git('init','-q');git('config','user.email','me@x');git('config','user.name','me');const A=path.join(G,'a.js');fs.writeFileSync(A,'committed body\n');git('add','-A');git('commit','-qm','i');
fs.writeFileSync(A,'committed body\nlater edit\n');
L.updateState(G,s=>{s.changes[A]={lines:5,at:Date.now(),committed:true,sinceRev:null,shellTouched:true};});
const m=K.at(G).review.reviewMaterial([A]);ok(/a\.js: changed and committed during this turn/.test(m.text),'whole-file read takes priority over the partial HEAD diff');
fs.rmSync(m.snapDir,{recursive:true,force:true});fs.rmSync(G,{recursive:true,force:true});
