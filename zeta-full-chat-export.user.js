// ==UserScript==
// @name         Zeta Full Chat Export
// @namespace    zeta-personal-tools
// @version      0.1.6
// @description  로드되지 않은 이전 메시지까지 거슬러 올라가 Zeta 대화 전체를 요약용 Markdown으로 저장합니다.
// @match        https://zeta-ai.io/*
// @updateURL    https://raw.githubusercontent.com/e4493089-cmyk/zeta-userscripts/main/zeta-full-chat-export.user.js
// @downloadURL  https://raw.githubusercontent.com/e4493089-cmyk/zeta-userscripts/main/zeta-full-chat-export.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const APP = 'zeta-full-chat-export';
  const BUTTON_ID = APP + '-button';
  const PANEL_ID = APP + '-panel';
  const STYLE_ID = APP + '-style';
  const MESSAGE_SELECTOR = '[data-sentry-component="BodyView"][id^="message-"]';
  const CHAT_SELECTOR = '[role="log"][aria-label="Chat messages"]';

  let running = false;
  let cancelled = false;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = value => String(value || '')
    .replace(/\u200b/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function safeFileName(value) {
    return clean(value || 'zeta-chat')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 80) || 'zeta-chat';
  }

  function findChatLog() {
    return document.querySelector(CHAT_SELECTOR);
  }

  function visibleChatPage() {
    const log = findChatLog();
    return !!(log && log.getBoundingClientRect().height > 0);
  }

  function roleOf(body) {
    if (body.querySelector('[data-sentry-component="RightTextContent"]')) return 'user';
    if (body.querySelector('[data-sentry-component="LeftTextContent"]')) return 'assistant';
    return 'narrator';
  }

  function pushPart(parts, type, text) {
    const value = clean(text);
    if (!value) return;

    const previous = parts[parts.length - 1];
    if (previous?.type === type) {
      previous.text = clean(previous.text + '\n\n' + value);
    } else {
      parts.push({ type, text: value });
    }
  }

  function extractParts(body) {
    const parts = [];
    const sections = body.querySelectorAll([
      '[data-sentry-component="NarratorBubble"]',
      '[data-sentry-component="LeftTextContent"]',
      '[data-sentry-component="RightTextContent"]'
    ].join(','));

    sections.forEach(section => {
      const forcedNarration = section.matches('[data-sentry-component="NarratorBubble"]');
      const paragraphs = Array.from(section.querySelectorAll('.chat p'));

      if (paragraphs.length) {
        paragraphs.forEach(paragraph => {
          const text = paragraph.innerText || paragraph.textContent || '';
          const meaningfulNodes = Array.from(paragraph.childNodes).filter(node =>
            node.nodeType === Node.ELEMENT_NODE ||
            (node.nodeType === Node.TEXT_NODE && clean(node.textContent))
          );
          const narration = forcedNarration || (
            meaningfulNodes.length > 0 &&
            meaningfulNodes.every(node =>
              node.nodeType === Node.ELEMENT_NODE &&
              node.matches('em, i')
            )
          );
          pushPart(parts, narration ? 'narration' : 'message', text);
        });
        return;
      }

      const chats = Array.from(section.querySelectorAll('.chat'));
      let text = clean(chats.length
        ? chats.map(node => node.innerText || node.textContent || '').join('\n\n')
        : section.innerText || section.textContent || '');

      const label = clean(section.querySelector('.caption1')?.innerText || '');
      if (label && text.startsWith(label)) text = clean(text.slice(label.length));
      pushPart(parts, forcedNarration ? 'narration' : 'message', text);
    });

    if (!parts.length) {
      const text = clean(body.innerText || body.textContent || '');
      pushPart(parts, 'message', text);
    }
    return parts;
  }

  function extractImages(body) {
    const ignored = [
      '/profile-image/',
      '/user-plot-chat-profile-image/',
      '/icon/',
      'zeta_watermark'
    ];

    return Array.from(body.querySelectorAll('img[src]'))
      .map(img => ({ src: img.currentSrc || img.src, alt: clean(img.alt) }))
      .filter(item => item.src && !ignored.some(token => item.src.includes(token)))
      .filter((item, index, all) => all.findIndex(x => x.src === item.src) === index);
  }

  function readMessage(body) {
    return {
      id: body.id,
      role: roleOf(body),
      parts: extractParts(body),
      images: extractImages(body)
    };
  }

  function messageNumber(id) {
    const match = String(id || '').match(/^message-MESSAGE-(\d+)-/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function mergeOrder(existing, incoming) {
    const fresh = incoming.filter(Boolean);
    if (!existing.length) return fresh.slice();
    if (!fresh.length) return existing;

    const max = Math.min(existing.length, fresh.length);
    for (let size = max; size > 0; size -= 1) {
      const incomingSuffix = fresh.slice(fresh.length - size).join('\n');
      const existingPrefix = existing.slice(0, size).join('\n');
      if (incomingSuffix === existingPrefix) {
        return [...fresh.slice(0, fresh.length - size), ...existing];
      }
      const existingSuffix = existing.slice(existing.length - size).join('\n');
      const incomingPrefix = fresh.slice(0, size).join('\n');
      if (existingSuffix === incomingPrefix) {
        return [...existing, ...fresh.slice(size)];
      }
    }

    const firstShared = fresh.findIndex(id => existing.includes(id));
    if (firstShared >= 0) {
      const anchor = existing.indexOf(fresh[firstShared]);
      const before = fresh.slice(0, firstShared).filter(id => !existing.includes(id));
      const after = fresh.slice(firstShared + 1).filter(id => !existing.includes(id));
      return [
        ...existing.slice(0, anchor),
        ...before,
        ...existing.slice(anchor),
        ...after
      ];
    }

    return [...fresh, ...existing];
  }

  function capture(messages, order) {
    const bodies = Array.from(document.querySelectorAll(MESSAGE_SELECTOR));
    const log = findChatLog();

    /* Zeta 채팅은 column-reverse라 DOM 순서가 최신→과거다. 저장 순서는 과거→최신으로 맞춘다. */
    if (log && getComputedStyle(log).flexDirection.includes('reverse')) {
      bodies.reverse();
    }

    const ids = [];
    bodies.forEach(body => {
      if (!body.id) return;
      ids.push(body.id);
      messages.set(body.id, readMessage(body));
    });
    return mergeOrder(order, ids);
  }

  function titleFromPage() {
    const candidates = [
      '[data-testid="chat-header-profile"]',
      'header h1',
      'main h1'
    ];
    for (const selector of candidates) {
      const text = clean(document.querySelector(selector)?.innerText || '');
      if (text) return text;
    }
    return clean(document.title.replace(/\s*[-–|]\s*제타.*$/i, '')) || 'Zeta 대화';
  }

  function updatePanel(status, detail = '') {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.querySelector('.zfce-status').textContent = status;
    panel.querySelector('.zfce-detail').textContent = detail;
  }

  function download(name, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function markdownText(value) {
    return clean(value)
      .replace(/^---+$/gm, '\\---')
      .replace(/^#{1,6}\\s/gm, match => '\\' + match);
  }

  function buildMarkdown(meta, items) {
    const lines = [
      '# ' + markdownText(meta.title),
      '',
      '- 메시지 수: ' + items.length,
      '- 저장 시각: ' + meta.exportedAt,
      '- 원본 주소: ' + meta.url,
      '',
      '---',
      ''
    ];

    items.forEach((item, index) => {
      const label = item.role === 'user' ? '나' : item.role === 'assistant' ? '캐릭터' : '서술';
      lines.push('## ' + (index + 1) + '. ' + label, '');

      item.parts.forEach(part => {
        lines.push(part.type === 'narration' ? '[지문]' : '[대사]');
        lines.push(markdownText(part.text), '');
      });

      item.images.forEach((image, imageIndex) => {
        lines.push('[이미지 ' + (imageIndex + 1) + '] ' + image.src, '');
      });

      lines.push('---', '');
    });

    return lines.join('\n').trim() + '\n';
  }

  async function exportAll() {
    if (running) return;
    const log = findChatLog();
    if (!log) {
      alert('Zeta 채팅방 안에서 실행해줘.');
      return;
    }

    running = true;
    cancelled = false;
    document.getElementById(PANEL_ID).hidden = false;
    const messages = new Map();
    let order = [];
    let stableAtEdge = 0;
    let previousCount = 0;

    try {
      const reverse = getComputedStyle(log).flexDirection.includes('reverse');

      /* 실행 위치와 관계없이 최신 메시지를 먼저 기준점으로 잡는다. */
      log.scrollTo({
        top: reverse ? 0 : log.scrollHeight,
        behavior: 'auto'
      });
      await wait(180);
      order = capture(messages, order);
      const latestAnchorId = order[order.length - 1] || '';
      updatePanel('이전 대화를 불러오는 중…', `${messages.size}개 수집`);

      previousCount = messages.size;

      while (!cancelled) {
        const beforeHeight = log.scrollHeight;
        const target = reverse ? -(log.scrollHeight + log.clientHeight) : 0;
        log.scrollTo({ top: target, behavior: 'auto' });

        /* 끝으로 바로 점프한 뒤 새 과거 묶음이 붙을 최소 시간만 기다린다. */
        await wait(320);
        order = capture(messages, order);

        const resized = Math.abs(log.scrollHeight - beforeHeight) > 2;
        const grew = messages.size > previousCount;
        previousCount = messages.size;
        stableAtEdge = (!resized && !grew) ? stableAtEdge + 1 : 0;

        updatePanel('이전 대화를 빠르게 불러오는 중…', `${messages.size}개 수집 · 맨 처음 확인 ${stableAtEdge}/8`);
        if (stableAtEdge >= 8) break;

        /* 네트워크 응답이 아직 안 왔을 때만 조금 더 양보한다. */
        await wait(grew || resized ? 60 : 380);
      }

      if (cancelled) throw new DOMException('Cancelled', 'AbortError');

      /*
       * 맨 처음 대화에서 최신 대화까지 다시 훑는다.
       * 한 화면보다 조금 작게 이동해 가상 스크롤 사이의 메시지도 빠뜨리지 않는다.
       */
      let chronologicalOrder = [];
      let stableAtBottom = 0;
      let stalledAwayFromLatest = 0;
      chronologicalOrder = capture(messages, chronologicalOrder);
      updatePanel('처음부터 순서대로 확인 중…', `${messages.size}개 수집`);

      while (!cancelled) {
        const beforeTop = log.scrollTop;
        const beforeCount = messages.size;
        const step = Math.max(320, log.clientHeight * 0.82);

        log.scrollBy({ top: step, behavior: 'auto' });
        await wait(90);
        chronologicalOrder = capture(messages, chronologicalOrder);

        const moved = Math.abs(log.scrollTop - beforeTop) > 2;
        const grew = messages.size > beforeCount;
        const atBottom = reverse
          ? Math.abs(log.scrollTop) < 3
          : log.scrollTop + log.clientHeight >= log.scrollHeight - 3;
        const latestVisible = !latestAnchorId || !!document.getElementById(latestAnchorId);

        /*
         * 가상 스크롤이 중간에서 scrollTop을 0으로 재설정할 수 있다.
         * 실제 최신 메시지 기준점까지 다시 보였을 때만 완료로 판정한다.
         */
        stableAtBottom = atBottom && latestVisible && !moved && !grew
          ? stableAtBottom + 1
          : 0;
        stalledAwayFromLatest = atBottom && !latestVisible && !moved
          ? stalledAwayFromLatest + 1
          : 0;

        updatePanel(
          '처음부터 순서대로 확인 중…',
          latestVisible
            ? `${messages.size}개 수집 · 끝 확인 ${stableAtBottom}/3`
            : `${messages.size}개 수집 · 최신 대화까지 계속 이동 중…`
        );

        if (stableAtBottom >= 3) break;

        if (stalledAwayFromLatest >= 3) {
          /* 경계에서 로딩이 멎으면 살짝 되짚었다가 다시 내려가 로딩을 재촉한다. */
          log.scrollBy({ top: reverse ? -160 : -160, behavior: 'auto' });
          await wait(100);
          log.scrollBy({ top: step + 160, behavior: 'auto' });
          await wait(420);
          chronologicalOrder = capture(messages, chronologicalOrder);
          stalledAwayFromLatest = 0;
        } else if (!moved) {
          await wait(atBottom ? 420 : 220);
        }
      }

      if (cancelled) throw new DOMException('Cancelled', 'AbortError');
      order = chronologicalOrder.length ? chronologicalOrder : capture(messages, order);
      /*
       * Zeta의 MESSAGE 번호는 오래된 메시지일수록 크다.
       * 가상 스크롤의 DOM 배치와 무관하게 번호 내림차순으로 과거→최신을 강제한다.
       */
      const orderIndex = new Map(order.map((id, index) => [id, index]));
      const items = Array.from(messages.values()).sort((a, b) => {
        const difference = messageNumber(b.id) - messageNumber(a.id);
        return difference || (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
      });
      const meta = {
        title: titleFromPage(),
        url: location.href,
        exportedAt: new Date().toLocaleString('ko-KR'),
        count: items.length
      };
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      download(`${safeFileName(meta.title)}-전체대화-${stamp}.md`, buildMarkdown(meta, items));
      updatePanel('저장 완료', `${items.length}개 메시지를 저장했어요.`);
      await wait(1200);
      document.getElementById(PANEL_ID).hidden = true;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('[Zeta Full Chat Export]', error);
        updatePanel('저장 실패', error?.message || String(error));
        await wait(2200);
      }
      document.getElementById(PANEL_ID).hidden = true;
    } finally {
      running = false;
      cancelled = false;
      document.querySelector('[data-testid="chat-scroll-to-bottom"]')?.click();
    }
  }

  function installUi() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `#${BUTTON_ID}{position:fixed;right:14px;bottom:142px;z-index:2147483643;border:0;border-radius:999px;padding:11px 15px;background:#6d48ff;color:#fff;font:800 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 5px 18px rgba(0,0,0,.24)}#${BUTTON_ID}[hidden]{display:none}#${PANEL_ID}{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.58);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#${PANEL_ID}[hidden]{display:none}#${PANEL_ID} .zfce-card{width:min(360px,100%);padding:20px;border-radius:17px;background:#fff;color:#263238;box-shadow:0 18px 50px rgba(0,0,0,.35);text-align:center}#${PANEL_ID} .zfce-status{font-weight:850;font-size:16px}#${PANEL_ID} .zfce-detail{margin:8px 0 15px;color:#78858c;font-size:12px}#${PANEL_ID} button{border:0;border-radius:10px;background:#eceff1;color:#45545c;padding:10px 18px;font-weight:800}`;
      document.head.appendChild(style);
    }

    if (!document.getElementById(BUTTON_ID)) {
      const button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.textContent = '대화 전체 저장';
      button.addEventListener('click', exportAll);
      document.body.appendChild(button);
    }

    if (!document.getElementById(PANEL_ID)) {
      const panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.hidden = true;
      panel.innerHTML = '<div class="zfce-card"><div class="zfce-status">준비 중…</div><div class="zfce-detail"></div><button type="button">취소</button></div>';
      panel.querySelector('button').addEventListener('click', () => { cancelled = true; });
      document.body.appendChild(panel);
    }

    document.getElementById(BUTTON_ID).hidden = !visibleChatPage();
  }

  const observer = new MutationObserver(() => {
    clearTimeout(observer.timer);
    observer.timer = setTimeout(installUi, 250);
  });

  installUi();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
