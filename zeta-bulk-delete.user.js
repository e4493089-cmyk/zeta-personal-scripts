// ==UserScript==
// @name         Zeta 플롯 선택 삭제
// @namespace    zeta-personal-scripts
// @version      0.2.0
// @description  크리에이터 센터에 체크박스를 붙이고 선택한 플롯을 제타 기본 삭제 UI로 순서대로 삭제합니다.
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
  const selected = new Set();
  let deleting = false;

  const style = document.createElement('style');
  style.textContent = `
    .zbd-item{position:relative!important}
    .zbd-check-wrap{position:absolute;left:8px;top:8px;z-index:20;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:rgba(20,20,20,.82);box-shadow:0 1px 5px rgba(0,0,0,.25)}
    .zbd-check{width:18px;height:18px;margin:0;accent-color:#fee500;cursor:pointer}
    .zbd-toolbar{display:flex;align-items:center;gap:8px;margin-left:auto;padding-left:10px}
    .zbd-delete-btn,.zbd-clear-btn{border:0;border-radius:9px;padding:7px 10px;font:600 12px/1.2 system-ui,sans-serif;cursor:pointer;white-space:nowrap}
    .zbd-delete-btn{background:#f05252;color:#fff}.zbd-delete-btn:disabled{background:#3a3a3d;color:#8d8d91;cursor:not-allowed}
    .zbd-clear-btn{background:rgba(255,255,255,.08);color:inherit}.zbd-clear-btn:disabled{opacity:.4;cursor:not-allowed}
    .zbd-status{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:10px 14px;border-radius:10px;background:#1f1f21;color:#fff;font:600 13px/1.35 system-ui,sans-serif;box-shadow:0 5px 24px rgba(0,0,0,.38)}
  `;
  document.documentElement.appendChild(style);

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function textOf(el) {
    return String(el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function plotId(item) {
    const direct = item.getAttribute('data-plot-id');
    if (direct) return direct;
    const link = item.querySelector('a[href*="/plots/"]');
    const href = link?.href || '';
    const match = href.match(/\/plots\/([0-9a-f-]{20,})/i);
    return match?.[1] || href || '';
  }

  function findItem(id) {
    return Array.from(document.querySelectorAll(ITEM)).find(item => plotId(item) === id) || null;
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
    if (timeout) setTimeout(() => { if (box?.textContent === message) box.remove(); }, timeout);
  }

  function updateToolbar() {
    const button = document.querySelector('.zbd-delete-btn');
    const clear = document.querySelector('.zbd-clear-btn');
    if (button) {
      button.textContent = selected.size ? `${selected.size}개 선택 삭제` : '선택 삭제';
      button.disabled = deleting || selected.size === 0;
    }
    if (clear) clear.disabled = deleting || selected.size === 0;
  }

  function injectItem(item) {
    if (item.querySelector(':scope > .zbd-check-wrap')) return;
    const id = plotId(item);
    if (!id) return;

    item.classList.add('zbd-item');
    const wrap = document.createElement('label');
    wrap.className = 'zbd-check-wrap';
    wrap.title = '삭제할 플롯 선택';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'zbd-check';
    checkbox.checked = selected.has(id);
    checkbox.disabled = deleting;

    const stop = event => event.stopPropagation();
    wrap.addEventListener('click', stop);
    wrap.addEventListener('mousedown', stop);
    wrap.addEventListener('pointerdown', stop);

    checkbox.addEventListener('change', event => {
      event.stopPropagation();
      if (checkbox.checked) selected.add(id);
      else selected.delete(id);
      updateToolbar();
    });

    wrap.appendChild(checkbox);
    item.prepend(wrap);
  }

  function injectToolbar() {
    const header = document.querySelector(HEADER);
    if (!header || header.querySelector('.zbd-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'zbd-toolbar';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'zbd-clear-btn';
    clear.textContent = '선택 해제';
    clear.addEventListener('click', () => {
      if (deleting) return;
      selected.clear();
      document.querySelectorAll('.zbd-check').forEach(input => { input.checked = false; });
      updateToolbar();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'zbd-delete-btn';
    remove.textContent = '선택 삭제';
    remove.disabled = true;
    remove.addEventListener('click', startDelete);

    toolbar.append(clear, remove);
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.appendChild(toolbar);
    updateToolbar();
  }

  function refresh() {
    injectToolbar();
    document.querySelectorAll(ITEM).forEach(injectItem);
    document.querySelectorAll('.zbd-check').forEach(input => { input.disabled = deleting; });
  }

  function menuButton(item) {
    const buttons = Array.from(item.querySelectorAll('button')).filter(button =>
      visible(button) && !button.closest('.zbd-check-wrap') && !button.classList.contains('zbd-delete-btn')
    );

    const named = buttons.find(button =>
      /더보기|메뉴|more|option|설정/i.test(
        [button.getAttribute('aria-label'), button.getAttribute('title'), textOf(button)].filter(Boolean).join(' ')
      )
    );
    if (named) return named;

    const svgOnly = buttons.filter(button => !textOf(button) && button.querySelector('svg'));
    return svgOnly.at(-1) || buttons.at(-1) || null;
  }

  function findDeleteAction() {
    const candidates = Array.from(document.querySelectorAll('button,[role="menuitem"],[role="button"]'))
      .filter(el => visible(el) && !el.closest('.zbd-toolbar') && !el.closest('.zbd-check-wrap'));

    return candidates.find(el => textOf(el) === '삭제')
      || candidates.find(el => /^(플롯\s*)?삭제$/.test(textOf(el)))
      || candidates.find(el => /삭제/.test(textOf(el)));
  }

  function findConfirmDelete() {
    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"],[role="alertdialog"],[data-sentry-component*="Modal"],[data-sentry-component*="Dialog"],[data-sentry-source-file*="Modal"],[data-sentry-source-file*="Dialog"]'
    )).filter(visible);

    for (const dialog of dialogs.reverse()) {
      if (!/삭제/.test(textOf(dialog))) continue;
      const buttons = Array.from(dialog.querySelectorAll('button,[role="button"]')).filter(visible);
      const exact = buttons.find(button => textOf(button) === '삭제');
      if (exact) return exact;
      const danger = buttons.find(button => /삭제|확인/.test(textOf(button)) && !/취소/.test(textOf(button)));
      if (danger) return danger;
    }
    return null;
  }

  async function waitFor(fn, timeout = 2500, interval = 60) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = fn();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  async function deleteOne(id) {
    const item = findItem(id);
    if (!item) return { ok: false, reason: '화면에서 플롯 카드를 찾지 못함' };

    const menu = menuButton(item);
    if (!menu) return { ok: false, reason: '플롯 메뉴 버튼을 찾지 못함' };

    menu.click();

    const action = await waitFor(findDeleteAction);
    if (!action) {
      document.body.click();
      return { ok: false, reason: '삭제 메뉴를 찾지 못함' };
    }

    action.click();

    const confirm = await waitFor(findConfirmDelete, 1800);
    if (confirm) {
      confirm.click();
    }

    const removed = await waitFor(() => !findItem(id), 4000, 100);
    if (!removed) {
      // 삭제 후 목록 갱신이 늦는 경우도 있어서 한 번 더 기다린다.
      await sleep(700);
    }
    return { ok: true };
  }

  async function startDelete() {
    if (deleting || !selected.size) return;

    const count = selected.size;
    if (!window.confirm(`선택한 ${count}개 플롯을 삭제할까요?\n제타의 기본 삭제 기능을 순서대로 실행합니다.`)) return;

    deleting = true;
    refresh();
    updateToolbar();

    const ids = [...selected];
    const failures = [];

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      setStatus(`${i + 1} / ${ids.length} 삭제 중…`);

      try {
        const result = await deleteOne(id);
        if (result.ok) selected.delete(id);
        else failures.push({ id, reason: result.reason });
      } catch (error) {
        failures.push({ id, reason: error?.message || '알 수 없는 오류' });
      }

      await sleep(250);
      refresh();
    }

    deleting = false;
    refresh();
    updateToolbar();

    if (failures.length) {
      setStatus(`${ids.length - failures.length}개 삭제 완료 · ${failures.length}개 실패`, 5000);
      console.warn('[Zeta 선택 삭제] 실패 항목', failures);
    } else {
      setStatus(`${ids.length}개 삭제 완료`, 3000);
    }
  }

  refresh();

  let timer = 0;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 80);
  }).observe(document.body, { childList: true, subtree: true });
})();
