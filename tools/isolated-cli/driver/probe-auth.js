const {spawnSync}=require('child_process'),{createHash}=require('crypto');
const result=spawnSync(process.env.PROBE_CLAUDE,['auth','status'],{env:process.env,encoding:'utf8',timeout:30000,windowsHide:true});
let status={};try{status=JSON.parse(result.stdout);}catch{}
const digest=createHash('sha256').update(status.email||'').digest('hex');
require('fs').writeFileSync(process.argv[2],JSON.stringify({loggedIn:status.loggedIn===true,expectedAccountMatched:!!status.email && digest===process.env.PROBE_ACCOUNT_DIGEST,exit:result.status}));
