// ==UserScript==
// @name         Zeta 플롯 선택 삭제
// @namespace    zeta-personal-scripts
// @version      0.5.0
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

  const style = document.createElement('style');
  style.textContent = `
    .zbd-item{position:relative!important}
    .zbd-check-wrap{position:absolute;left:8px;top:8px;z-index:20;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:rgba(20,20,20,.82);box-shadow:0 1px 5px rgba(0,0,0,.25)}
    .zbd-check{width:18px;height:18px;margin:0;accent-color:#fee500;cursor:pointer}
    .zbd-toolbar{display:flex;align-items:center;gap:8px;margin-left:auto;padding-left:10px}
    .zbd-delete-btn,.zbd-clear-btn{border:0;border-radius:9px;padding:7px 10px;font:600 12px/1.2 system-ui,sans-serif;cursor:pointer;white-space:nowrap}
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

  function checkedItems() {
    return Array.from(document.querySelectorAll('.zbd-check:checked'))
      .map(input => input.closest(ITEM))
      .filter(Boolean);
  }

  function updateToolbar() {
    const count = document.querySelectorAll('.zbd-check:checked').length;
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

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'zbd-check';

    for (const type of ['click', 'mousedown', 'pointerdown']) {
      wrap.addEventListener(type, event => event.stopPropagation());
    }

    checkbox.addEventListener('change', event => {
      event.stopPropagation();
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
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.appendChild(toolbar);
    updateToolbar();
  }

  function refresh() {
    injectToolbar();
    document.querySelectorAll(ITEM).forEach(injectItem);
    document.querySelectorAll('.zbd-check').forEach(input => {
      input.disabled = deleting;
    });
    updateToolbar();
  }

  function menuButton(item) {
    // 실제 카드 DOM의 오른쪽 마지막 버튼이 점 3개 메뉴 버튼이다.
    const buttons = Array.from(item.querySelectorAll('button'))
      .filter(button => !button.closest('.zbd-check-wrap'));

    return buttons.at(-1) || null;
  }

  function findMenuDeleteButton() {
    // 드롭다운 안에서 현재 보이는 "삭제" 버튼만 찾는다.
    const buttons = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"]'))
      .filter(el =>
        visible(el)
        && !el.closest('.zbd-toolbar')
        && !el.closest('.zbd-check-wrap')
        && textOf(el) === '삭제'
      );

    // 확인 팝업의 삭제 버튼은 여기서 제외.
    return buttons.find(button => !button.closest('[data-sentry-component="Popup"]')) || null;
  }

  function permanentDeletePopup() {
    return Array.from(document.querySelectorAll('[data-sentry-component="Popup"]'))
      .find(popup => {
        const title = textOf(popup.querySelector('h5,h4,h3,h2,h1,h6'));
        const body = textOf(popup.querySelector('p'));
        return title === '플롯을 영구 삭제하시겠어요?'
          && body === '삭제된 플롯과 플롯 정보는 복구할 수 없어요';
      }) || null;
  }

  function popupDeleteButton() {
    const popup = permanentDeletePopup();
    if (!popup) return null;

    const buttons = Array.from(popup.querySelectorAll('button'));
    if (buttons.length >= 2 && textOf(buttons[0]) === '취소' && textOf(buttons[1]) === '삭제') {
      return buttons[1];
    }
    return buttons.find(button => textOf(button) === '삭제') || null;
  }

  async function waitFor(fn, timeout = 3000, interval = 50) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = fn();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  async function deleteOne(item, index, total) {
    const id = plotId(item);
    const name = plotName(item);

    if (!item?.isConnected) {
      return { ok: false, reason: `${name}: 선택한 카드가 DOM에서 사라짐` };
    }

    const menu = menuButton(item);
    if (!menu) {
      return { ok: false, reason: `${name}: 점 3개 버튼을 못 찾음` };
    }

    setStatus(`${index}/${total} · ${name} · 점 3개 여는 중`);
    menu.click();

    const menuDelete = await waitFor(findMenuDeleteButton, 3000, 50);
    if (!menuDelete) {
      return { ok: false, reason: `${name}: 메뉴의 삭제 버튼을 못 찾음` };
    }

    setStatus(`${index}/${total} · ${name} · 삭제 팝업 여는 중`);
    menuDelete.click();

    const confirm = await waitFor(popupDeleteButton, 3000, 50);
    if (!confirm) {
      return { ok: false, reason: `${name}: 영구 삭제 확인 팝업을 못 찾음` };
    }

    setStatus(`${index}/${total} · ${name} · 확인 누르는 중`);
    confirm.click();

    const gone = await waitFor(() => {
      if (!id) return !item.isConnected;
      return !Array.from(document.querySelectorAll(ITEM)).some(candidate => plotId(candidate) === id);
    }, 8000, 100);

    if (!gone) {
      return { ok: false, reason: `${name}: 확인을 눌렀지만 카드가 사라지지 않음` };
    }

    return { ok: true, name };
  }

  async function startDelete() {
    if (deleting) return;

    // 중요: 저장해 둔 ID가 아니라 지금 실제로 체크된 DOM을 그 순간 다시 읽는다.
    const targets = checkedItems();
    if (!targets.length) {
      setStatus('체크된 플롯을 찾지 못했어요.', 4000);
      return;
    }

    deleting = true;
    refresh();

    let success = 0;
    let failure = null;

    for (let i = 0; i < targets.length; i += 1) {
      try {
        const result = await deleteOne(targets[i], i + 1, targets.length);
        if (!result.ok) {
          failure = result.reason;
          break;
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
