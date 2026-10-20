"""语义打标：唯一让模型参与的环节

为什么这层可以用模型：
    客户那句话到底算"有需求但犹豫"还是"明确拒绝"，这是语义问题，
    规则只能靠关键词猜——"我再看看"和"我看看你们资料"字面几乎一样，
    意思完全相反。这类判断交给规则，不如交给模型。

但模型参与不等于相信模型。这层加了三道约束：

约束一：每条结论必须抄原文。
    模型说"客户对价格有异议"，必须给出客户的原话片段。
    跟 JD 匹配器同一个原则：抄不出原话的结论，一律当它编的。

约束二：抄的原话要能在原文里查到。
    代码里做子串校验，查不到就丢掉这条结论，并在结果里记一笔
    "被丢弃的编造条目数"。这个数字本身就是模型可信度的指标。

约束三：temperature=0。
    打标是分类任务，不需要创造力。同样的通话跑两次结果应该一样，
    否则质检报告就没法复盘。
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

# ---------- 标签体系 ----------
# 这些枚举值写死，不让模型自己发挥。模型最爱干的事就是
# 在枚举之外发明新分类，那样统计就没法聚合了。

CUSTOMER_INTENT = [
    "需求明确", "有需求但犹豫", "无明确需求", "明确拒绝",
    "已在别处解决", "未表达清楚",
]
CUSTOMER_SENTIMENT = ["正向", "中性", "负向", "明显反感"]
OBJECTION_TYPES = ["价格", "时间", "信任", "已有替代方案", "不需要", "身份顾虑", "其他"]
HANDLE_RESULT = ["有效回应", "敷衍带过", "完全忽略", "反被说服"]
NEXT_STEP = ["有明确下一步", "模糊", "无"]

SYSTEM_PROMPT = """你是电话销售质检员。你的任务是给一通外呼通话打标签。

严格要求：
1. 只输出 JSON，不要任何解释文字，不要 markdown 代码块。
2. evidence 里的每一句必须是通话记录里的**原话片段**，逐字复制，不许改写、不许概括。
3. 如果某个判断你找不到原话支撑，就把该项留空（空字符串或空数组），不要编。
4. 枚举字段只能从给定选项里选，不许自创新分类。

只输出这个结构：
{
  "customer_intent": "从 __INTENT__ 里选一个",
  "intent_evidence": "客户原话片段",
  "customer_sentiment": "从 __SENTIMENT__ 里选一个",
  "sentiment_evidence": "客户原话片段",
  "objections": [
    {"type": "从 __OBJ__ 里选一个", "quote": "客户原话片段",
     "handled": "从 __HANDLE__ 里选一个", "handle_quote": "坐席原话片段"}
  ],
  "next_step": "从 __NXT__ 里选一个",
  "next_step_evidence": "坐席原话片段",
  "summary": "一句话总结这通电话（不超过40字，不加评价性形容词）"
}"""
# 注意：这里不用 str.format 填枚举，因为正文里有大量 JSON 大括号，
# format 会把它们当成占位符（第一次就是这么报的 KeyError）。用 replace 更稳。


@dataclass
class TagResult:
    available: bool = True
    data: dict = field(default_factory=dict)
    fabricated_dropped: int = 0       # 引用对不上、被丢掉的条数
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "tagging": self.data,
            "fabricated_dropped": self.fabricated_dropped,
            "error": self.error,
        }


def _transcript_text(transcript: dict) -> str:
    """把对话拼成"坐席：xxx / 客户：xxx"的形式给模型看。"""
    lines = []
    for t in transcript.get("turns", []):
        who = "坐席" if t.get("role") == "agent" else "客户"
        lines.append(f"{who}：{t.get('text', '')}")
    return "\n".join(lines)


def _norm(s: str) -> str:
    """比较引用时忽略标点和空白——模型抄原话时常把逗号句号弄丢。"""
    return re.sub(r"[\s，。！？、,.!?；;：:\"'“”‘’…—\-]", "", s or "")


def _verify(quote: str, source_norm: str) -> bool:
    q = _norm(quote)
    if not q:
        return False
    return q in source_norm


def _extract_json(raw: str) -> dict:
    """模型有时候会裹一层 markdown 代码块，或者前后多说两句。"""
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", raw)
        if m:
            return json.loads(m.group(0))
        raise


def tag(transcript: dict, model: str = "deepseek-chat", timeout: int = 60) -> TagResult:
    """调用模型打标，并校验它抄的原话是不是真的。"""
    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not key:
        return TagResult(available=False, error="没有 DEEPSEEK_API_KEY，语义打标未运行")

    try:
        from openai import OpenAI
    except ImportError:
        return TagResult(available=False, error="没有安装 openai 包，语义打标未运行")

    base = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    client = OpenAI(api_key=key, base_url=base)

    convo = _transcript_text(transcript)
    system = (SYSTEM_PROMPT
              .replace("__INTENT__", "/".join(CUSTOMER_INTENT))
              .replace("__SENTIMENT__", "/".join(CUSTOMER_SENTIMENT))
              .replace("__OBJ__", "/".join(OBJECTION_TYPES))
              .replace("__HANDLE__", "/".join(HANDLE_RESULT))
              .replace("__NXT__", "/".join(NEXT_STEP)))

    try:
        resp = client.chat.completions.create(
            model=model,
            temperature=0,          # 分类任务，不需要发挥
            timeout=timeout,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": f"通话记录：\n{convo}"},
            ],
        )
        raw = resp.choices[0].message.content or ""
        data = _extract_json(raw)
    except Exception as e:
        return TagResult(available=False, error=f"模型调用失败：{e}")

    # ---- 校验：把抄不出原话的结论全删掉 ----
    src = _norm(convo)
    dropped = 0

    for field_name in ("intent_evidence", "sentiment_evidence", "next_step_evidence"):
        q = data.get(field_name, "")
        if q and not _verify(q, src):
            data[field_name] = ""
            dropped += 1

    kept_objections = []
    for ob in data.get("objections", []) or []:
        quote_ok = _verify(ob.get("quote", ""), src)
        handle_ok = _verify(ob.get("handle_quote", ""), src) if ob.get("handle_quote") else True
        if not quote_ok:
            dropped += 1
            continue
        if not handle_ok:
            ob["handle_quote"] = ""
            dropped += 1
        kept_objections.append(ob)
    data["objections"] = kept_objections

    # ---- 枚举兜底：模型自创分类的，归到"其他"或标记 ----
    if data.get("customer_intent") not in CUSTOMER_INTENT:
        data["customer_intent"] = "未表达清楚"
    if data.get("customer_sentiment") not in CUSTOMER_SENTIMENT:
        data["customer_sentiment"] = "中性"
    if data.get("next_step") not in NEXT_STEP:
        data["next_step"] = "模糊"
    for ob in data["objections"]:
        if ob.get("type") not in OBJECTION_TYPES:
            ob["type"] = "其他"
        if ob.get("handled") not in HANDLE_RESULT:
            ob["handled"] = "敷衍带过"

    return TagResult(available=True, data=data, fabricated_dropped=dropped)


if __name__ == "__main__":
    import sys
    from pathlib import Path

    p = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "data/calls/call-03-auto-declined.json"
    tr = json.loads(p.read_text(encoding="utf-8"))
    r = tag(tr)
    print(f"{tr['call_id']}  {tr['campaign']}")
    if not r.available:
        print("语义打标未运行：", r.error)
        raise SystemExit(0)
    print(json.dumps(r.data, ensure_ascii=False, indent=2))
    print(f"\n被丢弃的编造引用：{r.fabricated_dropped} 条")
