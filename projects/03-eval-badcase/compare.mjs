/**
 * 合并两批评测（batch-b1 / batch-b2），对全部 20 条回答统一重算 v1/v2/v3，产出看板用的 report.json。
 * 规则是确定性的，所以对历史回答重算 = 免费的交叉验证。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { scoreAnswer, isRefusalV3 } from './rules.mjs';

function loadBatch(tag) {
  const raw = JSON.parse(readFileSync(new URL(`./batch-${tag}.json`, import.meta.url), 'utf8'));
  return raw.rows.map((r) => {
    const c = { q: r.q, expectRefuse: r.expectRefuse };
    const v1 = scoreAnswer(r.answer, c, 'v1');
    const v2 = scoreAnswer(r.answer, c, 'v2');
    const v2c = v2.checks.map((x) => ({ ...x }));
    const ref = v2c.find((x) => x.name === '拒答正确');
    let v3;
    if (ref && c.expectRefuse !== undefined) {
      ref.ok = isRefusalV3(r.answer) === c.expectRefuse;
      v3 = { checks: v2c, score: v2c.filter((x) => x.ok).reduce((s, x) => s + x.weight, 0), cause: v2c.some((x) => !x.ok) ? v2c.find((x) => !x.ok).name : '通过' };
    } else {
      v3 = v2;
    }
    return { batch: tag, no: r.no, type: r.type, q: r.q, answer: r.answer, v1, v2, v3 };
  });
}

const all = [...loadBatch('b1'), ...loadBatch('b2')];
const stat = (pick) => {
  const scores = all.map(pick);
  return {
    avgScore: +(scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(1),
    passCount: scores.filter((x) => x === 100).length,
    total: scores.length,
  };
};
const v3Causes = {};
for (const r of all) v3Causes[r.v3.cause] = (v3Causes[r.v3.cause] || 0) + 1;
const v1Causes = {};
for (const r of all) v1Causes[r.v1.cause] = (v1Causes[r.v1.cause] || 0) + 1;

const report = {
  generatedAt: new Date().toISOString(),
  note: '两批独立生成的回答（各 10 条），规则版本 v1（证据源仅知识库）→ v2（并入订单库与问题）→ v3（拒答看第一句主结论）。对同一批回答重算不同版本规则，规则确定、回答不变，差异全部来自规则本身。',
  summary: { v1: stat((r) => r.v1.score), v2: stat((r) => r.v2.score), v3: stat((r) => r.v3.score) },
  causes: { v1: v1Causes, v3: v3Causes },
  rows: all,
};
writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('v1:', report.summary.v1, '\nv2:', report.summary.v2, '\nv3:', report.summary.v3);
console.log('v1 归因分布:', v1Causes);
console.log('v3 归因分布:', v3Causes);
