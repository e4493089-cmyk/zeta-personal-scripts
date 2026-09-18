// ==UserScript==
// @name         Zeta Deleted Plot API Recorder
// @namespace    zeta-personal-scripts
// @version      0.1.0
// @description  삭제된 제타 플롯의 fetch/XHR/Next.js 응답 흔적을 기록해 JSON으로 저장합니다.
// @match        https://zeta-ai.io/*
// @match        https://link.zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const STORAGE_KEY = 'zeta-deleted-plot-api-recorder-v1';
  const MAX_ENTRIES = 500;
  const MAX_BODY_CHARS = 2_000_000;

  const TARGETS = [
    'b9a1d653-e4f4-47e0-bc8c-df1203956bf8',
    '97094f6a-656b-49b7-a76a-75654c398b9e',
    '06b2fa6e-eec0-47c1-8e6e-b3df4785ee34',
    '차평화',
    '류원호',
    '린웨이',
    'Jennet_Shaina'
  ];

  const state = loadState();
  let saveTimer = 0;
  let panel;
  let countLabel;

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (parsed && Array.isArray(parsed.entries)) return parsed;
    } catch (_) {}
    return {
      createdAt: new Date().toISOString(),
      entries: []
    };
  }

  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (_) {
        if (state.entries.length > 30) {
          state.entries.splice(0, Math.ceil(state.entries.length / 3));
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          } catch (_) {}
        }
      }
      updateCount();
    }, 80);
  }

  function textMatchesTarget(value) {
    const text = String(value || '');
    return TARGETS.some(target => text.includes(target));
  }

  function urlLooksRelevant(value) {
    let url;
    try {
      url = new URL(String(value), location.href);
    } catch (_) {
      return false;
    }

    if (!/(^|\.)zeta-ai\.io$/i.test(url.hostname)) return false;

    const haystack = decodeURIComponent(url.href);
    return (
      textMatchesTarget(haystack) ||
      /\/plots?(?:\/|$)|chat-profile|share_id|profile/i.test(haystack)
    );
  }

  function redact(value) {
    let text = String(value ?? '');

    text = text
      .replace(/("(?:access|refresh|id)?_?token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
      .replace(/("(?:authorization|cookie|set-cookie)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
      .replace(/("email"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');

    if (text.length > MAX_BODY_CHARS) {
      text = text.slice(0, MAX_BODY_CHARS) + '\n[TRUNCATED]';
    }
    return text;
  }

  function addEntry(entry) {
    const normalized = {
      capturedAt: new Date().toISOString(),
      pageUrl: location.href,
      ...entry
    };

    const searchable = [
      normalized.url,
      normalized.body,
      normalized.content
    ].join('\n');

    if (
      normalized.kind !== 'navigation' &&
      normalized.kind !== 'error' &&
      !urlLooksRelevant(normalized.url || '') &&
      !textMatchesTarget(searchable)
    ) {
      return;
    }

    state.entries.push(normalized);
    if (state.entries.length > MAX_ENTRIES) {
      state.entries.splice(0, state.entries.length - MAX_ENTRIES);
    }
    saveState();
  }

  function safeHeaders(headers) {
    const kept = {};
    try {
      headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (
          lower === 'content-type' ||
          lower === 'content-length' ||
          lower === 'etag' ||
          lower === 'last-modified' ||
          lower === 'x-request-id'
        ) {
          kept[lower] = value;
        }
      });
    } catch (_) {}
    return kept;
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__zetaRecorderPatched) return;

    const originalFetch = window.fetch;
    const wrappedFetch = function (...args) {
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === 'string' ? input : input?.url;
      const method = init.method || input?.method || 'GET';

      return originalFetch.apply(this, args).then(response => {
        try {
          const clone = response.clone();
          clone.text().then(body => {
            addEntry({
              kind: 'fetch',
              method,
              url: new URL(url || response.url, location.href).href,
              status: response.status,
              ok: response.ok,
              responseHeaders: safeHeaders(response.headers),
              body: redact(body)
            });
          }).catch(error => {
            addEntry({
              kind: 'error',
              source: 'fetch-body',
              url: String(url || response.url || ''),
              message: String(error)
            });
          });
        } catch (error) {
          addEntry({
            kind: 'error',
            source: 'fetch-clone',
            url: String(url || response.url || ''),
            message: String(error)
          });
        }
        return response;
      });
    };

    Object.defineProperty(wrappedFetch, '__zetaRecorderPatched', { value: true });
    window.fetch = wrappedFetch;
  }

  function patchXHR() {
    const proto = window.XMLHttpRequest?.prototype;
    if (!proto || proto.open.__zetaRecorderPatched) return;

    const originalOpen = proto.open;
    const originalSend = proto.send;

    function wrappedOpen(method, url, ...rest) {
      this.__zetaRecorderMeta = {
        method: String(method || 'GET'),
        url: new URL(String(url), location.href).href
      };
      return originalOpen.call(this, method, url, ...rest);
    }

    Object.defineProperty(wrappedOpen, '__zetaRecorderPatched', { value: true });

    proto.open = wrappedOpen;
    proto.send = function (...args) {
      this.addEventListener('loadend', () => {
        const meta = this.__zetaRecorderMeta || {};
        let body = '';
        try {
          if (!this.responseType || this.responseType === 'text') {
            body = this.responseText || '';
          } else if (this.responseType === 'json') {
            body = JSON.stringify(this.response);
          }
        } catch (_) {}

        addEntry({
          kind: 'xhr',
          method: meta.method || 'GET',
          url: meta.url || this.responseURL || '',
          status: this.status,
          body: redact(body)
        });
      }, { once: true });

      return originalSend.apply(this, args);
    };
  }

  function observeResources() {
    if (!('PerformanceObserver' in window)) return;

    try {
      const observer = new PerformanceObserver(list => {
        list.getEntries().forEach(item => {
          if (urlLooksRelevant(item.name)) {
            addEntry({
              kind: 'resource',
              url: item.name,
              initiatorType: item.initiatorType,
              durationMs: Math.round(item.duration)
            });
          }
        });
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch (_) {}
  }

  function captureScript(script) {
    if (!(script instanceof HTMLScriptElement)) return;
    if (script.dataset.zetaRecorderCaptured === '1') return;

    const content = script.textContent || '';
    if (!content || !textMatchesTarget(content)) return;

    script.dataset.zetaRecorderCaptured = '1';
    addEntry({
      kind: 'next-script',
      scriptId: script.id || null,
      scriptType: script.type || null,
      content: redact(content)
    });
  }

  function observeNextData() {
    const scan = root => {
      if (root instanceof HTMLScriptElement) captureScript(root);
      root.querySelectorAll?.('script').forEach(captureScript);
    };

    if (document.documentElement) scan(document.documentElement);

    const observer = new MutationObserver(records => {
      records.forEach(record => {
        record.addedNodes.forEach(node => {
          if (node instanceof Element) scan(node);
        });
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function addNavigationEntry() {
    addEntry({
      kind: 'navigation',
      url: location.href,
      title: document.title || null,
      referrer: document.referrer || null
    });
  }

  function updateCount() {
    if (countLabel) countLabel.textContent = String(state.entries.length);
  }

  function downloadLog() {
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      createdAt: state.createdAt,
      currentPage: location.href,
      userAgent: navigator.userAgent,
      targets: TARGETS,
      entries: state.entries
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = 'zeta-deleted-plot-api-' + timestamp + '.json';
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function clearLog() {
    if (!confirm('기록된 API 로그를 전부 지울까요?')) return;
    state.entries.length = 0;
    state.createdAt = new Date().toISOString();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    saveState();
  }

  function makeButton(label, onClick, color) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = [
      'appearance:none',
      'border:0',
      'border-radius:999px',
      'padding:9px 12px',
      'font:600 12px/1.2 system-ui,sans-serif',
      'color:#191919',
      'background:' + color,
      'box-shadow:0 2px 8px rgba(0,0,0,.22)',
      'touch-action:manipulation'
    ].join(';');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function installPanel() {
    if (panel || !document.body) return;

    panel = document.createElement('div');
    panel.id = 'zeta-api-recorder-panel';
    panel.style.cssText = [
      'position:fixed',
      'right:10px',
      'bottom:76px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:6px',
      'padding:6px',
      'border-radius:999px',
      'background:rgba(25,25,25,.82)',
      'backdrop-filter:blur(8px)',
      '-webkit-backdrop-filter:blur(8px)'
    ].join(';');

    const save = makeButton('API 로그 저장', downloadLog, '#FEE500');
    countLabel = document.createElement('span');
    countLabel.style.cssText = 'min-width:20px;color:white;font:700 12px system-ui;text-align:center';
    const clear = makeButton('지우기', clearLog, '#E8EAEB');

    panel.append(save, countLabel, clear);
    document.body.appendChild(panel);
    updateCount();
  }

  patchFetch();
  patchXHR();
  observeResources();

  const startDomWork = () => {
    observeNextData();
    addNavigationEntry();
    installPanel();
  };

  if (document.documentElement) {
    observeNextData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDomWork, { once: true });
  } else {
    startDomWork();
  }

  window.addEventListener('pageshow', () => {
    addNavigationEntry();
    installPanel();
  });
})();
