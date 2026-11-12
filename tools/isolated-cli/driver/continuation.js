const vscode=require('vscode'),fs=require('fs/promises'),path=require('path'),assert=require('assert/strict');
const {CliContinuation,assertDestinationReady,assertDestinationAvailable}=require('../../src/cli-continuation');
const {profileTerminalOptions}=require('../../src/terminal-profile');
const {listSessions,transferSession}=require('../../src/history');
exports.run=async()=>{
 const root=path.resolve(__dirname,'..'),live=path.resolve(root,'../.isolated-live'),cwd=path.join(live,'workspace');
 const output=path.join(root,'result-continuation.json');await fs.rm(output,{force:true});
 const env={...process.env,USERPROFILE:path.join(live,'home'),HOME:path.join(live,'home'),APPDATA:path.join(live,'appdata'),LOCALAPPDATA:path.join(live,'localappdata')};
 const profiles=[{name:'Default',builtin:true,configValue:null,directory:path.join(live,'home/.claude')},{name:'Test B',directory:path.join(live,'home/.claude-profile-switcher/profiles/test-b')}];
 const binary=path.join(live,'extensions/anthropic.claude-code-2.1.319-win32-x64/resources/native-binary/claude.exe');
 const manager=new CliContinuation();const terminals=[],events=[];
 const progress=async message=>{events.push(message);await fs.writeFile(path.join(root,'progress-continuation.json'),JSON.stringify(events));};
 async function open(profile,session){
  const terminal=vscode.window.createTerminal({...profileTerminalOptions(profile,env,false,session),shellPath:binary,cwd});
  terminal.show(true);terminals.push(terminal);manager.track(terminal,profile);
  const record=manager.records.get(terminal);let lastError;
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){
   try {const state=await manager.read(record);assert.equal(state.id,session.id);return record;}catch(e){lastError=e;}
   await new Promise(r=>setTimeout(r,500));
  }
  throw lastError;
 }
 try{
  assert.equal(process.env.USERPROFILE.toLowerCase(),path.join(root,'home').toLowerCase());
  const sessions=await listSessions(profiles[0].directory,[cwd]);assert.ok(sessions.length,'No isolated saved test conversation');
  const session=sessions.sort((a,b)=>b.modified-a.modified)[0];
  const accounts=profiles.map(profile=>{const r=require('child_process').spawnSync(binary,['auth','status'],{env:profileTerminalOptions(profile,env).env,encoding:'utf8',timeout:30000,windowsHide:true});const a=JSON.parse(r.stdout);assert.equal(a.loggedIn,true);assert.ok(a.email);return a.email;});assert.notEqual(accounts[0],accounts[1]);events.push('Both isolated profiles are signed in to distinct accounts');
  let record=await open(profiles[0],session);await progress('Default CLI resumed exact test conversation and is idle');
  for(const profile of [profiles[1],profiles[0]]){
   await new Promise(r=>setTimeout(r,2500));
   const [item]=await manager.plan([record]);await assertDestinationReady(profile);await assertDestinationAvailable(profile.directory,item.session.id);await manager.stop(item);assert.ok(item.stopped);
   await transferSession(record.profile.directory,profile.directory,item.session);
   await progress(`${profile.name}: history transferred, opening resumed CLI`);
   record=await open(profile,item.session);
   events.push(`${profile.name} CLI resumed same ID after previous process exited; history transfer backed up`);
  }
  await fs.writeFile(output,JSON.stringify({status:'pass',vscode:vscode.version,events},null,2));
 }catch(error){await fs.writeFile(output,JSON.stringify({status:'fail',events,error:error.message},null,2));throw error;}
 finally{for(const terminal of terminals)terminal.dispose();}
};
