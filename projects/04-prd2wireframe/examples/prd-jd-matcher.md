# JD 匹配诊断器 · 结果页原型

> 这是项目 01 结果页的 PRD 片段，用来演示 prd2wire：改 PRD 就能重生成线框图，不用重画。

## page 诊断页
### section 输入区
- navbar: logo=JD, title=JD 匹配诊断器, right=登录以保存记录
- tabs: items=匹配诊断/投递排序/Prompt 实验室/评测报告
- textarea: label=岗位 JD, rows=5, placeholder=把招聘要求原文粘进来，建议整段复制
- textarea: label=你的简历, rows=5, placeholder=把简历正文粘进来，信息越具体诊断越准
- button: text=开始诊断, style=primary

### section 结果区
- card: title=综合分 67 / 100, text=技能 35 分制得分 24｜经历 30 分制得分 18, note=分数是证据覆盖度，不是对人的评价
- table: cols=要求/状态/证据, rows=5
- list: items=命中：会用 SQL 做多表查询/缺失：没有 AB 实验经历/存疑：竞品分析只写过一次
- tags: items=技能 35/经历 30/业务 20/信号 15
- divider: x=1

### section 行动区
- card: title=简历改写建议, text=把「参与数据分析」改成「用 SQL 独立完成 3 张表的漏斗分析，定位到注册环节流失 12%」
- list: items=第 1 天：补一条可量化经历/第 2-3 天：做一个 AB 实验案例/第 4 天：把结论写成一页纸
- button: text=导出 Markdown 报告
- button: text=查看历史记录
- note: text=所有建议必须带具体工具名或交付物，否则不计为合格建议

## page 投递排序
### section 批量输入
- textarea: label=一次最多 5 条 JD（用 --- 分隔）, rows=6, placeholder=第一条 JD…… --- 第二条 JD……
- button: text=粗筛排序, style=primary
### section 排序结果
- table: cols=排名/岗位/快速匹配度/建议, rows=5
- note: text=先用一次轻量调用粗筛，只对 Top 2 跑完整诊断，控制成本
- footer: text=prd2wire demo
