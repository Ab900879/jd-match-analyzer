"""红线词检测：合规的硬拦截层

为什么这块不能用大模型：
    合规要求的是"召回"，不是"准确"。漏掉一句"保本保收益"，罚的是公司；
    多标一句让人复核，成本只是一分钟。所以这层必须用确定性规则，
    覆盖率宁可偏大。

但规则天生有两个坑，这里都处理了：

坑一：只扫坐席的话。
    客户问"你们保本吗？"这句话里有"保本"，但那不是违规。
    如果不分角色，每通电话都会被误判。所以 RedlineHit 里带 role，
    而扫描入口只喂 agent 的轮次。

坑二：否定语境。
    "我们不做保本承诺"里有"保本"，意思正好相反。
    处理办法不是在词库里加例外（例外会越加越多），
    而是检测匹配点前面是否有否定词——有就降级成"疑似"，
    交给人工确认，而不是直接判违规。

    这个降级很关键：它把"规则判错"的代价从"冤枉一个坐席"
    变成"多看一眼"，这是规则系统能落地的前提。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---------- 词库 ----------
# severity:
#   block —— 一票否决，直接 0 分并强制转人工复核
#   warn  —— 扣分项，不否决，但要在报告里标出来

RULES: list[dict] = [
    {
        "id": "guarantee_return",
        "category": "承诺收益 / 保本",
        "severity": "block",
        "why": "金融产品不得承诺保本保收益（资管新规后属明令禁止）",
        "words": [
            "保本", "保收益", "保证收益", "承诺收益", "稳赚", "稳赚不赔",
            "零风险", "无风险", "不会亏", "一定赚", "包赚", "肯定赚",
            "保底", "兜底", "只赚不赔",
        ],
    },
    {
        "id": "absolute_claim",
        "category": "绝对化用语",
        "severity": "warn",
        "why": "广告法禁用『第一 / 最好 / 唯一』这类无法证实的表述",
        "words": [
            "排名第一", "行业第一", "全国第一", "最好的", "最优的",
            "独一无二", "唯一的", "百分之百", "100%", "绝对安全", "绝对可靠",
        ],
    },
    {
        "id": "sensitive_info",
        "category": "索取敏感信息",
        "severity": "block",
        "why": "电话中索要验证码 / 密码 / 完整证件号，是电诈的典型特征，正规业务不应如此",
        "words": [
            "验证码", "密码", "身份证号", "银行卡号", "卡号后", "有效期和",
            "短信码", "动态码", "后六位", "后四位",
        ],
    },
    {
        "id": "impersonate",
        "category": "冒充官方 / 公检法",
        "severity": "block",
        "why": "非官方身份声称公检法 / 银行官方，属冒充",
        "words": [
            "公安局", "派出所", "法院", "检察院", "刑侦",
            "银行工作人员", "官方客服", "监管部门通知",
        ],
    },
    {
        "id": "coercion",
        "category": "威胁 / 施压",
        "severity": "block",
        "why": "以征信、起诉、上门等施压，属不当催收或胁迫",
        "words": [
            "影响征信", "上征信", "起诉你", "法院见", "上门", "找到你单位",
            "爆通讯录", "告诉你家人", "不还就",
        ],
    },
    {
        "id": "private_deal",
        "category": "引导私下交易",
        "severity": "block",
        "why": "引导脱离公司渠道交易，无法留痕，是资金风险高发点",
        "words": [
            "加我微信转账", "转我私人", "私人账户", "私下交易", "走我个人",
            "扫我这个码", "直接转给我",
        ],
    },
    {
        "id": "disparage",
        "category": "贬低竞品",
        "severity": "warn",
        "why": "商业诋毁，可能构成不正当竞争",
        "words": [
            "那是骗子", "那家不行", "别家都是骗", "他们都是坑",
            "只有我们正规", "别家做不到",
        ],
    },
]

# 否定词：出现在匹配点**前面**这几个字内，就认为语境是否定
NEGATIONS = ["不", "没", "无", "非", "不会", "绝不", "不存在", "谈不上", "不算", "不做", "没有"]
NEG_WINDOW = 8  # 往回看几个字


@dataclass
class RedlineHit:
    rule_id: str
    category: str
    severity: str
    why: str
    turn_index: int
    t: float
    role: str
    text: str
    matched: str
    negated: bool = False
    context: str = ""
    count: int = 1          # 同一条规则在同一句话里命中的次数

    @property
    def confirmed(self) -> bool:
        """确认违规：命中且不在否定语境里。"""
        return not self.negated

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule_id,
            "category": self.category,
            "severity": self.severity,
            "why": self.why,
            "turn_index": self.turn_index,
            "t": self.t,
            "role": self.role,
            "matched": self.matched,
            "negated": self.negated,
            "confirmed": self.confirmed,
            "context": self.context,
            "count": self.count,
            "text": self.text,
        }


@dataclass
class ScanResult:
    hits: list[RedlineHit] = field(default_factory=list)
    skipped_customer_mentions: int = 0  # 客户自己说的，跳过的次数（透明化用）

    @property
    def confirmed_hits(self) -> list[RedlineHit]:
        return [h for h in self.hits if h.confirmed]

    @property
    def suspected_hits(self) -> list[RedlineHit]:
        return [h for h in self.hits if h.negated]

    @property
    def blocked(self) -> bool:
        return any(h.severity == "block" for h in self.confirmed_hits)

    def to_dict(self) -> dict:
        return {
            "confirmed_count": len(self.confirmed_hits),
            "suspected_count": len(self.suspected_hits),
            "skipped_customer_mentions": self.skipped_customer_mentions,
            "blocked": self.blocked,
            "hits": [h.to_dict() for h in self.hits],
        }


def _is_negated(text: str, start: int) -> bool:
    """看匹配点前面 NEG_WINDOW 个字里有没有否定词。"""
    left = text[max(0, start - NEG_WINDOW): start]
    return any(n in left for n in NEGATIONS)


def _snippet(text: str, start: int, end: int, pad: int = 10) -> str:
    left = max(0, start - pad)
    right = min(len(text), end + pad)
    s = text[left:right]
    return ("…" if left > 0 else "") + s + ("…" if right < len(text) else "")


def scan(transcript: dict) -> ScanResult:
    """扫一通电话。只扫坐席说的话。

    同一句里可能多个词重叠命中（"稳赚不赔"里同时有"稳赚"），
    所以先收集所有 (start, end, word)，合并重叠区间只留最长的那个。
    不去重的话，一句话会被算成两三处违规，扣分量级就失真了。
    """
    result = ScanResult()
    turns = transcript.get("turns", [])

    for idx, turn in enumerate(turns):
        role = turn.get("role", "")
        text = turn.get("text", "") or ""
        if not text:
            continue

        for rule in RULES:
            spans: list[tuple[int, int, str]] = []
            for word in rule["words"]:
                for m in re.finditer(re.escape(word), text):
                    if role != "agent":
                        # 客户说的不算违规，但记一下，报告里要能解释
                        # "为什么这通电话提到了保本却没判违规"
                        result.skipped_customer_mentions += 1
                        continue
                    spans.append((m.start(), m.end(), word))

            if not spans:
                continue

            # 按起点排序，重叠的合并，保留最长匹配
            spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))
            kept: list[tuple[int, int, str]] = []
            for s, e, w in spans:
                if kept and s < kept[-1][1]:
                    # 和前一个重叠：留下更长的
                    ps, pe, pw = kept[-1]
                    if (e - s) > (pe - ps):
                        kept[-1] = (s, e, w)
                    continue
                kept.append((s, e, w))

            for s, e, w in kept:
                # 同一条规则在同一句话里出现两次（比如"验证码"说了两遍），
                # 合成一条、只记次数。分成两条会让报告看起来比实际更严重。
                same = next((h for h in result.hits
                             if h.rule_id == rule["id"] and h.turn_index == idx), None)
                if same is not None:
                    same.count += 1
                    continue
                result.hits.append(
                    RedlineHit(
                        rule_id=rule["id"],
                        category=rule["category"],
                        severity=rule["severity"],
                        why=rule["why"],
                        turn_index=idx,
                        t=turn.get("t", 0.0),
                        role=role,
                        text=text,
                        matched=w,
                        negated=_is_negated(text, s),
                        context=_snippet(text, s, e),
                    )
                )
    return result


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    p = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "data/calls/call-02-finance-redline.json"
    tr = json.loads(p.read_text(encoding="utf-8"))
    r = scan(tr)
    print(f"{tr['call_id']}  {tr['campaign']}")
    print(f"确认违规 {len(r.confirmed_hits)} 条 / 疑似 {len(r.suspected_hits)} 条 / "
          f"客户提及跳过 {r.skipped_customer_mentions} 次 / 一票否决={r.blocked}\n")
    for h in r.hits:
        flag = "疑似（否定语境）" if h.negated else ("【违规】" if h.severity == "block" else "【提醒】")
        print(f"  {flag} {h.category} · 命中「{h.matched}」· {h.t:5.1f}s")
        print(f"        …{h.context}…")
