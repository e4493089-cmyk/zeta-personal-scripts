// ==UserScript==
// @name         Zeta 플롯 선택 삭제
// @namespace    zeta-personal-scripts
// @version      0.6.1
// @description  크리에이터 센터에서 체크한 플롯을 제타 기본 삭제 UI로 순서대로 삭제합니다.
// @match        https://zeta-ai.io/*/creator-center*
// @updateURL    https://raw.githubusercontent.com/e4493089-cmyk/zeta-personal-scripts/main/zeta-bulk-delete.user.js
// @downloadURL  https://raw.githubusercontent.com/e4493089-cmyk/zeta-personal-scripts/main/zeta-bulk-delete.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.top !== window.self || window.__zetaBulkDeleteLoaded) return;
  window.__zetaBulkDeleteLoaded = true;

  const ITEM = '[data-sentry-component="CreatorCenterMyPlotListItem"]';
  const HEADER = '[data-sentry-component="CreatorCenterMyPlotListHeader"]';
  let deleting = false;
  const selectedIds = new Set();
  const selectedNames = new Map();

  const W = window;
  const API = 'https://api.zeta-ai.io';
  let auth = '';
  let clientVersion = '';
  let nativeVersion = '';
  let userLanguage = 'KOREAN';
  let deviceType = 'web';
  let clientType = 'web';

  function captureHeader(key, value) {
    const k = String(key || '').toLowerCase();
    const v = String(value || '');
    if (!v) return;
    if (k === 'authorization') auth = v;
    else if (k === 'x-client-version') clientVersion = v;
    else if (k === 'x-client-native-version') nativeVersion = v;
    else if (k === 'x-user-language') userLanguage = v;
    else if (k === 'x-device-type') deviceType = v;
    else if (k === 'x-client-type') clientType = v;
  }

  // 제타가 원래 보내는 API 요청에서 인증/클라이언트 헤더를 가로챈다.
  try {
    const proto = W.XMLHttpRequest.prototype;
    const originalSetRequestHeader = proto.setRequestHeader;
    proto.setRequestHeader = function(key, value) {
      try { captureHeader(key, value); } catch (_) {}
      return originalSetRequestHeader.call(this, key, value);
    };
  } catch (_) {}

  try {
    const originalFetch = W.fetch;
    W.fetch = function(input, init = {}) {
      try {
        const headers = init && init.headers;
        if (headers instanceof Headers) headers.forEach((v, k) => captureHeader(k, v));
        else if (Array.isArray(headers)) headers.forEach(([k, v]) => captureHeader(k, v));
        else if (headers && typeof headers === 'object') {
          Object.entries(headers).forEach(([k, v]) => captureHeader(k, v));
        }
      } catch (_) {}
      return originalFetch.apply(this, arguments);
    };
  } catch (_) {}

  function wakeZetaAuth() {
    try {
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    } catch (_) {}
  }

  function apiHeaders() {
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-Client-Type': clientType || 'web',
      'X-User-Language': userLanguage || 'KOREAN',
      'X-Device-Type': deviceType || 'web'
    };
    if (clientVersion) headers['X-Client-Version'] = clientVersion;
    if (nativeVersion) headers['X-Client-Native-Version'] = nativeVersion;
    if (auth) headers['Authorization'] = auth;
    return headers;
  }

  function apiRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      const xhr = new W.XMLHttpRequest();
      xhr.open(method, url, true);
      for (const [key, value] of Object.entries(apiHeaders())) {
        try { xhr.setRequestHeader(key, value); } catch (_) {}
      }
      xhr.onload = () => {
        let data = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; }
        catch (_) { data = xhr.responseText; }

        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(`HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('네트워크 오류'));
      xhr.send(JSON.stringify(body));
    });
  }

  async function ensureAuth(timeout = 4000) {
    if (auth) return true;
    wakeZetaAuth();
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (auth) return true;
      await sleep(100);
    }
    return false;
  }

  const style = document.createElement('style');
  style.textContent = `
    .zbd-item{position:relative!important}
    .zbd-check-wrap{position:absolute;left:8px;top:8px;z-index:20;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:rgba(20,20,20,.82);box-shadow:0 1px 5px rgba(0,0,0,.25)}
    .zbd-check{width:18px;height:18px;margin:0;accent-color:#fee500;cursor:pointer}
    .zbd-toolbar{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(18px,calc(env(safe-area-inset-bottom) + 12px));z-index:2147483600;display:flex;align-items:center;gap:8px;padding:8px;border:1px solid rgba(255,255,255,.10);border-radius:14px;background:rgba(28,28,31,.94);box-shadow:0 8px 30px rgba(0,0,0,.38);backdrop-filter:blur(10px)}
    .zbd-delete-btn,.zbd-clear-btn{border:0;border-radius:9px;padding:9px 12px;font:600 12px/1.2 system-ui,sans-serif;cursor:pointer;white-space:nowrap}
    .zbd-delete-btn{background:#f05252;color:#fff}.zbd-delete-btn:disabled{background:#3a3a3d;color:#8d8d91;cursor:not-allowed}
    .zbd-clear-btn{background:rgba(255,255,255,.08);color:inherit}.zbd-clear-btn:disabled{opacity:.4;cursor:not-allowed}
    .zbd-status{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:min(90vw,560px);padding:10px 14px;border-radius:10px;background:#1f1f21;color:#fff;font:600 13px/1.35 system-ui,sans-serif;box-shadow:0 5px 24px rgba(0,0,0,.38);text-align:center}
  `;
  document.documentElement.appendChild(style);

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function textOf(el) {
    return String(el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function plotId(item) {
    const link = item?.querySelector('a[href*="/plots/"]');
    const href = link?.href || '';
    return href.match(/\/plots\/([0-9a-f-]{20,})/i)?.[1] || '';
  }

  function plotName(item) {
    return textOf(
      item?.querySelector('[data-zrm-original-title]')
      || item?.querySelector('.line-clamp-1')
      || item?.querySelector('img')
    ) || item?.querySelector('img')?.alt || plotId(item) || '플롯';
  }

  function setStatus(message, timeout = 0) {
    let box = document.querySelector('.zbd-status');
    if (!message) {
      box?.remove();
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'zbd-status';
      document.body.appendChild(box);
    }
    box.textContent = message;
    if (timeout) {
      setTimeout(() => {
        if (box?.textContent === message) box.remove();
      }, timeout);
    }
  }

  function selectedTargets() {
    // API 삭제는 DOM이 필요 없다.
    // 가상 스크롤로 화면 밖 카드가 DOM에서 사라져도 선택한 ID 전체를 그대로 처리한다.
    return [...selectedIds].map(id => ({
      id,
      name: selectedNames.get(id) || id
    }));
  }

  function updateToolbar() {
    const count = selectedIds.size;
    const remove = document.querySelector('.zbd-delete-btn');
    const clear = document.querySelector('.zbd-clear-btn');

    if (remove) {
      remove.textContent = count ? `${count}개 선택 삭제` : '선택 삭제';
      remove.disabled = deleting || count === 0;
    }
    if (clear) clear.disabled = deleting || count === 0;
  }

  function injectItem(item) {
    if (item.querySelector(':scope > .zbd-check-wrap')) return;

    item.classList.add('zbd-item');

    const wrap = document.createElement('label');
    wrap.className = 'zbd-check-wrap';
    wrap.title = '삭제할 플롯 선택';

    const id = plotId(item);
    if (!id) return;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'zbd-check';
    checkbox.checked = selectedIds.has(id);

    for (const type of ['click', 'mousedown', 'pointerdown']) {
      wrap.addEventListener(type, event => event.stopPropagation());
    }

    checkbox.addEventListener('change', event => {
      event.stopPropagation();
      if (checkbox.checked) {
        selectedIds.add(id);
        selectedNames.set(id, plotName(item));
      } else {
        selectedIds.delete(id);
        selectedNames.delete(id);
      }
      updateToolbar();
    });

    wrap.appendChild(checkbox);
    item.prepend(wrap);
  }

  function injectToolbar() {
    if (document.querySelector('.zbd-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'zbd-toolbar';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'zbd-clear-btn';
    clear.textContent = '선택 해제';
    clear.addEventListener('click', () => {
      if (deleting) return;
      selectedIds.clear();
      selectedNames.clear();
      document.querySelectorAll('.zbd-check:checked').forEach(input => {
        input.checked = false;
      });
      updateToolbar();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'zbd-delete-btn';
    remove.textContent = '선택 삭제';
    remove.disabled = true;
    remove.addEventListener('click', startDelete);

    toolbar.append(clear, remove);
    document.body.appendChild(toolbar);
    updateToolbar();
  }

  function refresh() {
    injectToolbar();
    document.querySelectorAll(ITEM).forEach(injectItem);
    document.querySelectorAll(ITEM).forEach(item => {
      const id = plotId(item);
      const input = item.querySelector(':scope > .zbd-check-wrap .zbd-check');
      if (!input || !id) return;
      input.checked = selectedIds.has(id);
      input.disabled = deleting;
    });
    updateToolbar();
  }

  async function deleteOne(target, index, total) {
    const id = target?.id || '';
    const name = target?.name || id || '플롯';

    if (!id) {
      return { ok: false, reason: `${name}: 플롯 ID를 찾지 못함` };
    }

    setStatus(`${index}/${total} · ${name} · 삭제 중`);

    try {
      const result = await apiRequest(
        'PATCH',
        `${API}/v1/plots/${encodeURIComponent(id)}/status`,
        { status: 'DELETE' }
      );

      if (result?.status === 'DELETED' || result?.id === id) {
        // 현재 화면에 같은 카드가 떠 있으면 즉시 제거. 화면 밖이어도 API 삭제는 이미 완료됨.
        const visibleItem = Array.from(document.querySelectorAll(ITEM))
          .find(item => plotId(item) === id);
        visibleItem?.remove();

        return { ok: true, name, id };
      }

      return { ok: false, reason: `${name}: 삭제 응답을 확인하지 못함` };
    } catch (error) {
      return { ok: false, reason: `${name}: ${error?.message || '삭제 요청 실패'}` };
    }
  }

  async function startDelete() {
    if (deleting) return;

    // 화면에 보이는 카드만이 아니라 지금까지 체크해 둔 ID 전체를 삭제한다.
    const targets = selectedTargets();
    if (!targets.length) {
      setStatus('체크된 플롯을 찾지 못했어요.', 4000);
      return;
    }

    deleting = true;
    refresh();

    setStatus('제타 인증 확인 중…');
    const ready = await ensureAuth();
    if (!ready) {
      deleting = false;
      refresh();
      setStatus('제타 인증 헤더를 잡지 못했어요. 페이지에서 탭 하나 눌렀다가 다시 시도해 주세요.', 8000);
      return;
    }

    let success = 0;
    let failure = null;

    for (let i = 0; i < targets.length; i += 1) {
      try {
        const result = await deleteOne(targets[i], i + 1, targets.length);
        if (!result.ok) {
          failure = result.reason;
          break;
        }
        if (result.id) {
          selectedIds.delete(result.id);
          selectedNames.delete(result.id);
        }
        success += 1;
        await sleep(350);
      } catch (error) {
        failure = `예외: ${error?.message || String(error)}`;
        console.error('[Zeta 선택 삭제]', error);
        break;
      }
    }

    deleting = false;
    refresh();

    if (failure) {
      setStatus(`${success}개 삭제 완료 · 실패: ${failure}`, 10000);
    } else {
      setStatus(`${success}개 삭제 완료`, 4000);
    }
  }

  refresh();

  let refreshTimer = 0;
  new MutationObserver(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 80);
  }).observe(document.body, { childList: true, subtree: true });
})();
