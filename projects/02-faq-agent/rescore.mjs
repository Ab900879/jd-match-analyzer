/**
 * 离线重算：用修正后的标注重判已存储的回答（不重新调用模型，回答内容不变）。
 * 背景：r2 跑出 18/20；#9 是标注过严（回答含"签收"事实但无"已签收"三字），修正标注后应重算。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CASES, matchAny } from './cases.mjs';

const raw = JSON.parse(readFileSync(new URL('./result-r2.json', import.meta.url), 'utf8'));
const rows = raw.rows.map((r) => {
  const c = CASES.find((x) => x.no === r.no);
  const checks = [];
  if (c.tools) for (const t of c.tools) checks.push({ name: `调用 ${t}`, ok: r.toolCalls.includes(t) });
  if (c.refuse !== undefined) checks.push({ name: c.refuse ? '必须拒答' : '必须正常回答', ok: r.refused === c.refuse });
  if (c.includes && c.includes.length) for (const inc of c.includes) checks.push({ name: `含「${inc}」`, ok: matchAny(r.answer, inc) });
  return { ...r, checks, pass: checks.every((x) => x.ok) };
});

const passed = rows.filter((x) => x.pass).length;
const byGroup = {};
for (const r of rows) {
  byGroup[r.group] = byGroup[r.group] || { n: 0, pass: 0 };
  byGroup[r.group].n += 1;
  if (r.pass) byGroup[r.group].pass += 1;
}
const out = {
  generatedAt: new Date().toISOString(),
  model: raw.model,
  note: '回答来自 r2 全量复测（result-r2.json）；本轮仅用修正后的标注离线重判，未重新调用模型。#9 原标注要求逐字"已签收"，回答"已于 10 月 10 日签收"含事实但被误判，已修正。#3（公司抬头）为标注争议，保留 FAIL。',
  summary: { total: rows.length, passed, hitRate: passed / rows.length, byGroup, rawHitRate: raw.summary.hitRate },
  rows,
};
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`原始 ${raw.summary.passed}/${raw.summary.total} → 修正标注后 ${passed}/${rows.length}`);
console.log(JSON.stringify(byGroup));
