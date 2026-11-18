// Run on Windows with two actual A installations. Credentials and callback data stay in memory.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const run=path.resolve(process.argv[2]); const gateway=path.resolve(process.argv[3]);
const lab=path.join(gateway,'.preview/jg-native-a'); const json=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const conf=json(path.join(lab,'environment.json')); const issuer='https://127.0.0.1:15816',model='subq/snap-1.2';
if(conf.issuer!==issuer || conf.provider!=='loopback-mock' || conf.model!==model) throw Error('not the A environment');
const {chromium}=createRequire(path.join(gateway,'web/package.json'))('playwright');
const local=path.join(run,'installed-windows'),linux=fs.readFileSync(path.join(run,'linux-install-path.txt'),'utf8').trim();
const wslpath=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replaceAll('\\','/');
const small=path.join(run,'sample');
const env={...process.env,EMRANK_HOME:path.join(local,'credentials'),XDG_CONFIG_HOME:path.join(local,'config'),XDG_CACHE_HOME:path.join(local,'cache'),EMRANK_PROVIDER:'emrank', EMRANK_A_EXTERNAL_BROWSER:'1'};
const finishOnly=process.argv.includes('--finish-logout');
let report={stage:'A',provider:'loopback-mock',started:new Date().toISOString(),targets:{},real_provider_attempts:0,B:'not_run'};
const reportFile=path.join(run,'cli-acceptance.json');
if (finishOnly) {
  const previous = fs.readFileSync(reportFile);
  report = JSON.parse(previous.toString('utf8'));
  if (report.status === 'pass') throw Error('This batch already has a completed acceptance report.');
  // A resumed observation must preserve the exact bytes of the previous attempt, even when it passes.
  const digest = createHash('sha256').update(previous).digest('hex');
  const snapshot = `cli-acceptance.${digest}.json`;
  const dest = path.join(run, snapshot);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, previous, {flag: 'wx'});
  if (!fs.readFileSync(dest).equals(previous)) throw Error('Conflicting acceptance snapshot');
  report.previous_reports = [...new Set([...(report.previous_reports ?? []), snapshot])];
} else {
  if (fs.existsSync(reportFile)) throw Error('Refusing to replace the report for an existing batch.');
  fs.mkdirSync(small, {recursive: true});
  fs.writeFileSync(path.join(small, 'events.ts'), 'export function recordEvent(event: string, events: string[]) {\n  events.push(event);\n  return events.length;\n}\n');
}
const store=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
function measure(){const s=JSON.parse(execFileSync(process.execPath,['tests/e2e/oauth-native/jg-lab/manage.mjs','status'],{cwd:gateway,encoding:'utf8'}));return {nodes:s.gateway_nodes,mock:s.mock,finance:s.finance,queue:s.queue};}
function launch(os,args){
 const argv=os==='windows'?[process.execPath,path.join(local,'node_modules/@emrank/jevgrep/dist/bin/index.js'),...args]:['wsl','-d','Ubuntu-24.04','--','bash',wslpath(path.join(project,'scripts/verify/kiri-linux.sh')),linux,...args];
 const child=spawn(argv[0],argv.slice(1),{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let text='',errors='';
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>errors+=b);let finished=false;
 const done=new Promise((ok,no)=>{child.on('error',no);child.on('close',c=>{finished=true;c===0?ok(text):no(Error('CLI rejected: '+((text+'\n'+errors).match(/EMRank: [A-Za-z 0-9;.,-]{1,150}/)?.[0]||'exit '+c)));});});done.catch(()=>{});
 return {child,done,url:async()=>{for(let i=0;i<450;i++){const u=text.match(/https:\/\/127\.0\.0\.1:15816\/oauth\/authorize\?[^\s]+/);if(u)return u[0];if(finished) await done; await delay(100);}throw Error('CLI authorization URL missing');}};
}
const command=(os,args)=>launch(os,args).done;
const check=(condition,label)=>{if(!condition)throw Error(label);};
async function visibleFrame(page,locator){for(let i=0;i<170;i++){for(const frame of page.frames())if(await locator(frame).isVisible().catch(()=>false)) return frame;await delay(100);}throw Error('expected browser control was not visible');}
const loginPanel=f=>f.getByRole('button',{name:'超级管理员登录',exact:true});
async function grants(context){const page=await context.newPage();try{await page.goto(issuer+'/api/oauth/authorizations');const data=JSON.parse(await page.locator('body').innerText());return Array.isArray(data)?data:(data.grants??data.data??data.items);}finally{await page.close();}}
async function login(os,browser){
 const result=report.targets[os]={};const manual=os==='linux';const context=await browser.newContext();
 await context.route('**/*',route=>{const u=new URL(route.request().url());return u.origin===issuer||(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.pathname==='/callback')?route.continue():route.abort();});
 const p=launch(os,['emrank','--login',...(manual?['--manual']:[]),'--model',model]);
 try {
 const url=await p.url();const page=await context.newPage();page.setDefaultTimeout(17000);await page.goto(url);
 const frame=await visibleFrame(page,loginPanel);result.started_signed_out='pass';await loginPanel(frame).click();
 const creds=json(path.join(lab,'private/browser.json'));if(creds.role!==1)throw Error('ordinary lab account required');
 await frame.locator('input[name=username]').fill(creds.username);await frame.locator('input[name=password]').fill(creds.password);await frame.getByRole('button',{name:'登录并继续',exact:true}).click();
 const allow=f=>f.getByRole('button',{name:'允许访问',exact:true});const form=await visibleFrame(page,allow);await allow(form).click();
 if(manual){const code=f=>f.getByLabel('一次性授权码',{exact:true});const f=await visibleFrame(page,code);const value=await code(f).inputValue();check(value.startsWith('emrank1.'),'manual response missing');p.child.stdin.end(value+'\n');}
 const output=await p.done;check(output.includes('Hello '+creds.username),'login greeting mismatch');result.consent=manual?'manual':'loopback';result.greeting='pass';
 const st=JSON.parse(await command(os,['emrank','--status']));check(st.authenticated&&st.model===model&&st.issuer===issuer,'installed authorization/model mismatch');
 result.activation_and_model='pass';result.access_expiry_before=st.expiresAt;store();console.log(os,'authorized, activated and selected model');
 return {context,st};
 } finally {if(p.child.exitCode===null && !p.child.killed) p.child.kill();}
}
const sessions={};let stage='start'; let browser;
try {
 if(!finishOnly){report.before=measure();store();} browser=await chromium.launch({channel:'chrome',headless:true,args:['--ignore-certificate-errors-spki-list='+conf.leaf_spki_sha256]});
 if(finishOnly){
  // Resume observation after a harness failure, without new PAR, activation or inference.
  for(const os of ['windows','linux']) {
   const context=await browser.newContext();const page=await context.newPage();await page.goto(issuer+'/.well-known/oauth-authorization-server');
   const creds=json(path.join(lab,'private/browser.json'));
   const ok=await page.evaluate(async({username,password})=>(await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})})).ok,{username:creds.username,password:creds.password});
   check(ok,'could not open ordinary account grant observer');sessions[os]={context};
  }
 } else {
 for (const os of ['windows','linux']) {stage=os+' browser login';sessions[os]=await login(os,browser);}
 for (const os of ['windows','linux']) {const result=report.targets[os];stage=os+' doctor';const b=measure();let out=await command(os,['doctor']);check(out.includes('verified'),'doctor did not confirm model');const d=measure();check(d.mock.attempts-b.mock.attempts===1,'doctor mock delta mismatch');result.doctor={status:'pass',attempts:d.mock.attempts-b.mock.attempts};
 stage=os+' search';out=await command(os,['Where is an event appended to the events list?',os==='windows'?small:wslpath(small),'--concurrency','2','--max-requests','12','--no-cache']);const q=measure();check(out.includes('events.ts')&&out.includes('recordEvent')&&q.mock.attempts>d.mock.attempts,'search returned no verified source');result.search={status:'pass',attempts:q.mock.attempts-d.mock.attempts,matched:'events.ts:recordEvent'};store();console.log(os,'doctor and search passed');}
 stage='natural expiry';const until=Math.max(...Object.values(sessions).map(s=>s.st.expiresAt));console.log('Waiting for natural access expiry');await delay(Math.max(0,(until+2)*1000-Date.now()));
 for(const [os,{st}] of Object.entries(sessions)){stage=os+' refresh';const m=measure();await Promise.all([command(os,['emrank','--model',model]),command(os,['emrank','--model',model])]);const fresh=JSON.parse(await command(os,['emrank','--status']));check(fresh.authenticated&&fresh.expiresAt>st.expiresAt&&measure().mock.attempts===m.mock.attempts,'natural refresh failed');report.targets[os].refresh={status:'pass',overlapping_processes:2,access_expiry_after:fresh.expiresAt};store();}
 }
 for(const [os,{context}] of Object.entries(sessions)){if(report.targets[os].logout?.status==='pass') continue;stage=os+' logout';const before=await grants(context);check(Array.isArray(before),'website grants response shape');const active=gs=>gs.filter(g=>!g.revoked_at&&g.status!=='revoked'&&g.active!==false).length;
 const localBefore=JSON.parse(await command(os,['emrank','--status']));
 const alreadyCleared=finishOnly&&!localBefore.authenticated;
 if(!alreadyCleared){const reply=JSON.parse(await command(os,['emrank','--logout']));check(reply.localCleared&&reply.remoteRevoked,'revocation response missing');}
 const after=JSON.parse(await command(os,['emrank','--status']));const ended=await grants(context);check(!after.authenticated,'local logout failed');
 const home=os==='windows'?path.join(local,'credentials'):null;let keyKept,sessionGone;if(home){const loc=path.join(home,'native-v2');const dir=path.join(loc,fs.readdirSync(loc)[0]);keyKept=fs.existsSync(path.join(dir,'instance'));sessionGone=!fs.existsSync(path.join(dir,'session'));}else{const files=execFileSync('wsl',['-d','Ubuntu-24.04','--','find',linux+'/credentials/native-v2','-type','f','-print'],{encoding:'utf8'}).trim().split(/\r?\n/).map(p=>path.posix.basename(p.trim()));keyKept=files.includes('instance');sessionGone=!files.includes('session');}
 check(keyKept&&sessionGone,'invalid post-logout credential files');if(alreadyCleared){
   const r=report.targets[os];const matching=ended.filter(g=>g.client_id===conf.client_id&&g.revoked_at&&g.active===false&&Math.abs(g.created_at-(r.access_expiry_before-300))<=2&&Math.abs(g.last_used_at-(r.refresh.access_expiry_after-300))<=2);
   check(active(ended)===0&&matching.length===1,'no unique revoked grant matched this installed client');
 }else{check(active(ended)<active(before),'gateway authorization was not visibly revoked');}report.targets[os].logout={status:'pass',remote_revoked:true,session_removed:true,instance_retained:true};store();}
 delete report.failure; report.status='pass';
} catch(e) {report.status='fail';report.failure={stage,detail:/^(CLI rejected: EMRank: |CLI rejected: exit \d+$)/.test(e.message)?e.message:e.message.includes('\n')?'operation did not complete':e.message.replace(/https?:\/\/\S+/g,'[origin omitted]').slice(0,140)};console.error(report.failure);process.exitCode=1;}
finally {await browser?.close();report.after=measure();report.completed=new Date().toISOString();store();}
