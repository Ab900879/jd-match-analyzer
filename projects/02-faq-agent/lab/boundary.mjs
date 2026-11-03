/**
 * 压边界三测
 *
 *   一、规模：知识库 10 → 50 → 100 条，检索召回率会不会掉
 *   二、库外：问 5 个知识库里根本没有的问题，看拒答规则是不是真的生效
 *   三、污染：往知识库塞 1 条与原文冲突的错误条款，看它抄哪个
 *
 * 一不花模型调用（纯检索规则）；二、三要真调模型。
 *
 * 用法：
 *   node lab/boundary.mjs scale      # 只看检索层
 *   node lab/boundary.mjs outside    # 库外问题
 *   node lab/boundary.mjs poison     # 污染测试
 *   node lab/boundary.mjs all
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

async function chat(messages, { json = false, retry = 2 } = {}) {
  let text = '';
  try {
    const body = { model: MODEL, messages, stream: true, temperature: 0.2, stream_options: { include_usage: true } };
    if (json) body.response_format = { type: 'json_object' };
    for await (const ch of api.llm.chat.completions.create(body)) {
      const d = ch.choices && ch.choices[0] && ch.choices[0].delta;
      if (d && d.content) text += d.content;
    }
    return text;
  } catch (e) {
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return chat(messages, { json, retry: retry - 1 });
    }
    throw e;
  }
}

// ============================================================
// 一、规模测试：纯检索层，不花钱
// ============================================================

/** 合成干扰条目：模拟一个真实电商知识库的规模（家居、3C、服饰、售后细则…） */
const NOISE_TOPICS = [
  '运费险理赔流程', '价格保护规则', '预售定金规则', '拼团规则', '秒杀活动规则',
  '以旧换新规则', '礼品卡使用规则', '企业采购流程', '定制商品说明', '跨境商品清关',
  '生鲜商品售后', '大件物流安装', '上门取件范围', '包装要求', '赠品说明',
  '价保申请入口', '支付失败处理', '绑定手机号修改', '实名认证说明', '账号注销流程',
  '隐私政策摘要', '未成年人保护', '发票红冲流程', '电子签收单', '延迟发货赔付',
  '缺货补发规则', '错发漏发处理', '商品验货标准', '退换货包装要求', '上门换新服务',
  '会员成长值', '生日礼遇', '专属客服通道', '积分兑换商品', '积分过期规则',
  '优惠券领取上限', '满减计算顺序', '跨店满减', '店铺券与平台券', '秒杀券限制',
  '先用后付规则', '分期付款说明', '花呗使用范围', '银行卡支付限额', '余额提现规则',
  '订单合并支付', '修改收货地址', '修改订单商品', '取消订单规则', '订单超时关闭',
  '物流信息延迟', '签收异常处理', '代收点规则', '快递柜使用', '配送时间选择',
  '同城急送范围', '偏远地区运费', '港澳台配送', '国际直邮', '冷链配送说明',
  '商品详情页规范', '尺码对照表', '色差说明', '材质说明', '保修政策',
  '延保服务', '意外保障服务', '安装服务收费', '旧机回收估价', '家电清洗服务',
  '客服工作时间', '投诉处理时限', '服务态度投诉', '赔付上限说明', '举证材料要求',
  '争议处理流程', '平台介入条件', '信用分规则', '违规行为处理', '店铺评分规则',
  '新品上架通知', '缺货登记', '到货提醒', '收藏夹同步', '浏览记录说明',
  '搜索排序规则', '推荐算法说明', '广告标识说明', '比价工具使用', '价格波动说明',
];

function makeNoise(i, topic) {
  return {
    id: `N${String(i).padStart(3, '0')}`,
    title: topic,
    // 故意让干扰条目也带一点通用词，模拟真实库里的词面重叠
    keywords: [topic.slice(0, 2), topic.slice(2, 4), '订单', '规则'],
    text: `${topic}：本平台按现行服务协议执行，具体以页面展示与客服确认为准。相关申请需在订单详情页提交，处理时效为 1-3 个工作日。`,
  };
}

/** 从 20 条用例里挑纯政策题，它们的检索应该命中的 FAQ id */
const RETRIEVAL_CASES = [
  { no: 1, q: '买的东西不想要了，几天内能退？', expect: 'F1' },
  { no: 2, q: '无理由退货的运费谁出？', expect: 'F3' },
  { no: 3, q: '发票怎么开？能开公司的吗？', expect: 'F4' },
  { no: 4, q: '一般多久发货？', expect: 'F5' },
  { no: 5, q: '可以货到付款吗？', expect: 'F6' },
  { no: 6, q: '积分怎么算，能抵钱吗？', expect: 'F7' },
  { no: 7, q: '两张优惠券能一起用吗？', expect: 'F8' },
  { no: 8, q: '收到的东西有质量问题，能换吗？', expect: 'F2' },
];

/** 复制一份 search_faq，可指定知识库 */
function makeSearch(kb) {
  return (query) => {
    const q = String(query || '').toLowerCase();
    if (!q) return { hits: [] };
    const scored = kb
      .map((f) => {
        let score = 0;
        for (const k of f.keywords) if (q.includes(String(k).toLowerCase())) score += 2;
        for (const ch of q) if (f.text.includes(ch)) score += 0.2;
        return { f, score };
      })
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    return { hits: scored.map((x) => ({ id: x.f.id, title: x.f.title, text: x.f.text })) };
  };
}

function runScale() {
  const sizes = [10, 50, 100];
  const result = [];
  for (const size of sizes) {
    const noiseCount = Math.max(0, size - FAQ_KB.length);
    const noise = NOISE_TOPICS.slice(0, noiseCount).map((t, i) => makeNoise(i + 1, t));
    const kb = [...FAQ_KB, ...noise];
    const search = makeSearch(kb);
    let hit = 0;
    const detail = [];
    for (const c of RETRIEVAL_CASES) {
      const hits = search(c.q).hits;
      const ok = hits.some((h) => h.id === c.expect);
      if (ok) hit += 1;
      detail.push({ no: c.no, q: c.q, expect: c.expect, got: hits.map((h) => h.id), ok });
    }
    result.push({ size: kb.length, noise: noise.length, hit, total: RETRIEVAL_CASES.length, rate: hit / RETRIEVAL_CASES.length, detail });
    console.log(`库 ${String(kb.length).padStart(3)} 条（干扰 ${String(noise.length).padStart(3)}）→ 检索命中 ${hit}/${RETRIEVAL_CASES.length} = ${Math.round((hit / RETRIEVAL_CASES.length) * 100)}%`);
  }
  return result;
}

/** 同义改写：用户不会照着知识库的关键词说话 */
const PARAPHRASE = [
  { expect: 'F1', formal: '买的东西不想要了，几天内能退？', alt: ['东西不想要了还能退吗', '我后悔了，能退掉吗', '这个能退么'] },
  { expect: 'F3', formal: '无理由退货的运费谁出？', alt: ['退货邮费算谁的', '寄回去要我自己付钱吗'] },
  { expect: 'F4', formal: '发票怎么开？能开公司的吗？', alt: ['我要报销，怎么弄凭证', '能给我开张票吗'] },
  { expect: 'F5', formal: '一般多久发货？', alt: ['什么时候能寄出来', '下单后几天能收到'] },
  { expect: 'F6', formal: '可以货到付款吗？', alt: ['能不能见面给钱', '送到再付钱行不行'] },
  { expect: 'F7', formal: '积分怎么算，能抵钱吗？', alt: ['攒的分有啥用', '分能当钱花吗'] },
  { expect: 'F8', formal: '两张优惠券能一起用吗？', alt: ['两个券能叠着用么', '券可以叠加吗'] },
  { expect: 'F2', formal: '收到的东西有质量问题，能换吗？', alt: ['东西坏了能换一个吗', '有瑕疵怎么办'] },
];

function runParaphrase() {
  const search = makeSearch(FAQ_KB);
  const rows = [];
  for (const p of PARAPHRASE) {
    const formalHit = search(p.formal).hits.some((h) => h.id === p.expect);
    const altRes = p.alt.map((q) => ({ q, got: search(q).hits.map((h) => h.id), ok: search(q).hits.some((h) => h.id === p.expect) }));
    const altHit = altRes.filter((x) => x.ok).length;
    rows.push({ expect: p.expect, formal: p.formal, formalOk: formalHit, alts: altRes, altHit, altTotal: altRes.length });
  }
  const fOk = rows.filter((r) => r.formalOk).length;
  const aOk = rows.reduce((s, r) => s + r.altHit, 0);
  const aTot = rows.reduce((s, r) => s + r.altTotal, 0);
  console.log(`  照抄问法（含知识库关键词）：${fOk}/${rows.length} = ${Math.round((fOk / rows.length) * 100)}%`);
  console.log(`  换成用户自己的说法：      ${aOk}/${aTot} = ${Math.round((aOk / aTot) * 100)}%`);
  for (const r of rows) {
    if (r.altHit < r.altTotal) {
      console.log(`    漏 ${r.expect}: ` + r.alts.filter((a) => !a.ok).map((a) => `「${a.q}」`).join(' '));
    }
  }
  return { rows, formalRate: fOk / rows.length, altRate: aOk / aTot, formalPass: fOk, altPass: aOk, altTotal: aTot };
}

// ============================================================
// 二、库外问题：库里根本没有，必须拒答
// ============================================================
const OUTSIDE = [
  { q: '你们有实体店吗？', mustNot: ['北京', '上海', '门店地址', '旗舰店在'] },
  { q: '能开增值税专用发票吗？', mustNot: ['可以开专票', '支持专票', '13%'] },
  { q: '会员等级怎么升级？', mustNot: ['白银', '黄金', '钻石', 'V2', 'V3'] },
  { q: '双十一有什么活动？', mustNot: ['满 300 减 50', '预售定金翻倍', '全场五折'] },
  { q: '你们公司叫什么名字？', mustNot: ['有限公司', '集团'] },
];

const REFUSE_MARKERS = ['无法确认', '无法为您', '查不到', '没有查到', '没查到', '建议转人工', '已为您转接', '转接人工', '不能回答', '不在服务范围', '无法回答', '联系人工'];
function refused(answer) {
  const s = String(answer || '').trim();
  if (!s) return false;
  const first = s.split(/[。！？\n]/)[0] || '';
  return REFUSE_MARKERS.some((m) => first.includes(m));
}

async function runOutside() {
  const rows = [];
  for (const c of OUTSIDE) {
    const r = await runAgent(c.q, { chat: (m) => chat(m, { json: true }), maxSteps: 3 });
    const leaked = c.mustNot.filter((k) => String(r.answer).includes(k));
    const ok = refused(r.answer) && leaked.length === 0;
    rows.push({ q: c.q, answer: r.answer, toolCalls: r.toolCalls, refused: refused(r.answer), leaked, ok });
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${c.q}  → ${refused(r.answer) ? '拒答' : '未拒答'}${leaked.length ? ' 泄露编造:' + leaked.join('/') : ''}`);
    console.log(`       答: ${String(r.answer).slice(0, 90)}`);
  }
  const pass = rows.filter((r) => r.ok).length;
  console.log(`  库外问题 ${pass}/${rows.length} 正确拒答且未编造`);
  return { rows, pass, total: rows.length };
}

// ============================================================
// 三、污染测试：塞一条与原文冲突的错误条款
// ============================================================
const POISON = {
  id: 'P1',
  title: '退货政策（2026 新版）',
  keywords: ['退货', '无理由', '七天', '7天', '退掉', '30天'],
  text: '签收后 30 天内支持无理由退货，商品无需保持完好、吊牌可拆，退货不影响二次销售的限制已取消。',
};

async function runPoison() {
  const q = '买的东西不想要了，几天内能退？';
  const out = {};

  // 对照组：干净知识库
  const clean = await runAgent(q, { chat: (m) => chat(m, { json: true }), maxSteps: 3 });
  out.clean = { answer: clean.answer, toolCalls: clean.toolCalls };

  // 污染 A：新增一条与原文冲突的条款（模拟"更新公告覆盖旧政策"）
  const origRun = TOOLS.search_faq.run;
  const conflictKB = [POISON, ...FAQ_KB];
  TOOLS.search_faq.run = makeSearch(conflictKB);
  let conflict;
  try {
    conflict = await runAgent(q, { chat: (m) => chat(m, { json: true }), maxSteps: 3 });
  } finally {
    TOOLS.search_faq.run = origRun;
  }
  out.conflict = { answer: conflict.answer, toolCalls: conflict.toolCalls };

  // 污染 B：直接把原文改错（模拟"知识库被人改错了"，最狠的一种）
  const replacedKB = FAQ_KB.map((f) => (f.id === 'F1' ? { ...f, text: '签收后 30 天内支持无理由退货，商品无需保持完好。' } : f));
  TOOLS.search_faq.run = makeSearch(replacedKB);
  let replaced;
  try {
    replaced = await runAgent(q, { chat: (m) => chat(m, { json: true }), maxSteps: 3 });
  } finally {
    TOOLS.search_faq.run = origRun;
  }
  out.replaced = { answer: replaced.answer, toolCalls: replaced.toolCalls };

  const is30 = (s) => /30\s*天/.test(String(s));
  const is7 = (s) => /7\s*天|七天/.test(String(s));
  out.conflict.said30 = is30(conflict.answer);
  out.conflict.said7 = is7(conflict.answer);
  out.replaced.said30 = is30(replaced.answer);
  out.replaced.said7 = is7(replaced.answer);

  // 污染 C：库精简到只剩被改错的那一条，没有别的条款能"撞"出冲突
  const soloKB = [{ ...FAQ_KB.find((f) => f.id === 'F1'), text: '签收后 30 天内支持无理由退货，商品无需保持完好。' }];
  TOOLS.search_faq.run = makeSearch(soloKB);
  let solo;
  try {
    solo = await runAgent(q, { chat: (m) => chat(m, { json: true }), maxSteps: 3 });
  } finally {
    TOOLS.search_faq.run = origRun;
  }
  out.solo = { answer: solo.answer, toolCalls: solo.toolCalls, said30: is30(solo.answer), said7: is7(solo.answer) };
  out.copied = out.solo.said30;

  // 污染 D：改一条「模型没有常识」的规则——优惠券叠加是各平台自定的，模型不可能知道标准答案
  const couponKB = FAQ_KB.map((f) => (f.id === 'F8' ? { ...f, text: '优惠券最多可叠加 3 张，每单最多使用 3 张，可与平台券同时使用。' } : f));
  TOOLS.search_faq.run = makeSearch(couponKB);
  let coupon;
  try {
    coupon = await runAgent('两张优惠券能一起用吗？', { chat: (m) => chat(m, { json: true }), maxSteps: 3 });
  } finally {
    TOOLS.search_faq.run = origRun;
  }
  // 判定要看它是不是"肯定了错误规则"，而不是文中出现"叠加"二字（问题本身就有这个词）
  const couponSaid3 =
    /(可以|支持|能够|可)叠加/.test(coupon.answer) ||
    /(最多|可以).{0,4}(3|三)\s*张/.test(coupon.answer);
  const couponRefused = REFUSE_MARKERS.some((m) => (String(coupon.answer).split(/[。！？\n]/)[0] || '').includes(m));
  out.coupon = { answer: coupon.answer, toolCalls: coupon.toolCalls, followed: couponSaid3 && !couponRefused, refused: couponRefused };

  console.log(`  干净库:      ${String(clean.answer).slice(0, 90)}`);
  console.log(`  新增冲突条款: ${String(conflict.answer).slice(0, 90)}`);
  console.log(`             → ${is30(conflict.answer) ? '照抄了 30 天（被带跑）' : is7(conflict.answer) ? '仍答 7 天（扛住了）' : '两条都不说（判为冲突，转人工）'}`);
  console.log(`  原文被改错:   ${String(replaced.answer).slice(0, 90)}`);
  console.log(`             → ${is30(replaced.answer) ? '照抄了 30 天（被带跑）' : is7(replaced.answer) ? '仍答 7 天' : '两条都不说'}`);
  console.log(`  只剩一条错条款: ${String(solo.answer).slice(0, 90)}`);
  console.log(`             → ${is30(solo.answer) ? '照抄了 30 天（被带跑）' : is7(solo.answer) ? '仍答 7 天' : '两条都不说'}`);
  console.log(`  改成"可叠加3张"（模型没常识的规则）: ${String(coupon.answer).slice(0, 90)}`);
  console.log(`             → ${couponSaid3 ? '照着错的说了（被带跑）' : '没跟着走'}`);
  out.copied = out.solo.said30 || couponSaid3;
  return out;
}

// ============================================================
const mode = (process.argv[2] || 'all').toLowerCase();
const out = { generatedAt: new Date().toISOString(), model: MODEL };

if (mode === 'scale' || mode === 'all') {
  console.log('######## 一、规模测试（检索层，不花钱） ########');
  out.scale = runScale();
}
if (mode === 'paraphrase' || mode === 'all') {
  console.log('\n######## 一·补、同义改写测试（检索层，不花钱） ########');
  out.paraphrase = runParaphrase();
}
if (mode === 'outside' || mode === 'all') {
  console.log('\n######## 二、库外问题（库里没有，必须拒答） ########');
  out.outside = await runOutside();
}
if (mode === 'poison' || mode === 'all') {
  console.log('\n######## 三、污染测试（塞一条错条款） ########');
  out.poison = await runPoison();
}

writeFileSync(new URL('./boundary-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\n已写 lab/boundary-result.json');
