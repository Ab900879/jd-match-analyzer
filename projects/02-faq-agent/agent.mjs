/**
 * FAQ Agent 核心逻辑：工具定义 + ReAct 循环 + 拒答判定
 * 浏览器与 Node 共用同一份代码，保证「页面上看到的」和「测试跑出来的」是同一个 agent。
 */

// ---------- 知识库（模拟真实客服 FAQ，8 条政策 + 1 条时限） ----------
export const FAQ_KB = [
  { id: 'F1', title: '退货政策', keywords: ['退货', '无理由', '七天', '7天', '退掉'], text: '签收后 7 天内支持无理由退货，商品需保持完好、吊牌未拆、不影响二次销售。' },
  { id: 'F2', title: '换货政策', keywords: ['换货', '换个', '换一个', '质量问题'], text: '签收后 15 天内出现质量问题可申请换货；非质量问题（如不喜欢、拍错）不支持换货。' },
  { id: 'F3', title: '退货运费', keywords: ['运费', '邮费', '谁承担', '快递费'], text: '质量问题导致的退换货运费由商家承担；无理由退货运费由买家承担，默认 12 元起。' },
  { id: 'F4', title: '发票', keywords: ['发票', '开票', '报销', '税号'], text: '支持开具电子普通发票，下单后 30 天内可在「我的订单 - 申请发票」提交，1-3 个工作日开出。' },
  { id: 'F5', title: '发货时效', keywords: ['发货', '多久发', '什么时候发', '物流', '快递'], text: '现货商品付款后 48 小时内发出；预售商品按商品详情页标注的发货时间执行。' },
  { id: 'F6', title: '支付方式', keywords: ['支付', '付款', '微信', '支付宝', '银行卡', '货到付款'], text: '支持微信、支付宝、银行卡支付；不支持货到付款，也不支持分期。' },
  { id: 'F7', title: '会员积分', keywords: ['积分', '会员', '抵扣'], text: '消费 1 元累计 1 积分，100 积分可抵 1 元，积分有效期 1 年，过期清零。' },
  { id: 'F8', title: '优惠券', keywords: ['优惠券', '券', '折扣', '满减'], text: '优惠券不可叠加使用，每单限用 1 张；过期不补发，不支持延期。' },
  { id: 'F9', title: '售后申请时限', keywords: ['售后', '申请', '超时', '时限'], text: '退货申请需在签收后 7 天内提交，超时系统会自动关闭申请入口，需联系人工处理。' },
];

// ---------- 订单库（模拟） ----------
export const ORDERS = {
  A1001: { id: 'A1001', item: '蓝牙耳机', amount: 299, status: '已签收', signedAt: '2026-10-10', paidAt: '2026-10-07' },
  A1002: { id: 'A1002', item: '机械键盘', amount: 459, status: '运输中', eta: '2026-10-21', paidAt: '2026-10-18' },
  A1003: { id: 'A1003', item: '保温杯', amount: 129, status: '待发货', paidAt: '2026-10-19' },
  A1004: { id: 'A1004', item: '台灯', amount: 199, status: '已签收', signedAt: '2026-10-01', paidAt: '2026-09-28' },
  A1005: { id: 'A1005', item: '移动电源', amount: 199, status: '已退款', refundedAt: '2026-10-15', refundAmount: 199 },
};

// ---------- 工具 ----------
export const TOOLS = {
  search_faq: {
    desc: '在客服知识库中检索政策类问题。输入 {"query": "检索关键词"}。返回匹配的 FAQ 条目，无匹配时返回空数组。',
    run({ query }) {
      const q = String(query || '').toLowerCase();
      if (!q) return { hits: [] };
      const scored = FAQ_KB.map((f) => {
        let score = 0;
        for (const k of f.keywords) if (q.includes(k.toLowerCase())) score += 2;
        for (const ch of q) if (f.text.includes(ch)) score += 0.2;
        return { f, score };
      })
        .filter((x) => x.score >= 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      return { hits: scored.map((x) => ({ id: x.f.id, title: x.f.title, text: x.f.text })) };
    },
  },
  query_order: {
    desc: '按订单号查询订单状态。输入 {"order_id": "A1001"}。查不到时返回 found=false。注意：只能查 A1001-A1005 范围内的订单号。',
    run({ order_id }) {
      const o = ORDERS[String(order_id || '').trim().toUpperCase()];
      return o ? { found: true, order: o } : { found: false, order: null };
    },
  },
  handoff_to_human: {
    desc: '转接人工客服。当知识库查不到、订单查不到、或用户问题超出服务范围时调用。输入 {"reason": "转接原因"}。',
    run({ reason }) {
      return { handedOff: true, reason: String(reason || '用户主动要求'), ticket: 'T' + Date.now().toString().slice(-6) };
    },
  },
};

// ---------- 提示词 ----------
export const SYSTEM_PROMPT = `你是电商平台的 AI 客服。你必须通过调用工具获取信息，不能凭印象回答。

## 可用工具
1. search_faq  —— 检索政策类知识库（退货、换货、运费、发票、发货、支付、积分、优惠券、售后时限）
2. query_order —— 按订单号查询订单状态
3. handoff_to_human —— 转接人工

## 输出格式（严格遵守，只输出一个 JSON 对象，不要 markdown 代码块）
调用工具时：
{"thought": "为什么要调这个工具", "action": "工具名", "input": {"参数": "值"}}

给出最终回答时：
{"thought": "信息是否足够", "action": "final", "answer": "给用户的中文回答"}

## 三条硬性规则
1. **没有证据不许回答**：政策类问题必须先 search_faq，且只有 hits 非空才能回答；hits 为空时禁止回答政策内容。
2. **查不到就拒答**：知识库没有、订单查不到、问题超出客服范围（议价、竞品评价、闲聊、要你承诺平台没承诺的事），必须调用 handoff_to_human，并在 answer 中明确说明「我这边无法确认」或「已为您转接人工客服」，禁止猜测、禁止编造政策条款。
3. **不许多轮闲聊**：最多调 3 次工具，第 3 次之后必须给 final 回答。
4. **身份类问题直接如实回答**：用户问你是不是机器人、你是谁、能不能听懂，直接说明自己是 AI 客服，不要转人工。

## 示例
用户：我的订单 A1002 到哪了
→ {"thought":"需要查订单状态","action":"query_order","input":{"order_id":"A1002"}}
（观察：status=运输中，预计 2026-10-21 送达）
→ {"thought":"信息足够","action":"final","answer":"您的订单 A1002（机械键盘）目前运输中，预计 2026 年 10 月 21 日送达。"}

用户：能给我便宜 50 块吗
→ {"thought":"议价超出客服权限，知识库无相关条款","action":"handoff_to_human","input":{"reason":"用户要求议价"}}
→ {"thought":"已转接","action":"final","answer":"抱歉，我这边无法确认价格调整，已为您转接人工客服。"}`;

// ---------- 拒答判定（规则，不依赖模型自评） ----------
const REFUSE_MARKERS = ['无法确认', '无法为您', '查不到', '没有查到', '没查到', '查不到相关', '建议转人工', '已为您转接', '转接人工', '不能回答', '不在服务范围', '无法回答'];

export function isRefusal(answer) {
  const s = String(answer || '').trim();
  if (!s) return false;
  // 只看第一句主结论：否则「如仍有疑问，可为您转接人工」这类兜底话术会被误判成拒答
  const first = s.split(/[。！？\n]/)[0] || '';
  return REFUSE_MARKERS.some((m) => first.includes(m));
}

export function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  // 从后往前找能闭合的右括号，容忍流式截断
  for (let end = s.length; end > start; end -= 1) {
    if (s[end - 1] !== '}') continue;
    try {
      return JSON.parse(s.slice(start, end));
    } catch (e) {
      /* 继续向前退 */
    }
  }
  return null;
}

/**
 * ReAct 循环。
 * @param {string} question 用户问题
 * @param {(messages:object[])=>Promise<string>} chat 一次模型调用，返回完整文本
 */
export async function runAgent(question, { chat, maxSteps = 3 } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  const trace = [];
  let steps = 0;
  let lastText = '';

  while (steps < maxSteps) {
    steps += 1;
    const raw = await chat(messages);
    lastText = raw;
    const parsed = extractJson(raw);

    if (!parsed) {
      trace.push({ step: steps, type: 'parse_fail', raw: raw.slice(0, 200) });
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: '你的输出不是合法 JSON。请只输出一个 JSON 对象，不要任何其他文字。' });
      continue;
    }

    if (parsed.action === 'final') {
      const answer = String(parsed.answer || '');
      trace.push({ step: steps, type: 'final', thought: parsed.thought, answer });
      return { answer, trace, steps, refused: isRefusal(answer), toolCalls: trace.filter((t) => t.type === 'tool').map((t) => t.tool), parsedOk: true };
    }

    const tool = TOOLS[parsed.action];
    if (!tool) {
      trace.push({ step: steps, type: 'unknown_tool', name: parsed.action });
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: `没有名为 ${parsed.action} 的工具，可用工具只有 search_faq / query_order / handoff_to_human。` });
      continue;
    }

    let observation;
    try {
      observation = tool.run(parsed.input || {});
    } catch (e) {
      observation = { error: String(e && e.message) };
    }
    trace.push({ step: steps, type: 'tool', tool: parsed.action, input: parsed.input, observation, thought: parsed.thought });

    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: `工具 ${parsed.action} 返回：${JSON.stringify(observation)}\n请继续：需要更多信息就继续调用工具，信息够了就输出 action=final。` });
  }

  const parsed = extractJson(lastText);
  const answer = parsed && parsed.answer ? parsed.answer : '我这边无法确认，已为您转接人工客服。';
  trace.push({ step: steps, type: 'force_final', answer });
  return { answer, trace, steps, refused: isRefusal(answer), toolCalls: trace.filter((t) => t.type === 'tool').map((t) => t.tool), parsedOk: !!parsed };
}
