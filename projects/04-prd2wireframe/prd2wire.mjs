#!/usr/bin/env node
/**
 * prd2wire —— 把结构化 PRD 直接转成可交互的 HTML 线框图
 *
 * 用法:
 *   node prd2wire.mjs <prd.md> [out.html]
 *
 * PRD 语法（刻意保持极简，非设计师也能改）:
 *   # 项目名
 *   > 一句话说明（可选）
 *   ## page 页面名
 *   ### section 区块名
 *   - 组件: 键=值, 键=值
 *
 * 支持组件: navbar tabs textarea input select button card list table chart tags divider footer note
 */
import { readFileSync, writeFileSync } from 'node:fs';

const COMPONENTS = ['navbar', 'tabs', 'textarea', 'input', 'select', 'button', 'card', 'list', 'table', 'chart', 'tags', 'divider', 'footer', 'note'];
const WARNINGS = [];

function parse(src) {
  const doc = { title: '未命名原型', desc: '', pages: [] };
  let page = null;
  let section = null;

  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ')) {
      doc.title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('> ')) {
      doc.desc = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      page = { name: line.slice(3).replace(/^page\s+/i, '').trim(), sections: [] };
      doc.pages.push(page);
      section = null;
      continue;
    }
    if (line.startsWith('### ')) {
      if (!page) {
        page = { name: '默认页面', sections: [] };
        doc.pages.push(page);
      }
      section = { name: line.slice(4).trim(), blocks: [] };
      page.sections.push(section);
      continue;
    }
    const m = /^-\s*([a-zA-Z]+)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, type, rest] = m;
    if (!COMPONENTS.includes(type.toLowerCase())) {
      WARNINGS.push(`未知组件「${type}」已跳过（第 ${WARNINGS.length + 1} 处）`);
      continue;
    }
    const props = {};
    // 支持 k=v 与 k=v, k=v，值里允许中文和空格
    for (const part of rest.split(/[,，]\s*(?=[a-zA-Z\u4e00-\u9fa5]+\s*[=:：])/)) {
      const kv = /^([a-zA-Z\u4e00-\u9fa5]+)\s*[=:：]\s*(.*)$/.exec(part.trim());
      if (kv) props[kv[1]] = kv[2].trim();
    }
    if (!section) {
      section = { name: '默认区块', blocks: [] };
      page.sections.push(section);
    }
    section.blocks.push({ type: type.toLowerCase(), props });
  }
  return doc;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderBlock(b) {
  const p = b.props;
  const label = p.label ? `<div class="wf-label">${esc(p.label)}</div>` : '';
  const note = p.note ? `<div class="wf-note">${esc(p.note)}</div>` : '';
  switch (b.type) {
    case 'navbar':
      return `<div class="wf-navbar"><span class="wf-logo">${esc(p.logo || 'LOGO')}</span><span class="wf-title">${esc(p.title || '')}</span><span class="wf-right">${esc(p.right || '')}</span></div>`;
    case 'tabs': {
      const items = String(p.items || '').split(/[\/｜|]/).map((s) => s.trim()).filter(Boolean);
      return `<div class="wf-tabs">${items.map((t, i) => `<span class="${i === 0 ? 'on' : ''}">${esc(t)}</span>`).join('')}</div>`;
    }
    case 'textarea':
      return `<div class="wf-field">${label}<div class="wf-textarea" style="height:${Number(p.rows || 4) * 18}px">${esc(p.placeholder || '')}</div></div>`;
    case 'input':
      return `<div class="wf-field">${label}<div class="wf-input">${esc(p.placeholder || '')}</div></div>`;
    case 'select':
      return `<div class="wf-field">${label}<div class="wf-input">${esc(p.options || '请选择')} ▾</div></div>`;
    case 'button': {
      const primary = (p.style || '').toLowerCase() === 'primary';
      return `<div class="wf-btn ${primary ? 'primary' : ''}">${esc(p.text || '按钮')}</div>`;
    }
    case 'card':
      return `<div class="wf-card">${p.title ? `<div class="wf-card-title">${esc(p.title)}</div>` : ''}<div class="wf-card-body">${esc(p.text || '内容区')}</div>${note}</div>`;
    case 'list': {
      const items = String(p.items || '').split(/[\/｜|]/).map((s) => s.trim()).filter(Boolean);
      return `<div class="wf-list">${items.map((t) => `<div class="wf-li"><i></i>${esc(t)}</div>`).join('')}</div>`;
    }
    case 'table': {
      const cols = String(p.cols || 'A/B/C').split(/[\/｜|]/).map((s) => s.trim());
      const rows = Number(p.rows || 3);
      return `<table class="wf-table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: rows }, () => `<tr>${cols.map(() => '<td></td>').join('')}</tr>`).join('')}</tbody></table>`;
    }
    case 'chart':
      return `<div class="wf-chart">${esc(p.title || '图表区')}<div class="wf-bars">${Array.from({ length: 7 }, (_, i) => `<span style="height:${20 + ((i * 37) % 70)}%"></span>`).join('')}</div></div>`;
    case 'tags': {
      const items = String(p.items || '').split(/[\/｜|]/).map((s) => s.trim()).filter(Boolean);
      return `<div class="wf-tags">${items.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`;
    }
    case 'divider':
      return '<hr class="wf-hr">';
    case 'footer':
      return `<div class="wf-footer">${esc(p.text || '© 2026')}</div>`;
    case 'note':
      return `<div class="wf-note-box">${esc(p.text || '')}</div>`;
    default:
      return '';
  }
}

function renderSection(s) {
  return `<section class="wf-section"><h4>${esc(s.name)}</h4>${s.blocks.map(renderBlock).join('\n')}</section>`;
}

function render(doc) {
  const pages = doc.pages.length ? doc.pages : [{ name: '空页面', sections: [] }];
  const tabs = pages.map((p, i) => `<span class="${i === 0 ? 'on' : ''}">${esc(p.name)}</span>`).join('');
  const body = pages
    .map(
      (p, i) =>
        `<div class="wf-page" data-page="${i}" style="display:${i === 0 ? 'block' : 'none'}">${p.sections.map(renderSection).join('\n')}</div>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)} · 线框图</title>
<style>
:root{--ink:#1f2328;--mid:#6b7280;--line:#c9ced6;--bg:#f6f7f9;--paper:#fff;--accent:#2f6fed}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wf-wrap{max-width:960px;margin:28px auto 60px;padding:0 20px}
.wf-head{margin-bottom:18px}
.wf-head h1{font-size:20px;margin:0 0 6px}
.wf-head p{margin:0;color:var(--mid);font-size:13px}
.wf-canvas{background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 2px 14px rgba(16,24,40,.06)}
.wf-tabs{display:flex;gap:4px;padding:10px 14px;border-bottom:1px solid var(--line);background:#fbfcfd}
.wf-tabs span{padding:6px 12px;border-radius:7px;color:var(--mid);font-size:13px;cursor:pointer}
.wf-tabs span.on{background:#e8f0ff;color:var(--accent);font-weight:600}
.wf-page{padding:18px 20px}
.wf-section{border:1px dashed var(--line);border-radius:10px;padding:14px;margin-bottom:16px}
.wf-section h4{margin:0 0 12px;font-size:12px;color:var(--mid);font-weight:600;letter-spacing:.04em}
.wf-navbar{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:12px 4px;margin-bottom:14px}
.wf-logo{font-weight:700;background:#e8f0ff;color:var(--accent);border-radius:6px;padding:2px 6px;font-size:12px}
.wf-title{font-weight:600}
.wf-right{margin-left:auto;color:var(--mid);font-size:12px;border:1px solid var(--line);border-radius:6px;padding:4px 10px}
.wf-field{margin-bottom:12px}
.wf-label{font-size:12px;color:var(--mid);margin-bottom:5px}
.wf-textarea{border:1px solid var(--line);border-radius:8px;padding:10px;color:#9aa3af;font-size:13px;background:#fcfcfd}
.wf-input{border:1px solid var(--line);border-radius:8px;padding:9px 10px;color:#9aa3af;font-size:13px;background:#fcfcfd}
.wf-btn{display:inline-block;border:1px solid var(--line);border-radius:8px;padding:8px 16px;font-size:13px;margin-right:8px;background:#fff}
.wf-btn.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
.wf-card{border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px;background:#fcfcfd}
.wf-card-title{font-weight:600;margin-bottom:6px;font-size:13px}
.wf-card-body{color:#9aa3af;font-size:13px;min-height:28px}
.wf-note{font-size:12px;color:var(--mid);margin-top:6px}
.wf-list{border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.wf-li{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed #e5e8ec;color:#7b8494;font-size:13px}
.wf-li:last-child{border-bottom:0}
.wf-li i{width:8px;height:8px;border-radius:50%;background:#d5dae2;flex:none}
.wf-table{width:100%;border-collapse:collapse;font-size:13px}
.wf-table th,.wf-table td{border:1px solid var(--line);padding:8px;text-align:left}
.wf-table th{background:#f7f8fa;color:var(--mid);font-weight:600;font-size:12px}
.wf-table td{height:26px}
.wf-chart{border:1px solid var(--line);border-radius:10px;padding:12px;color:var(--mid);font-size:12px}
.wf-bars{display:flex;align-items:flex-end;gap:8px;height:84px;margin-top:10px}
.wf-bars span{flex:1;background:#e3e8f0;border-radius:4px 4px 0 0}
.wf-tags span{display:inline-block;border:1px solid var(--line);border-radius:20px;padding:3px 10px;margin:0 6px 6px 0;font-size:12px;color:var(--mid)}
.wf-hr{border:0;border-top:1px dashed var(--line);margin:14px 0}
.wf-footer{text-align:center;color:#9aa3af;font-size:12px;padding:14px 0}
.wf-note-box{background:#fff8e6;border:1px solid #f2dfae;border-radius:8px;padding:10px;font-size:12px;color:#8a6d1f}
.wf-foot{margin-top:14px;color:#9aa3af;font-size:12px;text-align:right}
</style></head>
<body><div class="wf-wrap">
<div class="wf-head"><h1>${esc(doc.title)}</h1>${doc.desc ? `<p>${esc(doc.desc)}</p>` : ''}</div>
<div class="wf-canvas"><div class="wf-tabs" id="tabs">${tabs}</div>${body}</div>
<div class="wf-foot">prd2wire 生成 · 灰度块仅表达结构，不含视觉设计</div>
</div>
<script>
var tabs=[].slice.call(document.querySelectorAll('#tabs span'));
var pages=[].slice.call(document.querySelectorAll('.wf-page'));
tabs.forEach(function(t,i){t.onclick=function(){tabs.forEach(function(x){x.className=''});t.className='on';pages.forEach(function(p,j){p.style.display=i===j?'block':'none';});};});
</script>
</body></html>`;
}

const [, , inPath, outPath] = process.argv;
if (!inPath) {
  console.error('用法: node prd2wire.mjs <prd.md> [out.html]');
  process.exit(1);
}
const src = readFileSync(inPath, 'utf8');
const doc = parse(src);
const html = render(doc);
const out = outPath || inPath.replace(/\.md$/i, '') + '.wireframe.html';
writeFileSync(out, html);

const blocks = doc.pages.reduce((s, p) => s + p.sections.reduce((t, x) => t + x.blocks.length, 0), 0);
console.log(`✓ ${out}`);
console.log(`  页面 ${doc.pages.length} 个 / 区块 ${doc.pages.reduce((s, p) => s + p.sections.length, 0)} 个 / 组件 ${blocks} 个`);
if (WARNINGS.length) console.log('  ⚠ ' + WARNINGS.join('；'));
