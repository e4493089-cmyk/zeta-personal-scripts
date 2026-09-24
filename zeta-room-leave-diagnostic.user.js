// ==UserScript==
// @name         Zeta 모바일 나가기 요청 진단
// @namespace    zeta-personal-scripts
// @version      0.1.0
// @description  모바일에서 대화방 나가기 직전/직후 ZETA가 실제로 보내는 네트워크 요청을 기록합니다. 추가 요청은 보내지 않습니다.
// @match        https://zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.top !== window.self || window.__zetaRoomLeaveDiagLoaded) return;
  window.__zetaRoomLeaveDiagLoaded = true;

  const KEY_LOGS = 'zeta-room-leave-diag:logs:v1';
  const KEY_UNTIL = 'zeta-room-leave-diag:until:v1';
  const KEY_STARTED = 'zeta-room-leave-diag:started:v1';
  const KEY_LAST_ROOM = 'zeta-room-leave-diag:last-room:v1';
  const PANEL_ID = 'zeta-room-leave-diag-panel';
  const BUTTON_ID = 'zeta-room-leave-diag-button';
  const STYLE_ID = 'zeta-room-leave-diag-style';
  const MAX_LOGS = 120;
  const MAX_TEXT = 2400;
  const RECORD_MS = 30000;

  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

  function nowActive() {
    const until = Number(localStorage.getItem(KEY_UNTIL) || 0);
    return until > Date.now();
  }

  function remainingSeconds() {
    return Math.max(0, Math.ceil((Number(localStorage.getItem(KEY_UNTIL) || 0) - Date.now()) / 1000));
  }

  function readLogs() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY_LOGS) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function writeLogs(logs) {
    try { localStorage.setItem(KEY_LOGS, JSON.stringify(logs.slice(-MAX_LOGS))); } catch (_) {}
  }

  function clipText(value, max = MAX_TEXT) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    return text.length > max ? text.slice(0, max) + ' …[잘림]' : text;
  }

  function bodyText(body) {
    if (body == null) return '';
    try {
      if (typeof body === 'string') return clipText(body);
      if (body instanceof URLSearchParams) return clipText(body.toString());
      if (body instanceof FormData) {
        const rows = [];
        for (const [key, value] of body.entries()) {
          rows.push([key, typeof value === 'string' ? value : '[File]']);
        }
        return clipText(JSON.stringify(rows));
      }
      if (body instanceof Blob) return '[Blob ' + body.type + ' ' + body.size + 'B]';
      if (body instanceof ArrayBuffer) return '[ArrayBuffer ' + body.byteLength + 'B]';
      if (ArrayBuffer.isView(body)) return '[' + body.constructor.name + ' ' + body.byteLength + 'B]';
      if (typeof body === 'object') return clipText(JSON.stringify(body));
    } catch (_) {}
    return clipText(String(body));
  }

  function currentRoomId() {
    const match = location.pathname.match(/\/rooms\/([^/?#]+)/i);
    if (match) return match[1];
    return clean(localStorage.getItem(KEY_LAST_ROOM));
  }

  function rememberRoomFromTarget(target) {
    try {
      const link = target?.closest?.('a[href*="/rooms/"]')
        || target?.closest?.('[data-sentry-component="SwipeableRoomListItem"]')?.querySelector?.('a[href*="/rooms/"]');
      const href = link?.href || '';
      const id = href.match(/\/rooms\/([^/?#]+)/i)?.[1];
      if (id) localStorage.setItem(KEY_LAST_ROOM, id);
    } catch (_) {}
  }

  function addLog(entry) {
    if (!nowActive()) return;
    const logs = readLogs();
    logs.push({
      at: new Date().toISOString(),
      page: location.pathname + location.search,
      roomId: currentRoomId() || '',
      ...entry
    });
    writeLogs(logs);
    updateButton();
  }

  function startRecording() {
    const started = Date.now();
    localStorage.setItem(KEY_STARTED, String(started));
    localStorage.setItem(KEY_UNTIL, String(started + RECORD_MS));
    localStorage.setItem(KEY_LOGS, '[]');
    addLog({
      kind: 'diag',
      event: 'record-start',
      note: '30초 기록 시작'
    });
    closePanel();
    updateButton();
  }

  function clearRecording() {
    localStorage.removeItem(KEY_LOGS);
    localStorage.removeItem(KEY_UNTIL);
    localStorage.removeItem(KEY_STARTED);
    updateButton();
    renderPanel();
  }

  function interestingUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      return /(^|\.)zeta-ai\.io$/i.test(url.hostname);
    } catch (_) {
      return false;
    }
  }

  function shouldRecord(method, url) {
    if (!nowActive() || !interestingUrl(url)) return false;
    const verb = String(method || 'GET').toUpperCase();
    // 나가기와 함께 발생하는 상태 변경 요청이 핵심. GET 노이즈는 버린다.
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb);
  }

  // fetch
  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = async function(input, init = {}) {
        const method = String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
        const url = typeof input === 'string' ? input : input?.url || '';
        const body = bodyText(init?.body);

        let response;
        try {
          response = await originalFetch.apply(this, arguments);
        } catch (error) {
          if (shouldRecord(method, url)) {
            addLog({
              kind: 'fetch',
              method,
              url: String(url),
              body,
              status: 0,
              ok: false,
              error: clipText(error?.message || String(error))
            });
          }
          throw error;
        }

        if (shouldRecord(method, url)) {
          addLog({
            kind: 'fetch',
            method,
            url: String(url),
            body,
            status: response.status,
            ok: response.ok
          });
        }
        return response;
      };
    }
  } catch (_) {}

  // XHR
  try {
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const meta = new WeakMap();

    proto.open = function(method, url) {
      try {
        meta.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url || '') });
      } catch (_) {}
      return originalOpen.apply(this, arguments);
    };

    proto.send = function(body) {
      const xhr = this;
      const info = meta.get(xhr) || { method: 'GET', url: '' };
      if (shouldRecord(info.method, info.url)) {
        xhr.addEventListener('loadend', () => {
          addLog({
            kind: 'xhr',
            method: info.method,
            url: info.url,
            body: bodyText(body),
            status: Number(xhr.status || 0),
            ok: xhr.status >= 200 && xhr.status < 300
          });
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  } catch (_) {}

  // sendBeacon
  try {
    const originalBeacon = navigator.sendBeacon?.bind(navigator);
    if (originalBeacon) {
      navigator.sendBeacon = function(url, data) {
        const accepted = originalBeacon(url, data);
        if (nowActive() && interestingUrl(url)) {
          addLog({
            kind: 'beacon',
            method: 'BEACON',
            url: String(url),
            body: bodyText(data),
            status: accepted ? 'queued' : 'rejected',
            ok: Boolean(accepted)
          });
        }
        return accepted;
      };
    }
  } catch (_) {}

  // WebSocket outgoing frames
  try {
    const originalWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (nowActive()) {
        addLog({
          kind: 'websocket',
          method: 'WS SEND',
          url: this.url || '',
          body: bodyText(data),
          status: this.readyState,
          ok: this.readyState === WebSocket.OPEN
        });
      }
      return originalWsSend.apply(this, arguments);
    };
  } catch (_) {}

  function installUiIntentCapture() {
    document.addEventListener('pointerdown', event => {
      rememberRoomFromTarget(event.target);
    }, true);

    document.addEventListener('touchstart', event => {
      rememberRoomFromTarget(event.target);
    }, { capture: true, passive: true });

    document.addEventListener('click', event => {
      rememberRoomFromTarget(event.target);
      if (!nowActive()) return;

      const button = event.target?.closest?.('button');
      if (!button) return;
      const label = clean(button.textContent);
      if (!label) return;

      if (/나가기/.test(label)) {
        addLog({
          kind: 'ui',
          event: 'leave-click',
          label,
          note: '사용자가 나가기 버튼 누름'
        });
      } else if (/^(취소|닫기|아니오)$/.test(label)) {
        addLog({
          kind: 'ui',
          event: 'cancel-click',
          label
        });
      }
    }, true);
  }

  function formatLogs() {
    const logs = readLogs();
    const started = Number(localStorage.getItem(KEY_STARTED) || 0);
    const lines = [
      '=== ZETA MOBILE ROOM LEAVE DIAGNOSTIC ===',
      'started: ' + (started ? new Date(started).toISOString() : '(없음)'),
      'saved: ' + new Date().toISOString(),
      'ua: ' + navigator.userAgent,
      'entries: ' + logs.length,
      ''
    ];

    logs.forEach((row, index) => {
      lines.push('[' + (index + 1) + '] ' + (row.at || ''));
      lines.push('kind: ' + (row.kind || ''));
      if (row.event) lines.push('event: ' + row.event);
      if (row.label) lines.push('label: ' + row.label);
      if (row.method) lines.push('method: ' + row.method);
      if (row.url) lines.push('url: ' + row.url);
      if (row.status !== undefined) lines.push('status: ' + row.status);
      if (row.ok !== undefined) lines.push('ok: ' + row.ok);
      if (row.roomId) lines.push('roomId: ' + row.roomId);
      if (row.page) lines.push('page: ' + row.page);
      if (row.body) lines.push('body: ' + row.body);
      if (row.error) lines.push('error: ' + row.error);
      if (row.note) lines.push('note: ' + row.note);
      lines.push('');
    });

    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID}{
        position:fixed;right:14px;bottom:max(16px,calc(env(safe-area-inset-bottom) + 10px));
        z-index:2147483646;border:0;border-radius:999px;padding:10px 13px;
        background:#1f1f22;color:#fff;font:700 12px/1.2 system-ui,sans-serif;
        box-shadow:0 6px 24px rgba(0,0,0,.35)
      }
      #${BUTTON_ID}[data-active="1"]{background:#b4232d}
      #${PANEL_ID}{
        position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;
        padding:16px;background:rgba(0,0,0,.58);box-sizing:border-box
      }
      #${PANEL_ID} .zrd-card{
        width:min(420px,100%);max-height:85vh;display:flex;flex-direction:column;gap:10px;
        padding:16px;border-radius:16px;background:#202023;color:#fff;
        box-shadow:0 20px 60px rgba(0,0,0,.4);font:500 12px/1.45 system-ui,sans-serif
      }
      #${PANEL_ID} .zrd-title{font-size:15px;font-weight:800}
      #${PANEL_ID} .zrd-note{color:rgba(255,255,255,.62);font-size:11px}
      #${PANEL_ID} textarea{
        width:100%;height:42vh;box-sizing:border-box;resize:none;border:1px solid rgba(255,255,255,.12);
        border-radius:10px;background:#121214;color:#fff;padding:10px;font:500 10px/1.45 ui-monospace,monospace
      }
      #${PANEL_ID} .zrd-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      #${PANEL_ID} button{
        min-height:40px;border:0;border-radius:10px;padding:8px 10px;
        background:rgba(255,255,255,.09);color:#fff;font:700 11px/1.2 system-ui,sans-serif
      }
      #${PANEL_ID} .zrd-start{grid-column:1/-1;background:#b4232d}
      #${PANEL_ID} .zrd-copy{background:#fff;color:#111}
    `;
    document.documentElement.appendChild(style);
  }

  function closePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function renderPanel() {
    if (!document.body) return;
    closePanel();
    injectStyle();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="zrd-card" role="dialog" aria-modal="true">
        <div class="zrd-title">ZETA 나가기 요청 진단</div>
        <div class="zrd-note">기록 시작 → 대화방 하나만 나가기 → 다시 진단 버튼 → 결과 복사. 인증 헤더는 기록하지 않습니다.</div>
        <textarea readonly></textarea>
        <div class="zrd-actions">
          <button type="button" class="zrd-start">30초 기록 시작</button>
          <button type="button" class="zrd-copy">결과 복사</button>
          <button type="button" class="zrd-clear">기록 삭제</button>
          <button type="button" class="zrd-close">닫기</button>
        </div>
      </div>
    `;

    const ta = panel.querySelector('textarea');
    ta.value = formatLogs();

    panel.querySelector('.zrd-start').addEventListener('click', startRecording);
    panel.querySelector('.zrd-copy').addEventListener('click', async event => {
      await copyText(formatLogs());
      event.currentTarget.textContent = '복사됨';
      setTimeout(() => {
        if (event.currentTarget?.isConnected) event.currentTarget.textContent = '결과 복사';
      }, 1200);
    });
    panel.querySelector('.zrd-clear').addEventListener('click', clearRecording);
    panel.querySelector('.zrd-close').addEventListener('click', closePanel);
    panel.addEventListener('click', event => {
      if (event.target === panel) closePanel();
    });

    document.body.appendChild(panel);
  }

  function updateButton() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    const active = nowActive();
    button.dataset.active = active ? '1' : '0';
    button.textContent = active ? '기록 중 ' + remainingSeconds() + 's' : '진단';
  }

  function mountButton() {
    if (!document.body) return;
    injectStyle();
    let button = document.getElementById(BUTTON_ID);
    if (!button) {
      button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.addEventListener('click', renderPanel);
      document.body.appendChild(button);
    }
    updateButton();
  }

  installUiIntentCapture();

  const timer = setInterval(() => {
    mountButton();
    updateButton();
  }, 500);

  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton, { once: true });
  } else {
    mountButton();
  }
})();
