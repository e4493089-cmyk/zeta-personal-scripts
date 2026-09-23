// ==UserScript==
// @name         Zeta 플롯 선택 삭제
// @namespace    zeta-personal-scripts
// @version      0.3.1
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
    // Creator Center 점 3개 메뉴의 실제 삭제 버튼은 id="delete".
    const nativeDelete = Array.from(document.querySelectorAll('#portal-container button#delete, button#delete'))
      .find(button => visible(button));
    if (nativeDelete) return nativeDelete;

    const candidates = Array.from(document.querySelectorAll('button,[role="menuitem"],[role="button"]'))
      .filter(el => visible(el) && !el.closest('.zbd-toolbar') && !el.closest('.zbd-check-wrap'));

    return candidates.find(el => textOf(el) === '삭제')
      || candidates.find(el => /^(플롯\s*)?삭제$/.test(textOf(el)))
      || candidates.find(el => /삭제/.test(textOf(el)));
  }

  function findPopupDeleteButton() {
    // 실제 Creator Center 삭제 확인 팝업:
    // data-sentry-component="Popup"
    // 제목: "플롯을 영구 삭제하시겠어요?"
    // 본문: "삭제된 플롯과 플롯 정보는 복구할 수 없어요"
    const popups = Array.from(document.querySelectorAll('[data-sentry-component="Popup"]'));

    for (const popup of popups.reverse()) {
      const title = textOf(popup.querySelector('h1,h2,h3,h4,h5,h6'));
      const body = textOf(popup.querySelector('p'));

      if (title !== '플롯을 영구 삭제하시겠어요?') continue;
      if (body !== '삭제된 플롯과 플롯 정보는 복구할 수 없어요') continue;

      const buttons = Array.from(popup.querySelectorAll('button'));
      const cancel = buttons.find(button => textOf(button) === '취소');
      const remove = buttons.find(button => textOf(button) === '삭제');

      if (cancel && remove) return remove;
    }

    return null;
  }

  function waitAndClickDeletePopup(timeout = 5000) {
    return new Promise(resolve => {
      let done = false;

      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(result);
      };

      const tryClick = () => {
        const button = findPopupDeleteButton();
        if (!button) return false;

        // React 버튼도 확실히 먹도록 포인터/마우스 이벤트 후 click.
        try { button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } catch (_) {}
        try { button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (_) {}
        try { button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (_) {}
        button.click();
        finish(true);
        return true;
      };

      const observer = new MutationObserver(tryClick);
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => finish(false), timeout);

      // 팝업이 이미 그려진 직후 observer가 붙는 경우 대비.
      tryClick();
    });
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

    const action = await waitFor(findDeleteAction, 2500, 50);
    if (!action) {
      document.body.click();
      return { ok: false, reason: '삭제 메뉴를 찾지 못함' };
    }

    // 먼저 팝업 감시를 시작한 뒤 제타 기본 삭제를 누른다.
    // 팝업이 생성되는 순간 안의 '삭제'를 매크로가 자동 클릭한다.
    const popupMacro = waitAndClickDeletePopup(5000);
    action.click();

    const clicked = await popupMacro;
    if (!clicked) {
      return { ok: false, reason: '삭제 확인 팝업을 감지하지 못함' };
    }

    const removed = await waitFor(() => !findItem(id), 7000, 100);
    if (!removed) {
      return { ok: false, reason: '확인 클릭 후에도 플롯이 삭제되지 않음' };
    }

    return { ok: true };
  }

  async function startDelete() {
    if (deleting || !selected.size) return;

    const count = selected.size;

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
        if (result.ok) {
          selected.delete(id);
        } else {
          failures.push({ id, reason: result.reason });
          // 삭제가 실제로 완료되지 않았으면 다음 플롯으로 건너뛰지 않는다.
          break;
        }
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
