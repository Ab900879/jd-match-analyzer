const fs = require('fs');
const a = JSON.parse(fs.readFileSync('./eval-result.json', 'utf8'));
const b = JSON.parse(fs.readFileSync('./eval-v3-calibrated.json', 'utf8'));

const EXPECT = { 1:[55,80],2:[40,70],3:[45,70],4:[40,65],5:[30,55],6:[40,65],7:[5,32],8:[40,80],9:[5,28],10:[30,52],11:[52,75],12:[58,80] };
const avg = (l, k) => (l.length ? l.reduce((s, x) => s + (x[k] || 0), 0) / l.length : 0);

function sm(list) {
  return {
    pass: list.filter((x) => x.pass).length / list.length,
    passCount: list.filter((x) => x.pass).length,
    ev: avg(list, 'ev'),
    fab: avg(list, 'fab'),
    sc: avg(list, 'sc'),
    sr: avg(list, 'sr'),
    aq: avg(list, 'aq'),
    lat: Math.round(avg(list, 'lat')),
    tok: Math.round(avg(list, 'tokens')),
  };
}

// 第一轮 detail 里字段名是 evidenceRate 等；第二轮是 ev 等，统一一下
function norm(list) {
  return list.map((x) => ({
    case: x.case,
    category: x.category,
    overall: x.overall,
    ev: x.ev !== undefined ? x.ev : x.evidenceRate,
    fab: x.fab !== undefined ? x.fab : x.fabricateRate,
    sc: x.sc !== undefined ? x.sc : x.schemaRate,
    sr: x.sr !== undefined ? x.sr : x.scoreReasonable,
    aq: x.aq !== undefined ? x.aq : x.actionQuality,
    pass: x.pass,
    lat: x.lat || x.latency || 0,
    tokens: x.tokens || 0,
    bad: x.bad || x.badcases || [],
    evidenceCount: x.evidenceCount || x.evidenceCount || 0,
  }));
}

const V1 = norm(a.detail.v1);
const V2 = norm(a.detail.v2);
const V3 = norm(a.detail.v3);
const V3C = norm(b.detail);

const sets = [
  ['v1 裸提示', V1],
  ['v2 结构化 rubric', V2],
  ['v3 仅证据约束', V3],
  ['v3 校准版（上线）', V3C],
];

console.log('=== 汇总（12 条 × 4 个版本，模型 deepseek-v4-flash）===');
console.log('版本'.padEnd(22), '通过率'.padEnd(8), '证据可追溯', '编造率', ' 格式合规', '分数合理', '建议可执行', '耗时');
sets.forEach(([name, l]) => {
  const s = sm(l);
  console.log(
    name.padEnd(20),
    String(Math.round(s.pass * 100) + '%').padEnd(10),
    String(Math.round(s.ev * 100) + '%').padEnd(10),
    String(Math.round(s.fab * 100) + '%').padEnd(8),
    String(Math.round(s.sc * 100) + '%').padEnd(10),
    String(Math.round(s.sr * 100) + '%').padEnd(10),
    String(Math.round(s.aq * 100) + '%').padEnd(12),
    s.lat + 'ms'
  );
});

console.log('\n=== 分数偏差：v3 未校准 → v3 校准版 ===');
console.log('case'.padEnd(6), '类型'.padEnd(14), '预期'.padEnd(8), 'v3'.padEnd(6), 'v3校准'.padEnd(8), '偏差改善');
for (let i = 0; i < 12; i += 1) {
  const c = i + 1;
  const o1 = V3.find((x) => x.case === c);
  const o2 = V3C.find((x) => x.case === c);
  const rg = EXPECT[c];
  const dev = (v) => (v == null ? null : v < rg[0] ? v - rg[0] : v > rg[1] ? v - rg[1] : 0);
  const d1 = o1 ? dev(o1.overall) : null;
  const d2 = o2 ? dev(o2.overall) : null;
  const fmt = (d) => (d === null ? '—' : d === 0 ? '0' : d > 0 ? '+' + d : String(d));
  console.log(
    ('#' + c).padEnd(6),
    String(o1 && o1.category).padEnd(14),
    (rg[0] + '-' + rg[1]).padEnd(9),
    String(o1 ? o1.overall : 'null').padEnd(6),
    String(o2 ? o2.overall : 'null').padEnd(9),
    fmt(d1) + ' → ' + fmt(d2)
  );
}

// 输出到文件供报告引用
fs.writeFileSync('./summary.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  model: 'deepseek-v4-flash',
  sets: sets.map(([name, l]) => ({ name, ...sm(l) })),
}, null, 2));
console.log('\n已写 summary.json');
