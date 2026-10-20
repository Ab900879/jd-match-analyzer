"""流程合规检查：坐席该做的动作有没有做对

这一层全是能数出来的东西：开场有没有自报身份、有没有确认对方是本人、
客户说"不需要"之后有没有停、有没有打断客户。所以用规则，不用模型——
能数清楚的事交给模型，等于把确定的事做成不确定的。

打断怎么判：ASR 给的是句子级时间戳，没有词级时间戳。
所以用估算：中文电话语速按 4.5 字/秒算，一句话的结束时间 ≈ 起始时间 + 字数/4.5。
下一句的开始时间只要早于上一句的估算结束时间，就认为发生了抢话/打断。

这个方法有误差，但方向是对的：它抓的是"重叠"，不是"语气"。
误差主要出现在语速特别快或特别慢的人身上，所以报告里把它标成"估算"。
"""
from __future__ import annotations

from dataclasses import dataclass, field

CHARS_PER_SEC = 4.5          # 中文电话语速估算
OVERLAP_TOLERANCE = 0.5      # 小于这个重叠量不算打断（留给时间戳误差）
MONOLOGUE_CHARS = 90         # 单轮超过这么多字，客户基本插不进话
OPENING_WINDOW = 30.0        # 开场判断窗口（秒）
TALK_RATIO_MAX = 0.90        # 参考指标用的上限（外呼场景坐席本就偏多话）
TALK_RATIO_MIN = 0.30

# 客户话被截断的标志。ASR 断句不会给"……"，所以它出现基本就是话没说完
TRUNC_MARKS = ["……", "…"]

DECLINE_WORDS = [
    "不需要", "不用了", "不用", "没兴趣", "不感兴趣", "不要",
    "别再打", "不要再打", "不考虑", "暂时不需要", "我说了不用",
    "先不", "不用谢", "我不能给你",
]
# 客户拒绝之后，坐席出现这些动作就算"继续推销"
PUSH_WORDS = [
    "加个微信", "考虑一下", "考虑考虑", "名额", "活动", "优惠", "折扣",
    "再联系", "明天再", "再给您打", "办一个", "帮您办", "投个", "先占",
    "要不先", "再想想", "机会难得", "截止",
]

SELF_ID_WORDS = ["我这边是", "我们是", "我姓", "工号", "我是", "公司"]
IDENTITY_WORDS = ["本人", "是您吗", "请问是", "您是吗"]
RECORD_WORDS = ["录音", "通话将被记录", "全程录音"]
CLOSING_WORDS = ["再见", "祝您", "感谢您接听", "不打扰您", "祝您生活愉快", "祝您工作顺利"]


@dataclass
class Check:
    id: str
    name: str
    section: str          # 合规流程 / 沟通质量
    weight: int
    status: str = "pass"  # pass / fail / na
    detail: str = ""
    evidence: list[dict] = field(default_factory=list)
    estimated: bool = False   # 这条结论是不是估算出来的

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "section": self.section,
            "weight": self.weight, "status": self.status, "detail": self.detail,
            "evidence": self.evidence, "estimated": self.estimated,
        }


@dataclass
class ComplianceResult:
    checks: list[Check] = field(default_factory=list)
    talk_ratio: float = 0.0       # 坐席说话占比
    agent_chars: int = 0
    customer_chars: int = 0
    interruptions: int = 0

    def to_dict(self) -> dict:
        return {
            "checks": [c.to_dict() for c in self.checks],
            "talk_ratio": round(self.talk_ratio, 3),
            "agent_chars": self.agent_chars,
            "customer_chars": self.customer_chars,
            "interruptions": self.interruptions,
        }


def _est_end(turn: dict) -> float:
    return turn.get("t", 0.0) + len(turn.get("text", "")) / CHARS_PER_SEC


def _ev(turn: dict, idx: int, note: str = "") -> dict:
    return {"turn_index": idx, "t": turn.get("t", 0.0),
            "role": turn.get("role"), "text": turn.get("text", ""), "note": note}


def check(transcript: dict) -> ComplianceResult:
    turns = transcript.get("turns", [])
    res = ComplianceResult()

    agent_turns = [(i, t) for i, t in enumerate(turns) if t.get("role") == "agent"]
    cust_turns = [(i, t) for i, t in enumerate(turns) if t.get("role") == "customer"]

    res.agent_chars = sum(len(t.get("text", "")) for _, t in agent_turns)
    res.customer_chars = sum(len(t.get("text", "")) for _, t in cust_turns)
    total = res.agent_chars + res.customer_chars
    res.talk_ratio = res.agent_chars / total if total else 0.0

    # ---- 1. 开场自报家门 ----
    opening = [(i, t) for i, t in agent_turns if t.get("t", 0) <= OPENING_WINDOW]
    found = [(i, t) for i, t in opening if any(w in t.get("text", "") for w in SELF_ID_WORDS)]
    res.checks.append(Check(
        id="opening_selfid", name="开场自报公司与身份", section="合规流程", weight=10,
        status="pass" if found else "fail",
        detail=(f"在 {found[0][1].get('t', 0):.1f}s 说清了身份" if found
                else f"前 {OPENING_WINDOW:.0f} 秒没有自报公司或身份"),
        evidence=[_ev(t, i) for i, t in (found[:1] if found else opening[:1])],
    ))

    # ---- 2. 确认对方是否本人 ----
    id_found = [(i, t) for i, t in agent_turns
                if any(w in t.get("text", "") for w in IDENTITY_WORDS)]
    res.checks.append(Check(
        id="confirm_identity", name="确认对方是否为本人", section="合规流程", weight=10,
        status="pass" if id_found else "fail",
        detail=("开场确认了接听人身份" if id_found else "没有确认接听人是否为本人，存在骚扰非目标人的风险"),
        evidence=[_ev(t, i) for i, t in id_found[:1]],
    ))

    # ---- 3. 录音告知 ----
    if transcript.get("recorded"):
        rec = [(i, t) for i, t in agent_turns if any(w in t.get("text", "") for w in RECORD_WORDS)]
        res.checks.append(Check(
            id="record_notice", name="告知通话录音", section="合规流程", weight=5,
            status="pass" if rec else "fail",
            detail=("已告知录音" if rec else "这通电话被录音，但坐席全程没有告知"),
            evidence=[_ev(t, i) for i, t in rec[:1]],
        ))
    else:
        res.checks.append(Check(
            id="record_notice", name="告知通话录音", section="合规流程", weight=5,
            status="na", detail="本通未录音，不适用",
        ))

    # ---- 4. 客户明确拒绝后是否继续推销（最容易踩的一条） ----
    decline_idx = [(i, t) for i, t in cust_turns
                   if any(w in t.get("text", "") for w in DECLINE_WORDS)]
    if not decline_idx:
        res.checks.append(Check(
            id="stop_after_decline", name="客户拒绝后停止推销", section="合规流程", weight=15,
            status="na", detail="客户全程未明确拒绝，不适用",
        ))
    else:
        first_decline_i, first_decline_t = decline_idx[0]
        after = [(i, t) for i, t in agent_turns if i > first_decline_i]
        pushed = [(i, t) for i, t in after
                  if any(w in t.get("text", "") for w in PUSH_WORDS)]
        res.checks.append(Check(
            id="stop_after_decline", name="客户拒绝后停止推销", section="合规流程", weight=15,
            status="fail" if pushed else "pass",
            detail=(f"客户在 {first_decline_t.get('t', 0):.1f}s 明确拒绝，之后坐席仍有 {len(pushed)} 次推销动作"
                    if pushed else "客户拒绝后没有再推销"),
            evidence=[_ev(first_decline_t, first_decline_i, "客户拒绝处")]
                       + [_ev(t, i, "之后仍继续推销") for i, t in pushed[:2]],
        ))

    # ---- 5. 打断 / 抢话（估算） ----
    # 判据两个，任一成立就算：
    #   a) 估算重叠超过 0.5 秒——这个量级不可能是时间戳误差
    #   b) 重叠很小，但客户那句以"……"收尾——那就是话没说完被接走了
    # 只用一个阈值不行：误差本身就有零点几秒，阈值调低会误判，
    # 调高又会漏掉"客户刚张嘴就被接过去"这种最典型的抢话。
    inter = []
    for k in range(len(turns) - 1):
        cur, nxt = turns[k], turns[k + 1]
        if cur.get("role") != nxt.get("role") and nxt.get("role") == "agent":
            overlap = _est_end(cur) - nxt.get("t", 0.0)
            if overlap <= 0:
                continue
            cut_off = any(cur.get("text", "").rstrip().endswith(m) for m in TRUNC_MARKS)
            if overlap > OVERLAP_TOLERANCE or (cut_off and overlap > 0.15):
                inter.append((k, cur, nxt, overlap, cut_off))
    res.interruptions = len(inter)
    res.checks.append(Check(
        id="interrupt", name="没有打断客户", section="沟通质量", weight=15,
        status="fail" if inter else "pass",
        detail=(f"估算有 {len(inter)} 处抢话，最长重叠 {max(o for *_, o, _c in inter):.1f} 秒"
                if inter else "没有检测到抢话"),
        evidence=[_ev(c, k, f"客户话未说完（估算重叠 {o:.1f}s{', 以省略号收尾' if c2 else ''}）")
                  for k, c, _, o, c2 in inter[:2]],
        estimated=True,
    ))

    # ---- 6. 单轮过长 ----
    long_turns = [(i, t) for i, t in agent_turns if len(t.get("text", "")) >= MONOLOGUE_CHARS]
    res.checks.append(Check(
        id="no_monologue", name="单次说话不过长", section="沟通质量", weight=10,
        status="fail" if long_turns else "pass",
        detail=(f"有 {len(long_turns)} 次单轮超过 {MONOLOGUE_CHARS} 字，客户插不进话"
                if long_turns else "没有超长独白"),
        evidence=[_ev(t, i, f"{len(t.get('text', ''))} 字") for i, t in long_turns[:2]],
        estimated=True,
    ))

    # ---- 7. 说话配比（参考指标，不参与打分） ----
    # 这条我原本做成了扣分项，结果 5 通电话全挂，包括那通做得好的。
    # 原因很简单：外呼场景坐席本来就要说 70%~85%，客户一般只回一两个字。
    # 规则的判断跟场景对不上，错的不是电话，是尺子。
    #
    # 所以把它降级成参考指标：weight=0，不参与打分，只在报告里显示。
    # 一条规则如果在样本上区分不出好坏，它就不该参与评分。
    balanced = TALK_RATIO_MIN <= res.talk_ratio <= TALK_RATIO_MAX
    res.checks.append(Check(
        id="talk_balance", name="说话配比（参考）", section="参考指标", weight=0,
        status="pass" if balanced else "warn",
        detail=(f"坐席占 {res.talk_ratio:.0%}" + ("" if balanced else "，偏高，可留意是否给客户留了说话空间")),
        estimated=True,
    ))

    # ---- 8. 结束语 ----
    tail = [(i, t) for i, t in agent_turns[-2:]] if len(agent_turns) >= 2 else agent_turns
    closed = [(i, t) for i, t in tail if any(w in t.get("text", "") for w in CLOSING_WORDS)]
    res.checks.append(Check(
        id="closing", name="有礼貌的结束语", section="沟通质量", weight=5,
        status="pass" if closed else "fail",
        detail=("结尾有结束语" if closed else "结尾没有结束语，直接挂断"),
        evidence=[_ev(t, i) for i, t in closed[:1]],
    ))

    return res


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    p = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "data/calls/call-03-auto-declined.json"
    tr = json.loads(p.read_text(encoding="utf-8"))
    r = check(tr)
    print(f"{tr['call_id']}  {tr['campaign']}")
    print(f"坐席说话占比 {r.talk_ratio:.0%}（坐席 {r.agent_chars} 字 / 客户 {r.customer_chars} 字）")
    print(f"抢话 {r.interruptions} 处\n")
    for c in r.checks:
        mark = {"pass": "✅", "fail": "❌", "na": "－"}[c.status]
        est = "（估算）" if c.estimated else ""
        print(f"  {mark} [{c.section}/{c.weight}] {c.name}{est}：{c.detail}")
