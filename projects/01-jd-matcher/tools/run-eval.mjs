/**
 * 自动化评测：3 版 Prompt × 12 条样本
 * 走官方 SDK 的同一条云端通道，与浏览器端完全一致的 prompt 与规则引擎。
 * 用法: node run-eval.mjs [limit]
 */
import { loadSdk } from './sdk-loader.mjs';
import { writeFileSync } from 'node:fs';

const sdk = loadSdk();
const { createWorkBuddyCloud } = sdk;

const { PROMPTS, PROMPT_VERSIONS } = await import('../assets/prompts.js');
const { CASES } = await import('../assets/evalset.js');
const { normalize, evaluateOne } = await import('../assets/judge.js');

const CONFIG = {
  endpoint: 'https://jd-match-analyzer.app.workbuddy.host',
  publishableKey: 'wbpk_wL6Ac81XPO3S0EeHRzcGEJ_x6tGGNVEdiUWn9o7XdO9RkAE6Q7C5j9q',
};

// 人工标注的预期分数区间（不是模型自评）
const EXPECT = {
  1: [55, 80], 2: [40, 70], 3: [45, 70], 4: [40, 65], 5: [30, 55], 6: [40, 65],
  7: [5, 32], 8: [40, 80], 9: [5, 28], 10: [30, 52], 11: [52, 75], 12: [58, 80],
};

const LIMIT = Number(process.argv[2] || 12);
const WANT_MODEL = process.argv[3] || '';

const cloud = createWorkBuddyCloud(CONFIG);

async function callOnce(modelId, version, tc) {
  const p = PROMPTS[version];
  const messages = [
    { role: 'system', content: p.system },
    { role: 'user', content: p.buildUser(tc.jd, tc.resume) },
  ];
  const params = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: version === 'v1' ? 1 : 0.3,
  };
  if (p.jsonMode) params.response_format = { type: 'json_object' };

  const t0 = Date.now();
  let text = '';
  let usage = null;
  for await (const ch of cloud.llm.chat.completions.create(params)) {
    const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
    if (d && d.content) text += d.content;
    if (ch.usage) usage = ch.usage;
  }
  return { text, usage, latency: Date.now() - t0 };
}

(async () => {
  const models = await cloud.llm.models.list();
  const model = (WANT_MODEL && models.find((m) => m.id === WANT_MODEL)) || models.find((m) => m.disabled !== true);
  console.log(`model=${model.id}  cases=${LIMIT}  versions=${PROMPT_VERSIONS.join(',')}`);

  const out = {};
  let done = 0;
  const total = PROMPT_VERSIONS.length * LIMIT;

  for (const v of PROMPT_VERSIONS) {
    out[v] = [];
    for (const tc of CASES.slice(0, LIMIT)) {
      done += 1;
      const label = `[${done}/${total}] ${v} #${tc.no} ${tc.category}`;
      try {
        const r = await callOnce(model.id, v, tc);
        const n = normalize(r.text, v);
        const m = evaluateOne(n, v, tc, EXPECT[tc.no]);
        out[v].push({
          case: tc.no,
          category: tc.category,
          difficulty: tc.difficulty,
          parsed: n.parsed,
          overall: n.overall,
          verdict: n.verdict,
          dims: n.dimensions.map((d) => ({ name: d.name, score: d.score })),
          evidenceCount: n.evidence.length,
          rewriteCount: n.rewrites.length,
          actionCount: n.actions.length,
          actionQuality: m.actionQuality,
          evidenceRate: m.evidenceRate,
          fabricateRate: m.fabricateRate,
          schemaRate: m.schemaRate,
          scoreReasonable: m.scoreReasonable,
          pass: m.pass,
          badcases: m.badcases,
          latency: r.latency,
          tokens: r.usage ? r.usage.total_tokens : null,
          rawHead: (r.text || '').slice(0, 600),
        });
        console.log(`${label}  score=${n.overall}  ${m.pass ? 'PASS' : 'FAIL'}  ${r.latency}ms`);
      } catch (e) {
        const code = e && e.error ? e.error.code : e && e.message;
        out[v].push({
          case: tc.no, category: tc.category, difficulty: tc.difficulty,
          error: String(code), pass: false, overall: null,
          evidenceRate: 0, fabricateRate: 1, schemaRate: 0, scoreReasonable: 0, actionQuality: 0,
          badcases: [{ dim: '调用失败', detail: String(code) }],
        });
        console.log(`${label}  ERROR ${code}`);
      }
    }
  }

  const avg = (arr, k) => (arr.length ? arr.reduce((s, x) => s + (x[k] || 0), 0) / arr.length : 0);
  const summary = {};
  for (const v of PROMPT_VERSIONS) {
    const list = out[v];
    summary[v] = {
      passRate: list.filter((x) => x.pass).length / list.length,
      evidenceRate: avg(list, 'evidenceRate'),
      fabricateRate: avg(list, 'fabricateRate'),
      schemaRate: avg(list, 'schemaRate'),
      scoreReasonable: avg(list, 'scoreReasonable'),
      actionQuality: avg(list, 'actionQuality'),
      avgLatency: Math.round(avg(list, 'latency')),
      avgTokens: Math.round(avg(list, 'tokens')),
      passCount: list.filter((x) => x.pass).length,
    };
  }

  const report = { generatedAt: new Date().toISOString(), model: model.id, cases: LIMIT, summary, detail: out };
  writeFileSync(new URL('./eval-result.json', import.meta.url), JSON.stringify(report, null, 2));

  console.log('\n===== SUMMARY =====');
  for (const v of PROMPT_VERSIONS) {
    const s = summary[v];
    console.log(
      `${v}: pass=${(s.passRate * 100).toFixed(0)}% evidence=${(s.evidenceRate * 100).toFixed(0)}% ` +
        `fabricate=${(s.fabricateRate * 100).toFixed(0)}% schema=${(s.schemaRate * 100).toFixed(0)}% ` +
        `scoreOk=${(s.scoreReasonable * 100).toFixed(0)}% action=${(s.actionQuality * 100).toFixed(0)}% ` +
        `lat=${s.avgLatency}ms tok=${s.avgTokens}`
    );
  }
})().catch((e) => {
  console.error('FATAL', e && (e.stack || e.message || e));
  process.exit(1);
});
