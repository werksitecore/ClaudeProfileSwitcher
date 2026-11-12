const vscode=require('vscode'),fs=require('fs/promises'),path=require('path'),assert=require('assert/strict');
const {syncTerminalProfile,profileTerminalOptions}=require('../../src/terminal-profile');
exports.run=async()=>{
 const root=path.resolve(__dirname,'..');
 assert.equal(process.env.USERPROFILE.toLowerCase(),path.join(root,'home').toLowerCase());
 const {context}=await vscode.extensions.getExtension('fixture.cli-probe').activate();
 const results=[];
 await fs.rm(path.join(root,'result-updated.json'),{force:true});
 async function probe(options,expectedDirectory,expectedAuth){
  const output=path.join(root,`updated-${results.length}.json`);
  await fs.rm(output,{force:true});
  const terminal=vscode.window.createTerminal({...options,shellPath:process.env.PROBE_NODE,shellArgs:[path.join(__dirname,'probe.js'),output]});
  try{
   let actual;
   for(let i=0;i<200;i++){try{actual=JSON.parse(await fs.readFile(output,'utf8'));break;}catch{} await new Promise(r=>setTimeout(r,50));}
   assert.deepEqual(actual,{...(expectedDirectory?{directory:expectedDirectory}:{}),authPresent:expectedAuth});
   results.push({name:options.name,pass:true});
  }finally{terminal.dispose();}
 }
 try{
  for(const name of ['work','personal','work']){
   const directory=path.join(root,'home',name);
   syncTerminalProfile(context.environmentVariableCollection,directory);
   await new Promise(r=>setTimeout(r,200));
   await probe({name:`ordinary terminal follows ${name}`},directory,true);
   const other=path.join(root,'home',name==='work'?'personal':'work');
   await probe(profileTerminalOptions({name:'explicit opposite profile',directory:other},process.env),other,false);
   await probe(profileTerminalOptions({name:'Default',builtin:true,configValue:null},process.env),undefined,false);
  }
  syncTerminalProfile(context.environmentVariableCollection,null);
  await new Promise(r=>setTimeout(r,200));
  await probe({name:'restore original inherited environment'},process.env.CLAUDE_CONFIG_DIR,true);
  
  const live=path.resolve(root,'../.isolated-live');
  const liveEnv={...process.env,USERPROFILE:path.join(live,'home'),HOME:path.join(live,'home'),APPDATA:path.join(live,'appdata'),LOCALAPPDATA:path.join(live,'localappdata')};
  for(const key of ['CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'])delete liveEnv[key];
  const binary=process.env.PROBE_CLAUDE_BINARY || path.join(live,'extensions/anthropic.claude-code-2.1.319-win32-x64/resources/native-binary/claude.exe');
  const profiles=[{name:'Default',builtin:true,configValue:null},{name:'Test B',directory:path.join(live,'home/.claude-profile-switcher/profiles/test-b')}];
  const digests=[];
  for(const profile of profiles){
   const env=profileTerminalOptions(profile,liveEnv).env;
   const result=require('child_process').spawnSync(binary,['auth','status'],{env,encoding:'utf8',timeout:30000,windowsHide:true});
   const status=JSON.parse(result.stdout);assert.equal(status.loggedIn,true);assert.ok(status.email);
   digests.push(require('crypto').createHash('sha256').update(status.email).digest('hex'));
  }
  assert.notEqual(digests[0],digests[1]);
  for(const index of [0,1,0]){
   const profile=profiles[index];
   syncTerminalProfile(context.environmentVariableCollection,profile.directory||null);
   await new Promise(r=>setTimeout(r,200));
   for(const mode of ['ordinary','explicit']){
    const output=path.join(root,`auth-${results.length}.json`);await fs.rm(output,{force:true});
    const env={...liveEnv,PROBE_CLAUDE:binary,PROBE_ACCOUNT_DIGEST:digests[index],PROBE_OTHER_DIGEST:digests[1-index]};
    const options=mode==='explicit'?profileTerminalOptions(profile,env):{env:{...env,CLAUDE_CONFIG_DIR:null,ANTHROPIC_API_KEY:null,ANTHROPIC_AUTH_TOKEN:null,CLAUDE_CODE_OAUTH_TOKEN:null}};
    const terminal=vscode.window.createTerminal({...options,name:`isolated auth ${profile.name}`,shellPath:process.env.PROBE_NODE,shellArgs:[path.join(__dirname,'probe-auth.js'),output]});
    try{
     let actual;
     for(let i=0;i<600;i++){try{actual=JSON.parse(await fs.readFile(output,'utf8'));break;}catch{} await new Promise(r=>setTimeout(r,50));}
     assert.deepEqual(actual,{loggedIn:true,expectedAccountMatched:true,exit:0});
     results.push({name:`live isolated account ${profile.name} ${mode}`,pass:true});
    }finally{terminal.dispose();}
   }
  }
  await fs.writeFile(path.join(root,'result-updated.json'),JSON.stringify({vscode:vscode.version,cli:process.env.PROBE_CLAUDE_BINARY?'standalone':'panel bundled',status:'pass',results},null,2));
 }finally{context.environmentVariableCollection.clear();}
};
