/**
 * 四组对照实验
 *
 *   A 裸调        —— 朴素提示词，无知识库、无工具（基线：模型本身能对多少）
 *   B 仅提示词    —— A + 客服场景优化提示词（三条铁律），仍无知识库、无工具
 *   C 仅知识库    —— 朴素提示词 + 检索结果直接塞进上下文，无工具
 *   D 完整版      —— ReAct + 工具 + 三条铁律（线上跑的就是这个）
 *
 * 四组用同一批 20 条用例、同一套判定规则、同一个模型、同一时段。
 *
 * 两种口径分别统计：
 *   全口径   —— 含「是否调用了该调的工具」，A/B/C 没有工具，必然失分
 *   答案口径 —— 只看答案对不对（拒答是否符合预期 + 是否包含关键事实），四组可比
 *
 * 用法：node lab/compare.mjs [组名 A|B|C|D|all] [起始] [结束]
 */
import { loadSdk } from './sdk-loader.mjs';
import { runAgent, FAQ_KB, TOOLS } from '../agent.mjs';
import { CASES, matchAny } from '../cases.mjs';
import { writeFileSync } from 'node:fs';

const CONFIG = {
  endpoint: 'https://jd-match-analyzer.app.workbuddy.host',
  publishableKey: 'wbpk_wL6Ac81XPO3S0EeHRzcGEJ_x6tGGNVEdiUWn9o7XdO9RkAE6Q7C5j9q',
};
const MODEL = process.env.MODEL || 'deepseek-v4-flash';

const { createWorkBuddyCloud } = loadSdk();
const api = createWorkBuddyCloud(CONFIG);

// ---------- 计量与调用 ----------
const meter = { calls: 0, inTok: 0, outTok: 0, ms: 0 };

async function chat(messages, { json = false, retry = 2 } = {}) {
  const t0 = Date.now();
  let text = '';
  let usage = null;
  try {
    const body = {
      model: MODEL,
      messages,
      stream: true,
      temperature: 0.2,
      stream_options: { include_usage: true },
    };
    if (json) body.response_format = { type: 'json_object' };
    for await (const ch of api.llm.chat.completions.create(body)) {
      const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
      if (d && d.content) text += d.content;
      if (ch.usage) usage = ch.usage;
    }
  } catch (e) {
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return chat(messages, { json, retry: retry - 1 });
    }
    throw e;
  }
  const ms = Date.now() - t0;
  meter.calls += 1;
  meter.ms += ms;
  if (usage) {
    meter.inTok += usage.prompt_tokens || 0;
    meter.outTok += usage.completion_tokens || 0;
  }
  return text;
}

// ---------- 检索（C 组用的纯 RAG，不经过模型决策） ----------
function retrieve(q) {
  const hits = TOOLS.search_faq.run({ query: q }).hits;
  return hits;
}

// ---------- 四组的提示词 ----------
const SYS_PLAIN = '你是一个电商平台的客服助手。';

const SYS_TUNED = `你是电商平台的 AI 客服，负责回答用户关于退货、换货、运费、发票、发货、支付、积分、优惠券、售后的问题。

三条铁律：
1. 不许编造。没有明确依据的政策条款、金额、时限，一律不要说。宁可说不确定。
2. 说不清的时候，明确告诉用户「我这边无法确认，建议联系人工客服」，不要用模糊话术糊弄。
3. 有明确条款的，直接给具体数字（几天、多少钱、多久），不要说"通常""一般"。

回答用中文，两三句话说清，不要罗列。`;

function buildRagPrompt(q) {
  const hits = retrieve(q);
  const doc = hits.length
    ? hits.map((h) => `【${h.title}】${h.text}`).join('\n')
    : '（本次未检索到相关资料）';
  return {
    system: '你是电商平台的客服。请根据下面提供的资料回答用户问题；资料里没有的内容不要编。',
    user: `资料：\n${doc}\n\n用户问题：${q}`,
    hitCount: hits.length,
  };
}

// ---------- 单条判定 ----------
function judge(c, answer, toolCalls) {
  const checks = [];
  if (c.refuse !== undefined) checks.push({ kind: 'answer', name: c.refuse ? '必须拒答' : '必须正常回答', ok: answerRefused(answer) === c.refuse });
  if (c.includes && c.includes.length) {
    for (const inc of c.includes) checks.push({ kind: 'answer', name: `含「${inc}」`, ok: matchAny(answer, inc) });
  }
  if (c.tools) for (const t of c.tools) checks.push({ kind: 'process', name: `调用 ${t}`, ok: (toolCalls || []).includes(t) });

  const answerOk = checks.filter((x) => x.kind === 'answer').every((x) => x.ok);
  const allOk = checks.every((x) => x.ok);
  return { checks, answerOk, allOk };
}

// 与 agent.mjs 的 isRefusal 保持一致：只看第一句主结论
const REFUSE_MARKERS = ['无法确认', '无法为您', '查不到', '没有查到', '没查到', '查不到相关', '建议转人工', '已为您转接', '转接人工', '不能回答', '不在服务范围', '无法回答', '联系人工'];
function answerRefused(answer) {
  const s = String(answer || '').trim();
  if (!s) return false;
  const first = s.split(/[。！？\n]/)[0] || '';
  return REFUSE_MARKERS.some((m) => first.includes(m));
}

// ---------- 各组执行 ----------
async function groupA(c) {
  const text = await chat([
    { role: 'system', content: SYS_PLAIN },
    { role: 'user', content: c.q },
  ]);
  return { answer: text.trim(), toolCalls: [], steps: 1 };
}

async function groupB(c) {
  const text = await chat([
    { role: 'system', content: SYS_TUNED },
    { role: 'user', content: c.q },
  ]);
  return { answer: text.trim(), toolCalls: [], steps: 1 };
}

async function groupC(c) {
  const p = buildRagPrompt(c.q);
  const text = await chat([
    { role: 'system', content: p.system },
    { role: 'user', content: p.user },
  ]);
  return { answer: text.trim(), toolCalls: [], steps: 1, hitCount: p.hitCount };
}

async function groupD(c) {
  const r = await runAgent(c.q, { chat: (m) => chat(m, { json: true }), maxSteps: 3 });
  return { answer: r.answer, toolCalls: r.toolCalls, steps: r.steps };
}

const RUNNERS = { A: groupA, B: groupB, C: groupC, D: groupD };

// ---------- 主流程 ----------
const arg = (process.argv[2] || 'all').toUpperCase();
const from = Number(process.argv[3] || 1);
const to = Number(process.argv[4] || 99);
const groups = arg === 'ALL' ? ['A', 'B', 'C', 'D'] : [arg];
const list = CASES.filter((c) => c.no >= from && c.no <= to);

const out = { generatedAt: new Date().toISOString(), model: MODEL, groups: {}, rows: [] };

for (const g of groups) {
  console.log(`\n######## 组 ${g} ########`);
  const before = { ...meter };
  const gRows = [];
  for (const c of list) {
    const t0 = Date.now();
    let r;
    try {
      r = await RUNNERS[g](c);
    } catch (e) {
      r = { answer: '', toolCalls: [], steps: 0, error: String(e && e.message) };
    }
    const j = judge(c, r.answer, r.toolCalls);
    const row = {
      group: g,
      no: c.no,
      caseGroup: c.group,
      q: c.q,
      answer: r.answer,
      toolCalls: r.toolCalls,
      steps: r.steps,
      latency: Date.now() - t0,
      answerOk: j.answerOk,
      allOk: j.allOk,
      failed: j.checks.filter((x) => !x.ok).map((x) => x.name),
      error: r.error || null,
    };
    gRows.push(row);
    out.rows.push(row);
    console.log(`  #${String(c.no).padStart(2)} ${j.answerOk ? 'OK  ' : 'MISS'} ${Date.now() - t0}ms ${j.answerOk ? '' : '未过:' + row.failed.join(',')}`);
  }
  const byCase = {};
  for (const r of gRows) {
    byCase[r.caseGroup] = byCase[r.caseGroup] || { n: 0, answerOk: 0, allOk: 0 };
    byCase[r.caseGroup].n += 1;
    if (r.answerOk) byCase[r.caseGroup].answerOk += 1;
    if (r.allOk) byCase[r.caseGroup].allOk += 1;
  }
  const n = gRows.length;
  out.groups[g] = {
    n,
    answerPass: gRows.filter((r) => r.answerOk).length,
    allPass: gRows.filter((r) => r.allOk).length,
    byCase,
    calls: meter.calls - before.calls,
    inTok: meter.inTok - before.inTok,
    outTok: meter.outTok - before.outTok,
    avgLatency: Math.round(gRows.reduce((s, r) => s + r.latency, 0) / n),
    refuseCount: gRows.filter((r) => answerRefused(r.answer)).length,
  };
  const s = out.groups[g];
  console.log(`  答案口径 ${s.answerPass}/${n} = ${Math.round((s.answerPass / n) * 100)}% | 全口径 ${s.allPass}/${n} | 调用 ${s.calls} 次 | 平均 ${s.avgLatency}ms`);
}

out.meter = meter;
writeFileSync(new URL('./lab-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\n已写 lab/lab-result.json');
console.log('总调用', meter.calls, '次 | 输入', meter.inTok, 'tokens | 输出', meter.outTok, 'tokens');
