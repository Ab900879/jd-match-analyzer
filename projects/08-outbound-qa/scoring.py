"""打分：规则权重表

为什么分不用模型算：
    让模型给坐席打 78 分，你没法解释这 78 是怎么来的，也没法复现。
    质检报告是要拿去跟坐席对话的——"你这通 78 分"和"你这两项没过、扣了 25 分"
    是两种完全不同的话。后者能改，前者只能争。

所以这里全部是可解释的加减：
    合规流程 40 分 —— 开场 / 身份 / 录音 / 拒绝后停止
    沟通质量 35 分 —— 打断 / 独白 / 结束语
    业务完成度 25 分 —— 意图识别 / 异议处理 / 下一步（数据来自打标）

一个容易做错的地方：不适用的项要**把权重拿掉**，而不是算 0 分。
    客户全程没拒绝，"拒绝后停止推销"这项就不该参与评分——
    否则一通本来挺好的电话会因为"客户没拒绝"而白扣 15 分。
    所以得分算法是：实得 / 适用总分 * 该段满分。
"""
from __future__ import annotations

from dataclasses import dataclass, field

SECTION_MAX = {"合规流程": 40, "沟通质量": 35, "业务完成度": 25}

# 异议处理效果的折算系数
HANDLE_CREDIT = {"有效回应": 1.0, "敷衍带过": 0.4, "完全忽略": 0.0, "反被说服": 0.0}

VERDICT_BANDS = [
    (85, "优秀"),
    (70, "合格"),
    (60, "待改进"),
    (0, "不合格"),
]


@dataclass
class ScoreResult:
    total: float = 0.0
    verdict: str = ""
    vetoed: bool = False          # 红线一票否决
    sections: dict = field(default_factory=dict)
    deductions: list[dict] = field(default_factory=list)
    bonus: list[dict] = field(default_factory=list)
    full_mark: int = 100          # 语义打标没跑就是 75
    tagging_used: bool = True

    def to_dict(self) -> dict:
        return {
            "total": round(self.total, 1),
            "verdict": self.verdict,
            "vetoed": self.vetoed,
            "full_mark": self.full_mark,
            "tagging_used": self.tagging_used,
            "sections": {k: round(v, 1) for k, v in self.sections.items()},
            "deductions": self.deductions,
            "bonus": self.bonus,
        }


def _band(score: float) -> str:
    for threshold, name in VERDICT_BANDS:
        if score >= threshold:
            return name
    return "不合格"


def compute(compliance, redline, tagging) -> ScoreResult:
    """compliance: ComplianceResult；redline: ScanResult；tagging: TagResult"""
    res = ScoreResult()
    res.tagging_used = bool(tagging and tagging.available)

    # ---- 一票否决 ----
    if redline.blocked:
        res.vetoed = True
        res.total = 0.0
        res.verdict = "违规·需人工复核"
        for h in redline.confirmed_hits:
            if h.severity == "block":
                res.deductions.append({
                    "section": "红线", "item": h.category, "weight": 100,
                    "reason": f"{h.t:.1f}s 命中「{h.matched}」：{h.why}",
                    "quote": h.context,
                })
        return res

    # ---- 合规流程 + 沟通质量 ----
    for section in ("合规流程", "沟通质量"):
        checks = [c for c in compliance.checks if c.section == section and c.weight > 0]
        applicable = [c for c in checks if c.status != "na"]
        earned = sum(c.weight for c in applicable if c.status == "pass")
        possible = sum(c.weight for c in applicable)

        if possible == 0:
            res.sections[section] = SECTION_MAX[section]  # 全都不适用，这段不扣分
        else:
            res.sections[section] = earned / possible * SECTION_MAX[section]

        for c in applicable:
            if c.status != "pass":
                # 按权重折算成实际扣分
                actual = c.weight / possible * SECTION_MAX[section]
                res.deductions.append({
                    "section": section, "item": c.name,
                    "weight": round(actual, 1), "reason": c.detail,
                    "quote": (c.evidence[0]["text"] if c.evidence else ""),
                })
            else:
                res.bonus.append({"section": section, "item": c.name})

    # ---- 业务完成度（来自打标） ----
    if res.tagging_used:
        got, out = _business_score(tagging, res)
        res.sections["业务完成度"] = got / out * SECTION_MAX["业务完成度"] if out else SECTION_MAX["业务完成度"]
    else:
        res.sections["业务完成度"] = 0.0
        res.full_mark = 75

    res.total = sum(res.sections.values())
    res.verdict = _band(res.total / res.full_mark * 100)
    return res


def _business_score(tagging, res: ScoreResult) -> tuple[float, float]:
    """业务完成度：意图 5 + 异议 12 + 下一步 8 = 25"""
    d = tagging.data or {}
    got, out = 0.0, 0.0

    # 意图识别：有明确意图且有原话支撑，才算识别出来了
    out += 5
    if d.get("intent_evidence") and d.get("customer_intent") not in ("未表达清楚",):
        got += 5
    else:
        res.deductions.append({
            "section": "业务完成度", "item": "客户意图识别", "weight": 5,
            "reason": "没能从对话里定位客户的明确意图（或没有原话支撑）",
            "quote": "",
        })

    # 异议处理：按效果折算
    obs = d.get("objections") or []
    out += 12
    if not obs:
        got += 12  # 客户没提异议，不扣分
    else:
        ratio = sum(HANDLE_CREDIT.get(o.get("handled", ""), 0) for o in obs) / len(obs)
        got += 12 * ratio
        bad = [o for o in obs if HANDLE_CREDIT.get(o.get("handled", ""), 0) < 1.0]
        for o in bad:
            res.deductions.append({
                "section": "业务完成度", "item": f"异议处理·{o.get('type')}",
                "weight": round(12 / len(obs) * (1 - HANDLE_CREDIT.get(o.get("handled", ""), 0)), 1),
                "reason": f"客户提出「{o.get('quote')}」，坐席{o.get('handled')}",
                "quote": o.get("handle_quote", ""),
            })

    # 下一步
    out += 8
    nxt = d.get("next_step")
    got += {"有明确下一步": 8, "模糊": 4, "无": 0}.get(nxt, 0)
    if nxt != "有明确下一步":
        res.deductions.append({
            "section": "业务完成度", "item": "是否有明确下一步", "weight": 8 if nxt == "无" else 4,
            "reason": f"通话结束时下一步是「{nxt}」",
            "quote": d.get("next_step_evidence", ""),
        })

    return got, out


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    import compliance as C
    import redline as R
    import tagging as T

    p = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "data/calls/call-01-edu-good.json"
    tr = json.loads(p.read_text(encoding="utf-8"))
    s = compute(C.check(tr), R.scan(tr), T.tag(tr))
    print(f"{tr['call_id']}  {tr['campaign']}")
    print(f"总分 {s.total:.1f}/{s.full_mark} · {s.verdict} · 一票否决={s.vetoed}")
    for k, v in s.sections.items():
        print(f"  {k}: {v:.1f}/{SECTION_MAX[k]}")
    print("\n扣分：")
    for d in s.deductions:
        print(f"  -{d['weight']:>5.1f}  [{d['section']}] {d['item']}：{d['reason']}")
