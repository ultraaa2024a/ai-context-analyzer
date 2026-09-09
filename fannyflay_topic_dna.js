'use strict';
// Stage 3: deterministic local text features and descriptive D7 cohort analysis.
const STOP=new Set('the a an and or of in on at to for with from this that these those is are was were be been it its i you your we our they their my me us he she his her as by but not do does did how what why when where who which than then into about just very video videos channel shorts short subscribe subscribed like likes follow comment comments share watch watching thanks thank official hd uhd 4k 1080p 720p copyright rights reserved'.split(' '));
const number=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x))?Number(x):null;
const median=a=>quantile(a,.5);
function quantile(values,p){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const i=(a.length-1)*p,j=Math.floor(i);return a[j]+(a[Math.ceil(i)]-a[j])*(i-j);}
const calendarMonths=new Set();
for(const locale of ['en','ru','es','fr','de'])for(let month=0;month<12;month++)calendarMonths.add(new Intl.DateTimeFormat(locale,{month:'long',day:'numeric',timeZone:'UTC'}).formatToParts(new Date(Date.UTC(2025,month,15))).find(p=>p.type==='month').value.toLowerCase());
function dateOnlyTitle(text){
  const t=String(text||'').normalize('NFKC').toLowerCase().trim();
  if(/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t))return true;
  const m=t.match(/^(?:\d{1,2}\s+)?([\p{L}]+)\s+(?:\d{1,2},?\s+)?\d{4}(?:\s*г\.?)?$/u);
  return Boolean(m&&calendarMonths.has(m[1]));
}
const clean=s=>dateOnlyTitle(s)?'':String(s||'').normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+|www\.\S+/gi,' ').replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,' ').replace(/(?:subscribe|follow|like and|click the|all rights reserved)[^.!?\n]*/gi,' ');
function words(text){return(clean(text).match(/[\p{L}\p{N}]+/gu)||[]).filter(x=>!STOP.has(x)&&x.length>1&&!/^\d+$/.test(x));}
function withoutTags(text){return String(text||'').replace(/#[\p{L}\p{N}_]+/gu,' ');}
function normalizedTitle(title){return words(withoutTags(title)).join(' ');}
function topicFeatures(videos){
  const list=videos.filter(v=>v.privacyStatus==='public').slice().sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const lineDF=new Map(),titleCount=new Map();
  for(const v of list){const title=normalizedTitle(v.title);if(title)titleCount.set(title,(titleCount.get(title)||0)+1);for(const line of new Set(String(v.description||'').split(/\r?\n/).map(clean).map(s=>s.trim()).filter(Boolean)))lineDF.set(line,(lineDF.get(line)||0)+1);}
  const features=list.map(v=>{
    const titleKey=normalizedTitle(v.title);
    const repeated=titleKey&&(titleCount.get(titleKey)||0)>=2&&titleKey.split(' ').length<=4;
    const seriesFamily=repeated?'SERIES: '+titleKey:'NO_SERIES_EVIDENCE';
    const titleTokens=repeated?[]:words(withoutTags(v.title));
    const description=String(v.description||'').split(/\r?\n/).filter(line=>(lineDF.get(clean(line).trim())||0)<Math.max(3,Math.ceil(list.length*.6))).join(' ');
    const descriptionTokens=words(withoutTags(description));
    const hashtags=(String(v.title||'')+' '+description).match(/#[\p{L}\p{N}_]+/gu)||[];
    const hashtagTokens=hashtags.flatMap(words);
    const weights={};
    for(const [ts,w] of [[titleTokens,1],[descriptionTokens,.25],[hashtagTokens,.1]])for(const t of new Set(ts))weights[t]=(weights[t]||0)+w;
    const formatFamily=dateOnlyTitle(v.title)?'DATE_ONLY_TITLE':/\?/.test(v.title||'')?'QUESTION_TITLE':/\b(?:vs|versus)\b/i.test(v.title||'')?'COMPARISON_TITLE':/^\s*\d+\s+/.test(v.title||'')?'NUMBERED_LIST_TITLE':repeated?'REPEATED_SERIES_TITLE':'STATEMENT_TITLE';
    return{videoId:v.id,seriesFamily,formatFamily,weights,titleTokens,descriptionTokens,hashtagTokens,confidence:{level:repeated?'LOW':'VERY_LOW',reason:'Series and format are metadata proxies; actual audiovisual format is not verified.'}};
  });
  const df=new Map();for(const f of features)for(const token of Object.keys(f.weights))df.set(token,(df.get(token)||0)+1);
  for(const f of features){f.discriminators=[];for(const token of Object.keys(f.weights)){const frequent=list.length>=5&&df.get(token)/list.length>=.8;f.weights[token]*=(Math.log((1+list.length)/(1+df.get(token)))+1)*(frequent?.05:1);if(!frequent)f.discriminators.push(token);}}
  return{list,features,methodology:{titleWeight:1,descriptionWeight:.25,hashtagWeight:.1,frequentTokenThreshold:.8,frequentTokenMultiplier:.05,series:'Repeated short normalized title is a series candidate, removed from topic evidence.',format:'Title structure proxy only; no inferred production genre.'}};
}
function cosine(a,b){let dot=0,aa=0,bb=0;for(const [k,x] of Object.entries(a)){aa+=x*x;dot+=x*(b[k]||0);}for(const x of Object.values(b))bb+=x*x;return aa&&bb?dot/Math.sqrt(aa*bb):0;}
function topicClusters(videos){
  const {list,features,methodology}=topicFeatures(videos),groups=[];
  for(let i=0;i<list.length;i++){
    let best=null,bestSimilarity=.32;
    for(const g of groups){const representative=features[g[0]],f=features[i];if(!f.discriminators.some(t=>representative.discriminators.includes(t)))continue;const similarity=cosine(f.weights,representative.weights);if(similarity>bestSimilarity){best=g;bestSimilarity=similarity;}}
    if(best)best.push(i);else groups.push([i]);
  }
  groups.sort((a,b)=>b.length-a.length||String(list[a[0]].id).localeCompare(String(list[b[0]].id)));
  const byVideo={},familiesByVideo={};
  const clusters=groups.map((indices,index)=>{
    const clusterId='T'+String(index+1).padStart(3,'0'),freq={};
    for(const i of indices){byVideo[list[i].id]=clusterId;familiesByVideo[list[i].id]={seriesFamily:features[i].seriesFamily,topicCluster:clusterId,formatFamily:features[i].formatFamily,confidence:features[i].confidence};for(const t of features[i].discriminators)freq[t]=(freq[t]||0)+features[i].weights[t];}
    const keywords=Object.keys(freq).sort((a,b)=>freq[b]-freq[a]||a.localeCompare(b)).slice(0,5);
    const label=keywords.slice(0,3).join(' / ')||'Unresolved topic '+clusterId;
    return{id:clusterId,clusterId,representativeLabel:label,size:indices.length,videoCount:indices.length,sharePct:list.length?indices.length/list.length*100:0,keywords,representativeTitles:indices.slice(0,5).map(i=>list[i].title),videoIds:indices.map(i=>list[i].id),examples:indices.slice(0,5).map(i=>({id:list[i].id,title:list[i].title})),resolved:keywords.length>0};
  });
  const chronological=list.slice().sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt));
  const changes=chronological.slice(1).filter((x,i)=>byVideo[x.id]!==byVideo[chronological[i].id]).length;
  const switchRate=chronological.length>1?changes/(chronological.length-1):0,dominant=clusters[0]?.sharePct||0;
  return{source:'HEURISTIC',officialYouTubeMetric:false,method:'Weighted local TF-IDF cosine; fixed representative prevents transitive chaining.',methodology,clusters,byVideo,familiesByVideo,dominantSharePct:dominant,transitionSwitchRatePct:switchRate*100,topicConsistencyScore:list.length>=5?Math.round(20+dominant*.55+(1-switchRate)*25):null};
}
function cohortConfidence(count,coverage=1,failed=false,views=Infinity){
  let rank=count<2?0:count<10?1:count<30?2:3;
  if(coverage<.8||failed)rank=Math.max(0,rank-1);
  if(views<10)rank=0;else if(views<100)rank=Math.min(rank,1);
  return{level:['VERY_LOW','LOW','MEDIUM','HIGH'][rank],score:[10,30,60,80][rank],reason:`${count} mature videos; ${Math.round(coverage*100)}% usable coverage${failed?'; query failure':''}`,source:'HEURISTIC'};
}
function matureD7(row){return row.milestones?.d7?.status==='COMPLETE'&&Number.isFinite(row.milestones.d7.views)&&row.milestones.d7.views>=0&&!['WAITING_FOR_ANALYTICS','EARLY_TEST'].includes(row.lifecycleState);}
function rankTopics(topic,rows){
  const groups=topic.clusters.map(c=>{
    const items=rows.filter(r=>r.topicCluster===c.clusterId),mature=items.filter(matureD7),values=mature.map(r=>r.milestones.d7.views),coverage=items.length?mature.length/items.length:0,failed=items.some(r=>r.launchDataStatus==='API_ERROR');
    return{...c,key:c.clusterId,count:c.videoCount,matureD7Count:mature.length,medianD7:median(values),medianD7Views:median(values),p25D7:quantile(values,.25),p75D7:quantile(values,.75),medianLifetimeViewsPerDay:median(items.map(r=>r.viewsPerDay)),medianViewsPerDay:median(items.map(r=>r.viewsPerDay)),comparisonBasis:'D7_CALENDAR_VIEWS',confidence:cohortConfidence(mature.length,coverage,failed,values.reduce((a,b)=>a+b,0)),reliable:c.resolved&&mature.length>=5&&coverage>=.8&&!failed,coverage};
  }).sort((a,b)=>(b.medianD7??-Infinity)-(a.medianD7??-Infinity)||a.clusterId.localeCompare(b.clusterId));
  return{groups,reliableRank:groups.filter(g=>g.reliable),exploratoryRank:groups.filter(g=>!g.reliable)};
}
function engagement(video){
  const stats=video.publicStats||{},available=video.publicStatisticsAvailability;
  const read=key=>available&&available[key]===false?null:number(stats[key]);
  const views=read('viewCount'),likes=read('likeCount'),comments=read('commentCount');
  const rate=x=>views>0&&x!==null?x*1000/views:null;
  return{raw:{source:'OFFICIAL_API_RAW',views,likes,comments},source:'DERIVED_FROM_PUBLIC_LIFETIME_STATS',publicLikesPer1000LifetimeViews:rate(likes),publicCommentsPer1000LifetimeViews:rate(comments),confidence:{level:views===null||views<10?'VERY_LOW':views<100?'LOW':views<1000?'MEDIUM':'HIGH'},note:'Lifetime public counters captured now; not D7 engagement and not a causal ranking feature.'};
}
function titleFeatures(title){
  const t=String(title||''),letters=t.match(/[\p{L}]/gu)||[],latin=(t.match(/[A-Za-z]/g)||[]).length,cyrillic=(t.match(/[\u0400-\u04ff]/g)||[]).length;
  const emojis=t.match(/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu)||[];
  return{length:[...t].length,wordCount:(withoutTags(t).match(/[\p{L}\p{N}]+/gu)||[]).length,emojiPresence:emojis.length>0,emojiCount:emojis.length,questionMarkPresence:t.includes('?'),exclamationMarkPresence:t.includes('!'),script:!letters.length?'UNKNOWN':latin/letters.length>.7?'LATIN':cyrillic/letters.length>.7?'CYRILLIC':'OTHER_OR_MIXED'};
}
function categoryCounts(items,key){const m=new Map();for(const item of items){const value=item[key]||'UNKNOWN';m.set(value,(m.get(value)||0)+1);}return[...m].map(([family,count])=>({family,count,sharePct:items.length?100*count/items.length:0})).sort((a,b)=>b.count-a.count||a.family.localeCompare(b.family));}
function winnerLoser(rows,videos,topic,duplicate={},upload={}){
  const byId=new Map(videos.map(v=>[v.id,v])),duplicates=new Set((duplicate.exactTitleGroups||[]).flat().map(x=>x.id));
  const near=new Set((duplicate.nearDuplicateTitlePairs||[]).flatMap(x=>[x.a?.id,x.b?.id]));
  const bursts=new Set((upload.burstExamples||[]).flatMap(x=>[x.first?.id,x.second?.id]));
  const mature=rows.filter(matureD7).map(row=>{const v=byId.get(row.id)||{};return{...row,...(topic.familiesByVideo[row.id]||{}),d7:row.milestones.d7.views,titleFeatures:titleFeatures(v.title||row.title),engagement:engagement(v),duplicateStatus:duplicates.has(row.id)?'NORMALIZED_TITLE_REPEAT':'NO_REPEAT_DETECTED',nearDuplicateStatus:near.has(row.id)?'LEXICAL_NEAR_REPEAT':'NO_NEAR_REPEAT_DETECTED',uploadBurstStatus:bursts.has(row.id)?'BURST':'SINGLE'};}).sort((a,b)=>a.d7-b.d7||String(a.id).localeCompare(String(b.id)));
  const gate=mature.length>=10&&mature[0].d7!==mature.at(-1).d7,q=gate?Math.ceil(mature.length*.2):0;
  const losers=mature.slice(0,q),winners=q?mature.slice(-q):[];
  const ties=gate&&((mature[q]?.d7===mature[q-1]?.d7)||(mature[mature.length-q-1]?.d7===mature[mature.length-q]?.d7));
  const summary=(items,side)=>{
    const percent=key=>items.length?100*items.filter(x=>x.titleFeatures[key]).length/items.length:null;
    const conf=cohortConfidence(items.length,1,!gate||ties,items.reduce((s,r)=>s+r.d7,0));
    return{basis:'D7_CALENDAR_VIEWS',source:'HEURISTIC',relationship:'CORRELATIONAL',matureVideoCount:mature.length,[side==='winner'?'winnerCount':'loserCount']:items.length,count:items.length,comparisonBasis:'D7_CALENDAR_VIEWS',medianComparisonValue:median(items.map(x=>x.d7)),dominantDurations:categoryCounts(items,'durationBucket'),dominantTopics:categoryCounts(items,'topicCluster'),dominantSeries:categoryCounts(items,'seriesFamily'),dominantFormats:categoryCounts(items,'formatFamily'),titleCharacteristics:{medianLength:median(items.map(x=>x.titleFeatures.length)),medianWordCount:median(items.map(x=>x.titleFeatures.wordCount)),emojiPresencePct:percent('emojiPresence'),medianEmojiCount:median(items.map(x=>x.titleFeatures.emojiCount)),questionMarkPct:percent('questionMarkPresence'),exclamationMarkPct:percent('exclamationMarkPresence'),scripts:categoryCounts(items.map(x=>({script:x.titleFeatures.script})),'script')},duplicateCharacteristics:{titleRepeats:categoryCounts(items,'duplicateStatus'),nearRepeats:categoryCounts(items,'nearDuplicateStatus'),uploadBursts:categoryCounts(items,'uploadBurstStatus')},engagementCharacteristics:{source:'DERIVED_FROM_PUBLIC_LIFETIME_STATS',medianPublicLikesPer1000LifetimeViews:median(items.map(x=>x.engagement.publicLikesPer1000LifetimeViews)),medianPublicCommentsPer1000LifetimeViews:median(items.map(x=>x.engagement.publicCommentsPer1000LifetimeViews)),usableRateVideoCount:items.filter(x=>x.engagement.raw.views>=100&&x.engagement.publicLikesPer1000LifetimeViews!==null).length,medianLifetimeViewsPerDay:median(items.map(x=>x.viewsPerDay)),note:'Secondary descriptive lifetime signal only. No D7 likes/comments claim; uneven video age may confound rates.'},confidence:conf,evidence:[gate?`${side==='winner'?'Top':'Bottom'} ${q}/${mature.length} mature videos selected only by D7 calendar views.`:'At least 10 mature videos with distinct D7 values required for percentile DNA.',...(ties?['Boundary ties resolved deterministically by video id; confidence lowered.']:[]),'Lifetime views/day and public engagement did not determine selection.','Title structure and lexical topic labels are metadata proxies, not verified video concepts.'],examples:items.map(x=>({id:x.id,title:x.title,basis:'D7_CALENDAR_VIEWS',value:x.d7,durationSeconds:x.durationSeconds,percentile:side==='winner'?80:20,seriesFamily:x.seriesFamily,topicCluster:x.topicCluster,formatFamily:x.formatFamily,engagement:x.engagement})),videoIds:items.map(x=>x.id)};
  };
  const winnerDNA=summary(winners,'winner'),loserDNA=summary(losers,'loser');
  return{winnerDNA,loserDNA,legacy:{officialYouTubeMetric:false,comparisonBasis:'D7_CALENDAR_VIEWS',comparisonRule:'Top/bottom 20% of mature D7 videos only; at least 10 distinct-sample videos, lifetime signals secondary.',winners:winnerDNA,losers:loserDNA},mature};
}
function contentDirection(topics,duration,dna){
  const recommendedTestFamilies=[],avoidOrDeprioritizeFamilies=[],rationale=['HEURISTIC / CORRELATIONAL: no proven causation. Signals overlap and are not independent experimental evidence.'];
  const win=new Set(dna.winnerDNA.videoIds),lose=new Set(dna.loserDNA.videoIds);
  for(const t of topics.reliableRank){
    const items=dna.mature.filter(x=>x.topicCluster===t.clusterId),winCount=items.filter(x=>win.has(x.id)).length,loseCount=items.filter(x=>lose.has(x.id)).length;
    const durations=duration.reliableRank.filter(d=>items.filter(x=>x.durationBucket===d.bucket).length>=5);
    const engagementCount=items.filter(x=>x.engagement.raw.views>=100&&x.engagement.publicLikesPer1000LifetimeViews!==null).length;
    if(!durations.length||engagementCount<5||Math.max(winCount,loseCount)<2||winCount===loseCount)continue;
    const candidate={topicCluster:t.clusterId,label:t.representativeLabel,durationFamilies:durations.map(d=>d.bucket),matureD7Count:items.length,signals:['RELIABLE_TOPIC','RELIABLE_DURATION','WINNER_LOSER_COMPARISON','PUBLIC_LIFETIME_ENGAGEMENT_COVERAGE'],winnerCount:winCount,loserCount:loseCount,engagementCount,source:'HEURISTIC',relationship:'CORRELATIONAL',confidence:cohortConfidence(items.length),wording:winCount>loseCount?'Candidate for a controlled content test; not a proven winning format.':'Candidate for lower test allocation; not proof the family is intrinsically poor.'};
    (winCount>loseCount?recommendedTestFamilies:avoidOrDeprioritizeFamilies).push(candidate);
  }
  if(!recommendedTestFamilies.length)rationale.push('No family currently satisfies reliable topic + reliable duration + mature Winner/Loser contrast + sufficient public lifetime engagement coverage. No main content direction inferred.');
  rationale.push(`Reliable topics: ${topics.reliableRank.length}; reliable duration cohorts: ${duration.reliableRank.length}; mature D7 sample: ${dna.mature.length}.`);
  return{source:'HEURISTIC',relationship:'CORRELATIONAL',recommendedTestFamilies,avoidOrDeprioritizeFamilies,confidence:{level:recommendedTestFamilies.length?'LOW':'VERY_LOW',reason:'Observational metadata only; controlled validation is needed.'},rationale};
}
function stage3(videos,rows,topic,duration,duplicate,upload){
  const topics=rankTopics(topic,rows),dna=winnerLoser(rows,videos,topic,duplicate,upload);
  for(const group of [dna.winnerDNA,dna.loserDNA])for(const example of group.examples)example.percentile=100*dna.mature.filter(x=>x.d7<=example.value).length/dna.mature.length;
  const direction=contentDirection(topics,duration,dna);
  return{topics,...dna,contentDirectionEvidence:direction};
}
function compactHtml(report,esc){
  const table=groups=>`<table><tr><th>Topic</th><th>Videos / mature D7</th><th>Median / P25 / P75 D7</th><th>Confidence</th></tr>${groups.map(g=>`<tr><td>${esc(g.representativeLabel)}</td><td>${g.videoCount} / ${g.matureD7Count}</td><td>${esc(g.medianD7??'UNKNOWN')} / ${esc(g.p25D7??'UNKNOWN')} / ${esc(g.p75D7??'UNKNOWN')}</td><td>${esc(g.confidence.level)}</td></tr>`).join('')}</table>`;
  const dna=d=>`<p>D7_CALENDAR_VIEWS · mature sample ${d.matureVideoCount} · selected ${d.count} · ${esc(d.confidence.level)}</p><p>Duration: ${esc(d.dominantDurations.map(x=>x.family+' ('+x.count+')').join(', '))}</p><p>Topic / series / format: ${esc([d.dominantTopics,d.dominantSeries,d.dominantFormats].map(a=>a.map(x=>x.family+' ('+x.count+')').join(', ')).join(' / '))}</p><p>Title: median ${esc(d.titleCharacteristics.medianWordCount)} words; emoji ${esc(d.titleCharacteristics.emojiPresencePct)}%; question ${esc(d.titleCharacteristics.questionMarkPct)}%</p><p>DERIVED_FROM_PUBLIC_LIFETIME_STATS: median likes/1000 = ${esc(d.engagementCharacteristics.medianPublicLikesPer1000LifetimeViews??'UNKNOWN')}; comments/1000 = ${esc(d.engagementCharacteristics.medianPublicCommentsPer1000LifetimeViews??'UNKNOWN')}. Not D7 engagement.</p><ul>${d.evidence.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
  if(!report.winnerDNA)return'';
  return`<section><h2>RELIABLE TOPIC DNA</h2>${table(report.topicPerformanceReliableRank||[])}</section><section><h2>EXPLORATORY TOPICS</h2><p>Small or incomplete cohorts: hypotheses only.</p>${table(report.topicPerformanceExploratoryRank||[])}</section><section><h2>WINNER DNA</h2>${dna(report.winnerDNA)}</section><section><h2>LOSER DNA</h2>${dna(report.loserDNA)}</section><section><h2>CONTENT DIRECTION EVIDENCE</h2><p>HEURISTIC / CORRELATIONAL</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(report.contentDirectionEvidence,null,2))}</pre></section>`;
}
module.exports={words,topicFeatures,topicClusters,rankTopics,matureD7,engagement,titleFeatures,winnerLoser,contentDirection,stage3,compactHtml};
