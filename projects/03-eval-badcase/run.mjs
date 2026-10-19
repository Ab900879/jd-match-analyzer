/**
 * 评测主流程：生成回答 → 用 v1 / v2 两套规则分别打分 → 出报告
 * 用法: node run.mjs
 */
import { loadSdk } from '../01-jd-matcher/tools/sdk-loader.mjs';
import { FAQ_KB, ORDERS } from '../02-faq-agent/agent.mjs';
import { CASES } from './cases.mjs';
import { scoreAnswer, isRefusalV3 } from './rules.mjs';
import { writeFileSync } from 'node:fs';

const TAG = process.env.TAG || 'b1';

const CONFIG = {
  endpoint: 'https://jd-match-analyzer.app.workbuddy.host',
  publishableKey: 'wbpk_wL6Ac81XPO3S0EeHRzcGEJ_x6tGGNVEdiUWn9o7XdO9RkAE6Q7C5j9q',
};
const MODEL = process.env.MODEL || 'deepseek-v4-flash';
const { createWorkBuddyCloud } = loadSdk();
const api = createWorkBuddyCloud(CONFIG);

const KB_TEXT = FAQ_KB.map((f) => `- ${f.title}：${f.text}`).join('\n');
const ORDER_TEXT = Object.values(ORDERS)
  .map((o) => `- ${o.id}｜${o.item}｜${o.amount} 元｜${o.status}｜签收 ${o.signedAt || '-'}｜预计送达 ${o.eta || '-'}｜退款 ${o.refundAmount || '-'}｜退款时间 ${o.refundedAt || '-'}｜付款 ${o.paidAt}`)
  .join('\n');

const SYSTEM = `你是电商平台的 AI 客服。只能依据下面的资料回答，资料里没有的内容一律不许编。

## 政策知识库
${KB_TEXT}

## 订单数据
${ORDER_TEXT}

## 硬性要求
1. 回答不超过 150 字，不要用 markdown、不要列项目符号。
2. 先给结论，再给依据。
3. 资料里查不到（订单号不存在、问题超出客服范围、知识库没有对应条款），必须明确说「我这边无法确认」或「建议转人工」，不许猜测。
4. 每条回答都要给出一个具体下一步（申请入口、时限、转人工等）。`;

async function ask(question) {
  let text = '';
  for await (const ch of api.llm.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }],
    stream: true,
    temperature: 0.2,
  })) {
    const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
    if (d && d.content) text += d.content;
  }
  return text.trim();
}

const rows = [];
for (const c of CASES) {
  const t0 = Date.now();
  let answer = '';
  try {
    answer = await ask(c.q);
  } catch (e) {
    answer = `[调用失败] ${String(e && e.message)}`;
  }
  const v1 = scoreAnswer(answer, c, 'v1');
  const v2 = scoreAnswer(answer, c, 'v2');
  // v3 = v2 的证据池 + 第一句主结论的拒答判定（修掉「如订单已超 30 天，我这边无法…」被误判拒答的问题）
  const v3Checks = v2.checks.map((x) => ({ ...x }));
  const ref = v3Checks.find((x) => x.name === '拒答正确');
  if (ref && c.expectRefuse !== undefined) {
    const refused = isRefusalV3(answer);
    ref.ok = refused === c.expectRefuse;
    ref.detail = ok2(ref, c, refused);
  }
  function ok2(r, tc, refused) {
    if (r.ok) return refused ? '正确拒答/转人工' : '正确地给出了答案';
    return refused ? '该回答却拒答了（过度保守）' : '该拒答却编了答案';
  }
  const v3Score = v3Checks.filter((x) => x.ok).reduce((s, x) => s + x.weight, 0);
  const v3Failed = v3Checks.filter((x) => !x.ok);
  const v3 = { checks: v3Checks, score: v3Score, cause: v3Failed.length ? v3Failed[0].name : '通过', failedCount: v3Failed.length };
  rows.push({ ...c, answer, latency: Date.now() - t0, v1, v2, v3 });
  console.log(`#${c.no} ${c.type} v1=${v1.score} v2=${v2.score} v3=${v3.score} ${answer.slice(0, 60).replace(/\n/g, ' ')}`);
}

const avg = (pick) => rows.reduce((s, r) => s + pick(r), 0) / rows.length;
const report = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  ruleVersion: 'v1=证据源仅知识库；v2=证据源含订单库与用户问题',
  summary: {
    v1: { avgScore: +avg((r) => r.v1.score).toFixed(1), passCount: rows.filter((r) => r.v1.score === 100).length, badcase: rows.filter((r) => r.v1.score < 100).length },
    v2: { avgScore: +avg((r) => r.v2.score).toFixed(1), passCount: rows.filter((r) => r.v2.score === 100).length, badcase: rows.filter((r) => r.v2.score < 100).length },
    v3: { avgScore: +avg((r) => r.v3.score).toFixed(1), passCount: rows.filter((r) => r.v3.score === 100).length, badcase: rows.filter((r) => r.v3.score < 100).length },
  },
  causeStat: rows.reduce((m, r) => {
    const k = r.v2.cause;
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {}),
  rows,
};

writeFileSync(new URL(`./batch-${TAG}.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log(`\n===== 汇总（batch ${TAG}）=====`);
console.log(`v1 规则：${report.summary.v1.avgScore} 分，满分 ${report.summary.v1.passCount}/${rows.length}`);
console.log(`v2 规则：${report.summary.v2.avgScore} 分，满分 ${report.summary.v2.passCount}/${rows.length}`);
console.log(`v3 规则：${report.summary.v3.avgScore} 分，满分 ${report.summary.v3.passCount}/${rows.length}`);
console.log('已写 batch-' + TAG + '.json');
