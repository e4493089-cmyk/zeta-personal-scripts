// ==UserScript==
// @name         Zeta Auto Chat (OpenRouter)
// @namespace    zeta-auto-chat-openrouter
// @version      0.2.7
// @description  OpenRouter로 다음 사용자 답장을 만들고 Zeta 채팅에 자동 전송합니다.
// @match        https://zeta-ai.io/*
// @updateURL    https://raw.githubusercontent.com/e4493089-cmyk/zeta-personal-scripts/main/zeta-auto-chat.user.js
// @downloadURL  https://raw.githubusercontent.com/e4493089-cmyk/zeta-personal-scripts/main/zeta-auto-chat.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const APP_ID = 'zeta-auto-chat';
  const PANEL_ID = APP_ID + '-panel';
  const WIDGET_ID = APP_ID + '-widget';
  const STYLE_ID = APP_ID + '-style';
  const SETTINGS_KEY = APP_ID + ':settings:v1';
  const DAILY_KEY = APP_ID + ':daily:v1';
  const DEFAULT_PROMPT = [
    '너는 역할극 채팅에서 사용자 역할을 맡는다.',
    '주어진 대화의 흐름, 사용자 말투, 관계와 감정선을 자연스럽게 이어서 다음 사용자 답장 하나만 작성한다.',
    '상대 캐릭터의 행동이나 대사를 대신 결정하지 않는다.',
    '해설, 분석, 따옴표, 답변 머리말 없이 실제로 전송할 내용만 출력한다.',
    '기본 언어는 한국어다.'
  ].join('\n');
  const HARD_ROLE_RULES = [
    '[절대 출력 규칙]',
    '너는 반드시 사용자 프로필의 인물만 연기한다.',
    '제타 캐릭터의 행동, 표정, 감정, 생각, 대사를 절대 대신 작성하지 않는다.',
    '사용자 자신의 행동, 표정, 상황 묘사, 속마음은 narration 항목으로 분류한다.',
    '사용자가 실제로 말하는 대사는 dialogue 항목으로 분류한다.',
    '출력에는 사용자 자신의 narration 항목을 최소 하나 이상 반드시 포함한다.',
    '모든 narration의 행동 주체, 감정 주체, 생각 주체는 오직 사용자 프로필의 인물이어야 한다.',
    '제타 캐릭터가 웃거나, 움직이거나, 말하거나, 생각하거나, 표정을 짓는 새 지문은 한 문장도 쓰지 않는다.',
    '나쁜 예: *그가 미소 지으며 사용자를 끌어안았다.*',
    '좋은 예: *나는 잠깐 그를 바라보다가 시선을 돌렸다.*',
    '별표 마크다운은 스크립트가 붙이므로 text 값에는 별표나 따옴표를 넣지 않는다.',
    '제타 캐릭터 시점의 서술을 이어 쓰지 말고, 그 말과 행동에 대한 사용자의 반응만 작성한다.',
    '직전 제타 캐릭터의 대사나 문장을 사용자 대사로 복사하거나 그대로 반복하지 않는다.',
    '해설이나 분석 없이 제타 입력창에 바로 전송할 사용자 답장만 출력한다.'
  ].join('\n');
  const PROFILE_RULES = [
    '[사용자 프로필 적용 규칙]',
    '사용자 프로필은 사용자 캐릭터의 성격과 말투를 정하는 최우선 기준이다.',
    '최근 대화의 분위기나 제타 캐릭터의 말투를 따라 하느라 사용자 프로필의 성격을 평범하게 바꾸지 않는다.',
    '매 답변마다 프로필에 적힌 핵심 성격, 감정 표현 방식, 말투 특징을 실제 행동과 대사에 드러낸다.',
    '프로필과 충돌하는 전형적인 반응이나 임의의 성격을 새로 만들지 않는다.',
    '프로필을 요약하거나 설명하지 말고 답변의 선택과 표현에만 반영한다.'
  ].join('\n');
  const STYLE_RULES = [
    '[문체와 행동 규칙]',
    '문체는 담백하고 자연스럽게 유지하며 감정을 장황하게 해설하지 않는다.',
    '지문은 구체적인 행동과 반응만 짧게 쓰고, 과장된 비유나 소설식 미사여구를 피한다.',
    '숨이 멎었다, 심장이 요동쳤다, 목덜미가 달아올랐다, 입가에 여유로운 웃음을 걸었다, 턱을 들었다, 손끝을 꼼지락거렸다는 식의 상투적인 신체 반응을 습관적으로 쓰지 않는다.',
    '능동성은 상황에 맞는 선택과 대답을 스스로 한다는 뜻이다. 매번 신체 접촉, 도발, 유혹, 우위 행동 또는 새로운 사건을 억지로 만들라는 뜻이 아니다.',
    '가만히 보기, 짧게 대답하기, 망설이기, 화제를 넘기기처럼 작은 반응이 자연스러운 장면에서는 그 정도만 표현한다.',
    '사용자 캐릭터의 행동은 프로필과 현재 상황에서 자연스럽게 나올 때만 작성한다.'
  ].join('\n');
  const INTERACTION_RULES = [
    '[상호작용 규칙]',
    '답변은 반드시 직전 제타 캐릭터의 핵심 대사나 행동을 알아듣고 직접 호응해야 한다.',
    '질문을 받으면 그 질문에 답하거나 답을 피하는 반응을 먼저 보이고, 제안·감정 표현·접촉에는 그에 맞는 수락·거절·감정·행동으로 반응한다.',
    '제타 캐릭터가 이미 한 말과 이미 일어난 행동은 답변에서 자연스럽게 언급하거나 그 대상으로 반응해도 된다.',
    '사용자 캐릭터가 제타 캐릭터에게 말을 걸거나, 바라보거나, 다가가거나, 손을 잡는 등 상호작용을 먼저 시도할 수 있다. 단, 그에 대한 제타 캐릭터의 다음 반응은 정하지 않는다.',
    '사용자 캐릭터 혼자 새로운 행동이나 독백만 이어가며 상대의 직전 발화를 무시하지 않는다.',
    '새로운 화제나 사건을 일방적으로 시작하기 전에 현재 주고받는 대화를 한 번 이상 이어받는다.'
  ].join('\n');
  const DEFAULTS = {
    apiKey: '',
    model: 'google/gemini-2.5-flash-lite',
    profile: '',
    prompt: DEFAULT_PROMPT,
    historyItems: 14,
    maxInputChars: 30000,
    maxOutputTokens: 500,
    temperature: 0.9,
    minDelay: 2,
    maxDelay: 5,
    settleSeconds: 3,
    sessionLimit: 0
  };

  let settings = loadSettings();
  let enabled = false;
  let busy = false;
  let sessionTurns = 0;
  let lastHandledFingerprint = '';
  let lastConversationFingerprint = '';
  let lastConversationChangeAt = Date.now();
  let checkTimer = 0;
  let abortController = null;
  let observer = null;

  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function loadSettings() {
    const saved = storageGet(SETTINGS_KEY, {});
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  }

  function saveSettings(next) {
    settings = { ...DEFAULTS, ...next };
    storageSet(SETTINGS_KEY, settings);
  }

  function todayKey() {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }

  function getDailyUsage() {
    const saved = storageGet(DAILY_KEY, {});
    if (!saved || saved.date !== todayKey()) return { date: todayKey(), count: 0 };
    return { date: saved.date, count: Number(saved.count) || 0 };
  }

  function incrementDailyUsage() {
    const usage = getDailyUsage();
    usage.count += 1;
    storageSet(DAILY_KEY, usage);
    return usage.count;
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u200b/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function isChatPage() {
    return !!document.querySelector('textarea[aria-label="내용 입력하기"]');
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function messageRole(el) {
    const component = el.getAttribute('data-sentry-component');
    if (component === 'RightTextContent') return 'user';
    return 'assistant';
  }

  function extractElementText(el) {
    const preferred = el.querySelector('.chat');
    const text = normalizeText((preferred || el).innerText || (preferred || el).textContent);
    return text
      .replace(/^\d{1,2}:\d{2}\s*(AM|PM)?\s*/i, '')
      .trim();
  }

  function collectConversation() {
    const selector = [
      '[data-sentry-component="LeftTextContent"]',
      '[data-sentry-component="RightTextContent"]',
      '[data-sentry-component="NarratorBubble"]'
    ].join(',');

    const raw = Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .map(el => ({ role: messageRole(el), text: extractElementText(el) }))
      .filter(item => item.text);

    const grouped = [];
    raw.forEach(item => {
      const prev = grouped[grouped.length - 1];
      if (prev && prev.role === item.role) {
        prev.text += '\n\n' + item.text;
      } else {
        grouped.push({ ...item });
      }
    });

    return grouped;
  }

  function trimConversation(items) {
    const count = clampNumber(settings.historyItems, 2, 50, DEFAULTS.historyItems);
    const budget = clampNumber(settings.maxInputChars, 2000, 100000, DEFAULTS.maxInputChars);
    const selected = items.slice(-count);
    let used = 0;
    const out = [];

    for (let i = selected.length - 1; i >= 0; i -= 1) {
      let text = selected[i].text;
      const remaining = budget - used;
      if (remaining <= 0) break;
      if (text.length > remaining) text = text.slice(text.length - remaining);
      out.unshift({ role: selected[i].role, content: text });
      used += text.length;
    }

    return out;
  }

  function conversationFingerprint(items) {
    const tail = items.slice(-4).map(x => x.role + ':' + x.text).join('\n');
    let hash = 2166136261;
    for (let i = 0; i < tail.length; i += 1) {
      hash ^= tail.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36) + ':' + tail.length;
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function hasPendingGeneration() {
    const textarea = document.querySelector('textarea[aria-label="내용 입력하기"]');
    if (!textarea || textarea.disabled) return true;

    const send = document.querySelector('button[data-testid="chat-send-button"]');
    const stopLike = send && /stop|중지/i.test(
      [send.getAttribute('aria-label'), send.getAttribute('title'), send.textContent].filter(Boolean).join(' ')
    );

    /* MessageLoadingIndicator는 유휴 상태에도 DOM에 남는 버전이 있어
       생성 여부 판정에 사용하지 않는다. 대화 내용 안정화 시간으로 대신 확인한다. */
    return !!stopLike;
  }

  function scheduleCheck(delay = 350) {
    clearTimeout(checkTimer);
    checkTimer = window.setTimeout(checkLoop, delay);
  }

  function noteConversationChange() {
    const items = collectConversation();
    const fp = conversationFingerprint(items);
    if (fp !== lastConversationFingerprint) {
      lastConversationFingerprint = fp;
      lastConversationChangeAt = Date.now();
    }
    return items;
  }

  async function checkLoop() {
    renderWidget();
    if (!enabled || busy || !isChatPage()) return;

    const items = noteConversationChange();
    const last = items[items.length - 1];
    if (!last) {
      setStatus('대화 인식 못함', 'on');
      renderWidget();
      return;
    }
    if (last.role !== 'assistant') {
      setStatus('제타 답변 대기', 'on');
      renderWidget();
      return;
    }
    if (hasPendingGeneration()) {
      setStatus('제타 생성 대기', 'on');
      renderWidget();
      scheduleCheck(800);
      return;
    }

    const stableMs = clampNumber(settings.settleSeconds, 1, 15, DEFAULTS.settleSeconds) * 1000;
    const elapsed = Date.now() - lastConversationChangeAt;
    if (elapsed < stableMs) {
      setStatus('답변 안정화 대기', 'on');
      renderWidget();
      scheduleCheck(stableMs - elapsed + 150);
      return;
    }

    const fp = conversationFingerprint(items);
    if (fp === lastHandledFingerprint) return;

    const sessionLimit = clampNumber(settings.sessionLimit, 0, 100000, DEFAULTS.sessionLimit);
    if (sessionLimit > 0 && sessionTurns >= sessionLimit) {
      stopAuto('세션 한도 도달');
      return;
    }

    await handleTurn(items, fp);
  }

  async function handleTurn(items, fingerprint) {
    busy = true;
    setStatus('답변 생성 중…', 'busy');
    abortController = new AbortController();

    try {
      const reply = await generateReply(trimConversation(items), abortController.signal);
      if (!enabled) return;
      if (!reply) throw new Error('빈 답변이 반환됐어요.');

      setStatus('전송 대기 중…', 'busy');
      const min = clampNumber(settings.minDelay, 0, 60, DEFAULTS.minDelay);
      const max = clampNumber(settings.maxDelay, min, 120, DEFAULTS.maxDelay);
      await wait((min + Math.random() * (max - min)) * 1000, abortController.signal);
      if (!enabled) return;

      const sent = await fillAndSend(reply, abortController.signal);
      if (!sent) throw new Error('입력창 또는 전송 버튼을 찾지 못했어요.');

      lastHandledFingerprint = fingerprint;
      sessionTurns += 1;
      incrementDailyUsage();
      setStatus('AI 답변 대기 중', 'on');
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      console.error('[Zeta Auto Chat]', error);
      stopAuto('오류로 정지');
      showToast(error && error.message ? error.message : String(error), true);
    } finally {
      busy = false;
      abortController = null;
      renderWidget();
      scheduleCheck(1000);
    }
  }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      const id = setTimeout(resolve, ms);
      if (!signal) return;
      signal.addEventListener('abort', () => {
        clearTimeout(id);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  function openRouterRequest(payload, signal) {
    const body = JSON.stringify(payload);
    const headers = {
      'Authorization': 'Bearer ' + settings.apiKey.trim(),
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://zeta-ai.io/',
      'X-Title': 'Zeta Auto Chat'
    };

    return fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers, body, signal
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || 'OpenRouter HTTP ' + response.status);
      return data;
    });
  }

  async function generateReply(history, signal) {
    if (!settings.apiKey.trim()) throw new Error('먼저 OpenRouter API 키를 입력해줘.');

    const profile = normalizeText(settings.profile).slice(0, 20000);
    const systemPrompt = [
      settings.prompt.trim() || DEFAULT_PROMPT,
      '\n' + HARD_ROLE_RULES,
      profile ? '\n[최우선 사용자 프로필]\n' + profile : '',
      profile ? '\n' + PROFILE_RULES : '',
      '\n' + STYLE_RULES,
      '\n' + INTERACTION_RULES
    ].filter(Boolean).join('\n');

    /* API의 user/assistant 역할을 뒤집으면 가벼운 모델이 화자를 혼동할 수 있다.
       화자를 직접 표시한 대본으로 전달해 제타 캐릭터와 사용자 캐릭터를 분리한다. */
    const transcript = history.map((item, index) => {
      const speaker = item.role === 'user' ? '사용자 캐릭터' : '제타 캐릭터';
      return `[${index + 1}. ${speaker}]\n${item.content}`;
    }).join('\n\n');
    const transcriptPrompt = [
      '[대화 기록]',
      transcript,
      '',
      '[이번 출력 대상]',
      '위 기록에서 제타 캐릭터의 마지막 말과 행동에 반응하는 "사용자 캐릭터"의 다음 답장만 작성한다.',
      '제타 캐릭터의 다음 행동·표정·감정·생각·대사는 예측하거나 대신 쓰지 않는다.',
      '직전 제타 캐릭터의 핵심 발화를 무시하지 말고 이번 대사나 행동으로 분명하게 이어받는다.',
      profile ? '작성 전에 [최우선 사용자 프로필]의 핵심 성격과 말투 특징을 내부적으로 확인하고 이번 행동과 대사에 반드시 반영한다. 확인 과정은 출력하지 않는다.' : ''
    ].filter(Boolean).join('\n');

    const payload = {
      model: settings.model.trim() || DEFAULTS.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcriptPrompt }
      ],
      temperature: clampNumber(settings.temperature, 0, 2, DEFAULTS.temperature),
      max_tokens: clampNumber(settings.maxOutputTokens, 50, 4000, DEFAULTS.maxOutputTokens),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'zeta_user_reply',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              parts: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    actor: { type: 'string', enum: ['user_character'] },
                    type: { type: 'string', enum: ['narration', 'dialogue'] },
                    text: { type: 'string', minLength: 1 }
                  },
                  required: ['actor', 'type', 'text']
                }
              }
            },
            required: ['parts']
          }
        }
      }
    };

    let data = await openRouterRequest(payload, signal);
    let reply = formatStructuredReply(readResponseContent(data));

    /* 긴 구조화 답변이 토큰 제한으로 잘리면 JSON 원문을 전송하지 않고
       출력 한도를 늘려 짧은 답변으로 한 번만 재생성한다. */
    if (!reply || data?.choices?.[0]?.finish_reason === 'length') {
      payload.max_tokens = Math.min(4000, Math.max(1000, payload.max_tokens * 2));
      payload.messages[0].content += [
        '',
        '[길이 제한]',
        '전체 답변을 narration과 dialogue 합계 2~4개 항목으로 간결하게 작성한다.',
        '각 항목을 끝까지 완성하고 유효한 JSON 객체 하나로 출력한다.'
      ].join('\n');
      data = await openRouterRequest(payload, signal);
      reply = formatStructuredReply(readResponseContent(data));
    }

    if (!reply) {
      throw new Error('구조화 답변이 중간에 잘렸어요. 최대 출력 토큰을 1000 이상으로 올려줘.');
    }

    const lastCharacterText = [...history].reverse()
      .find(item => item.role === 'assistant')?.content || '';

    if (isLikelyCharacterEcho(reply, lastCharacterText)) {
      payload.messages[0].content += [
        '',
        '[재생성 지시]',
        '방금 출력은 직전 제타 캐릭터의 대사를 복사했다.',
        '그 문장을 절대 반복하지 말고 사용자 자신의 새로운 반응만 다시 작성한다.'
      ].join('\n');
      data = await openRouterRequest(payload, signal);
      reply = formatStructuredReply(readResponseContent(data));
      if (!reply) throw new Error('재생성된 구조화 답변이 중간에 잘렸어요.');
    }

    return removeCharacterEcho(reply, lastCharacterText);
  }

  function readResponseContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.map(x => typeof x === 'string' ? x : x?.text || '').join('');
    }
    return text;
  }

  function comparisonText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\{\{[^}]+\}\}/g, '')
      .replace(/[*_~`“”"'‘’.,!?…·:;()\[\]{}<>\-—\s]/g, '');
  }

  function copiedDialogueParagraphs(reply, characterText) {
    const source = comparisonText(characterText);
    if (!source) return [];
    return String(reply || '').split(/\n{2,}/).filter(paragraph => {
      const trimmed = paragraph.trim();
      if (!trimmed || (trimmed.startsWith('*') && trimmed.endsWith('*'))) return false;
      const candidate = comparisonText(trimmed);
      return candidate.length >= 6 && source.includes(candidate);
    });
  }

  function isLikelyCharacterEcho(reply, characterText) {
    return copiedDialogueParagraphs(reply, characterText).length > 0;
  }

  function removeCharacterEcho(reply, characterText) {
    const copied = new Set(copiedDialogueParagraphs(reply, characterText));
    if (!copied.size) return reply;
    return String(reply || '').split(/\n{2,}/)
      .filter(paragraph => !copied.has(paragraph))
      .join('\n\n')
      .trim();
  }

  function formatStructuredReply(raw) {
    const source = String(raw || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    try {
      const data = JSON.parse(source);
      if (Array.isArray(data?.parts) && data.parts.length) {
        const parts = data.parts.map(part => {
          const text = normalizeText(part?.text)
            .replace(/^\*+|\*+$/g, '')
            .replace(/^[“”"]+|[“”"]+$/g, '')
            .trim();
          if (!text) return '';
          return part.type === 'narration' ? `*${text}*` : text;
        }).filter(Boolean);
        if (parts.length) return parts.join('\n\n');
      }
    } catch (_) {
      /* JSON처럼 시작한 응답은 파싱 실패 시 불완전한 구조화 출력이다.
         일반 문장으로 취급하면 JSON 원문이 채팅창에 전송된다. */
      if (/^[\[{]/.test(source)) return '';
    }

    /* 파싱은 됐지만 요구한 parts 구조가 아닌 JSON도 그대로 보내지 않는다. */
    if (/^[\[{]/.test(source)) return '';

    /* 구조화 출력을 지원하지 않는 모델로 바꾼 경우의 호환용 처리. */
    return normalizeGeneratedReply(source);
  }

  function normalizeGeneratedReply(text) {
    let out = normalizeText(text);
    out = out.replace(/^(다음\s*(사용자\s*)?답장|사용자|답장)\s*:\s*/i, '');
    if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
      out = out.slice(1, -1).trim();
    }
    return out;
  }

  function setNativeTextareaValue(textarea, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (descriptor?.set) descriptor.set.call(textarea, value);
    else textarea.value = value;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function replyAppearedInChat(reply) {
    const target = normalizeText(reply);
    if (!target) return false;
    return collectConversation().slice(-3).some(item => (
      item.role === 'user' && normalizeText(item.text) === target
    ));
  }

  async function fillAndSend(reply, signal) {
    for (let attempt = 1; ; attempt += 1) {
      const textarea = document.querySelector('textarea[aria-label="내용 입력하기"]');
      if (!textarea || textarea.disabled) return false;

      /* 이전 시도가 실제 채팅에 올라갔다면 입력창 상태와 무관하게 중복 전송하지 않는다. */
      if (replyAppearedInChat(reply)) return true;

      const current = normalizeText(textarea.value);
      if (current && current !== normalizeText(reply)) {
        throw new Error('입력창 내용이 바뀌어 재전송을 중단했어요.');
      }

      if (!current) {
        textarea.focus();
        setNativeTextareaValue(textarea, reply);
        await wait(300, signal);
      }

      const send = document.querySelector('button[data-testid="chat-send-button"]');
      if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') return false;

      if (attempt > 1) {
        setStatus(`전송 재시도 ${attempt - 1}회`, 'busy');
        renderWidget();
      }

      send.click();
      await wait(2500, signal);

      if (replyAppearedInChat(reply)) return true;

      const after = document.querySelector('textarea[aria-label="내용 입력하기"]');
      if (!after || !normalizeText(after.value)) return true;
      if (normalizeText(after.value) !== normalizeText(reply)) {
        throw new Error('입력창 내용이 바뀌어 재전송을 중단했어요.');
      }

      await wait(1500, signal);
    }
  }

  function startAuto() {
    settings = loadSettings();
    if (!settings.apiKey.trim()) {
      openPanel();
      showToast('OpenRouter API 키를 먼저 입력해줘.', true);
      return;
    }
    if (!isChatPage()) {
      showToast('제타 채팅방 안에서 켜줘.', true);
      return;
    }
    enabled = true;
    busy = false;
    sessionTurns = 0;
    lastHandledFingerprint = '';
    lastConversationFingerprint = '';
    lastConversationChangeAt = Date.now();
    setStatus('대화 확인 중', 'on');
    renderWidget();
    startObserver();
    showToast('자동대화를 시작했어요.');
    scheduleCheck(300);
  }

  function stopAuto(reason = '정지됨') {
    enabled = false;
    busy = false;
    clearTimeout(checkTimer);
    stopObserver();
    abortController?.abort();
    abortController = null;
    setStatus(reason, 'off');
    renderWidget();
  }

  function toggleAuto() {
    if (enabled) stopAuto();
    else startAuto();
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${WIDGET_ID}{position:fixed;right:12px;bottom:92px;z-index:2147483644;display:flex;gap:6px;align-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #${WIDGET_ID} button{border:1px solid rgba(0,0,0,.12);box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer}
      #${WIDGET_ID} .zac-toggle{height:36px;padding:0 12px;border-radius:18px;background:#fff;color:#333;font-size:12px;font-weight:700}
      #${WIDGET_ID}.is-on .zac-toggle{background:#FEE500;color:#191919;border-color:#D9C500}
      #${WIDGET_ID}.is-busy .zac-toggle{background:#FFF3A0;color:#4C4300}
      #${WIDGET_ID} .zac-settings{width:36px;height:36px;border-radius:50%;background:#fff;color:#444;font-size:17px}
      #${PANEL_ID}{position:fixed;inset:0;z-index:2147483646;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.58);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box}
      #${PANEL_ID}.open{display:flex}
      #${PANEL_ID} *{box-sizing:border-box}
      #${PANEL_ID} .zac-card{width:min(440px,100%);max-height:min(760px,92dvh);overflow:auto;border-radius:18px;background:#fff;color:#222;padding:18px;box-shadow:0 18px 50px rgba(0,0,0,.3)}
      #${PANEL_ID} .zac-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
      #${PANEL_ID} h2{font-size:18px;margin:0}
      #${PANEL_ID} .zac-close{border:0;background:#eee;width:32px;height:32px;border-radius:50%;font-size:18px}
      #${PANEL_ID} label{display:block;margin:12px 0 5px;font-size:12px;font-weight:700;color:#555}
      #${PANEL_ID} input,#${PANEL_ID} textarea{width:100%;border:1px solid #d8dde0;border-radius:9px;background:#f7f8f9;color:#222;padding:10px;font:inherit;outline:none}
      #${PANEL_ID} input:focus,#${PANEL_ID} textarea:focus{border-color:#c9b600;box-shadow:0 0 0 3px rgba(254,229,0,.2)}
      #${PANEL_ID} textarea{min-height:120px;resize:vertical;font-size:12px;line-height:1.45}
      #${PANEL_ID} .zac-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      #${PANEL_ID} .zac-note{margin:8px 0 0;color:#777;font-size:11px;line-height:1.45}
      #${PANEL_ID} .zac-actions{display:flex;gap:8px;margin-top:18px}
      #${PANEL_ID} .zac-actions button{flex:1;height:42px;border:0;border-radius:9px;font-weight:700;cursor:pointer}
      #${PANEL_ID} .zac-save{background:#FEE500;color:#191919}
      #${PANEL_ID} .zac-stop{background:#eceff1;color:#46545e}
      #${APP_ID}-toast{position:fixed;left:50%;bottom:34px;z-index:2147483647;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 14px;border-radius:10px;background:#263238;color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .2s}
      #${APP_ID}-toast.show{opacity:1}
      #${APP_ID}-toast.error{background:#a63838}
    `;
    document.head.appendChild(style);
  }

  function installUi() {
    if (!document.getElementById(WIDGET_ID)) {
      const widget = document.createElement('div');
      widget.id = WIDGET_ID;
      widget.innerHTML = '<button class="zac-toggle" type="button">AUTO OFF</button><button class="zac-settings" type="button" aria-label="자동대화 설정">⚙</button>';
      widget.querySelector('.zac-toggle').addEventListener('click', toggleAuto);
      widget.querySelector('.zac-settings').addEventListener('click', openPanel);
      document.body.appendChild(widget);
    }

    if (!document.getElementById(PANEL_ID)) {
      const panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.innerHTML = `
        <div class="zac-card" role="dialog" aria-modal="true" aria-label="Zeta 자동대화 설정">
          <div class="zac-head"><h2>Zeta 자동대화</h2><button class="zac-close" type="button">×</button></div>
          <label>OpenRouter API 키</label>
          <input name="apiKey" type="password" autocomplete="off" placeholder="sk-or-v1-…">
          <p class="zac-note">키는 이 기기의 유저스크립트 저장소에만 보관되며 GitHub로 전송되지 않습니다.</p>
          <label>모델</label>
          <input name="model" type="text">
          <label>내 프로필</label>
          <textarea name="profile" placeholder="성격, 말투, 상대와의 관계, 답장할 때 지켜야 할 설정 등을 적어주세요."></textarea>
          <p class="zac-note">최근 대화와 함께 OpenRouter에 전달됩니다. 비워두면 최근 대화만 참고합니다.</p>
          <label>사용자 역할 프롬프트</label>
          <textarea name="prompt"></textarea>
          <div class="zac-grid">
            <div><label>최근 발화 수</label><input name="historyItems" type="number" min="2" max="50"></div>
            <div><label>최대 출력 토큰</label><input name="maxOutputTokens" type="number" min="50" max="4000"></div>
            <div><label>최소 전송 대기(초)</label><input name="minDelay" type="number" min="0" max="60" step="0.5"></div>
            <div><label>최대 전송 대기(초)</label><input name="maxDelay" type="number" min="0" max="120" step="0.5"></div>
            <div><label>세션 전송 한도 (0=무제한)</label><input name="sessionLimit" type="number" min="0" max="100000"></div>
          </div>
          <div class="zac-actions"><button class="zac-stop" type="button">자동대화 정지</button><button class="zac-save" type="button">저장</button></div>
        </div>`;
      panel.addEventListener('click', event => { if (event.target === panel) closePanel(); });
      panel.querySelector('.zac-close').addEventListener('click', closePanel);
      panel.querySelector('.zac-stop').addEventListener('click', () => { stopAuto(); closePanel(); });
      panel.querySelector('.zac-save').addEventListener('click', savePanel);
      document.body.appendChild(panel);
    }

    renderWidget();
  }

  function formValue(panel, name) {
    return panel.querySelector(`[name="${name}"]`)?.value ?? '';
  }

  function openPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    settings = loadSettings();
    Object.entries(settings).forEach(([key, value]) => {
      const input = panel.querySelector(`[name="${key}"]`);
      if (input) input.value = value;
    });
    panel.classList.add('open');
  }

  function closePanel() {
    document.getElementById(PANEL_ID)?.classList.remove('open');
  }

  function savePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    saveSettings({
      ...settings,
      apiKey: formValue(panel, 'apiKey').trim(),
      model: formValue(panel, 'model').trim() || DEFAULTS.model,
      profile: formValue(panel, 'profile').trim(),
      prompt: formValue(panel, 'prompt').trim() || DEFAULT_PROMPT,
      historyItems: clampNumber(formValue(panel, 'historyItems'), 2, 50, DEFAULTS.historyItems),
      maxOutputTokens: clampNumber(formValue(panel, 'maxOutputTokens'), 50, 4000, DEFAULTS.maxOutputTokens),
      minDelay: clampNumber(formValue(panel, 'minDelay'), 0, 60, DEFAULTS.minDelay),
      maxDelay: clampNumber(formValue(panel, 'maxDelay'), 0, 120, DEFAULTS.maxDelay),
      sessionLimit: clampNumber(formValue(panel, 'sessionLimit'), 0, 100000, DEFAULTS.sessionLimit)
    });
    closePanel();
    showToast('설정을 저장했어요.');
  }

  function setStatus(text, state) {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;
    widget.dataset.status = text;
    widget.dataset.state = state;
  }

  function renderWidget() {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;
    widget.classList.toggle('is-on', enabled && !busy);
    widget.classList.toggle('is-busy', enabled && busy);
    const button = widget.querySelector('.zac-toggle');
    if (!button) return;
    const usage = getDailyUsage();
    const status = widget.dataset.status || '';
    const statusLabel = {
      '대화 확인 중': '확인 중',
      '대화 인식 못함': '인식 못함',
      '제타 답변 대기': '답변 대기',
      '제타 생성 대기': '생성 대기',
      '답변 안정화 대기': '안정화 중',
      'AI 답변 대기 중': '답변 대기'
    }[status] || 'ON';
    const nextText = enabled
      ? (busy ? 'AUTO 처리 중' : `AUTO ${statusLabel} · ${sessionTurns}`)
      : 'AUTO OFF';
    const nextTitle = `${widget.dataset.status || '정지됨'} · 오늘 ${usage.count}회`;
    if (button.textContent !== nextText) button.textContent = nextText;
    if (button.title !== nextTitle) button.title = nextTitle;
  }

  let toastTimer = 0;
  function showToast(message, error = false) {
    let toast = document.getElementById(APP_ID + '-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = APP_ID + '-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!enabled || busy) return;
      /* 스트리밍 중 발생하는 수많은 변경을 한 번으로 묶는다. */
      scheduleCheck(500);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  function start() {
    installStyle();
    installUi();
    setStatus('정지됨', 'off');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
