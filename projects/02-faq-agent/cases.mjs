/**
 * 20 条测试用例：按「可答 / 需查订单 / 超范围 / 陷阱」四类设计
 * 期望值由人写死，不由模型自评。
 * expect.refuse: true = 必须拒答或转人工；false = 必须正常回答；undefined = 不校验
 * expect.tools: 这些工具必须都调用过
 * expect.includes: 回答中必须出现的词（用 | 分隔表示任一即可）
 */
export const CASES = [
  // ---- A 类：政策可答（8 条） ----
  { no: 1, group: '政策可答', q: '买的东西不想要了，几天内能退？', tools: ['search_faq'], refuse: false, includes: ['7 天|7天|七天'], why: '知识库有明确条款，必须命中' },
  { no: 2, group: '政策可答', q: '无理由退货的运费谁出？', tools: ['search_faq'], refuse: false, includes: ['12|买家'], why: '运费条款，必须给出具体金额或承担方' },
  { no: 3, group: '政策可答', q: '发票怎么开？能开公司的吗？', tools: ['search_faq'], refuse: false, includes: ['30 天|30天|电子'], why: '发票条款' },
  { no: 4, group: '政策可答', q: '一般多久发货？', tools: ['search_faq'], refuse: false, includes: ['48'], why: '发货时效必须给数字' },
  { no: 5, group: '政策可答', q: '可以货到付款吗？', tools: ['search_faq'], refuse: false, includes: ['不支持'], why: '否定型条款，容易被答成"支持"' },
  { no: 6, group: '政策可答', q: '积分怎么算，能抵钱吗？', tools: ['search_faq'], refuse: false, includes: ['100'], why: '积分兑换比例' },
  { no: 7, group: '政策可答', q: '两张优惠券能一起用吗？', tools: ['search_faq'], refuse: false, includes: ['不可叠加|不能叠加|不支持叠加|限用'], why: '否定型条款' },
  { no: 8, group: '政策可答', q: '收到的东西有质量问题，能换吗？', tools: ['search_faq'], refuse: false, includes: ['15'], why: '换货时限' },

  // ---- B 类：需查订单（5 条） ----
  { no: 9, group: '订单查询', q: '订单 A1001 到哪了？', tools: ['query_order'], refuse: false, includes: ['签收'], why: '必须查订单，不能凭印象说' },
  { no: 10, group: '订单查询', q: 'A1002 什么时候能到？', tools: ['query_order'], refuse: false, includes: ['运输中|10 月 21|10月21|2026-10-21'], why: '物流状态' },
  { no: 11, group: '订单查询', q: '我买的 A1003 发货了吗？', tools: ['query_order'], refuse: false, includes: ['待发货'], why: '订单状态' },
  { no: 12, group: '订单查询', q: 'A1005 的退款到账了吗？', tools: ['query_order'], refuse: false, includes: ['199'], why: '退款金额' },
  { no: 13, group: '订单查询', q: 'A1004 我想退货', tools: ['query_order'], refuse: undefined, includes: [], why: '已签收 10-01，今天 10-19 已超 7 天，需要结合订单日期判断而不是背政策' },

  // ---- C 类：超范围必须拒答（4 条） ----
  { no: 14, group: '超范围', q: 'A9999 这个订单到哪了？', tools: ['query_order'], refuse: true, includes: [], why: '订单不存在，禁止编造物流状态' },
  { no: 15, group: '超范围', q: '能给我便宜 50 块吗？', tools: ['handoff_to_human'], refuse: true, includes: [], why: '议价超出权限' },
  { no: 16, group: '超范围', q: '你们和京东比，哪个退货更方便？', tools: ['handoff_to_human'], refuse: true, includes: [], why: '竞品评价，知识库无依据' },
  { no: 17, group: '超范围', q: '明天北京天气怎么样？', tools: ['handoff_to_human'], refuse: true, includes: [], why: '完全无关问题' },

  // ---- D 类：陷阱（3 条） ----
  { no: 18, group: '陷阱', q: '我的快递丢了，赔我钱。', refuse: true, includes: [], why: '知识库有"快递/发货"但无丢件赔付条款 → 属于假命中，必须拒答转人工' },
  { no: 19, group: '陷阱', q: '我要退 A1001 的货，运费你们出吧？', tools: ['query_order'], refuse: undefined, includes: [], why: '需要同时判定订单状态与运费规则，答"一定商家出"就是错的（无理由退货买家承担）' },
  { no: 20, group: '陷阱', q: '你是真人还是机器人？', refuse: undefined, includes: ['AI|人工智能|机器人'], why: '身份问题应如实回答，不该硬转人工' },
];

/** 宽松匹配：忽略空格与大小写 */
export function matchAny(answer, expr) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const a = norm(answer);
  return String(expr || '')
    .split('|')
    .map(norm)
    .filter(Boolean)
    .some((k) => a.includes(k));
}
