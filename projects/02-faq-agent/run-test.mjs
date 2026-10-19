/**
 * 跑 20 条测试，判定全部由规则完成（不调用模型自评）。
 * 用法: node run-test.mjs [起始序号] [结束序号]
 */
import { loadSdk } from '../01-jd-matcher/tools/sdk-loader.mjs';
import { runAgent, isRefusal } from './agent.mjs';
import { CASES, matchAny } from './cases.mjs';
import { writeFileSync } from 'node:fs';

const CONFIG = {
  endpoint: 'https://jd-match-analyzer.app.workbuddy.host',
  publishableKey: 'wbpk_wL6Ac81XPO3S0EeHRzcGEJ_x6tGGNVEdiUWn9o7XdO9RkAE6Q7C5j9q',
};
const MODEL = process.env.MODEL || 'deepseek-v4-flash';

const { createWorkBuddyCloud } = loadSdk();
const api = createWorkBuddyCloud(CONFIG);

async function chat(messages, retry = 2) {
  let text = '';
  try {
    for await (const ch of api.llm.chat.completions.create({
      model: MODEL,
      messages,
      stream: true,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })) {
      const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
      if (d && d.content) text += d.content;
    }
    return text;
  } catch (e) {
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return chat(messages, retry - 1);
    }
    throw e;
  }
}

const from = Number(process.argv[2] || 1);
const to = Number(process.argv[3] || 20);
const list = CASES.filter((c) => c.no >= from && c.no <= to);

const rows = [];
for (const c of list) {
  const t0 = Date.now();
  let r;
  try {
    r = await runAgent(c.q, { chat, maxSteps: 3 });
  } catch (e) {
    r = { answer: '', trace: [], steps: 0, refused: false, toolCalls: [], error: String(e && e.message) };
  }
  const checks = [];
  if (c.tools) for (const t of c.tools) checks.push({ name: `调用 ${t}`, ok: r.toolCalls.includes(t) });
  if (c.refuse !== undefined) checks.push({ name: c.refuse ? '必须拒答' : '必须正常回答', ok: r.refused === c.refuse });
  if (c.includes && c.includes.length) for (const inc of c.includes) checks.push({ name: `含「${inc}」`, ok: matchAny(r.answer, inc) });

  const pass = checks.every((x) => x.ok);
  rows.push({
    no: c.no,
    group: c.group,
    q: c.q,
    why: c.why,
    answer: r.answer,
    toolCalls: r.toolCalls,
    refused: r.refused,
    steps: r.steps,
    latency: Date.now() - t0,
    checks,
    pass,
    error: r.error || null,
    trace: r.trace,
  });
  const bad = checks.filter((x) => !x.ok).map((x) => x.name).join(',');
  console.log(`#${c.no} ${c.group} ${pass ? 'PASS' : 'FAIL'} tools=[${r.toolCalls.join('|')}] ${Date.now() - t0}ms ${bad ? '未过: ' + bad : ''}`);
  if (!pass) console.log(`    答: ${String(r.answer).slice(0, 120)}`);
}

const total = rows.length;
const passed = rows.filter((x) => x.pass).length;
const byGroup = {};
for (const r of rows) {
  byGroup[r.group] = byGroup[r.group] || { n: 0, pass: 0 };
  byGroup[r.group].n += 1;
  if (r.pass) byGroup[r.group].pass += 1;
}
const refusedRight = rows.filter((r) => r.refused).length;

console.log('\n===== 汇总 =====');
console.log(`命中率 ${passed}/${total} = ${Math.round((passed / total) * 100)}%`);
for (const [g, v] of Object.entries(byGroup)) console.log(`  ${g}: ${v.pass}/${v.n}`);
console.log(`触发拒答/转人工: ${refusedRight}/${total} 条`);

writeFileSync(new URL(`./result-${process.env.TAG || 'r1'}.json`, import.meta.url), JSON.stringify({
  generatedAt: new Date().toISOString(),
  model: MODEL,
  summary: { total, passed, hitRate: passed / total, byGroup, refusedCount: refusedRight },
  rows,
}, null, 2));
console.log('已写 result.json');
