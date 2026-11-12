const vscode=require('vscode'),fs=require('fs/promises'),path=require('path'),assert=require('assert/strict');
const {readSession}=require('../../src/cli-continuation');
const {listSessions}=require('../../src/history');
const {profileTerminalOptions}=require('../../src/terminal-profile');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
exports.run=async()=>{
 const root=path.resolve(__dirname,'..'),cwd=path.join(root,'workspace'),output=path.join(root,'combined-result.json');
 await fs.rm(output,{force:true});
 const events=[],terminals=[];let selected='Test B',questions=0,notices=0;
 const report=async(status,error)=>fs.writeFile(output,JSON.stringify({status,vscode:vscode.version,events,...(error?{error}: {})},null,2));
 const profiles=[{name:'Default',builtin:true,configValue:null,directory:path.join(root,'home/.claude'),directoryEntries:[]},{id:'test-b',name:'Test B',directory:path.join(root,'home/.claude-profile-switcher/profiles/test-b')}];
 const config=()=>vscode.workspace.getConfiguration('claudeCode');
 const allTabs=()=>vscode.window.tabGroups.all.flatMap(g=>g.tabs);
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 async function waitFor(fn,label){let last;const end=Date.now()+45000;while(Date.now()<end){try{return await fn();}catch(e){last=e;}await delay(500);}throw new Error(`${label}: ${last?.message}`);}
 async function panelState(profile,id,cliPid){
  return waitFor(async()=>{
   const names=await fs.readdir(path.join(profile.directory,'sessions'));
   for(const name of names){if(!/^\d+\.json$/.test(name))continue;let state;try{state=JSON.parse(await fs.readFile(path.join(profile.directory,'sessions',name),'utf8'));}catch{continue;}
    if(state.sessionId===id&&state.pid!==cliPid&&alive(state.pid))return state;
   }throw Error('No live panel process with expected session ID');
  },'Panel resume');
 }
 async function cliState(profile,id){return waitFor(async()=>{const terminal=terminals.at(-1);assert.ok(terminal);const state=await readSession({terminal,profile,startedAt:Date.now()-45000});assert.equal(state.id,id);return state;},'CLI resume');}
 try{
  assert.equal(require('os').homedir().toLowerCase(),path.join(root,'home').toLowerCase());
  assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath.toLowerCase(),cwd.toLowerCase());
  const context=(await vscode.extensions.getExtension('fixture.combined-switch-test').activate()).context;
  const claude=vscode.extensions.getExtension('anthropic.claude-code');assert.ok(claude.extensionPath.toLowerCase().startsWith(root.toLowerCase()+path.sep));
  await config().update('environmentVariables',[],vscode.ConfigurationTarget.Global);
  await context.globalState.update('profiles',[profiles[1]]);await context.globalState.update('defaultConfiguration',{directoryEntries:[],inheritedDirectory:null});
  const overrides={showQuickPick:async items=>{questions++;return items.find(i=>i.label===selected);},showInformationMessage:async()=>{notices++;return 'Resume in CLI';},showErrorMessage:message=>{throw Error(message);}};
  const window=new Proxy(vscode.window,{get:(t,k)=>k in overrides?overrides[k]:t[k]});
  const api=new Proxy(vscode,{get:(t,k)=>k==='window'?window:t[k]});
  const file=path.resolve(root,'../src/extension.js'),module={exports:{}};
  require('vm').runInNewContext(await fs.readFile(file,'utf8'),{module,process,setTimeout,require:n=>n==='vscode'?api:n.startsWith('./')?require(path.resolve(path.dirname(file),n)):require(n)});
  await module.exports.activate(context);context.subscriptions.push(vscode.window.onDidOpenTerminal(t=>terminals.push(t)));
  await claude.activate();
  const binary=path.join(claude.extensionPath,'resources/native-binary/claude.exe');
  const accounts=profiles.map(p=>{const r=require('child_process').spawnSync(binary,['auth','status'],{env:profileTerminalOptions(p,process.env).env,encoding:'utf8',timeout:30000,windowsHide:true});const status=JSON.parse(r.stdout);assert.ok(status.loggedIn&&status.email);return status.email;});assert.notEqual(accounts[0],accounts[1]);events.push('Two distinct signed-in isolated accounts verified');
  const candidates=(await listSessions(profiles[0].directory,[cwd])).sort((a,b)=>b.modified-a.modified);
  const originals=[];
  for(const session of candidates){const lines=(await fs.readFile(path.join(profiles[0].directory,'projects',session.project,session.id+'.jsonl'),'utf8')).split('\n').filter(line=>{try{return ['user','assistant'].includes(JSON.parse(line).type);}catch{return false;}});if(lines.length)originals.push({session,lines});if(originals.length===2)break;}
  assert.equal(originals.length,2,'Need two nonempty isolated saved conversations');
  const [cliSession,panelSession]=originals.map(o=>o.session);
  const note=await vscode.workspace.openTextDocument(path.join(cwd,'ISOLATED-TEST.txt'));await vscode.window.showTextDocument(note);const noteTab=allTabs().find(t=>t.label==='ISOLATED-TEST.txt');assert.ok(noteTab);const hostPid=process.pid;
  await context.workspaceState.update('pendingResume',{profile:profiles[0],session:cliSession});await vscode.commands.executeCommand('claudeProfiles.resume');let cli=await cliState(profiles[0],cliSession.id);
  await vscode.commands.executeCommand('claude-vscode.primaryEditor.open',panelSession.id);let panel=await panelState(profiles[0],panelSession.id,cli.pid);
  events.push('Default: panel and managed CLI have their distinct expected conversation IDs');await report('running');
  for(const profile of [profiles[1],profiles[0]]){
   await delay(4000);await vscode.commands.executeCommand('claude-vscode.primaryEditor.open',panelSession.id);
   assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputWebview);
   const oldCli=cli.pid,oldPanel=panel.pid;selected=profile.name;
   await vscode.commands.executeCommand('claudeProfiles.switch');
   cli=await cliState(profile,cliSession.id);panel=await panelState(profile,panelSession.id,cli.pid);
   assert.notEqual(cli.pid,oldCli);assert.notEqual(panel.pid,oldPanel);assert.ok(!alive(oldCli));assert.equal(process.pid,hostPid);assert.ok(allTabs().includes(noteTab));
   for(const o of originals){const transcript=await fs.readFile(path.join(profile.directory,'projects',o.session.project,o.session.id+'.jsonl'),'utf8');assert.ok(o.lines.every(line=>transcript.includes(line)));}
   events.push(`${profile.name}: both original session IDs resumed in new processes; all original messages and unrelated editor preserved`);await report('running');
  }
  assert.equal(questions,2);assert.equal(notices,1);events.push('Two account choices only; no conversation picker or resume confirmation; VS Code host never restarted');await report('pass');
 }catch(error){await report('fail',error.message);throw error;}
 finally{for(const terminal of terminals)terminal.dispose();}
};
