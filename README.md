# zzq · AI 产品作品集

通信工程本科在读，2027 届。找 **AI 产品 / AI 产品运营** 实习（北京，每周 5 天，能实习 3 个月以上）。

这大半年自己做了 6 个写进简历的项目（下面按简历顺序排），另有 2 个没写进简历的附加实验。代码大部分是用 AI 编程工具写的，方案和判断是我定的——这点写在最前面，省得你后面猜。

**[在线作品页](https://ab900879.github.io/jd-match-analyzer/)**　·　**[直接上手玩](https://jd-match-analyzer.app.workbuddy.host/)**

---

## 旗舰：简历诊断（从简历优化助手长出来的）

> [**Ab900879/resume-diagnose**](https://github.com/Ab900879/resume-diagnose) · [打开就能用](https://ab900879.github.io/resume-diagnose/)

简历里"简历优化 AI 助手（Coze）"那条的完整形态：先判该不该投（A/B/C 三分类），再给改好的简历。
每句结论必须挂事实编号，挂不上就删——**不是在提示词里求模型别编，是写了校验器把编的句子抓出来**。

完整链路都在那个仓库里：PRD（331 行）、决策日志（6 条含被否掉的方案）、产品手记、9 条 badcase 归因、33 个模型的选型实测、FAQ、封版文档（v0.5，写明哪三个已知缺陷不修以及为什么）。

---

## 6 个项目（与简历一一对应）

| 简历里的项目 | 目录 | 形态 | 现在能看到什么 |
|---|---|---|---|
| 简历优化 AI 助手（Coze） | [projects/05](projects/05-coze-resume-bot/README.md) + 上面的旗舰仓库 | 设计稿 → 已落地 | Coze 调优的边界记录 + 完整产品 |
| 主流 AI 产品对比拆解 | [projects/06](projects/06-competitor-teardown/README.md) | 评测协议 | 30 题任务集 + 盲评协议 + 三家模型实测 |
| AI Agent 工具调用与 FAQ 知识库 | [projects/02](projects/02-faq-agent/README.md) | 网页演示 + 实验 | 20 条测试 + 四组对照归因 |
| 大模型效果评测与 Badcase 归因 | [projects/03](projects/03-eval-badcase/README.md) | 看板 | 三版规则的分数变化数据 |
| PRD 转线框图与提示词迭代 | [projects/04](projects/04-prd2wireframe/README.md) | 命令行 | 一条命令出图 |
| JD 匹配诊断器 | [projects/01](projects/01-jd-matcher/README.md) | 网页产品 | 在线能用，不用装 |

---

### 简历优化 AI 助手（Coze） → `projects/05`

`设计稿 · 已演进为独立产品`

调了五十多轮，摸到一条边界：可以换个说法，但不许升级动词、不许加没做过的经历。原始对话有个人信息，没往仓库放。这条边界后来长成了上面的旗舰产品——"动词不许升级"在那里变成了一个真的会拦下句子的校验器。

### 主流 AI 产品对比拆解（豆包 / 通义 / Kimi） → `projects/06`

`评测协议 · 任务集和实测数据都在`

同一套题喂三个产品，90 次手工测试，结论是"什么任务用哪个"，不是"谁最强"。

后来发现原始评测有个方法论漏洞：**明评**——我知道每份答案来自哪个产品，打分时品牌偏差会盖过真实差距。所以把评测本身升级了：[30 题任务集](projects/06-competitor-teardown/tasks.json)开源、[盲评协议](projects/06-competitor-teardown/protocol.md)（打乱 → 匿名 → 评分模型与被测不同厂商 → 二评算信度）、硬约束（字数/必含数字）交给代码判。并用三家不同厂商的模型端到端跑通了这套协议——被测 kimi / glm / deepseek，评分 minimax（第四家），数据在 [lab](projects/06-competitor-teardown/lab/)。

### AI Agent 工具调用与 FAQ 知识库 → `projects/02`

`网页演示 · 能自己跑测试 · 附四组对照实验`

客服机器人最怕瞎编政策，所以给了它三条规矩：先查资料、查不到转人工、不许猜。20 条测试第一轮过 17 条，查出两个是我自己判定程序的 bug，改完过 19 条。

后来把它拉进实验室做了[四组对照](projects/02-faq-agent/report.md)：裸调 40% → 加提示词还是 40% → 只加知识库 60% → 完整版 90%。两个反直觉发现：**加了三条铁律的提示词，正确率一点没涨**（它只是从"敢答但答错"变成"不敢答、全转人工"）；**照抄关键词问检索命中 88%，换成用户真实说法只剩 35%**——原来那个 95% 是开卷考试考出来的。

### 大模型效果评测与 Badcase 归因 → `projects/03`

`看板 · 数据是真的`

让模型给自己打分等于自己判卷子，所以我用四条规则算分。规则改了三版，同一批回答分数从 83.5 到 92.5 再到 98.8——变的不是模型，是我的尺子。其中两处扣分是我规则写错了。

### PRD 转线框图与提示词迭代 → `projects/04`

`命令行工具`

需求改一句就得重画原型太烦，所以把草图变成文档的输出：写好的文档跑一条命令出图。200 行，零依赖，14 种元素。

### JD 匹配诊断器 → `projects/01`

`网页产品 · 现在就能用`

我自己投实习时说不清简历哪里不对，就做了这个：把岗位要求和简历一起读，逐条标"有依据 / 没依据 / 看不出来"，说"有依据"必须抄出简历原话，抄不出来算它编。编造率压到 1%，12 条样本上合格率从 0 到 67%。样本小是我的短板。

---

## 附加实验（没写进简历，凑数不凑数自己看）

| # | 项目 | 一句话 |
|---|---|---|
| 07 | [语音面试官](projects/07-voice-interviewer/README.md) | 念题、听答、判断够不够、不够就追问；判断用规则不用模型，因为练面试需要可预测 |
| 08 | [外呼质检器](projects/08-outbound-qa/README.md) | 红线用规则、流程用时间戳、只有异议意图才给模型；5 通样例平均 34 分，3 通踩红线 |

---

## 几句实话

> **代码不是我一行行敲的。** 我干的是定方案、定标准、判断结果对不对，以及出问题时能查出是哪一环坏了。后者比会写代码难。

> **02 和 06 这两个项目，我把"原来的成绩"亲手拆过一次。** 02 原来报 95%，实测发现是开卷考试；06 原来是明评，有品牌偏差。拆完都写进了报告——我知道这两个数字虚在哪，比报一个好看的数字踏实。

> **05 是设计稿，点开看到的不是能跑的东西。** 但它长成了上面那个旗舰仓库，链路是通的。

> **没有真实用户。** 只有我和一个同学用过，这是最该补的一块。

> **有个地方我故意没修。** 03 里还有一条规则不准，修了分数更好看，但那是在拿 20 条样本凑分。

---

<details>
<summary><b>想跑一遍的话（点开）</b></summary>

需要 Node 18+ 或 Python 3，模型调用走公开的云端接口：

```bash
cd projects/01-jd-matcher && python -m http.server  # JD 匹配，本地起个服务就行
cd projects/02-faq-agent && node run-test.mjs       # 20 条 Agent 测试
cd projects/02-faq-agent && node lab/compare.mjs all # 四组对照实验（104 次调用）
cd projects/03-eval-badcase && node compare.mjs     # 重算三版规则得分
cd projects/04-prd2wireframe && node prd2wire.mjs examples/prd-jd-matcher.md out.html
cd projects/06-competitor-teardown && node lab/run.mjs all  # 盲评协议全流程（90 次调用）
cd projects/07-voice-interviewer && python main.py  # 语音面试练习（文字模式也能跑）
cd projects/08-outbound-qa && python main.py --all --no-llm # 外呼质检，不调模型也能跑
```

每个项目目录里都有原始测试数据，JSON 格式，没做过美化。

</details>

MIT License
