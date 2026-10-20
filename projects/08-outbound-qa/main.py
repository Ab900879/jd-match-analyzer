"""外呼质检器 · 命令行入口

用法：
  python main.py --all                  # 跑 data/calls 下全部通话，出汇总页
  python main.py --file data/calls/xxx.json
  python main.py --all --no-llm         # 不调模型，只跑规则层（离线可用）
  python main.py --all --out reports    # 指定输出目录

为什么默认跑全部：
  质检是抽样工作，单看一通电话说明不了坐席水平。跑一批才看得出
  是这个人有问题，还是这个活动的话术本身有问题。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import compliance as C
import redline as R
import report as Rep
import scoring as S
import tagging as T

ROOT = Path(__file__).parent
DEFAULT_CALLS = ROOT / "data" / "calls"


def load_calls(files: list[Path]) -> list[dict]:
    out = []
    for p in files:
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except json.JSONDecodeError as e:
            print(f"[跳过] {p.name} 不是合法 JSON：{e}")
    return out


def analyze(transcript: dict, use_llm: bool = True) -> dict:
    rl = R.scan(transcript)
    cp = C.check(transcript)
    if use_llm:
        tg = T.tag(transcript)
    else:
        tg = T.TagResult(available=False, error="本次运行加了 --no-llm")
    sc = S.compute(cp, rl, tg)
    return {"transcript": transcript, "redline": rl, "compliance": cp, "tagging": tg, "score": sc}


def print_one(b: dict) -> None:
    tr, rl, cp, tg, sc = (b["transcript"], b["redline"], b["compliance"],
                          b["tagging"], b["score"])
    flag = "  【需人工复核】" if sc.vetoed else ""
    print(f"\n{'='*62}")
    print(f"{tr['call_id']}  {tr['campaign']}  坐席 {tr.get('agent_id')}")
    print(f"得分 {sc.total:.0f}/{sc.full_mark}  ·  {sc.verdict}{flag}")
    print(f"  合规流程 {sc.sections.get('合规流程', 0):.0f}/40  "
          f"沟通质量 {sc.sections.get('沟通质量', 0):.0f}/35  "
          f"业务完成度 {sc.sections.get('业务完成度', 0):.0f}/25")

    if rl.confirmed_hits:
        print(f"  红线 {len(rl.confirmed_hits)} 条：")
        for h in rl.confirmed_hits:
            print(f"    · {h.t:5.1f}s [{h.category}] 命中「{h.matched}」")
    if rl.suspected_hits:
        print(f"  疑似 {len(rl.suspected_hits)} 条（否定语境，需人工确认）")

    fails = [c for c in cp.checks if c.status == "fail"]
    if fails:
        print("  未通过：")
        for c in fails:
            print(f"    · {c.name}：{c.detail}")

    if tg.available:
        d = tg.data
        print(f"  客户意图：{d.get('customer_intent')}｜情绪：{d.get('customer_sentiment')}"
              f"｜下一步：{d.get('next_step')}")
        if tg.fabricated_dropped:
            print(f"  模型引用校验：丢弃 {tg.fabricated_dropped} 条查无原文的结论")
    else:
        print(f"  语义打标未运行（{tg.error}），本通按 75 分制计算")


def run(files: list[Path], use_llm: bool, out_dir: Path) -> int:
    calls = load_calls(files)
    if not calls:
        print("没有可分析的通话。")
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    bundles = []
    t0 = time.time()

    for tr in calls:
        print(f"分析 {tr['call_id']} {tr['campaign']} …", flush=True)
        try:
            b = analyze(tr, use_llm)
        except Exception as e:
            print(f"  [失败] {type(e).__name__}: {e}")
            continue
        bundles.append(b)
        print_one(b)
        (out_dir / f"{tr['call_id']}.html").write_text(Rep.render_call(b), encoding="utf-8")
        # 同时存一份机器可读的结果，方便以后接看板或做回归
        (out_dir / f"{tr['call_id']}.json").write_text(
            json.dumps({
                "call_id": tr["call_id"],
                "campaign": tr["campaign"],
                "score": b["score"].to_dict(),
                "redline": b["redline"].to_dict(),
                "compliance": b["compliance"].to_dict(),
                "tagging": b["tagging"].to_dict(),
            }, ensure_ascii=False, indent=2), encoding="utf-8")

    if not bundles:
        print("全部失败。")
        return 1

    (out_dir / "index.html").write_text(Rep.render_index(bundles), encoding="utf-8")

    n = len(bundles)
    n_veto = sum(1 for b in bundles if b["score"].vetoed)
    avg = sum(b["score"].total / b["score"].full_mark * 100 for b in bundles) / n
    print(f"\n{'='*62}")
    print(f"共 {n} 通，{time.time()-t0:.1f} 秒，平均 {avg:.0f} 分，红线违规 {n_veto} 通")
    print(f"报告：{out_dir / 'index.html'}")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="外呼质检器")
    ap.add_argument("--file", type=Path, action="append", help="指定通话 JSON（可多次）")
    ap.add_argument("--all", action="store_true", help="跑 data/calls 下全部")
    ap.add_argument("--no-llm", action="store_true", help="不调模型，只跑规则层")
    ap.add_argument("--out", type=Path, default=ROOT / "reports", help="输出目录")
    a = ap.parse_args()

    if a.file:
        files = a.file
    elif a.all:
        files = sorted(DEFAULT_CALLS.glob("*.json"))
    else:
        ap.print_help()
        sys.exit(0)

    sys.exit(run(files, not a.no_llm, a.out))
