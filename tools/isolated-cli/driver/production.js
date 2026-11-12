const vscode=require('vscode'),fs=require('fs/promises'),path=require('path'),assert=require('assert/strict');
const {CliContinuation}=require('../../src/cli-continuation');
const {profileTerminalOptions}=require('../../src/terminal-profile');
const {listSessions,transferSession}=require('../../src/history');
exports.run=async()=>{
 const root=path.resolve(__dirname,'..'),live=path.resolve(root,'../.isolated-live'),cwd=path.join(live,'workspace');
 const output=path.join(root,'result-cli-command.json');await fs.rm(output,{force:true});
 const env={...process.env,USERPROFILE:path.join(live,'home'),HOME:path.join(live,'home'),APPDATA:path.join(live,'appdata'),LOCALAPPDATA:path.join(live,'localappdata')};
 const profiles=[{name:'Default',builtin:true,configValue:null,directory:path.join(live,'home/.claude')},{name:'Test B',directory:path.join(live,'home/.claude-profile-switcher/profiles/test-b')}];
 const binary=path.join(live,'extensions/anthropic.claude-code-2.1.319-win32-x64/resources/native-binary/claude.exe');
 const manager=new CliContinuation();const terminals=[],events=[];
 const progress=async message=>{events.push(message);await fs.writeFile(path.join(root,'progress-cli-command.json'),JSON.stringify(events));};
 let selected='Test B',questions=0,notices=0;
 const driver=await vscode.extensions.getExtension('fixture.cli-probe').activate();
 const context=driver.context;
 await context.globalState.update('profiles',[profiles[1]]);
 await context.globalState.update('defaultConfiguration',{directoryEntries:[],inheritedDirectory:null});
 await context.globalState.update('original',undefined);
 const windowOverrides={showQuickPick:async items=>{questions++;return items.find(item=>item.label===selected);},showInformationMessage:async()=>{notices++;return 'Resume in CLI';},showErrorMessage:message=>{throw Error(message);}};
 const window=new Proxy(vscode.window,{get:(target,key)=>key in windowOverrides?windowOverrides[key]:target[key]});
 const workspace=new Proxy(vscode.workspace,{get:(target,key)=>key==='getConfiguration'?(section=>section==='claudeCode'?{get:()=>[],update:async()=>{}}:vscode.workspace.getConfiguration(section)):target[key]});
 const extensions=new Proxy(vscode.extensions,{get:(target,key)=>key==='getExtension'?(id=>id==='anthropic.claude-code'?{extensionPath:path.dirname(path.dirname(path.dirname(binary)))}:vscode.extensions.getExtension(id)):target[key]});
 const overrides={window,workspace,extensions};
 const api=new Proxy(vscode,{get:(target,key)=>key in overrides?overrides[key]:target[key]});

 const source=path.resolve(root,'../src/extension.js');const module={exports:{}};
 const processEnv=require('../../src/terminal-profile').profileTerminalOptions(profiles[0],env).env;
 require('vm').runInNewContext(await fs.readFile(source,'utf8'),{module,setTimeout,process:{env:processEnv,platform:process.platform},require:name=>name==='vscode'?api:name==='node:os'?{...require('os'),homedir:()=>path.join(live,'home')}:name.startsWith('./')?require(path.resolve(path.dirname(source),name)):require(name)});
 await module.exports.activate(context);
 const subscription=vscode.window.onDidOpenTerminal(t=>terminals.push(t));context.subscriptions.push(subscription);
 async function current(profile,session){
  const deadline=Date.now()+45000;let lastError;
  while(Date.now()<deadline){
   const terminal=terminals.at(-1);
   if(terminal){try{const record={terminal,profile,startedAt:Date.now()-30000};const state=await manager.read(record);assert.equal(state.id,session.id);assert.equal(vscode.window.activeTerminal,terminal);return record;}catch(e){lastError=e;}}
   await new Promise(r=>setTimeout(r,500));
  }
  throw lastError||new Error('No managed terminal opened');
 }

 try{
  assert.equal(process.env.USERPROFILE.toLowerCase(),path.join(root,'home').toLowerCase());
  const sessions=await listSessions(profiles[0].directory,[cwd]);assert.ok(sessions.length,'No isolated saved test conversation');
  const session=sessions.sort((a,b)=>b.modified-a.modified)[0];
  const originalPath=path.join(profiles[0].directory,'projects',session.project,session.id+'.jsonl');
  const originalMessages=(await fs.readFile(originalPath,'utf8')).split('\n').filter(line=>{try{return ['user','assistant'].includes(JSON.parse(line).type);}catch{return false;}});assert.ok(originalMessages.length);
  const accounts=profiles.map(profile=>{const r=require('child_process').spawnSync(binary,['auth','status'],{env:profileTerminalOptions(profile,env).env,encoding:'utf8',timeout:30000,windowsHide:true});const a=JSON.parse(r.stdout);assert.equal(a.loggedIn,true);assert.ok(a.email);return a.email;});assert.notEqual(accounts[0],accounts[1]);events.push('Both isolated profiles are signed in to distinct accounts');
  await context.workspaceState.update('pendingResume',{profile:profiles[0],session});await vscode.commands.executeCommand('claudeProfiles.resume');let record=await current(profiles[0],session);await progress('Default CLI resumed exact test conversation and is idle');
  for(const profile of [profiles[1],profiles[0]]){
   await new Promise(r=>setTimeout(r,2500));
   const oldPid=await record.terminal.processId;
   selected=profile.name;
   await vscode.commands.executeCommand('claudeProfiles.switchCli');
   record=await current(profile,session);
   assert.notEqual(await record.terminal.processId,oldPid);
   events.push(`${profile.name}: production switch command opened the same session in a new process`);
  }
  assert.equal(questions,2,'Only the account picker should appear for each switch');
  assert.equal(notices,1,'Only initial test resume uses a notice; automatic switches must not ask');
  events.push('Two switches used only account selection; no conversation picker or Resume confirmation');

  const finalTranscript=await fs.readFile(originalPath,'utf8');assert.ok(originalMessages.every(line=>finalTranscript.includes(line)));events.push('All original saved user/assistant messages preserved after the round trip');
  await fs.writeFile(output,JSON.stringify({status:'pass',vscode:vscode.version,events},null,2));
 }catch(error){await fs.writeFile(output,JSON.stringify({status:'fail',events,error:error.message},null,2));throw error;}
 finally{for(const terminal of terminals)terminal.dispose();}
};
