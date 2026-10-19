/**
 * 4 条打分规则（规则计算，不调用模型自评）
 * v1：证据源只取知识库 —— 这是一个真实的设计错误，会把「引用订单数据」的正确回答判成编造
 * v2：证据源 = 知识库 ∪ 订单库 ∪ 用户问题本身
 */
import { FAQ_KB, ORDERS } from '../02-faq-agent/agent.mjs';

const REFUSE_MARKERS = ['无法确认', '无法为您', '查不到', '没有查到', '没查到', '建议转人工', '已为您转接', '转接人工', '不能回答', '不在服务范围', '无法回答'];

export function isRefusal(answer) {
  const s = String(answer || '');
  return REFUSE_MARKERS.some((m) => s.includes(m));
}

/**
 * v3 的拒答判定：只看第一句主结论。
 * 原因：v2 用整段匹配，把「如订单已超 30 天，我这边无法…」这种条件式说明误判成拒答。
 */
export function isRefusalV3(answer) {
  const s = String(answer || '').trim();
  if (!s) return false;
  const first = s.split(/[。！？\n]/)[0] || '';
  return REFUSE_MARKERS.some((m) => first.includes(m));
}

/** v1 的证据池：只有知识库 */
export const POOL_V1 = FAQ_KB.map((f) => f.text).join('\n');

/** v2 的证据池：知识库 + 订单库 + 用户问题 */
export function poolV2(question) {
  const orders = Object.values(ORDERS)
    .map((o) => `${o.id} ${o.item} ${o.amount} 元 ${o.status} ${o.signedAt || ''} ${o.eta || ''} ${o.refundedAt || ''} ${o.refundAmount || ''} ${o.paidAt || ''}`)
    .join('\n');
  return [POOL_V1, orders, String(question || '')].join('\n');
}

/** 归一化：全角数字、中文数字天数 → 便于比对 */
function norm(s) {
  return String(s || '')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 65248))
    .replace(/([一二两三四五六七八九十])\s*天/g, (m, c) => {
      const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      return `${map[c] || ''}天`;
    });
}

/** R1 事实一致：回答里出现的每个数字，都必须在证据池里出现 */
function ruleEvidence(answer, pool) {
  const nums = (norm(answer).match(/\d+(?:\.\d+)?/g) || []).filter((n) => n.length <= 6);
  const poolNums = new Set(norm(pool).match(/\d+(?:\.\d+)?/g) || []);
  const bad = nums.filter((n) => !poolNums.has(n));
  return {
    name: '事实一致',
    weight: 30,
    ok: bad.length === 0,
    detail: bad.length ? `无依据数字：${[...new Set(bad)].join('、')}` : '所有数字均可追溯',
    hard: true,
  };
}

/** R2 拒答正确：该拒的必须拒，不该拒的不许乱拒 */
function ruleRefusal(answer, expectRefuse) {
  const refused = isRefusal(answer);
  const ok = expectRefuse === undefined ? true : refused === expectRefuse;
  return {
    name: '拒答正确',
    weight: 25,
    ok,
    detail: expectRefuse === undefined ? `未校验（实际${refused ? '拒答' : '作答'}）` : ok ? (refused ? '正确拒答/转人工' : '正确地给出了答案') : refused ? '该回答却拒答了（过度保守）' : '该拒答却编了答案',
    hard: true,
  };
}

/** R3 格式合规：≤200 字、无 markdown、无元话术 */
function ruleFormat(answer) {
  const s = String(answer || '');
  const problems = [];
  if (s.length > 200) problems.push(`超长 ${s.length} 字`);
  if (/[#*`|]|^\s*[-+]\s/m.test(s)) problems.push('含 markdown 标记');
  if (/作为(一个)?\s*AI|语言模型|以下是|希望对你有帮助/.test(s)) problems.push('含元话术');
  return { name: '格式合规', weight: 20, ok: problems.length === 0, detail: problems.length ? problems.join('；') : '格式干净' };
}

/** R4 可执行：必须给出具体下一步（时限/入口/动作） */
function ruleActionable(answer) {
  const s = String(answer || '');
  const hit = /(\d+\s*(小时|天|个工作日|元))|我的订单|申请|转接|人工|联系|入口|提交|点击|售后/.exec(s);
  return { name: '可执行', weight: 25, ok: !!hit, detail: hit ? `给出了下一步：${hit[0]}` : '只有结论，没有下一步' };
}

export function scoreAnswer(answer, testCase, version = 'v2') {
  const pool = version === 'v1' ? POOL_V1 : poolV2(testCase.q);
  const checks = [ruleEvidence(answer, pool), ruleRefusal(answer, testCase.expectRefuse), ruleFormat(answer), ruleActionable(answer)];
  const earned = checks.filter((c) => c.ok).reduce((s, c) => s + c.weight, 0);
  /** 归因：第一条失败的规则即为主因 */
  const failed = checks.filter((c) => !c.ok);
  const cause = failed.length === 0 ? '通过' : failed[0].name;
  return { checks, score: earned, cause, failedCount: failed.length };
}
