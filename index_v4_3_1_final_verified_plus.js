'use strict';

/*
  FANNYFLAY V4.3.1 FINAL VERIFIED+ — Production Edition
  Read-only YouTube analytics auditor.
  Official API data and local heuristics are kept explicitly separate.
*/

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const topicDNA = require('./fannyflay_topic_dna.js');

const ROOT = __dirname;
const CREDS_PATH = path.join(ROOT, 'oauth_client.local.json');
const TOKEN_PATH = path.join(ROOT, 'token.local.json');
const EXPECTED_CHANNEL_PATH = path.join(ROOT, 'expected_channel.local.json');
const FANNYFLAY_CHANNEL_ID = 'UCpo1qEGOUk1_xeJwJUW10Dw';
const SNAPSHOT_PATH = path.join(ROOT, 'fannyflay-v4-snapshots.jsonl');
const CHANNEL_SNAPSHOT_PATH = path.join(ROOT, 'fannyflay-v4-channel-snapshots.jsonl');
const HISTORY_KEEP_RUNS = 50;
const LOG_KEEP_RUNS = 100;
const LOCK_PATH = path.join(ROOT, '.fannyflay-v4.lock');
const CACHE_DIR = path.join(ROOT, 'v4_cache');
const HISTORY_DIR = path.join(ROOT, 'v4_history');
const LOG_DIR = path.join(ROOT, 'v4_logs');

const OUT = {
  json: path.join(ROOT, 'fannyflay-master-v4-3-1-final-verified-plus.json'),
  txt: path.join(ROOT, 'fannyflay-master-v4-3-1-final-verified-plus.txt'),
  html: path.join(ROOT, 'fannyflay-master-v4-3-1-final-verified-plus.html'),
  videosCsv: path.join(ROOT, 'fannyflay-v4-3-1-final-verified-plus-videos.csv'),
  dailyCsv: path.join(ROOT, 'fannyflay-v4-3-1-final-verified-plus-daily.csv'),
  qualityCsv: path.join(ROOT, 'fannyflay-v4-3-1-final-verified-plus-data-quality.csv')
};

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly'
];

const args = parseArgs(process.argv.slice(2));
const RUN_ID = `V431-${new Date().toISOString().replace(/[-:.TZ]/g,'')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const runtimeLog = [];
const queryLog = [];
const fileWarnings = [];
let lockFd = null;
let ACTIVE_CHANNEL_ID = 'UNRESOLVED';
const CACHE_SCHEMA_VERSION = 'v4.3.1-final-verified';
const ANALYTICS_TIME_ZONE = 'America/Los_Angeles';

// ---------- CLI / RUNTIME ----------

function parseArgs(argv) {
  const out = {
    fresh: false,
    acceptChannel: false,
    days: [],
    start: null,
    end: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fresh' || a === '--no-cache') out.fresh = true;
    else if (a === '--accept-channel') out.acceptChannel = true;
    else if (a === '--days' && argv[i+1]) {
      const d = argv[++i].split(',').map(Number).filter(x => Number.isInteger(x) && x > 0 && x <= 3650);
      if (d.length) out.days = [...new Set(d)];
    } else if (a === '--start' && argv[i+1]) out.start = argv[++i];
    else if (a === '--end' && argv[i+1]) out.end = argv[++i];
  }
  return out;
}

function resolveRequestedWindows(extraDays=[]) {
  return [...new Set([7,28,90,365,...(extraDays||[])])].sort((a,b)=>a-b);
}

function isValidYmdString(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s||''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
}

function validateDateArgs(parsed, safeEndDate) {
  if (parsed.start && !isValidYmdString(parsed.start)) throw new Error(`Invalid --start date: ${parsed.start}. Use YYYY-MM-DD.`);
  if (parsed.end && !isValidYmdString(parsed.end)) throw new Error(`Invalid --end date: ${parsed.end}. Use YYYY-MM-DD.`);
  const requestedEnd = parsed.end || safeEndDate;
  const endDate = requestedEnd > safeEndDate ? safeEndDate : requestedEnd;
  if (parsed.start && parsed.start > endDate) throw new Error(`--start (${parsed.start}) cannot be after effective --end (${endDate}).`);
  return {startDate:parsed.start||null,endDate,requestedEndDate:requestedEnd,wasFutureEndClamped:requestedEnd!==endDate};
}

function log(level, message, data = null) {
  const row = { at: new Date().toISOString(), level, message, data };
  runtimeLog.push(row);
  const prefix = level === 'ERROR' ? '[ERROR]' : level === 'WARN' ? '[WARN]' : '[INFO]';
  console.log(`${prefix} ${message}`);
}

function phase(n, total, text) {
  console.log(`\n[${String(n).padStart(2,'0')}/${String(total).padStart(2,'0')}] ${text}`);
}

function ensureDirs() {
  for (const dir of [CACHE_DIR, HISTORY_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function acquireLock() {
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const stale = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (stale?.pid && isPidAlive(stale.pid)) {
        throw new Error(`Another V4 run is active (PID ${stale.pid}, Run ${stale.runId || 'unknown'}).`);
      }
      fs.unlinkSync(LOCK_PATH);
      log('WARN', 'Removed stale V4 lock file from a previous interrupted run.');
    } catch (e) {
      if (String(e.message || '').includes('Another V4 run is active')) throw e;
      try {
        fs.unlinkSync(LOCK_PATH);
        log('WARN', 'Removed unreadable stale V4 lock file.');
      } catch {
        throw new Error(`Cannot clear stale lock file: ${LOCK_PATH}`);
      }
    }
  }

  try {
    lockFd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(lockFd, JSON.stringify({
      runId: RUN_ID,
      pid: process.pid,
      startedAt: new Date().toISOString()
    }));
  } catch (e) {
    throw new Error(`Could not create V4 lock file: ${e.message}`);
  }
}

function releaseLock() {
  try { if (lockFd !== null) fs.closeSync(lockFd); } catch {}
  try { if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH); } catch {}
}

function atomicWrite(filePath, content, encoding='utf8') {
  if ([CREDS_PATH, TOKEN_PATH, EXPECTED_CHANNEL_PATH, SNAPSHOT_PATH, CHANNEL_SNAPSHOT_PATH].includes(path.resolve(filePath))) {
    throw new Error('Protected local file is read-only in this installation: ' + path.basename(filePath));
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, encoding);
  fs.renameSync(tmp, filePath);
}

function hashObject(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('powershell.exe', ['-NoProfile','-Command','Start-Process', target],
        { detached:true, stdio:'ignore', windowsHide:true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached:true, stdio:'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached:true, stdio:'ignore' }).unref();
    }
  } catch (_) {}
}

// ---------- GENERAL UTILS ----------

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function round(v,d=2){ const p=10**d; return Math.round((Number(v)+Number.EPSILON)*p)/p; }
function pct(a,b){ return b>0 ? round((a*100)/b,2) : 0; }
function partsInTimeZone(dateLike, timeZone=ANALYTICS_TIME_ZONE) {
  const d = new Date(dateLike);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23', weekday:'short'
  }).formatToParts(d);
  return Object.fromEntries(parts.map(p=>[p.type,p.value]));
}
function ymdPT(dateLike) {
  const p=partsInTimeZone(dateLike,ANALYTICS_TIME_ZONE);
  return `${p.year}-${p.month}-${p.day}`;
}
function hourPT(dateLike) { return Number(partsInTimeZone(dateLike,ANALYTICS_TIME_ZONE).hour); }
function weekdayPT(dateLike) { return partsInTimeZone(dateLike,ANALYTICS_TIME_ZONE).weekday; }
function dateOnlyLabel(s){ return new Date(`${String(s).slice(0,10)}T00:00:00Z`); }
function addYmdDays(s, days){ const d=dateOnlyLabel(s); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function diffYmdDays(startYmd,endYmd){ return Math.round((dateOnlyLabel(endYmd)-dateOnlyLabel(startYmd))/86400000); }
function daysAgoYmd(days,endYmd){ return addYmdDays(endYmd,-(days-1)); }
function safeAnalyticsEndDate(now=new Date()){ return addYmdDays(ymdPT(now),-1); }
function observedLastDay(queryResult){
  if(!queryResult?.ok)return null;
  const days=(queryResult.rows||[]).map(r=>String(r.day||'')).filter(isValidYmdString).sort();
  return days.length?days[days.length-1]:null;
}

function ageDays(publishedAt, now=new Date()){
  if(!publishedAt) return null;
  return Math.max(0, (now - new Date(publishedAt))/86400000);
}
function median(arr){
  const x=arr.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!x.length)return null;
  const m=Math.floor(x.length/2);
  return x.length%2 ? x[m] : (x[m-1]+x[m])/2;
}
function mean(arr){
  const x=arr.map(Number).filter(Number.isFinite);
  return x.length ? x.reduce((s,v)=>s+v,0)/x.length : null;
}
function percentileRank(value, arr) {
  const x=arr.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!x.length)return null;
  const count=x.filter(v=>v<=value).length;
  return round(count*100/x.length,1);
}
function isoToSeconds(iso){
  if(!iso)return null;
  const m=iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if(!m)return null;
  return n(m[1])*86400+n(m[2])*3600+n(m[3])*60+n(m[4]);
}
function rowsFrom(data){
  const headers=(data.columnHeaders||[]).map(x=>x.name);
  return (data.rows||[]).map(row=>{
    const o={}; headers.forEach((h,i)=>o[h]=row[i]); return o;
  });
}
function csvEscape(v){
  if(v===null||v===undefined)return'';
  const s=typeof v==='object'?JSON.stringify(v):String(v);
  return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
}
function toCsv(rows, headers){
  return [headers.join(','), ...rows.map(r=>headers.map(h=>csvEscape(r[h])).join(','))].join('\r\n');
}
function escHtml(s){
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function durationBucket(s){
  s=n(s);
  if(s<=0)return'unknown';
  if(s<=7)return'01-07s';
  if(s<=12)return'08-12s';
  if(s<=15)return'13-15s';
  if(s<=20)return'16-20s';
  if(s<=30)return'21-30s';
  if(s<=45)return'31-45s';
  if(s<=60)return'46-60s';
  return'61s+';
}
function confidenceGate({views,videoCount=null,coverage=1,days=28,successfulQueries=1,totalQueries=1,privacyThreshold=false,dependencyMissing=false,queryFailed=false,analyticsIncomplete=false}){
  if(analyticsIncomplete)coverage=Math.min(coverage,0.5);
  const levels=['VERY_LOW','LOW','MEDIUM','HIGH'];
  let rank=views<10?0:views<100?1:views<1000?2:3;
  const reasons=[`${views??'unknown'} views`];
  if(!Number.isFinite(views)||views<0){rank=0;reasons.push('Views unavailable');}
  if(videoCount!==null&&videoCount<5){rank=Math.min(rank,1);reasons.push('Cohort below minimum 5');}
  if(videoCount!==null&&videoCount<2){rank=0;reasons.push('Fewer than two videos');}
  if(coverage<0.8){rank=Math.max(0,Math.min(rank-1,1));reasons.push('Incomplete Analytics coverage');}
  if(coverage<=0||successfulQueries<=0){rank=0;reasons.push('No usable coverage/query');}
  if(days<7){rank=Math.min(rank,1);reasons.push('Fewer than seven observed days');}
  if(totalQueries>0&&successfulQueries/totalQueries<0.9){rank=Math.min(rank,1);reasons.push('API success below 90%');}
  if(dependencyMissing||queryFailed){rank=0;reasons.push('Required dependency missing or failed');}
  if(privacyThreshold){rank=Math.min(rank,1);reasons.push('Privacy threshold');}
  return{level:levels[rank],score:[10,30,60,80][rank],reasons,reason:reasons.join('; '),source:'HEURISTIC'};
}

function analyticsFreshness(daily,endDate){
  const observed=observedLastDay(daily);
  const lag=observed?Math.max(0,diffYmdDays(observed,endDate)):null;
  const observedDays=observed?Math.max(0,Math.min(28,28-lag)):0;
  return{apiOk:Boolean(daily?.ok),requestedEndDate:endDate,observedThroughDate:observed,lagDays:lag,observedDays,coverage:observedDays/28,mature:Boolean(daily?.ok&&lag!==null&&lag<=2&&observedDays>=26),source:'DERIVED',note:'Observed channel day is a conservative freshness signal, not a guarantee of completion for every metric.'};
}

function confidenceFromViews(views){
  return confidenceGate({views});
}

function httpStatusOf(e){
  return e?.response?.status || e?.code || null;
}
function retryAfterMs(e){
  const h=e?.response?.headers?.['retry-after'];
  if(!h)return null;
  const secs=Number(h);
  if(Number.isFinite(secs))return secs*1000;
  const t=Date.parse(h);
  return Number.isFinite(t)?Math.max(0,t-Date.now()):null;
}

function isInvalidGoogleTokenError(e) {
  const status = Number(httpStatusOf(e));
  const body = JSON.stringify(e?.response?.data || e?.message || '').toLowerCase();
  return status === 401 ||
    body.includes('invalid_grant') ||
    body.includes('invalid credentials') ||
    body.includes('invalid authentication credentials') ||
    body.includes('token has been expired') ||
    body.includes('token has been revoked');
}

function friendlyGoogleError(e) {
  if (isInvalidGoogleTokenError(e)) {
    return 'Google OAuth token is expired or revoked. Close this window, rename or delete token.local.json, then run V4 again and complete Google authorization. Do NOT delete oauth_client.local.json.';
  }
  return e?.response?.data?.error?.message || e?.message || String(e);
}
function shouldRetry(e){
  const status=Number(httpStatusOf(e));
  const code=String(e?.code||e?.cause?.code||'').toUpperCase();
  if(['ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','ECONNREFUSED','EPIPE','ENOTFOUND','ECONNABORTED'].includes(code))return true;
  if(code.startsWith('UND_ERR_'))return true;
  if([408,425,429,500,502,503,504].includes(status))return true;
  if(status===403){
    const reason=JSON.stringify(e?.response?.data||'').toLowerCase();
    return reason.includes('ratelimit') || reason.includes('userratelimit') || reason.includes('backenderror');
  }
  return false;
}

async function withRetry(name, fn, maxAttempts=4){
  let last;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      const t0=Date.now();
      const value=await fn();
      return { value, attempts:attempt, latencyMs:Date.now()-t0 };
    }catch(e){
      last=e;
      if(attempt>=maxAttempts || !shouldRetry(e))throw e;
      const explicit=retryAfterMs(e);
      const jitter=Math.floor(Math.random()*350);
      const wait=explicit ?? (600*(2**(attempt-1))+jitter);
      log('WARN',`${name}: temporary API error, retry ${attempt}/${maxAttempts-1} after ${wait} ms`);
      await sleep(wait);
    }
  }
  throw last;
}

function cachePath(namespace, key){
  return path.join(CACHE_DIR, `${namespace}-${key}.json`);
}
function readCache(namespace, key, ttlMs){
  if(args.fresh)return null;
  const p=cachePath(namespace,key);
  try{
    const st=fs.statSync(p);
    if(Date.now()-st.mtimeMs>ttlMs)return null;
    const data=JSON.parse(fs.readFileSync(p,'utf8'));
    return data;
  }catch{return null;}
}
function writeCache(namespace,key,data){
  try{ atomicWrite(cachePath(namespace,key),JSON.stringify(data)); }
  catch(e){ fileWarnings.push({type:'CACHE_WRITE_FAILED',file:cachePath(namespace,key),error:e.message}); }
}

async function safeQuery(analytics,name,params,{ttlMs=10*60*1000}={}){
  const key=hashObject({schema:CACHE_SCHEMA_VERSION,channelId:ACTIVE_CHANNEL_ID,params});
  const cached=readCache('analytics',key,ttlMs);
  if(cached){
    queryLog.push({at:new Date().toISOString(),kind:'analytics',name,ok:true,rows:(cached.rows||[]).length,cache:'HIT',attempts:0,latencyMs:0,error:null});
    return {...cached,cache:'HIT'};
  }
  try{
    const result=await withRetry(name,()=>analytics.reports.query(params));
    const rows=rowsFrom(result.value.data);
    const out={ok:true,name,rows,columnHeaders:result.value.data.columnHeaders||[],params,cache:'LIVE'};
    writeCache('analytics',key,out);
    queryLog.push({at:new Date().toISOString(),kind:'analytics',name,ok:true,rows:rows.length,cache:'LIVE',attempts:result.attempts,latencyMs:result.latencyMs,error:null});
    return out;
  }catch(e){
    const msg=friendlyGoogleError(e);
    queryLog.push({at:new Date().toISOString(),kind:'analytics',name,ok:false,rows:0,cache:'MISS',attempts:null,latencyMs:null,error:msg,status:httpStatusOf(e)});
    return{ok:false,name,rows:[],error:msg,params,cache:'MISS',status:httpStatusOf(e)};
  }
}

async function safeApi(name,fn){
  try{
    const result=await withRetry(name,fn);
    queryLog.push({at:new Date().toISOString(),kind:'data-api',name,ok:true,rows:null,cache:'LIVE',attempts:result.attempts,latencyMs:result.latencyMs,error:null});
    return{ok:true,value:result.value,latencyMs:result.latencyMs};
  }catch(e){
    const msg=friendlyGoogleError(e);
    queryLog.push({at:new Date().toISOString(),kind:'data-api',name,ok:false,rows:null,cache:'MISS',attempts:null,latencyMs:null,error:msg,status:httpStatusOf(e)});
    return{ok:false,error:msg,status:httpStatusOf(e)};
  }
}

// ---------- AUTH ----------

function normalizeClientCredentials(raw){
  const src=raw?.installed||raw?.web||raw;
  const client_id=src?.client_id;
  const client_secret=src?.client_secret;
  if(!client_id||!client_secret)throw new Error('oauth_client.local.json does not contain client_id/client_secret. Flat, Google "installed", and Google "web" JSON formats are supported.');
  return{client_id,client_secret};
}

async function loadClient(){
  if(!fs.existsSync(CREDS_PATH)){
    throw new Error(`OAuth credentials file is missing: ${CREDS_PATH}. Copy the working oauth_client.local.json from V2/V3 into this folder. For security, V4.3.1 does not ask for Client Secret in visible console input.`);
  }
  return normalizeClientCredentials(JSON.parse(fs.readFileSync(CREDS_PATH,'utf8')));
}

function oauthStateMatches(expected,actual){
  if(!expected||!actual)return false;
  const a=Buffer.from(String(expected)); const b=Buffer.from(String(actual));
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

async function authorize(client){
  if(fs.existsSync(TOKEN_PATH)){
    const oauth=new google.auth.OAuth2(client.client_id,client.client_secret,'http://127.0.0.1');
    oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH,'utf8')));
    // Refresh credentials in memory only; preserve the user's existing token file.
    return oauth;
  }

  return new Promise((resolve,reject)=>{
    const server=http.createServer();
    server.listen(0,'127.0.0.1',()=>{
      const port=server.address().port;
      const redirectUri=`http://127.0.0.1:${port}/oauth2callback`;
      const oauth=new google.auth.OAuth2(client.client_id,client.client_secret,redirectUri);
      const expectedState=crypto.randomBytes(32).toString('base64url');
      const authUrl=oauth.generateAuthUrl({
        access_type:'offline',prompt:'consent',include_granted_scopes:true,scope:SCOPES,state:expectedState
      });
      console.log('\nOpening Google authorization...');
      console.log('If it does not open, copy the full URL into Chrome:\n');
      console.log(authUrl+'\n');
      openBrowser(authUrl);

      server.on('request',async(req,res)=>{
        try{
          const u=new URL(req.url,`http://127.0.0.1:${port}`);
          if(u.pathname!=='/oauth2callback'){res.writeHead(404);res.end('Not found');return;}
          if(!oauthStateMatches(expectedState,u.searchParams.get('state')))throw new Error('OAuth state validation failed. Authorization callback was rejected.');
          const err=u.searchParams.get('error');
          if(err)throw new Error(`Google authorization error: ${err}`);
          const code=u.searchParams.get('code');
          if(!code)throw new Error('No authorization code returned by Google.');
          const {tokens}=await oauth.getToken(code);
          oauth.setCredentials(tokens);
          atomicWrite(TOKEN_PATH,JSON.stringify(tokens,null,2));
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
          res.end('<html><body style="font-family:Arial;padding:40px"><h2>V4.3.1 FINAL VERIFIED+ access confirmed</h2><p>You can close this tab.</p></body></html>');
          server.close();resolve(oauth);
        }catch(e){
          res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});
          res.end('Authorization error: '+friendlyGoogleError(e));
          server.close();reject(e);
        }
      });
    });
    server.on('error',reject);
  });
}

// ---------- SELF TEST / CHANNEL LOCK ----------

function nodeSelfTest(){
  const major=Number(process.versions.node.split('.')[0]);
  return{
    name:'Node.js version',
    ok:major>=18,
    value:process.versions.node,
    requirement:'Node.js 18+'
  };
}
function writeSelfTest(){
  const p=path.join(ROOT,`.v4-write-test-${process.pid}.tmp`);
  try{
    fs.writeFileSync(p,'ok');
    fs.unlinkSync(p);
    return{name:'Write permission',ok:true,value:ROOT};
  }catch(e){
    return{name:'Write permission',ok:false,value:e.message};
  }
}
function fileSelfTest(file,name){
  return{name,ok:fs.existsSync(file),value:fs.existsSync(file)?'present':'missing'};
}
function enforceExpectedChannel(channel){
  if(!fs.existsSync(EXPECTED_CHANNEL_PATH) && !args.acceptChannel && channel.id !== FANNYFLAY_CHANNEL_ID){
    throw new Error(`WRONG YOUTUBE CHANNEL. This Fannyflay build expects ${FANNYFLAY_CHANNEL_ID}, but Google returned ${channel.snippet?.title||channel.id} (${channel.id}).`);
  }
  if(!fs.existsSync(EXPECTED_CHANNEL_PATH)||args.acceptChannel){
    atomicWrite(EXPECTED_CHANNEL_PATH,JSON.stringify({
      channelId:channel.id,title:channel.snippet?.title||null,
      customUrl:channel.snippet?.customUrl||null,
      lockedAt:new Date().toISOString(),
      buildExpectedChannelId:FANNYFLAY_CHANNEL_ID
    },null,2));
    return{ok:true,status:args.acceptChannel?'RELOCKED':'LOCKED_FIRST_RUN',expected:channel.id,actual:channel.id};
  }
  const expected=JSON.parse(fs.readFileSync(EXPECTED_CHANNEL_PATH,'utf8'));
  if(expected.channelId!==channel.id){
    throw new Error(
      `WRONG YOUTUBE ACCOUNT/CHANNEL. Expected ${expected.title||expected.channelId} (${expected.channelId}) but authorized ${channel.snippet?.title||channel.id} (${channel.id}). `+
      `If this switch is intentional, run with --accept-channel.`
    );
  }
  return{ok:true,status:'MATCH',expected:expected.channelId,actual:channel.id};
}

// ---------- DATA API ----------

async function allUploads(youtube,playlistId,limit=500){
  const out=[];let pageToken;
  while(out.length<limit){
    const r=await withRetry('playlistItems.list',()=>youtube.playlistItems.list({
      part:['contentDetails','snippet'],playlistId,maxResults:Math.min(50,limit-out.length),pageToken
    }));
    out.push(...(r.value.data.items||[]));
    pageToken=r.value.data.nextPageToken;
    if(!pageToken)break;
  }
  queryLog.push({at:new Date().toISOString(),kind:'data-api',name:'all-uploads',ok:true,rows:out.length,cache:'LIVE',attempts:null,latencyMs:null,error:null});
  return out;
}

async function videoDetails(youtube,ids){
  const map={};
  for(let i=0;i<ids.length;i+=50){
    const chunk=ids.slice(i,i+50);
    if(!chunk.length)continue;
    const r=await withRetry('videos.list',()=>youtube.videos.list({
      part:['snippet','contentDetails','statistics','status','topicDetails','recordingDetails','paidProductPlacementDetails'],
      id:chunk
    }));
    for(const v of(r.value.data.items||[])){
      map[v.id]={
        id:v.id,
        title:v.snippet?.title||v.id,
        description:v.snippet?.description||'',
        publishedAt:v.snippet?.publishedAt||null,
        categoryId:v.snippet?.categoryId||null,
        defaultLanguage:v.snippet?.defaultLanguage||null,
        defaultAudioLanguage:v.snippet?.defaultAudioLanguage||null,
        tags:v.snippet?.tags||[],
        durationIso:v.contentDetails?.duration||null,
        durationSeconds:isoToSeconds(v.contentDetails?.duration),
        definition:v.contentDetails?.definition||null,
        caption:v.contentDetails?.caption||null,
        licensedContent:v.contentDetails?.licensedContent??null,
        privacyStatus:v.status?.privacyStatus||null,
        uploadStatus:v.status?.uploadStatus||null,
        embeddable:v.status?.embeddable??null,
        publicStatsViewable:v.status?.publicStatsViewable??null,
        madeForKids:v.status?.madeForKids??null,
        selfDeclaredMadeForKids:v.status?.selfDeclaredMadeForKids??null,
        containsSyntheticMedia:v.status?.containsSyntheticMedia??null,
        license:v.status?.license||null,
        topicCategories:v.topicDetails?.topicCategories||[],
        recordingDate:v.recordingDetails?.recordingDate||null,
        hasPaidProductPlacement:v.paidProductPlacementDetails?.hasPaidProductPlacement??null,
        publicStatisticsAvailability:{viewCount:v.statistics?.viewCount!=null,likeCount:v.statistics?.likeCount!=null,commentCount:v.statistics?.commentCount!=null},
        publicStats:{
          viewCount:n(v.statistics?.viewCount),
          likeCount:n(v.statistics?.likeCount),
          commentCount:n(v.statistics?.commentCount)
        }
      };
    }
  }
  queryLog.push({at:new Date().toISOString(),kind:'data-api',name:'video-details',ok:true,rows:Object.keys(map).length,cache:'LIVE',attempts:null,latencyMs:null,error:null});
  return map;
}

// ---------- SNAPSHOTS ----------

function snapshotAppend(videos){
  return {ok:true,skipped:true,rowsWritten:0,reason:'Existing snapshot file preserved by installation policy.'};
  const at=new Date().toISOString();
  const rows=videos.filter(v=>v.privacyStatus==='public').map(v=>({
    at,runId:RUN_ID,videoId:v.id,title:v.title,publishedAt:v.publishedAt,
    views:n(v.publicStats?.viewCount),likes:n(v.publicStats?.likeCount),comments:n(v.publicStats?.commentCount)
  }));
  try{
    fs.appendFileSync(SNAPSHOT_PATH,rows.map(x=>JSON.stringify(x)).join('\n')+'\n','utf8');
    return{ok:true,rowsWritten:rows.length,at};
  }catch(e){
    fileWarnings.push({type:'SNAPSHOT_WRITE_FAILED',file:SNAPSHOT_PATH,error:e.message});
    return{ok:false,rowsWritten:0,error:e.message,at};
  }
}

function snapshotVelocity(videos, includeCurrent=true){
  const all=[]; let corrupt=0;
  if(fs.existsSync(SNAPSHOT_PATH)){
    const lines=fs.readFileSync(SNAPSHOT_PATH,'utf8').split(/\r?\n/).filter(Boolean);
    for(let i=0;i<lines.length;i++){
      try{all.push(JSON.parse(lines[i]));}
      catch(e){corrupt++;fileWarnings.push({type:'SNAPSHOT_CORRUPT_LINE',lineNumber:i+1,error:e.message});}
    }
  }
  if(includeCurrent){
    const at=new Date().toISOString();
    for(const v of videos.filter(v=>v.privacyStatus==='public')) all.push({
      at,runId:RUN_ID,videoId:v.id,title:v.title,publishedAt:v.publishedAt,
      views:n(v.publicStats?.viewCount),likes:n(v.publicStats?.likeCount),comments:n(v.publicStats?.commentCount),ephemeral:true
    });
  }
  const runs=new Set(all.map(x=>x.runId||x.at)).size;
  const latestIntervalVelocity=[]; const allHistoryVelocity=[];
  const delta=(a,b)=>{
    const hours=(new Date(b.at)-new Date(a.at))/3600000;
    if(hours<=0)return null;
    return{elapsedHours:round(hours,2),viewDelta:n(b.views)-n(a.views),avgViewsPerHour:round((n(b.views)-n(a.views))/hours,3),likeDelta:n(b.likes)-n(a.likes),commentDelta:n(b.comments)-n(a.comments)};
  };
  for(const v of videos){
    const arr=all.filter(x=>x.videoId===v.id).sort((a,b)=>new Date(a.at)-new Date(b.at));
    if(arr.length<2)continue;
    const allD=delta(arr[0],arr[arr.length-1]);
    const latestD=delta(arr[arr.length-2],arr[arr.length-1]);
    if(allD)allHistoryVelocity.push({videoId:v.id,title:v.title,samples:arr.length,...allD});
    if(latestD)latestIntervalVelocity.push({videoId:v.id,title:v.title,samples:arr.length,...latestD});
  }
  latestIntervalVelocity.sort((a,b)=>b.avgViewsPerHour-a.avgViewsPerHour);
  allHistoryVelocity.sort((a,b)=>b.avgViewsPerHour-a.avgViewsPerHour);
  return{runsObserved:runs,corruptLines:corrupt,includesCurrentEphemeralSample:includeCurrent,
    latestIntervalVelocity:latestIntervalVelocity.slice(0,200),allHistoryVelocity:allHistoryVelocity.slice(0,200),
    videoVelocity:latestIntervalVelocity.slice(0,200)};
}

function appendChannelSnapshot(channel) {
  return {ok:true,skipped:true,reason:'Existing channel snapshot file preserved by installation policy.'};
  const row = {
    at: new Date().toISOString(),
    runId: RUN_ID,
    channelId: channel.id,
    title: channel.title,
    subscribers: n(channel.subscribers),
    totalViews: n(channel.totalViews),
    totalVideos: n(channel.totalVideos)
  };
  try {
    fs.appendFileSync(CHANNEL_SNAPSHOT_PATH, JSON.stringify(row) + '\n', 'utf8');
    return { ok: true, row };
  } catch (e) {
    fileWarnings.push({type:'CHANNEL_SNAPSHOT_WRITE_FAILED',file:CHANNEL_SNAPSHOT_PATH,error:e.message});
    return { ok: false, error: e.message, row };
  }
}

function previousChannelDelta(current) {
  if (!fs.existsSync(CHANNEL_SNAPSHOT_PATH)) {
    return { available:false, reason:'No previous channel snapshot.', corruptLines:0 };
  }
  const rows = [];
  let corruptLines = 0;
  const lines = fs.readFileSync(CHANNEL_SNAPSHOT_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let i=0;i<lines.length;i++) {
    try { rows.push(JSON.parse(lines[i])); }
    catch (e) {
      corruptLines++;
      fileWarnings.push({type:'CHANNEL_SNAPSHOT_CORRUPT_LINE',lineNumber:i+1,error:e.message});
    }
  }
  const same = rows.filter(x => x.channelId === current.id && x.runId !== RUN_ID)
    .sort((a,b)=>new Date(a.at)-new Date(b.at));
  if (!same.length) return { available:false, reason:'No previous snapshot for this channel.', corruptLines };
  const prev = same[same.length-1];
  const hours = (new Date() - new Date(prev.at)) / 3600000;
  return {
    available:true,
    previousRunId:prev.runId,
    previousAt:prev.at,
    elapsedHours:round(hours,2),
    viewsDelta:n(current.totalViews)-n(prev.totalViews),
    subscribersDelta:n(current.subscribers)-n(prev.subscribers),
    videosDelta:n(current.totalVideos)-n(prev.totalVideos),
    previous:{views:n(prev.totalViews),subscribers:n(prev.subscribers),videos:n(prev.totalVideos)},
    corruptLines
  };
}

function cleanupOldRunArtifacts() {
  const result = {historyDeleted:0,logsDeleted:0,errors:[]};

  try {
    const dirs = fs.readdirSync(HISTORY_DIR, {withFileTypes:true})
      .filter(d=>d.isDirectory())
      .map(d=>({name:d.name,path:path.join(HISTORY_DIR,d.name),mtime:fs.statSync(path.join(HISTORY_DIR,d.name)).mtimeMs}))
      .sort((a,b)=>b.mtime-a.mtime);
    for (const d of dirs.slice(HISTORY_KEEP_RUNS)) {
      fs.rmSync(d.path,{recursive:true,force:true});
      result.historyDeleted++;
    }
  } catch(e) { result.errors.push(`history cleanup: ${e.message}`); }

  try {
    const files = fs.readdirSync(LOG_DIR, {withFileTypes:true})
      .filter(d=>d.isFile() && d.name.endsWith('.json'))
      .map(d=>({name:d.name,path:path.join(LOG_DIR,d.name),mtime:fs.statSync(path.join(LOG_DIR,d.name)).mtimeMs}))
      .sort((a,b)=>b.mtime-a.mtime);
    for (const f of files.slice(LOG_KEEP_RUNS)) {
      fs.unlinkSync(f.path);
      result.logsDeleted++;
    }
  } catch(e) { result.errors.push(`log cleanup: ${e.message}`); }

  return result;
}

function sparklineSvg(rows, width=900, height=180) {
  const vals=(rows||[]).map(r=>n(r.views));
  if(!vals.length)return '<div class="muted">No daily data.</div>';
  const max=Math.max(1,...vals);
  const min=Math.min(...vals);
  const range=Math.max(1,max-min);
  const pts=vals.map((v,i)=>{
    const x=vals.length===1?0:(i*(width-20)/(vals.length-1))+10;
    const y=height-10-((v-min)/range)*(height-20);
    return `${round(x,1)},${round(y,1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Daily views chart">
    <polyline fill="none" stroke="currentColor" stroke-width="2" points="${pts}"></polyline>
    <line x1="10" y1="${height-10}" x2="${width-10}" y2="${height-10}" stroke="#ddd"></line>
  </svg>`;
}

// ---------- TEXT / TOPIC / DUPLICATES ----------

const STOP=new Set([
  'the','and','for','with','from','this','that','when','what','why','how','your','you','our','are','was','were','have','has',
  'into','about','just','all','new','short','shorts','video','videos','funny','comedy','ai','a','an','of','in','on','to','is','it',
  'и','в','во','на','с','со','для','из','это','как','что','когда','где','почему','или','но','все','ещё','еще'
]);
function tokens(t){
  return String(t||'').toLowerCase().normalize('NFKD')
    .replace(/https?:\/\/\S+/g,' ').replace(/[#@]/g,' ')
    .replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/)
    .filter(x=>x.length>=3&&!STOP.has(x));
}
function jaccard(a,b){
  const A=new Set(a),B=new Set(b);
  if(!A.size||!B.size)return 0;
  let i=0;for(const x of A)if(B.has(x))i++;
  return i/(A.size+B.size-i);
}
function normTitle(t){
  return String(t||'').toLowerCase().replace(/#\w+/g,' ')
    .replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
}
function hashtagCount(t){return(String(t||'').match(/#[\p{L}\p{N}_]+/gu)||[]).length;}
function scriptProfile(t){
  t=String(t||'');
  const c=(t.match(/[\u0400-\u04FF]/g)||[]).length;
  const l=(t.match(/[A-Za-z]/g)||[]).length;
  if(!c&&!l)return'other';
  if(c>l*1.5)return'cyrillic';
  if(l>c*1.5)return'latin';
  return'mixed';
}

function clusterTopics(videos){
  return topicDNA.topicClusters(videos);
}

function duplicateAudit(videos){
  const v=videos.filter(x=>x.privacyStatus==='public');
  const exact=new Map();
  for(const x of v){
    const k=normTitle(x.title);if(!k)continue;
    if(!exact.has(k))exact.set(k,[]);
    exact.get(k).push(x);
  }
  const exactGroups=[...exact.values()].filter(g=>g.length>1).map(g=>g.map(x=>({
    id:x.id,title:x.title,publishedAt:x.publishedAt,views:n(x.publicStats?.viewCount)
  })));
  const near=[];
  for(let i=0;i<v.length;i++)for(let j=i+1;j<v.length;j++){
    const sim=jaccard(tokens(v[i].title),tokens(v[j].title));
    if(sim>=0.72&&normTitle(v[i].title)!==normTitle(v[j].title)){
      near.push({similarityPct:round(sim*100,1),a:{id:v[i].id,title:v[i].title},b:{id:v[j].id,title:v[j].title}});
    }
  }
  return{exactTitleGroups:exactGroups,nearDuplicateTitlePairs:near.slice(0,100)};
}

// ---------- ANALYTICS NORMALIZATION ----------

function cumulativeFromDaily(rows,startDate,observedThroughDate,maxDays=28){
  const out={d1:null,d3:null,d7:null,d14:null,d28:null,availableCalendarDays:0,observedThroughDate:observedThroughDate||null};
  if(!startDate||!observedThroughDate||observedThroughDate<startDate)return out;
  const available=Math.min(maxDays,diffYmdDays(startDate,observedThroughDate)+1);
  out.availableCalendarDays=Math.max(0,available);
  const byDay=new Map((rows||[]).map(r=>[String(r.day),n(r.views)]));
  let cum=0;
  for(let i=0;i<available;i++){
    const day=addYmdDays(startDate,i);
    cum+=byDay.get(day)||0;
    const d=i+1;
    if([1,3,7,14,28].includes(d))out[`d${d}`]=cum;
  }
  return out;
}

function launchStatus(video,requestedEndDate,observedThroughDate){
  if(!video?.publishedAt)return'UNKNOWN';
  const pub=ymdPT(video.publishedAt);
  if(!observedThroughDate||pub>observedThroughDate)return'WAITING_FOR_ANALYTICS';
  const available=diffYmdDays(pub,observedThroughDate)+1;
  if(available<1)return'WAITING_FOR_ANALYTICS';
  if(available<3)return'PARTIAL_D3';
  if(available<7)return'PARTIAL_D7';
  if(available<14)return'PARTIAL_D14';
  if(available<28)return'PARTIAL_D28';
  return'COMPLETE_D28';
}

function choosePerformanceBasis(rows){
  const d7Comparable=rows.filter(r=>Number.isFinite(r.d7Views));
  return d7Comparable.length>=5?'D7_CALENDAR_VIEWS':'VIEWS_PER_DAY';
}

function videoLifecycle(video,curve,observedLastAnalyticsDate,now=new Date()){
  const published=video.publishedAt?ymdPT(video.publishedAt):null;
  const today=ymdPT(now);
  const rows=new Map();
  for(const r of curve?.ok?curve.rows||[]:[]){
    if(isValidYmdString(r.day)&&r.views!==null&&r.views!==undefined&&Number.isFinite(Number(r.views))&&Number(r.views)>=0&&r.day<today)rows.set(r.day,Number(r.views));
  }
  const ownLast=[...rows.keys()].sort().at(-1)||null;
  const through=ownLast&&observedLastAnalyticsDate?(ownLast<observedLastAnalyticsDate?ownLast:observedLastAnalyticsDate):null;
  const milestones={};
  for(const days of [1,3,7,14,28]){
    const target=published?addYmdDays(published,days-1):null;
    let complete=Boolean(curve?.ok&&target&&through&&target<=through),views=0;
    for(let i=0;complete&&i<days;i++){const day=addYmdDays(published,i);if(!rows.has(day))complete=false;else views+=rows.get(day);}
    milestones['d'+days]={status:complete?'COMPLETE':target&&target>=today?'WAITING':'UNKNOWN',views:complete?views:null,targetDate:target};
  }
  let lifecycleState=rows.size?'EARLY_TEST':'WAITING_FOR_ANALYTICS';
  for(const days of [1,3,7,14,28])if(milestones['d'+days].status==='COMPLETE')lifecycleState='D'+days+'_COMPLETE';
  if(milestones.d28.status==='COMPLETE'&&through>addYmdDays(published,27)&&rows.has(addYmdDays(published,28)))lifecycleState='MATURE';
  return{lifecycleState,milestones,observedLastAnalyticsDate:through,coveragePolicy:'Explicit per-video daily rows only; absent interior or trailing dates are UNKNOWN, never zero.'};
}

function durationCohorts(perfRows){
  const map=new Map();
  for(const row of perfRows){if(!map.has(row.durationBucket))map.set(row.durationBucket,[]);map.get(row.durationBucket).push(row);}
  const groups=[...map].map(([bucket,items])=>{
    const mature=items.filter(r=>r.milestones?.d7.status==='COMPLETE'&&Number.isFinite(r.milestones.d7.views));
    const values=mature.map(r=>r.milestones.d7.views),count=values.length;
    let rank=count<2?0:count<5?1:count<10?1:count<30?2:3;
    const coverage=items.length?count/items.length:0;
    const failed=items.some(r=>r.launchDataStatus==='API_ERROR');
    if(failed||coverage<.8)rank=Math.max(0,rank-1);
    const medianD7=count?median(values):null;
    const confidence={level:['VERY_LOW','LOW','MEDIUM','HIGH'][rank],score:[10,30,60,80][rank],reason:`${count} mature D7 videos; ${round(coverage*100)}% cohort coverage${failed?'; failed Analytics query':''}`};
    const reliable=count>=5&&coverage>=.8&&!failed;
    return{bucket,key:bucket,count:items.length,matureD7Count:count,medianD7,medianD7Views:medianD7,medianViewsPerDay:median(items.map(r=>r.viewsPerDay).filter(Number.isFinite)),confidence,reliable,comparisonBasis:'D7_CALENDAR_VIEWS',comparableCount:count,videosWithD7Data:count,rankingMedian:medianD7,coverage};
  }).sort((a,b)=>(b.medianD7??-Infinity)-(a.medianD7??-Infinity));
  return{groups,reliableRank:groups.filter(x=>x.reliable),exploratoryRank:groups.filter(x=>!x.reliable),methodology:{minimumMatureD7Count:5,minimumCoverage:.8,missingDays:'UNKNOWN; no zero imputation',comparisonUnit:'D7 Pacific calendar views',matureLifecycle:'MATURE requires completed D28 and an observed day beyond D28; 28-day launch queries normally stop at D28_COMPLETE.'}};
}

function durationRecommendation(analysis){
  const best=[...(analysis.reliableRank||[]),...(analysis.exploratoryRank||[])].filter(x=>Number.isFinite(x.medianD7)).sort((a,b)=>b.medianD7-a.medianD7)[0];
  if(!best)return null;
  return{priority:'P1',code:'DURATION_HYPOTHESIS',confidence:best.confidence,evidence:best,text:best.reliable?`${best.bucket} has the highest observed median D7 among eligible cohorts. This is a historical association, not a causal best-format claim.`:`${best.bucket} currently has a high observed median, but the mature sample or data quality is insufficient for a reliable conclusion. Exploratory hypothesis only.`};
}

function buildPerformanceRows(videos,launchCurves,topicInfo,observedThroughDate){
  const now=new Date();
  const rows=videos.filter(v=>v.privacyStatus==='public').map(v=>{
    const exactAge=Math.max(0.05,ageDays(v.publishedAt,now)??0.05);
    const curve=launchCurves[v.id];
    const publishDate=v.publishedAt?ymdPT(v.publishedAt):null;
    const lifecycle=videoLifecycle(v,curve,observedThroughDate,now);
    const c=Object.fromEntries([1,3,7,14,28].map(d=>['d'+d,lifecycle.milestones['d'+d].views]));
    c.availableCalendarDays=lifecycle.observedLastAnalyticsDate&&publishDate?Math.max(0,diffYmdDays(publishDate,lifecycle.observedLastAnalyticsDate)+1):0;
    const lifetime=n(v.publicStats?.viewCount);
    return{
      id:v.id,title:v.title,publishedAt:v.publishedAt,publishDatePacific:publishDate,...lifecycle,
      ageDays:round(exactAge,2),durationSeconds:v.durationSeconds,durationBucket:durationBucket(v.durationSeconds),
      topicCluster:topicInfo.byVideo[v.id]||'unclustered',lifetimeViews:lifetime,viewsPerDay:round(lifetime/exactAge,3),
      d1Views:c.d1,d3Views:c.d3,d7Views:c.d7,d14Views:c.d14,d28Views:c.d28,
      availableAnalyticsCalendarDays:c.availableCalendarDays,
      launchDataStatus:curve?.ok?(curve.status||'OK'):curve?'API_ERROR':'NOT_QUERIED',
      calendarBucketWarning:'D1/D3/D7/D14/D28 use YouTube Analytics Pacific-Time calendar days, not exact rolling 24-hour windows.'
    };
  });
  const basis=choosePerformanceBasis(rows);
  const baseline=basis==='D7_CALENDAR_VIEWS'?rows.map(r=>r.d7Views).filter(Number.isFinite):rows.map(r=>r.viewsPerDay).filter(Number.isFinite);
  for(const r of rows){
    if(basis==='D7_CALENDAR_VIEWS'){
      if(Number.isFinite(r.d7Views)){
        r.comparisonBasis=basis;r.comparisonValue=r.d7Views;r.performancePercentile=percentileRank(r.d7Views,baseline);r.comparableForWinnerLoser=true;r.confidence=confidenceFromViews(r.d7Views);
      }else{
        r.comparisonBasis='INSUFFICIENT_D7_COVERAGE';r.comparisonValue=null;r.performancePercentile=null;r.comparableForWinnerLoser=false;r.confidence=confidenceFromViews(r.lifetimeViews);
      }
    }else{
      const eligible=r.milestones.d1.status==='COMPLETE';
      r.comparisonBasis=basis;r.comparisonValue=eligible?r.viewsPerDay:null;r.performancePercentile=eligible?percentileRank(r.viewsPerDay,baseline):null;r.comparableForWinnerLoser=eligible;r.confidence=confidenceFromViews(eligible?r.lifetimeViews:0);
    }
  }
  return rows;
}

function aggregatePerformance(perfRows,keyFn,basis=choosePerformanceBasis(perfRows)){
  const m=new Map();
  for(const r of perfRows){const k=keyFn(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}
  const result=[...m.entries()].map(([key,items])=>{
    const values=basis==='D7_CALENDAR_VIEWS'?items.map(x=>x.d7Views).filter(Number.isFinite):items.map(x=>x.viewsPerDay).filter(Number.isFinite);
    return{
      key,count:items.length,comparisonBasis:basis,comparableCount:values.length,
      rankingMedian:values.length?round(median(values),3):null,
      medianD7Views:(()=>{const a=items.map(x=>x.d7Views).filter(Number.isFinite);return a.length?median(a):null;})(),
      videosWithD7Data:items.filter(x=>Number.isFinite(x.d7Views)).length,
      medianViewsPerDay:round(median(items.map(x=>x.viewsPerDay))||0,3),
      medianLifetimeViews:median(items.map(x=>x.lifetimeViews)),
      basisNote:basis==='D7_CALENDAR_VIEWS'?'All groups ranked only by D7 calendar views.':'All groups ranked only by lifetime views/day fallback.'
    };
  });
  return result.sort((a,b)=>{
    if(a.rankingMedian===null&&b.rankingMedian===null)return 0;
    if(a.rankingMedian===null)return 1;if(b.rankingMedian===null)return-1;
    return b.rankingMedian-a.rankingMedian;
  });
}

function winnerLoserDNA(perfRows,videos=[],topic={familiesByVideo:{}},duplicate={},upload={}){
  return topicDNA.winnerLoser(perfRows,videos,topic,duplicate,upload).legacy;
}

function chooseLaunchCurveCandidates(videos,limit=200){
  const publicVideos=videos.filter(v=>v.privacyStatus==='public'&&v.publishedAt);
  if(publicVideos.length<=limit)return publicVideos.map(v=>v.id);
  const newest=[...publicVideos].sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt)).slice(0,60);
  const oldest=[...publicVideos].sort((a,b)=>new Date(a.publishedAt)-new Date(b.publishedAt)).slice(0,30);
  const top=[...publicVideos].sort((a,b)=>n(b.publicStats?.viewCount)-n(a.publicStats?.viewCount)).slice(0,40);
  const evenly=[]; const sorted=[...publicVideos].sort((a,b)=>new Date(a.publishedAt)-new Date(b.publishedAt));
  const needed=Math.max(0,limit-new Set([...newest,...oldest,...top].map(v=>v.id)).size);
  for(let i=0;i<needed;i++){const idx=Math.floor(i*(sorted.length-1)/Math.max(1,needed-1));evenly.push(sorted[idx]);}
  return[...new Set([...newest,...oldest,...top,...evenly].map(v=>v.id))].slice(0,limit);
}

// ---------- METADATA / UPLOAD / DISTRIBUTION ----------

function metadataAudit(videos){
  const rows=videos.filter(v=>v.privacyStatus==='public').map(v=>({
    id:v.id,title:v.title,titleLength:v.title.length,
    descriptionLength:(v.description||'').length,
    hashtagCount:hashtagCount(`${v.title} ${v.description}`),
    tagCount:(v.tags||[]).length,titleScript:scriptProfile(v.title),
    hasDescription:Boolean((v.description||'').trim()),
    durationSeconds:v.durationSeconds,views:n(v.publicStats?.viewCount)
  }));
  const empty=rows.filter(r=>!r.hasDescription).length;
  const scripts={};rows.forEach(r=>scripts[r.titleScript]=(scripts[r.titleScript]||0)+1);
  const titleLen=rows.map(r=>r.titleLength);
  const score=clamp(Math.round(
    100-pct(empty,Math.max(rows.length,1))*0.35
    -Math.min(20,Math.abs((median(titleLen)||45)-45)*0.35)
    -(Object.keys(scripts).length>2?10:0)
  ),0,100);
  return{officialYouTubeMetric:false,score,publicVideoCount:rows.length,emptyDescriptions:empty,medianTitleLength:median(titleLen),titleScripts:scripts,rows};
}

function uploadPattern(videos,perfRows){
  const perf=new Map(perfRows.map(r=>[r.id,r]));
  const v=videos.filter(x=>x.publishedAt).sort((a,b)=>new Date(a.publishedAt)-new Date(b.publishedAt));
  const gaps=[],bursts=[];
  for(let i=1;i<v.length;i++){
    const gap=(new Date(v[i].publishedAt)-new Date(v[i-1].publishedAt))/60000;
    gaps.push(gap);
    if(gap<=30)bursts.push({
      gapMinutes:round(gap,1),
      first:{id:v[i-1].id,title:v[i-1].title,publishedAt:v[i-1].publishedAt},
      second:{id:v[i].id,title:v[i].title,publishedAt:v[i].publishedAt}
    });
  }
  const byKey=fn=>{
    const m=new Map();
    for(const x of v){const k=fn(x);if(!m.has(k))m.set(k,[]);
      const pr=perf.get(x.id);
      if(pr)m.get(k).push(pr);}
    return[...m.entries()].map(([key,itemsRaw])=>{
      const items=itemsRaw.filter(Boolean);
      const d7=items.map(x=>x.d7Views).filter(Number.isFinite);
      return{
        key,count:items.length,
        medianD7Views:d7.length?median(d7):null,
        medianViewsPerDay:round(median(items.map(x=>x.viewsPerDay))||0,3),
        correlationWarning:'Association only; publication time is not proven causal.'
      };
    });
  };
  return{
    officialYouTubeMetric:false,
    medianGapMinutes:median(gaps),
    burstsUnder30Min:bursts.length,
    burstExamples:bursts.slice(-30).reverse(),
    performanceByPublishHourPacific:byKey(x=>String(hourPT(x.publishedAt)).padStart(2,'0')+':00 PT'),
    performanceByWeekdayPacific:byKey(x=>weekdayPT(x.publishedAt)),
    timezoneNote:'Creator-facing upload pattern uses America/Los_Angeles to align with YouTube Analytics calendar boundaries.'
  };
}

function shareRows(rows){
  const total=(rows||[]).reduce((s,r)=>s+n(r.views),0);
  return(rows||[]).map(r=>({...r,shareOfViewsPct:pct(n(r.views),total)})).sort((a,b)=>n(b.views)-n(a.views));
}

function resultHealth(result,label){
  if(!result)return{ok:false,status:'MISSING',label};
  if(!result.ok)return{ok:false,status:'API_ERROR',label,error:result.error||'Unknown API error'};
  return{ok:true,status:(result.rows||[]).length?'OK':'NO_ROWS',label,rows:(result.rows||[]).length};
}
function buildDependencyHealth({windows,traffic28,playback28,daily365,video365,byContent28}){
  const summary28=windows.find(x=>x.days===28)?.summary;
  const summary365=windows.find(x=>x.days===365)?.summary;
  const h={
    summary28:resultHealth(summary28,'28-day summary'),summary365:resultHealth(summary365,'365-day summary'),
    traffic28:resultHealth(traffic28,'28-day traffic'),daily365:resultHealth(daily365,'365-day daily trend'),
    video365:resultHealth(video365,'365-day per-video'),byContent28:resultHealth(byContent28,'28-day content type')
  };
  const summary28HasRow=Boolean(summary28?.ok && summary28.rows?.length);
  const recentViews=summary28HasRow?n(summary28.rows[0]?.views):null;
  const trafficUsable=Boolean(traffic28?.ok && (recentViews===0 || traffic28.rows?.length));
  const playbackUsable=Boolean(playback28?.ok && (recentViews===0 || playback28.rows?.length));
  h.playback28=resultHealth(playback28,'28-day playback');
  const distributionOk=summary28HasRow && trafficUsable && playbackUsable;
  const summary365HasRow=Boolean(summary365?.ok && summary365.rows?.length);
  h.distribution={ok:distributionOk,status:distributionOk?'OK':'DATA_UNAVAILABLE',requires:['summary28','traffic28','playback28'],reason:distributionOk?null:(!summary28HasRow?'28-day summary has no usable row or failed.':'28-day traffic/playback data is missing or failed.')};
  h.historicalScores={ok:summary365HasRow,status:summary365HasRow?'OK':'DATA_UNAVAILABLE',requires:['summary365']};
  h.performance={ok:Boolean(daily365?.ok),status:daily365?.ok?'OK':'PARTIAL',requires:['daily365']};
  return h;
}

function distributionState(traffic28,summary28,playback28,freshness={mature:false,coverage:0,observedDays:0}){
  const validViews=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x))&&Number(x)>=0;
  const recentViews=summary28?.ok&&summary28.rows?.length&&validViews(summary28.rows[0].views)?Number(summary28.rows[0].views):null;
  const usable=q=>Boolean(q?.ok&&Array.isArray(q.rows)&&(recentViews===0||q.rows.length)&&q.rows.every(r=>validViews(r.views)));
  const sum=(q,key,pattern)=>q?.ok?(q.rows||[]).filter(r=>pattern.test(String(r[key]||'').toUpperCase())).reduce((s,r)=>s+n(r.views),0):null;
  const trafficSignal=sum(traffic28,'insightTrafficSourceType',/^SHORTS(?:_FEED)?$/);
  const playbackSignal=sum(playback28,'insightPlaybackLocationType',/^SHORTS(?:_FEED)?$/);
  const evidence=[];
  const dependenciesOk=recentViews!==null&&usable(traffic28)&&usable(playback28)&&freshness.apiOk!==false;
  const totalsAgree=dependenciesOk&&[traffic28,playback28].every(q=>q.rows.reduce((s,r)=>s+n(r.views),0)===recentViews);
  const conflict=dependenciesOk&&((trafficSignal>0)!==(playbackSignal>0));
  const confidence=confidenceGate({views:recentViews,coverage:freshness.coverage??0,days:freshness.observedDays??0,successfulQueries:[summary28,traffic28,playback28].filter(q=>q?.ok).length,totalQueries:3,dependencyMissing:!dependenciesOk});
  let state;
  if(!dependenciesOk){state='DATA_UNAVAILABLE';evidence.push('Required summary, traffic or playback query failed, is missing or has unusable rows.');}
  else if(recentViews<20){state=conflict?'DISTRIBUTION_AMBIGUOUS':'INSUFFICIENT_SAMPLE';evidence.push('Small recent sample: fewer than 20 views; no categorical feed starvation diagnosis.');}
  else if(conflict){state='DISTRIBUTION_AMBIGUOUS';evidence.push('Traffic source and playback location differ. They describe different dimensions; do not add their counts or infer feed absence.');}
  else if(!freshness.mature||!totalsAgree){state='DISTRIBUTION_AMBIGUOUS';evidence.push('Analytics freshness or breakdown coverage is insufficient for a categorical conclusion.');}
  else if(trafficSignal===0&&playbackSignal===0){state='FEED_STARVED';evidence.push('No Shorts signal in either successful breakdown with sufficient sample and mature observed coverage. Heuristic for this period, not an algorithmic penalty.');}
  else{state='SHORTS_FEED_ACTIVE';evidence.push('Both breakdowns contain a positive Shorts signal.');}
  if(playbackSignal>0)evidence.push(`Playback location reports ${playbackSignal} SHORTS_FEED views; Shorts playback is present.`);
  if(trafficSignal>0)evidence.push(`Traffic sources report ${trafficSignal} Shorts views.`);
  if(conflict&&!evidence.some(x=>x.includes('different dimensions')))evidence.push('The two breakdowns disagree on the Shorts signal; they are different dimensions and are not additive.');
  return{source:'HEURISTIC',officialYouTubeMetric:false,state,finalState:state,recentViews,sampleSize:recentViews,trafficSourceShortsSignal:trafficSignal,playbackLocationShortsSignal:playbackSignal,signalConflict:conflict,evidence,distributionEvidence:evidence,reason:evidence.join(' '),distributionConfidence:confidence,confidence,analyticsFreshness:freshness,freshness,shortsFeedDetected:dependenciesOk?(trafficSignal>0||playbackSignal>0):null,shortsFeedViews:trafficSignal,shortsFeedSharePct:dependenciesOk?pct(trafficSignal,recentViews):null,searchViews:sum(traffic28,'insightTrafficSourceType',/SEARCH/),externalViews:sum(traffic28,'insightTrafficSourceType',/^EXT/)};
}

function dailyAnomalies(rows){
  const r=(rows||[]).map(x=>({...x,views:n(x.views)}));
  if(!r.length)return{};
  const peak=[...r].sort((a,b)=>b.views-a.views)[0];
  let longest=0,cur=0,start=null,best=null;
  for(const x of r){
    if(x.views===0){
      if(cur===0)start=x.day;cur++;
      if(cur>longest){longest=cur;best={start,end:x.day,days:cur};}
    }else cur=0;
  }
  const nonzero=r.filter(x=>x.views>0);
  const med=median(nonzero.map(x=>x.views))||0;
  const spikes=nonzero.filter(x=>x.views>=Math.max(10,med*3)).map(x=>({day:x.day,views:x.views}));
  return{officialYouTubeMetric:false,peakDay:peak,longestZeroStreak:best,spikeDays:spikes.slice(-30)};
}

// ---------- SCORES / RECOMMENDATIONS ----------

function buildScores(report){
  const dep=report.dataQuality?.dependencyHealth||{};
  const dist=report.diagnostics.distribution,topic=report.diagnostics.topicClustering,meta=report.diagnostics.metadataAudit;
  const s365=report.analytics.windows.find(x=>x.days===365)?.summary?.rows?.[0]||{};
  const s28=report.analytics.windows.find(x=>x.days===28)?.summary?.rows?.[0]||{};
  const hist=n(s365.views),recent=n(s28.views);
  let distribution=null;
  if(dep.distribution?.ok && !['DATA_UNAVAILABLE','INSUFFICIENT_SAMPLE','DISTRIBUTION_AMBIGUOUS'].includes(dist.state)){
    distribution=50;if(dist.state==='FEED_STARVED')distribution=15;if(dist.state==='NO_RECENT_DISTRIBUTION')distribution=5;
    if(dist.state==='SHORTS_FEED_ACTIVE')distribution=80;if(dist.state==='SEARCH_DEPENDENT'||dist.state==='EXTERNAL_DEPENDENT')distribution=35;
  }
  let engagement=null,recovery=null;
  if(dep.historicalScores?.ok){
    engagement=clamp(Math.round(Math.min(45,n(s365.likes)*1000/Math.max(1,hist)*2.2)+Math.min(25,n(s365.comments)*1000/Math.max(1,hist)*8)+Math.min(30,n(s365.shares)*1000/Math.max(1,hist)*10)),0,100);
    recovery=clamp(Math.round((hist>1000?35:15)+(n(s365.averageViewPercentage)>=90?25:10)+(topic.topicConsistencyScore<55?10:20)+(dep.distribution?.ok?(recent<100?15:25):0)),0,100);
  }
  const components=[distribution,topic.topicConsistencyScore,meta.score,engagement,recovery];
  const weights=[.35,.20,.15,.15,.15]; let weighted=0,weight=0;
  components.forEach((v,i)=>{if(Number.isFinite(v)){weighted+=v*weights[i];weight+=weights[i];}});
  const overall=weight>=0.75?clamp(Math.round(weighted/weight),0,100):null;
  return{officialYouTubeMetric:false,warning:'V4.3.1 heuristic scores, not official YouTube metrics.',diagnosticStatus:overall===null?'PARTIAL_DATA':'OK',overallChannelHealth:overall,distributionHealth:distribution,topicConsistency:topic.topicConsistencyScore,metadataHygiene:meta.score,engagementQuality:engagement,recoveryPotential:recovery};
}

function legacyRecommendationEngine(report){
  const out=[]; const push=(priority,code,text,evidence,confidence)=>out.push({priority,code,text,evidence,confidence});
  const dep=report.dataQuality?.dependencyHealth||{},dist=report.diagnostics.distribution,topic=report.diagnostics.topicClustering,dup=report.diagnostics.duplicateAudit,up=report.diagnostics.uploadPattern,duration=report.diagnostics.durationPerformance;
  const s28=report.analytics.windows.find(x=>x.days===28)?.summary?.rows?.[0]||{},s365=report.analytics.windows.find(x=>x.days===365)?.summary?.rows?.[0]||{};
  if(dep.distribution?.ok&&(dist.state==='FEED_STARVED'||dist.state==='NO_RECENT_DISTRIBUTION'))push('P0','RESTORE_DISTRIBUTION','Use one tightly defined Shorts concept for the next 10–15 uploads. Watch for Shorts Feed return before changing several variables at once.',dist,dist.confidence);
  if(!dep.distribution?.ok)push('P0','DATA_UNAVAILABLE','Do not diagnose Shorts distribution until the failed 28-day summary/traffic queries succeed.',dep.distribution,{level:'HIGH',score:95});
  if(topic.topicConsistencyScore<55)push('P0','TOPIC_DRIFT','Choose one audience promise and keep topic, character and format stable during the recovery batch.',{score:topic.topicConsistencyScore,dominantSharePct:topic.dominantSharePct,transitionSwitchRatePct:topic.transitionSwitchRatePct},{level:topic.clusters.length>=3?'MEDIUM':'LOW',score:topic.clusters.length>=3?65:35});
  if(dup.exactTitleGroups.length||dup.nearDuplicateTitlePairs.length>2)push('P1','DUPLICATE_PATTERN','Reduce repeated or near-duplicate titles/concepts while keeping the same audience promise.',{exactGroups:dup.exactTitleGroups.length,nearPairs:dup.nearDuplicateTitlePairs.length},{level:'MEDIUM',score:60});
  if(up.burstsUnder30Min>=2)push('P1','UPLOAD_BURSTS','Avoid publishing several Shorts within 30 minutes while testing recovery. Use a cleaner cadence so each upload has an interpretable test window.',{burstsUnder30Min:up.burstsUnder30Min},{level:'MEDIUM',score:55});
  const best=duration.find(x=>Number.isFinite(x.rankingMedian));
  if(best)push('P1','DURATION_HYPOTHESIS',`Historical normalized performance is strongest in ${best.key} using ${best.comparisonBasis}. Treat that as a test hypothesis, not proof of causality.`,best,{level:best.comparableCount>=5?'MEDIUM':'LOW',score:best.comparableCount>=5?65:35});
  if(dep.historicalScores?.ok&&dep.distribution?.ok&&n(s365.views)>1000&&n(s28.views)<100)push('P0','HISTORICAL_COLLAPSE','The channel has proven historical reach but almost no recent distribution. Treat this as a recovery problem rather than a brand-new-channel problem.',{views365:n(s365.views),views28:n(s28.views)},confidenceFromViews(n(s365.views)));
  push('P2','SNAPSHOT_VELOCITY','Run V4.3.1 repeatedly after future uploads. Latest-interval and all-history velocity are stored separately.',{snapshotRuns:report.diagnostics.snapshotVelocity.runsObserved},{level:report.diagnostics.snapshotVelocity.runsObserved>=2?'HIGH':'LOW',score:report.diagnostics.snapshotVelocity.runsObserved>=2?80:25});
  const rank={P0:0,P1:1,P2:2};return out.sort((a,b)=>rank[a.priority]-rank[b.priority]);
}

// ---------- REPORTS ----------

function recommendationEngine(report){
  const dist=report.diagnostics.distribution;
  const out=legacyRecommendationEngine(report).filter(x=>!['DURATION_HYPOTHESIS','TOPIC_DRIFT'].includes(x.code));
  const durationAction=durationRecommendation(report.durationAnalysis||{reliableRank:[],exploratoryRank:[]});
  if(durationAction)out.push(durationAction);
  for(const item of out){
    if(item.priority==='P0'){
      const gate=dist.confidence||confidenceFromViews(dist.recentViews);
      if(!item.confidence||item.confidence.score>gate.score)item.confidence=gate;
      if(gate.level==='VERY_LOW'){
        item.text='Текущая гипотеза ('+item.code+'): недостаточно данных для уверенного вывода. Нужно продолжить наблюдение и проверить зрелую Analytics; причинная связь не установлена.';
        item.hypothesisOnly=true;
      }
    }
  }
  if(['INSUFFICIENT_SAMPLE','DISTRIBUTION_AMBIGUOUS'].includes(dist.state))out.unshift({priority:'P0',code:'DISTRIBUTION_UNCERTAIN',text:'Недостаточно данных: текущая гипотеза о распространении не подтверждена. Нужно продолжить наблюдение. Сигналы traffic source и playback location не позволяют утверждать отсутствие Shorts Feed.',evidence:dist.evidence,confidence:dist.confidence,hypothesisOnly:true});
  return out;
}

function textReport(r){
  const w=d=>r.analytics.windows.find(x=>x.days===d)?.summary?.rows?.[0]||{};
  const sc=r.diagnostics.scores;
  const lines=[
    'FANNYFLAY FINAL V4 HARDENED — PRODUCTION EDITION',
    '================================================',
    '',
    `Run ID: ${r.runId}`,
    `Generated: ${r.generatedAt}`,
    `Channel: ${r.channel.title} (${r.channel.customUrl||'-'})`,
    `Subscribers: ${r.channel.subscribers}`,
    `Public total views: ${r.channel.totalViews}`,
    `Videos: ${r.channel.totalVideos}`,
    `Analytics requested end date: ${r.dataFreshness.requestedAnalyticsEndDate}`,
    `Analytics observed last available date: ${r.dataFreshness.observedLastAvailableDate||'UNKNOWN'}`,
    '',
    'SELF TEST',
    ...r.selfTest.map(x=>`${x.ok?'OK':'FAIL'} | ${x.name}: ${x.value??''}`),
    '',
    'CUSTOM DIAGNOSTIC SCORES (NOT OFFICIAL YOUTUBE METRICS)',
    `Overall channel health: ${sc.overallChannelHealth===null?'UNAVAILABLE':sc.overallChannelHealth+'/100'}`,
    `Distribution health: ${sc.distributionHealth===null?'UNAVAILABLE':sc.distributionHealth+'/100'}`,
    `Topic consistency: ${sc.topicConsistency}/100`,
    `Metadata hygiene: ${sc.metadataHygiene}/100`,
    `Engagement quality: ${sc.engagementQuality===null?'UNAVAILABLE':sc.engagementQuality+'/100'}`,
    `Recovery potential: ${sc.recoveryPotential===null?'UNAVAILABLE':sc.recoveryPotential+'/100'}`,
    '',
    'TRAFFIC STATE',
    `Distribution state: ${r.diagnostics.distribution.state}`,
    `Shorts Feed detected: ${r.diagnostics.distribution.shortsFeedDetected?'YES':'NO'}`,
    `Shorts Feed share: ${r.diagnostics.distribution.shortsFeedSharePct}%`,
    `Confidence: ${r.diagnostics.distribution.confidence.level}`,
    '',
    'DISTRIBUTION EVIDENCE',
    ...(r.diagnostics.distribution.evidence||[]),
    'PERIODS'
  ];
  for(const d of r.analytics.windows.map(x=>x.days)){
    const s=w(d);
    lines.push(`${d}d views: ${n(s.views)} | engaged: ${n(s.engagedViews)} | avg%: ${n(s.averageViewPercentage)} | confidence: ${confidenceFromViews(n(s.views)).level}`);
  }
  if(r.analytics.customRange?.summary){
    const s=r.analytics.customRange.summary.rows?.[0]||{};
    lines.push(`Custom ${r.analytics.customRange.startDate}..${r.analytics.customRange.endDate}: ${n(s.views)} views`);
  }
  lines.push('','TOPIC DIAGNOSTICS',
    `Topic consistency score: ${r.diagnostics.topicClustering.topicConsistencyScore}/100`,
    `Dominant topic share: ${r.diagnostics.topicClustering.dominantSharePct}%`,
    `Topic switch rate: ${r.diagnostics.topicClustering.transitionSwitchRatePct}%`,
    '',
    'RECOMMENDATIONS'
  );
  for(const x of r.recommendations)lines.push(`${x.priority} ${x.code} [${x.confidence?.level||'N/A'}]: ${x.text}`);
  lines.push('','DATA QUALITY',
    `Queries successful: ${r.dataQuality.successfulQueries}`,
    `Queries failed: ${r.dataQuality.failedQueries}`,
    `Cache hits: ${r.dataQuality.cacheHits}`,
    `Snapshot corrupt lines: ${r.diagnostics.snapshotVelocity.corruptLines}`
  );
  for(const x of r.dataQuality.insufficientSampleWarnings)lines.push(`WARN: ${x}`);
  for(const x of r.dataQuality.failures.slice(0,20))lines.push(`FAIL: ${x.name}: ${x.error}`);
  lines.push('','IMPORTANT',
    'engagedViews/views is NOT the exact YouTube Studio "Viewed vs swiped away" metric.',
    'Publish-time, duration and topic relationships are correlations/heuristics, not proven causes.'
  );
  if(r.durationAnalysis){
    lines.push('','DURATION COHORTS — D7 CALENDAR VIEWS');
    for(const g of [...r.durationAnalysis.reliableRank,...r.durationAnalysis.exploratoryRank])lines.push(`${g.bucket}: count=${g.count}, matureD7=${g.matureD7Count}, medianD7=${g.medianD7??'UNKNOWN'}, confidence=${g.confidence.level}, ${g.reliable?'RELIABLE':'EXPLORATORY — hypothesis only'}`);
  }
  return lines.join('\r\n');
}

function htmlReport(r){
  const w=d=>r.analytics.windows.find(x=>x.days===d)?.summary?.rows?.[0]||{};
  const sc=r.diagnostics.scores;
  const traffic=(r.analytics.trafficSources28d.rows||[]).slice(0,12);
  const searchDetail=(r.analytics.trafficSearchDetails28d?.rows||[]).slice(0,12);
  const externalDetail=(r.analytics.trafficExternalDetails28d?.rows||[]).slice(0,12);
  const playback=(r.analytics.playbackLocations28d?.rows||[]).slice(0,12);
  const devices=(r.analytics.devices28d?.rows||[]).slice(0,12);
  const osRows=(r.analytics.operatingSystems28d?.rows||[]).slice(0,12);
  const countries=(r.analytics.countries365d?.rows||[]).slice(0,15);
  const subscribed=(r.analytics.subscribedStatus365d?.rows||[]).slice(0,10);
  const audience=(r.analytics.audienceAgeGender365d?.rows||[]).slice(0,15);
  const recent=(r.inventory.recentUploads||[]).slice(0,20);
  const winners=r.diagnostics.winnerLoserDNA?.winners?.examples||[];
  const losers=r.diagnostics.winnerLoserDNA?.losers?.examples||[];
  const dupExact=r.diagnostics.duplicateAudit?.exactTitleGroups||[];
  const dupNear=r.diagnostics.duplicateAudit?.nearDuplicateTitlePairs||[];
  const meta=r.diagnostics.metadataAudit||{};
  const up=r.diagnostics.uploadPattern||{};
  const duration=(r.diagnostics.durationPerformance||[]).slice(0,12);
  const topicPerf=(r.diagnostics.topicPerformance||[]).slice(0,12);
  const anomalies=r.diagnostics.dailyAnomalies||{};
  const delta=r.changeSincePreviousRun||{};
  const views28=n(w(28).views);
  const confidence=confidenceFromViews(views28);

  const cards=[
    ['Health',sc.overallChannelHealth===null?'UNAVAILABLE':`${sc.overallChannelHealth}/100`],
    ['Distribution',r.diagnostics.distribution.state],
    ['Topic consistency',`${sc.topicConsistency}/100`],
    ['28d views',views28],
    ['365d views',n(w(365).views)],
    ['Recovery potential',sc.recoveryPotential===null?'UNAVAILABLE':`${sc.recoveryPotential}/100`]
  ];

  const lowDataBanner = confidence.score < 60
    ? `<div class="alert"><b>LOW DATA CONFIDENCE — ${escHtml(confidence.level)}</b><br>
       Recent sample: ${views28} views. Fine-grained conclusions should be treated cautiously.</div>`
    : '';

  const deltaHtml = delta.available
    ? `<div class="delta"><b>Since previous run (${escHtml(delta.previousRunId)}):</b>
       views ${delta.viewsDelta>=0?'+':''}${delta.viewsDelta},
       subscribers ${delta.subscribersDelta>=0?'+':''}${delta.subscribersDelta},
       videos ${delta.videosDelta>=0?'+':''}${delta.videosDelta}
       over ${delta.elapsedHours} h.</div>`
    : `<div class="muted">No previous-run channel baseline yet. Run V4 again later to get deltas.</div>`;

  return`<!doctype html><html><head><meta charset="utf-8"><title>Fannyflay V4.3.1 FINAL VERIFIED+</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#f4f6f8;color:#111}
.wrap{max-width:1320px;margin:auto;padding:24px}h1{margin:0 0 8px}.muted{color:#666}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}
.card,section{background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
.card{padding:18px}.big{font-size:27px;font-weight:700;margin-top:8px}
section{padding:20px;margin:16px 0}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{border-bottom:1px solid #eee;text-align:left;padding:9px;vertical-align:top}
.p0{background:#ffe8e8}.p1{background:#fff5d6}.p2{background:#e9f5ff}
.good{color:#18794e}.bad{color:#b42318}
.alert{background:#fff0c2;border:1px solid #f0c36d;padding:14px;border-radius:12px;margin:14px 0}
.delta{background:#eaf7ef;border:1px solid #acd8bd;padding:14px;border-radius:12px;margin:14px 0}
code{background:#f2f2f2;padding:2px 5px;border-radius:5px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}
.small{font-size:12px}.pill{display:inline-block;background:#eef2ff;padding:4px 8px;border-radius:999px;margin:2px}
</style></head><body><div class="wrap">
<h1>Fannyflay V4.3.1 FINAL VERIFIED+</h1>
<div class="muted">Production Edition · Run ${escHtml(r.runId)} · ${escHtml(r.generatedAt)}</div>
${lowDataBanner}
<section><h2>Distribution evidence — HEURISTIC</h2><p>State: ${escHtml(r.diagnostics.distribution.finalState)} · Confidence: ${escHtml(r.diagnostics.distribution.confidence?.level)} · Sample: ${escHtml(r.diagnostics.distribution.sampleSize)}</p><p>Traffic Shorts signal: ${escHtml(r.diagnostics.distribution.trafficSourceShortsSignal??'UNKNOWN')} · Playback Shorts signal: ${escHtml(r.diagnostics.distribution.playbackLocationShortsSignal??'UNKNOWN')}</p><p>Analytics lag: ${escHtml(r.diagnostics.distribution.analyticsFreshness?.lagDays??'UNKNOWN')} days</p><ul>${(r.diagnostics.distribution.evidence||[]).map(x=>`<li>${escHtml(x)}</li>`).join('')}</ul></section>
${deltaHtml}

<div class="cards">${cards.map(c=>`<div class="card"><div class="muted">${escHtml(c[0])}</div><div class="big">${escHtml(c[1])}</div></div>`).join('')}</div>

<section><h2>Daily Views — 365 days</h2>
${sparklineSvg(r.analytics.daily365.rows||[])}
<div class="small muted">Peak: ${escHtml(anomalies.peakDay?.day||'-')} · ${n(anomalies.peakDay?.views)} views. Longest zero streak: ${n(anomalies.longestZeroStreak?.days)} days.</div>
</section>

<section><h2>Self Test</h2><table><tr><th>Check</th><th>Status</th><th>Value</th></tr>
${r.selfTest.map(x=>`<tr><td>${escHtml(x.name)}</td><td class="${x.ok?'good':'bad'}">${x.ok?'OK':'FAIL'}</td><td>${escHtml(x.value??'')}</td></tr>`).join('')}
</table></section>

<section><h2>Priority Action Plan</h2>
${r.recommendations.map(x=>`<div class="${x.priority.toLowerCase()}" style="padding:12px;border-radius:10px;margin:8px 0"><b>${x.priority} · ${escHtml(x.code)} · confidence ${escHtml(x.confidence?.level||'N/A')}</b><br>${escHtml(x.text)}</div>`).join('')}
</section>

<div class="grid2">
<section><h2>Traffic Sources — 28 days</h2>
<table><tr><th>Source</th><th>Views</th><th>Engaged</th><th>Share</th></tr>
${traffic.map(x=>`<tr><td>${escHtml(x.insightTrafficSourceType)}</td><td>${n(x.views)}</td><td>${n(x.engagedViews)}</td><td>${x.shareOfViewsPct||0}%</td></tr>`).join('')}
</table></section>

<section><h2>Metadata Audit</h2>
<p><b>Score:</b> ${n(meta.score)}/100</p>
<p>Public videos: ${n(meta.publicVideoCount)} · Empty descriptions: ${n(meta.emptyDescriptions)} · Median title length: ${escHtml(meta.medianTitleLength)}</p>
<p>Title scripts: ${escHtml(JSON.stringify(meta.titleScripts||{}))}</p>
</section>
</div>

<div class="grid2">
<section><h2>Normalized Winner DNA</h2>
<p class="muted">Prefer D7 views when available; otherwise lifetime views/day.</p>
<table><tr><th>Title</th><th>Basis</th><th>Value</th><th>Percentile</th><th>Duration</th></tr>
${winners.map(x=>`<tr><td>${escHtml(x.title)}</td><td>${escHtml(x.basis)}</td><td>${escHtml(x.value)}</td><td>${escHtml(x.percentile)}</td><td>${n(x.durationSeconds)}s</td></tr>`).join('')}
</table></section>

<section><h2>Normalized Loser DNA</h2>
<table><tr><th>Title</th><th>Basis</th><th>Value</th><th>Percentile</th><th>Duration</th></tr>
${losers.map(x=>`<tr><td>${escHtml(x.title)}</td><td>${escHtml(x.basis)}</td><td>${escHtml(x.value)}</td><td>${escHtml(x.percentile)}</td><td>${n(x.durationSeconds)}s</td></tr>`).join('')}
</table></section>
</div>

<div class="grid2">
<section><h2>Duration Performance</h2>
<p>Reliable and exploratory cohorts — D7 calendar views. Missing dates remain UNKNOWN.</p>
<table><tr><th>Bucket</th><th>Count</th><th>Mature D7</th><th>Median D7</th><th>Median views/day</th><th>Confidence</th><th>Ranking</th></tr>
${duration.map(x=>`<tr><td>${escHtml(x.key)}</td><td>${n(x.count)}</td><td>${n(x.matureD7Count)}</td><td>${escHtml(x.medianD7Views??'UNKNOWN')}</td><td>${escHtml(x.medianViewsPerDay)}</td><td>${escHtml(x.confidence?.level)}</td><td>${x.reliable?'RELIABLE':'EXPLORATORY — hypothesis only'}</td></tr>`).join('')}
</table></section>

<section><h2>Topic Performance</h2>
<table><tr><th>Cluster</th><th>Count</th><th>Median D7</th><th>Median views/day</th></tr>
${topicPerf.map(x=>`<tr><td>${escHtml(x.key)}</td><td>${n(x.count)}</td><td>${escHtml(x.medianD7Views??'-')}</td><td>${escHtml(x.medianViewsPerDay)}</td></tr>`).join('')}
</table></section>
</div>

<div class="grid2">
<section><h2>Duplicate Audit</h2>
<p>Exact title groups: <b>${dupExact.length}</b> · Near-duplicate pairs: <b>${dupNear.length}</b></p>
${dupExact.slice(0,10).map(g=>`<div>${g.map(x=>`<span class="pill">${escHtml(x.title)} (${n(x.views)})</span>`).join('')}</div>`).join('')}
${dupNear.slice(0,10).map(x=>`<div class="small">${x.similarityPct}% — ${escHtml(x.a.title)} ↔ ${escHtml(x.b.title)}</div>`).join('')}
</section>

<section><h2>Upload Pattern</h2>
<p>Median gap: <b>${escHtml(up.medianGapMinutes)}</b> min · Bursts under 30 min: <b>${n(up.burstsUnder30Min)}</b></p>
${(up.burstExamples||[]).slice(0,8).map(x=>`<div class="small">${x.gapMinutes} min — ${escHtml(x.first.title)} → ${escHtml(x.second.title)}</div>`).join('')}
</section>
</div>

<section><h2>Video lifecycle & milestones — DERIVED</h2>
<table><tr><th>Title</th><th>Lifecycle</th><th>D1</th><th>D3</th><th>D7</th><th>D14</th><th>D28</th></tr>${recent.map(x=>`<tr><td>${escHtml(x.title)}</td><td>${escHtml(x.lifecycleState)}</td>${[1,3,7,14,28].map(d=>`<td>${escHtml(x.milestones?.['d'+d]?.status??'UNKNOWN')}: ${escHtml(x.milestones?.['d'+d]?.views??'—')}</td>`).join('')}</tr>`).join('')}</table></section>
<section><h2>Recent Uploads & Freshness</h2>
<table><tr><th>Published</th><th>Title</th><th>Duration</th><th>Public views</th><th>D1</th><th>D7</th><th>Percentile</th><th>Analytics status</th></tr>
${recent.map(x=>`<tr><td>${escHtml(x.publishedAt||'')}</td><td>${escHtml(x.title)}</td><td>${n(x.durationSeconds)}s</td><td>${n(x.publicStats?.viewCount)}</td><td>${escHtml(x.normalizedPerformance?.d1Views??'-')}</td><td>${escHtml(x.normalizedPerformance?.d7Views??'-')}</td><td>${escHtml(x.normalizedPerformance?.performancePercentile??'-')}</td><td>${escHtml(x.analyticsCoverageStatus||'')}</td></tr>`).join('')}
</table></section>

<div class="grid2">
<section><h2>Search Details — 28 days</h2><table><tr><th>Search detail</th><th>Views</th></tr>${searchDetail.map(x=>`<tr><td>${escHtml(x.insightTrafficSourceDetail||'-')}</td><td>${n(x.views)}</td></tr>`).join('')}</table></section>
<section><h2>External Referrers — 28 days</h2><table><tr><th>Referrer</th><th>Views</th></tr>${externalDetail.map(x=>`<tr><td>${escHtml(x.insightTrafficSourceDetail||'-')}</td><td>${n(x.views)}</td></tr>`).join('')}</table></section>
</div>

<div class="grid2">
<section><h2>Playback Locations</h2><table><tr><th>Location</th><th>Views</th></tr>${playback.map(x=>`<tr><td>${escHtml(x.insightPlaybackLocationType||'-')}</td><td>${n(x.views)}</td></tr>`).join('')}</table></section>
<section><h2>Devices / OS</h2><table><tr><th>Device</th><th>Views</th></tr>${devices.map(x=>`<tr><td>${escHtml(x.deviceType||'-')}</td><td>${n(x.views)}</td></tr>`).join('')}</table><p class="small muted">OS: ${osRows.map(x=>`${escHtml(x.operatingSystem||'-')} (${n(x.views)})`).join(' · ')||'No data'}</p></section>
</div>

<div class="grid2">
<section><h2>Top Countries — 365 days</h2><table><tr><th>Country</th><th>Views</th><th>Avg %</th></tr>${countries.map(x=>`<tr><td>${escHtml(x.country||'-')}</td><td>${n(x.views)}</td><td>${escHtml(x.averageViewPercentage??'-')}</td></tr>`).join('')}</table></section>
<section><h2>Audience</h2><p><b>Subscribed status</b></p><table><tr><th>Status</th><th>Views</th></tr>${subscribed.map(x=>`<tr><td>${escHtml(x.subscribedStatus||'-')}</td><td>${n(x.views)}</td></tr>`).join('')}</table><p class="small muted"><b>Age/Gender:</b> ${audience.map(x=>`${escHtml(x.ageGroup||'-')}/${escHtml(x.gender||'-')}: ${escHtml(x.viewerPercentage??'-')}%`).join(' · ')||'Unavailable / privacy threshold'}</p></section>
</div>

<section><h2>Data Quality</h2>
<p>Successful queries: <b>${r.dataQuality.successfulQueries}</b> · Failed: <b>${r.dataQuality.failedQueries}</b> · Cache hits: <b>${r.dataQuality.cacheHits}</b></p>
${r.dataQuality.insufficientSampleWarnings.map(x=>`<div class="p1" style="padding:10px;border-radius:8px;margin:6px 0">${escHtml(x)}</div>`).join('')}
${r.dataQuality.failures.length?`<table><tr><th>Query</th><th>Error</th></tr>${r.dataQuality.failures.slice(0,30).map(x=>`<tr><td>${escHtml(x.name)}</td><td>${escHtml(x.error)}</td></tr>`).join('')}</table>`:'<p>No query failures.</p>'}
</section>

${topicDNA.compactHtml(r,escHtml)}
<section><h2>Metric Integrity</h2>
<p><code>engagedViews</code> is useful but is <b>not</b> the exact Studio "Viewed vs swiped away" percentage.</p>
<p>Topic, duration and publication-time conclusions are local diagnostics/correlations, not proven causal effects.</p>
</section>
</div></body></html>`;
}

// ---------- MAIN ----------

async function main(){
  ensureDirs();
  acquireLock();

  const selfTest=[nodeSelfTest(),writeSelfTest()];
  if(!selfTest[0].ok)throw new Error(`Node.js ${selfTest[0].value} is too old. Node.js 18+ is required.`);
  if(!selfTest[1].ok)throw new Error(`No write permission in ${ROOT}`);

  phase(1,12,'Authorization and self-test');
  const client=await loadClient();
  const auth=await authorize(client);
  selfTest.push(fileSelfTest(CREDS_PATH,'OAuth client file'));
  selfTest.push(fileSelfTest(TOKEN_PATH,'OAuth token file'));
  const youtube=google.youtube({version:'v3',auth});
  const analytics=google.youtubeAnalytics({version:'v2',auth});

  phase(2,12,'Verify channel identity');
  const channelCheck=await safeApi('channels.list',()=>youtube.channels.list({
    part:['snippet','statistics','contentDetails','brandingSettings','status','topicDetails'],mine:true
  }));
  if(!channelCheck.ok)throw new Error(channelCheck.error);
  const c=channelCheck.value.data.items?.[0];
  if(!c)throw new Error('No YouTube channel returned for this Google account.');
  const channelLock=enforceExpectedChannel(c);
  ACTIVE_CHANNEL_ID=c.id;
  selfTest.push({name:'Correct YouTube channel',ok:true,value:`${c.snippet?.title||c.id} — ${channelLock.status}`});
  selfTest.push({name:'YouTube Data API',ok:true,value:`latency ${channelCheck.latencyMs} ms`});

  const channel={
    id:c.id,title:c.snippet?.title||null,customUrl:c.snippet?.customUrl||null,
    description:c.snippet?.description||'',publishedAt:c.snippet?.publishedAt||null,
    country:c.snippet?.country||null,defaultLanguage:c.snippet?.defaultLanguage||null,
    subscribers:n(c.statistics?.subscriberCount),hiddenSubscriberCount:c.statistics?.hiddenSubscriberCount??null,
    totalViews:n(c.statistics?.viewCount),totalVideos:n(c.statistics?.videoCount),
    madeForKids:c.status?.madeForKids??null,selfDeclaredMadeForKids:c.status?.selfDeclaredMadeForKids??null,
    branding:c.brandingSettings||{},topicCategories:c.topicDetails?.topicCategories||[]
  };

  const changeSincePreviousRun = previousChannelDelta(channel);

  phase(3,12,'Read complete video inventory');
  const uploadsId=c.contentDetails?.relatedPlaylists?.uploads;
  const uploads=uploadsId?await allUploads(youtube,uploadsId,500):[];
  const ids=uploads.map(x=>x.contentDetails?.videoId).filter(Boolean);
  const vmap=await videoDetails(youtube,ids);
  const videos=ids.map(id=>vmap[id]).filter(Boolean).sort((a,b)=>new Date(b.publishedAt||0)-new Date(a.publishedAt||0));

  const safeEndDate=safeAnalyticsEndDate(new Date());
  const validatedDates=validateDateArgs(args,safeEndDate);
  const endDate=validatedDates.endDate;
  if(validatedDates.wasFutureEndClamped)log('WARN',`Requested --end ${validatedDates.requestedEndDate} is newer than safe Analytics date ${safeEndDate}; clamped to ${endDate}.`);
  const metrics='views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost';

  phase(4,12,'Read 7/28/90/365 day channel analytics');
  const windows=[];
  const requestedDays=resolveRequestedWindows(args.days);
  for(const days of requestedDays){
    const startDate=daysAgoYmd(days,endDate);
    windows.push({days,startDate,endDate,summary:await safeQuery(analytics,`${days}d-summary`,{ids:'channel==MINE',startDate,endDate,metrics})});
  }
  const analyticsProbe=windows[0]?.summary;
  selfTest.push({name:'YouTube Analytics API',ok:Boolean(analyticsProbe?.ok),value:analyticsProbe?.ok?'connected':analyticsProbe?.error||'failed'});

  let customRange=null;
  if(validatedDates.startDate){
    customRange={
      startDate:validatedDates.startDate,endDate,
      summary:await safeQuery(analytics,'custom-range-summary',{
        ids:'channel==MINE',startDate:validatedDates.startDate,endDate,metrics
      })
    };
  }

  phase(5,12,'Read traffic, devices, audience and geography');
  const daily365=await safeQuery(analytics,'daily-365d',{
    ids:'channel==MINE',startDate:daysAgoYmd(365,endDate),endDate,dimensions:'day',
    metrics:'views,engagedViews,estimatedMinutesWatched,subscribersGained,subscribersLost',sort:'day'
  },{ttlMs:5*60*1000});
  const observedAnalyticsThroughDate=observedLastDay(daily365);
  if(!observedAnalyticsThroughDate)log('WARN','Could not observe the last available Analytics day from daily365; launch milestones will remain UNKNOWN where coverage cannot be proven.');

  const byContent28=await safeQuery(analytics,'content-type-28d',{
    ids:'channel==MINE',startDate:daysAgoYmd(28,endDate),endDate,dimensions:'creatorContentType',metrics,sort:'-views'
  });
  const traffic28=await safeQuery(analytics,'traffic-source-28d',{
    ids:'channel==MINE',startDate:daysAgoYmd(28,endDate),endDate,dimensions:'insightTrafficSourceType',
    metrics:'views,engagedViews,estimatedMinutesWatched,averageViewDuration',sort:'-views'
  });
  const traffic365=await safeQuery(analytics,'traffic-source-365d',{
    ids:'channel==MINE',startDate:daysAgoYmd(365,endDate),endDate,dimensions:'insightTrafficSourceType',
    metrics:'views,engagedViews,estimatedMinutesWatched,averageViewDuration',sort:'-views'
  },{ttlMs:30*60*1000});
  traffic28.rows=shareRows(traffic28.rows);traffic365.rows=shareRows(traffic365.rows);
  const searchDetails28=await safeQuery(analytics,'traffic-search-detail-28d',{ids:'channel==MINE',startDate:daysAgoYmd(28,endDate),endDate,dimensions:'insightTrafficSourceDetail',metrics:'views,engagedViews,estimatedMinutesWatched',filters:'insightTrafficSourceType==YT_SEARCH',sort:'-views',maxResults:50});
  const externalDetails28=await safeQuery(analytics,'traffic-external-detail-28d',{ids:'channel==MINE',startDate:daysAgoYmd(28,endDate),endDate,dimensions:'insightTrafficSourceDetail',metrics:'views,engagedViews,estimatedMinutesWatched',filters:'insightTrafficSourceType==EXT_URL',sort:'-views',maxResults:50});

  const playback28=await safeQuery(analytics,'playback-location-28d',{
    ids:'channel==MINE',startDate:daysAgoYmd(28,endDate),endDate,dimensions:'insightPlaybackLocationType',
    metrics:'views,engagedViews,estimatedMinutesWatched,averageViewDuration',sort:'-views'
  });
  const devices28=await safeQuery(analytics,'device-28d',{
    ids:'channel==MINE',startDate:daysAgoYmd(28,endDate),endDate,dimensions:'deviceType',
    metrics:'views,engagedViews,estimatedMinutesWatched,averageViewDuration',sort:'-views'
  });
  const os28=await safeQuery(analytics,'os-28d',{
    ids:'channel==MINE',startDate:daysAgoYmd(28,endDate),endDate,dimensions:'operatingSystem',
    metrics:'views,engagedViews,estimatedMinutesWatched,averageViewDuration',sort:'-views'
  });
  const countries365=await safeQuery(analytics,'country-365d',{
    ids:'channel==MINE',startDate:daysAgoYmd(365,endDate),endDate,dimensions:'country',
    metrics:'views,engagedViews,estimatedMinutesWatched,averageViewDuration,averageViewPercentage',sort:'-views',maxResults:50
  },{ttlMs:30*60*1000});
  const subscribed365=await safeQuery(analytics,'subscribed-status-365d',{
    ids:'channel==MINE',startDate:daysAgoYmd(365,endDate),endDate,dimensions:'subscribedStatus',
    metrics:'views,engagedViews,estimatedMinutesWatched,averageViewDuration',sort:'-views'
  },{ttlMs:30*60*1000});
  const ageGender365=await safeQuery(analytics,'age-gender-365d',{
    ids:'channel==MINE',startDate:daysAgoYmd(365,endDate),endDate,dimensions:'ageGroup,gender',
    metrics:'viewerPercentage',sort:'-viewerPercentage'
  },{ttlMs:60*60*1000});

  phase(6,12,'Read per-video analytics');
  const video365=await safeQuery(analytics,'videos-365d',{
    ids:'channel==MINE',startDate:daysAgoYmd(365,endDate),endDate,dimensions:'video',
    metrics,sort:'-views',maxResults:200
  },{ttlMs:10*60*1000});

  phase(7,12,'Build launch curves and age-normalized performance');
  const byPublicViews=[...videos].sort((a,b)=>n(b.publicStats?.viewCount)-n(a.publicStats?.viewCount));
  const candidateIds=chooseLaunchCurveCandidates(videos,200);
  const launchCurves={};
  let done=0;
  for(const id of candidateIds){
    const v=vmap[id]; if(!v?.publishedAt)continue;
    const status=launchStatus(v,endDate,observedAnalyticsThroughDate);
    if(status==='WAITING_FOR_ANALYTICS'){
      launchCurves[id]={ok:true,status,rows:[],name:`launch-${id}`};
      continue;
    }
    const start=ymdPT(v.publishedAt);
    const desiredEnd=addYmdDays(start,27);
    const curveEnd=desiredEnd<endDate?desiredEnd:endDate;
    const q=await safeQuery(analytics,`launch-${id}`,{
      ids:'channel==MINE',startDate:start,endDate:curveEnd,dimensions:'day',
      metrics:'views,engagedViews,estimatedMinutesWatched,likes,comments,shares,subscribersGained',
      filters:`video==${id}`,sort:'day'
    },{ttlMs:20*60*1000});
    launchCurves[id]={...q,status};
    done++;
    if(done%10===0)console.log(`  launch curves: ${done}/${candidateIds.length}`);
  }

  const topic=clusterTopics(videos);
  const performanceRows=buildPerformanceRows(videos,launchCurves,topic,observedAnalyticsThroughDate);
  const perfMap=new Map(performanceRows.map(r=>[r.id,r]));
  for(const v of videos){
    const p=perfMap.get(v.id);
    v.analyticsCoverageStatus=launchCurves[v.id]?.status || (ymdPT(v.publishedAt||'1970-01-01')>(observedAnalyticsThroughDate||'0000-00-00')?'WAITING_FOR_ANALYTICS':'NOT_QUERIED');
    v.normalizedPerformance=p||null;
    v.lifecycleState=p?.lifecycleState||'WAITING_FOR_ANALYTICS';
    v.milestones=p?.milestones||null;
    v.analyticsCoverageStatus=v.lifecycleState;
  }

  phase(8,12,'Retention diagnostics');
  const topForRetention=[...new Set([
    ...video365.rows.slice(0,10).map(r=>r.video),
    ...byPublicViews.slice(0,10).map(v=>v.id)
  ])].slice(0,12);
  const retention={};
  for(const id of topForRetention){
    const v=vmap[id]; if(!v)continue;
    retention[id]=await safeQuery(analytics,`retention-${id}`,{
      ids:'channel==MINE',
      startDate:v.publishedAt?ymdPT(v.publishedAt):daysAgoYmd(365,endDate),
      endDate,
      dimensions:'elapsedVideoTimeRatio',
      metrics:'audienceWatchRatio,relativeRetentionPerformance',
      filters:`video==${id}`,sort:'elapsedVideoTimeRatio'
    },{ttlMs:30*60*1000});
  }

  phase(9,12,'Snapshots, duplicates, cadence, topic drift, Winner/Loser DNA');
  const snapshotVel=snapshotVelocity(videos,true);
  const snapshotWrite={ok:null,status:'PENDING_SUCCESSFUL_REPORT_COMMIT'};
  const meta=metadataAudit(videos);
  const dup=duplicateAudit(videos);
  const globalPerformanceBasis=choosePerformanceBasis(performanceRows);
  const durationAnalysis=durationCohorts(performanceRows);
  const durationPerf=durationAnalysis.groups;
  const upload=uploadPattern(videos,performanceRows);
  const topicStage=topicDNA.stage3(videos,performanceRows,topic,durationAnalysis,dup,upload);
  const topicPerf=topicStage.topics.groups;
  const dna=topicStage.legacy;
  topic.clusters=topicStage.topics.groups;
  for(const video of videos){
    Object.assign(video,topic.familiesByVideo[video.id]||{});
    video.publicEngagement=topicDNA.engagement(video);
    if(video.normalizedPerformance){
      const family=topic.familiesByVideo[video.id];
      if(family)Object.assign(video.normalizedPerformance,{seriesFamily:family.seriesFamily,topicCluster:family.topicCluster,formatFamily:family.formatFamily,topicConfidence:family.confidence});
    }
  }
  const anomalies=dailyAnomalies(daily365.rows);
  const distribution=distributionState(traffic28,windows.find(x=>x.days===28)?.summary,playback28,analyticsFreshness(daily365,endDate));

  phase(10,12,'Confidence engine, freshness model and recommendations');
  const currentCapturedAt=new Date().toISOString();
  const recentFreshness=videos.slice(0,30).map(v=>({
    videoId:v.id,title:v.title,publishedAt:v.publishedAt,
    publicViews:n(v.publicStats?.viewCount),
    analyticsCoverageStatus:v.analyticsCoverageStatus,
    note:v.analyticsCoverageStatus==='WAITING_FOR_ANALYTICS'
      ?'Public Data API counter may be newer than Analytics. Missing Analytics coverage is UNKNOWN, not zero.'
      :'Analytics has observed calendar coverage for at least part of this video history.'
  }));

  const report={
    version:4,
    edition:'FANNYFLAY V4.3.1 FINAL VERIFIED+ — Production Edition',
    runId:RUN_ID,
    generatedAt:currentCapturedAt,
    commandOptions:args,
    selfTest,
    channel,
    channelLock,
    changeSincePreviousRun,
    channelSnapshotWrite:{ok:null,status:'PENDING_SUCCESSFUL_REPORT_COMMIT'},
    inventory:{
      allVideos:videos,
      recentUploads:videos.slice(0,100),
      counts:{
        total:videos.length,
        public:videos.filter(x=>x.privacyStatus==='public').length,
        private:videos.filter(x=>x.privacyStatus==='private').length,
        unlisted:videos.filter(x=>x.privacyStatus==='unlisted').length,
        videos60sOrLess:videos.filter(x=>n(x.durationSeconds)<=60).length,
        videos180sOrLess:videos.filter(x=>n(x.durationSeconds)<=180).length,
        shortsClassificationNote:'Duration alone cannot prove Shorts status. Since Oct 15, 2024, eligible square/vertical uploads can be Shorts up to 3 minutes.'
      }
    },
    dataFreshness:{
      publicCountersCapturedAt:currentCapturedAt,
      requestedAnalyticsEndDate:endDate,
      observedLastAvailableDate:observedAnalyticsThroughDate,
      analyticsLastCompleteDate:null,
      analyticsDateSemantics:'observedLastAvailableDate is the latest day actually returned by the daily Analytics query; V4.3.1 does not claim it is globally complete for every metric.',
      analyticsLagWarning:'YouTube Analytics can lag behind public counters, especially for recent uploads.',
      recentVideos:recentFreshness
    },
    analytics:{
      windows,customRange,daily365,byContent28,
      trafficSources28d:traffic28,trafficSources365d:traffic365,
      trafficSearchDetails28d:searchDetails28,trafficExternalDetails28d:externalDetails28,
      playbackLocations28d:playback28,devices28d:devices28,operatingSystems28d:os28,
      countries365d:countries365,subscribedStatus365d:subscribed365,
      audienceAgeGender365d:ageGender365,
      videos365d:video365,
      retention,launchCurves
    },
    normalizedPerformance:{
      comparisonRule:'A single global basis is chosen for the full cohort: D7 calendar views when at least five videos have proven D7 coverage; otherwise lifetime views/day fallback.',
      ageBiasMitigation:true,
      rows:performanceRows
    },
    diagnostics:{
      distribution,
      topicClustering:topic,
      topicPerformance:topicPerf,
      durationPerformance:durationPerf,
      durationPerformanceReliableRank:durationAnalysis.reliableRank,
      durationPerformanceExploratoryRank:durationAnalysis.exploratoryRank,
      metadataAudit:meta,
      duplicateAudit:dup,
      uploadPattern:upload,
      winnerLoserDNA:dna,
      dailyAnomalies:anomalies,
      snapshotWrite,
      snapshotVelocity:snapshotVel
    },
    durationAnalysis,
    topicPerformanceReliableRank:topicStage.topics.reliableRank,
    topicPerformanceExploratoryRank:topicStage.topics.exploratoryRank,
    winnerDNA:topicStage.winnerDNA,
    loserDNA:topicStage.loserDNA,
    contentDirectionEvidence:topicStage.contentDirectionEvidence,
    methodology:{
      officialData:['YouTube Data API v3','YouTube Analytics API v2'],
      analyticsTimeZone:ANALYTICS_TIME_ZONE,
      localHeuristics:[
        'Distribution state','Topic clustering','Topic consistency score','Normalized Winner/Loser DNA',
        'Metadata score','Duplicate similarity','Recovery potential','Channel health score',
        'Duration/topic/publish-time associations'
      ],
      importantLimitations:[
        'engagedViews/views is NOT the exact YouTube Studio Viewed vs swiped away metric.',
        'Analytics can lag behind public counters.',
        'D1/D3/D7/D14/D28 use YouTube Analytics America/Los_Angeles calendar buckets, not exact rolling 24-hour windows.',
        'A missing trailing Analytics day is UNKNOWN until daily channel coverage reaches that date; it is not forced to zero.',
        'Publish-time, duration and topic associations are correlations/heuristics, not proven causes.',
        'Audience/geography/retention can be blank because of privacy thresholds or low sample size.',
        'Local snapshot velocity becomes meaningful only after at least two successful V4.3.1 runs.',
        'Thumbnail impressions/CTR from YouTube Reporting API are not included in this build because they require a separate Reporting API job lifecycle; V4.3.1 does not fabricate those metrics.'
      ]
    }
  };

  const dependencyHealth=buildDependencyHealth({windows,traffic28,playback28,daily365,video365,byContent28});
  const failures=queryLog.filter(x=>!x.ok);
  const sampleWarnings=[];
  const views28=n(windows.find(x=>x.days===28)?.summary?.rows?.[0]?.views);
  if(views28<10)sampleWarnings.push('28-day sample has fewer than 10 views: fine-grained conclusions are VERY LOW confidence.');
  else if(views28<100)sampleWarnings.push('28-day sample has fewer than 100 views: fine-grained conclusions are LOW confidence.');
  if(!ageGender365.ok||!ageGender365.rows.length)sampleWarnings.push('Audience age/gender unavailable or below YouTube privacy/sample thresholds.');
  if(Object.values(retention).every(x=>!x.ok||!x.rows?.length))sampleWarnings.push('Retention rows unavailable for selected videos; likely low sample/privacy threshold or API limitation.');
  if(snapshotVel.runsObserved<2)sampleWarnings.push('Velocity baseline not mature yet. Run V4.3.1 FINAL VERIFIED+ again later to calculate true deltas.');

  report.dataQuality={
    totalQueries:queryLog.length,
    successfulQueries:queryLog.filter(x=>x.ok).length,
    failedQueries:failures.length,
    cacheHits:queryLog.filter(x=>x.cache==='HIT').length,
    liveQueries:queryLog.filter(x=>x.cache==='LIVE').length,
    failures,
    fileWarnings,
    insufficientSampleWarnings:sampleWarnings,
    dependencyHealth,
    queryLog
  };

  report.diagnostics.scores=buildScores(report);
  report.recommendations=recommendationEngine(report);

  phase(11,12,'Generate JSON, TXT, HTML, CSV and run archive');
  atomicWrite(OUT.json,JSON.stringify(report,null,2));
  atomicWrite(OUT.txt,textReport(report));
  atomicWrite(OUT.html,htmlReport(report));

  const videoRows=performanceRows.map(r=>({
    id:r.id,title:r.title,publishedAt:r.publishedAt,ageDays:r.ageDays,
    durationSeconds:r.durationSeconds,durationBucket:r.durationBucket,topicCluster:r.topicCluster,
    lifetimeViews:r.lifetimeViews,viewsPerDay:r.viewsPerDay,
    d1Views:r.d1Views,d3Views:r.d3Views,d7Views:r.d7Views,d14Views:r.d14Views,d28Views:r.d28Views,
    comparisonBasis:r.comparisonBasis,comparisonValue:r.comparisonValue,performancePercentile:r.performancePercentile,
    lifecycleState:r.lifecycleState,d1Status:r.milestones.d1.status,d3Status:r.milestones.d3.status,d7Status:r.milestones.d7.status,d14Status:r.milestones.d14.status,d28Status:r.milestones.d28.status,confidence:r.confidence.level
  }));
  atomicWrite(OUT.videosCsv,toCsv(videoRows,Object.keys(videoRows[0]||{})));
  atomicWrite(OUT.dailyCsv,toCsv(daily365.rows||[],['day','views','engagedViews','estimatedMinutesWatched','subscribersGained','subscribersLost']));
  atomicWrite(OUT.qualityCsv,toCsv(queryLog,['at','kind','name','ok','rows','cache','attempts','latencyMs','status','error']));

  // Commit snapshots only after all primary report files were generated successfully.
  const committedVideoSnapshot=snapshotAppend(videos);
  const committedChannelSnapshot=appendChannelSnapshot(channel);
  report.diagnostics.snapshotWrite=committedVideoSnapshot;
  report.channelSnapshotWrite=committedChannelSnapshot;

  // Rewrite human/master outputs so snapshot commit status is captured in the final report.
  atomicWrite(OUT.json,JSON.stringify(report,null,2));
  atomicWrite(OUT.txt,textReport(report));
  atomicWrite(OUT.html,htmlReport(report));

  const runDir=path.join(HISTORY_DIR,RUN_ID);
  fs.mkdirSync(runDir,{recursive:true});
  for(const [k,p] of Object.entries(OUT)){
    try{fs.copyFileSync(p,path.join(runDir,path.basename(p)));}catch(e){fileWarnings.push({type:'HISTORY_COPY_FAILED',file:p,error:e.message});}
  }
  atomicWrite(path.join(runDir,'run-manifest.json'),JSON.stringify({
    runId:RUN_ID,generatedAt:report.generatedAt,channelId:channel.id,channelTitle:channel.title,
    requestedAnalyticsEndDate:endDate,observedLastAvailableDate:observedAnalyticsThroughDate,files:Object.values(OUT).map(p => path.basename(p))
  },null,2));
  atomicWrite(path.join(LOG_DIR,`${RUN_ID}.json`),JSON.stringify({runId:RUN_ID,runtimeLog,queryLog,fileWarnings},null,2));

  const cleanupResult = cleanupOldRunArtifacts();
  console.log(`  cleanup: history deleted ${cleanupResult.historyDeleted}, logs deleted ${cleanupResult.logsDeleted}`);

  phase(12,12,'Complete');
  console.log('\n============================================');
  console.log(' FANNYFLAY V4.3.1 FINAL VERIFIED+ READY');
  console.log('============================================');
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`Channel: ${channel.title}`);
  console.log(`Health score: ${report.diagnostics.scores.overallChannelHealth===null?'UNAVAILABLE':report.diagnostics.scores.overallChannelHealth+'/100'}`);
  console.log(`Distribution: ${report.diagnostics.distribution.state}`);
  console.log(`Topic consistency: ${report.diagnostics.scores.topicConsistency}/100`);
  console.log(`Successful API queries: ${report.dataQuality.successfulQueries}`);
  console.log(`Failed API queries: ${report.dataQuality.failedQueries}`);
  console.log('\nMASTER FILE TO SEND TO CHATGPT:');
  console.log(OUT.json);
  console.log('\nVISUAL DASHBOARD:');
  console.log(OUT.html);
  console.log('\nDo NOT send token.local.json, oauth_client.local.json or Client Secret.');
  openBrowser(OUT.html);
}

if(require.main===module){
  main()
    .catch(e=>{
      console.error('\nFANNYFLAY V4.3.1 FINAL VERIFIED+ ERROR:',friendlyGoogleError(e));
      try{
        ensureDirs();
        atomicWrite(path.join(LOG_DIR,`${RUN_ID}-FAILED.json`),JSON.stringify({runId:RUN_ID,failedAt:new Date().toISOString(),error:e.stack||e.message,runtimeLog,queryLog,fileWarnings},null,2));
      }catch{}
      process.exitCode=1;
    })
    .finally(()=>releaseLock());
}

module.exports={
  parseArgs,resolveRequestedWindows,isValidYmdString,validateDateArgs,
  ymdPT,hourPT,weekdayPT,addYmdDays,diffYmdDays,daysAgoYmd,safeAnalyticsEndDate,observedLastDay,
  shouldRetry,normalizeClientCredentials,oauthStateMatches,
  cumulativeFromDaily,launchStatus,choosePerformanceBasis,buildPerformanceRows,aggregatePerformance,winnerLoserDNA,chooseLaunchCurveCandidates,
  resultHealth,buildDependencyHealth,distributionState,buildScores,recommendationEngine,snapshotVelocity,
  confidenceFromViews,durationBucket,textReport,htmlReport
};

Object.assign(module.exports,{confidenceGate,analyticsFreshness,videoLifecycle,durationCohorts,durationRecommendation});
