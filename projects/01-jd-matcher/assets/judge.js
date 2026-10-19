/* =========================================================
 * judge.js — 评测引擎
 * 产品意义：这是"证据"的核心。产品经理不是靠感觉说"变好了"，
 *          而是靠同一套 rubric 在同一份评测集上重复测量。
 * ========================================================= */

/**
 * 把模型自由文本解析成对象（v1 没有 json mode，输出没保障）
 */
/**
 * 修复被截断的 JSON。
 * 真实场景：模型流到一半断了（网络/长度限制），前面 90% 的内容其实是对的。
 * 直接判"解析失败"会把一个好结论扔掉 —— 这是工程问题，不该算到判断质量上。
 *
 * 做法：逐字符扫描，跟踪字符串状态与括号栈；遇到不完整就回退到最后一个安全的
 * 逗号处，再把未闭合的括号补齐。
 */
function repairTruncatedJson(text) {
  let inStr = false;
  let esc = false;
  const stack = [];
  let lastSafe = -1; // 最后一个「可安全截断」的位置

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && stack.length) lastSafe = i;
  }

  if (inStr || stack.length) {
    // 回退到最后一个逗号，丢掉后面半截（可能是一个写了一半的字符串/对象）
    if (lastSafe > 0) {
      let trimmed = text.slice(0, lastSafe);
      // 重新计算截断后的栈
      const st = [];
      let s2 = false;
      let e2 = false;
      for (let i = 0; i < trimmed.length; i += 1) {
        const c = trimmed[i];
        if (s2) {
          if (e2) e2 = false;
          else if (c === '\\') e2 = true;
          else if (c === '"') s2 = false;
          continue;
        }
        if (c === '"') s2 = true;
        else if (c === '{' || c === '[') st.push(c === '{' ? '}' : ']');
        else if (c === '}' || c === ']') st.pop();
      }
      return trimmed + st.reverse().join('');
    }
    // 没有逗号可回退，直接补齐
    return text + (inStr ? '"' : '') + stack.reverse().join('');
  }
  return text;
}

export function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    /* 继续 */
  }
  const start = cleaned.indexOf('{');
  if (start < 0) return null;

  // 先试到最后一个 }（正常完整的情形）
  const end = cleaned.lastIndexOf('}');
  if (end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) {
      /* 继续 */
    }
  }

  // 再试截断修复
  const body = cleaned.slice(start);
  try {
    const repaired = repairTruncatedJson(body);
    return JSON.parse(repaired);
  } catch (_) {
    return null;
  }
}

/** 取一个 0-100 的数字 */
function num(v, fallback = null) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

/** 从 v1 的自由文本里硬抠一个分数 */
function scrapeScore(text) {
  const m = String(text || '').match(/(\d{1,3})\s*分|匹配度[^\d]{0,6}(\d{1,3})|(\d{1,3})\s*%/);
  if (!m) return null;
  const raw = m[1] || m[2] || m[3];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n <= 100 ? n : null;
}

/**
 * 把模型输出规整成统一结构（4 个版本都走这里，保证可比）
 */
export function normalize(raw, version) {
  const obj = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!obj) {
    return {
      parsed: false,
      overall: null,
      rawText: typeof raw === 'string' ? raw : JSON.stringify(raw),
      dimensions: [],
      evidence: [],
      rewrites: [],
      actions: [],
      riskFlags: [],
      reason: '输出无法解析为 JSON',
    };
  }

  const DIMS = [
    { key: 'skill', name: '技能匹配', weight: 0.35 },
    { key: 'experience', name: '经历匹配', weight: 0.3 },
    { key: 'domain', name: '业务/行业', weight: 0.2 },
    { key: 'signal', name: '求职信号', weight: 0.15 },
  ];

  const srcDims = Array.isArray(obj.dimensions) ? obj.dimensions : [];
  const dimensions = DIMS.map((d, i) => {
    const found =
      srcDims.find((x) => x && (x.key === d.key || x.name === d.name)) || srcDims[i] || {};
    return {
      key: d.key,
      name: found.name || d.name,
      weight: d.weight,
      score: num(found.score, null),
      evidence: Array.isArray(found.evidence) ? found.evidence : [],
    };
  });

  const evidence = dimensions.flatMap((d) =>
    d.evidence.map((e) => ({
      dim: d.name,
      jdQuote: e?.jd_quote ?? '',
      resumeQuote: e?.resume_quote ?? '',
      state: ['hit', 'miss', 'unclear'].includes(e?.state) ? e.state : 'unclear',
      note: e?.note ?? '',
    }))
  );

  const rewrites = (Array.isArray(obj.rewrites) ? obj.rewrites : []).map((r) => ({
    original: r?.original ?? '',
    revised: r?.revised ?? '',
    why: r?.why ?? '',
    targets: Array.isArray(r?.targets) ? r.targets : [],
  }));

  const overall = num(obj.overall_score, null) ?? scrapeScore(typeof raw === 'string' ? raw : '');

  return {
    parsed: true,
    overall,
    verdict: obj.verdict || '',
    oneLine: obj.one_line || '',
    gapFocus: obj.gap_focus || '',
    dimensions,
    evidence,
    rewrites,
    actions: Array.isArray(obj.actions) ? obj.actions : [],
    riskFlags: Array.isArray(obj.risk_flags) ? obj.risk_flags : [],
    rawText: typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2),
  };
}

/* ------------------------------------------------------------------
 * 4 项客观指标。全部不用模型打分，都是用规则算出来的 —— 这是关键：
 * 指标本身必须可复现，否则整个评测就是"用感觉证明感觉"。
 * ------------------------------------------------------------------ */

/** 1. 证据可追溯率：有明确原文摘录的证据条数 / 证据总条数 */
export function evidenceRate(n) {
  if (!n.evidence.length) return 0;
  const ok = n.evidence.filter((e) => {
    const rq = (e.resumeQuote || '').trim();
    if (e.state === 'miss') return rq === ''; // miss 就该是空
    return rq.length >= 4; // hit / unclear 必须有原文
  }).length;
  return ok / n.evidence.length;
}

/** 2. 编造率：候选人从没写过、却被当成已具备的能力数 / 证据总条数 */
export function fabricateRate(n, resumeText) {
  if (!n.evidence.length) return 0;
  const norm = (s) => String(s || '').replace(/[\s，。、；：,.;:"'""''（）()【】\[\]]/g, '');
  const resumeNorm = norm(resumeText);
  const leaked = n.evidence.filter((e) => {
    if (e.state !== 'hit') return false;
    const rq = norm(e.resumeQuote);
    if (rq.length < 4) return true; // 声称命中却没有原文 → 编造
    // 原文摘录必须真的出现在简历里（允许标点差异）
    return !resumeNorm.includes(rq.slice(0, Math.min(rq.length, 14)));
  }).length;
  return leaked / n.evidence.length;
}

/** 3. Schema 合规率：关键字段齐不齐 */
export function schemaRate(n, version) {
  let checks;
  if (version === 'v1') {
    // v1 没有 schema 约束，这里检查"输出里是否具备可结构化的要素"：
    // 有明确分数、有维度拆分、有可解析的结构 —— 三项都不满足就是纯散文
    checks = [
      typeof n.rawText === 'string' && n.rawText.length > 10,
      /\d{1,3}\s*(分|\/100|%)/.test(n.rawText),
      n.parsed || /(技能|经历|维度|权重)/.test(n.rawText),
    ];
  } else if (version === 'v2') {
    checks = [
      n.parsed,
      n.overall !== null,
      n.dimensions.every((d) => d.score !== null),
    ];
  } else {
    checks = [
      n.parsed,
      n.overall !== null,
      n.dimensions.every((d) => d.score !== null),
      n.evidence.length >= 4,
      n.rewrites.length >= 1,
      n.actions.length >= 3,
      n.riskFlags.length >= 1,
    ];
  }
  return checks.filter(Boolean).length / checks.length;
}

/** 4. 分数合理性：分数落在预期区间（人工标注的区间，不是模型自评） */
export function scoreReasonable(n, expect) {
  if (n.overall === null) return 0;
  const [lo, hi] = expect;
  if (n.overall >= lo && n.overall <= hi) return 1;
  const dist = n.overall < lo ? lo - n.overall : n.overall - hi;
  return dist <= 10 ? 0.5 : 0;
}

/** 5. 动作可执行度：actions 里有多少条带具体工具/交付物，而不是空话 */
const VAGUE = /提升|加强|努力|多学习|增强|深入了解|培养|积累经验|提高能力/g;
const CONCRETE =
  /(Coze|Dify|Figma|Axure|SQL|Excel|GitHub|飞书|PRD|Prompt|评测集|badcase|看板|原型|剧本|工作流|workflow|Bot|文档|报告|截图|链接)/i;

export function actionQuality(n) {
  if (!n.actions.length) return 0;
  const good = n.actions.filter((a) => {
    const s = String(a);
    return s.length >= 12 && CONCRETE.test(s) && !VAGUE.test(s);
  }).length;
  return good / n.actions.length;
}

/** 每一条 case 跑一遍，产出 5 个指标 + 是否通过 */
export function evaluateOne(normalized, version, testCase, expectRange) {
  const ev = evidenceRate(normalized);
  const fab = fabricateRate(normalized, testCase.resume);
  const sc = schemaRate(normalized, version);
  const sr = scoreReasonable(normalized, expectRange);
  const aq = actionQuality(normalized);

  const pass =
    sc >= 0.7 && sr >= 0.5 && ev >= 0.7 && fab <= 0.2 && (version === 'v3' ? aq >= 0.5 : true);

  return {
    overall: normalized.overall,
    evidenceRate: ev,
    fabricateRate: fab,
    schemaRate: sc,
    scoreReasonable: sr,
    actionQuality: aq,
    pass,
    badcases: [
      sc < 0.7 && { dim: '格式合规', detail: '输出未按 schema 返回' },
      sr < 0.5 && { dim: '分数口径', detail: `分数 ${normalized.overall} 落在预期区间 ${expectRange[0]}-${expectRange[1]} 之外` },
      ev < 0.7 && { dim: '证据可追溯', detail: '证据缺少原文摘录' },
      fab > 0.2 && { dim: '编造', detail: '把简历里没有的经历当成已具备' },
      version === 'v3' && aq < 0.5 && { dim: '建议质量', detail: '建议不可执行（空话/无交付物）' },
    ].filter(Boolean),
  };
}
