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
import re
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
#
# 这一层最容易被做错的地方，是把它当成"找关键词"。
# 找关键词只能判到字面上，人一换说法就失效；真实回答的表达方式无穷多。
#
# 所以规则分成两族，职责不同：
#
#   "有没有说够"  —— 用**结构**判，不看词表。具体的东西在中文里只有三种长相：
#                     数字、专有名词、动作+对象。沾上任意一种就是具体的。
#
#   "有没有说到点" —— 才用关键词，而且必须分组、必须带同义说法。
#
# 把"具体性"也做成词表，是我在这上面栽得最惨的一次：
# 词表写"日志"，就说不出"log"；写"改成"，就说不出"加了个队列"。
# 尺度一旦变成一张列表，它就只能判到列表覆盖的那一小块。


# --- 具体性锚点 ---

# 数字：阿拉伯数字、中文数词，以及"几十/上百"这类模糊量。
#
# 中文数词这里踩过两个坑：
#   坑一：第一版写 `[一二三…]{1,4}(?=量词)`，"三千多条"里每个字都被单独抓成一个数
#         （一、千、一），于是任何含"一"的句子都算有数字。
#   坑二：修完之后，"第一次""一开始"又成了数字——"第一次"是序数，估不了量级。
# 现在要求数词后面紧跟量词**或**再跟一个数词，整段一起匹配；
# "第"字开头的序数整段排除；"多/余/成"这类后缀要连上。
_NUM_RE = re.compile(
    r"第[一二三四五六七八九十\d]+(?:次|个|版|步|轮|天)"                # 序数：整段吞掉，后面排除
    r"|\d[\d.,]*\s*(?:%|％|万|千|百|多|余)?"                          # 30 / 3% / 4000 / 2万
    r"|[一二三四五六七八九十百千万零两几上数]{1,4}(?:多|余|成)?"
    r"(?=[条份次个遍人天秒分块元年月周篇页行字题通话页张]|$)"           # 三千多/八成/一百
    r"|[半一二三四五六七八九十\d]\s*(?:个)?\s*(?:小时|钟头|分钟|礼拜|星期|月|年)"  # 半小时/三分钟
    r"|百分之[一二三四五六七八九十百零两几\d]+"
    r"|[一两二三四五六七八九十]成"                                    # 两成 / 八成
    r"|[一二三四五六七八九十半]{1,3}(?:分之[一二三四五六七八九十\d]+)"  # 三分之一 / 一半
    r"|一半|大半|小半"
)
_ORDINAL_RE = re.compile(r"^第")


def _has_number(text: str) -> bool:
    """有没有一个能估量级的数字。

    排除三类假数字：序数（第一次）、单独的"几"（多试了几次）、"一/两"（一个人）。
    这几类在中文里天天出现，认了它们等于没判。
    """
    for m in _NUM_RE.finditer(text):
        s = m.group(0).strip()
        if _ORDINAL_RE.match(s):
            continue
        if s in {"一", "两", "几", "上", "数", "几成"}:
            continue
        # "一个很小的东西""一批录音""几条记录"——数词 + 通用量词 + 泛指名词，
        # 是口语里最常见的虚指，估不出量级。
        # 但"一个队列""一个阈值"要认：那是真的加了一个具体的东西。
        mm = re.match(r"^[一二两几]{1,2}\s*(?:个|条|批|些)\s*(.*)$", s)
        if mm and (not mm.group(1) or mm.group(1)[0] in _VAGUE_TAILS):
            continue
        return True
    return False


# 虚指搭配：数词 + 量词 + 这类词开头，说明是"泛指有这么个东西"，不是量级。
_VAGUE_TAILS = "很大小多少些长早久快慢好坏差远近年月天里点下"

# 专有名词：英文技术 token（Next.js、Vercel、SQL、GPT-4）。
#
# 为什么要认英文 token：一个做技术的人在讲细节时，名字几乎都是英文的。
# 漏掉这类词，等于专门漏掉最具体的那些回答。
#
# 但也有坑：第一版把 AI / API / app 也算进去了，结果"因为 AI 比较火，我觉得前景好"
# 这句话凭一个 AI 就过了。所以这里维护一个**软词表**，它们不算专有名词——
# 人人都能说出口的词，证明不了任何事。只有长度 > 3 的英文 token 才算硬证据。
_SOFT_EN = {
    "ai", "app", "api", "bug", "id", "ui", "ux", "pc", "ok", "okay", "chat",
    "llm", "nlp", "cv", "gpt", "web", "svr", "db",
}
# 三字母以下但**信息量高**的技术缩写：它们本身就是硬证据。
# ASR / OCR / TTS / SLA / ETL 这种词，会说的人一定在这行里干过，
# 不能因为短就跟 ai/app 一起扔进软词表。
# 真实踩到："里面 ASR 和标点恢复这两块都是我自己调的" 被判成品名都没有。
_HARD_ABBR = {"asr", "ocr", "tts", "sla", "etl", "rag", "sql", "gpu", "cpu", "kpi",
              "cdp", "crm", "erp", "sdk", "rtc", "sip", "vad", "wer", "bleu"}
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.\-]{1,24}")


def _has_proper_noun(text: str) -> bool:
    for m in _TOKEN_RE.finditer(text):
        tok = m.group(0)
        low = tok.lower()
        if low in _HARD_ABBR:
            return True
        if low in _SOFT_EN:
            continue
        # 纯小写的常见英文词也可能是软词，但长度够长、带点号/数字的一律算硬证据
        if len(tok) <= 3 and not any(c in tok for c in ".0123456789"):
            continue
        return True
    return False


# 动作 + 对象：中文里"干活"的典型句式。
#
# 这一版的设计原则跟上一版不一样：**动词和对象分开判，都要真**。
#
# 上一版用一条 `(动词)(可选后缀)(0~6 字)(对象后缀)` 的正则，结果两头都漏水：
#   松的一头："给坐席做个实时提示" 命中 "给坐席做个"——"做…个"就算具体了
#   紧的一头："把人的判断变成可检查的规则" 里"变成"的"成"被当成动词，
#             后面接到了"查的规则"，凭空造出一个不存在的动作
# 一条正则同时管"什么算动词"和"什么算对象"，就一定会在这两端之间来回滑动。
#
# 所以拆开：
#   1. 动词表只收**改造类**动词。做/搞/弄/说/有 一个都不收——
#      这些词自己证明不了任何事，"我搞了个小工具"和"我搞了个大新闻"长得一样。
#   2. 对象表只收**信息量高的名词**（日志/队列/阈值/录音/文字…），
#      不收"个"，因为"做个X"是提想法，"拆成X和Y"才是做过。
#   3. 要求两者在 8 个字以内共现，且中间不能有句读断开。
_ACTION_VERBS = [
    "拆", "换", "改", "加", "补", "删", "减", "压", "抄", "跑", "测", "查", "记",
    "标", "算", "迁", "接", "封", "切", "拉", "调", "定", "搬", "裁", "剪", "录",
    "转", "编译", "部署", "上线", "回滚", "复现", "对比", "替换", "合并", "拆分",
    "对齐", "量化", "剥离", "统一", "整理", "分段", "标注", "改名", "重写", "封成",
    "包一层", "限流", "排队", "缓存",
    # 下面这批是补的：真实回答里"操作"远不止改造类动词。
    # "在拨号前过滤掉投诉号码""用扩散模型生成图""搭了个向量库"——
    # 这些都不是"改/换"，但都指向一个真做过的动作。
    "过滤", "筛掉", "剔掉", "生成", "搭", "建", "接上", "接通", "抓", "爬", "清洗",
    "去重", "合并", "拆分", "切分", "打标", "过一遍", "扫", "重训", "训练", "推理",
    "导出", "导入", "同步", "备份", "监控", "告警", "限速", "降级", "熔断",
    # 注意：不收"建""做""搞"这类万能动词。
    # "需要建立一个完善的指标体系"——"建"在动词表里、"个"在兜底正则里，
    # 两句一拼就成"具体动作+具体对象"，可是这句话一个可复述的信息都没有。
    # 万能动词永远凑得出宾语，所以它们只能出现在**具体名词**后面，不能走句式兜底。
    # 再补一批：诊断与描述的动词。人讲"哪里不对"时用得最多的是这些，而不是"改"。
    # "服务被拖垮了""日志里写了不允许输出""挑几个刁钻的问""客户挂了电话没跟进"——
    # 每一句都在陈述事实，但都具体到可以复述。
    "设", "撑", "拖垮", "崩", "掉线", "超时", "堵", "卡", "漏", "挂", "夹",
    "挑", "看", "写", "记", "跟前", "跟进", "追问", "推一条", "发一条", "弹",
    # "我负责提示词和评测这两块"——面试讲分工，最标准的说法就是"负责X"。
    # 这里"负责"后面跟的常常是名词短语而不是改造动作，但它对"这块是不是你干的"
    # 是决定性信息，漏掉它等于把所有讲分工的答案都判成空话。
    "负责", "管", "承接", "承接了",
    # 用户侧的动作：真实项目里一半的"改"是从"去问人"开始的。
    #   "后来去问了几个坐席才知道按钮放得太深了"
    #   "挪到第一屏之后使用率上来了"
    # 这些不是技术改造，但它们是**真的做了什么**，比"我优化了体验"实得多。
    "问", "挪", "移", "放", "摆", "换位", "调位",
    # "清缓存""重启""切/断/分"——排查现场的固定说法。
    #   "后来发现是我本地缓存没清，重启之后就好了"
    # 这句一个"改"字都没有，但它是标准的修复陈述。
    "清", "重启", "重开", "断开", "分", "断",
]
# 有实际信息量的名词。注意这里也放进了"指标""口径"这类东西——
# 一个人说"用什么指标衡量"和说"要做得更好"，虽然都没有数字，但前者可在事后检查。
#
# 这里踩的坑是"只用自己想到的词"：写"文档"没想到"图"，写"数据"没想到"号码"，
# 写"日志"没想到"记录"。于是"把投诉过的号码过滤掉"这种标准回答被判成空话。
# 补的办法不是一个个加，而是按**类别**列：文本类、结构类、产物类、媒体类。
_OBJECT_NOUNS = [
    # 文本 / 数据
    "日志", "报错", "记录", "文档", "文字", "文本", "句子", "段落", "标题", "标签",
    "数据", "表", "字段", "参数", "配置", "索引", "名单", "号码", "清单", "词表",
    # 结构 / 系统
    "队列", "缓存", "阈值", "接口", "函数", "脚本", "文件", "规则", "条件", "标准",
    "流程", "步骤", "版本", "模块", "服务", "功能", "页面", "程序", "代码", "结构",
    "依赖", "端口", "证书", "权限", "账号", "库", "数据库", "索引", "集群",
    # 产物 / 交付物
    "小结", "报表", "看板", "报告", "提示词", "模板", "评分", "话术", "方案", "总结",
    # 媒体
    "录音", "音频", "视频", "字幕", "图", "图片", "向量",
    # 度量
    "率", "口径", "判据", "指标", "衡量", "考核", "复盘",
    # 退一步的兜底：只要动作落在了一个"东西"上（中文里的"的X""一条X""几个X"），
    # 就算指到了具体对象。这一条是必须有的，否则每来一个新领域就要补一次名词：
    #   "我有一次缓存没设过期" / "加了个告警" / "推一条待办给销售" /
    #   "挑几个刁钻的问" / "看它是不是在瞎编"
    # 这些对象五花八门，但句式是一样的：动词 + 量词/助词 + 名词。
    # 用句式兜底，比穷举名词稳。
    "待办", "告警", "任务", "工单", "通知", "消息",
    # 语音/文本处理这一层的具体名词。做 ASR/质检的人天天说这些，
    # 漏掉它们等于专门漏掉最懂业务的那批回答。
    "分句", "断句", "分词", "标点", "切分", "缓存", "句号", "空格", "编码",
    "逗号", "顿号", "换行", "字段名", "关键字", "关键词", "字数", "长度",
]
_CLAUSE_BREAK = "，。！？；,.!?;"
_BETWEEN_MAX = 8          # 动词和宾语之间最多隔几个字

# 动词被"包在名词里"的情况：这些字跟在动词前面时，动词不成立。
#   "对好的**定**义不太一样" —— "定"是"定义"的一部分
#   "有一**个统一**的标准"   —— "统一"在这里是形容词，不是动作
# 判据很土但有效：如果动词前面那一个字能和它拼成一个常用双字词，就跳过。
_VERB_IN_NOUN_PREV = {
    "定": "决定确指规约鉴设假判限",
    "标": "目标指标商坐路滑",
    "查": "检调审",
    "记": "笔传日游铭",
    "调": "协强空",
    "改": "修",
    "接": "连直间迎衔",
    "换": "交替转",
}


def _verb_is_inside_noun(text: str, i: int, v: str) -> bool:
    if i == 0 or len(v) != 1:
        return False
    prev = text[i - 1]
    return prev in _VERB_IN_NOUN_PREV.get(v, "")


# 结果补语：动词后面紧跟这些字，表示"这个动作做完了"，算动作的一部分，不算距离。
_COMPLEMENT_RE = re.compile(r"(?:掉|成|进|上|完|走|开|出来|下来|过来|起来|一遍|一遍遍)")

# 容器词：这些词一出现，说明前面那个名词只是容器，不是落点。
# "指标体系""评估框架""多个维度""整个流程"——都是说"要有个东西"，
# 而不是"我做了那个东西"。判具体性时必须把它们排除，否则套话永远过。
_CONTAINER_RE = re.compile(r"(?:体系|框架|维度|层面|矩阵|机制|闭环|生态|能力|建设|思路|方法论)")

# "调了调""改了改""试试看"这类动词重叠式：语法上是动作，实质是敷衍。
# 判具体性时要先把它从文本里剔掉，否则"我就调了调提示词"会因为"调"+"提示词"而被当成具体。
#
# 这里有个隐蔽的坑：最初写成 `[改编调换取补压试弄搞看查对][了过]?[同组]`，
# 结果"调参数"被吃成"调参"（调 + 参 不在同组，但"调"后面跟了任意一个字），
# 一个正常的动作就被当成敷衍删掉了。所以只认**同一个字重叠**（调了调/改改/试试）
# 和几个固定双字词（看看/试试/弄弄），不认跨字组合。
_HEDGE_VERB_RE = re.compile(
    r"(?:调了调|改了改|换了换|试了试|压了压|补了补|弄了弄|搞了搞|看了看|查了查|对了对"
    r"|试试|看看|弄弄|搞搞|调调|改改|换换)"
)


def _strip_hedges(text: str) -> str:
    return _HEDGE_VERB_RE.sub("　", text)


# 预测/设想的标记。出现了这些，说明句子在讲"如果要做"，不是"我做过"。
# 这种句子里出现的动词不能算"做过改造"的证据——
# "给坐席做个实时提示，说到哪句话就在屏幕上标红"里确实有"标"，
# 但那是在设计一个还不存在的东西，不是踩过坑。
_FUTURE_MARKERS = ["会", "可以", "要做", "做个", "打算", "建议", "如果", "可以改成",
                   "应该", "提一个", "我会", "能", "需要", "改成什么"]


def _has_action_object(text: str) -> bool:
    """动词 + 宾语共现，且中间没被句读打断。

    "把提示词拆成两条" → 拆…两条 ✓
    "我搞了个小工具"   → 搞不在动词表里，✗
    "觉得这件事特别有意思" → 没有改造类动词，✗
    """
    vpos = [(i, v) for v in _ACTION_VERBS for i in _all_idx(text, v)]
    if not vpos:
        return False
    for i, v in vpos:
        # 动词被包在名词里（"定义"的"定"、"统一的标准"的"统一"）——不算动作。
        if _verb_is_inside_noun(text, i, v):
            continue
        if v in ("统一", "分开", "合并") and re.search(rf"{v}的", text):
            # "统一的标准""合并的方案"：这里是形容词，不是在动手
            continue
        # 否定后缀：动作后面紧跟"不了/不过/不通过/不动/不进去"，说明这件动作**没成**，
        # 不能拿来当"我做过什么"的证据。
        #   "测的时候一直**通不过**" - 这是失败，不是动作
        if re.match(r"(?:不|没)[\u4e00-\u9fa5]{1,2}", text[i + len(v):]):
            continue
        after = i + len(v)
        # 动词后面常跟一个结果补语，它属于**动作本身**，不该占动词和宾语之间的距离：
        #   "把投诉过的号码过滤掉" —— "掉"占了一格，正好把 8 字的窗口挤满
        # 同理还有 成/进/上/成片/完/掉，都是"这个动作做完了"的意思。
        m = _COMPLEMENT_RE.match(text, after)
        if m:
            after = m.end()
        window = text[after: after + _BETWEEN_MAX + 6]
        # 中间出现句读就断开：跨句的组合不算一个动作
        cut = len(window)
        for k, ch in enumerate(window):
            if ch in _CLAUSE_BREAK:
                cut = k
                break
        seg = window[:min(cut, _BETWEEN_MAX + 6)]
        # 名词后面紧跟"体系/框架/维度/层面"这类容器词时，说明说的是个空壳：
        #   "指标"在名词表里，"建立一个完善的指标体系"因此命中——
        #   但"指标体系""评估框架""多个维度"恰恰是最典型的套话，
        #   它说的是"要有个东西"，不是"我做了个东西"。
        # 所以动词窗口里只要出现容器词，这一段就不算证据。
        container = bool(_CONTAINER_RE.search(seg))
        if not container and any(n in seg for n in _OBJECT_NOUNS):
            return True
        # 句式兜底：动词后紧跟"了/个/条/条把/几个"再接两个字以上的东西，
        # 就算指到了具体对象。这条兜底是必需的——每来一个新领域都要补一次名词，
        # 而句式在中文里是稳定的：加了个告警 / 推一条待办 / 挑几个刁钻的问。
        m2 = _OBJECT_SHAPE_RE.search(v + seg)
        if m2 and not container and not _is_vague_phrase(m2.group(0)):
            return True
        # 反向窗口：宾语在动词前面 ----
        # 中文最标准的"处置式"是 把/将 + 宾语 + 动词："把投诉过的号码过滤掉"。
        # 上面只看动词右边的窗口，这类句子一条都过不了——
        # 而它恰恰是最具体、最有"我动过手"味道的句式，漏掉它等于专挑好答案杀。
        # 判据收紧一点：前面必须有"把/将/对/给/按"，且在同一个分句里。
        # "按"是后来加的："我试过**按**逗号**切**，不行"——这是最朴素的实验叙述。
        before = text[max(0, i - _BETWEEN_MAX - 8): i]
        cut2 = 0
        for k in range(len(before) - 1, -1, -1):
            if before[k] in _CLAUSE_BREAK:
                cut2 = k + 1
                break
        seg2 = before[cut2:]
        if re.search(r"(?:把|将|对|给|按|用|照)", seg2) and any(n in seg2 for n in _OBJECT_NOUNS):
            return True
    # ---- "对象 + 没/忘 + 动作"：中文里最简洁的故障陈述 ----
    #   "本地缓存没清" / "超时没设" / "日志没留" / "索引忘了建"
    # 这种句式没有"把"没有"改"，但一句就说清了哪里没做好，
    # 恰恰是面试里最有用的那种回答。之前一直漏，因为它跟"动作+对象"是反的。
    for n in _OBJECT_NOUNS:
        for m in _all_idx(text, n):
            tail = text[m + len(n): m + len(n) + 4]
            if re.match(r"(?:没|忘了|忘了去|没有|未)", tail) or re.match(r"(?:也|都|一直)?(?:没|未)", tail):
                return True
    return False


# 动词 + (了/掉/成) + (个/一条/几个/两句) + 至少两个字的东西
_OBJECT_SHAPE_RE = re.compile(
    r"(?:了|掉|成|进|上)?(?:个|条|条把|件|次|句|段|批|份|层|遍|套|张|页|轮)"
    r"[\u4e00-\u9fa5A-Za-z]{2,}"
)

# 泛指词：句式兜底最大的漏洞就在这 ——
#   "做过**一个**语音识别的**课设**"       ← 课设是泛称，不是具体对象
#   "对**这个**行业产生了**兴趣**"          ← 行业+兴趣，一个可复述的信息都没有
#   "做了**一个**很大**的**东西"
# 这些句子结构上跟"加了个告警"一模一样，但信息量为零。
# 补名词表治不好（泛称词是开放集合），只能从**尾巴**判：
# 量词后面那两个字如果落在泛称集合里，就不算具体。
_VAGUE_NOUNS = {
    "东西", "事情", "项目", "系统", "课设", "作业", "工作", "功能", "业务", "产品",
    "方案", "想法", "问题", "办法", "方向", "领域", "行业", "兴趣", "热情", "能力",
    "经验", "机会", "平台", "技术", "工具", "软件", "程序", "模型", "算法", "结果",
    "效果", "提升", "优化", "改进", "变化", "发展", "成长", "过程", "方面", "部分",
    "内容", "情况", "状态", "水平", "质量", "价值", "意义", "作用", "影响",
}


def _is_vague_phrase(s: str) -> bool:
    """句式兜底命中的那段，是不是"量词 + 泛称词"。

    "加了个告警"          → 告警不在泛称表里 → 算具体
    "做过一个课设"        → 课设是泛称       → 不算具体
    "建立一个完善的指标体系" → 中心词是"体系"，修饰语越长越虚 → 不算具体

    第三条是这批新踩到的：前面加了"完善的"这种形容词，尾巴看着不像泛称，
    但整个短语的信息量跟"一个体系"没区别。所以看**中心词**（最后两个字），
    而不是开头——中文里定语都在前面。
    """
    tail = re.sub(r"^(?:了|掉|成|进|上)?(?:个|条|条把|件|次|句|段|批|份|层|遍|套|张|页|轮)", "", s)
    tail = tail.strip("的")
    if not tail:
        return True
    for w in _VAGUE_NOUNS:
        if tail.startswith(w):
            return True
        # 中心词落在泛称上：定语再长也是空的
        if len(tail) >= 2 and tail.endswith(w):
            return True
    # "很大的东西""一堆杂活"：以形容词性开头也当泛称
    if tail[0] in "很大小多少好差高低新旧长短快慢轻重":
        return True
    return False


def _all_idx(text: str, sub: str):
    start = 0
    while True:
        i = text.find(sub, start)
        if i < 0:
            return
        yield i
        start = i + 1

# 因果/取舍结构：说明在解释"为什么"，而不是罗列。
#
# "因为"单独不算——"因为 AI 比较火"也是因为，那只是给个理由，不是解释。
# 必须成对出现（因为…所以 / 因为…后来 / 所以 / 结果 / 代价是），
# 才算讲清了一条机制。
#
# 另外要认"发现式"的因果：中文口语里讲排查，很少说"因为所以"，
# 更常说"我一查是分词切错了""我一看是端口错了""才发现是超时"。
#   "用户说搜不到，我一查是分词切错了，换成分词器就好了"
# 这句里没有"因为"没有"所以"，但"一查是…"就是定位，"换成就好了"就是修复。
# 只认"因为/所以"的规则，会把最标准的排查叙述判成空话。
_DISCOVERY_RE = re.compile(
    r"(?:一查|一测|一看|一跑|一对比|测了|试了|查了|看了|发现|定位到|才明白|才看出)"
    r"[^，。！？,.!?]{0,12}?(?:是|在|因为|由于)"
)
# 先假设、后推翻，是中文里讲排查最标准的一种叙述，而且它**天生跨逗号**：
#   "我一开始以为模型不收敛是学习率的问题，试了几次都不对，后来发现是标签错位了"
#
# 上一版只认"一查/发现 + 是/因为"这种同句结构，这句被判成"没有具体东西"——
# 错在窗口 `{0,12}?` 跨不过逗号，而人讲排查是一句一个阶段。
# 所以这条规则不看窗口，看**三件事齐不齐**：
#     假设词（以为/觉得/怀疑/猜） → 否定证据（不对/没用/不是/排除了） → 结论（后来发现/才定位/其实是）
# 三件齐了，说明这人真的走过一遍弯路，而不是在罗列。
_HYPOTHESIS_RE = re.compile(r"(?:以为|原以为是|一开始以为|还以为是|觉得是|怀疑是|猜是|判断是|估摸着是)")
_REFUTE_RE = re.compile(
    r"(?:试了|测了|跑了|查了|改了|调了|换了|加了)?(?:几次|半天|好久|一阵|很多|不少)?"
    r"(?:都|也|还是|仍然|依然|依旧|照样)?"
    r"(?:不对|没用|没解决|不解决|不是|排除了|不成立|行不通|没效果|还是错|还是不行|没变化"
    r"|一样|不变|照样|如故|没好|没管用)"
    r"|(?:结果|但|可|然而)[^，。！？,.!?]{0,6}(?:不是|没用|不对)"
)
_CONCLUDE_RE = re.compile(
    r"(?:后来|最后|再后来|然后|才|一查|一测|才发现|最终)"
    r"[^，。！？,.!?]{0,10}?(?:发现|看出|定位|查明|确认|找到|明白|知道)"
    r"|(?:后来|最后|再后来|才发现|原来是|才知道|其实是)[^，。！？,.!?]{0,8}?(?:是|在)"
)
# 修好必须有**明确的改造动作**，不能用"后来就"这种时间词充数。
# 反例（真实踩到的）："我就调了调提示词，多试了几次，后来就好了"——
# 这句只有"后来"，没有任何改造动作，凭"后来就…好"放行等于失守。
_FIX_RE = re.compile(
    r"(?:换成|改成|加了|加进|去掉|删了|删掉|重跑|重写|调大|调小|包一层|拆开|重试|"
    r"补上|补了|拆成|缓存|限流|排队|换了|改成|分开|合并)"
    r"[^，。！？,.!?]{0,10}?(?:就|才|之后|以后)[^，。！？,.!?]{0,4}?(?:好|正常|解决|过|行|通)"
)


_CONCLUSION_WORDS = ["最难", "关键", "问题在", "卡在", "瓶颈", "根因", "原因", "关键在于",
                     "真正的", "其实是", "发现", "才明白", "才懂", "靠的是", "不在于"]


def _has_causal(text: str) -> bool:
    # 注意："后来就"这类词**不能算因果**。它是时间词，不是机制。
    # "我就调了调提示词，多试了几次，后来就好了"——只有一个"后来"，
    # 没有任何解释；把它认成因果，等于给所有含糊回答发通行证。
    if any(m in text for m in ["所以", "结果", "导致", "代价是", "否则", "不然",
                               "换来的是", "最后改成", "于是", "之所以"]):
        return True
    if "因为" in text and any(m in text for m in ["所以", "后来", "于是", "才"]):
        return True
    # 判断句："最难的不是模型而是数据"——"不是A而是B"是中文里最标准的判断结构。
    # 它没有"因为"没有"所以"，但它说的是"我找到了关键在哪"。
    if re.search(r"(?:不是|不在)[^，。！？,.!?]{1,10}?(?:而是|是|在于)", text):
        return True
    if any(w in text for w in _CONCLUSION_WORDS) and \
            re.search(r"(?:最难|关键|问题|瓶颈|根因)[^，。！？,.!?]{0,6}?(?:是|在|在于)", text):
        return True
    # 发现式排查：定位 + 修好了
    if _DISCOVERY_RE.search(text) and _FIX_RE.search(text):
        return True
    # 先假设后推翻：以为 X → 试了不对 → 后来发现是 Y。
    # 这条不需要 _FIX_RE：人讲清楚了"我怎么排掉的错误猜想"，
    # 已经比"我改好了"更能证明真踩过。修复留给下一句，这条不押。
    if _HYPOTHESIS_RE.search(text) and _REFUTE_RE.search(text) and _CONCLUDE_RE.search(text):
        return True
    return False


# 接续结构：把两件事用"先…再…""分两步"串起来。
#   "我加了意图识别在前面，先分类再答"
# 这种回答说明了动作的**顺序和目的**，比单个动词具体。
_SEQUENCE_RE = re.compile(
    r"(?:先|首先)[^。！？.!?]{1,22}?(?:再|然后|接着)"
    r"|(?:分|拆成)(?:两|三)\s*(?:步|层|块|段)"
)


# 类比 / 迁移结构：把自己的判断跟另一件事挂上钩。
#   "调参那套思路跟调模型挺像，都是找变量、看反馈"
#   "做信号处理跟做评测是一回事，都是定标准"
#
# 为什么单独认：讲动机、讲自我认知的题，最有说服力的回答往往是一个类比——
# 它证明的是"我理解这两件事的共同结构"，而这种回答天生没有数字和动作。
# 只看数字和动词的尺子，会把这类回答全判成空话，恰好把最好的答案杀掉了。
_ANALOGY_RE = re.compile(
    r"(?:跟|和|与|比)[^，。！？,.!?]{1,12}(?:挺像|很像|一样|一个道理|一回事|同理|相通)"
    r"|都是[^，。！？,.!?]{2,12}"
    r"|(?:这套|那套)[^，。！？,.!?]{0,6}(?:思路|方法|习惯)"
    # "说白了就是X""本质上跟X一回事" —— 中文里讲清一个类比的另一种说法
    r"|(?:说白了|本质上是|归根到底|说穿了)[^，。！？,.!?]{0,4}(?:就是|是|跟|和)"
)
# 注意：类比必须**把两件事挂在一起**，不是"出现两个名词"。
# 真实踩到：'to B 和 to C 的标准完全不一样' —— "和"+"不一样"齐了，
# 但它只是在分类，没有任何"这两件事结构相通"的意思。
# 所以上面只认"像/一样/一回事/同理/相通"这类真正表达相似的词，
# 不认"和…不一样/和…不同"这种表达差异的。
_ANALOGY_NEG_RE = re.compile(r"(?:跟|和|与|比)[^，。！？,.!?]{0,10}?(?:不一样|不同|差别|区别|差得远)")


def _has_analogy(text: str) -> bool:
    for m in _ANALOGY_RE.finditer(text):
        s = m.group(0)
        # "…不一样"里包含"一样"，但它说的是差异，正好是类比的反面。
        # 这类误判只能靠看上下文，不能靠改词表。
        if "不一样" in s or "不同" in s or _ANALOGY_NEG_RE.search(s):
            continue
        return True
    return False


# 具体对象：引号书名号里的东西
_QUOTE_RE = re.compile(r"[「『“\"《]([^」』”\"》]{1,20})[」』”\"》]")

# 行业硬术语：这类词出现，说明谈的是具体业务而不是空话。
#
# 这里的坑是**软术语**："坐席"这个词在外呼行业里人人会说，
# 一句"给坐席做个实时提示"照样可以通过。所以分成两组：
#   软术语 soft —— 只说明"在这个行业里"，不说明"想到了具体东西"
#   硬术语 hard —— 带做法、带指标、带取舍的词，套话里不会出现
# 软术语只在 opinion 题里算半个锚点，且必须与别的锚点同时出现才算。
_DOMAIN_TERMS_HARD = [
    "实时质检", "事后抽检", "抽检", "接通率", "ASR", "转写", "标注", "召回",
    "准确率", "误杀", "badcase", "bad case", "提示词", "阈值", "拒答", "幻觉",
    "埋点", "灰度", "压测", "并发", "超时", "上下文", "向量", "检索", "微调",
    "蒸馏", "话术", "质检", "出处", "引用", "编造", "上限", "下限",
]
_DOMAIN_TERMS_SOFT = ["坐席", "话务", "外呼", "工单", "客户", "录音", "接听"]

# 可复查性词：一个答案如果给出了"怎么验"的接口（算比例、看比例、低于多少就不上线、
# 写不出出处就当错），它就是可执行的标准，哪怕它没说出"标准"这两个字。
# 这一条是为 judgement 类题准备的——问"你怎么判断好坏"，
# 好答案往往是一个判据句，而不是"我的标准是……"。
_CHECKABILITY = [
    "比例", "占比", "通过率", "答对", "对得上", "对不上", "算一下", "算出来",
    "低于", "高于", "超过", "少于", "一律", "全部", "每一个", "逐条", "每条",
    "写不出", "说不清", "标一遍", "人工看", "抽样", "抽查", "对一遍",
    # "凡是…就算…" 是中文里最典型的判据句式，比"标准"两个字更可靠
    "凡是", "只要", "就算", "都算", "算过", "算失败", "算错", "判失败", "判错",
    # 责任判据：把"这句话错了谁扛"当成标准，比任何指标都硬。
    #   "这句话如果错了，谁承担后果。承担得起就当它对，承担不起就必须有人复核"
    "承担", "扛", "后果", "担责", "复核", "会签", "签字", "谁负责", "谁来定",
    "必须有人", "必须复核", "必须确认",
]


def _has_domain_term(text: str) -> bool:
    low = text.lower()
    return any(t.lower() in low for t in _DOMAIN_TERMS_HARD)


def _has_soft_domain(text: str) -> bool:
    low = text.lower()
    return any(t in low for t in _DOMAIN_TERMS_SOFT)


def _has_checkability(text: str) -> bool:
    """有没有说出"怎么验"。这是 judgment 类题的真正门槛。"""
    return any(w in text for w in _CHECKABILITY)


def _has_quote(text: str) -> bool:
    return bool(_QUOTE_RE.search(text))


# 套话词：这些词本身不能证明任何事，它们的出现往往正说明在讲概念。
# 判具体性时先把它们从文本里抹掉，免得"提升用户体验"里的"提升"被当成动作。
_HOLLOW_PHRASES = [
    "提升用户体验", "形成闭环", "打通", "数据孤岛", "赋能", "抓手", "生态",
    "智能化", "数字化转型", "以用户为中心", "更智能", "更高效",
    "什么都能干", "挺多的", "还行吧", "都挺", "比较火", "前景好",
    # 讲"我是怎么面对困难"的空话：听着像方法，实际上是态度。
    #   "遇到困难我一般会先自己想办法，实在不行再问同事"
    # 这句话把"问同事"当成了动作，可是没说是哪件事、问了什么。
    "先自己想办法", "自己先想办法", "先自己查", "自己查一下",
    "都挺愿意帮忙", "都挺愿意", "同事都很", "团队氛围",
    "静下心", "慢慢都能解决", "办法总比困难多", "肯钻研", "肯吃苦",
]

# 只讲趋势、不讲事实：谈动机和行业前景时最常见的空话模板。
#   "因为 AI 是未来的方向，我很看好这个行业"
#   "通信和 AI 有很多结合点，这是很有前景的方向"
# 这些句子里"看好/结合点/方向"能凑出动作+对象，但那不是一件事，是一个态度。
# 判据：出现趋势词，且**没有任何一处**落到具体的东西上（数字/专名/改造动作/术语）。
_TREND_RE = re.compile(
    r"(?:未来的方向|很有前景|前景(?:很|挺|比较)?(?:好|广阔|不错)|很大的空间|空间很大"
    r"|是趋势|大趋势|浪潮|风口|蓝海|朝阳|大势所趋|结合点|相辅相成"
    r"|一定会|必然会|迟早|早晚|未来肯定)"
)


@dataclass
class Verdict:
    qid: str
    passed: bool
    failed_rules: list[str] = field(default_factory=list)
    detail: dict = field(default_factory=dict)
    # 命中的具体性锚点，给追问用：追问要问"缺的那一类"，而不是笼统说"再具体点"
    anchors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# 题目类型决定"具体"的门槛：问方案和问动机，要求不一样。
#   project   —— 讲做过的事，必须有可复述的细节
#   judgement —— 讲判断标准，标准本身就是名词，门槛低一点
#   opinion   —— 提改进、讲动机，认行业术语和取舍结构
#   open      —— 反问，只要问题问得具体（问到岗位细节）就够
def _kind(q: dict) -> str:
    return q.get("kind", "project")


def kind_is_opinion_and_motivation(q: dict) -> bool:
    """讲动机的题（"你为什么想做 AI 产品"）。

    这类题的判准跟提议题不一样：提议看"改成什么"，动机看"有没有一件真事撑住"。
    用 category 判，避免以后加题时又要改代码。
    """
    return _kind(q) == "opinion" and "动机" in (q.get("category") or "")


# 经历标记：说"这是发生在我身上的事"，而不是"我认为"。
# 动机题没有这个就是空谈；有了它，哪怕没说出"AI"三个字，也是在讲自己的路。
_EXPERIENCE_RE = re.compile(
    r"(?:实习的时候|实习那会|实习期间|上课的时候|课上|毕设|课设|比赛|大创"
    r"|之前做过|以前做过|曾经|那阵子|有一次|那次|当时"
    r"|帮(?:业务方|客户|公司|团队|老板)"
    r"|做过|干过|写过一个|搭过)"
)


def rule_too_short(text: str, q: dict) -> tuple[bool, str]:
    """太短：一句话没说完就停了。

    门槛按题类型分：反问那题 20 字就够，讲项目那题 20 字肯定不够。
    用一套字数标准卡所有题，是最省事也最蠢的做法。
    """
    n = len(text.strip())
    floor = q.get("min_chars", 30)
    if n < floor:
        return False, f"只说了 {n} 个字，这题至少要 {floor} 字，明显没展开"
    return True, ""


def rule_no_concrete(text: str, q: dict) -> tuple[bool, str]:
    """太笼统：说了半天没有一个能复述的抓手。

    判的是**三类锚点里有没有命中至少一个**，不是某类词有没有出现：

        1. 数字      —— "二十多份""压到百分之三""30 条"
        2. 专有名词  —— "Next.js""Vercel""DeepSeek""prompt"
        3. 动作+对象 —— "加了个队列""把提示词拆成两条""拉下来看日志"

    另外两类辅助锚点，只在对应题型里算数：
        4. 因果/取舍结构（因为…所以 / 代价是…）—— opinion 题必认
        5. 行业硬术语（实时质检、接通率、badcase）—— opinion 题必认

    为什么单选题的容忍度更高：问"你会提什么改进"这种题，
    答"我会提实时质检，不要等事后抽检"已经是合格答案，它没有数字也没有动词，
    但它指出了一个别人没提的东西。对这种题要求"加了个队列"就等于强人所难。

    误判的代价不对称：把一句合格的话判成空话，人会以为自己的表达有问题，
    越练越不敢说；把一句空话放过一次，下次追问一句就补上了。
    """
    kind = _kind(q)

    # 先抹掉套话短语，避免"提升"这类词被当成动作、"闭环"这类词被当成术语
    cleaned = text
    for p in _HOLLOW_PHRASES:
        cleaned = cleaned.replace(p, "　")

    # ---- 反问题单独判 ----
    # "你还有什么想问我的"——这题答的是**一个问题**，不是一段经历。
    # 拿"有没有数字/动作"去卡它没道理：好的反问本来就是"你们用什么指标衡量"。
    # 所以改判两件事：它是不是在提问，以及问的是不是岗位/业务而不是待遇。
    if kind == "open":
        # 先拦放弃式回答。"暂时没有什么问题""我这边都了解了"——
        # 这里也有"什么"两个字，会被下面那条"在不在提问"骗过去，
        # 但它恰恰是这题最典型的零分答案：一个字都没问。
        if any(w in text for w in ["没有什么问题", "没什么问题", "没有问题", "暂时没有",
                                   "都了解了", "已经了解", "没什么想问", "没有想问",
                                   "没有问题要问", "暂时没问题"]):
            return False, "这等于放弃了提问机会。反问不是扣分项，问一个具体的就比不问强"
        if not ("?" in text or "？" in text or any(w in text for w in
                 ["请问", "想问", "想了解", "能不能", "会不会", "什么"])):
            return False, "这不是一个提问，等于放弃了提问机会"
        # 只有"我想问一下"这种空提问，问完没有内容
        if len(text.strip("。，？?！! ")) <= 12 and \
                any(w in text for w in ["我想问", "想问一下", "问一下", "请问一下"]):
            return False, "只说了要问，但没把问题问出来"
        # 问的是待遇而不是岗位/业务，是面试里经典的失分点
        if any(w in text for w in ["工资", "薪资", "薪水", "多少钱", "待遇", "加班",
                                   "双休", "公积金", "几点上班", "几点下班", "年假",
                                   "涨薪", "五险一金", "福利", "食堂", "班车", "住宿",
                                   "宿舍", "调休", "报销", "补贴", "试用期多久",
                                   # 这几类不是待遇，是**不该对面试官说的**：
                                   # 问公司会不会裁员、稳不稳，等于当面质疑对方的饭碗；
                                   # 问"你觉得我能过吗"是把判断权又推回去。
                                   "裁员", "倒闭", "会不会裁", "公司稳不稳", "能活多久",
                                   "能不能过", "我表现怎么样", "你觉得我怎么样",
                                   "能不能进", "有希望吗"]):
            return False, "问的是待遇或作息，这类问题留到 HR 环节再问，终面问会显得只关心条件"
        return True, ""

    # ---- 防"报菜名"：把名字列了一串，一个都没讲进去 ----
    # 判据：并列项 >= 2，用了空动词（做过/搞了/碰过），且没有任何实锚点。
    parallel = cleaned.count("还有") + cleaned.count("比如") + cleaned.count("、")
    hollow = sum(cleaned.count(v) for v in ["做过", "搞了", "弄了", "碰过", "写了个", "做过很多"])
    if parallel >= 2 and hollow >= 1 and not _has_number(cleaned) \
            and not _has_action_object(cleaned) and not _has_proper_noun(cleaned):
        return False, "列了好几个项目但没讲其中任何一个的细节，像在报菜名"

    # ---- 只讲趋势，不讲事实 ----
    # 这条要放在锚点判定**之前**：趋势句太容易凑出一个"动词+名词"，
    # 一旦进去就出不来。所以先问一句"有没有真东西撑着"，没有就直接判空。
    # 只拦"趋势 + 完全没有实锚点"的组合，讲趋势但配了具体事的照样放过：
    #   "AI 是趋势，所以我去年做了两个小工具试水" —— 有事实，该过。
    if (_TREND_RE.search(cleaned)
            and not _has_number(cleaned)
            and not _has_proper_noun(cleaned)
            and not _has_domain_term(cleaned)
            and not re.search(r"(?:做过|写了|搭了|试过|弄了|参加|实习|毕设|课设|比赛)", cleaned)):
        return False, "说的是趋势和态度，没说一件自己做过的事"

    anchors = []
    if _has_number(cleaned):
        anchors.append("number")
    if _has_proper_noun(cleaned):
        anchors.append("proper_noun")
    if _has_action_object(_strip_hedges(cleaned)):
        anchors.append("action_object")
    if _has_quote(cleaned):
        anchors.append("quote")
    # 因果结构对所有题型都有效。一开始我只在 opinion/judgement 里认它，
    # 结果一句标准的排查叙述被判成空话：
    #   "用户说搜不到，我一查是分词切错了，换成分词器就好了"
    # 讲清了"现象→定位→修好"，这是最具体的一种回答方式，没理由只让提议题享受。
    if _has_causal(cleaned):
        anchors.append("causal")
    if _SEQUENCE_RE.search(cleaned):
        anchors.append("sequence")

    if kind in ("opinion", "judgement"):
        # 提议里的动词不算"做过"的证据，但提议本身要判。见下面 op_ 系列。
        if _has_domain_term(cleaned):
            anchors.append("domain_term")
        # 讲动机的题，一个说清了的类比就是最好的答案（见 _ANALOGY_RE 的注释）
        if _has_analogy(cleaned):
            anchors.append("analogy")

    # ---- 动机题的第三条通道：自我认知 ----
    #   "我不太擅长社交，但写东西和查问题还行。AI 产品这块正好是我能做且愿意做的"
    # 它没有一件事、没有一个数字、也没有类比，但它说了"我这人是什么形状 + 这活吻合"。
    # 面试里这比"我热爱 AI"可信得多——因为它在承认短板。
    #
    # 这条通道本来只写在 rule_missing_keywords 里，结果这些回答在
    # rule_no_concrete 就被拦掉了，根本走不到词表那一步。规则之间是有顺序的，
    # 通道开在后面的规则里，等于没开。
    if kind_is_opinion_and_motivation(q):
        groups0 = q.get("must_mention") or []
        g0 = groups0[0] if groups0 else []
        g0 = [g0] if isinstance(g0, str) else g0
        if any(w in cleaned for w in g0) \
                and any(w in cleaned for w in ("我其实", "我这人", "我这个人", "我比较",
                                               "我不太", "我不擅长", "我不太擅长",
                                               "我并不是", "我不是那种")) \
                and any(w in cleaned for w in ("正好", "适合", "更擅长", "愿意做", "能做",
                                               "对得上", "合我")):
            anchors.append("self_awareness")

    # ---- judgement 类（"你怎么判断好坏"）的额外通道 ----
    # 问判断标准的题，好答案长得跟项目题完全不同：它是一句判据，不是一段经历。
    #   "拿一批固定问题跑，算答对的比例，低于八成就不上线"
    #   "会不会把出处写出来，写不出来的一律当成错的"
    # 这两句都没有"标准"两个字，但都给了"怎么验"。
    # 所以这里认的是**可复查性**（算比例 / 低于X / 一律 / 逐条），
    # 不是某个名词。
    if kind == "judgement" and _has_checkability(cleaned):
        anchors.append("checkability")

    if anchors:
        return True, ""

    # ---- 提方案类（opinion）还有一条路：说清了"改成什么" ----
    # "给坐席做个实时提示，说到哪句话就在屏幕上标红"——没有数字、没有硬术语、
    # 也不在讲因果，但它确实指出了要动哪个环节（实时提示 + 屏幕标红），
    # 比"用 AI 提升体验"实在得多。
    # 判据：具体动作（改造类动词 + 后果名词），或者"改在哪/什么情况/怎么判"这类结构。
    if kind == "opinion":
        if _has_action_object(_strip_hedges(cleaned)):
            return True, ""
        # 提议句式："做成 X""改成 X""做个 X""提一个 X"——X 带来了一个新东西（挂机短信/实时提示），
        # 而不是一个形容词（更智能）。判 X 是不是名词性短语，就看它有没有落脚在名词上。
        #
        # 这里踩过两个小坑：
        #   1. 一开始只写"做一个/做个"，"我想做挂机短信"（不带量词）漏了 —— 中文量词经常省略
        #   2. 中间一段（"通话结束后的自动"）有 8 个字，而这里的间隔只给了 6 个 —— 又漏了
        # 所以：动词要带量词（做/上个 太弱，会跟"做过"混），间隔放宽到 12 个字。
        if re.search(r"(?:做成|改成|换成|做个|做一个|加个|加一个|提一个|上一个|接入|上一条|加一条)"
                     r"[^，。！？,.!?]{0,12}"
                     r"(?:短信|提示|弹窗|看板|报表|队列|接口|模块|功能|标签|评分|"
                     r"话术|提醒|面板|页面|流程|名单|清单|工单|回访|跟进|小结|总结|"
                     r"报告|记录|打分|账单|凭证|回执)", cleaned):
            return True, ""
        # 中文里量词可以全省："我想做挂机短信"。所以"做"后面直接跟名词性短语也要认。
        # 区别"做过"的办法是看它后面有没有"过/了"：做过/做了 是回顾，做X 是提议。
        if re.search(r"做(?!过|了|完)[^，。！？,.!?]{0,8}"
                     r"(?:短信|提示|弹窗|看板|报表|看板|面板|页面|小结|总结|报告|"
                     r"打分|评分|提醒|标签|话术)", cleaned):
            return True, ""
        if any(w in cleaned for w in ["标红", "提示", "拦住", "拦下来", "弹窗", "排到", "推到"]) \
                and any(w in cleaned for w in ["哪句", "哪一句", "什么时候", "一旦", "如果",
                                               "就直接", "屏幕上", "当场", "实时"]):
            return True, ""
        # 还有一条：说了"在哪一步做什么"，并且那个动作落在了一个具体动作上。
        #   "在拨号前先过滤掉投诉过的号码" —— 时点（拨号前）+ 动作（过滤号码）
        # 这类回答的重点不在"改成什么功能"，而在"流程的哪一环插什么"，
        # 对提改进的题来说是合格答案。
        if any(w in cleaned for w in ["之前", "以前", "之后", "以后", "时候", "环节", "这一步"]) \
                and _has_action_object(_strip_hedges(cleaned)):
            return True, ""

    # 没命中任何锚点，给出对症的追问方向
    if kind == "opinion":
        return False, "说的是方向，没说出具体改哪一步、拿什么衡量"
    if kind == "judgement":
        return False, "没说出一个能拿去检查的标准"
    return False, "没听到数字、具体的工具或具体的动作，像在讲概念"


def rule_missing_keywords(text: str, q: dict) -> tuple[bool, str]:
    """漏要点：这题要求的两组要点，有一组完全没碰。

    这里踩过两个坑，都记下来：

    坑一（2026-10 第一版）：must_mention 写的是 ["我","做","项目"]，
        结果一句完全正确的回答因为没用"项目"这个词就被判失败。
        —— 只能命中字面的规则不可靠，所以改成**分组**：组内任一命中即可。

    坑二（2026-10 第二版）：为了修坑一把词表扩得很宽，结果放过一句烂答案
        "我就调了调提示词，多试了几次，后来就好了"——"调"在词表里、"试"也在，
        看起来齐全，其实等于什么都没说。
        —— 所以加了敷衍词守卫：命中敷衍词时，要求另外还有实锚点。

    坑三（2026-10 第三版，本次）：把词表当成补丁打，是治不好的。
        "把 log 拉下来看" 这句话一个关键词都没命中，因为词表里没有"看"、没有"log"。
        修法不是再补两个词，而是**先看结构**：只要这句话有真动作+真对象，
        就不该因为"没用面试官想听的词"被判失败。

    坑四（2026-10 第四版）：给结构开的后门开太大了。
        "我在实验室做协议仿真，觉得把人的判断变成可检查的规则很有意思"——
        这句话没有回答"为什么想做 AI 产品"，它只是在说学了什么。
        但上一版只要"动作+原因"就放行，于是一句没答到题的话也过了。
        —— 后门必须带条件：要么讲了因果（在解释为什么），
           要么撞上这道题的行业硬术语（说明确实在谈这个领域）。
           光有一个动词不算。

    —— 这条规则的定位要想清楚：它查的是"有没有答到这道题的意图"，
       不是"有没有说出我准备好的那几个字"。
       所以它的否决权要低于结构规则：结构过了、意思明显在，词不词的不重要。
    """
    groups = q.get("must_mention") or []
    if not groups:
        return True, ""

    # 敷衍词守卫
    #
    # 「试了几次」既可能是打太极（"我就试了几次，后来就好了"），
    # 也可能是排查过程本身（"试了几次都不对，后来发现是标签错位了"）。
    # 区别不在词上，在**后面有没有结论**。所以判守卫之前先问一句：
    # 这句话有没有讲清"错在哪/查到了什么"？讲清了就不该被这个词扣分。
    hedges = ["多试几次", "多试了", "调了调", "改了改", "试了几次", "研究了一下",
              "大概就是这样", "差不多", "反正就是", "慢慢就好了", "摸索", "都解决了"]
    has_hedge = any(h in text for h in hedges)
    has_anchor = (_has_number(text) or _has_action_object(_strip_hedges(text))
                  or _has_proper_noun(text) or _has_domain_term(text))
    explained = (_CONCLUDE_RE.search(text) is not None
                 or (_HYPOTHESIS_RE.search(text) and _REFUTE_RE.search(text)))
    if has_hedge and not has_anchor and not explained:
        return False, f"说了「{next(h for h in hedges if h in text)}」但没给出具体做法"

    missed = []
    for group in groups:
        words = [group] if isinstance(group, str) else group
        if not any(w in text for w in words):
            missed.append("/".join(words))

    if not missed:
        return True, ""

    # 关键修正：词表没命中，但这句话结构上已经是实打实的回答了。
    # 真实例子："把 log 拉下来看，发现是并发太高，加了个队列"——
    # 既没说"问题"也没说"改"，但谁都看得出这是在讲怎么排查、怎么解决。
    # 这种时候判失败，错的是尺子，不是考生。
    #
    # 但后门要有条件（见坑四）：必须是"真动作 + 在讲道理"，
    # 而不是"有个动作就算答到了"。
    # 另外只要回答里出现了数量的证据，就已经在讲具体事情了，
    # 词不词的没必要再卡（"把三千多条删了""从两成降到很低"都是这种）。
    if _has_number(text):
        return True, ""
    # 两组一个都没沾，但讲清了一条完整的排查链（现象 → 定位 → 改法），
    # 也该放过。真实例子（第十二批踩到的）：
    #   "最难的是那个功能一直没人用，后来去问了几个坐席才知道按钮放得太深了，
    #    挪到第一屏之后使用率上来了"
    # "没人用""放得太深""挪到第一屏"——一个要点词都没有，但没人会说这不是答案。
    # 判据：因果/结论结构 + 一个真动作。缺任何一个都不放（防止套话借道）。
    if _has_causal(text) and _has_action_object(_strip_hedges(text)):
        return True, ""
    # 判断题（"你怎么判断好坏"）有自己的一条通道：可复查性。
    #   "谁承担后果。承担得起就当它对，承担不起就必须有人复核"
    # 这句里没有"标准""指标""比例"任何一个词，但它就是一个判据，
    # 而且是比指标更硬的判据（责任落点）。词表没想到这种写法，不是答案的错。
    if _kind(q) == "judgement" and _has_checkability(text):
        return True, ""
    if _has_action_object(_strip_hedges(text)) and (_has_causal(text) or _has_domain_term(text)):
        return True, ""
    if _has_domain_term(text) and (_has_causal(text) or _SEQUENCE_RE.search(text)):
        return True, ""
    # 动机题（q5）单独一条：硬术语 + 一件真事 + 一个指向未来的意向。
    #   "实习的时候做过一个客服质检的小工具，看到它真的能省下人力，就想继续做"
    # 这句里没有 AI 这个词，没有"因为所以"，动词"做"也不在改造类动词表里，
    # 但它把动机**落到了经历上**，比"我对 AI 很感兴趣"实在得多。
    #
    # 判据是"三件事"而不是"动词+对象"：
    #   硬术语（质检/转写/评测…说明真在这行里）
    #   经历标记（实习的时候/做过/帮业务方…说明是自己的事）
    #   意向词（想/希望/就决定…说明这是动机）
    # 词表漏掉这种写法是词的错，不是答案的错。
    if kind_is_opinion_and_motivation(q) and _has_domain_term(text) \
            and _EXPERIENCE_RE.search(text) \
            and any(w in text for w in ("想", "希望", "决定", "就一直", "才转", "所以转")):
        return True, ""
    # 动机题的第二种合格写法：讲清"我这人是什么样 / 这活正好合我的形状"。
    #   "我其实不太擅长社交，但是写东西和查问题还行。AI 产品这块正好是我能做且愿意做的"
    # 它没有一件事、没有一个数字，但它是一种**自我认知**——
    # 面试里比"我热爱 AI"可信得多，因为它在承认短板。
    # 判据：自我描述 + 匹配关系（正好/适合/更擅长/愿意做/能做）。
    # 这里用 must_mention 的第一组判"确实在谈这行"，而不是 _has_domain_term：
    # 硬术语表里没有"AI 产品"这种最基础的说法，而这类句子恰恰只说这个。
    _g0 = groups[0] if groups else []
    _g0 = [_g0] if isinstance(_g0, str) else _g0
    if kind_is_opinion_and_motivation(q) and any(w in text for w in _g0) \
            and any(w in text for w in ("我其实", "我这人", "我这个人", "我比较", "我不太", "我不擅长",
                                        "我不太擅长", "我并不是", "我不是那种")) \
            and any(w in text for w in ("正好", "适合", "更擅长", "愿意做", "能做", "合", "对得上")):
        return True, ""

    # 最后一条也是踩出来的：两组要点"只命中一半"是常态，不是失败。
    #   "有一次缓存没设过期，服务被拖垮了，我加了 TTL" —— 讲了坑，没命中"改"的词表
    #   "我会先看它有没有答到点上，再挑几个刁钻的问" —— 讲了方法，没命中"标准"的词表
    # 真正的空话是**两组都不沾**。只沾一组、又带具体结构，就该放过：
    # 这是练面试，判错一次的代价是让人不敢说，比漏判一次大得多。
    #
    # 注意这里的"具体结构"要求**带因果或接续**，不能只靠一个动作+对象。
    # 因为两组都没命中的时候，"动词+对象"太容易凑出来：
    #   "我在提示词里写了不允许输出英文" —— 写了+提示词，但没讲出这是个什么问题。
    if len(missed) < len(groups) and (
        _has_causal(text)
        or _SEQUENCE_RE.search(text)
        or _has_number(text)
        or (_has_action_object(_strip_hedges(text)) and _has_domain_term(text))
        # 只命中一半 + 有一个真动作，就该放过。
        #   "测的时候一直通不过，后来发现是我本地缓存没清，重启之后就好了"
        # 命中"缓存"一组，"问题"那组没词；但它说了故障、说了修复，是标准答案。
        # 这里把"真动作"也算作结构——理由：动作+对象是三类锚点里最硬的一种，
        # 它比"命中某个关键词"更能说明这人在讲真事。
        or _has_action_object(_strip_hedges(text))
    ):
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

    # 收集命中的锚点，追问时用得上
    cleaned = answer
    for p in _HOLLOW_PHRASES:
        cleaned = cleaned.replace(p, "　")
    anchors = []
    if _has_number(cleaned):
        anchors.append("number")
    if _has_proper_noun(cleaned):
        anchors.append("proper_noun")
    if _has_action_object(cleaned):
        anchors.append("action_object")
    if _has_causal(cleaned):
        anchors.append("causal")

    return Verdict(qid=q["id"], passed=not failed, failed_rules=failed,
                   detail=detail, anchors=anchors)


# ---------- 追问层：规则选方向，模型润色 ----------

# 追问要问"缺的那一类"，不是笼统说"再具体点"。
# 缺数字就问数字，缺动作就问从哪一步开始，什么都缺才问例子。
FOLLOWUP_BY_ANCHOR = {
    "no_number":      "这里面大概是个什么量级？数字说一下。",
    "no_action":      "你最先做的是哪一步？说一个动作就行。",
    "no_object":      "你说的那个东西，具体是什么？名字或方法说一个。",
}

FOLLOWUP_TEMPLATES = {
    "too_short": "说得太短了，展开讲讲。{followup}",
    "no_concrete": "说得有点空，能给我一个具体的例子吗？{followup}",
    "missing_keywords": "{followup}",
}

SYSTEM_FOLLOWUP = """你是一个面试官。用户刚才回答得不够，你需要追问一句。
要求：
1. 口语化，像真人说话，不要书面语
2. 20 到 40 字，只说一个问题
3. 不要安慰，不要评价好坏，直接追问
4. 不要重复用户的原话
5. 只问一个缺口：缺数字就问量级，缺动作就问哪一步，缺对象就问是什么
"""


def followup_by_rule(q: dict, verdict: Verdict) -> str:
    """不用模型也能出追问：按失败的规则 + 缺的锚点选模板。"""
    first = verdict.failed_rules[0] if verdict.failed_rules else "too_short"
    base = q.get("followup", "")

    if first == "no_concrete":
        have = set(verdict.anchors)
        if "number" not in have:
            hint = FOLLOWUP_BY_ANCHOR["no_number"]
        elif "action_object" not in have:
            hint = FOLLOWUP_BY_ANCHOR["no_action"]
        else:
            hint = FOLLOWUP_BY_ANCHOR["no_object"]
        return f"{hint}{base}"

    tpl = FOLLOWUP_TEMPLATES.get(first, "{followup}")
    return tpl.format(followup=base)


def followup_by_model(q: dict, answer: str, verdict: Verdict) -> str:
    """调用模型把追问说得更自然。没配 key 就自动退回规则版。"""
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        return followup_by_rule(q, verdict)
    try:
        from openai import OpenAI
        client = OpenAI(api_key=key, base_url="https://api.deepseek.com")
        reason = "、".join(verdict.failed_rules) or "不够具体"
        missing = [a for a in ("number", "action_object", "proper_noun") if a not in verdict.anchors]
        resp = client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "system", "content": SYSTEM_FOLLOWUP},
                {"role": "user", "content": (
                    f"题目：{q['question']}\n"
                    f"这题想考：{q['focus']}\n"
                    f"考生的回答：{answer}\n"
                    f"判断出的问题：{reason}\n"
                    f"他缺的是：{'、'.join(missing) or '具体例子'}\n"
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
