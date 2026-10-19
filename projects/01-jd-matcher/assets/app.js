/* =========================================================
 * app.js — JD 匹配诊断器
 * ========================================================= */
import { PROMPTS, PROMPT_VERSIONS, SCAN_PROMPT } from './prompts.js';
import { CASES, RESUME_SOFT, JD_PM, JD_OPS } from './evalset.js';
import {
  normalize, extractJson, evaluateOne, evidenceRate, fabricateRate,
} from './judge.js';

/* ---------------- 云服务配置（来自 activate 返回的 publicConfig） ---------------- */
const PUBLIC_CONFIG = {
  endpoint: 'https://jd-match-analyzer.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_wL6Ac81XPO3S0EeHRzcGEJ_x6tGGNVEdiUWn9o7XdO9RkAE6Q7C5j9q',
};

let cloud = null;
try {
  cloud = window.WorkBuddyCloud.createWorkBuddyCloud(PUBLIC_CONFIG);
} catch (e) {
  console.error('cloud init failed', e);
}

/* ---------------- 小工具 ---------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function pct(v) {
  return `${Math.round((v || 0) * 100)}%`;
}

/* ---------------- 视图切换 ---------------- */
$$('nav button').forEach((b) => {
  b.onclick = () => {
    $$('nav button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === `v-${b.dataset.view}`));
  };
});

/* ---------------- 模型 ---------------- */
let MODEL = null;
let MODEL_LIST = [];
const PREFERRED_FAST = ['deepseek-v4-flash', 'glm-5.3-flash', 'hunyuan-2.0-thinking', 'step-5-preview'];

function estimateCredits(m) {
  const c = m.credits;
  if (typeof c !== 'string') return null;
  const n = parseFloat(c.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function loadModels() {
  const sel = $('#modelSelect');
  try {
    MODEL_LIST = (await cloud.llm.models.list()).filter((m) => m.disabled !== true);
    if (!MODEL_LIST.length) {
      sel.innerHTML = '<option>无可用模型</option>';
      return;
    }

    // 默认选一个「够快又能用」的：优先低倍率旗舰 flash 类，其次 auto
    const fast = PREFERRED_FAST.map((id) => MODEL_LIST.find((m) => m.id === id)).find(Boolean);
    MODEL = fast || MODEL_LIST.find((m) => m.id === 'auto') || MODEL_LIST[0];

    // 排序：auto 在前，其余按倍率升序
    const sorted = [...MODEL_LIST].sort((a, b) => {
      if (a.id === 'auto') return -1;
      if (b.id === 'auto') return 1;
      return (estimateCredits(a) ?? 99) - (estimateCredits(b) ?? 99);
    });

    sel.innerHTML = sorted
      .map((m) => {
        const cr = estimateCredits(m);
        const tag = cr === null ? '' : ` · ×${cr}`;
        const rec = m.id === 'auto' ? '（默认，较慢）' : '';
        return `<option value="${esc(m.id)}">${esc(m.name || m.id)}${tag}${rec}</option>`;
      })
      .join('');
    sel.value = MODEL.id;
    sel.onchange = () => {
      const next = MODEL_LIST.find((m) => m.id === sel.value);
      if (next) {
        MODEL = next;
        toast(`已切换到 ${next.name || next.id}`);
      }
    };
  } catch (e) {
    console.error(e);
    sel.innerHTML = '<option>模型加载失败</option>';
  }
}

/* ---------------- 会话 ---------------- */
let SESSION = null;

async function refreshSession() {
  try {
    SESSION = await cloud.auth.getSession();
  } catch (_) {
    SESSION = null;
  }
  renderAuthBar();
}

function renderAuthBar() {
  const el = $('#modelSelect');
  let bar = document.getElementById('authBar');
  if (!bar) {
    bar = document.createElement('span');
    bar.id = 'authBar';
    bar.style.cssText = 'display:flex;gap:8px;align-items:center';
    el.parentNode.appendChild(bar);
  }
  if (SESSION?.user) {
    bar.innerHTML = `<span style="font-size:12.5px">${esc(SESSION.user.name || '已登录')}</span>
      <button class="ghost tiny" id="logoutBtn">退出</button>`;
    $('#logoutBtn').onclick = async () => {
      await cloud.auth.signOut();
      SESSION = null;
      renderAuthBar();
      toast('已退出');
    };
  } else {
    bar.innerHTML = `<button class="ghost tiny" id="loginBtn">登录以保存记录</button>`;
    $('#loginBtn').onclick = () => openAuth();
  }
}

/* ---------------- 登录弹层 ---------------- */
let AUTH_TAB = 'phone';
let PENDING = { phone: null, email: null };

function openAuth() {
  $('#authModal').style.display = 'flex';
}
function closeAuth() {
  $('#authModal').style.display = 'none';
  $('#authMsg').textContent = '';
}
$('#authClose').onclick = closeAuth;
$('#authModal').onclick = (e) => { if (e.target.id === 'authModal') closeAuth(); };

$$('#authTabs .pill').forEach((b) => {
  b.onclick = () => {
    AUTH_TAB = b.dataset.tab;
    $$('#authTabs .pill').forEach((x) => x.classList.toggle('on', x === b));
    $('#tab-phone').style.display = AUTH_TAB === 'phone' ? '' : 'none';
    $('#tab-email').style.display = AUTH_TAB === 'email' ? '' : 'none';
  };
});

$('#phoneInput').oninput = () => { $('#phoneErr').style.display = 'none'; };

async function sendPhoneCode() {
  const phone = $('#phoneInput').value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    $('#phoneErr').style.display = 'block';
    return;
  }
  const btn = $('#sendPhoneCode');
  btn.disabled = true;
  const sent = await cloud.auth.sendOtp({ phone });
  btn.disabled = false;
  if (sent.error) {
    $('#authMsg').textContent = sent.error.message || '发送失败';
    return;
  }
  PENDING.phone = { phone, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
  $('#authMsg').textContent = '验证码已发送';
}
$('#sendPhoneCode').onclick = sendPhoneCode;

async function sendEmailCode() {
  const email = $('#emailInput').value.trim();
  if (!/.+@.+\..+/.test(email)) {
    $('#authMsg').textContent = '请输入正确的邮箱';
    return;
  }
  const btn = $('#sendEmailCode');
  btn.disabled = true;
  const sent = await cloud.auth.sendOtp({ email });
  btn.disabled = false;
  if (sent.error) {
    $('#authMsg').textContent = sent.error.message || '发送失败';
    return;
  }
  PENDING.email = { email, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
  $('#authMsg').textContent = '验证码已发送';
}
$('#sendEmailCode').onclick = sendEmailCode;

$('#authSubmit').onclick = async () => {
  const btn = $('#authSubmit');
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    let r;
    if (AUTH_TAB === 'phone') {
      const phone = $('#phoneInput').value.trim();
      const token = $('#phoneCode').value.trim();
      const p = PENDING.phone;
      if (!p || p.phone !== phone) {
        $('#authMsg').textContent = '请先为当前手机号获取验证码';
        return;
      }
      r = await cloud.auth.verifyOtp({ phone, verificationId: p.verificationId, isExistingUser: p.isExistingUser, token });
    } else {
      const email = $('#emailInput').value.trim();
      const token = $('#emailCode').value.trim();
      const p = PENDING.email;
      if (!p || p.email !== email) {
        $('#authMsg').textContent = '请先为当前邮箱获取验证码';
        return;
      }
      r = await cloud.auth.verifyOtp({ email, verificationId: p.verificationId, isExistingUser: p.isExistingUser, token });
    }
    if (r.error) {
      $('#authMsg').textContent = r.error.message || '验证失败';
      return;
    }
    PENDING = { phone: null, email: null };
    SESSION = await cloud.auth.getSession();
    renderAuthBar();
    closeAuth();
    toast('登录成功');
    loadDiagList();
    loadRuns();
  } catch (e) {
    $('#authMsg').textContent = e?.message || '登录失败';
  } finally {
    btn.disabled = false;
    btn.textContent = '登录 / 注册';
  }
};

$('#wbLogin').onclick = async () => {
  const back = new URL(location.href);
  for (const k of ['code', 'state', 'provider']) back.searchParams.delete(k);
  const { data, error } = await cloud.auth.signInWithOAuth({ provider: 'workbuddy', redirectTo: back.toString() });
  if (error) {
    $('#authMsg').textContent = error.message || '暂时无法使用此方式登录';
    return;
  }
  location.assign(data.url);
};

/* ---------------- 启动时处理 OAuth 回调 ---------------- */
async function restoreOAuth() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return;
  const provider = url.searchParams.get('provider');
  if (provider !== 'workbuddy' && provider !== 'wechat') return;
  const handler = provider === 'workbuddy'
    ? cloud.auth.handleWorkBuddyCallback
    : cloud.auth.handleWechatWebCallback;
  if (typeof handler !== 'function') return;
  const { data: session, error } = await handler.call(cloud.auth);
  if (error) {
    toast(error.message || '登录失败');
    return;
  }
  if (session) {
    for (const k of ['code', 'state', 'provider']) url.searchParams.delete(k);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    toast('登录成功');
  }
}

/* =========================================================
 * 核心调用：跑一次诊断
 * ========================================================= */
async function callLLM({ version, jd, resume }) {
  const p = PROMPTS[version];
  const messages = [
    { role: 'system', content: p.system },
    { role: 'user', content: p.buildUser(jd, resume) },
  ];
  const t0 = performance.now();
  let text = '';
  let usage = null;

  const params = {
    model: MODEL.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: version === 'v1' ? 1 : 0.3,
  };
  if (p.jsonMode) params.response_format = { type: 'json_object' };

  for await (const chunk of cloud.llm.chat.completions.create(params)) {
    const d = chunk.choices?.[0]?.delta;
    if (d?.content) text += d.content;
    if (chunk.usage) usage = chunk.usage;
  }

  return {
    text,
    usage,
    latency: Math.round(performance.now() - t0),
    modelId: MODEL.id,
  };
}

/* =========================================================
 * 诊断页
 * ========================================================= */
let CURRENT_VERSION = 'v3';

function renderPromptPicker() {
  $('#promptPicker').innerHTML = Object.entries(PROMPTS)
    .map(
      ([k, p]) => `<button class="pill ${k === CURRENT_VERSION ? 'on' : ''}" data-v="${k}">
        <b>${esc(p.label)}</b><span>${esc(p.tagline)}</span></button>`
    )
    .join('');
  $$('#promptPicker .pill').forEach((b) => {
    b.onclick = () => {
      CURRENT_VERSION = b.dataset.v;
      renderPromptPicker();
    };
  });
}

$('#fillJd').onclick = () => { $('#jd').value = JD_PM; };
$('#fillResume').onclick = () => { $('#resume').value = RESUME_SOFT; };

$('#runBtn').onclick = async () => {
  const jd = $('#jd').value.trim();
  const resume = $('#resume').value.trim();
  if (jd.length < 20) return toast('JD 太短了，粘完整一点');
  if (resume.length < 20) return toast('简历内容太短，粘完整一点');
  if (!MODEL) return toast('模型还没加载好，稍等或刷新');

  const btn = $('#runBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>诊断中…';
  $('#resultPane').innerHTML = `<div class="card"><div class="empty"><b>正在分析</b>三版 Prompt 里，v3 会逐条比对 JD 要求和简历原文，通常需要 20-40 秒。</div></div>`;

  try {
    const r = await callLLM({ version: CURRENT_VERSION, jd, resume });
    const n = normalize(r.text, CURRENT_VERSION);
    renderResult(n, r, { jd, resume, version: CURRENT_VERSION });
    saveDiagnosis(n, r, { jd, resume, version: CURRENT_VERSION });
  } catch (e) {
    console.error(e);
    const code = e?.error?.code || e?.code || '';
    let msg = '生成失败，可以重试一次';
    if (code.startsWith('quota_')) msg = '调用额度用完或限流，稍后再试';
    if (code.startsWith('gateway_') || code.startsWith('model_')) msg = '模型服务暂时不可用，请重试';
    $('#resultPane').innerHTML = `<div class="card"><div class="empty"><b>${esc(msg)}</b>${
      e?.requestId ? `诊断编号 ${esc(e.requestId)}` : '如果反复失败，换一版 Prompt 或稍后再试。'
    }</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始诊断';
  }
};

function scoreColor(s) {
  if (s === null || s === undefined) return '#8a90a0';
  if (s >= 75) return '#1f8a5b';
  if (s >= 55) return '#2f5bea';
  if (s >= 35) return '#c5791a';
  return '#d93a3a';
}

function renderResult(n, r, ctx) {
  const color = scoreColor(n.overall);
  const val = n.overall === null ? '—' : n.overall;
  const circ = 2 * Math.PI * 42;
  const dash = n.overall === null ? 0 : (n.overall / 100) * circ;

  let html = `
  <div class="card">
    <div class="card-h">
      <div class="card-t">诊断结果 <span class="tag" style="background:#eef2ff;color:#2f5bea">${esc(PROMPTS[ctx.version].label)}</span></div>
      <div style="display:flex;gap:6px">
        ${n.parsed ? '<button class="ghost tiny" id="exportMd">导出报告</button>' : ''}
        <span class="hint">${r.latency} ms · ${r.usage?.total_tokens || '?'} tokens</span>
      </div>
    </div>
    <div class="score-wrap">
      <div class="ring">
        <svg width="104" height="104">
          <circle cx="52" cy="52" r="42" fill="none" stroke="#eef0f4" stroke-width="9"/>
          <circle cx="52" cy="52" r="42" fill="none" stroke="${color}" stroke-width="9"
                  stroke-linecap="round" stroke-dasharray="${dash} ${circ}"/>
        </svg>
        <div class="val" style="color:${color}">${val}<small>/100</small></div>
      </div>
      <div style="flex:1">
        <div style="font-weight:620;font-size:15px;margin-bottom:4px">${esc(n.verdict || '—')}</div>
        <div style="color:var(--ink-2);font-size:13px">${esc(n.oneLine || '')}</div>
        ${n.gapFocus ? `<div style="margin-top:8px;font-size:12.5px;color:var(--red)">最大差距：${esc(n.gapFocus)}</div>` : ''}
      </div>
    </div>
  `;

  if (!n.parsed) {
    html += `<div class="risk" style="margin-top:14px">这一版输出没能解析成结构化结果（这本身就是 v1/v2 的问题之一）。下面是原始输出。</div>
      <div class="raw">${esc(n.rawText)}</div></div>`;
    $('#resultPane').innerHTML = html;
    return;
  }

  // 维度
  n.dimensions.forEach((d) => {
    const c = scoreColor(d.score);
    html += `<div class="dim">
      <div class="dim-h"><span class="n">${esc(d.name)} <span style="color:var(--ink-3);font-size:11.5px">权重 ${Math.round(d.weight * 100)}%</span></span>
      <span class="s" style="color:${c}">${d.score ?? '—'}</span></div>
      <div class="bar"><i style="width:${d.score || 0}%;background:${c}"></i></div>
    </div>`;

    // 证据
    if (d.evidence?.length) {
      d.evidence.forEach((e) => {
        const state = ['hit', 'miss', 'unclear'].includes(e?.state) ? e.state : 'unclear';
        const stateText = { hit: '命中', miss: '缺失', unclear: '存疑' }[state];
        html += `<div class="ev">
          <div class="ev-top"><span class="tag ${state}">${stateText}</span>
            ${e.note ? `<span class="hint">${esc(e.note)}</span>` : ''}</div>
          <div class="q">JD：<b class="jd">${esc(e.jd_quote || '—')}</b></div>
          <div class="quote rs">简历：${e.resume_quote ? esc(e.resume_quote) : '<span style="color:var(--ink-3)">（无对应内容）</span>'}</div>
        </div>`;
      });
    }
  });

  html += `</div>`;

  // 改写
  if (n.rewrites.length) {
    html += `<div class="card"><div class="card-t" style="margin-bottom:6px">简历改写建议</div>
      <div class="hint" style="margin-bottom:4px">直接用右边这句替换左边这句，别照着"思路"自己重写。</div>`;
    n.rewrites.forEach((w) => {
      html += `<div class="rw">
        <div class="before">${esc(w.original || '（新增）')}</div>
        <div class="after">${esc(w.revised)}</div>
        ${w.why ? `<div class="why">${esc(w.why)}</div>` : ''}
        ${w.targets?.length ? `<div class="why">对应要求：${w.targets.map(esc).join(' / ')}</div>` : ''}
      </div>`;
    });
    html += `</div>`;
  }

  // 行动
  if (n.actions.length) {
    html += `<div class="card"><div class="card-t" style="margin-bottom:8px">7 天行动</div>
      <ol class="acts">${n.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol></div>`;
  }

  // 风险
  if (n.riskFlags.length) {
    html += `<div class="card"><div class="card-t" style="margin-bottom:8px">面试风险提示</div>
      ${n.riskFlags.map((r2) => `<div class="risk" style="margin-bottom:6px">${esc(r2)}</div>`).join('')}</div>`;
  }

  // 规则校验（把评测指标暴露给用户，这是产品透明度）
  const ev = evidenceRate(n);
  const fab = fabricateRate(n, ctx.resume);
  html += `<div class="card">
    <div class="card-t" style="margin-bottom:10px">本次输出的质量自检</div>
    <div class="kpi" style="grid-template-columns:repeat(3,1fr)">
      <div class="k" style="padding:12px"><div class="l">证据可追溯率</div><div class="v" style="font-size:19px">${pct(ev)}</div><div class="d">有原文摘录的证据占比</div></div>
      <div class="k" style="padding:12px"><div class="l">疑似编造率</div><div class="v" style="font-size:19px;color:${fab > 0.2 ? 'var(--red)' : 'var(--green)'}">${pct(fab)}</div><div class="d">声称命中但找不到原文</div></div>
      <div class="k" style="padding:12px"><div class="l">证据条数</div><div class="v" style="font-size:19px">${n.evidence.length}</div><div class="d">逐条对照了 ${n.evidence.length} 项要求</div></div>
    </div>
  </div>`;

  html += `<div class="card"><details><summary class="hint" style="cursor:pointer">查看模型原始输出</summary>
    <div class="raw">${esc(n.rawText)}</div></details></div>`;

  $('#resultPane').innerHTML = html;

  const ex = $('#exportMd');
  if (ex) ex.onclick = () => exportReport(n, r, ctx);
}

/* ---------------- 报告导出（Markdown） ---------------- */
function buildMarkdown(n, r, ctx) {
  const L = [];
  L.push(`# JD 匹配诊断报告`);
  L.push('');
  L.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push(`- Prompt 版本：${PROMPTS[ctx.version].label}`);
  L.push(`- 模型：${r.modelId}`);
  L.push(`- 耗时：${r.latency} ms · tokens：${r.usage?.total_tokens ?? '未知'}`);
  L.push('');
  if (ctx.jd) {
    L.push(`## 岗位 JD`);
    L.push('');
    L.push('```');
    L.push(ctx.jd.trim().slice(0, 3000));
    L.push('```');
    L.push('');
  }
  L.push(`## 结论`);
  L.push('');
  L.push(`- **匹配分：${n.overall ?? '—'} / 100**`);
  if (n.verdict) L.push(`- 判定：${n.verdict}`);
  if (n.oneLine) L.push(`- 一句话：${n.oneLine}`);
  if (n.gapFocus) L.push(`- 最大差距：${n.gapFocus}`);
  L.push('');
  if (n.dimensions?.length) {
    L.push(`## 四维评分`);
    L.push('');
    L.push(`| 维度 | 权重 | 得分 |`);
    L.push(`| --- | --- | --- |`);
    n.dimensions.forEach((d) => {
      L.push(`| ${d.name} | ${Math.round(d.weight * 100)}% | ${d.score ?? '—'} |`);
    });
    L.push('');
  }
  if (n.evidence?.length) {
    L.push(`## 证据对照`);
    L.push('');
    n.evidence.forEach((e) => {
      const s = { hit: '命中', miss: '缺失', unclear: '存疑' }[e.state] || '存疑';
      L.push(`### [${s}] ${e.dim}`);
      L.push('');
      L.push(`- JD：${e.jdQuote || '—'}`);
      L.push(`- 简历：${e.resumeQuote || '（无对应内容）'}`);
      if (e.note) L.push(`- 判断依据：${e.note}`);
      L.push('');
    });
  }
  if (n.rewrites?.length) {
    L.push(`## 简历改写建议`);
    L.push('');
    n.rewrites.forEach((w, i) => {
      L.push(`**${i + 1}. 原句**：${w.original || '（新增）'}`);
      L.push('');
      L.push(`**改为**：${w.revised}`);
      if (w.why) L.push(`> ${w.why}`);
      if (w.targets?.length) L.push(`> 对应要求：${w.targets.join(' / ')}`);
      L.push('');
    });
  }
  if (n.actions?.length) {
    L.push(`## 7 天行动`);
    L.push('');
    n.actions.forEach((a, i) => L.push(`${i + 1}. ${a}`));
    L.push('');
  }
  if (n.riskFlags?.length) {
    L.push(`## 面试风险提示`);
    L.push('');
    n.riskFlags.forEach((x) => L.push(`- ${x}`));
    L.push('');
  }
  L.push(`---`);
  L.push('');
  L.push(`> 本报告由「JD 匹配诊断器」生成。分数不是绝对评价，仅表示在该 JD 口径下的证据覆盖度。`);
  return L.join('\n');
}

function exportReport(n, r, ctx) {
  const md = buildMarkdown(n, r, ctx);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const title = (ctx.jd.split('\n')[0] || 'jd').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 30);
  a.href = url;
  a.download = `诊断报告_${title}_${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('报告已下载（Markdown）');
}

/* ---------------- 落库 ---------------- */
async function saveDiagnosis(n, r, ctx) {
  if (!SESSION?.user) return;
  try {
    const { error } = await cloud.database.from('jd_diagnoses').insert({
      owner_name: SESSION.user.name || null,
      job_title: (ctx.jd.split('\n')[0] || '').slice(0, 60),
      jd_text: ctx.jd,
      resume_text: ctx.resume,
      prompt_version: ctx.version,
      prompt_variant: PROMPTS[ctx.version].label,
      model_id: r.modelId,
      result: n,
      overall_score: n.overall,
      latency_ms: r.latency,
      prompt_tokens: r.usage?.prompt_tokens ?? null,
      completion_tokens: r.usage?.completion_tokens ?? null,
      total_tokens: r.usage?.total_tokens ?? null,
    });
    if (error) throw error;
    toast('已保存记录');
    loadDiagList();
    loadRuns();
  } catch (e) {
    console.error(e);
    toast('保存失败：' + (e?.message || '检查登录状态'));
  }
}

/* =========================================================
 * 投递排序（轻诊断）
 * 产品动机：一天刷 30 个岗，逐个跑完整诊断太贵太慢。
 * 分层：轻诊断做筛选 → 完整诊断做深挖。
 * ========================================================= */
function splitJds(text) {
  return text
    .split(/^\s*---+\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20)
    .slice(0, 5);
}

function updateScanCount() {
  const list = splitJds($('#scanJds').value);
  $('#scanCount').textContent = list.length ? `已识别 ${list.length} 条 JD` : '';
}

$('#scanJds').oninput = updateScanCount;

$('#scanFillResume').onclick = () => { $('#scanResume').value = RESUME_SOFT; };
$('#scanFillJds').onclick = () => {
  $('#scanJds').value = [JD_PM, JD_OPS, 'AI 产品经理实习生（增长方向）\n岗位职责：\n1. 负责 AI 工具的拉新、留存与转化，设计并执行增长实验\n2. 搭建用户分层与召回策略，跟踪核心漏斗\n3. 输出周度运营数据复盘\n任职要求：\n1. 本科在读，有数据分析基础，SQL 熟练\n2. 有内容运营或社群运营经验\n3. 对增长模型（AARRR）有基本理解\n4. 能写清楚复盘报告'].join('\n\n---\n\n');
  updateScanCount();
};

$('#scanBtn').onclick = async () => {
  const resume = $('#scanResume').value.trim();
  const list = splitJds($('#scanJds').value);
  if (resume.length < 40) return toast('简历太短，粘完整一点');
  if (list.length < 2) return toast('至少要 2 条 JD，用 --- 分隔');
  if (!MODEL) return toast('模型还没加载好');

  const btn = $('#scanBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>排序中…';
  $('#scanResult').innerHTML = `<div class="card"><div class="empty"><b>正在比较 ${list.length} 条 JD</b>这一步只做粗筛，通常 15-25 秒。</div></div>`;

  try {
    const t0 = performance.now();
    let text = '';
    const msgs = [
      { role: 'system', content: SCAN_PROMPT.system },
      { role: 'user', content: SCAN_PROMPT.buildUser(list, resume) },
    ];
    for await (const chunk of cloud.llm.chat.completions.create({
      model: MODEL.id,
      messages: msgs,
      stream: true,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })) {
      const d = chunk.choices?.[0]?.delta;
      if (d?.content) text += d.content;
    }
    const latency = Math.round(performance.now() - t0);
    const obj = extractJson(text);
    if (!obj || !Array.isArray(obj.items)) throw new Error('输出无法解析');

    renderScan(obj.items, list, latency);
  } catch (e) {
    console.error(e);
    $('#scanResult').innerHTML = `<div class="card"><div class="empty"><b>排序失败</b>${esc(e?.message || '可以重试一次')}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始排序';
  }
};

function renderScan(items, jdList, latency) {
  const rows = items
    .map((it, i) => ({
      index: Number(it.index) || i + 1,
      title: it.title || `JD ${i + 1}`,
      score: Math.max(0, Math.min(100, parseInt(it.score, 10) || 0)),
      fatalGap: it.fatal_gap || '—',
      why: it.why || '',
    }))
    .sort((a, b) => b.score - a.score);

  const top = rows[0];
  const second = rows[1];

  let html = `<div class="card">
    <div class="card-h">
      <div class="card-t">投递优先级</div>
      <span class="hint">${rows.length} 条 · ${latency} ms</span>
    </div>`;

  if (top) {
    html += `<div class="note" style="margin-bottom:16px">
      <b>先投第 ${rows.indexOf(top) + 1} 个：${esc(top.title)}（${top.score} 分）</b><br />
      ${esc(top.why)}
      ${second && top.score - second.score <= 5 ? '<br />—— 但它和第 2 名只差 ' + (top.score - second.score) + ' 分，两条都值得投。' : ''}
    </div>`;
  }

  html += `<table><thead><tr>
    <th style="width:46px">排序</th><th style="width:60px">分数</th><th style="width:200px">岗位</th>
    <th>为什么是这个分</th><th style="width:190px">最致命缺口</th><th style="width:80px">下一步</th>
  </tr></thead><tbody>`;

  rows.forEach((r, i) => {
    const s = scoreColor(r.score);
    html += `<tr>
      <td class="num" style="font-weight:650">${i + 1}</td>
      <td class="num" style="color:${s};font-weight:650">${r.score}</td>
      <td>${esc(r.title)}</td>
      <td class="hint">${esc(r.why)}</td>
      <td class="hint">${esc(r.fatalGap)}</td>
      <td><button class="ghost tiny" data-jd="${r.index - 1}">深挖</button></td>
    </tr>`;
  });
  html += `</tbody></table>
    <div class="hint" style="margin-top:10px">
      点「深挖」会把这条件带入「匹配诊断」，跑完整版（4 维评分 + 证据对照 + 简历改写 + 7 天行动）。
      注意：分数只在这批 JD 内部可比，不要跨批次比较。
    </div>
  </div>`;

  // 柱状对比
  const maxScore = Math.max(...rows.map((r) => r.score), 1);
  html += `<div class="card"><div class="card-t" style="margin-bottom:12px">分数对比</div>`;
  rows.forEach((r, i) => {
    html += `<div class="dim">
      <div class="dim-h"><span class="n">${i + 1}. ${esc(r.title)}</span><span class="s" style="color:${scoreColor(r.score)}">${r.score}</span></div>
      <div class="bar"><i style="width:${(r.score / maxScore) * 100}%;background:${scoreColor(r.score)}"></i></div>
    </div>`;
  });
  html += `</div>`;

  $('#scanResult').innerHTML = html;

  $$('#scanResult button[data-jd]').forEach((b) => {
    b.onclick = () => {
      const jd = jdList[Number(b.dataset.jd)];
      if (!jd) return;
      $('#jd').value = jd;
      $('#resume').value = $('#scanResume').value;
      $$('nav button').forEach((x) => x.classList.toggle('on', x.dataset.view === 'diagnose'));
      $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-diagnose'));
      toast('已带入，点「开始诊断」继续');
      $('#jd').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  });
}

/* =========================================================
 * 实验室：跑评测集
 * ========================================================= */
const EXPECT_RANGE = {
  1: [55, 80], 2: [40, 70], 3: [45, 70], 4: [40, 65], 5: [30, 55], 6: [40, 65],
  7: [5, 32], 8: [40, 80], 9: [5, 28], 10: [30, 52], 11: [52, 75], 12: [58, 80],
};

function renderCases() {
  $('#caseCount').textContent = `共 ${CASES.length} 条`;
  $('#caseTable').querySelector('tbody').innerHTML = CASES.map(
    (c) => `<tr>
      <td class="num">${c.no}</td>
      <td><span class="tag" style="background:#f4f5f8;color:#4a5060">${esc(c.category)}</span></td>
      <td>${esc(c.difficulty)}</td>
      <td>${esc(c.inputSummary)}<div class="hint" style="margin-top:2px">陷阱：${esc(c.trap)}</div></td>
      <td class="hint">${esc(c.expectHit)}</td>
    </tr>`
  ).join('');
}

let EVAL_RESULTS = null;

$('#runEval').onclick = async () => {
  if (!MODEL) return toast('模型还没加载好');
  const limit = parseInt($('#caseFilter').value === 'all' ? '12' : $('#caseFilter').value, 10);
  const btn = $('#runEval');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>运行中';
  const log = $('#evalLog');
  log.textContent = '';

  const versions = ['v1', 'v2', 'v3'];
  const total = versions.length * limit;
  let done = 0;
  const out = {};

  for (const v of versions) {
    out[v] = [];
    for (const c of CASES.slice(0, limit)) {
      done += 1;
      $('#evalProgress').textContent = `${done}/${total}`;
      log.textContent += `[${done}/${total}] ${v} · case#${c.no} ${c.category} … `;
      log.scrollTop = log.scrollHeight;

      let rec;
      try {
        const r = await callLLM({ version: v, jd: c.jd, resume: c.resume });
        const n = normalize(r.text, v);
        const m = evaluateOne(n, v, c, EXPECT_RANGE[c.no]);
        rec = { ...m, latency: r.latency, tokens: r.usage?.total_tokens ?? null };
        log.textContent += `score=${n.overall ?? '解析失败'} ${m.pass ? '✓' : '✗'}\n`;
      } catch (e) {
        rec = {
          overall: null, evidenceRate: 0, fabricateRate: 1, schemaRate: 0,
          scoreReasonable: 0, actionQuality: 0, pass: false,
          badcases: [{ dim: '调用失败', detail: e?.error?.code || e?.message || 'error' }],
          latency: null, tokens: null,
        };
        log.textContent += `调用失败 ${e?.error?.code || ''}\n`;
      }
      log.scrollTop = log.scrollHeight;
      out[v].push(rec);
    }
  }

  EVAL_RESULTS = out;
  renderCompare(out, limit);
  await persistRuns(out, limit);

  btn.disabled = false;
  btn.textContent = '跑评测';
  $('#evalProgress').textContent = '完成';
  toast('评测完成');
};

function aggregate(list, key) {
  if (!list.length) return 0;
  return list.reduce((s, x) => s + (x[key] || 0), 0) / list.length;
}

function renderCompare(out, limit) {
  const metrics = [
    ['通过率', 'pass', '综合判定：格式+分数区间+证据+编造+建议质量全部达标'],
    ['证据可追溯率', 'evidenceRate', '证据里有原文摘录的比例，越高越可信'],
    ['编造率', 'fabricateRate', '越低越好：声称命中却找不到原文'],
    ['格式合规率', 'schemaRate', '关键字段齐全程度'],
    ['分数合理性', 'scoreReasonable', '分数落在人工标注区间的比例'],
    ['建议可执行度', 'actionQuality', '建议里有具体工具/交付物的比例'],
  ];

  let html = `<table><thead><tr><th style="width:140px">指标</th>
    ${PROMPT_VERSIONS.map((v) => `<th>${esc(PROMPTS[v].label)}</th>`).join('')}
    <th style="width:260px">怎么读</th></tr></thead><tbody>`;

  metrics.forEach(([name, key, read]) => {
    const vals = PROMPT_VERSIONS.map((v) => aggregate(out[v], key));
    const best = key === 'fabricateRate' ? Math.min(...vals) : Math.max(...vals);
    html += `<tr><td><b>${name}</b></td>`;
    PROMPT_VERSIONS.forEach((v, i) => {
      const good = key === 'fabricateRate' ? vals[i] === best : vals[i] === best;
      html += `<td class="num" style="${good ? 'color:#1f8a5b;font-weight:650' : ''}">${pct(vals[i])}</td>`;
    });
    html += `<td class="hint">${read}</td></tr>`;
  });

  // 延迟
  html += `<tr><td><b>平均耗时</b></td>`;
  const lats = PROMPT_VERSIONS.map((v) => {
    const arr = out[v].filter((x) => x.latency);
    return arr.length ? Math.round(arr.reduce((s, x) => s + x.latency, 0) / arr.length) : 0;
  });
  const minLat = Math.min(...lats.filter(Boolean));
  PROMPT_VERSIONS.forEach((v, i) => {
    html += `<td class="num" style="${lats[i] === minLat ? 'color:#1f8a5b;font-weight:650' : ''}">${lats[i]} ms</td>`;
  });
  html += `<td class="hint">v3 更慢是预期的，换来的是可追溯性</td></tr>`;

  html += `<tr><td><b>通过条数</b></td>`;
  PROMPT_VERSIONS.forEach((v) => {
    const p = out[v].filter((x) => x.pass).length;
    html += `<td class="num">${p}/${out[v].length}</td>`;
  });
  html += `<td class="hint"></td></tr></tbody></table>`;

  // badcase 明细
  html += `<div style="margin-top:20px"><div class="card-t" style="margin-bottom:10px">v3 的 badcase 明细</div>`;
  const v3 = out.v3;
  const bad = v3.map((r, i) => ({ i: i + 1, r })).filter((x) => !x.r.pass);
  if (!bad.length) {
    html += `<div class="hint">本轮 v3 全部通过。注意：样本只有 ${limit} 条，全部通过说明样本还不够难，不代表产品成熟。</div>`;
  } else {
    html += `<table><thead><tr><th style="width:50px">case</th><th style="width:80px">分数</th><th>归因</th></tr></thead><tbody>`;
    bad.forEach(({ i, r }) => {
      const c = CASES[i - 1];
      html += `<tr><td class="num">#${i}</td><td class="num">${r.overall ?? '—'}</td>
        <td>${esc(c.category)} → ${r.badcases.map((b) => `<b>${esc(b.dim)}</b>：${esc(b.detail)}`).join('；')}</td></tr>`;
    });
    html += `</tbody></table>`;
  }
  html += `</div>`;

  $('#compareWrap').innerHTML = html;
}

async function persistRuns(out, limit) {
  if (!SESSION?.user) return;
  try {
    for (const v of PROMPT_VERSIONS) {
      const list = out[v];
      const dims = {
        evidenceRate: aggregate(list, 'evidenceRate'),
        fabricateRate: aggregate(list, 'fabricateRate'),
        schemaRate: aggregate(list, 'schemaRate'),
        scoreReasonable: aggregate(list, 'scoreReasonable'),
        actionQuality: aggregate(list, 'actionQuality'),
      };
      await cloud.database.from('eval_runs').insert({
        owner_name: SESSION.user.name || null,
        run_label: `${CASES.length} 条样本中取前 ${limit} 条`,
        prompt_version: v,
        model_id: MODEL.id,
        cases_total: list.length,
        cases_pass: list.filter((x) => x.pass).length,
        pass_rate: list.length ? list.filter((x) => x.pass).length / list.length : 0,
        dim_scores: dims,
        badcase_count: list.filter((x) => !x.pass).length,
        badcase_detail: list
          .map((x, i) => ({ case: i + 1, category: CASES[i]?.category, score: x.overall, reasons: (x.badcases || []).map((b) => `${b.dim}：${b.detail}`) }))
          .filter((x) => x.reasons.length),
        notes: 'eval.run',
      });
    }
    loadRuns();
  } catch (e) {
    console.error(e);
  }
}

/* ---------------- Prompt 正文 ---------------- */
function renderPromptViewer(v = 'v3') {
  $('#promptViewPicker').innerHTML = PROMPT_VERSIONS.map(
    (k) => `<button class="pill ${k === v ? 'on' : ''}" data-v="${k}"><b>${esc(PROMPTS[k].label)}</b><span>${esc(PROMPTS[k].tagline)}</span></button>`
  ).join('');
  $('#promptBody').textContent = PROMPTS[v].system;
  $$('#promptViewPicker .pill').forEach((b) => {
    b.onclick = () => renderPromptViewer(b.dataset.v);
  });
}

/* =========================================================
 * 报告页
 * ========================================================= */
async function loadDiagList() {
  if (!SESSION?.user) {
    $('#diagTable').innerHTML = `<div class="empty"><b>未登录</b>登录后这里会显示你的所有诊断记录。</div>`;
    return;
  }
  const { data, error } = await cloud.database
    .from('jd_diagnoses')
    .select('id, job_title, prompt_version, overall_score, latency_ms, total_tokens, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    $('#diagTable').innerHTML = `<div class="empty"><b>读取失败</b>${esc(error.message || '')}</div>`;
    return;
  }
  if (!data?.length) {
    $('#diagTable').innerHTML = `<div class="empty"><b>还没有记录</b>去「匹配诊断」跑一次。</div>`;
    renderKpi([]);
    return;
  }

  $('#diagTable').innerHTML = `<table><thead><tr>
    <th style="width:70px">时间</th><th>岗位</th><th style="width:70px">Prompt</th>
    <th style="width:60px">总分</th><th style="width:70px">耗时</th><th style="width:80px">tokens</th>
  </tr></thead><tbody>${data
    .map(
      (d) => `<tr style="cursor:pointer" data-id="${d.id}">
      <td class="hint">${new Date(d.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${esc((d.job_title || '未命名').slice(0, 40))}</td>
      <td><span class="tag" style="background:#f4f5f8;color:#4a5060">${esc(d.prompt_version)}</span></td>
      <td class="num" style="color:${scoreColor(d.overall_score)};font-weight:600">${d.overall_score ?? '—'}</td>
      <td class="num hint">${d.latency_ms ?? '—'}ms</td>
      <td class="num hint">${d.total_tokens ?? '—'}</td>
    </tr>`
    )
    .join('')}</tbody></table>
    <div class="hint" style="margin-top:8px">点任意一行可以回看完整诊断结果并重新导出报告。</div>`;

  $$('#diagTable tbody tr[data-id]').forEach((tr) => {
    tr.onclick = () => openHistory(tr.dataset.id);
  });

  renderKpi(data);
}

async function openHistory(id) {
  const { data, error } = await cloud.database
    .from('jd_diagnoses')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return toast('读取失败');
  const n = typeof data.result === 'string' ? normalize(data.result, data.prompt_version) : data.result;
  if (!n) return toast('这条记录的原始结果缺失');
  const r = {
    latency: data.latency_ms,
    usage: { total_tokens: data.total_tokens },
    modelId: data.model_id,
    text: n.rawText,
  };
  $$('nav button').forEach((x) => x.classList.toggle('on', x.dataset.view === 'diagnose'));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-diagnose'));
  renderResult(n, r, { jd: data.jd_text, resume: data.resume_text, version: data.prompt_version });
  $('#resultPane').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderKpi(rows) {  const n = rows.length;
  const avg = n ? Math.round(rows.reduce((s, r) => s + (r.overall_score || 0), 0) / n) : 0;
  const avgLat = n ? Math.round(rows.reduce((s, r) => s + (r.latency_ms || 0), 0) / n) : 0;
  const versions = new Set(rows.map((r) => r.prompt_version)).size;
  $('#kpi').innerHTML = `
    <div class="k"><div class="l">累计诊断</div><div class="v">${n}</div><div class="d">次</div></div>
    <div class="k"><div class="l">平均匹配分</div><div class="v">${avg || '—'}</div><div class="d">非绝对值，只在同 JD 口径下可比</div></div>
    <div class="k"><div class="l">平均耗时</div><div class="v">${avgLat || '—'}</div><div class="d">毫秒</div></div>
    <div class="k"><div class="l">已用 Prompt 版本</div><div class="v">${versions}</div><div class="d">共 ${PROMPT_VERSIONS.length} 个版本</div></div>`;
}

async function loadRuns() {
  if (!SESSION?.user) return;
  const { data, error } = await cloud.database
    .from('eval_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error || !data?.length) {
    $('#runTable').innerHTML = `<div class="empty"><b>还没有评测</b>去「Prompt 实验室」跑一轮。</div>`;
    return;
  }
  $('#runTable').innerHTML = `<table><thead><tr>
    <th style="width:110px">时间</th><th style="width:60px">版本</th><th style="width:80px">通过</th>
    <th style="width:70px">通过率</th><th>分项指标</th>
  </tr></thead><tbody>${data
    .map((r) => {
      const d2 = r.dim_scores || {};
      return `<tr>
      <td class="hint">${new Date(r.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
      <td><span class="tag" style="background:#f4f5f8;color:#4a5060">${esc(r.prompt_version)}</span></td>
      <td class="num">${r.cases_pass}/${r.cases_total}</td>
      <td class="num" style="font-weight:600">${pct(r.pass_rate)}</td>
      <td class="hint">证据 ${pct(d2.evidenceRate)} · 编造 ${pct(d2.fabricateRate)} · 格式 ${pct(d2.schemaRate)} · 分数合理 ${pct(d2.scoreReasonable)} · 建议 ${pct(d2.actionQuality)}</td>
    </tr>`;
    })
    .join('')}</tbody></table>`;
}

$('#refreshDiag').onclick = () => { loadDiagList(); toast('已刷新'); };
$('#refreshRuns').onclick = () => { loadRuns(); toast('已刷新'); };

/* =========================================================
 * 启动
 * ========================================================= */
(async function boot() {
  renderPromptPicker();
  renderCases();
  renderPromptViewer('v3');
  if (cloud) {
    await loadModels();
    try { await restoreOAuth(); } catch (e) { console.error(e); }
    await refreshSession();
    loadDiagList();
    loadRuns();
  } else {
    $('#modelSelect').innerHTML = '<option>SDK 未加载</option>';
  }
  $$('.step').forEach((s) => s.classList.add('done'));
})();
