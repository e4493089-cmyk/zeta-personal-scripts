// ==UserScript==
// @name         Zeta RM 진단 스크립트
// @namespace    zeta-room-manager-diag
// @version      0.2.0
// @description  Zeta Room Manager 데이터/응답 구조 진단 스크립트.
// @match        https://zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;

  const capturedRooms = [];

  function scanPlotKeys(value, path = [], depth = 0, seen = new WeakSet(), out = []) {
    if (value == null || depth > 7 || out.length >= 120) return out;
    if (typeof value !== 'object') return out;
    if (seen.has(value)) return out;
    seen.add(value);

    if (Array.isArray(value)) {
      value.slice(0, 80).forEach((v, i) => scanPlotKeys(v, path.concat(i), depth + 1, seen, out));
      return out;
    }

    for (const [key, child] of Object.entries(value)) {
      const next = path.concat(key);
      if (/plot|origin|scenario|character|creator|author/i.test(key)) {
        let preview = child;
        if (child && typeof child === 'object') {
          try { preview = JSON.stringify(child).slice(0, 500); }
          catch (_) { preview = '[object]'; }
        }
        out.push(next.join('.') + ' = ' + String(preview).slice(0, 500));
        if (out.length >= 120) break;
      }
      if (child && typeof child === 'object') scanPlotKeys(child, next, depth + 1, seen, out);
      if (out.length >= 120) break;
    }
    return out;
  }

  function inspectRoomsPayload(payload, url) {
    const roots = [];
    if (Array.isArray(payload)) roots.push(...payload);
    if (payload && typeof payload === 'object') {
      for (const key of ['rooms', 'items', 'data', 'results', 'content']) {
        const v = payload[key];
        if (Array.isArray(v)) roots.push(...v);
        else if (v && typeof v === 'object') {
          for (const sub of ['rooms', 'items', 'results', 'content']) {
            if (Array.isArray(v[sub])) roots.push(...v[sub]);
          }
        }
      }
    }

    const room = roots.find(v => v && typeof v === 'object') || payload;
    capturedRooms.unshift({
      at: new Date().toISOString(),
      url: String(url || ''),
      sample: room,
      keys: scanPlotKeys(room)
    });
    if (capturedRooms.length > 5) capturedRooms.length = 5;
  }

  function isRoomsUrl(url) {
    return /\/v2\/rooms(?:[/?#]|$)/i.test(String(url || ''));
  }

  function installRoomsInterceptor() {
    if (window.__zrmDiagRoomsInterceptor) return;
    window.__zrmDiagRoomsInterceptor = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = async function () {
        const response = await originalFetch.apply(this, arguments);
        try {
          const req = arguments[0];
          const url = typeof req === 'string' ? req : req && req.url;
          if (isRoomsUrl(url)) {
            response.clone().json().then(data => inspectRoomsPayload(data, url)).catch(() => {});
          }
        } catch (_) {}
        return response;
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const urls = new WeakMap();

    XMLHttpRequest.prototype.open = function (method, url) {
      try { urls.set(this, String(url || '')); } catch (_) {}
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const url = urls.get(xhr) || '';
      if (isRoomsUrl(url)) {
        xhr.addEventListener('load', () => {
          try {
            const data = xhr.responseType === 'json'
              ? xhr.response
              : JSON.parse(xhr.responseText || 'null');
            inspectRoomsPayload(data, url);
          } catch (_) {}
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  }

  installRoomsInterceptor();

  function collect() {
    const out = [];
    const L = s => out.push(String(s));

    const items = new Set(document.querySelectorAll('[data-sentry-component="SwipeableRoomListItem"]'));
    document.querySelectorAll('a[href*="/rooms/"]').forEach(a => {
      const it = a.closest('[data-sentry-component="SwipeableRoomListItem"], li, [role="listitem"]')
        || a.parentElement?.parentElement;
      if (it) items.add(it);
    });
    const arr = [...items];

    L('URL: ' + location.pathname);
    L('=== 화면의 방 아이템: ' + arr.length + '개 ===');

    L('');
    L('=== /v2/rooms 응답 캡처 ===');
    if (!capturedRooms.length) {
      L('아직 캡처 없음 — 진단 스크립트를 켠 상태로 /ko/rooms를 새로고침하세요.');
    } else {
      const cap = capturedRooms[0];
      L('URL: ' + cap.url);
      L('캡처 시각: ' + cap.at);
      L('--- plot/character/creator 관련 키 ---');
      if (cap.keys.length) cap.keys.forEach(x => L(x));
      else L('(관련 키 없음)');
      L('--- 방 객체 샘플 (최대 5000자) ---');
      try { L(JSON.stringify(cap.sample, null, 2).slice(0, 5000)); }
      catch (_) { L(String(cap.sample).slice(0, 5000)); }
    }

    try {
      const st = JSON.parse(localStorage.getItem('zeta-room-manager:v1') || '{}');
      const idx = Object.values(st.index || {}).filter(e => e && e.type === 'room');
      let wc = 0, wr = 0;
      idx.forEach(e => {
        if ((e.characterNames || []).length) wc++;
        if ((e.creatorNames || []).length) wr++;
      });
      L('저장된 인덱스: ' + idx.length + '개 / 캐릭터명 있음: ' + wc + ' / 제작자명 있음: ' + wr);
      idx.slice(0, 5).forEach(e => L('  · ' + (e.alias || e.original)
        + ' | char=[' + (e.characterNames || []).join(', ') + ']'
        + ' | creator=[' + (e.creatorNames || []).join(', ') + ']'));
    } catch (err) {
      L('state 읽기 실패: ' + err);
    }

    const it = arr[0];
    if (!it) {
      L('');
      L('!! 방 아이템 없음 — 방 목록 화면(/ko/rooms)에서 눌러주세요');
      return out.join('\n');
    }

    L('');
    L('=== 첫 방 아이템 HTML (1200자) ===');
    L(it.outerHTML.slice(0, 1200));

    L('');
    L('=== dataset / alt / aria-label ===');
    [it, ...it.querySelectorAll('*')].slice(0, 60).forEach((el, i) => {
      const d = el.dataset || {};
      const ks = Object.keys(d);
      if (ks.length) L('[' + i + '] ' + el.tagName.toLowerCase() + ': ' + ks.map(k => k + '=' + d[k]).join(' | '));
      const al = el.getAttribute?.('alt');
      if (al) L('[' + i + '] alt=' + al);
      const ar = el.getAttribute?.('aria-label');
      if (ar) L('[' + i + '] aria-label=' + ar);
    });

    L('');
    L('=== React props 문자열 (최대 150줄) ===');
    const fk = Object.keys(it).find(k => k.startsWith('__reactFiber'));
    let f = fk ? it[fk] : null;
    if (!f) {
      L('!! __reactFiber 키 없음');
      return out.join('\n');
    }

    const seen = new WeakSet();
    let n = 0;
    const walk = (v, p, d) => {
      if (n >= 150 || v == null || d > 10) return;
      if (typeof v === 'string') {
        if (v.length > 0 && v.length < 160) { L(p.join('.') + ' = ' + JSON.stringify(v)); n++; }
        return;
      }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) {
        v.slice(0, 20).forEach((x, i) => walk(x, p.concat(i), d + 1));
        return;
      }
      for (const [k, x] of Object.entries(v)) {
        if (['children', 'ref', '_owner', 'return', 'stateNode', 'memoizedState', '_store', '_debugOwner'].includes(k)) continue;
        walk(x, p.concat(k), d + 1);
        if (n >= 150) break;
      }
    };
    for (let d = 0; f && d < 15; d++, f = f.return) {
      const nm = f.type?.name || f.elementType?.name || (typeof f.type === 'string' ? f.type : '?');
      L('--- depth ' + d + ' (' + nm + ') ---');
      walk(f.memoizedProps, ['d' + d], 0);
      if (n >= 150) break;
    }
    L('총 ' + n + '줄');

    return out.join('\n');
  }

  function show() {
    const text = collect();
    document.getElementById('zrm-diag-overlay')?.remove();

    const o = document.createElement('div');
    o.id = 'zrm-diag-overlay';
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#111;color:#eee;'
      + 'font:12px/1.5 ui-monospace,monospace;padding:12px;overflow:auto;'
      + 'white-space:pre-wrap;word-break:break-all;-webkit-overflow-scrolling:touch';

    const bar = document.createElement('div');
    bar.style.cssText = 'position:sticky;top:0;background:#111;padding:8px 0;display:flex;gap:8px;'
      + 'padding-top:calc(8px + env(safe-area-inset-top,0px))';

    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:10px 18px;background:#6d52ff;color:#fff;border:0;border-radius:8px;font:inherit;font-size:14px';
      b.addEventListener('click', fn);
      return b;
    };

    const copy = () => {
      const done = () => alert('복사됐어요!');
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else fallback();
      function fallback() {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        try { document.execCommand('copy'); done(); }
        catch (_) { alert('자동 복사 실패 — 아래 텍스트를 길게 눌러 직접 복사하세요'); }
        ta.remove();
      }
    };

    bar.append(mk('복사', copy), mk('닫기', () => o.remove()));

    const pre = document.createElement('div');
    pre.textContent = text;
    pre.style.userSelect = 'text';
    pre.style.webkitUserSelect = 'text';

    o.append(bar, pre);
    document.body.appendChild(o);
  }

  function addButton() {
    if (document.getElementById('zrm-diag-btn')) return;
    const b = document.createElement('button');
    b.id = 'zrm-diag-btn';
    b.textContent = '진단';
    b.style.cssText = 'position:fixed;right:14px;bottom:88px;z-index:2147483646;'
      + 'padding:12px 16px;background:#ff5c5c;color:#fff;border:0;border-radius:24px;'
      + 'font:700 14px/1 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4)';
    b.addEventListener('click', show);
    document.body.appendChild(b);
  }

  addButton();
  setInterval(addButton, 1500);
})();
