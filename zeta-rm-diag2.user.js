// ==UserScript==
// @name         Zeta RM 진단 2 (API 탐색)
// @namespace    zeta-room-manager-diag2
// @version      0.2.0
// @description  Zeta가 쓰는 API 주소와 응답에 제작자/캐릭터 정보가 있는지 확인.
// @match        https://zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;
  const log = [], MAX = 60;
  function note(method, url, bodyText) {
    if (log.length >= MAX) return;
    let hit = '', keys = '';
    if (bodyText) {
      try { keys = summarizeKeys(JSON.parse(bodyText), 0).slice(0, 40).join(', '); } catch (_) { keys = '(JSON 아님)'; }
      const found = new Set();
      const re = /"([a-zA-Z_]*(?:creator|character|author|nickname)[a-zA-Z_]*)"\s*:\s*("(?:[^"\\]|\\.){0,60}")/gi;
      let m; while ((m = re.exec(bodyText)) && found.size < 12) found.add(m[1] + '=' + m[2]);
      if (found.size) hit = [...found].join(' | ');
    }
    log.push({ method, url, keys, hit });
  }
  function summarizeKeys(v, depth, prefix = '') {
    if (depth > 3 || v == null || typeof v !== 'object') return [];
    if (Array.isArray(v)) return v.length ? summarizeKeys(v[0], depth + 1, prefix + '[].') : [];
    const out = [];
    for (const k of Object.keys(v).slice(0, 25)) {
      out.push(prefix + k);
      const child = v[k];
      if (child && typeof child === 'object') out.push(...summarizeKeys(child, depth + 1, prefix + k + '.'));
      if (out.length > 60) break;
    }
    return out;
  }
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const method = args[1]?.method || 'GET';
    return origFetch.apply(this, args).then(res => {
      try {
        if (/zeta-ai\.io|api/i.test(url) && !/image\.|_next\/static|\.js$|\.css$|sentry/i.test(url))
          res.clone().text().then(t => note('fetch ' + method, url, t.slice(0, 200000))).catch(() => {});
      } catch (_) {}
      return res;
    });
  };
  const origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__zrmMethod = m; this.__zrmUrl = u; return origOpen.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        const u = this.__zrmUrl || '';
        if (/zeta-ai\.io|api/i.test(u) && !/image\.|_next\/static|\.js$|\.css$|sentry/i.test(u))
          note('xhr ' + (this.__zrmMethod || ''), u, String(this.responseText || '').slice(0, 200000));
      } catch (_) {}
    });
    return origSend.apply(this, a);
  };
  function buildReport() {
    const out = [], L = s => out.push(String(s));
    L('=== 가로챈 요청: ' + log.length + '개 ==='); L('');
    log.forEach((e, i) => { L('[' + i + '] ' + e.method + ' ' + e.url); if (e.hit) L('   ★ 제작자/캐릭터 후보: ' + e.hit); if (e.keys) L('   keys: ' + e.keys); L(''); });
    L('=== __NEXT_DATA__ ===');
    try { const nd = window.__NEXT_DATA__; L(nd ? JSON.stringify(nd).slice(0, 800) : '없음'); } catch (_) { L('읽기 실패'); }
    return out.join('\n');
  }
  function show() {
    const report = buildReport(); document.getElementById('zrm-diag2-overlay')?.remove();
    const o=document.createElement('div'); o.id='zrm-diag2-overlay'; o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#111;color:#eee;font:12px/1.5 ui-monospace,monospace;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all';
    const bar=document.createElement('div'); bar.style.cssText='position:sticky;top:0;background:#111;padding:8px 0;display:flex;gap:8px;padding-top:calc(8px + env(safe-area-inset-top,0px))';
    const mk=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.style.cssText='padding:10px 18px;background:#6d52ff;color:#fff;border:0;border-radius:8px;font:inherit;font-size:14px';b.addEventListener('click',fn);return b;};
    const copy=()=>navigator.clipboard?.writeText(report).then(()=>alert('복사됐어요!')).catch(()=>{});
    bar.append(mk('복사',copy),mk('닫기',()=>o.remove())); const pre=document.createElement('div');pre.textContent=report;pre.style.userSelect='text';o.append(bar,pre);document.body.appendChild(o);
  }
  function addButton(){if(!document.body||document.getElementById('zrm-diag2-btn'))return;const b=document.createElement('button');b.id='zrm-diag2-btn';b.textContent='API';b.style.cssText='position:fixed;right:14px;bottom:150px;z-index:2147483646;padding:12px 16px;background:#2ea44f;color:#fff;border:0;border-radius:24px;font:700 14px/1 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4)';b.addEventListener('click',show);document.body.appendChild(b);}
  setInterval(addButton,1000);
})();