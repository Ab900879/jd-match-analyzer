/**
 * 盲评协议 · 自动化演示（对应 protocol.md 的六步流程）
 *
 *   被测（三家不同厂商）：kimi-k2.5 / glm-5.3-flash / deepseek-v4-flash
 *   评分（第四家厂商，与被测全部不同）：minimax-m3.1-flash
 *   题目：W01-W05（写作）+ S01-S05（总结）——联网题 N01-N10 无法在 API 模型上测，
 *         消费级 App 的正式评测按协议人工采集。
 *
 *   流程：gen（生成答案）→ score（打乱+匿名+盲评+机器判硬约束）→ rescore（二评）→ report（汇总）
 *   全部步骤断点可续：已有结果的不重跑。
 *
 *   用法：node lab/run.mjs gen|score|rescore|report|all
 */
import { loadSdk } from './sdk-loader.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, './lab-data.json');

// ---------- 配置 ----------
const CONFIG = {
  endpoint: 'https://jd-match-analyzer.app.workbuddy.host',
  publishableKey: 'wbpk_wL6Ac81XPO3S0EeHRzcGEJ_x6tGGNVEdiUWn9o7XdO9RkAE6Q7C5j9q',
};
const CANDIDATES = ['kimi-k2.5', 'glm-5.3-flash', 'deepseek-v4-flash']; // 被测三家
const SCORER = 'minimax-m3.1-flash';                                    // 评分（第四家）
const DEMO_IDS = ['W01', 'W02', 'W03', 'W04', 'W05', 'S01', 'S02', 'S03', 'S04', 'S05'];
const SEED = 20261103; // 打乱种子，固定保证可复盘

const { createWorkBuddyCloud } = loadSdk();
const api = createWorkBuddyCloud(CONFIG);

// ---------- 数据读写（断点可续的关键） ----------
function loadData() {
  if (existsSync(DATA)) return JSON.parse(readFileSync(DATA, 'utf8'));
  return { meta: null, answers: [], anonOrder: null, scores: [], rescores: [], summary: null };
}
function saveData(d) { writeFileSync(DATA, JSON.stringify(d, null, 2), 'utf8'); }

// ---------- 固定种子打乱（mulberry32，可复盘） ----------
function shuffle(arr, seed) {
  const a = [...arr];
  let t = seed;
  const rnd = () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- 模型调用 ----------
const meter = { calls: 0, inTok: 0, outTok: 0 };
async function chat(model, userContent, { json = false, temperature = 0.3, maxTokens = 1200, retry = 2 } = {}) {
  const t0 = Date.now();
  let text = '', usage = null;
  try {
    const body = { model, messages: [{ role: 'user', content: userContent }], stream: true, temperature, max_tokens: maxTokens, stream_options: { include_usage: true } };
    if (json) body.response_format = { type: 'json_object' };
    for await (const ch of api.llm.chat.completions.create(body)) {
      const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
      if (d && d.content) text += d.content;
      if (ch.usage) usage = ch.usage;
    }
  } catch (e) {
    if (retry > 0) { await new Promise(r => setTimeout(r, 2000)); return chat(model, userContent, { json, temperature, maxTokens, retry: retry - 1 }); }
    throw e;
  }
  meter.calls += 1;
  if (usage) { meter.inTok += usage.prompt_tokens || 0; meter.outTok += usage.completion_tokens || 0; }
  return { text, ms: Date.now() - t0 };
}
function extractJSON(t) {
  t = String(t).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  return JSON.parse(t.slice(a, b + 1));
}

// ---------- 机器判硬约束（protocol.md 第二层） ----------
// 数字数前先剥掉 markdown 修饰符（* # ` _ 和行首列表符），只数可见字符——
// 否则用 markdown 排版的答案会被冤枉超字数（这个坑是跑完第一轮发现的）
const countChars = s => String(s)
  .replace(/^\s*[-*+]\s+/gm, '')   // 行首列表符
  .replace(/[*#`_]/g, '')          // 强调/标题/代码标记
  .replace(/\s/g, '')
  .length;
const stripNum = l => l.replace(/^\s*\d+\s*[.、)）]\s*/, '').trim();
function machineCheck(task, answer) {
  const m = task.machine;
  if (!m) return { pass: true, violations: [], skipped: true };
  const s = String(answer || '');
  const v = [];
  const lines = s.split('\n').map(x => x.trim()).filter(Boolean);

  if (m.titleCount) {
    const titles = lines.map(stripNum);
    if (titles.length !== m.titleCount) v.push(`条数不符：要求 ${m.titleCount} 条，实际 ${titles.length} 行`);
    titles.forEach((t, i) => { if (countChars(t) > m.titleMaxChars) v.push(`第 ${i + 1} 条超字数：${countChars(t)} > ${m.titleMaxChars}`); });
  }
  if (m.maxBodyChars) { // W02：首行=标题，其余=正文
    const title = lines[0] || '';
    const body = lines.slice(1).join('');
    if (countChars(title) > 15) v.push(`标题超字数：${countChars(title)} > 15`);
    if (countChars(body) > m.maxBodyChars) v.push(`正文超字数：${countChars(body)} > ${m.maxBodyChars}`);
  }
  if (m.maxChars && !m.titleCount && !m.maxBodyChars) {
    if (countChars(s) > m.maxChars) v.push(`超字数：${countChars(s)} > ${m.maxChars}`);
  }
  (m.mustContain || []).forEach(k => { if (!s.includes(k)) v.push(`缺少必含信息：「${k}」`); });
  (m.mustNotContain || []).forEach(k => { if (s.includes(k)) v.push(`出现禁用词：「${k}」`); });
  return { pass: v.length === 0, violations: v, skipped: false };
}

// ---------- 评分提示词（盲：只有题目和匿名答案） ----------
function scorerPrompt(task, answer) {
  return `你是评测员，按口径给一份匿名的任务完成结果打分。

【题目】
${task.prompt}

【完成结果（匿名，来源未知）】
${answer}

【口径】
2 = 可直接用：满足题目全部硬性要求（字数/条数/必含信息），无事实错误，无编造
1 = 可用但需手动修正：大体满足，但有轻微越界（如略超字数）、格式瑕疵或个别事实不准
0 = 不可用：硬性要求明显违反、关键信息编造、答非所问或拒绝执行

只输出 JSON：{"score": 0, "reason": "一句话理由", "violations": ["违反的具体要求，没有则空数组"]}`;
}

// ---------- 各步骤 ----------
const TASKS = JSON.parse(readFileSync(resolve(here, '../tasks.json'), 'utf8')).tasks;
const demoTasks = DEMO_IDS.map(id => TASKS.find(t => t.id === id)).filter(Boolean);

async function gen(d) {
  d.meta = { generatedAt: new Date().toISOString(), candidates: CANDIDATES, scorer: SCORER, seed: SEED, demoIds: DEMO_IDS };
  let n = 0;
  for (const model of CANDIDATES) {
    for (const task of demoTasks) {
      if (d.answers.some(a => a.model === model && a.taskId === task.id)) continue;
      const r = await chat(model, task.prompt, { temperature: 0.3 });
      d.answers.push({ taskId: task.id, scenario: task.scenario, model, answer: r.text.trim(), ms: r.ms });
      saveData(d); n++;
      console.log(`  [gen] ${model} × ${task.id}  ${r.ms}ms  ${countChars(r.text)}字`);
    }
  }
  console.log(`生成完成：本次新产生 ${n} 份，累计 ${d.answers.length} 份`);
}

function buildAnon(d) {
  if (d.anonOrder) return;
  const pairs = shuffle(d.answers.map(a => ({ taskId: a.taskId, model: a.model })), SEED);
  d.anonOrder = pairs.map((p, i) => ({ anonId: '答-' + String(i + 1).padStart(3, '0'), ...p }));
  saveData(d);
}

async function score(d, key /* 'scores' | 'rescores' */, round) {
  buildAnon(d);
  const find = (arr, id) => arr.find(x => x.anonId === id);
  let n = 0;
  for (const item of d.anonOrder) {
    if (find(d[key], item.anonId)) continue;
    const task = TASKS.find(t => t.id === item.taskId);
    const ans = d.answers.find(a => a.taskId === item.taskId && a.model === item.model);
    let verdict, r;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await chat(SCORER, scorerPrompt(task, ans.answer), { json: true, temperature: 0.1, maxTokens: 1200 });
      try { verdict = extractJSON(r.text); break; }
      catch (e) { if (attempt === 1) verdict = { score: -1, reason: '评分输出无法解析：' + r.text.slice(0, 60), violations: [] }; }
    }
    const rec = { anonId: item.anonId, taskId: item.taskId, model: item.model, ...verdict };
    if (key === 'scores') rec.machine = machineCheck(task, ans.answer);
    d[key].push(rec);
    saveData(d); n++;
    console.log(`  [${round}] ${item.anonId} ${item.taskId} → ${verdict.score} 分${d[key].at(-1).machine ? (d[key].at(-1).machine.pass ? '（硬约束过）' : '（硬约束: ' + d[key].at(-1).machine.violations[0] + '）') : ''}`);
  }
  console.log(`${round}完成：本次 ${n} 条，累计 ${d[key].length} 条`);
}

function report(d) {
  const byModel = {};
  for (const m of CANDIDATES) {
    const rs = d.scores.filter(x => x.model === m);
    const r2map = Object.fromEntries(d.rescores.map(x => [x.anonId, x.score]));
    const scores = rs.map(x => x.score).filter(s => s >= 0);
    const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const usable = scores.filter(s => s >= 1).length;
    const machPass = rs.filter(x => x.machine && x.machine.pass).length;
    const ms = d.answers.filter(a => a.model === m).reduce((s, a) => s + a.ms, 0) / Math.max(1, d.answers.filter(a => a.model === m).length);
    // 分场景
    const byScene = {};
    for (const sc of ['写作', '总结']) {
      const ss = rs.filter(x => x.scenario !== undefined ? x.scenario === sc : TASKS.find(t => t.id === x.taskId).scenario === sc).map(x => x.score).filter(s => s >= 0);
      byScene[sc] = ss.length ? +(ss.reduce((a, b) => a + b, 0) / ss.length).toFixed(2) : null;
    }
    byModel[m] = { avgScore: +avg.toFixed(2), usable: `${usable}/${scores.length}`, machinePass: `${machPass}/${rs.length}`, avgMs: Math.round(ms), byScene };
  }
  // 二评一致率
  let agree = 0, agree1 = 0, total = 0;
  const disagree = [];
  for (const s of d.scores) {
    const r2 = d.rescores.find(x => x.anonId === s.anonId);
    if (!r2 || s.score < 0 || r2.score < 0) continue;
    total++;
    if (s.score === r2.score) agree++; else disagree.push({ anonId: s.anonId, taskId: s.taskId, model: s.model, r1: s.score, r2: r2.score });
    if (Math.abs(s.score - r2.score) <= 1) agree1++;
  }
  // 机器 vs 盲评冲突（仲裁候选）
  const conflicts = d.scores.filter(x => x.machine && !x.machine.skipped &&
    ((x.machine.pass && x.score === 0) || (!x.machine.pass && x.score === 2)))
    .map(x => ({ anonId: x.anonId, taskId: x.taskId, model: x.model, machinePass: x.machine.pass, blindScore: x.score, machineViolations: x.machine.violations }));

  d.summary = {
    byModel, nAnswers: d.answers.length, nScored: d.scores.length,
    agreement: { exact: total ? +(agree / total).toFixed(3) : null, within1: total ? +(agree1 / total).toFixed(3) : null, total },
    disagree, conflicts, meter: { ...meter },
  };
  saveData(d);

  console.log('\n===== 汇总 =====');
  console.log('模型'.padEnd(18), '盲评均分', '可用率', '硬约束过', '平均耗时');
  for (const m of CANDIDATES) {
    const x = byModel[m];
    console.log(m.padEnd(18), String(x.avgScore).padEnd(6), x.usable.padEnd(7), x.machinePass.padEnd(8), x.avgMs + 'ms', JSON.stringify(x.byScene));
  }
  console.log(`\n二评一致率：完全一致 ${agree}/${total} = ${total ? Math.round(agree / total * 100) : '-'}%，差1分以内 ${agree1}/${total}`);
  if (disagree.length) console.log('不一致条目：', disagree.map(x => `${x.anonId}(${x.taskId},${x.model}) ${x.r1}→${x.r2}`).join('  '));
  if (conflicts.length) console.log('机器vs盲评冲突（需人工仲裁）：', conflicts.map(x => `${x.anonId}(${x.taskId})`).join('  '));
  console.log(`\n调用统计：${meter.calls} 次，入 ${meter.inTok} tok，出 ${meter.outTok} tok`);
}

// ---------- 入口 ----------
const mode = process.argv[2] || 'all';
const d = loadData();
if (mode === 'gen' || mode === 'all') { console.log('===== ① 生成 ====='); await gen(d); }
if (mode === 'score' || mode === 'all') { console.log('===== ② 盲评（打乱+匿名+评分+机器判） ====='); await score(d, 'scores', '盲评'); }
if (mode === 'rescore' || mode === 'all') { console.log('===== ③ 二评（信度） ====='); await score(d, 'rescores', '二评'); }
if (mode === 'remachine') {
  // 判定器修 bug 后离线重算机器判（纯代码，零调用），然后重新汇总
  for (const s of d.scores) {
    const task = TASKS.find(t => t.id === s.taskId);
    const ans = d.answers.find(a => a.taskId === s.taskId && a.model === s.model);
    s.machine = machineCheck(task, ans.answer);
  }
  saveData(d);
  console.log(`机器判已重算：${d.scores.length} 条`);
}
if (mode === 'report' || mode === 'all' || mode === 'remachine') { console.log('===== ④ 汇总 ====='); report(d); }
