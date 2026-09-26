// ==UserScript==
// @name         ZETA Snapshot Test Prototype
// @namespace    zeta-snapshot-test
// @version      0.5.0
// @description  ZETA Snapshot collector/review/send/result persistence
// @match        https://zeta-ai.io/*
// @match        https://www.zeta-ai.io/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      image.zeta-ai.io
// @connect      zeta-snapshot.kwillhs.workers.dev
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    RELAY_BASE: 'https://zeta-snapshot.kwillhs.workers.dev',
    MESSAGE_LIMIT: 12,
    STORAGE: {
      CHARACTER: 'zetaSnapshot.characterCache.v1',
      USER: 'zetaSnapshot.userCache.v1',
      GLOBAL: 'zetaSnapshot.globalSettings.v1',
      PLOTS: 'zetaSnapshot.plots.v1',
      SNAPSHOTS: 'zetaSnapshot.roomSnapshots.v1',
      CLIENT_ID: 'zetaSnapshot.clientId.v1',
    },
    DEFAULT_INSTRUCTIONS: [
      '가능한 한 캐릭터 프로필 이미지와 유저 프로필 이미지의 그림체, 선화, 채색 분위기, 얼굴 인상을 따라갈 것.',
      '단순 복제가 아니라 현재 대화 장면을 같은 느낌으로 새롭게 구성할 것.',
      '텍스트를 이미지에 넣지 말 것.',
      '정보가 없는 외형은 임의로 과하게 확정하지 말고, 아래 외형 프롬프트와 대화에서 확인된 정보만 우선 반영할 것.'
    ].join('\n'),
  };

  const STYLE_PRESETS = {
    '2d': {
      label: '2D 일러스트',
      prompt: 'high-quality 2D illustration, clean lineart, soft shading, illustrated look',
    },
    'semi': {
      label: '반실사',
      prompt: 'semi-realistic illustration, refined facial details, realistic proportions, illustrated finish',
    },
    'real': {
      label: '실사',
      prompt: 'photorealistic image, realistic lighting, realistic skin texture, cinematic look',
    },
  };

  const state = {
    overlay: null,
    resultBox: null,
    currentDraft: null,
    activePlotId: null,
    autosaveTimer: null,
    roomPollTimers: new Map(),
    lastObservedRoomId: null,
  };

  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

  function cleanText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\u200b/g, '')
      .trim();
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function load(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function getPlotStore() {
    return load(CONFIG.STORAGE.PLOTS, {}) || {};
  }

  function savePlotStore(store) {
    save(CONFIG.STORAGE.PLOTS, store || {});
  }

  function getPlotEntry(plotId) {
    if (!plotId) return null;
    const store = getPlotStore();
    return store[plotId] || null;
  }

  function getDraftPlotId(draft) {
    return (
      draft?.plotId ||
      draft?.character?.plotId ||
      draft?.character?.id ||
      null
    );
  }

  function upsertPlotEntry(plotId, patch = {}) {
    if (!plotId) return null;

    const store = getPlotStore();
    const prev = store[plotId] || {};
    const next = {
      ...prev,
      ...patch,
      plotId,
      updatedAt: Date.now(),
    };

    if (patch.rooms || prev.rooms) {
      next.rooms = {
        ...(prev.rooms || {}),
        ...(patch.rooms || {}),
      };
    }

    store[plotId] = next;
    savePlotStore(store);
    return next;
  }

  function getPlotLabel(entry, fallbackId = '') {
    return (
      cleanText(entry?.title) ||
      cleanText(entry?.character?.plotTitle) ||
      cleanText(entry?.character?.name) ||
      (fallbackId ? `플롯 ${fallbackId.slice(0, 6)}` : '플롯')
    );
  }

  function getClientId() {
    let id = localStorage.getItem(CONFIG.STORAGE.CLIENT_ID);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CONFIG.STORAGE.CLIENT_ID, id);
    }
    return id;
  }

  function flash(message, ms = 2200) {
    const el = document.createElement('div');
    el.className = 'zs-toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, ms);
  }

  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return String(h >>> 0);
  }

  function getRoomId() {
    let m = location.pathname.match(/\/rooms\/([^/?#]+)/);
    if (m) return m[1];

    m = location.pathname.match(/\/my-plot-chat-profile\/[^/?#]+\/([^/?#]+)\/edit/);
    if (m) return m[1];

    return 'manual-room';
  }

  function getPlotIdFromUrl() {
    let m = location.pathname.match(/\/plots\/([^/?#]+)/);
    if (m) return m[1];

    m = location.pathname.match(/\/my-plot-chat-profile\/([^/?#]+)\/[^/?#]+\/edit/);
    if (m) return m[1];

    return null;
  }

  function pickBestImageUrl(candidates) {
    const valid = [...new Set(candidates.filter(Boolean))];
    if (!valid.length) return '';

    const scored = valid.map(url => {
      let score = 0;
      if (/user-plot-chat-profile-image/.test(url)) score += 80;
      if (/profile-image/.test(url)) score += 60;
      if (/plot-cover-image/.test(url)) score -= 1000;

      const w = (url.match(/[?&]w=(\d+)/)?.[1]) || '';
      score += Number(w || 0);

      if (/1920/.test(url)) score += 600;
      if (/1080/.test(url)) score += 500;
      if (/q=90/.test(url)) score += 10;

      return { url, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].url;
  }

  function stripImageTransform(url) {
    if (!url) return '';
    try {
      const u = new URL(url, location.origin);
      if (u.hostname === 'image.zeta-ai.io') u.search = '';
      return u.href;
    } catch {
      return String(url).replace(/\?.*$/, '');
    }
  }

  function imageUrlFromImg(img, { original = true } = {}) {
    if (!img) return '';

    const candidates = [];
    if (img.currentSrc) candidates.push(img.currentSrc);
    if (img.src) candidates.push(img.src);

    const srcset = img.getAttribute('srcset') || '';
    srcset.split(',').forEach(part => {
      const url = part.trim().split(/\s+/)[0];
      if (url) candidates.push(url);
    });

    const best = pickBestImageUrl(candidates);
    return original ? stripImageTransform(best) : best;
  }

  function makeSvgDataUrl(label, bg = '#888') {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
        <rect width="100%" height="100%" fill="${bg}"/>
        <circle cx="256" cy="200" r="90" fill="rgba(255,255,255,0.75)"/>
        <rect x="130" y="305" width="252" height="120" rx="60" fill="rgba(255,255,255,0.75)"/>
        <text x="50%" y="480" text-anchor="middle" font-family="sans-serif" font-size="34" fill="#fff">${label}</text>
      </svg>
    `;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function joinMaybe(...parts) {
    return parts.filter(Boolean).join('\n').trim();
  }

  function buildAutoAppearance(profile) {
    return String(profile?.description || '').trim();
  }

  function collectRecentMessages(limit = CONFIG.MESSAGE_LIMIT) {
    const rows = [];
    const nodes = qsa([
      '[data-sentry-component="LeftTextContent"]',
      '[data-sentry-component="RightTextContent"]',
      '[data-sentry-component="NarratorBubble"]'
    ].join(','));

    for (const el of nodes) {
      let speaker = 'unknown';
      const kind = el.getAttribute('data-sentry-component') || '';
      if (kind === 'LeftTextContent') speaker = 'character';
      else if (kind === 'RightTextContent') speaker = 'user';
      else if (kind === 'NarratorBubble') speaker = 'narrator';

      const text = cleanText(qs('.chat', el)?.innerText || el.innerText || '');
      if (text) rows.push({ speaker, text });
    }

    if (!rows.length) {
      const fallbacks = qsa('main [class*="whitespace-pre-wrap"], main p, main div.break-words');
      for (const el of fallbacks) {
        if (!el.offsetParent) continue;
        const text = cleanText(el.innerText || el.textContent || '');
        if (text) rows.push({ speaker: 'unknown', text: text.slice(0, 500) });
      }
    }

    const deduped = [];
    for (const row of rows) {
      const prev = deduped[deduped.length - 1];
      if (!prev || prev.speaker !== row.speaker || prev.text !== row.text) deduped.push(row);
    }

    return deduped.slice(-limit);
  }

  function buildAnchor(messages) {
    const last = messages[messages.length - 1];
    if (!last) return { messageId: null, hash: null, preview: '' };

    return {
      messageId: null,
      hash: simpleHash(`${last.speaker}:${last.text}`),
      preview: last.text.slice(0, 100),
    };
  }

  function collectSelectedUserProfileFromDialog() {
    const dialog =
      qs('section[role="dialog"][aria-label*="대화 프로필"]') ||
      qs('[role="group"][aria-label="My chat profiles"]')?.closest('section[role="dialog"]') ||
      qs('section[role="dialog"]');

    if (!dialog) {
      throw new Error('대화 프로필 창을 열어둔 상태에서 다시 시도해줘.');
    }

    const items = qsa('[data-sentry-component="ChatProfileListItem"]', dialog);
    if (!items.length) throw new Error('프로필 목록을 찾지 못했어.');

    const active = items.find(item => {
      const checkBadge = qs('.bg-primary-400 svg, .kt-profile-hub-selected svg', item);
      const disabledButton = qsa('button', item).some(btn => btn.disabled);
      return !!checkBadge || disabledButton;
    });

    if (!active) throw new Error('체크된 현재 사용 프로필을 찾지 못했어.');

    const name =
      cleanText(qs('.body1', active)?.textContent) ||
      cleanText(qs('img', active)?.alt) ||
      '유저';

    const description = cleanText(qs('.caption1', active)?.textContent) || '';
    const imageUrl = imageUrlFromImg(qs('img', active));

    const editLabel = qs('button[aria-label^="edit-"]', active)?.getAttribute('aria-label') || '';
    const id = editLabel.startsWith('edit-') ? editLabel.slice(5) : null;

    const profile = {
      id,
      kind: 'user',
      name,
      description,
      imageUrl,
      source: 'dialog-selected-profile',
      updatedAt: Date.now(),
    };

    save(CONFIG.STORAGE.USER, profile);

    const plotId = getPlotIdFromUrl() || state.activePlotId || null;
    const roomId = getRoomId();

    if (plotId) {
      upsertPlotEntry(plotId, {
        userProfile: profile,
        rooms: roomId && roomId !== 'manual-room'
          ? {
              [roomId]: {
                roomId,
                lastUsedAt: Date.now(),
              },
            }
          : {},
      });
    }

    return profile;
  }

  function isUsableUserProfileImage(url) {
    const value = String(url || '');
    if (!value) return false;
    if (/default-profile|default_profile|placeholder|avatar-default/i.test(value)) return false;
    return /\/user-plot-chat-profile-image\//.test(value);
  }

  function extractUserProfileImageFromHtml(html) {
    const normalized = String(html || '')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/\\\//g, '/');

    const matches = normalized.match(
      /https:\/\/image\.zeta-ai\.io\/user-plot-chat-profile-image\/[^"'<>\\\s)]+/g
    ) || [];

    const candidates = matches
      .map(url => stripImageTransform(url))
      .filter(isUsableUserProfileImage);

    return candidates[0] || '';
  }

  function parseUserProfileEditDoc(doc, plotId, roomId, fallbackImageUrl = '') {
    const name = cleanText(doc.querySelector('input[name="name"]')?.value || '');
    const description = String(doc.querySelector('textarea[name="description"]')?.value || '').trim();

    const imgs = [...doc.querySelectorAll('img[alt="profile image"], img[src*="user-plot-chat-profile-image"]')];
    const imageUrl =
      imgs.map(img => imageUrlFromImg(img))
        .find(isUsableUserProfileImage) ||
      (isUsableUserProfileImage(fallbackImageUrl) ? stripImageTransform(fallbackImageUrl) : '');

    const imageProfileId =
      imageUrl.match(/\/user-plot-chat-profile-image\/([^/]+)\//)?.[1] || null;

    if (!name && !description && !imageUrl) {
      throw new Error('현재 사용 프로필 편집 페이지에서 프로필 정보를 찾지 못했어.');
    }

    return {
      id: imageProfileId,
      kind: 'user',
      name: name || '유저',
      description,
      imageUrl,
      plotId,
      roomId,
      source: 'current-profile-edit-page',
      updatedAt: Date.now(),
    };
  }

  function getSelectedUserProfileIfOpen() {
    const dialog =
      qs('section[role="dialog"][aria-label*="대화 프로필"]') ||
      qs('[role="group"][aria-label="My chat profiles"]')?.closest('section[role="dialog"]');

    if (!dialog) return null;

    try {
      return collectSelectedUserProfileFromDialog();
    } catch {
      return null;
    }
  }

  async function collectCurrentUserProfileFromEditPage(plotId, roomId) {
    if (!plotId || !roomId || roomId === 'manual-room') {
      throw new Error('plotId 또는 roomId가 없어 현재 프로필을 자동 수집할 수 없어.');
    }

    const cached = load(CONFIG.STORAGE.USER, null);
    const selected = getSelectedUserProfileIfOpen();

    const currentEditMatch = location.pathname.match(
      /\/my-plot-chat-profile\/([^/?#]+)\/([^/?#]+)\/edit/
    );

    if (
      currentEditMatch &&
      currentEditMatch[1] === plotId &&
      currentEditMatch[2] === roomId
    ) {
      const liveHtml = document.documentElement?.innerHTML || '';
      const fallback = extractUserProfileImageFromHtml(liveHtml);
      const live = parseUserProfileEditDoc(document, plotId, roomId, fallback);

      if (!isUsableUserProfileImage(live.imageUrl)) {
        if (selected && isUsableUserProfileImage(selected.imageUrl)) live.imageUrl = selected.imageUrl;
        else if (cached?.name === live.name && isUsableUserProfileImage(cached.imageUrl)) live.imageUrl = cached.imageUrl;
      }

      save(CONFIG.STORAGE.USER, live);
      upsertPlotEntry(plotId, {
        userProfile: live,
        rooms: {
          [roomId]: {
            roomId,
            lastUsedAt: Date.now(),
          },
        },
      });
      return live;
    }

    const url = `/ko/my-plot-chat-profile/${encodeURIComponent(plotId)}/${encodeURIComponent(roomId)}/edit`;
    const res = await fetch(url, { credentials: 'include' });

    if (!res.ok) {
      throw new Error(`현재 프로필 편집 페이지 요청 실패: ${res.status}`);
    }

    const html = await res.text();
    const fallback = extractUserProfileImageFromHtml(html);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const profile = parseUserProfileEditDoc(doc, plotId, roomId, fallback);

    if (selected?.name === profile.name && isUsableUserProfileImage(selected.imageUrl)) {
      profile.imageUrl = stripImageTransform(selected.imageUrl);
    } else if (
      cached?.name === profile.name &&
      isUsableUserProfileImage(cached.imageUrl) &&
      !isUsableUserProfileImage(profile.imageUrl)
    ) {
      profile.imageUrl = stripImageTransform(cached.imageUrl);
    }

    save(CONFIG.STORAGE.USER, profile);
    return profile;
  }

  function parseCharacterProfileDoc(doc, plotId) {
    const basic = doc.querySelector('[data-sentry-component="PlotBasic"]');
    const plotTitle = cleanText(
      basic?.querySelector('.title1')?.textContent ||
      basic?.querySelector('span')?.textContent ||
      ''
    );
    const plotSummary = cleanText(basic?.querySelector('p.heading3')?.textContent || '');

    let jsonLdCharacters = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || '{}');
        if (Array.isArray(data?.character)) {
          jsonLdCharacters = data.character
            .filter(item => item && typeof item === 'object')
            .map(item => ({
              name: cleanText(item.name || ''),
              imageUrl: stripImageTransform(item.image || ''),
            }));
          if (jsonLdCharacters.length) break;
        }
      } catch {}
    }

    const boxes = [...doc.querySelectorAll('[data-sentry-component="PlotCharacterAbout"]')];
    let characters = boxes.map((box, index) => {
      const img = box.querySelector('img[alt^="Profile image of "]');
      const altName = cleanText(
        (img?.getAttribute('alt') || '').replace(/^Profile image of\s*/i, '')
      );
      const name = cleanText(
        box.querySelector('.heading2')?.textContent ||
        altName ||
        ''
      );
      const description = String(
        box.querySelector('.body1')?.innerText ||
        box.querySelector('.body1')?.textContent ||
        ''
      ).trim();
      const imageUrl = img ? imageUrlFromImg(img) : '';
      return {
        id: `${plotId}:character:${index + 1}`,
        slotId: `${plotId}:character:${index + 1}`,
        kind: 'character',
        name: name || `캐릭터 ${index + 1}`,
        description,
        imageUrl: /\/profile-image\//.test(imageUrl) ? imageUrl : '',
        primary: index === 0,
        source: 'plot-character-about',
      };
    });

    if (!characters.length && jsonLdCharacters.length) {
      characters = jsonLdCharacters.map((item, index) => ({
        id: `${plotId}:character:${index + 1}`,
        slotId: `${plotId}:character:${index + 1}`,
        kind: 'character',
        name: item.name || `캐릭터 ${index + 1}`,
        description: '',
        imageUrl: /\/profile-image\//.test(item.imageUrl) ? item.imageUrl : '',
        primary: index === 0,
        source: 'json-ld',
      }));
    }

    if (!characters.length) {
      const longRoot = doc.querySelector('[data-sentry-component="PlotLongDescription"]');
      const charImg =
        longRoot?.querySelector('img[alt^="Profile image of "]') ||
        doc.querySelector('img[alt^="Profile image of "]');

      let name = '';
      if (charImg) {
        name = cleanText((charImg.getAttribute('alt') || '').replace(/^Profile image of\s*/i, ''));
        if (!name) {
          name = cleanText(charImg.closest('button')?.querySelector('.heading2')?.textContent || '');
        }
      }

      if (!name) {
        name = cleanText(
          doc.querySelector('[data-sentry-component="StaticIntroMessage"] .caption1')?.textContent ||
          ''
        );
      }

      const imageUrl = charImg ? imageUrlFromImg(charImg) : '';
      let description = '';

      if (longRoot) {
        const clone = longRoot.cloneNode(true);
        clone.querySelectorAll('button, h1, h2, h3, img, svg').forEach(el => el.remove());
        description = cleanText(clone.textContent || '');
        description = description.replace(/^캐릭터\s*/i, '').trim();
        if (name && description.startsWith(name)) {
          description = description.slice(name.length).trim();
        }
        if (!description || description === '.' || description === name) {
          description = '';
        }
      }

      characters = [{
        id: `${plotId}:character:1`,
        slotId: `${plotId}:character:1`,
        kind: 'character',
        name: name || plotTitle || '캐릭터',
        description,
        imageUrl: /\/profile-image\//.test(imageUrl) ? imageUrl : '',
        primary: true,
        source: 'plot-profile-page',
      }];
    }

    for (const item of jsonLdCharacters) {
      const target = characters.find(c => c.name === item.name);
      if (target && !target.imageUrl && /\/profile-image\//.test(item.imageUrl)) {
        target.imageUrl = item.imageUrl;
      }
    }

    const primary = characters.find(c => c.primary) || characters[0];

    return {
      id: plotId,
      plotId,
      kind: characters.length > 1 ? 'character_group' : 'character',
      name: primary?.name || plotTitle || '캐릭터',
      description: primary?.description || '',
      imageUrl: primary?.imageUrl || '',
      characters,
      plotTitle,
      plotSummary,
      source: 'plot-profile-page',
      updatedAt: Date.now(),
    };
  }

  function collectCharacterProfileFromCurrentPage() {
    const plotId = getPlotIdFromUrl();
    if (!plotId || !/\/profile/.test(location.pathname)) {
      throw new Error('캐릭터 프로필 페이지에서 실행해줘. (/plots/.../profile)');
    }

    const profile = parseCharacterProfileDoc(document, plotId);
    save(CONFIG.STORAGE.CHARACTER, profile);
    upsertPlotEntry(plotId, {
      title: profile.plotTitle || profile.name || '',
      character: profile,
    });
    return profile;
  }

  async function collectCharacterProfileById(plotId) {
    if (!plotId) throw new Error('plotId가 없어 캐릭터 프로필을 자동 수집할 수 없어.');

    const res = await fetch(
      `/ko/plots/${encodeURIComponent(plotId)}/profile?fromRoom=true`,
      { credentials: 'include' }
    );

    if (!res.ok) {
      throw new Error(`캐릭터 프로필 요청 실패: ${res.status}`);
    }

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const profile = parseCharacterProfileDoc(doc, plotId);
    save(CONFIG.STORAGE.CHARACTER, profile);
    upsertPlotEntry(plotId, {
      title: profile.plotTitle || profile.name || '',
      character: profile,
    });
    return profile;
  }

  async function buildDraftFromCache() {
    const legacyCharacter = load(CONFIG.STORAGE.CHARACTER, {
      id: null,
      kind: 'character',
      name: '캐릭터',
      description: '',
      imageUrl: '',
    });

    const legacyUser = load(CONFIG.STORAGE.USER, {
      id: null,
      kind: 'user',
      name: '유저',
      description: '',
      imageUrl: '',
    });

    const roomId = getRoomId();
    const plotId =
      getPlotIdFromUrl() ||
      state.activePlotId ||
      legacyCharacter?.plotId ||
      legacyCharacter?.id ||
      null;

    const plotEntry = getPlotEntry(plotId);

    let character = plotEntry?.character || legacyCharacter;
    let userProfile = plotEntry?.userProfile || legacyUser;

    if (plotId) {
      try {
        character = await collectCharacterProfileById(plotId);
      } catch (err) {
        console.warn('[ZETA Snapshot] character auto collect failed', err);
      }

      if (roomId && roomId !== 'manual-room') {
        try {
          userProfile = await collectCurrentUserProfileFromEditPage(plotId, roomId);
        } catch (err) {
          console.warn('[ZETA Snapshot] user profile auto collect failed', err);
        }
      }
    }

    const global = load(CONFIG.STORAGE.GLOBAL, {});
    const refreshedEntry = getPlotEntry(plotId) || plotEntry || {};
    const messages = collectRecentMessages();

    const characterText = messages
      .filter(m => m.speaker === 'character')
      .map(m => m.text)
      .join('\n');

    const sceneText = messages.map(m => m.text).join('\n');
    const userText = '';

    let characters = Array.isArray(character?.characters) && character.characters.length
      ? character.characters
      : [character];

    characters = characters.map((item, index) => {
      const mentioned = !!item.name && sceneText.includes(item.name);
      return {
        ...item,
        slotId: item.slotId || item.id || `${plotId || 'plot'}:character:${index + 1}`,
        primary: item.primary ?? (index === 0),
        included: item.included ?? (index === 0 || mentioned),
        appearancePrompt:
          item.manualAppearancePrompt ||
          item.appearancePrompt ||
          String(item.description || '').trim(),
      };
    });

    if (!characters.some(item => item.primary) && characters[0]) {
      characters[0].primary = true;
    }

    const primaryCharacter =
      characters.find(item => item.primary) ||
      characters.find(item => item.included) ||
      characters[0] ||
      character;

    const characterGroup = {
      ...character,
      plotId: plotId || character?.plotId || character?.id || null,
      id: plotId || character?.plotId || character?.id || null,
      name: primaryCharacter?.name || character?.name || '캐릭터',
      description: primaryCharacter?.description || '',
      imageUrl: primaryCharacter?.imageUrl || '',
      appearancePrompt: primaryCharacter?.appearancePrompt || '',
      characters,
    };

    const draft = {
      source: 'auto',
      plotId,
      roomId,
      anchor: buildAnchor(messages),
      messages,
      stylePreset:
        refreshedEntry.stylePreset ||
        global.stylePreset ||
        '2d',
      additionalInstructions:
        refreshedEntry.additionalInstructions ||
        global.additionalInstructions ||
        CONFIG.DEFAULT_INSTRUCTIONS,
      character: characterGroup,
      characters,
      userProfile: {
        ...userProfile,
        appearancePrompt:
          userProfile.manualAppearancePrompt ||
          userProfile.appearancePrompt ||
          String(userProfile.description || '').trim(),
      },
    };

    if (plotId) {
      upsertPlotEntry(plotId, {
        title:
          characterGroup.plotTitle ||
          refreshedEntry.title ||
          characterGroup.name ||
          '',
        character: characterGroup,
        userProfile: draft.userProfile,
        stylePreset: draft.stylePreset,
        additionalInstructions: draft.additionalInstructions,
        rooms: roomId && roomId !== 'manual-room'
          ? {
              [roomId]: {
                roomId,
                lastUsedAt: Date.now(),
              },
            }
          : {},
      });
    }

    return draft;
  }

  function getMockDraft(kind) {
    const baseMessages = [
      { speaker: 'character', text: '그는 조용히 시선을 내렸다.' },
      { speaker: 'user', text: '...' },
      { speaker: 'character', text: '손끝이 아주 잠깐 닿았다.' },
    ];

    const baseUser = {
      id: 'mock-user',
      kind: 'user',
      name: '테스트 유저',
      description: '갈색 머리, 갈색 눈, 작은 체구.',
      imageUrl: makeSvgDataUrl('USER', '#b87de0'),
    };

    let character;

    if (kind === 'image-only') {
      character = {
        id: 'mock-char-image-only',
        kind: 'character',
        name: '프사만 있는 캐',
        description: '',
        imageUrl: makeSvgDataUrl('CHAR', '#4da6ff'),
      };
    } else if (kind === 'full') {
      character = {
        id: 'mock-char-full',
        kind: 'character',
        name: '프사+설명 캐',
        description: '금발, 처진 눈, 넓은 어깨. 겉은 순한 인상이나 집요한 성격.',
        imageUrl: makeSvgDataUrl('CHAR', '#f28c8c'),
      };
    } else {
      character = {
        id: 'mock-char-empty',
        kind: 'character',
        name: '아무것도 없는 캐',
        description: '',
        imageUrl: '',
      };
    }

    const recentText = baseMessages.map(m => m.text).join('\n');

    return {
      source: `mock:${kind}`,
      roomId: 'mock-room',
      anchor: buildAnchor(baseMessages),
      messages: baseMessages,
      stylePreset: '2d',
      additionalInstructions: CONFIG.DEFAULT_INSTRUCTIONS,
      character: {
        ...character,
        characters: [{
          ...character,
          slotId: character.id,
          primary: true,
          included: true,
          appearancePrompt: String(character.description || '').trim(),
        }],
        appearancePrompt: String(character.description || '').trim(),
      },
      characters: [{
        ...character,
        slotId: character.id,
        primary: true,
        included: true,
        appearancePrompt: String(character.description || '').trim(),
      }],
      userProfile: {
        ...baseUser,
        appearancePrompt: String(baseUser.description || '').trim(),
      },
    };
  }

  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest를 사용할 수 없어.'));
        return;
      }

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        anonymous: false,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`이미지 GM 요청 실패: ${response.status}`));
            return;
          }

          const blob = response.response;
          if (!(blob instanceof Blob)) {
            reject(new Error('이미지 응답을 Blob으로 받지 못했어.'));
            return;
          }

          resolve(blob);
        },
        onerror: err => {
          reject(new Error(`이미지 GM 요청 실패: ${err?.error || err?.statusText || 'network error'}`));
        },
        ontimeout: () => {
          reject(new Error('이미지 GM 요청 시간 초과'));
        },
      });
    });
  }

  async function fetchBlobWithCreds(url) {
    if (url.startsWith('data:')) {
      const res = await fetch(url);
      return await res.blob();
    }

    if (/^https:\/\/image\.zeta-ai\.io\//i.test(url)) {
      return await gmFetchBlob(url);
    }

    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`이미지 fetch 실패: ${res.status}`);
    return await res.blob();
  }

  async function uploadImageToRelay(token, type, imageUrl) {
    if (!imageUrl) return { skipped: true, reason: 'no image' };

    const blob = await fetchBlobWithCreds(imageUrl);
    const mime = blob.type || 'image/png';
    const endpoint = type === 'result' ? 'result' : `${type}-image`;

    const res = await fetch(
      `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}/${endpoint}`,
      {
        method: type === 'result' ? 'POST' : 'PUT',
        headers: { 'Content-Type': mime },
        body: blob,
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`${type} 업로드 실패: ${res.status} ${JSON.stringify(data)}`);
    }

    return data;
  }


  function getRoomSnapshotStore() {
    return load(CONFIG.STORAGE.SNAPSHOTS, {}) || {};
  }

  function saveRoomSnapshotStore(store) {
    save(CONFIG.STORAGE.SNAPSHOTS, store || {});
  }

  function getRoomSnapshotInfo(roomId) {
    if (!roomId || roomId === 'manual-room') return null;
    return getRoomSnapshotStore()[roomId] || null;
  }

  function setRoomSnapshotInfo(roomId, patch = {}) {
    if (!roomId || roomId === 'manual-room') return null;
    const store = getRoomSnapshotStore();
    const prev = store[roomId] || {};
    const next = {
      ...prev,
      ...patch,
      roomId,
      updatedAt: Date.now(),
    };
    store[roomId] = next;
    saveRoomSnapshotStore(store);
    return next;
  }

  async function fetchSnapshotFromRelay(token) {
    const res = await fetch(
      `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}`,
      { method: 'GET' }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `스냅샷 조회 실패: ${res.status}`);
    }
    return data?.snapshot || data;
  }

  async function fetchSnapshotStatusFromRelay(token) {
    const res = await fetch(
      `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}/status`,
      { method: 'GET' }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `상태 조회 실패: ${res.status}`);
    }
    return data;
  }

  async function uploadResultFileToRelay(token, file) {
    if (!file) throw new Error('업로드할 이미지가 없어.');
    const mime = file.type || 'image/png';
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (!allowed.has(mime)) throw new Error('PNG/JPEG/WEBP/GIF만 업로드할 수 있어.');

    const res = await fetch(
      `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}/result`,
      {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: file,
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `결과 업로드 실패: ${res.status}`);
    }
    return data;
  }

  function findAnchorElement(anchor) {
    const preview = cleanText(anchor?.preview || '');
    const nodes = qsa([
      '[data-sentry-component="LeftTextContent"]',
      '[data-sentry-component="RightTextContent"]',
      '[data-sentry-component="NarratorBubble"]'
    ].join(','));

    if (preview) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const text = cleanText(qs('.chat', nodes[i])?.innerText || nodes[i].innerText || '');
        if (!text) continue;
        if (text === preview || text.startsWith(preview) || preview.startsWith(text.slice(0, 100))) {
          return nodes[i];
        }
      }
    }

    return nodes[nodes.length - 1] || null;
  }

  function getInlineCardId(roomId, token) {
    const safeRoom = String(roomId || 'room').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeToken = String(token || 'token').slice(0, 10).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `zs-inline-${safeRoom}-${safeToken}`;
  }

  function ensureInlineCard(roomId, info = {}) {
    if (!roomId || roomId === 'manual-room' || !info?.token) return null;
    const id = getInlineCardId(roomId, info.token);
    let card = document.getElementById(id);
    if (card) return card;

    card = document.createElement('section');
    card.id = id;
    card.className = 'zs-inline-card';
    card.dataset.zsRoomId = roomId;
    card.dataset.zsToken = info.token;

    const anchorEl = findAnchorElement(info.anchor);
    if (anchorEl?.parentNode) {
      const host = anchorEl.closest('[data-sentry-component="ChatMessage"], li, article') || anchorEl;
      host.insertAdjacentElement('afterend', card);
    } else {
      const host = qs('main') || document.body;
      host.appendChild(card);
    }

    card.addEventListener('click', async e => {
      const btn = e.target.closest('[data-zs-inline-action]');
      if (!btn) return;

      if (btn.dataset.zsInlineAction === 'refresh') {
        await refreshRoomSnapshot(roomId, true).catch(err => flash(String(err.message || err)));
        return;
      }

      if (btn.dataset.zsInlineAction === 'upload') {
        card.querySelector('input[type="file"]')?.click();
      }
    });

    card.addEventListener('change', async e => {
      const input = e.target.closest('input[type="file"]');
      if (!input) return;
      const file = input.files?.[0];
      if (!file) return;

      try {
        const uploadBtn = card.querySelector('[data-zs-inline-action="upload"]');
        if (uploadBtn) {
          uploadBtn.disabled = true;
          uploadBtn.textContent = '업로드 중...';
        }

        await uploadResultFileToRelay(info.token, file);
        flash('결과 이미지 업로드 완료');
        await refreshRoomSnapshot(roomId, true);
      } catch (err) {
        console.error('[ZETA Snapshot] result upload failed', err);
        flash(`결과 업로드 실패: ${String(err.message || err)}`, 3500);
      } finally {
        input.value = '';
      }
    });

    return card;
  }

  function renderInlineSnapshotCard(roomId, info = {}, snapshot = null) {
    const card = ensureInlineCard(roomId, info);
    if (!card) return;

    const status = snapshot?.status || info.status || 'pending';
    const resultImageUrl = snapshot?.resultImageUrl || info.resultImageUrl || '';
    const error = snapshot?.error || info.error || '';

    card.innerHTML = `
      <div class="zs-inline-card-head">
        <div>
          <strong>ZETA Snapshot</strong>
          <span class="zs-inline-status" data-status="${status}">${status}</span>
        </div>
        <div class="zs-inline-card-actions">
          <button type="button" data-zs-inline-action="refresh">새로고침</button>
          <button type="button" data-zs-inline-action="upload">결과 업로드</button>
        </div>
      </div>
      ${resultImageUrl ? `
        <img class="zs-inline-result-image" src="${resultImageUrl}" alt="ZETA Snapshot result" />
      ` : `
        <div class="zs-inline-waiting">
          ${status === 'failed'
            ? '생성에 실패했어.'
            : 'ChatGPT에서 이미지 생성 후 결과가 저장되면 여기에 표시돼.'}
        </div>
      `}
      ${error ? `<div class="zs-inline-error">${cleanText(error)}</div>` : ''}
      <input class="zs-inline-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
    `;

    // innerHTML 교체 후에도 위임 리스너는 card 자체에 남아 있음.
  }

  async function refreshRoomSnapshot(roomId, force = false) {
    const info = getRoomSnapshotInfo(roomId);
    if (!info?.token) return null;

    try {
      const snapshot = await fetchSnapshotFromRelay(info.token);
      const next = setRoomSnapshotInfo(roomId, {
        ...info,
        anchor: info.anchor || snapshot.anchor || null,
        status: snapshot.status || info.status || 'pending',
        resultImageUrl: snapshot.resultImageUrl || '',
        error: snapshot.error || null,
        expiresAt: snapshot.expiresAt || info.expiresAt || null,
      });

      renderInlineSnapshotCard(roomId, next, snapshot);

      if (next.status === 'completed' || next.resultImageUrl || next.status === 'failed') {
        stopRoomSnapshotPolling(roomId);
      } else if (force) {
        startRoomSnapshotPolling(roomId);
      }

      return next;
    } catch (err) {
      const message = String(err.message || err);
      const next = setRoomSnapshotInfo(roomId, { ...info, error: message });
      renderInlineSnapshotCard(roomId, next, null);
      throw err;
    }
  }

  function stopRoomSnapshotPolling(roomId) {
    const timer = state.roomPollTimers.get(roomId);
    if (timer) clearInterval(timer);
    state.roomPollTimers.delete(roomId);
  }

  function startRoomSnapshotPolling(roomId) {
    if (!roomId || roomId === 'manual-room') return;
    stopRoomSnapshotPolling(roomId);

    const info = getRoomSnapshotInfo(roomId);
    if (!info?.token) return;

    renderInlineSnapshotCard(roomId, info, null);

    const tick = () => {
      refreshRoomSnapshot(roomId).catch(err => {
        console.warn('[ZETA Snapshot] polling failed', err);
      });
    };

    tick();
    state.roomPollTimers.set(roomId, setInterval(tick, 8000));
  }

  function restoreSnapshotForCurrentRoom() {
    const roomId = getRoomId();
    if (!roomId || roomId === 'manual-room') return;

    const info = getRoomSnapshotInfo(roomId);
    if (!info?.token) return;

    renderInlineSnapshotCard(roomId, info, null);

    if (info.status === 'completed' && info.resultImageUrl) {
      refreshRoomSnapshot(roomId).catch(() => {});
    } else {
      startRoomSnapshotPolling(roomId);
    }
  }

  function scheduleDraftAutosave() {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(() => {
      if (!state.overlay || state.overlay.style.display === 'none' || !state.currentDraft) return;
      try {
        const draft = readFormToDraft();
        persistFromDraft(draft);
        state.currentDraft = structuredClone(draft);
      } catch (err) {
        console.warn('[ZETA Snapshot] autosave failed', err);
      }
    }, 450);
  }

  function watchRoomNavigation() {
    const check = () => {
      const roomId = getRoomId();
      if (roomId === state.lastObservedRoomId) return;

      if (state.lastObservedRoomId && state.lastObservedRoomId !== 'manual-room') {
        stopRoomSnapshotPolling(state.lastObservedRoomId);
      }

      state.lastObservedRoomId = roomId;

      if (roomId && roomId !== 'manual-room') {
        setTimeout(restoreSnapshotForCurrentRoom, 600);
      }
    };

    check();
    setInterval(check, 1000);
  }

  async function sendDraftToRelay(draft) {
    const allCharacters =
      Array.isArray(draft.characters) && draft.characters.length
        ? draft.characters
        : (Array.isArray(draft.character?.characters) && draft.character.characters.length
            ? draft.character.characters
            : [draft.character].filter(Boolean));

    const selectedCharacters = allCharacters.filter(item => item.included !== false);
    const primaryCharacter =
      selectedCharacters.find(item => item.primary) ||
      allCharacters.find(item => item.primary) ||
      selectedCharacters[0] ||
      allCharacters[0] ||
      draft.character ||
      {};

    const payload = {
      clientId: getClientId(),
      roomId: draft.roomId || 'manual-room',
      anchor: draft.anchor || { messageId: null, hash: null, preview: '' },
      messages: draft.messages || [],
      character: {
        id: draft.character?.id || null,
        plotId: draft.character?.plotId || draft.character?.id || null,
        kind: allCharacters.length > 1 ? 'character_group' : 'character',
        name: primaryCharacter.name || '',
        description: primaryCharacter.description || '',
        imageUrl: primaryCharacter.imageUrl || '',
        appearancePrompt: primaryCharacter.appearancePrompt || '',
        characters: allCharacters.map(item => ({
          id: item.id || null,
          slotId: item.slotId || null,
          name: item.name || '',
          description: item.description || '',
          imageUrl: item.imageUrl || '',
          appearancePrompt: item.appearancePrompt || '',
          primary: !!item.primary,
          included: item.included !== false,
        })),
        selectedCharacterIds: selectedCharacters.map(item => item.slotId || item.id || item.name),
        snapshotOptions: {
          stylePreset: draft.stylePreset,
          stylePrompt: STYLE_PRESETS[draft.stylePreset]?.prompt || '',
          additionalInstructions: draft.additionalInstructions || '',
        },
      },
      userProfile: {
        id: draft.userProfile.id || null,
        kind: 'user',
        name: draft.userProfile.name || '',
        description: draft.userProfile.description || '',
        imageUrl: draft.userProfile.imageUrl || '',
        appearancePrompt: draft.userProfile.appearancePrompt || '',
      },
    };

    const createRes = await fetch(`${CONFIG.RELAY_BASE}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const createData = await createRes.json().catch(() => ({}));
    if (!createRes.ok) {
      throw new Error(`생성 요청 실패: ${createRes.status} ${JSON.stringify(createData)}`);
    }

    const token = createData?.snapshot?.token;
    if (!token) throw new Error('토큰을 받지 못했어.');

    let charUpload = null;
    let userUpload = null;

    try {
      if (primaryCharacter.imageUrl) {
        charUpload = await uploadImageToRelay(token, 'character', primaryCharacter.imageUrl);
      }
    } catch (err) {
      charUpload = { error: String(err.message || err) };
    }

    try {
      if (draft.userProfile.imageUrl) {
        userUpload = await uploadImageToRelay(token, 'user', draft.userProfile.imageUrl);
      }
    } catch (err) {
      userUpload = { error: String(err.message || err) };
    }

    const roomId = draft.roomId || 'manual-room';
    const snapshotInfo = setRoomSnapshotInfo(roomId, {
      token,
      snapshotId: createData?.snapshot?.id || null,
      plotId: getDraftPlotId(draft),
      anchor: draft.anchor || null,
      status: createData?.snapshot?.status || 'pending',
      resultImageUrl: '',
      snapshotUrl: `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}`,
      statusUrl: `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}/status`,
      expiresAt: createData?.snapshot?.expiresAt || null,
    });

    if (snapshotInfo) {
      renderInlineSnapshotCard(roomId, snapshotInfo, null);
      startRoomSnapshotPolling(roomId);
    }

    return {
      create: createData,
      characterSlots: {
        total: allCharacters.length,
        selected: selectedCharacters.length,
        primary: primaryCharacter.name || '',
        note: allCharacters.length > 1
          ? '현재 Worker는 대표 캐릭터 이미지 1장만 R2에 업로드하고, 나머지 캐릭터 정보/원본 이미지 URL은 character.characters에 저장함.'
          : '',
      },
      uploads: {
        character: charUpload,
        user: userUpload,
      },
      token,
      getSnapshotUrl: `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}`,
      getStatusUrl: `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}/status`,
    };
  }

  function buildDraftFromPlotEntry(plotId) {
    const entry = getPlotEntry(plotId);
    if (!entry) return null;

    const character = entry.character || {
      id: plotId,
      plotId,
      kind: 'character',
      name: '캐릭터',
      description: '',
      imageUrl: '',
      characters: [],
    };

    const characters =
      Array.isArray(character.characters) && character.characters.length
        ? character.characters
        : [character].filter(Boolean);

    const roomEntries = Object.values(entry.rooms || {});
    roomEntries.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    const latestRoomId = roomEntries[0]?.roomId || 'manual-room';

    const isCurrentPlot =
      plotId === getPlotIdFromUrl() ||
      plotId === state.activePlotId;

    const messages = isCurrentPlot ? collectRecentMessages() : [];

    return {
      source: 'plot-cache',
      plotId,
      roomId: latestRoomId,
      anchor: buildAnchor(messages),
      messages,
      stylePreset: entry.stylePreset || '2d',
      additionalInstructions: entry.additionalInstructions || CONFIG.DEFAULT_INSTRUCTIONS,
      character: {
        ...character,
        id: plotId,
        plotId,
        characters,
      },
      characters,
      userProfile: entry.userProfile || {
        id: null,
        kind: 'user',
        name: '유저',
        description: '',
        imageUrl: '',
        appearancePrompt: '',
      },
    };
  }

  function renderPlotTabs(activePlotId = null) {
    const root = qs('#zs-plot-tabs', state.overlay);
    if (!root) return;

    const store = getPlotStore();
    const entries = Object.entries(store)
      .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));

    root.innerHTML = '';

    if (!entries.length) {
      root.style.display = 'none';
      return;
    }

    root.style.display = 'flex';

    for (const [plotId, entry] of entries) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'zs-plot-tab';
      btn.dataset.zsAction = 'switch-plot';
      btn.dataset.zsPlotId = plotId;
      btn.title = plotId;

      if (plotId === activePlotId) {
        btn.classList.add('active');
      }

      const label = document.createElement('span');
      label.className = 'zs-plot-tab-label';
      label.textContent = getPlotLabel(entry, plotId);

      const count = Array.isArray(entry?.character?.characters)
        ? entry.character.characters.length
        : (entry?.character ? 1 : 0);

      const meta = document.createElement('span');
      meta.className = 'zs-plot-tab-meta';
      meta.textContent = count > 1 ? `${count}캐` : '';

      btn.append(label, meta);
      root.append(btn);
    }
  }

  function renderCharacterSlots(characters) {
    const root = qs('#zs-character-slots', state.overlay);
    if (!root) return;

    const list = Array.isArray(characters) && characters.length
      ? characters
      : [{
          id: crypto.randomUUID(),
          slotId: crypto.randomUUID(),
          name: '',
          description: '',
          imageUrl: '',
          appearancePrompt: '',
          included: true,
          primary: true,
        }];

    root.innerHTML = '';

    list.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'zs-char-card';
      card.dataset.charIndex = String(index);

      const head = document.createElement('div');
      head.className = 'zs-char-card-head';

      const title = document.createElement('strong');
      title.textContent = item.name || `캐릭터 ${index + 1}`;

      const controls = document.createElement('div');
      controls.className = 'zs-char-card-controls';

      const includeLabel = document.createElement('label');
      includeLabel.className = 'zs-inline-check';
      const include = document.createElement('input');
      include.type = 'checkbox';
      include.dataset.charField = 'included';
      include.checked = item.included !== false;
      includeLabel.append(include, document.createTextNode(' 이번 장면'));

      const primaryLabel = document.createElement('label');
      primaryLabel.className = 'zs-inline-check';
      const primary = document.createElement('input');
      primary.type = 'radio';
      primary.name = 'zs-primary-character';
      primary.dataset.charField = 'primary';
      primary.checked = !!item.primary;
      primaryLabel.append(primary, document.createTextNode(' 대표'));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'zs-char-remove';
      remove.dataset.zsAction = 'remove-character-slot';
      remove.dataset.zsRemoveCharacter = String(index);
      remove.textContent = '삭제';

      controls.append(includeLabel, primaryLabel, remove);
      head.append(title, controls);

      const grid = document.createElement('div');
      grid.className = 'zs-char-grid';

      const previewWrap = document.createElement('div');
      previewWrap.className = 'zs-char-preview-wrap';
      const preview = document.createElement('img');
      preview.className = 'zs-char-slot-preview';
      preview.dataset.charPreview = String(index);
      preview.alt = item.name || `캐릭터 ${index + 1}`;
      if (item.imageUrl) preview.src = item.imageUrl;
      previewWrap.append(preview);

      const fields = document.createElement('div');
      fields.className = 'zs-char-fields';

      const makeField = (labelText, field, value, textarea = false) => {
        const wrap = document.createElement('label');
        wrap.className = 'zs-char-field';
        const label = document.createElement('span');
        label.textContent = labelText;
        const input = textarea ? document.createElement('textarea') : document.createElement('input');
        if (!textarea) input.type = 'text';
        input.dataset.charField = field;
        input.value = value || '';
        wrap.append(label, input);
        return wrap;
      };

      fields.append(
        makeField('이름', 'name', item.name),
        makeField('원본 설명', 'description', item.description, true),
        makeField('외형 프롬프트 (원본 설명 복사 · 수정 가능)', 'appearancePrompt', item.appearancePrompt || item.description || '', true),
        makeField('프로필 이미지 URL', 'imageUrl', item.imageUrl)
      );

      const hiddenId = document.createElement('input');
      hiddenId.type = 'hidden';
      hiddenId.dataset.charField = 'id';
      hiddenId.value = item.id || '';

      const hiddenSlotId = document.createElement('input');
      hiddenSlotId.type = 'hidden';
      hiddenSlotId.dataset.charField = 'slotId';
      hiddenSlotId.value = item.slotId || item.id || crypto.randomUUID();

      card.append(head, grid);
      grid.append(previewWrap, fields);
      card.append(hiddenId, hiddenSlotId);
      root.append(card);
    });

    if (!root.querySelector('[data-char-field="primary"]:checked')) {
      const first = root.querySelector('[data-char-field="primary"]');
      if (first) first.checked = true;
    }
  }

  function readCharacterSlots() {
    const cards = qsa('.zs-char-card', state.overlay);
    const characters = cards.map((card, index) => {
      const get = field => card.querySelector(`[data-char-field="${field}"]`);
      return {
        id: get('id')?.value || null,
        slotId: get('slotId')?.value || `manual:${index + 1}`,
        kind: 'character',
        name: get('name')?.value?.trim() || `캐릭터 ${index + 1}`,
        description: get('description')?.value?.trim() || '',
        imageUrl: get('imageUrl')?.value?.trim() || '',
        appearancePrompt: get('appearancePrompt')?.value?.trim() || '',
        manualAppearancePrompt: get('appearancePrompt')?.value?.trim() || '',
        included: !!get('included')?.checked,
        primary: !!get('primary')?.checked,
      };
    });

    if (characters.length && !characters.some(item => item.primary)) {
      characters[0].primary = true;
    }

    return characters;
  }

  function ensureModal() {
    if (state.overlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'zs-overlay';
    overlay.innerHTML = `
      <div class="zs-modal">
        <div class="zs-head">
          <div class="zs-title">ZETA Snapshot Draft</div>
          <button class="zs-close" type="button">✕</button>
        </div>

        <div id="zs-plot-tabs" class="zs-plot-tabs"></div>

        <div class="zs-tools">
          <button type="button" data-zs-action="load-real">현재 플롯 다시 수집</button>
          <span class="zs-autosave-badge">자동 저장</span>
        </div>

        <div class="zs-body">
          <div class="zs-grid">
            <div class="zs-field">
              <label>화풍</label>
              <select id="zs-style">
                <option value="2d">2D 일러스트</option>
                <option value="semi">반실사</option>
                <option value="real">실사</option>
              </select>
            </div>

            <div class="zs-field">
              <label>Room ID</label>
              <input id="zs-room" type="text" />
            </div>

            <div class="zs-field zs-span2">
              <div class="zs-section-title-row">
                <label>캐릭터 슬롯</label>
                <button type="button" data-zs-action="add-character-slot">+ 슬롯 추가</button>
              </div>
              <div id="zs-character-slots" class="zs-character-slots"></div>
            </div>

            <div class="zs-field zs-span2">
              <label>유저 이름</label>
              <input id="zs-user-name" type="text" />
            </div>

            <div class="zs-field zs-span2">
              <label>유저 원본 설명</label>
              <textarea id="zs-user-desc"></textarea>
            </div>

            <div class="zs-field zs-span2">
              <label>유저 외형 프롬프트 (원본 설명 복사 · 수정 가능)</label>
              <textarea id="zs-user-appearance"></textarea>
            </div>

            <div class="zs-field">
              <label>유저 이미지 URL</label>
              <input id="zs-user-image" type="text" />
            </div>

            <div class="zs-field">
              <label>유저 프리뷰</label>
              <div class="zs-preview"><img id="zs-user-preview" /></div>
            </div>

            <div class="zs-field zs-span2">
              <label>추가 지침</label>
              <textarea id="zs-extra"></textarea>
            </div>

            <div class="zs-field zs-span2">
              <label>최근 대화 미리보기</label>
              <textarea id="zs-messages" readonly></textarea>
            </div>
          </div>

          <div class="zs-actions">
            <button type="button" class="primary" data-zs-action="send-relay">스냅샷 만들기</button>
            <button type="button" data-zs-action="close">닫기</button>
          </div>

          <div class="zs-result-wrap">
            <label>결과</label>
            <pre id="zs-result"></pre>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.resultBox = qs('#zs-result', overlay);

    qs('.zs-close', overlay).addEventListener('click', closeModal);

    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal();
    });

    overlay.addEventListener('click', async e => {
      const btn = e.target.closest('[data-zs-action]');
      if (!btn) return;

      const action = btn.dataset.zsAction;

      if (action === 'close') return closeModal();

      if (action === 'switch-plot') {
        const plotId = btn.dataset.zsPlotId;
        if (!plotId || plotId === state.activePlotId) return;

        if (state.currentDraft) {
          try {
            persistFromDraft(readFormToDraft());
          } catch (err) {
            console.warn('[ZETA Snapshot] plot switch save failed', err);
          }
        }

        const cachedDraft = buildDraftFromPlotEntry(plotId);
        if (!cachedDraft) {
          flash('저장된 플롯 정보를 찾지 못했어.');
          return;
        }

        openDraft(cachedDraft);
        flash(`${getPlotLabel(getPlotEntry(plotId), plotId)} 탭`);
        return;
      }

      if (action === 'load-real') {
        state.resultBox.textContent = '자동 수집 중...';
        try {
          return openDraft(await buildDraftFromCache());
        } catch (err) {
          state.resultBox.textContent = `자동 수집 오류:\n${String(err.message || err)}`;
          return;
        }
      }
      if (action === 'add-character-slot') {
        const characters = readCharacterSlots();
        characters.push({
          id: null,
          slotId: crypto.randomUUID(),
          name: '',
          description: '',
          imageUrl: '',
          appearancePrompt: '',
          included: true,
          primary: !characters.length,
        });
        renderCharacterSlots(characters);
        return;
      }

      if (btn.dataset.zsRemoveCharacter != null) {
        const index = Number(btn.dataset.zsRemoveCharacter);
        const characters = readCharacterSlots();
        characters.splice(index, 1);
        renderCharacterSlots(characters);
        return;
      }

      if (action === 'save-local') {
        const draft = readFormToDraft();
        persistFromDraft(draft);
        flash('현재 값 로컬 저장 완료');
        state.resultBox.textContent = '로컬 저장 완료';
        return;
      }

      if (action === 'send-relay') {
        try {
          const draft = readFormToDraft();
          persistFromDraft(draft);
          state.resultBox.textContent = '전송 중...';
          const result = await sendDraftToRelay(draft);
          state.resultBox.textContent = [
            '스냅샷 생성 완료',
            '',
            result.getSnapshotUrl || '',
            '',
            'ChatGPT에서 위 스냅샷 URL을 ZETA Snapshot Generator에 전달해 이미지를 생성해줘.',
            '결과가 Worker에 저장되면 현재 대화 아래 카드에 자동 표시돼.'
          ].join('\n');
          flash('스냅샷 생성 완료');
        } catch (err) {
          console.error(err);
          state.resultBox.textContent = `오류:\n${String(err.message || err)}`;
          flash('전송 실패');
        }
      }
    });

    overlay.addEventListener('input', e => {
      if (e.target.matches('[data-char-field="imageUrl"]')) {
        const card = e.target.closest('.zs-char-card');
        const preview = card?.querySelector('.zs-char-slot-preview');
        if (preview) preview.src = e.target.value || '';
      }

      if (e.target.matches('[data-char-field="name"]')) {
        const card = e.target.closest('.zs-char-card');
        const title = card?.querySelector('.zs-char-card-head strong');
        if (title) title.textContent = e.target.value.trim() || '캐릭터';
      }

      if (e.target.id === 'zs-user-image') {
        qs('#zs-user-preview', overlay).src = e.target.value || '';
      }

      scheduleDraftAutosave();
    });

    overlay.addEventListener('change', () => {
      scheduleDraftAutosave();
    });
  }

  function openModal() {
    ensureModal();
    state.overlay.style.display = 'flex';
  }

  function closeModal() {
    if (state.currentDraft && state.overlay && state.overlay.style.display !== 'none') {
      try {
        const draft = readFormToDraft();
        persistFromDraft(draft);
        state.currentDraft = structuredClone(draft);
      } catch (err) {
        console.warn('[ZETA Snapshot] close autosave failed', err);
      }
    }
    if (state.overlay) state.overlay.style.display = 'none';
  }

  function openDraft(draft) {
    ensureModal();
    openModal();
    state.currentDraft = structuredClone(draft);
    state.activePlotId = getDraftPlotId(draft) || state.activePlotId || null;

    renderPlotTabs(state.activePlotId);

    qs('#zs-style').value = draft.stylePreset || '2d';
    qs('#zs-room').value = draft.roomId || '';

    const characters =
      Array.isArray(draft.characters) && draft.characters.length
        ? draft.characters
        : (Array.isArray(draft.character?.characters) && draft.character.characters.length
            ? draft.character.characters
            : [draft.character].filter(Boolean));

    renderCharacterSlots(characters.map(item => ({
      ...item,
      appearancePrompt: item.appearancePrompt || item.description || '',
    })));

    qs('#zs-user-name').value = draft.userProfile.name || '';
    qs('#zs-user-desc').value = draft.userProfile.description || '';
    qs('#zs-user-appearance').value =
      draft.userProfile.appearancePrompt ||
      draft.userProfile.description ||
      '';
    qs('#zs-user-image').value = draft.userProfile.imageUrl || '';
    qs('#zs-user-preview').src = draft.userProfile.imageUrl || '';

    qs('#zs-extra').value = draft.additionalInstructions || CONFIG.DEFAULT_INSTRUCTIONS;
    qs('#zs-messages').value = (draft.messages || [])
      .map(m => `[${m.speaker}] ${m.text}`)
      .join('\n');

    state.resultBox.textContent = '';
  }

  function readFormToDraft() {
    const messages = state.currentDraft?.messages || collectRecentMessages();
    const anchor = state.currentDraft?.anchor || buildAnchor(messages);
    const characters = readCharacterSlots();

    const primaryCharacter =
      characters.find(item => item.primary) ||
      characters.find(item => item.included) ||
      characters[0] ||
      {};

    const previousGroup = state.currentDraft?.character || {};

    const plotId =
      state.activePlotId ||
      getDraftPlotId(state.currentDraft) ||
      getPlotIdFromUrl() ||
      previousGroup.plotId ||
      previousGroup.id ||
      null;

    return {
      source: state.currentDraft?.source || 'form',
      plotId,
      roomId: qs('#zs-room').value.trim() || getRoomId(),
      anchor,
      messages,
      stylePreset: qs('#zs-style').value,
      additionalInstructions: qs('#zs-extra').value.trim(),
      characters,
      character: {
        ...previousGroup,
        id: plotId,
        plotId,
        kind: characters.length > 1 ? 'character_group' : 'character',
        name: primaryCharacter.name || '',
        description: primaryCharacter.description || '',
        imageUrl: primaryCharacter.imageUrl || '',
        appearancePrompt: primaryCharacter.appearancePrompt || '',
        manualAppearancePrompt: primaryCharacter.appearancePrompt || '',
        characters,
      },
      userProfile: {
        ...(state.currentDraft?.userProfile || {}),
        name: qs('#zs-user-name').value.trim(),
        description: qs('#zs-user-desc').value.trim(),
        imageUrl: qs('#zs-user-image').value.trim(),
        appearancePrompt: qs('#zs-user-appearance').value.trim(),
        manualAppearancePrompt: qs('#zs-user-appearance').value.trim(),
      },
    };
  }

  function persistFromDraft(draft) {
    save(CONFIG.STORAGE.GLOBAL, {
      stylePreset: draft.stylePreset,
      additionalInstructions: draft.additionalInstructions,
    });

    save(CONFIG.STORAGE.CHARACTER, {
      ...(load(CONFIG.STORAGE.CHARACTER, {}) || {}),
      ...draft.character,
      characters: draft.characters || draft.character?.characters || [],
      updatedAt: Date.now(),
    });

    save(CONFIG.STORAGE.USER, {
      ...(load(CONFIG.STORAGE.USER, {}) || {}),
      ...draft.userProfile,
      updatedAt: Date.now(),
    });

    const plotId = getDraftPlotId(draft);
    if (plotId) {
      const roomId = draft.roomId || 'manual-room';
      upsertPlotEntry(plotId, {
        title:
          draft.character?.plotTitle ||
          getPlotEntry(plotId)?.title ||
          draft.character?.name ||
          '',
        character: {
          ...draft.character,
          id: plotId,
          plotId,
          characters: draft.characters || draft.character?.characters || [],
        },
        userProfile: draft.userProfile,
        stylePreset: draft.stylePreset,
        additionalInstructions: draft.additionalInstructions,
        rooms: roomId && roomId !== 'manual-room'
          ? {
              [roomId]: {
                roomId,
                lastUsedAt: Date.now(),
              },
            }
          : {},
      });

      state.activePlotId = plotId;
      renderPlotTabs(plotId);
    }
  }

  function createLauncher() {
    if (qs('.zs-launcher')) return;

    const wrap = document.createElement('div');
    wrap.className = 'zs-launcher';
    wrap.innerHTML = `
      <button type="button" data-zs-launch="draft" title="ZETA Snapshot">📷</button>
    `;

    wrap.addEventListener('click', e => {
      const btn = e.target.closest('[data-zs-launch="draft"]');
      if (!btn) return;

      (async () => {
        try {
          flash('프로필 수집 중...');
          openDraft(await buildDraftFromCache());
          flash('수집 완료');
        } catch (err) {
          console.error(err);
          alert(String(err.message || err));
        }
      })();
    });

    document.body.appendChild(wrap);
  }

  function injectStyles() {
    if (qs('#zs-snapshot-test-style')) return;

    const style = document.createElement('style');
    style.id = 'zs-snapshot-test-style';
    style.textContent = `
      .zs-launcher{
        position:fixed;
        right:18px;
        bottom:18px;
        z-index:999999;
        display:flex;
        flex-direction:column;
        gap:8px;
      }
      .zs-launcher button{
        width:46px;
        height:46px;
        border:none;
        border-radius:14px;
        cursor:pointer;
        background:#111827;
        color:#fff;
        box-shadow:0 8px 24px rgba(0,0,0,.22);
        font-size:20px;
      }
      .zs-launcher button:hover{ transform:translateY(-1px); }

      .zs-overlay{
        position:fixed;
        inset:0;
        background:rgba(0,0,0,.48);
        z-index:9999999;
        display:none;
        align-items:center;
        justify-content:center;
        padding:24px;
      }
      .zs-modal{
        width:min(980px, 96vw);
        max-height:92vh;
        overflow:hidden;
        display:flex;
        flex-direction:column;
        background:#fff;
        color:#111827;
        border-radius:18px;
        box-shadow:0 20px 60px rgba(0,0,0,.25);
      }
      .zs-head{
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:16px 18px;
        border-bottom:1px solid #e5e7eb;
      }
      .zs-title{
        font-size:18px;
        font-weight:700;
      }
      .zs-close{
        border:none;
        background:none;
        color:#111827;
        font-size:20px;
        cursor:pointer;
      }
      .zs-plot-tabs{
        display:none;
        gap:8px;
        overflow-x:auto;
        padding:10px 18px 0;
        scrollbar-width:thin;
      }
      .zs-plot-tab{
        flex:0 0 auto;
        min-height:34px;
        display:flex;
        align-items:center;
        gap:7px;
        max-width:210px;
        border:1px solid #dbe1e8;
        background:#f8fafc;
        color:#475569;
        padding:9px 14px;
        border-radius:999px;
        cursor:pointer;
        font-size:13px;
        line-height:1;
      }
      .zs-plot-tab:hover{
        background:#f1f5f9;
      }
      .zs-plot-tab.active{
        background:#111827;
        border-color:#111827;
        color:#fff;
      }
      .zs-plot-tab-label{
        max-width:150px;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font-weight:700;
      }
      .zs-plot-tab-meta{
        font-size:10px;
        opacity:.72;
      }
      .zs-tools{
        display:flex;
        gap:8px;
        flex-wrap:wrap;
        padding:12px 18px 0;
      }
      .zs-autosave-badge{
        display:inline-flex;
        align-items:center;
        padding:0 4px;
        font-size:12px;
        color:#64748b;
      }
      .zs-tools button,
      .zs-actions button{
        border:none;
        background:#e5e7eb;
        color:#111827;
        padding:10px 12px;
        border-radius:10px;
        cursor:pointer;
        font-size:13px;
      }
      .zs-actions button.primary{
        background:#111827;
        color:#fff;
      }
      .zs-body{
        overflow:auto;
        padding:16px 18px 18px;
      }
      .zs-grid{
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:14px;
      }
      .zs-field{
        display:flex;
        flex-direction:column;
        gap:6px;
      }
      .zs-span2{ grid-column:span 2; }
      .zs-section-title-row{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
      }
      .zs-section-title-row > button{
        border:1px solid #d1d5db;
        background:#f8fafc;
        color:#334155;
        padding:7px 10px;
        border-radius:9px;
        cursor:pointer;
        font-size:12px;
      }
      .zs-character-slots{
        display:flex;
        flex-direction:column;
        gap:12px;
      }
      .zs-char-card{
        border:1px solid #dbe1e8;
        border-radius:14px;
        padding:12px;
        background:#f8fafc;
      }
      .zs-char-card-head{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        margin-bottom:10px;
      }
      .zs-char-card-head strong{
        min-width:0;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font-size:14px;
      }
      .zs-char-card-controls{
        display:flex;
        align-items:center;
        gap:8px;
        flex-wrap:wrap;
        justify-content:flex-end;
      }
      .zs-inline-check{
        display:flex!important;
        flex-direction:row!important;
        align-items:center;
        gap:4px!important;
        font-size:12px!important;
        font-weight:500!important;
        white-space:nowrap;
      }
      .zs-inline-check input{
        width:auto!important;
        margin:0;
      }
      .zs-char-remove{
        border:none;
        background:#e5e7eb;
        color:#475569;
        border-radius:8px;
        padding:6px 8px;
        font-size:11px;
        cursor:pointer;
      }
      .zs-char-grid{
        display:grid;
        grid-template-columns:132px minmax(0,1fr);
        gap:12px;
        align-items:start;
      }
      .zs-char-preview-wrap{
        width:120px;
        height:120px;
        border:1px dashed #cbd5e1;
        border-radius:12px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#fff;
        overflow:hidden;
      }
      .zs-char-slot-preview{
        width:120px;
        height:120px;
        object-fit:cover;
        display:block;
      }
      .zs-char-fields{
        display:flex;
        flex-direction:column;
        gap:8px;
        min-width:0;
      }
      .zs-char-field{
        display:flex;
        flex-direction:column;
        gap:5px;
      }
      .zs-char-field > span{
        font-size:12px;
        font-weight:700;
        color:#475569;
      }
      .zs-char-field input,
      .zs-char-field textarea{
        width:100%;
        border:1px solid #d1d5db;
        border-radius:9px;
        padding:9px 10px;
        background:#fff;
        color:#111827;
        box-sizing:border-box;
        font-size:12px;
        line-height:1.45;
      }
      .zs-char-field textarea{
        min-height:78px;
        resize:vertical;
      }
      .zs-field label{
        font-size:13px;
        font-weight:700;
        color:#374151;
      }
      .zs-field input,
      .zs-field select,
      .zs-field textarea{
        width:100%;
        border:1px solid #d1d5db;
        border-radius:10px;
        padding:10px 12px;
        background:#fff;
        color:#111827;
        font-size:13px;
        line-height:1.45;
        box-sizing:border-box;
      }
      .zs-field textarea{
        min-height:94px;
        resize:vertical;
      }
      .zs-preview{
        width:100%;
        min-height:110px;
        border:1px dashed #cbd5e1;
        border-radius:12px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#f8fafc;
        overflow:hidden;
      }
      .zs-preview img{
        width:120px;
        height:120px;
        object-fit:cover;
        border-radius:12px;
        display:block;
      }
      .zs-actions{
        display:flex;
        gap:8px;
        flex-wrap:wrap;
        margin-top:18px;
      }
      .zs-result-wrap{
        margin-top:16px;
      }
      .zs-result-wrap label{
        display:block;
        font-size:13px;
        font-weight:700;
        color:#374151;
        margin-bottom:6px;
      }
      #zs-result{
        margin:0;
        min-height:120px;
        max-height:280px;
        overflow:auto;
        background:#0f172a;
        color:#e2e8f0;
        border-radius:12px;
        padding:12px;
        font-size:12px;
        line-height:1.5;
      }

      .zs-inline-card{
        box-sizing:border-box;
        width:min(640px, calc(100% - 32px));
        margin:14px auto;
        padding:12px;
        border:1px solid rgba(148,163,184,.28);
        border-radius:16px;
        background:rgba(255,255,255,.96);
        color:#111827;
        box-shadow:0 6px 22px rgba(15,23,42,.08);
        position:relative;
        z-index:2;
      }
      .zs-inline-card-head{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        margin-bottom:10px;
      }
      .zs-inline-card-head > div:first-child{
        display:flex;
        align-items:center;
        gap:8px;
        min-width:0;
      }
      .zs-inline-card-head strong{ font-size:13px; }
      .zs-inline-status{
        font-size:11px;
        color:#64748b;
        background:#f1f5f9;
        border-radius:999px;
        padding:4px 7px;
      }
      .zs-inline-status[data-status="completed"]{
        background:#dcfce7;
        color:#166534;
      }
      .zs-inline-status[data-status="failed"]{
        background:#fee2e2;
        color:#991b1b;
      }
      .zs-inline-card-actions{
        display:flex;
        gap:6px;
        flex-wrap:wrap;
        justify-content:flex-end;
      }
      .zs-inline-card-actions button{
        border:none;
        border-radius:8px;
        padding:7px 9px;
        background:#e5e7eb;
        color:#111827;
        font-size:11px;
        cursor:pointer;
      }
      .zs-inline-result-image{
        display:block;
        width:100%;
        max-height:720px;
        object-fit:contain;
        border-radius:12px;
        background:#f8fafc;
      }
      .zs-inline-waiting{
        padding:16px 10px;
        border-radius:12px;
        background:#f8fafc;
        color:#64748b;
        font-size:12px;
        text-align:center;
      }
      .zs-inline-error{
        margin-top:8px;
        color:#b91c1c;
        font-size:11px;
        line-height:1.45;
      }
      .zs-toast{
        position:fixed;
        left:50%;
        bottom:26px;
        transform:translateX(-50%) translateY(10px);
        background:#111827;
        color:#fff;
        padding:10px 14px;
        border-radius:999px;
        font-size:13px;
        z-index:10000000;
        opacity:0;
        transition:.2s ease;
        pointer-events:none;
      }
      .zs-toast.show{
        opacity:1;
        transform:translateX(-50%) translateY(0);
      }
      @media (max-width:760px){
        .zs-grid{ grid-template-columns:1fr; }
        .zs-span2{ grid-column:span 1; }
        .zs-overlay{ padding:8px; }
        .zs-modal{ width:100%; max-height:96vh; border-radius:14px; }
        .zs-char-grid{ grid-template-columns:1fr; }
        .zs-char-preview-wrap{ width:100%; height:150px; }
        .zs-char-slot-preview{ width:150px; height:150px; }
        .zs-char-card-head{ align-items:flex-start; flex-direction:column; }
        .zs-char-card-controls{ justify-content:flex-start; }
      }
    `;

    document.head.appendChild(style);
  }

  function init() {
    injectStyles();
    createLauncher();
    watchRoomNavigation();
    setTimeout(restoreSnapshotForCurrentRoom, 900);
    console.log('[ZETA Snapshot] v0.5.0 ready');
  }

  init();
})();