/**
 * 重判：数据不动，只改判定规则，看分数怎么变。
 *
 * 起因：D 组 #1 答案是对的（说了 7 天），却被判成"拒答"。
 * 因为答案里有一句"超时……需联系人工处理"的兜底话术，被 REFUSE_MARKERS 里的「联系人工」命中。
 * 这是判定器的假阳性，不是模型答错。
 *
 * 这类修正必须说清楚：分数变化来自尺子变了，不是模型变好了。
 * 所以这个脚本不重新调用模型，只拿原来的 answer 文本重算。
 *
 * 用法：node lab/rescore.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CASES, matchAny } from '../cases.mjs';

const path = new URL('./lab-result.json', import.meta.url);
const d = JSON.parse(readFileSync(path, 'utf8'));

// ---------- 旧规则 ----------
const OLD = ['无法确认', '无法为您', '查不到', '没有查到', '没查到', '查不到相关', '建议转人工', '已为您转接', '转接人工', '不能回答', '不在服务范围', '无法回答', '联系人工'];

// ---------- 新规则 ----------
// 保留全部标记，但加一条：第一句已经给出具体事实、且没有否定表述时，判为「边答边兜底」，不算拒答。
// 依据：
//   D #1「退货申请需在签收后 7 天内提交，超时……需联系人工处理」→ 答了，人工只是兜底
//   B #14「我这边看不到订单 A9999 的物流信息，建议……联系人工客服」→ 没答，是真拒答
// 两者的差别不在有没有"人工"二字，在有没有给出事实。
const NEG = /无法确认|查不到|没有查到|没查到|查不到相关|看不到|无法为您|无法回答|不能回答|不在服务范围|没有权限/;
const FACT = /\d|天|元|小时|工作日|签收|支持|不支持|需|可以/;

function refusedBy(answer, markers) {
  const s = String(answer || '').trim();
  if (!s) return false;
  const first = s.split(/[。！？\n]/)[0] || '';
  const hit = markers.some((m) => first.includes(m));
  if (!hit) return false;
  if (FACT.test(first) && !NEG.test(first)) return false; // 边答边兜底
  return true;
}

const byNo = new Map(CASES.map((c) => [c.no, c]));
const changed = [];

for (const row of d.rows) {
  const c = byNo.get(row.no);
  if (!c) continue;
  const oldRefused = refusedBy(row.answer, OLD);
  const newRefused = refusedBy(row.answer, OLD);

  const checks = [];
  if (c.refuse !== undefined) checks.push({ kind: 'answer', ok: newRefused === c.refuse });
  if (c.includes && c.includes.length) for (const inc of c.includes) checks.push({ kind: 'answer', ok: matchAny(row.answer, inc) });
  if (c.tools) for (const t of c.tools) checks.push({ kind: 'process', ok: (row.toolCalls || []).includes(t) });

  const answerOk = checks.filter((x) => x.kind === 'answer').every((x) => x.ok);
  const allOk = checks.every((x) => x.ok);

  if (answerOk !== row.answerOk) {
    changed.push({ group: row.group, no: row.no, q: row.q, before: row.answerOk, after: answerOk, why: `refused ${oldRefused}→${newRefused}` });
  }
  row.answerOk = answerOk;
  row.allOk = allOk;
  row.refused = newRefused;
  row.failed = checks.filter((x) => !x.ok).map((x) => x.name);
}

// 重算分组汇总
const zeroCheck = new Set(CASES.filter((c) => c.refuse === undefined && (!c.includes || !c.includes.length)).map((c) => c.no));
for (const g of Object.keys(d.groups)) {
  const rs = d.rows.filter((r) => r.group === g);
  const valid = rs.filter((r) => !zeroCheck.has(r.no));
  d.groups[g].answerPass = valid.filter((r) => r.answerOk).length;
  d.groups[g].allPass = rs.filter((r) => r.allOk).length;
  d.groups[g].refuseCount = rs.filter((r) => r.refused).length;
}

d.rescoredAt = new Date().toISOString();
d.rescoreNote = '判定器修正：移除「联系人工」这个拒答标记（兜底话术的常见结尾），数据未重新调用模型。';
writeFileSync(path, JSON.stringify(d, null, 2));

console.log('=========== 重判结果 ===========');
console.log(`改判 ${changed.length} 条：`);
for (const c of changed) console.log(`  ${c.group} 组 #${c.no} ${c.before ? 'PASS→FAIL' : 'FAIL→PASS'}  ${c.q}  (${c.why})`);
console.log('\n各组（有效分母 18）：');
for (const g of ['A', 'B', 'C', 'D']) {
  console.log(`  ${g}: ${d.groups[g].answerPass}/18 = ${Math.round((d.groups[g].answerPass / 18) * 100)}%`);
}
console.log('\n已写回 lab/lab-result.json');
