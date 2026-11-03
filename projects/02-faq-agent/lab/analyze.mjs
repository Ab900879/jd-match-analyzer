/**
 * 四组结果分析：把 lab-result.json 算成能写进报告的那几张表。
 *
 * 三件容易虚高的事，这里都要扣掉：
 *   1. 零检查项用例（refuse 未定义且无关键词检查）——任何组都能"通过"，不计入有效分母
 *   2. A/B/C 没有工具，却按全口径算他们失分——不公平，分开列
 *   3. D 组答对了但检索为空（靠常识蒙对）——单列，这是"通过但路径错"
 *
 * 用法：node lab/analyze.mjs
 */
import { readFileSync } from 'node:fs';
import { CASES } from '../cases.mjs';

const d = JSON.parse(readFileSync(new URL('./lab-result.json', import.meta.url), 'utf8'));

// ---------- 用例有效性 ----------
const zeroCheck = new Set(
  CASES.filter((c) => c.refuse === undefined && (!c.includes || !c.includes.length)).map((c) => c.no)
);
const validCases = CASES.filter((c) => !zeroCheck.has(c.no));

console.log('=========== 用例有效性 ===========');
console.log(`总用例 ${CASES.length} 条，其中 ${zeroCheck.size} 条没有任何答案层检查项：#${[...zeroCheck].join(', #')}`);
console.log(`有效用例 ${validCases.length} 条（下面所有百分比都按这个分母）\n`);

// ---------- 各组表 ----------
const groups = ['A', 'B', 'C', 'D'];
const NAME = { A: 'A 裸调', B: 'B 仅提示词', C: 'C 仅知识库', D: 'D 完整版' };

const rows = {};
for (const g of groups) {
  const rs = d.rows.filter((r) => r.group === g);
  const valid = rs.filter((r) => !zeroCheck.has(r.no));
  const answerPass = valid.filter((r) => r.answerOk).length;
  const allPass = rs.filter((r) => r.allOk).length;
  const gs = d.groups[g];
  rows[g] = {
    n: valid.length,
    answerPass,
    answerRate: answerPass / valid.length,
    allPass,
    calls: gs.calls,
    inTok: gs.inTok,
    outTok: gs.outTok,
    avgLatency: gs.avgLatency,
    refuse: gs.refuseCount,
  };
}

// 成本：按 deepseek-chat 挂牌价折算（输入 2 元/百万，输出 8 元/百万）
const PRICE_IN = 2 / 1e6;
const PRICE_OUT = 8 / 1e6;
for (const g of groups) {
  const r = rows[g];
  r.cost = r.inTok * PRICE_IN + r.outTok * PRICE_OUT;
  r.costPerCase = r.cost / 20; // 一次跑完 20 条的总花费 / 20 = 每条
}

console.log('=========== 四组结果（20 条用例） ===========');
console.log('组'.padEnd(12), '答案口径'.padEnd(12), '全口径'.padEnd(10), '调用', '输入tok', '输出tok', '平均延迟', '20条总花费', '每条花费');
for (const g of groups) {
  const r = rows[g];
  console.log(
    NAME[g].padEnd(12),
    `${r.answerPass}/${r.n} = ${Math.round(r.answerRate * 100)}%`.padEnd(12),
    `${r.allPass}/20`.padEnd(10),
    String(r.calls).padStart(2),
    String(r.inTok).padStart(6),
    String(r.outTok).padStart(6),
    `${r.avgLatency}ms`.padStart(8),
    `¥${r.cost.toFixed(3)}`.padStart(9),
    `¥${r.costPerCase.toFixed(4)}`.padStart(8)
  );
}

// ---------- 归因 ----------
console.log('\n=========== 归因（相邻组差值 = 该环节的贡献） ===========');
const delta = (a, b) => {
  const x = rows[a].answerRate;
  const y = rows[b].answerRate;
  return { abs: (y - x) * rows[a].n, pct: (y - x) * 100 };
};
const dAB = delta('A', 'B');
const dAC = delta('A', 'C');
const dCD = delta('C', 'D');
console.log(`提示词贡献（B−A）：  ${dAB.abs >= 0 ? '+' : ''}${dAB.abs.toFixed(0)} 条 = ${dAB.pct >= 0 ? '+' : ''}${dAB.pct.toFixed(1)} 个百分点`);
console.log(`知识库贡献（C−A）：  ${dAC.abs >= 0 ? '+' : ''}${dAC.abs.toFixed(0)} 条 = ${dAC.pct >= 0 ? '+' : ''}${dAC.pct.toFixed(1)} 个百分点`);
console.log(`工具+ReAct（D−C）：  ${dCD.abs >= 0 ? '+' : ''}${dCD.abs.toFixed(0)} 条 = ${dCD.pct >= 0 ? '+' : ''}${dCD.pct.toFixed(1)} 个百分点`);
console.log(`完整版 vs 裸调（D−A）：+${((rows.D.answerRate - rows.A.answerRate) * rows.A.n).toFixed(0)} 条 = +${((rows.D.answerRate - rows.A.answerRate) * 100).toFixed(1)} 个百分点`);

// ---------- D 组：答对了但没查到证据 ----------
console.log('\n=========== D 组：答对但检索为空（蒙对） ===========');
const dRows = d.rows.filter((r) => r.group === 'D');
const policyNos = CASES.filter((c) => c.group === '政策可答').map((c) => c.no);
let fakeOk = 0;
const fakeList = [];
for (const r of dRows) {
  if (!policyNos.includes(r.no)) continue;
  // D 组 row 里没有 trace，用 toolCalls 是否有 search_faq 做弱判断
  const calledSearch = (r.toolCalls || []).includes('search_faq');
  if (r.answerOk && !calledSearch) {
    fakeOk += 1;
    fakeList.push({ no: r.no, q: r.q, why: '答对但没检索' });
  }
}
console.log(`政策类 8 条里，答对且没调用检索的有 ${fakeOk} 条：`);
for (const x of fakeList) console.log(`  #${x.no} ${x.q}`);
console.log(fakeOk ? '→ 这些分数不是知识库挣的，是模型自己的常识。' : '→ 政策题全部经过检索，没有蒙对。');

// ---------- 按用例类型看 D 组的真实能力 ----------
console.log('\n=========== D 组按用例类型 ===========');
const byCase = {};
for (const r of dRows) {
  if (zeroCheck.has(r.no)) continue;
  byCase[r.caseGroup] = byCase[r.caseGroup] || { n: 0, ok: 0 };
  byCase[r.caseGroup].n += 1;
  if (r.answerOk) byCase[r.caseGroup].ok += 1;
}
for (const [g, v] of Object.entries(byCase)) console.log(`  ${g.padEnd(6)} ${v.ok}/${v.n} = ${Math.round((v.ok / v.n) * 100)}%`);

// ---------- 存一份精简版 ----------
const summary = { generatedAt: d.generatedAt, model: d.model, zeroCheck: [...zeroCheck], rows, delta: { AB: dAB, AC: dAC, CD: dCD }, fakeOk, fakeList, byCase };
const fs = await import('node:fs');
fs.writeFileSync(new URL('./lab-summary.json', import.meta.url), JSON.stringify(summary, null, 2));
console.log('\n已写 lab/lab-summary.json');
