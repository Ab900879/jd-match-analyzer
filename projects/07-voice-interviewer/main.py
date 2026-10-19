"""语音面试官 · 命令行入口

用法：
  python main.py                  # 文字模式（不用麦克风，先跑通逻辑）
  python main.py --voice          # 语音模式：它念题、你说话、它转写成文字
  python main.py --listen-only    # 只念题，不判断（验证语音链路）
  python main.py --devices        # 看本机有哪些可录音的麦克风
  python main.py --report         # 看积累下来的 badcase 统计

为什么默认是文字模式：
  语音整条链路长（录音→剪静音→转写），一上来就全上，出错了不知道是哪一段坏的。
  先用文字把"判断+追问"跑对，再接麦克风。这不是功能残缺，是调试顺序。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import core

AUDIO = core.ROOT / "audio"


def ensure_question_audio(qs: list[dict]) -> dict[str, Path]:
    """一次性把所有题的语音生成好，练的时候直接放，不用等。"""
    paths = {}
    for q in qs:
        p = AUDIO / f"{q['id']}.mp3"
        if not p.exists():
            print(f"  生成语音 {q['id']} …")
            core.speak(q["question"], p)
        paths[q["id"]] = p
    return paths


def ask_by_typing(prompt: str) -> str:
    print("\n（说完按回车。输入 /skip 跳过，/quit 退出）")
    return input("你的回答 > ").strip()


def ask_by_mic(seconds_hint: int) -> str:
    """录音 → 转写。

    录音走 voice_io.record_wav（Windows 原生 waveIn，零依赖），
    转写走 voice_io.get_transcriber()（本地 whisper 或在线接口）。

    这里不再"装不上就退回打字"：录音能录就录，转写缺什么就报什么。
    因为退回打字会让"语音模式"变成一句假话——用户以为在练语音，
    其实还在敲键盘，面试时张不开嘴。
    """
    import voice_io

    secs = max(8, int(seconds_hint))
    wav = AUDIO / f"_ans_{int(time.time())}.wav"
    print(f"\n开始录音（最多 {secs} 秒，说完就停）…")

    try:
        voice_io.record_wav(wav, seconds=secs)
    except RuntimeError as e:
        print(f"\n[录音失败] {e}\n这一题改用打字，其它题不受影响。")
        return ask_by_typing("")

    # 剪掉尾巴的静音，再判断是不是压根没说话
    trimmed = wav.with_name(wav.stem + "_trim.wav")
    voice_io.trim_silence(wav, trimmed, keep_tail=0.4)
    if voice_io.wav_is_silent(trimmed, threshold=200):
        print("  （没听到声音：可能麦克风没开，或者 Windows 隐私设置里没允许访问麦克风）")
        return ""

    print(f"  录到 {voice_io.wav_duration(trimmed):.1f} 秒，转写中…")
    try:
        tr = voice_io.get_transcriber("auto")
        text = tr.transcribe(trimmed)
    except RuntimeError as e:
        print(f"\n[转写失败] {e}")
        print(f"（录音还在：{trimmed}，可以自己听一下再打字）")
        return ask_by_typing("")

    print(f"  转写结果：{text}")
    return text



def run(voice: bool, listen_only: bool, limit: int | None):
    qs = core.load_questions()
    if limit:
        qs = qs[:limit]

    audio_map = {}
    if voice or listen_only:
        print("准备语音…")
        audio_map = ensure_question_audio(qs)

    print("=" * 56)
    print(f"语音面试官 · {len(qs)} 题 · {'语音' if voice else '文字'}模式")
    print("=" * 56)

    results = []
    for i, q in enumerate(qs, 1):
        print(f"\n【第 {i}/{len(qs)} 题 · {q['category']}】")
        print(f"问：{q['question']}")

        if audio_map:
            core.play(audio_map[q["id"]])
        if listen_only:
            input("\n（听完按回车继续，/quit 退出）")
            continue

        answer = ask_by_mic(q["ask_seconds"]) if voice else ask_by_typing("")
        if answer == "/quit":
            break
        if answer == "/skip" or not answer:
            print("（跳过）")
            continue

        verdict = core.judge(answer, q)
        asked = ""

        # 规则先判；不过就追问一次，追问完不管好坏都往下走（模拟真实面试节奏）
        if not verdict.passed:
            asked = core.followup_by_model(q, answer, verdict)
            print(f"\n追问：{asked}")
            if audio_map:
                p = core.speak(asked, AUDIO / f"_followup_{q['id']}.mp3")
                core.play(p)
            answer2 = ask_by_mic(q["ask_seconds"]) if voice else ask_by_typing("")
            if answer2 == "/quit":
                break
            verdict2 = core.judge(answer2, q) if answer2 and answer2 != "/skip" else verdict
            print(f"  → 追问后：{'过了' if verdict2.passed else '还是没过：' + '、'.join(verdict2.failed_rules)}")
            record_answer = answer2
        else:
            print("  → 过了")
            record_answer = answer

        rec = {
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "qid": q["id"],
            "category": q["category"],
            "answer": record_answer,
            "passed": verdict.passed,
            "failed_rules": verdict.failed_rules,
            "detail": verdict.detail,
            "followup_asked": asked,
        }
        core.log_session(rec)
        results.append(rec)

    if results:
        print("\n" + "=" * 56)
        ok = sum(1 for r in results if r["passed"])
        print(f"本次 {len(results)} 题，一次过关 {ok} 题，需要追问 {len(results) - ok} 题")
        bad = {}
        for r in results:
            for k in r["failed_rules"]:
                bad[k] = bad.get(k, 0) + 1
        if bad:
            print("问题类型：", "、".join(f"{k}×{v}" for k, v in bad.items()))
        print("已记录到 logs/sessions.jsonl，跑多了可以用 --report 看总体分布")


def report():
    s = core.summarize()
    print(f"累计练习 {s['sessions']} 次")
    if not s["rule_hits"]:
        print("还没有失败记录")
        return
    print("\n【badcase 分布】")
    for k, v in s["rule_hits"].items():
        print(f"  {k:18} {'█' * v} {v}")


def list_devices():
    import voice_io

    devs = voice_io.list_input_devices()
    print("本机可录音设备：")
    if not devs:
        print("  （一个都没有）")
    for d in devs:
        print("  -", d)
    print("\n说明：枚举走 waveIn。WMI 里列出来的 NVIDIA/Nahimic 那些是虚拟驱动，")
    print("不一定能录音，所以不能拿它当设备清单。")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", action="store_true", help="语音模式（需要麦克风）")
    ap.add_argument("--listen-only", action="store_true", help="只念题不判断")
    ap.add_argument("--limit", type=int, default=None, help="只跑前 N 题")
    ap.add_argument("--devices", action="store_true", help="列出可录音设备")
    ap.add_argument("--report", action="store_true", help="看 badcase 统计")
    a = ap.parse_args()

    if a.devices:
        list_devices()
    elif a.report:
        report()
    else:
        run(a.voice, a.listen_only, a.limit)
