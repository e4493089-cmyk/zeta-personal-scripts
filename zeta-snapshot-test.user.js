// ==UserScript==
// @name         ZETA Snapshot
// @namespace    zeta-snapshot-test
// @version      0.7.1
// @description  ZETA Snapshot collector + ChatGPT bridge + automatic result write-back
// @match        https://zeta-ai.io/*
// @match        https://www.zeta-ai.io/*
// @match        https://chatgpt.com/*
// @match        https://www.chatgpt.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      image.zeta-ai.io
// @connect      zeta-snapshot.kwillhs.workers.dev
// @connect      files.oaiusercontent.com
// @connect      *.oaiusercontent.com
// @connect      cdn.openai.com
// ==/UserScript==

(() => {
  'use strict';

  const IS_CHATGPT_HOST = /(^|\.)chatgpt\.com$/i.test(location.hostname);
  const IS_ZETA_HOST = /(^|\.)zeta-ai\.io$/i.test(location.hostname);

  const CONFIG = {
    RELAY_BASE: 'https://zeta-snapshot.kwillhs.workers.dev',
    MESSAGE_LIMIT: 12,
    STORAGE: {
      CHARACTER: 'zetaSnapshot.characterCache.v1',
      USER: 'zetaSnapshot.userCache.v1',
      GLOBAL: 'zetaSnapshot.globalSettings.v1',
      PLOTS: 'zetaSnapshot.plots.v1',
      SNAPSHOTS: 'zetaSnapshot.roomSnapshots.v1',
      COLLECT_SESSION: 'zetaSnapshot.collectSession.v1',
      LAUNCHER_POS: 'zetaSnapshot.launcherPosition.v1',
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
    inlineMountTimers: new Map(),
    lastCreatedSnapshotInfo: null,
    lastObservedRoomId: null,
    collectResumeBusy: false,
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

    // /rooms/:roomId 자체에는 plotId가 없다.
    // 대화방에서는 헤더의 "Open plot profile" 버튼을 자동으로 눌러
    // 실제 프로필 URL로 이동한 뒤 plotId를 얻는다.
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
    // 최근 대화는 대화방에서만 수집한다.
    // 프로필 페이지의 댓글/설명 DOM을 대화로 오인하지 않는다.
    if (!/\/rooms\/[^/?#]+/.test(location.pathname)) return [];

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

  function getProfileHubRoot() {
    const group = qs('[role="group"][aria-label="My chat profiles"]');
    if (!group) return null;
    return (
      group.closest('section[role="dialog"]') ||
      group.closest('[role="dialog"]') ||
      group.closest('section') ||
      group
    );
  }

  function collectCurrentUserProfileFromRoomCard(plotId = null, roomId = null) {
    if (!/\/rooms\/[^/?#]+/.test(location.pathname)) return null;

    // 현재 대화방에서는 유저 메시지 오른쪽 아바타가
    // 현재 사용중인 유저 프로필을 그대로 보여준다.
    const rows = qsa('[data-sentry-component="RightTextContent"]');
    const row = rows[rows.length - 1];
    if (!row) return null;

    const name =
      cleanText(qs('.caption1', row)?.textContent) ||
      cleanText(qs('img', row)?.alt) ||
      '유저';

    const profileButton = Array.from(row.children || [])
      .find(el => el?.tagName === 'BUTTON' && el.querySelector('img')) ||
      qsa('button', row).find(btn => btn.querySelector('img'));

    const imageUrl = imageUrlFromImg(qs('img', profileButton || row));

    if (!name && !imageUrl) return null;

    return {
      id: null,
      kind: 'user',
      name,
      description: '',
      imageUrl,
      plotId,
      roomId: roomId || getRoomId(),
      source: 'room-user-message-avatar',
      updatedAt: Date.now(),
    };
  }

  function collectSelectedUserProfileFromDialog(fallbackProfile = null) {
    const dialog =
      qs('#portal-container section[role="dialog"][aria-label="대화 프로필"]') ||
      qs('section[role="dialog"][aria-label="대화 프로필"]');

    if (!dialog) {
      if (fallbackProfile) return fallbackProfile;
      throw new Error('대화 프로필 창을 찾지 못했어.');
    }

    const items = qsa('[data-sentry-component="ChatProfileListItem"]', dialog);
    if (!items.length) {
      if (fallbackProfile) return fallbackProfile;
      throw new Error('대화 프로필 목록을 찾지 못했어.');
    }

    // 현재 선택된 프로필은 "추천 대화 프로필" 영역에 있을 수도 있다.
    // 실제 DOM에서는 선택된 항목의 메인 버튼이 disabled이고 체크 배지가 붙는다.
    let active = items.find(item => {
      const selectedMarker = qs(
        '.kt-profile-hub-selected, div[class*="bg-primary-400"], [aria-checked="true"], [data-state="checked"]',
        item
      );
      const mainButton = Array.from(item.children || []).find(el => el?.tagName === 'BUTTON');
      return !!selectedMarker || !!mainButton?.disabled;
    });

    if (!active && fallbackProfile) {
      const fallbackName = cleanText(fallbackProfile.name || '');
      const fallbackImage = stripImageTransform(fallbackProfile.imageUrl || '');

      active = items.find(item => {
        const itemName = cleanText(qs('.body1', item)?.textContent || '');
        const itemImage = stripImageTransform(imageUrlFromImg(qs('img', item)));
        return (
          (fallbackName && itemName === fallbackName) ||
          (fallbackImage && itemImage && itemImage === fallbackImage)
        );
      });
    }

    if (!active) {
      if (fallbackProfile) return fallbackProfile;
      throw new Error('현재 사용중인 대화 프로필을 찾지 못했어.');
    }

    const name =
      cleanText(qs('.body1', active)?.textContent) ||
      cleanText(qs('img', active)?.alt) ||
      fallbackProfile?.name ||
      '유저';

    const description =
      cleanText(qs('.caption1', active)?.textContent) ||
      fallbackProfile?.description ||
      '';

    const imageUrl =
      imageUrlFromImg(qs('img', active)) ||
      fallbackProfile?.imageUrl ||
      '';

    const editLabel =
      qs('button[aria-label^="edit-"]', active)?.getAttribute('aria-label') || '';
    const id = editLabel.startsWith('edit-')
      ? editLabel.slice(5)
      : (fallbackProfile?.id || null);

    const profile = {
      ...fallbackProfile,
      id,
      kind: 'user',
      name,
      description,
      imageUrl,
      source: 'dialog-selected-profile',
      updatedAt: Date.now(),
    };

    save(CONFIG.STORAGE.USER, profile);
    return profile;
  }

  function isUsableUserProfileImage(url) {
    const value = String(url || '');
    if (!value) return false;
    if (/default-profile|default_profile|placeholder|avatar-default/i.test(value)) return false;
    return /\/user-(?:plot-)?chat-profile-image\//.test(value);
  }

  function extractUserProfileImageFromHtml(html) {
    const normalized = String(html || '')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/\\\//g, '/');

    const matches = normalized.match(
      /https:\/\/image\.zeta-ai\.io\/user-(?:plot-)?chat-profile-image\/[^"'<>\\\s)]+/g
    ) || [];

    const candidates = matches
      .map(url => stripImageTransform(url))
      .filter(isUsableUserProfileImage);

    return candidates[0] || '';
  }

  function parseUserProfileEditDoc(doc, plotId, roomId, fallbackImageUrl = '') {
    const name = cleanText(doc.querySelector('input[name="name"]')?.value || '');
    const description = String(doc.querySelector('textarea[name="description"]')?.value || '').trim();

    const imgs = [...doc.querySelectorAll('img[alt="profile image"], img[src*="user-plot-chat-profile-image"], img[src*="user-chat-profile-image"]')];
    const imageUrl =
      imgs.map(img => imageUrlFromImg(img))
        .find(isUsableUserProfileImage) ||
      (isUsableUserProfileImage(fallbackImageUrl) ? stripImageTransform(fallbackImageUrl) : '');

    const imageProfileId =
      imageUrl.match(/\/user-(?:plot-)?chat-profile-image\/([^/]+)\//)?.[1] || null;

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

  async function buildDraftFromCache(overrides = {}) {
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

    const roomId = overrides.roomId || getRoomId();
    const plotId =
      overrides.plotId ||
      getPlotIdFromUrl() ||
      state.activePlotId ||
      legacyCharacter?.plotId ||
      legacyCharacter?.id ||
      null;

    const plotEntry = getPlotEntry(plotId);

    let character = overrides.character || plotEntry?.character || legacyCharacter;
    let userProfile = overrides.userProfile || plotEntry?.userProfile || legacyUser;

    if (plotId && !overrides.skipAutoCollect && !overrides.character) {
      try {
        character = await collectCharacterProfileById(plotId);
      } catch (err) {
        console.warn('[ZETA Snapshot] character auto collect failed', err);
      }
    }

    if (
      plotId &&
      roomId &&
      roomId !== 'manual-room' &&
      !overrides.skipAutoCollect &&
      !overrides.userProfile
    ) {
      try {
        userProfile = await collectCurrentUserProfileFromEditPage(plotId, roomId);
      } catch (err) {
        console.warn('[ZETA Snapshot] user profile auto collect failed', err);
      }
    }

    const global = load(CONFIG.STORAGE.GLOBAL, {});
    const refreshedEntry = getPlotEntry(plotId) || plotEntry || {};
    const messages = Array.isArray(overrides.messages)
      ? overrides.messages
      : collectRecentMessages();

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

    const includedCharacters = characters.filter(item => item.included !== false);
    const includedPrimary = includedCharacters.find(item => item.primary);

    if (!includedPrimary && includedCharacters[0]) {
      characters.forEach(item => { item.primary = false; });
      includedCharacters[0].primary = true;
    }

    const primaryCharacter =
      includedCharacters.find(item => item.primary) ||
      includedCharacters[0] ||
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

  function inferSpeakerFromNode(node) {
    const kind = node?.getAttribute?.('data-sentry-component') || '';
    if (kind === 'LeftTextContent') return 'character';
    if (kind === 'RightTextContent') return 'user';
    if (kind === 'NarratorBubble') return 'narrator';
    return 'unknown';
  }

  function findAnchorElement(anchor, allowFallback = false) {
    const preview = cleanText(anchor?.preview || '');
    const hash = String(anchor?.hash || '');
    const nodes = qsa([
      '[data-sentry-component="LeftTextContent"]',
      '[data-sentry-component="RightTextContent"]',
      '[data-sentry-component="NarratorBubble"]'
    ].join(','));

    for (let i = nodes.length - 1; i >= 0; i--) {
      const text = cleanText(qs('.chat', nodes[i])?.innerText || nodes[i].innerText || '');
      if (!text) continue;

      if (hash) {
        const speaker = inferSpeakerFromNode(nodes[i]);
        if (simpleHash(`${speaker}:${text}`) === hash) return nodes[i];
      }

      if (
        preview &&
        (text === preview ||
         text.startsWith(preview) ||
         preview.startsWith(text.slice(0, 100)))
      ) {
        return nodes[i];
      }
    }

    if (allowFallback) return nodes[nodes.length - 1] || null;
    return null;
  }

  function getInlineCardId(roomId, token) {
    const safeRoom = String(roomId || 'room').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeToken = String(token || 'token').slice(0, 10).replace(/[^a-zA-Z0-9_-]/g, '_');
    return `zs-inline-${safeRoom}-${safeToken}`;
  }

  function getAnchorHost(anchorEl) {
    return (
      anchorEl?.closest?.('[data-index][data-key]') ||
      anchorEl?.closest?.('[data-sentry-component="ChatMessage"], [data-sentry-component="MessageItem"], li, article') ||
      anchorEl ||
      null
    );
  }

  function placeInlineCard(card, info = {}, allowFallback = false) {
    const anchorEl = findAnchorElement(info.anchor, allowFallback);
    const host = getAnchorHost(anchorEl);
    if (!host?.parentNode) {
      if (allowFallback) {
        const notice = qs('[data-testid="plugin-notice-slot"]');
        if (notice) {
          card.classList.remove('zs-inline-floating');
          notice.appendChild(card);
          card.style.display = '';
          return true;
        }

        if (document.body) {
          if (card.parentNode !== document.body) document.body.appendChild(card);
          card.classList.add('zs-inline-floating');
          card.style.display = '';
          return true;
        }
      }
      return false;
    }

    card.classList.remove('zs-inline-floating');
    if (card.previousElementSibling !== host || card.parentNode !== host.parentNode) {
      host.insertAdjacentElement('afterend', card);
    }
    card.style.display = '';
    return true;
  }

  function scheduleInlineCardMount(roomId, info = {}) {
    const key = getInlineCardId(roomId, info.token);
    if (state.inlineMountTimers.has(key)) return;

    let attempt = 0;
    const timer = setInterval(() => {
      attempt += 1;
      const card = document.getElementById(key);
      if (!card) {
        clearInterval(timer);
        state.inlineMountTimers.delete(key);
        return;
      }

      const placed = placeInlineCard(card, info, attempt >= 6);
      if (placed || attempt >= 10) {
        clearInterval(timer);
        state.inlineMountTimers.delete(key);
      }
    }, 350);

    state.inlineMountTimers.set(key, timer);
  }

  function ensureInlineCard(roomId, info = {}) {
    if (!roomId || roomId === 'manual-room' || !info?.token) return null;
    const id = getInlineCardId(roomId, info.token);
    let card = document.getElementById(id);

    if (!card) {
      card = document.createElement('section');
      card.id = id;
      card.className = 'zs-inline-card';
      card.dataset.zsRoomId = roomId;
      card.dataset.zsToken = info.token;
      card.style.display = 'none';
      document.body.appendChild(card);

      card.addEventListener('click', async e => {
        const btn = e.target.closest('[data-zs-inline-action]');
        if (!btn) return;

        if (btn.dataset.zsInlineAction === 'refresh') {
          await refreshRoomSnapshot(roomId, true).catch(err => flash(String(err.message || err)));
          return;
        }

        if (btn.dataset.zsInlineAction === 'chatgpt') {
          const current = getRoomSnapshotInfo(roomId) || info;
          await openSnapshotInChatGPT(current);
          return;
        }
      });
    }

    if (!placeInlineCard(card, info, false)) {
      scheduleInlineCardMount(roomId, info);
    }

    return card;
  }

  function buildChatGPTPrompt(snapshotUrl) {
    return [
      '[@ZETA Snapshot Generator](plugin://zeta-snapshot-generator@created-by-me-remote)',
      '이 스냅샷을 불러와서 포함된 캐릭터/유저 프로필, 최근 장면, 저장된 스타일을 반영해 이미지를 생성해줘.',
      '참조 이미지가 있으면 같이 사용해.',
      '이미지 생성이 끝나면 가능한 경우 같은 스냅샷에 결과를 저장해.',
      snapshotUrl || ''
    ].filter(Boolean).join('\n');
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  function getChatGPTBridgeToken() {
    const url = new URL(location.href);
    const fromUrl = String(url.searchParams.get('zeta_snapshot') || '').trim();
    if (fromUrl) {
      sessionStorage.setItem('zetaSnapshot.bridgeToken', fromUrl);
      return fromUrl;
    }
    return String(sessionStorage.getItem('zetaSnapshot.bridgeToken') || '').trim();
  }

  function getChatGPTBridgePrompt() {
    const url = new URL(location.href);
    const fromUrl = String(url.searchParams.get('prompt') || url.searchParams.get('q') || '').trim();
    if (fromUrl) {
      sessionStorage.setItem('zetaSnapshot.bridgePrompt', fromUrl);
      return fromUrl;
    }
    return String(sessionStorage.getItem('zetaSnapshot.bridgePrompt') || '').trim();
  }

  function buildChatGPTHandoffUrl(info = {}) {
    const snapshotUrl =
      info.snapshotUrl ||
      (info.token ? `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(info.token)}` : '');
    if (!snapshotUrl || !info.token) return '';

    const url = new URL('https://chatgpt.com/');
    url.searchParams.set('prompt', buildChatGPTPrompt(snapshotUrl));
    url.searchParams.set('zeta_snapshot', info.token);
    return url.toString();
  }

  function showChatGPTBridgeBadge(message, tone = 'normal') {
    let badge = document.getElementById('zs-chatgpt-bridge-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'zs-chatgpt-bridge-badge';
      Object.assign(badge.style, {
        position: 'fixed',
        right: '14px',
        bottom: '14px',
        zIndex: '2147483647',
        maxWidth: 'min(360px, calc(100vw - 28px))',
        padding: '10px 13px',
        borderRadius: '12px',
        background: '#ffffff',
        color: '#111827',
        border: '1px solid #e5e7eb',
        boxShadow: '0 10px 30px rgba(0,0,0,.16)',
        fontSize: '12px',
        fontWeight: '700',
        lineHeight: '1.45',
        fontFamily: 'system-ui, -apple-system, sans-serif'
      });
      document.body.appendChild(badge);
    }
    badge.textContent = message;
    badge.style.color = tone === 'error' ? '#b91c1c' : tone === 'success' ? '#047857' : '#111827';
  }

  function setChatGPTComposerText(prompt) {
    if (!prompt) return false;
    const composer =
      document.querySelector('#prompt-textarea') ||
      document.querySelector('textarea[name="prompt-textarea"]') ||
      document.querySelector('main [contenteditable="true"][data-placeholder]');

    if (!composer) return false;

    const current = String(
      composer.value ??
      composer.innerText ??
      composer.textContent ??
      ''
    ).trim();

    if (current) return current.includes('ZETA Snapshot Generator') || current.includes('/snapshots/');

    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(composer, prompt);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    try {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, prompt);
    } catch {
      composer.textContent = prompt;
    }
    composer.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: prompt
    }));
    return true;
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
          if (response.status >= 200 && response.status < 300 && response.response) {
            resolve(response.response);
          } else {
            reject(new Error(`이미지 가져오기 실패: ${response.status}`));
          }
        },
        onerror: () => reject(new Error('이미지 가져오기 실패')),
      });
    });
  }

  async function fetchBridgeImageBlob(src) {
    if (!src) throw new Error('생성 이미지 URL이 없어.');
    const absolute = new URL(src, location.href).toString();

    if (
      absolute.startsWith('blob:') ||
      absolute.startsWith('data:') ||
      new URL(absolute).origin === location.origin
    ) {
      const response = await fetch(absolute, { credentials: 'include' });
      if (!response.ok) throw new Error(`이미지 fetch 실패: ${response.status}`);
      return response.blob();
    }

    try {
      const response = await fetch(absolute, { credentials: 'include' });
      if (response.ok) return response.blob();
    } catch {}

    return gmFetchBlob(absolute);
  }

  async function uploadResultBlobToRelay(token, blob) {
    if (!token || !blob) throw new Error('결과 업로드 정보가 부족해.');
    const mime = String(blob.type || 'image/png').split(';')[0].toLowerCase();
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (!allowed.has(mime)) throw new Error(`지원하지 않는 이미지 형식: ${mime}`);

    const res = await fetch(
      `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}/result`,
      {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: blob,
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || `결과 업로드 실패: ${res.status}`);
    }
    return data;
  }

  function findChatGPTGeneratedImage() {
    const assistantRoots = [
      ...document.querySelectorAll('[data-message-author-role="assistant"]'),
      ...document.querySelectorAll('article[data-testid^="conversation-turn"] [data-message-author-role="assistant"]')
    ];

    const pool = [];
    for (const root of assistantRoots) {
      pool.push(...root.querySelectorAll('img'));
    }

    if (!pool.length) {
      pool.push(...document.querySelectorAll(
        'main img[alt*="generated" i], main img[alt*="image" i]'
      ));
    }

    const candidates = [...new Set(pool)].filter(img => {
      const src = String(img.currentSrc || img.src || '');
      if (!src || /^data:image\/svg/i.test(src)) return false;
      const w = Number(img.naturalWidth || img.width || 0);
      const h = Number(img.naturalHeight || img.height || 0);
      return w >= 256 && h >= 256;
    });

    return candidates[candidates.length - 1] || null;
  }

  async function initChatGPTBridge() {
    const token = getChatGPTBridgeToken();
    if (!token) return;

    const prompt = getChatGPTBridgePrompt();
    showChatGPTBridgeBadge('ZETA Snapshot 연결 중 · 요청문 준비 중');

    let composerAttempts = 0;
    const submittedKey = `zetaSnapshot.submitted.${token}`;
    const composerTimer = setInterval(() => {
      composerAttempts += 1;
      const prepared = setChatGPTComposerText(prompt);

      if (!prepared && composerAttempts < 30) return;

      clearInterval(composerTimer);

      if (!prepared) {
        showChatGPTBridgeBadge('ZETA Snapshot 연결됨 · 요청문 자동 입력에 실패했어.', 'error');
        return;
      }

      showChatGPTBridgeBadge('ZETA 요청문 준비됨 · 자동 전송 대기 중');

      if (sessionStorage.getItem(submittedKey) === '1') return;

      let sendAttempts = 0;
      const sendTimer = setInterval(() => {
        sendAttempts += 1;

        const sendButton =
          document.querySelector('button[data-testid="send-button"]') ||
          document.querySelector('button[aria-label="Send prompt"]') ||
          document.querySelector('button[aria-label="Send message"]') ||
          document.querySelector('button[aria-label="메시지 보내기"]') ||
          document.querySelector('button[aria-label="전송"]');

        if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
          clearInterval(sendTimer);
          sessionStorage.setItem(submittedKey, '1');
          showChatGPTBridgeBadge('ZETA 요청 자동 전송 중');
          sendButton.click();
          return;
        }

        if (sendAttempts >= 25) {
          clearInterval(sendTimer);
          showChatGPTBridgeBadge('자동 전송 버튼을 못 찾았어 · 전송만 한 번 눌러줘.', 'error');
        }
      }, 300);
    }, 400);

    const uploadedKey = `zetaSnapshot.uploaded.${token}`;
    if (sessionStorage.getItem(uploadedKey) === '1') {
      showChatGPTBridgeBadge('ZETA에 결과 저장 완료', 'success');
      return;
    }

    let candidateSrc = '';
    let candidateSince = 0;
    let busy = false;
    const startedAt = Date.now();

    const watcher = setInterval(async () => {
      if (busy) return;
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        clearInterval(watcher);
        return;
      }

      try {
        const statusRes = await fetch(
          `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}/status`
        );
        const statusData = await statusRes.json().catch(() => ({}));
        if (statusRes.ok && (statusData?.status === 'completed' || statusData?.hasResult)) {
          sessionStorage.setItem(uploadedKey, '1');
          showChatGPTBridgeBadge('ZETA에 결과 저장 완료', 'success');
          clearInterval(watcher);
          return;
        }
      } catch {}

      const img = findChatGPTGeneratedImage();
      const src = String(img?.currentSrc || img?.src || '');
      if (!img || !src || !img.complete) return;

      if (src !== candidateSrc) {
        candidateSrc = src;
        candidateSince = Date.now();
        return;
      }

      if (Date.now() - candidateSince < 3500) return;

      busy = true;
      showChatGPTBridgeBadge('생성 이미지 감지 · ZETA에 저장 중');

      try {
        const blob = await fetchBridgeImageBlob(src);
        await uploadResultBlobToRelay(token, blob);
        sessionStorage.setItem(uploadedKey, '1');
        showChatGPTBridgeBadge('ZETA에 결과 저장 완료 · 제타 탭으로 돌아가면 표시돼.', 'success');
        clearInterval(watcher);
      } catch (err) {
        console.warn('[ZETA Snapshot] ChatGPT bridge upload failed', err);
        showChatGPTBridgeBadge(`ZETA 저장 재시도 중 · ${String(err.message || err)}`, 'error');
        candidateSince = Date.now();
      } finally {
        busy = false;
      }
    }, 2500);
  }

  async function openSnapshotInChatGPT(info = {}, targetWindow = null) {
    const handoffUrl = buildChatGPTHandoffUrl(info);
    if (!handoffUrl) {
      flash('스냅샷 URL 또는 토큰이 없어.');
      return false;
    }

    const snapshotUrl =
      info.snapshotUrl ||
      `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(info.token)}`;
    const prompt = buildChatGPTPrompt(snapshotUrl);

    try {
      await copyText(prompt);
    } catch (err) {
      console.warn('[ZETA Snapshot] fallback copy failed', err);
    }

    try {
      if (targetWindow && !targetWindow.closed) {
        targetWindow.location.replace(handoffUrl);
      } else {
        targetWindow = window.open(handoffUrl, 'zeta-snapshot-chatgpt');
      }
    } catch (err) {
      console.warn('[ZETA Snapshot] ChatGPT open failed', err);
      targetWindow = window.open(handoffUrl, '_blank');
    }

    if (!targetWindow) {
      flash('팝업이 막혔어 · ChatGPT 열기 버튼을 다시 눌러줘.');
      return false;
    }

    flash('ChatGPT 탭에 요청문 준비 완료');
    return true;
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
          ${status !== 'completed' && !resultImageUrl
            ? '<button type="button" data-zs-inline-action="chatgpt">ChatGPT 열기</button>'
            : ''}
          <button type="button" data-zs-inline-action="refresh">새로고침</button>
        </div>
      </div>
      ${resultImageUrl ? `
        <img class="zs-inline-result-image" src="${resultImageUrl}" alt="ZETA Snapshot result" />
      ` : `
        <div class="zs-inline-waiting">
          ${status === 'failed'
            ? '생성에 실패했어.'
            : '스냅샷은 만들어졌어. ChatGPT에서 ZETA Snapshot Generator를 실행해야 이미지 생성이 시작돼.'}
        </div>
      `}
      ${error ? `<div class="zs-inline-error">${cleanText(error)}</div>` : ''}
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
    setInterval(() => {
      check();

      const roomId = getRoomId();
      const info = getRoomSnapshotInfo(roomId);
      if (roomId && roomId !== 'manual-room' && info?.token) {
        const cardId = getInlineCardId(roomId, info.token);
        if (!document.getElementById(cardId)) {
          renderInlineSnapshotCard(roomId, info, null);
        }
      }
    }, 1000);
  }

  async function sendDraftToRelay(draft) {
    const allCharacters =
      Array.isArray(draft.characters) && draft.characters.length
        ? draft.characters
        : (Array.isArray(draft.character?.characters) && draft.character.characters.length
            ? draft.character.characters
            : [draft.character].filter(Boolean));

    const selectedCharacters = allCharacters.filter(item => item.included === true);
    if (!selectedCharacters.length) {
      throw new Error('포함할 캐릭터를 하나 이상 체크해줘.');
    }

    const primaryCharacter =
      selectedCharacters.find(item => item.primary) ||
      selectedCharacters[0] ||
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
          included: item.included === true,
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
      .filter(([plotId]) => !!plotId)
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

      const label = getPlotLabel(entry, plotId) || `플롯 ${plotId.slice(0, 6)}`;
      btn.textContent = label;

      btn.style.setProperty('font-size', '13px', 'important');
      btn.style.setProperty('font-weight', '750', 'important');
      btn.style.setProperty('line-height', '1.2', 'important');
      btn.style.setProperty('opacity', '1', 'important');
      btn.style.setProperty('visibility', 'visible', 'important');
      btn.style.setProperty('-webkit-text-fill-color', plotId === activePlotId ? '#18181b' : '#e4e4e7', 'important');
      btn.style.setProperty('color', plotId === activePlotId ? '#18181b' : '#e4e4e7', 'important');

      if (plotId === activePlotId) btn.classList.add('active');
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

    const included = characters.filter(item => item.included);
    const selectedPrimary = included.find(item => item.primary);

    if (included.length && !selectedPrimary) {
      characters.forEach(item => { item.primary = false; });
      included[0].primary = true;
    } else if (selectedPrimary) {
      characters.forEach(item => {
        if (item !== selectedPrimary) item.primary = false;
      });
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
          <div class="zs-head-copy">
            <div class="zs-title">ZETA Snapshot</div>
            <div class="zs-subtitle">장면과 프로필을 확인한 뒤 바로 생성</div>
          </div>
          <button class="zs-close" type="button" aria-label="닫기">✕</button>
        </div>

        <div id="zs-plot-tabs" class="zs-plot-tabs"></div>

        <div class="zs-tools">
          <span class="zs-autosave-badge">● 자동 저장</span>
        </div>

        <div class="zs-body">
          <div class="zs-grid">
            <div class="zs-field zs-style-field">
              <label>화풍</label>
              <select id="zs-style">
                <option value="2d">2D 일러스트</option>
                <option value="semi">반실사</option>
                <option value="real">실사</option>
              </select>
            </div>

            <details class="zs-technical">
              <summary>기술 정보</summary>
              <div class="zs-field">
                <label>Room ID</label>
                <input id="zs-room" type="text" />
              </div>
            </details>

            <div class="zs-field zs-span2">
              <div class="zs-section-title-row">
                <label>캐릭터 슬롯</label>
                <button type="button" data-zs-action="add-character-slot">+ 슬롯 추가</button>
              </div>
              <div id="zs-character-slots" class="zs-character-slots"></div>
            </div>

            <div class="zs-section-title zs-span2">유저 프로필</div>

            <div class="zs-user-card zs-span2">
              <div class="zs-user-preview-col">
                <div class="zs-preview"><img id="zs-user-preview" /></div>
              </div>
              <div class="zs-user-fields">
                <div class="zs-field">
                  <label>이름</label>
                  <input id="zs-user-name" type="text" />
                </div>
                <div class="zs-field">
                  <label>원본 설명</label>
                  <textarea id="zs-user-desc"></textarea>
                </div>
                <div class="zs-field">
                  <label>외형 프롬프트 <span class="zs-help">원본 설명에서 시작 · 수정 가능</span></label>
                  <textarea id="zs-user-appearance"></textarea>
                </div>
                <details class="zs-technical zs-user-url">
                  <summary>이미지 URL</summary>
                  <div class="zs-field">
                    <input id="zs-user-image" type="text" />
                  </div>
                </details>
              </div>
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

          <div class="zs-result-wrap">
            <label>결과</label>
            <pre id="zs-result"></pre>
          </div>
        </div>

        <div class="zs-actions">
          <button type="button" data-zs-action="close">닫기</button>
          <button type="button" class="zs-refresh-btn" data-zs-action="load-real">✨ 자동 수집</button>
          <button id="zs-primary-action" type="button" class="primary" data-zs-action="send-relay">스냅샷 만들기</button>
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
        state.resultBox.textContent = '대화 + 캐릭터 프로필 + 사용 프로필 자동 수집 중...';
        try {
          if (/\/rooms\/[^/?#]+/.test(location.pathname)) {
            closeModal();
            await startFullCollectionFromRoom();
            return;
          }
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

      if (action === 'open-chatgpt') {
        if (!state.lastCreatedSnapshotInfo) {
          flash('먼저 스냅샷을 만들어줘.');
          return;
        }
        await openSnapshotInChatGPT(state.lastCreatedSnapshotInfo);
        return;
      }

      if (action === 'send-relay') {
        let handoffWindow = null;

        try {
          handoffWindow = window.open('about:blank', 'zeta-snapshot-chatgpt');
          if (handoffWindow) {
            try {
              handoffWindow.document.title = 'ZETA Snapshot → ChatGPT';
              handoffWindow.document.body.innerHTML =
                '<div style="font-family:system-ui;padding:24px">ZETA Snapshot 준비 중...</div>';
            } catch {}
          }

          const draft = readFormToDraft();
          persistFromDraft(draft);
          state.resultBox.textContent = '스냅샷 저장 중...';
          const result = await sendDraftToRelay(draft);
          state.lastCreatedSnapshotInfo = {
            token: result.token,
            snapshotUrl: result.getSnapshotUrl,
            statusUrl: result.getStatusUrl,
            roomId: draft.roomId || getRoomId(),
          };

          const primaryAction = qs('#zs-primary-action', state.overlay);
          if (primaryAction) {
            primaryAction.dataset.zsAction = 'open-chatgpt';
            primaryAction.textContent = 'ChatGPT 다시 열기';
          }

          const opened = await openSnapshotInChatGPT(state.lastCreatedSnapshotInfo, handoffWindow);

          state.resultBox.textContent = [
            '스냅샷 데이터 저장 완료',
            '',
            result.getSnapshotUrl || '',
            '',
            opened
              ? 'ChatGPT 탭을 열고 요청문까지 준비했어. 전송만 누르면 돼.'
              : 'ChatGPT 자동 열기가 막혔어. 아래 [ChatGPT 다시 열기]를 눌러줘.',
            '이미지 생성이 끝나면 이 스크립트가 결과 이미지를 Worker로 되돌리고 제타 대화에 표시해.'
          ].join('\n');

          flash(opened ? 'ChatGPT 탭 준비 완료' : '스냅샷 저장 완료');
        } catch (err) {
          try {
            if (handoffWindow && !handoffWindow.closed && handoffWindow.location.href === 'about:blank') {
              handoffWindow.close();
            }
          } catch {}
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
    state.lastCreatedSnapshotInfo = null;

    const primaryAction = qs('#zs-primary-action', state.overlay);
    if (primaryAction) {
      primaryAction.dataset.zsAction = 'send-relay';
      primaryAction.textContent = '스냅샷 만들기';
    }

    const handoff = qs('#zs-handoff', state.overlay);
    if (handoff) handoff.style.display = 'none';
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


  function getCollectSession() {
    return load(CONFIG.STORAGE.COLLECT_SESSION, null);
  }

  function setCollectSession(session) {
    if (!session) {
      localStorage.removeItem(CONFIG.STORAGE.COLLECT_SESSION);
      return null;
    }
    save(CONFIG.STORAGE.COLLECT_SESSION, session);
    return session;
  }

  async function startFullCollectionFromRoom() {
    if (!/\/rooms\/[^/?#]+/.test(location.pathname)) {
      throw new Error('대화방에서 자동 수집을 시작해줘.');
    }

    const roomId = getRoomId();
    const messages = collectRecentMessages();
    const roomUserProfile = collectCurrentUserProfileFromRoomCard(null, roomId);
    const profileButton = qs('button[data-testid="chat-header-profile"][aria-label="Open plot profile"]');

    if (!profileButton) {
      throw new Error('캐릭터 프로필 이동 버튼을 찾지 못했어.');
    }

    setCollectSession({
      phase: 'open-character-profile',
      roomId,
      roomUrl: location.href,
      messages,
      roomUserProfile,
      anchor: buildAnchor(messages),
      startedAt: Date.now(),
    });

    closeModal();
    flash('1/3 캐릭터 프로필 수집 중...');
    profileButton.click();
  }

  function findUserProfileHubTrigger() {
    // 실제 대화방 DOM: RightTextContent 오른쪽 끝의 아바타 버튼을 누르면
    // "대화 프로필" 바텀시트가 열린다.
    const rows = qsa('[data-sentry-component="RightTextContent"]');
    for (let i = rows.length - 1; i >= 0; i--) {
      const directButtons = Array.from(rows[i].children || [])
        .filter(el => el?.tagName === 'BUTTON' && el.querySelector('img'));
      if (directButtons.length) return directButtons[directButtons.length - 1];

      const nested = qsa('button', rows[i]).find(btn => btn.querySelector('img'));
      if (nested) return nested;
    }

    return null;
  }

  function openUserProfileHubFromRoom() {
    const trigger = findUserProfileHubTrigger();
    if (!trigger) return false;
    trigger.click();
    return true;
  }

  async function openCollectionFallback(error, session = {}) {
    try {
      const draft = await buildDraftFromCache({
        plotId: session.plotId || null,
        roomId: session.roomId || getRoomId(),
        messages: Array.isArray(session.messages) ? session.messages : collectRecentMessages(),
        skipAutoCollect: true,
      });

      openDraft(draft);
      if (state.resultBox) {
        state.resultBox.textContent = [
          '자동 수집이 중간에 멈췄어.',
          String(error || '알 수 없는 오류'),
          '',
          '위의 ✨ 자동 수집 버튼으로 다시 시도할 수 있어.',
          '이미 수집된 값은 그대로 남겨둠.'
        ].join('\n');
      }
    } catch (fallbackErr) {
      console.error('[ZETA Snapshot] fallback popup failed', fallbackErr);
      ensureModal();
      openModal();
      if (state.resultBox) {
        state.resultBox.textContent = `자동 수집 실패:\n${String(error || fallbackErr?.message || fallbackErr)}`;
      }
    }
  }

  async function resumeCollectSession() {
    if (state.collectResumeBusy) return;

    const session = getCollectSession();
    if (!session) return;

    if (Date.now() - Number(session.startedAt || 0) > 2 * 60 * 1000) {
      setCollectSession(null);
      if (/\/rooms\/[^/?#]+/.test(location.pathname)) {
        await openCollectionFallback('자동 수집 시간이 초과됐어. 다시 시도해줘.', session);
      }
      return;
    }

    state.collectResumeBusy = true;
    try {
      if (
        session.phase === 'open-character-profile' &&
        /\/plots\/[^/?#]+\/profile/.test(location.pathname)
      ) {
        const plotId = getPlotIdFromUrl();
        if (!plotId) throw new Error('캐릭터 프로필에서 plotId를 찾지 못했어.');

        const character = collectCharacterProfileFromCurrentPage();

        setCollectSession({
          ...session,
          phase: 'return-room-open-user-profile',
          plotId,
          character,
        });

        flash('1/3 캐릭터 프로필 완료 · 대화방으로 복귀');
        history.back();
        setTimeout(() => {
          if (/\/plots\/[^/?#]+\/profile/.test(location.pathname)) {
            location.href = session.roomUrl;
          }
        }, 1400);
        return;
      }

      if (
        session.phase === 'return-room-open-user-profile' &&
        /\/rooms\/[^/?#]+/.test(location.pathname) &&
        getRoomId() === session.roomId
      ) {
        const roomUserProfile =
          collectCurrentUserProfileFromRoomCard(session.plotId, session.roomId) ||
          session.roomUserProfile ||
          null;

        const dialog =
          qs('#portal-container section[role="dialog"][aria-label="대화 프로필"]') ||
          qs('section[role="dialog"][aria-label="대화 프로필"]');

        if (!dialog) {
          const opened = openUserProfileHubFromRoom();
          if (!opened) {
            throw new Error('대화방에서 유저 프로필 아바타 버튼을 찾지 못했어.');
          }
        }

        setCollectSession({
          ...session,
          phase: 'wait-user-profile',
          roomUserProfile,
          profileOpenAt: Date.now(),
        });

        flash('2/3 현재 유저 프로필 여는 중...');
        return;
      }

      if (
        session.phase === 'wait-user-profile' &&
        /\/rooms\/[^/?#]+/.test(location.pathname) &&
        getRoomId() === session.roomId
      ) {
        const dialog =
          qs('#portal-container section[role="dialog"][aria-label="대화 프로필"]') ||
          qs('section[role="dialog"][aria-label="대화 프로필"]');

        if (!dialog && Date.now() - Number(session.profileOpenAt || 0) < 4000) {
          return;
        }

        const fallbackProfile =
          collectCurrentUserProfileFromRoomCard(session.plotId, session.roomId) ||
          session.roomUserProfile ||
          null;

        if (!dialog) {
          throw new Error('유저 프로필 창이 열리지 않았어.');
        }

        const selected = collectSelectedUserProfileFromDialog(fallbackProfile);

        if (!selected) {
          throw new Error('현재 유저 프로필 정보를 찾지 못했어.');
        }

        const userProfile = {
          ...selected,
          plotId: session.plotId,
          roomId: session.roomId,
          source: 'room-selected-profile',
          updatedAt: Date.now(),
        };

        save(CONFIG.STORAGE.USER, userProfile);
        upsertPlotEntry(session.plotId, {
          userProfile,
          rooms: {
            [session.roomId]: {
              roomId: session.roomId,
              lastUsedAt: Date.now(),
            },
          },
        });

        const draft = await buildDraftFromCache({
          plotId: session.plotId,
          roomId: session.roomId,
          messages: Array.isArray(session.messages) ? session.messages : [],
          character: session.character || getPlotEntry(session.plotId)?.character || null,
          userProfile,
          skipAutoCollect: true,
        });

        draft.anchor = session.anchor || buildAnchor(draft.messages || []);

        setCollectSession(null);
        openDraft(draft);
        flash('3/3 대화 + 캐릭터 + 유저 프로필 수집 완료');
        return;
      }

      if (
        session.phase === 'failed-return' &&
        /\/rooms\/[^/?#]+/.test(location.pathname) &&
        getRoomId() === session.roomId
      ) {
        setCollectSession(null);
        await openCollectionFallback(session.error || '자동 수집 실패', session);
      }
    } catch (err) {
      console.error('[ZETA Snapshot] full collection failed', err);
      const message = String(err.message || err);

      if (session.roomUrl && !/\/rooms\/[^/?#]+/.test(location.pathname)) {
        setCollectSession({
          ...session,
          phase: 'failed-return',
          error: message,
        });
        location.href = session.roomUrl;
      } else {
        setCollectSession(null);
        await openCollectionFallback(message, session);
      }
    } finally {
      state.collectResumeBusy = false;
    }
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

    const getViewport = () => ({
      width: window.visualViewport?.width || window.innerWidth,
      height: window.visualViewport?.height || window.innerHeight,
    });

    const applySavedPosition = () => {
      const saved = load(CONFIG.STORAGE.LAUNCHER_POS, null);
      if (!saved) return;

      const vp = getViewport();
      const w = wrap.offsetWidth || 50;
      const h = wrap.offsetHeight || 50;
      const pad = 8;

      if (!saved.h && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        const rectLeft = Math.max(pad, Math.min(saved.left, vp.width - w - pad));
        const rectTop = Math.max(pad, Math.min(saved.top, vp.height - h - pad));
        const migrated = {
          h: rectLeft <= (vp.width - (rectLeft + w)) ? 'left' : 'right',
          hx: Math.round(Math.min(rectLeft, vp.width - (rectLeft + w))),
          v: rectTop <= (vp.height - (rectTop + h)) ? 'top' : 'bottom',
          vy: Math.round(Math.min(rectTop, vp.height - (rectTop + h))),
        };
        save(CONFIG.STORAGE.LAUNCHER_POS, migrated);
        return applySavedPosition();
      }

      wrap.style.left = 'auto';
      wrap.style.right = 'auto';
      wrap.style.top = 'auto';
      wrap.style.bottom = 'auto';

      if (saved.h === 'left') wrap.style.left = `${Math.max(pad, saved.hx || pad)}px`;
      else wrap.style.right = `${Math.max(pad, saved.hx || pad)}px`;

      if (saved.v === 'top') wrap.style.top = `${Math.max(pad, saved.vy || pad)}px`;
      else wrap.style.bottom = `${Math.max(pad, saved.vy || pad)}px`;
    };

    const saveCurrentPosition = () => {
      const vp = getViewport();
      const rect = wrap.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.max(0, vp.width - rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.max(0, vp.height - rect.bottom);

      save(CONFIG.STORAGE.LAUNCHER_POS, {
        h: left <= right ? 'left' : 'right',
        hx: Math.round(Math.min(left, right)),
        v: top <= bottom ? 'top' : 'bottom',
        vy: Math.round(Math.min(top, bottom)),
      });
    };

    document.body.appendChild(wrap);
    applySavedPosition();
    setTimeout(applySavedPosition, 120);
    setTimeout(applySavedPosition, 650);

    const button = qs('[data-zs-launch="draft"]', wrap);
    let drag = null;
    let suppressClick = false;

    const clampPosition = (left, top) => {
      const vp = getViewport();
      const rect = wrap.getBoundingClientRect();
      const pad = 8;
      return {
        left: Math.max(pad, Math.min(left, vp.width - rect.width - pad)),
        top: Math.max(pad, Math.min(top, vp.height - rect.height - pad)),
      };
    };

    button.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
      button.setPointerCapture?.(e.pointerId);
    });

    button.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;

      const distance = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (!drag.moved && distance < 12) return;
      drag.moved = true;

      e.preventDefault();
      const next = clampPosition(e.clientX - drag.offsetX, e.clientY - drag.offsetY);
      wrap.style.left = `${next.left}px`;
      wrap.style.top = `${next.top}px`;
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    });

    const finishDrag = e => {
      if (!drag || (e.pointerId != null && e.pointerId !== drag.pointerId)) return;
      if (drag.moved) {
        saveCurrentPosition();
        applySavedPosition();
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 120);
      }
      try { button.releasePointerCapture?.(drag.pointerId); } catch {}
      drag = null;
    };

    button.addEventListener('pointerup', finishDrag);
    button.addEventListener('pointercancel', finishDrag);

    wrap.addEventListener('click', e => {
      const btn = e.target.closest('[data-zs-launch="draft"]');
      if (!btn) return;
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      (async () => {
        try {
          const draft = await buildDraftFromCache({
            roomId: getRoomId(),
            messages: collectRecentMessages(),
            skipAutoCollect: true,
          });
          openDraft(draft);

          if (/\/rooms\/[^/?#]+/.test(location.pathname) && state.resultBox) {
            state.resultBox.textContent = '✨ 자동 수집을 누르면 캐릭터 프로필 → 대화방 → 현재 유저 프로필까지 이어서 수집해.';
          }
        } catch (err) {
          console.error(err);
          await openCollectionFallback(String(err.message || err), {
            roomId: getRoomId(),
            messages: collectRecentMessages(),
          });
        }
      })();
    });

    const keepStable = () => applySavedPosition();
    window.addEventListener('resize', keepStable);
    window.visualViewport?.addEventListener('resize', keepStable);
  }

  function injectStyles() {
    if (qs('#zs-snapshot-test-style')) return;

    const style = document.createElement('style');
    style.id = 'zs-snapshot-test-style';
    style.textContent = `
      .zs-launcher{
        position:fixed;
        right:16px;
        bottom:max(18px, env(safe-area-inset-bottom));
        z-index:999999;
      }
      .zs-launcher button{
        touch-action:none;
        user-select:none;
        -webkit-user-select:none;
        cursor:grab;
        width:50px;
        height:50px;
        border:1px solid #d1d5db;
        border-radius:16px;
        background:#ffffff;
        color:#111827;
        box-shadow:0 10px 28px rgba(17,24,39,.14);
        font-size:21px;
        transition:.16s ease;
      }
      .zs-launcher button:active{ transform:scale(.96); cursor:grabbing; }

      .zs-overlay{
        position:fixed;
        inset:0;
        background:rgba(0,0,0,.68);
        backdrop-filter:blur(6px);
        -webkit-backdrop-filter:blur(6px);
        z-index:9999999;
        display:none;
        align-items:center;
        justify-content:center;
        padding:18px;
        box-sizing:border-box;
      }
      .zs-modal{
        width:min(880px, 96vw);
        max-height:min(92vh, 920px);
        overflow:hidden;
        display:flex;
        flex-direction:column;
        min-height:0;
        background:#ffffff;
        color:#111827;
        border:1px solid #e5e7eb;
        border-radius:22px;
        box-shadow:0 24px 70px rgba(17,24,39,.18);
      }
      .zs-head{
        flex:0 0 auto;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding:16px 18px 14px;
        border-bottom:1px solid #e5e7eb;
        background:#ffffff;
        position:sticky;
        top:0;
        z-index:4;
      }
      .zs-head-copy{ min-width:0; }
      .zs-title{
        font-size:18px;
        line-height:1.25;
        font-weight:800;
        letter-spacing:-.02em;
      }
      .zs-subtitle{
        margin-top:3px;
        color:#6b7280;
        font-size:11px;
        line-height:1.35;
      }
      .zs-close{
        width:34px;
        height:34px;
        flex:0 0 auto;
        border:none;
        border-radius:10px;
        background:#f3f4f6;
        color:#374151;
        font-size:16px;
        cursor:pointer;
      }

      .zs-plot-tabs{
        display:none;
        flex:0 0 58px;
        width:100%;
        height:58px;
        min-height:58px;
        max-height:58px;
        box-sizing:border-box;
        align-items:center;
        gap:8px;
        overflow-x:auto;
        overflow-y:hidden;
        flex-wrap:nowrap;
        padding:8px 16px;
        scrollbar-width:none;
        -webkit-overflow-scrolling:touch;
        overscroll-behavior-x:contain;
        scroll-snap-type:x proximity;
      }
      .zs-plot-tabs::-webkit-scrollbar{ display:none; }
      .zs-plot-tab{
        flex:0 0 calc((100% - 24px) / 4);
        min-width:0;
        width:auto;
        min-height:40px;
        display:flex;
        align-items:center;
        justify-content:center;
        gap:6px;
        max-width:none;
        border:1px solid #e5e7eb;
        background:#f3f4f6;
        color:#374151;
        padding:10px 8px;
        border-radius:12px;
        cursor:pointer;
        font-size:13px;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        scroll-snap-align:start;
      }
      .zs-plot-tab,
      .zs-plot-tab *{
        color:#374151!important;
        opacity:1!important;
        visibility:visible!important;
        -webkit-text-fill-color:currentColor!important;
      }
      .zs-plot-tab{
        min-width:0;
      }
      .zs-plot-tab.active{
        background:#111827;
        border-color:#111827;
        color:#ffffff!important;
      }
      .zs-plot-tab.active *{
        color:#ffffff!important;
        -webkit-text-fill-color:#ffffff!important;
      }
      .zs-plot-tab-label{
        display:block!important;
        min-width:0;
        max-width:190px;
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font-weight:750;
      }
      .zs-plot-tab-meta{
        font-size:10px;
        opacity:.68;
      }

      .zs-tools{
        flex:0 0 auto;
        display:flex;
        align-items:center;
        gap:9px;
        padding:10px 16px 4px;
      }
      .zs-refresh-btn{
        border:1px solid #e5e7eb!important;
        background:#f3f4f6!important;
        color:#1f2937!important;
      }
      .zs-autosave-badge{
        margin-left:auto;
        display:inline-flex;
        align-items:center;
        gap:4px;
        color:#6b7280;
        font-size:11px;
        white-space:nowrap;
      }
      .zs-autosave-badge::first-letter{ color:#22c55e; }

      .zs-tools button,
      .zs-actions button{
        min-height:40px;
        border:none;
        border-radius:12px;
        padding:9px 13px;
        font-size:13px;
        font-weight:700;
        cursor:pointer;
      }

      .zs-body{
        flex:1 1 auto;
        min-height:0;
        overflow-y:auto;
        overflow-x:hidden;
        overscroll-behavior:contain;
        padding:14px 16px 18px;
      }
      .zs-grid{
        display:grid;
        grid-template-columns:minmax(0,1fr) minmax(0,1fr);
        gap:12px;
      }
      .zs-field{
        display:flex;
        flex-direction:column;
        gap:6px;
        min-width:0;
      }
      .zs-span2{ grid-column:span 2; }
      .zs-section-title{
        margin-top:8px;
        padding-top:4px;
        color:#111827;
        font-size:13px;
        font-weight:800;
      }
      .zs-section-title-row{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        margin-top:8px;
      }
      .zs-section-title-row > label{
        color:#111827!important;
        font-size:13px!important;
        font-weight:800!important;
      }
      .zs-section-title-row > button{
        border:1px solid #e5e7eb;
        background:#f3f4f6;
        color:#374151;
        padding:7px 10px;
        border-radius:10px;
        cursor:pointer;
        font-size:11px;
      }

      .zs-field label,
      .zs-char-field > span{
        color:#6b7280;
        font-size:11px;
        font-weight:700;
      }
      .zs-help{
        color:#6b7280;
        font-size:10px;
        font-weight:500;
      }
      .zs-field input,
      .zs-field select,
      .zs-field textarea,
      .zs-char-field input,
      .zs-char-field textarea{
        width:100%;
        box-sizing:border-box;
        border:1px solid #e5e7eb;
        border-radius:12px;
        padding:10px 11px;
        background:#f3f4f6;
        color:#111827;
        outline:none;
        font-size:13px;
        line-height:1.45;
        transition:border-color .15s ease, background .15s ease;
      }
      .zs-field input:focus,
      .zs-field select:focus,
      .zs-field textarea:focus,
      .zs-char-field input:focus,
      .zs-char-field textarea:focus{
        border-color:#6b7280;
        background:#ffffff;
      }
      .zs-field textarea{ min-height:88px; resize:vertical; }
      .zs-char-field textarea{ min-height:74px; resize:vertical; }
      #zs-messages{
        min-height:150px;
        color:#374151;
        background:#f9fafb;
      }

      .zs-technical{
        align-self:end;
        border:1px solid #e5e7eb;
        border-radius:12px;
        background:#f9fafb;
        overflow:hidden;
      }
      .zs-technical > summary{
        list-style:none;
        cursor:pointer;
        color:#6b7280;
        font-size:11px;
        font-weight:700;
        padding:11px 12px;
      }
      .zs-technical > summary::-webkit-details-marker{ display:none; }
      .zs-technical[open] > summary{
        border-bottom:1px solid #e5e7eb;
      }
      .zs-technical > .zs-field{ padding:10px; }

      .zs-character-slots{
        display:flex;
        flex-direction:column;
        gap:10px;
      }
      .zs-char-card{
        border:1px solid #e5e7eb;
        border-radius:16px;
        padding:12px;
        background:#f9fafb;
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
        color:#111827;
        font-size:14px;
      }
      .zs-char-card-controls{
        display:flex;
        align-items:center;
        gap:7px;
        flex-wrap:wrap;
        justify-content:flex-end;
      }
      .zs-inline-check{
        display:flex!important;
        flex-direction:row!important;
        align-items:center;
        gap:5px!important;
        color:#6b7280!important;
        font-size:11px!important;
        font-weight:600!important;
        white-space:nowrap;
      }
      .zs-inline-check input{
        width:auto!important;
        margin:0;
        accent-color:#111827;
      }
      .zs-char-remove{
        border:none;
        background:#fef2f2;
        color:#dc2626;
        border-radius:9px;
        padding:6px 8px;
        font-size:10px;
        cursor:pointer;
      }
      .zs-char-grid{
        display:grid;
        grid-template-columns:110px minmax(0,1fr);
        gap:12px;
        align-items:start;
      }
      .zs-char-preview-wrap{
        width:110px;
        height:110px;
        border-radius:14px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#f3f4f6;
        overflow:hidden;
      }
      .zs-char-slot-preview{
        width:100%;
        height:100%;
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

      .zs-user-card{
        display:grid;
        grid-template-columns:120px minmax(0,1fr);
        gap:12px;
        padding:12px;
        border:1px solid #e5e7eb;
        border-radius:16px;
        background:#f9fafb;
      }
      .zs-user-preview-col{ min-width:0; }
      .zs-user-fields{
        display:flex;
        flex-direction:column;
        gap:9px;
        min-width:0;
      }
      .zs-preview{
        width:120px;
        height:120px;
        border-radius:14px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#f3f4f6;
        overflow:hidden;
      }
      .zs-preview img{
        width:100%;
        height:100%;
        object-fit:cover;
        display:block;
      }
      .zs-user-url{ margin-top:1px; }

      .zs-actions{
        flex:0 0 auto;
        display:grid;
        grid-template-columns:90px 120px minmax(0,1fr);
        gap:8px;
        margin:0;
        padding:12px 16px calc(12px + env(safe-area-inset-bottom));
        border-top:1px solid #e5e7eb;
        background:#ffffff;
      }
      .zs-actions button{
        background:#f3f4f6;
        color:#374151;
      }
      .zs-actions button.primary{
        background:#111827;
        color:#ffffff;
        font-weight:800;
      }

      .zs-handoff{
        margin-top:14px;
        padding:10px;
        border:1px solid #e5e7eb;
        border-radius:14px;
        background:#f9fafb;
        align-items:center;
        gap:10px;
      }
      .zs-handoff button{
        flex:0 0 auto;
        min-height:40px;
        border:none;
        border-radius:11px;
        padding:9px 12px;
        background:#111827;
        color:#ffffff;
        font-size:12px;
        font-weight:800;
        cursor:pointer;
      }
      .zs-handoff span{
        color:#6b7280;
        font-size:10px;
        line-height:1.4;
      }

      .zs-result-wrap{
        margin-top:16px;
      }
      .zs-result-wrap label{
        display:block;
        color:#6b7280;
        font-size:11px;
        font-weight:700;
        margin-bottom:6px;
      }
      #zs-result{
        margin:0;
        min-height:0;
        max-height:230px;
        overflow:auto;
        background:#f9fafb;
        color:#374151;
        border:1px solid #e5e7eb;
        border-radius:12px;
        padding:11px;
        font-size:11px;
        line-height:1.5;
        white-space:pre-wrap;
        word-break:break-all;
      }
      #zs-result:empty{ display:none; }
      .zs-result-wrap:has(#zs-result:empty){ display:none; }

      .zs-inline-card{
        box-sizing:border-box;
        width:min(640px, calc(100% - 24px));
        margin:12px auto;
        padding:12px;
        border:1px solid #e5e7eb;
        border-radius:16px;
        background:#ffffff;
        color:#111827;
        box-shadow:0 8px 24px rgba(17,24,39,.10);
        position:relative;
        z-index:2;
      }
      .zs-inline-card.zs-inline-floating{
        position:fixed;
        left:12px;
        right:12px;
        bottom:max(76px, calc(64px + env(safe-area-inset-bottom)));
        width:auto;
        max-width:640px;
        max-height:68dvh;
        overflow:auto;
        margin:0 auto;
        z-index:9999998;
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
        font-size:10px;
        color:#6b7280;
        background:#f3f4f6;
        border-radius:999px;
        padding:4px 7px;
      }
      .zs-inline-status[data-status="completed"]{
        background:#ecfdf5;
        color:#15803d;
      }
      .zs-inline-status[data-status="failed"]{
        background:#fef2f2;
        color:#dc2626;
      }
      .zs-inline-card-actions{
        display:flex;
        gap:6px;
      }
      .zs-inline-card-actions button{
        border:none;
        border-radius:9px;
        padding:7px 9px;
        background:#f3f4f6;
        color:#374151;
        font-size:10px;
        cursor:pointer;
      }
      .zs-inline-result-image{
        display:block;
        width:100%;
        max-height:720px;
        object-fit:contain;
        border-radius:12px;
        background:#f3f4f6;
      }
      .zs-inline-waiting{
        padding:16px 10px;
        border-radius:12px;
        background:#f9fafb;
        color:#6b7280;
        font-size:11px;
        text-align:center;
      }
      .zs-inline-error{
        margin-top:8px;
        color:#dc2626;
        font-size:11px;
        line-height:1.45;
      }

      .zs-toast{
        position:fixed;
        left:50%;
        bottom:max(24px, env(safe-area-inset-bottom));
        transform:translateX(-50%) translateY(10px);
        max-width:calc(100vw - 32px);
        background:#111827;
        color:#ffffff;
        padding:10px 14px;
        border-radius:999px;
        font-size:12px;
        font-weight:700;
        z-index:10000000;
        opacity:0;
        transition:.2s ease;
        pointer-events:none;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        box-shadow:0 10px 30px rgba(0,0,0,.25);
      }
      .zs-toast.show{
        opacity:1;
        transform:translateX(-50%) translateY(0);
      }

      @media (max-width:760px){
        .zs-overlay{
          align-items:flex-end;
          padding:0;
        }
        .zs-modal{
          width:100%;
          max-height:94dvh;
          border-radius:22px 22px 0 0;
          border-left:none;
          border-right:none;
          border-bottom:none;
        }
        .zs-head{
          padding:14px 16px 12px;
        }
        .zs-subtitle{ display:none; }
        .zs-title{ font-size:17px; }
        .zs-plot-tabs{
          flex:0 0 56px;
          height:56px;
          min-height:56px;
          max-height:56px;
          padding:8px 12px;
          gap:7px;
          overflow-x:auto;
          overflow-y:hidden;
          flex-wrap:nowrap;
        }
        .zs-plot-tab{
          flex:0 0 calc((100% - 21px) / 4);
          min-width:0;
          width:auto;
          min-height:38px;
          max-width:none;
          padding:9px 6px;
          font-size:12px!important;
        }
        .zs-tools{
          padding:9px 12px 2px;
        }
        .zs-autosave-badge{
          font-size:10px;
        }
        .zs-body{
          padding:12px 12px 16px;
        }
        .zs-grid{
          grid-template-columns:1fr;
          gap:10px;
        }
        .zs-span2{ grid-column:span 1; }
        .zs-technical{ align-self:stretch; }

        .zs-char-card{
          padding:10px;
          border-radius:14px;
        }
        .zs-char-card-head{
          align-items:flex-start;
          margin-bottom:9px;
        }
        .zs-char-card-controls{
          gap:6px;
          justify-content:flex-end;
        }
        .zs-char-grid{
          grid-template-columns:88px minmax(0,1fr);
          gap:10px;
        }
        .zs-char-preview-wrap{
          width:88px;
          height:88px;
          border-radius:12px;
        }
        .zs-char-field textarea{ min-height:68px; }

        .zs-user-card{
          grid-template-columns:88px minmax(0,1fr);
          gap:10px;
          padding:10px;
        }
        .zs-preview{
          width:88px;
          height:88px;
          border-radius:12px;
        }

        .zs-actions{
          grid-template-columns:76px 108px minmax(0,1fr);
          padding-left:12px;
          padding-right:12px;
        }
      }

      @media (max-width:420px){
        .zs-char-card-head{
          flex-direction:column;
          gap:7px;
        }
        .zs-char-card-controls{
          width:100%;
          justify-content:flex-start;
        }
        .zs-char-grid,
        .zs-user-card{
          grid-template-columns:72px minmax(0,1fr);
        }
        .zs-char-preview-wrap,
        .zs-preview{
          width:72px;
          height:72px;
        }
        .zs-field input,
        .zs-field select,
        .zs-field textarea,
        .zs-char-field input,
        .zs-char-field textarea{
          font-size:12px;
          padding:9px 10px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function init() {
    if (IS_CHATGPT_HOST) {
      initChatGPTBridge().catch(err => {
        console.warn('[ZETA Snapshot] ChatGPT bridge init failed', err);
        showChatGPTBridgeBadge(`ZETA 연결 오류 · ${String(err.message || err)}`, 'error');
      });
      return;
    }

    if (!IS_ZETA_HOST) return;

    injectStyles();
    createLauncher();
    watchRoomNavigation();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        restoreSnapshotForCurrentRoom();
      }
    });

    // 프로필 이동이 SPA 전환이어도 이어서 수집되도록 감시.
    setInterval(() => {
      resumeCollectSession().catch(err => console.warn('[ZETA Snapshot] resume collection failed', err));
    }, 500);

    setTimeout(() => {
      resumeCollectSession().catch(err => console.warn('[ZETA Snapshot] initial collection resume failed', err));
      restoreSnapshotForCurrentRoom();
    }, 700);

    console.log('[ZETA Snapshot] v0.7.1 white UI + ChatGPT auto-submit bridge + automatic result write-back ready');
  }

  init();
})();