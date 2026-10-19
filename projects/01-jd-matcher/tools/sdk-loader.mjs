/**
 * 从内置的 IIFE 版 SDK 引导出 Node 可用的 client，避免重复下载。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sdkPath = resolve(here, '../assets/vendor/workbuddy-cloud-sdk.global.js');

export function loadSdk() {
  const code = readFileSync(sdkPath, 'utf8');
  const fn = new Function(
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'navigator',
    'location',
    `${code}; return typeof WorkBuddyCloud !== "undefined" ? WorkBuddyCloud : (typeof globalThis.WorkBuddyCloud !== "undefined" ? globalThis.WorkBuddyCloud : null);`
  );

  // 最小浏览器垫片：SDK 在 Node 下只用到少量 Web API
  const noop = () => {};
  const memStore = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
      key: (i) => Array.from(m.keys())[i] ?? null,
      get length() { return m.size; },
    };
  };

  const fakeWindow = globalThis;
  const fakeDoc = {
    cookie: '',
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop }),
    body: { appendChild: noop },
    documentElement: {},
  };
  const fakeNav = { userAgent: 'node', language: 'zh-CN', languages: ['zh-CN'] };
  const fakeLoc = { href: 'https://jd-match-analyzer.app.workbuddy.host/', origin: 'https://jd-match-analyzer.app.workbuddy.host', search: '', pathname: '/', hash: '' };

  const sdk = fn(fakeWindow, fakeDoc, memStore(), memStore(), fakeNav, fakeLoc);
  if (!sdk) throw new Error('SDK 引导失败');
  return sdk;
}
