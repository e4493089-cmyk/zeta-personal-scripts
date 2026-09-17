// ==UserScript==
// @name         Zeta HTML Dump
// @namespace    zeta-html-dump
// @version      0.1.0
// @description  현재 Zeta 화면의 동적 DOM을 HTML 파일로 저장하는 임시 진단 도구
// @match        https://zeta-ai.io/*
// @updateURL    https://raw.githubusercontent.com/e4493089-cmyk/zeta-personal-scripts/main/zeta-html-dump.user.js
// @downloadURL  https://raw.githubusercontent.com/e4493089-cmyk/zeta-personal-scripts/main/zeta-html-dump.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const BUTTON_ID = 'zeta-html-dump-button';

  function syncFormState(source, clone) {
    const sourceFields = source.querySelectorAll('input, textarea, select');
    const cloneFields = clone.querySelectorAll('input, textarea, select');

    sourceFields.forEach((field, index) => {
      const copy = cloneFields[index];
      if (!copy) return;

      if (field instanceof HTMLInputElement) {
        copy.setAttribute('value', field.value);
        if (field.checked) copy.setAttribute('checked', '');
        else copy.removeAttribute('checked');
      } else if (field instanceof HTMLTextAreaElement) {
        copy.textContent = field.value;
      } else if (field instanceof HTMLSelectElement) {
        [...copy.options].forEach((option, optionIndex) => {
          if (optionIndex === field.selectedIndex) option.setAttribute('selected', '');
          else option.removeAttribute('selected');
        });
      }
    });
  }

  function saveHtml() {
    try {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelector('#' + BUTTON_ID)?.remove();
      clone.querySelectorAll('script').forEach(node => {
        if ((node.textContent || '').includes('zeta-html-dump-button')) node.remove();
      });
      syncFormState(document, clone);

      const meta = [
        '<!-- Zeta live DOM dump',
        'URL: ' + location.href,
        'Saved: ' + new Date().toISOString(),
        'UA: ' + navigator.userAgent,
        '-->'
      ].join('\n');
      const html = '<!doctype html>\n' + meta + '\n' + clone.outerHTML;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = url;
      link.download = 'zeta-live-dom-' + stamp + '.html';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);

      const button = document.getElementById(BUTTON_ID);
      if (button) {
        const old = button.textContent;
        button.textContent = '저장됨 ✓';
        setTimeout(() => { button.textContent = old; }, 1600);
      }
    } catch (error) {
      console.error('[Zeta HTML Dump]', error);
      alert('HTML 저장 실패: ' + error.message);
    }
  }

  function mount() {
    if (!document.body || document.getElementById(BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'HTML 저장';
    button.setAttribute('aria-label', '현재 화면 HTML 저장');
    Object.assign(button.style, {
      position: 'fixed',
      right: '12px',
      bottom: 'calc(88px + env(safe-area-inset-bottom))',
      zIndex: '2147483647',
      height: '42px',
      padding: '0 14px',
      border: '0',
      borderRadius: '999px',
      background: '#6d52ff',
      color: '#fff',
      fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      fontSize: '14px',
      fontWeight: '700',
      boxShadow: '0 5px 18px rgba(0,0,0,.3)'
    });
    button.addEventListener('click', saveHtml);
    document.body.appendChild(button);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  new MutationObserver(mount).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();