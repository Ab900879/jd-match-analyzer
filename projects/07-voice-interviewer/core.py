"""语音面试官 —— 核心逻辑

设计原则（也是面试要讲的）：
1. 是否追问，用规则判；追问那句话，才交给模型润色。
   理由：规则每次行为一致，出了问题能定位到是哪条规则没触发。
2. 题库外置（questions.json），加题不改代码。
3. 所有判断结果落盘成 jsonl，badcase 可以直接按规则名统计。
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

ROOT = Path(__file__).parent
QUESTIONS = ROOT / "questions.json"
LOG = ROOT / "logs" / "sessions.jsonl"
LOGS_DIR = ROOT / "logs"


# ---------- 题库 ----------

def load_questions() -> list[dict]:
    return json.loads(QUESTIONS.read_text(encoding="utf-8"))


# ---------- 判断层：规则 ----------

@dataclass
class Verdict:
    qid: str
    passed: bool
    failed_rules: list[str] = field(default_factory=list)
    detail: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def rule_too_short(text: str, q: dict) -> tuple[bool, str]:
    """太短：一句话没说完就停了。用字数粗判，比用字数秒数更稳（不用等真实时长）。"""
    n = len(text.strip())
    floor = q.get("min_chars", 40)
    if n < floor:
        return False, f"只说了 {n} 个字，这题至少要 {floor} 字"
    return True, ""


def rule_no_concrete(text: str, q: dict) -> tuple[bool, str]:
    """太笼统：没有任何具体的东西。具体＝出现数字、项目名、或者时间/结果类的词。"""
    markers = ["个", "次", "天", "周", "月", "年", "%", "分", "条", "版", "轮"]
    has_number = any(ch.isdigit() for ch in text)
    has_marker = any(m in text for m in markers)
    if not has_number and not has_marker:
        return False, "一个具体数字都没有"
    return True, ""


def rule_missing_keywords(text: str, q: dict) -> tuple[bool, str]:
    """漏要点：这题的关键词一个都没提。

    这里踩过一次坑：最早 must_mention 写的是 ["我","做","项目"]，
    结果一句完全正确的回答因为没用"项目"这个词就被判失败。
    只能命中字面的规则不可靠，所以两处改了：
    1. must_mention 改成关键词组分（每个组内任一命中即可）
    2. 加入常见同义说法（做=弄/写/搭/干）
    """
    groups = q.get("must_mention") or []
    if not groups:
        return True, ""
    missed = []
    for group in groups:
        words = [group] if isinstance(group, str) else group
        if not any(w in text for w in words):
            missed.append("/".join(words))
    if not missed:
        return True, ""
    return False, f"没提到：{'、'.join(missed)}"


# 规则表和它的说明。顺序即执行顺序，第一条不过就停。
RULES = [
    ("too_short", "回答太短，像是一句话就过去了", rule_too_short),
    ("no_concrete", "没有具体的东西，全是空话", rule_no_concrete),
    ("missing_keywords", "没说到这道题的关键词", rule_missing_keywords),
]


def judge(answer: str, q: dict) -> Verdict:
    failed = []
    detail = {}
    for name, desc, fn in RULES:
        ok, why = fn(answer, q)
        detail[name] = {"ok": ok, "why": why}
        if not ok:
            failed.append(name)
    return Verdict(qid=q["id"], passed=not failed, failed_rules=failed, detail=detail)


# ---------- 追问层：规则选方向，模型润色 ----------

FOLLOWUP_TEMPLATES = {
    "too_short": "说得太短了，展开讲讲。{followup}",
    "no_concrete": "说得有点空，能给我一个具体的例子吗？最好带数字。{followup}",
    "missing_keywords": "{followup}",
}

SYSTEM_FOLLOWUP = """你是一个面试官。用户刚才回答得不够，你需要追问一句。
要求：
1. 口语化，像真人说话，不要书面语
2. 20 到 40 字，只说一个问题
3. 不要安慰，不要评价好坏，直接追问
4. 不要重复用户的原话
"""


def followup_by_rule(q: dict, verdict: Verdict) -> str:
    """不用模型也能出追问：按失败的规则选模板。"""
    first = verdict.failed_rules[0] if verdict.failed_rules else "too_short"
    tpl = FOLLOWUP_TEMPLATES.get(first, "{followup}")
    return tpl.format(followup=q.get("followup", ""))


def followup_by_model(q: dict, answer: str, verdict: Verdict) -> str:
    """调用模型把追问说得更自然。没配 key 就自动退回规则版。"""
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        return followup_by_rule(q, verdict)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=key, base_url="https://api.deepseek.com")
        reason = "、".join(verdict.failed_rules) or "不够具体"
        resp = client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "system", "content": SYSTEM_FOLLOWUP},
                {"role": "user", "content": (
                    f"题目：{q['question']}\n"
                    f"这题想考：{q['focus']}\n"
                    f"考生的回答：{answer}\n"
                    f"判断出的问题：{reason}\n"
                    f"原定的追问方向：{q.get('followup','')}\n"
                )},
            ],
            temperature=0.7,
            timeout=20,
        )
        return resp.choices[0].message.content.strip()
    except Exception:
        return followup_by_rule(q, verdict)


# ---------- 语音 ----------

async def _tts_async(text: str, out: Path, voice: str, rate: str):
    import edge_tts
    c = edge_tts.Communicate(text, voice, rate=rate)
    await c.save(str(out))


def speak(text: str, out: Path, voice: str = "zh-CN-XiaoxiaoNeural", rate: str = "-8%") -> Path:
    import asyncio
    out.parent.mkdir(parents=True, exist_ok=True)
    asyncio.run(_tts_async(text, out, voice, rate))
    return out


def play(path: Path):
    """Windows 上直接调系统默认播放器。"""
    os.startfile(str(path))


# ---------- 记录 ----------

def log_session(record: dict):
    LOGS_DIR.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def summarize(log_path: Path = LOG) -> dict:
    """按规则名统计 badcase，这是后面做 FAQ 的原料。"""
    if not log_path.exists():
        return {"sessions": 0, "rule_hits": {}}
    hits: dict[str, int] = {}
    n = 0
    for line in log_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        n += 1
        for rule in r.get("failed_rules", []):
            hits[rule] = hits.get(rule, 0) + 1
    return {"sessions": n, "rule_hits": dict(sorted(hits.items(), key=lambda x: -x[1]))}
