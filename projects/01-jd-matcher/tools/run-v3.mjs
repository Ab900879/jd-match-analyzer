/** 只跑 v3（校准版），与上一轮 v2/v3 数据对比 */
import { loadSdk } from './sdk-loader.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
const { createWorkBuddyCloud } = loadSdk();
const { PROMPTS } = await import('../assets/prompts.js');
const { CASES } = await import('../assets/evalset.js');
const { normalize, evaluateOne } = await import('../assets/judge.js');
const EXPECT = {1:[55,80],2:[40,70],3:[45,70],4:[40,65],5:[30,55],6:[40,65],7:[5,32],8:[40,80],9:[5,28],10:[30,52],11:[52,75],12:[58,80]};
const cloud = createWorkBuddyCloud({endpoint:'https://jd-match-analyzer.app.workbuddy.host',publishableKey:'wbpk_wL6Ac81XPO3S0EeHRzcGEJ_x6tGGNVEdiUWn9o7XdO9RkAE6Q7C5j9q'});
const models = await cloud.llm.models.list();
const model = models.find(m=>m.id==='deepseek-v4-flash');
const out=[];
for (const tc of CASES){
  const p=PROMPTS.v3;
  let text=''; const t0=Date.now();
  try{
    for await (const ch of cloud.llm.chat.completions.create({model:model.id,messages:[{role:'system',content:p.system},{role:'user',content:p.buildUser(tc.jd,tc.resume)}],stream:true,temperature:0.3,response_format:{type:'json_object'}})){
      const d=ch.choices&&ch.choices[0]&&ch.choices[0].delta; if(d&&d.content) text+=d.content;
    }
    const n=normalize(text,'v3'); const m=evaluateOne(n,'v3',tc,EXPECT[tc.no]);
    out.push({case:tc.no,category:tc.category,overall:n.overall,ev:m.evidenceRate,fab:m.fabricateRate,sc:m.schemaRate,sr:m.scoreReasonable,aq:m.actionQuality,pass:m.pass,bad:m.badcases,lat:Date.now()-t0,evidenceCount:n.evidence.length,rewriteCount:n.rewrites.length,actionCount:n.actions.length,rawHead:text.slice(0,400)});
    console.log(`#${tc.no} ${tc.category} score=${n.overall} ${m.pass?'PASS':'FAIL'} ev=${Math.round(m.evidenceRate*100)}% ${Date.now()-t0}ms`);
  }catch(e){ out.push({case:tc.no,category:tc.category,error:String(e&&e.error?e.error.code:e&&e.message),pass:false,overall:null,evidenceRate:0,fabricateRate:1,schemaRate:0,scoreReasonable:0,actionQuality:0,badcases:[{dim:'调用失败',detail:'err'}]}); console.log(`#${tc.no} ERROR`); }
}
const avg=(k)=>out.reduce((s,x)=>s+(x[k]||0),0)/out.length;
const summary={passRate:out.filter(x=>x.pass).length/out.length,evidenceRate:avg('evidenceRate'),fabricateRate:avg('fabricateRate'),schemaRate:avg('schemaRate'),scoreReasonable:avg('scoreReasonable'),actionQuality:avg('actionQuality'),avgLatency:Math.round(avg('lat'))};
writeFileSync(new URL('./eval-v3-calibrated.json',import.meta.url),JSON.stringify({generatedAt:new Date().toISOString(),model:model.id,summary,detail:out},null,2));
console.log('\n== v3 calibrated ==');
console.log(`pass=${(summary.passRate*100).toFixed(0)}% ev=${(summary.evidenceRate*100).toFixed(0)}% fab=${(summary.fabricateRate*100).toFixed(0)}% schema=${(summary.schemaRate*100).toFixed(0)}% scoreOk=${(summary.scoreReasonable*100).toFixed(0)}% action=${(summary.actionQuality*100).toFixed(0)}% lat=${summary.avgLatency}ms`);
