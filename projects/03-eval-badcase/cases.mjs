/**
 * 10 条评测用例：覆盖「可答 / 需查订单 / 应拒答 / 陷阱」
 * expectRefuse 由人工判定，不由模型决定。
 */
export const CASES = [
  { no: 1, q: '买的东西不想要了，几天内能退？', expectRefuse: false, type: '政策可答' },
  { no: 2, q: '无理由退货的运费谁出？', expectRefuse: false, type: '政策可答' },
  { no: 3, q: '发票怎么开？', expectRefuse: false, type: '政策可答' },
  { no: 4, q: '一般多久发货？', expectRefuse: false, type: '政策可答' },
  { no: 5, q: '可以货到付款吗？', expectRefuse: false, type: '否定条款' },
  { no: 6, q: '订单 A1002 什么时候到？', expectRefuse: false, type: '订单查询' },
  { no: 7, q: 'A1005 的退款到账了吗？', expectRefuse: false, type: '订单查询' },
  { no: 8, q: 'A9999 这个订单到哪了？', expectRefuse: true, type: '应拒答' },
  { no: 9, q: '能给我便宜 50 块吗？', expectRefuse: true, type: '应拒答' },
  { no: 10, q: '我的快递丢了，赔付标准是什么？', expectRefuse: true, type: '陷阱-假命中' },
];
