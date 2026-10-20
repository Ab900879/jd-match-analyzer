"""报告生成：给质检员看的一页纸

设计上只有一个目标：**让人能直接拿着这份报告去跟坐席对话。**
所以每一处扣分都必须带三样东西：扣了多少、扣的哪一条、原文是哪句。
只写"沟通质量待提升"的报告，坐席没法改，主管也没法用。

另外这页会明确标出哪些结论是估算的（打断、独白、配比），
因为估算的结论不能拿去处分人，只能拿去提醒人。
"""
from __future__ import annotations

import html
import json
from pathlib import Path

STATUS_MARK = {"pass": "✓", "fail": "✗", "na": "—", "warn": "!"}
STATUS_CLASS = {"pass": "ok", "fail": "bad", "na": "na", "warn": "warn"}

CSS = """
:root{--ink:#1a1d21;--mid:#6b7280;--light:#9aa3af;--line:#e6e8ec;--bg:#f7f8fa;
--accent:#2563eb;--ok:#0f9d58;--bad:#d93025;--warn:#e8a33d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px 60px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:16px}
h1{font-size:21px;margin:0 0 4px}
h2{font-size:16px;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.sub{color:var(--mid);font-size:13.5px}
.scorebar{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
.score{font-size:44px;font-weight:700;line-height:1;letter-spacing:-1px}
.score small{font-size:15px;color:var(--light);font-weight:400}
.verdict{font-size:15px;font-weight:600;padding:4px 12px;border-radius:20px;background:#eff5ff;color:var(--accent)}
.verdict.veto{background:#fdecea;color:var(--bad)}
.sec{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}
.sec div{background:var(--bg);border-radius:8px;padding:8px 14px;font-size:13.5px;color:var(--mid)}
.sec b{display:block;color:var(--ink);font-size:17px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mid);font-weight:500;font-size:13px;background:#fafbfc}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.q{color:#3f4650;background:#fafbfc;border-left:2px solid var(--line);
padding:2px 8px;margin-top:4px;display:inline-block;font-size:13.5px}
.hit{background:#fdecea;border:1px solid #f5c6c2;border-radius:10px;padding:14px 16px;margin-bottom:10px}
.hit.negt{background:#fff8e8;border-color:#f3d9a4}
.hit .tag{font-size:12px;font-weight:600;color:var(--bad);letter-spacing:.3px}
.hit.negt .tag{color:#a8721a}
.hit .why{font-size:13.5px;color:var(--mid);margin-top:4px}
.badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:10px;
background:#eef1f4;color:var(--mid);margin-left:6px}
.badge.est{background:#fff4e0;color:#a8721a}
.dlg{font-size:14px;line-height:1.9}
.dlg .row{display:flex;gap:10px;padding:3px 0}
.dlg .t{color:var(--light);font-size:12px;min-width:44px;text-align:right;font-variant-numeric:tabular-nums}
.dlg .who{min-width:34px;color:var(--mid);font-size:13px}
.dlg .row.agent .who{color:var(--accent)}
.dlg .row.hit-line{background:#fdecea;border-radius:5px}
.note{font-size:13px;color:var(--mid);background:#fafbfc;border-left:3px solid var(--line);
padding:10px 14px;border-radius:0 6px 6px 0}
.veto-box{background:#fdecea;border:1px solid #f5c6c2;border-radius:10px;padding:14px 16px;margin-bottom:14px}
.veto-box b{color:var(--bad)}
.empty{color:var(--light);font-size:14px;padding:6px 0}
footer{color:var(--light);font-size:12.5px;text-align:center;margin-top:26px}
"""


def _e(s) -> str:
    return html.escape(str(s or ""))


def render_call(bundle: dict) -> str:
    """bundle: {transcript, redline, compliance, tagging, score}"""
    tr = bundle["transcript"]
    rl = bundle["redline"]
    cp = bundle["compliance"]
    tg = bundle["tagging"]
    sc = bundle["score"]
    turns = tr.get("turns", [])

    # 哪些轮次踩了红线（对话全文里要高亮）
    hit_turns = {h.turn_index for h in rl.confirmed_hits}

    parts: list[str] = []
    parts.append(f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>质检报告 · {_e(tr.get('call_id'))}</title><style>{CSS}</style></head><body><div class="wrap">""")

    # ---- 头部 ----
    veto_cls = " veto" if sc.vetoed else ""
    parts.append(f"""<div class="card">
<h1>{_e(tr.get('call_id'))} · {_e(tr.get('campaign'))}</h1>
<div class="sub">{_e(tr.get('started_at'))} ｜ 时长 {tr.get('duration_sec', 0)} 秒 ｜ 坐席 {_e(tr.get('agent_id'))} ｜ 外呼</div>
<div class="scorebar" style="margin-top:16px">
  <div class="score">{sc.total:.0f}<small> / {sc.full_mark}</small></div>
  <div class="verdict{veto_cls}">{_e(sc.verdict)}</div>
</div>
<div class="sec">""")
    for k, v in sc.sections.items():
        parts.append(f"<div><b>{v:.0f}</b>{_e(k)}</div>")
    parts.append("</div></div>")

    # ---- 一票否决 ----
    if sc.vetoed:
        items = "".join(
            f'<div style="margin-top:6px">{_e(d["reason"])}<div class="q">{_e(d["quote"])}</div></div>'
            for d in sc.deductions if d["section"] == "红线")
        parts.append(f"""<div class="card"><h2>红线违规（一票否决）</h2>
<div class="veto-box"><b>本通判定为违规，必须转人工复核。</b>
<div class="sub" style="margin-top:6px">红线项不做分数折中：漏放一次，代价是处罚和诉讼；误拦一次，代价只是人工看一眼。</div>
{items}</div></div>""")

    # ---- 红线明细 ----
    parts.append('<div class="card"><h2>红线检测明细</h2>')
    if not rl.hits:
        parts.append('<div class="empty">没有命中任何红线词。</div>')
    else:
        for h in rl.confirmed_hits:
            times = f'<span class="badge">同句 {h.count} 次</span>' if h.count > 1 else ""
            parts.append(f"""<div class="hit"><span class="tag">违规</span>
{badge(h.category)}<span class="badge">{h.t:.1f}s</span>{times}
<div style="margin-top:6px">命中「<b>{_e(h.matched)}</b>」</div>
<div class="q">{_e(h.context)}</div>
<div class="why">{_e(h.why)}</div></div>""")
        for h in rl.suspected_hits:
            parts.append(f"""<div class="hit negt"><span class="tag">疑似（否定语境）</span>
{badge(h.category)}<span class="badge">{h.t:.1f}s</span>
<div style="margin-top:6px">命中「<b>{_e(h.matched)}</b>」，但前面有否定词，意思可能相反</div>
<div class="q">{_e(h.context)}</div>
<div class="why">这类不直接判违规，转人工确认。规则读得懂字，读不懂语气。</div></div>""")
    if rl.skipped_customer_mentions:
        parts.append(f'<div class="note">客户自己提到相关词 {rl.skipped_customer_mentions} 次，'
                     f'未计入违规——红线只扫坐席说的话，客户问"你们保本吗"不是违规。</div>')
    parts.append("</div>")

    # ---- 扣分明细 ----
    parts.append('<div class="card"><h2>扣分明细</h2>')
    if not sc.deductions or (len(sc.deductions) == 1 and sc.deductions[0]["section"] == "红线"):
        parts.append('<div class="empty">本通没有扣分项。</div>')
    else:
        rows = "".join(
            f'<tr><td class="num">-{d["weight"]:g}</td><td>{_e(d["section"])}</td>'
            f'<td>{_e(d["item"])}<div class="sub">{_e(d["reason"])}</div>'
            + (f'<div class="q">{_e(d["quote"])}</div>' if d.get("quote") else "")
            + "</td></tr>"
            for d in sc.deductions if d["section"] != "红线")
        parts.append(f"<table><tr><th style='width:60px'>扣分</th><th style='width:90px'>板块</th>"
                     f"<th>项目与依据</th></tr>{rows}</table>")
    parts.append("</div>")

    # ---- 检查清单 ----
    parts.append('<div class="card"><h2>合规与沟通检查</h2><table>'
                 "<tr><th style='width:38px'></th><th style='width:180px'>项目</th>"
                 "<th style='width:70px'>权重</th><th>结果</th></tr>")
    for c in cp.checks:
        cls = STATUS_CLASS.get(c.status, "na")
        color = {"ok": "var(--ok)", "bad": "var(--bad)", "na": "var(--light)", "warn": "var(--warn)"}[cls]
        est = '<span class="badge est">估算</span>' if c.estimated else ""
        ev = "".join(f'<div class="q">{_e(e["text"])}</div>' for e in c.evidence[:2])
        w = c.weight if c.weight else "参考"
        parts.append(f"<tr><td style='color:{color};font-weight:700'>{STATUS_MARK.get(c.status, '')}</td>"
                     f"<td>{_e(c.name)}{est}</td><td class='num'>{w}</td>"
                     f"<td>{_e(c.detail)}{ev}</td></tr>")
    parts.append("</table>")
    parts.append(f'<div class="note" style="margin-top:12px">坐席说话 {cp.talk_ratio:.0%}'
                 f'（坐席 {cp.agent_chars} 字 / 客户 {cp.customer_chars} 字）。'
                 f'这个数字只作参考，不参与打分——外呼场景坐席本来话就多，'
                 f'拿它扣分会把好电话也判差。</div>')
    parts.append("</div>")

    # ---- 语义打标 ----
    parts.append('<div class="card"><h2>语义打标</h2>')
    if not tg.available:
        parts.append(f'<div class="note">语义打标未运行：{_e(tg.error)}<br>'
                     f'本通只按前 75 分计算，业务完成度未参与评分。</div>')
    else:
        d = tg.data
        parts.append(f"""<table>
<tr><th style="width:120px">客户意图</th><td>{_e(d.get('customer_intent'))}
{f'<div class="q">{_e(d.get("intent_evidence"))}</div>' if d.get('intent_evidence') else '<div class="sub">（没有找到原话支撑，此项不计分）</div>'}</td></tr>
<tr><th>客户情绪</th><td>{_e(d.get('customer_sentiment'))}
{f'<div class="q">{_e(d.get("sentiment_evidence"))}</div>' if d.get('sentiment_evidence') else ''}</td></tr>
<tr><th>下一步</th><td>{_e(d.get('next_step'))}
{f'<div class="q">{_e(d.get("next_step_evidence"))}</div>' if d.get('next_step_evidence') else ''}</td></tr>
</table>""")
        obs = d.get("objections") or []
        if obs:
            parts.append("<h2 style='margin-top:18px;font-size:14px;border:none;padding:0'>客户异议与坐席处理</h2>"
                         "<table><tr><th style='width:90px'>类型</th><th>客户原话</th>"
                         "<th style='width:90px'>处理</th><th>坐席原话</th></tr>")
            for o in obs:
                parts.append(f"<tr><td>{_e(o.get('type'))}</td>"
                             f"<td><div class='q' style='margin:0'>{_e(o.get('quote'))}</div></td>"
                             f"<td>{_e(o.get('handled'))}</td>"
                             f"<td><div class='q' style='margin:0'>{_e(o.get('handle_quote')) or '—'}</div></td></tr>")
            parts.append("</table>")
        else:
            parts.append('<div class="empty">客户全程没有提出明确异议。</div>')
        if d.get("summary"):
            parts.append(f'<div class="note" style="margin-top:12px">{_e(d["summary"])}</div>')
        if tg.fabricated_dropped:
            parts.append(f'<div class="note" style="margin-top:10px;border-left-color:var(--warn)">'
                         f'模型给出 {tg.fabricated_dropped} 条引用在原文里查不到，已丢弃。'
                         f'这个数字越大，说明模型越不可靠。</div>')
    parts.append("</div>")

    # ---- 对话全文 ----
    parts.append('<div class="card"><h2>对话全文</h2><div class="dlg">')
    for i, t in enumerate(turns):
        who = "坐席" if t.get("role") == "agent" else "客户"
        cls = "row agent" if t.get("role") == "agent" else "row"
        if i in hit_turns:
            cls += " hit-line"
        parts.append(f'<div class="{cls}"><div class="t">{t.get("t", 0):.1f}s</div>'
                     f'<div class="who">{who}</div><div>{_e(t.get("text"))}</div></div>')
    parts.append("</div></div>")

    parts.append("""<footer>由外呼质检器生成 · 红线段为确定性规则，打标段由模型产出并已做原文校验</footer>
</div></body></html>""")
    return "".join(parts)


def badge(text: str) -> str:
    return f'<span class="badge">{_e(text)}</span>'


def render_index(bundles: list[dict]) -> str:
    """多通电话的汇总页。按分数排序，一眼看出哪几通要处理。"""
    rows = []
    for b in sorted(bundles, key=lambda x: x["score"].total):
        tr, sc, rl, tg = b["transcript"], b["score"], b["redline"], b["tagging"]
        veto = '<span class="verdict veto">违规</span>' if sc.vetoed else ""
        link = f'<a href="{_e(tr.get("call_id"))}.html">{_e(tr.get("call_id"))}</a>'
        red = "、".join(sorted({h.category for h in rl.confirmed_hits})) or "—"
        intent = tg.data.get("customer_intent", "—") if tg.available else "（未打标）"
        rows.append(
            f'<tr><td class="num">{sc.total:.0f}</td><td>{link}</td>'
            f'<td>{_e(tr.get("campaign"))}</td><td>{_e(tr.get("agent_id"))}</td>'
            f'<td>{veto} {_e(sc.verdict)}</td><td>{_e(red)}</td><td>{_e(intent)}</td></tr>')

    n = len(bundles)
    n_veto = sum(1 for b in bundles if b["score"].vetoed)
    avg = sum(b["score"].total for b in bundles) / n if n else 0
    avg_norm = sum(b["score"].total / b["score"].full_mark * 100 for b in bundles) / n if n else 0

    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>质检汇总</title><style>{CSS}</style></head><body><div class="wrap">
<div class="card">
<h1>外呼质检汇总</h1>
<div class="sub">共 {n} 通 · 平均 {avg_norm:.0f} 分（归一化） · 红线违规 {n_veto} 通</div>
<div class="sec">
  <div><b>{n}</b>抽检通数</div>
  <div><b>{n_veto}</b>需人工复核</div>
  <div><b>{avg_norm:.0f}</b>平均得分</div>
</div></div>
<div class="card"><h2>明细（按分数从低到高）</h2>
<table><tr><th style="width:52px">分数</th><th style="width:150px">通话</th>
<th>活动</th><th style="width:60px">坐席</th><th style="width:120px">判定</th>
<th>红线</th><th style="width:90px">客户意图</th></tr>
{"".join(rows)}</table>
<div class="note" style="margin-top:14px">红线违规的通话分数显示为 0，这是设计如此：
合规项不是扣分项，是一票否决。若要看这些电话在流程和沟通上得多少分，点进单通报告看分板块得分。</div>
</div></div></body></html>"""


if __name__ == "__main__":
    print("这个模块由 main.py 调用。单跑请看：python main.py --all")
