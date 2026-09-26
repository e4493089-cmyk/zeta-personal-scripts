// ==UserScript==
// @name         ZETA Snapshot Test Prototype
// @namespace    zeta-snapshot-test
// @version      0.1.0
// @description  ZETA Snapshot collector/review/send prototype
// @match        https://zeta-ai.io/*
// @match        https://www.zeta-ai.io/*
// @run-at       document-idle
// @grant        none
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
    const m = location.pathname.match(/\/rooms\/([^/?#]+)/);
    return m ? m[1] : 'manual-room';
  }

  function getPlotIdFromUrl() {
    const m = location.pathname.match(/\/plots\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function pickBestImageUrl(candidates) {
    const valid = [...new Set(candidates.filter(Boolean))];
    if (!valid.length) return '';

    const scored = valid.map(url => {
      let score = 0;
      if (/profile-image/.test(url)) score += 30;
      if (/plot-cover-image/.test(url)) score += 20;

      const w = (url.match(/[?&]w=(\d+)/)?.[1]) || '';
      score += Number(w || 0);

      if (/1080/.test(url)) score += 500;
      if (/q=90/.test(url)) score += 10;

      return { url, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].url;
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

  function inferAppearanceTags(sourceText) {
    const text = String(sourceText || '');
    const rules = [
      [/금발|블론드|golden blond|blond/gi, '금발'],
      [/흑발|검은 머리|black hair/gi, '흑발'],
      [/백발|하얀 머리|white hair/gi, '백발'],
      [/갈색 머리|brown hair/gi, '갈색 머리'],
      [/장발|long hair/gi, '장발'],
      [/단발|short hair/gi, '단발'],
      [/파란 눈|푸른 눈|blue eyes/gi, '파란 눈'],
      [/갈색 눈|brown eyes/gi, '갈색 눈'],
      [/검은 눈|black eyes|dark eyes/gi, '검은 눈'],
      [/안경|glasses/gi, '안경'],
      [/키가 크|장신|tall/gi, '큰 키'],
      [/작은 체구|작은 키|petite|small build/gi, '작은 체구'],
      [/넓은 어깨|broad shoulders/gi, '넓은 어깨'],
      [/마른 체형|slim/gi, '마른 체형'],
      [/근육|탄탄한 체격|muscular/gi, '탄탄한 체격'],
      [/문신|tattoo/gi, '문신'],
      [/흉터|scar/gi, '흉터'],
      [/무심한 인상|무뚝뚝/gi, '무심한 인상'],
      [/순한 인상|온순한 인상/gi, '순한 인상'],
      [/고양이상/gi, '고양이상'],
      [/강아지상/gi, '강아지상'],
    ];

    const found = [];
    for (const [regex, label] of rules) {
      regex.lastIndex = 0;
      if (regex.test(text) && !found.includes(label)) found.push(label);
    }
    return found;
  }

  function buildAutoAppearance(profile, recentText, kindLabel) {
    const blocks = [];

    if (profile.description) {
      blocks.push(`[공개 설명]\n${profile.description}`);
    }

    const inferred = inferAppearanceTags(joinMaybe(profile.description, recentText));
    if (inferred.length) {
      blocks.push(`[자동 추출 단서]\n${inferred.join(', ')}`);
    }

    if (profile.imageUrl) {
      blocks.push(`[레퍼런스]\n${kindLabel} 프로필 이미지 기반 외형/분위기 반영`);
    }

    if (!profile.imageUrl && !profile.description && !inferred.length) {
      blocks.push('[정보 부족]\n프로필 이미지와 소개글이 없습니다. 대화에서 확인되는 정보만 참고하고, 필요한 경우 수동 입력 권장.');
    }

    return blocks.join('\n\n').trim();
  }

  function collectRecentMessages(limit = CONFIG.MESSAGE_LIMIT) {
    const rows = [];

    qsa('[data-sentry-component="LeftTextContent"]').forEach(el => {
      const text = cleanText(qs('.chat', el)?.innerText || el.innerText || '');
      if (text) rows.push({ speaker: 'character', text });
    });

    qsa('[data-sentry-component="RightTextContent"]').forEach(el => {
      const text = cleanText(qs('.chat', el)?.innerText || el.innerText || '');
      if (text) rows.push({ speaker: 'user', text });
    });

    qsa('[data-sentry-component="NarratorBubble"]').forEach(el => {
      const text = cleanText(qs('.chat', el)?.innerText || el.innerText || '');
      if (text) rows.push({ speaker: 'narrator', text });
    });

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
      const checkBadge = qs('.bg-primary-400 svg', item);
      const disabledButton = qsa('button', item).some(btn => btn.disabled);
      return !!checkBadge || disabledButton;
    });

    if (!active) throw new Error('체크된 현재 사용 프로필을 찾지 못했어.');

    const name =
      cleanText(qs('.body1', active)?.textContent) ||
      cleanText(qs('img', active)?.alt) ||
      '유저';

    const description = cleanText(qs('.caption1', active)?.textContent) || '';
    const imageUrl = qs('img', active)?.currentSrc || qs('img', active)?.src || '';

    const profile = {
      id: active.getAttribute('data-profile-id') || null,
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

  function collectCharacterProfileFromCurrentPage() {
    const plotId = getPlotIdFromUrl();
    if (!plotId || !/\/profile/.test(location.pathname)) {
      throw new Error('캐릭터 프로필 페이지에서 실행해줘. (/plots/.../profile)');
    }

    const ogTitle = qs('meta[property="og:title"]')?.content || '';
    const h1Text = cleanText(qs('h1')?.textContent || '');
    const candidates = [h1Text, cleanText(ogTitle)]
      .filter(Boolean)
      .map(t => t.replace(/\s*[|｜-]\s*제타.*$/i, '').trim());

    const name = candidates[0] || '캐릭터';

    const descRoots = [
      qs('[data-sentry-component="PlotLongDescription"]'),
      qs('[data-sentry-component="PlotIntro"]'),
    ].filter(Boolean);

    const descTexts = [];
    for (const root of descRoots) {
      const text = cleanText(root.innerText || root.textContent || '');
      if (text && text !== '캐릭터' && text !== '인트로' && text !== name) {
        descTexts.push(text);
      }
    }
    const description = [...new Set(descTexts)].join('\n').trim();

    const imageCandidates = [];
    qsa('img').forEach(img => {
      const src = img.currentSrc || img.src || '';
      const srcset = img.getAttribute('srcset') || '';

      if (/profile-image|plot-cover-image|image\.zeta-ai\.io/i.test(src)) {
        imageCandidates.push(src);
      }

      if (srcset) {
        srcset.split(',').forEach(part => {
          const u = cleanText(part.split(' ')[0]);
          if (/profile-image|plot-cover-image|image\.zeta-ai\.io/i.test(u)) {
            imageCandidates.push(u);
          }
        });
      }
    });

    qsa('link[rel="preload"][as="image"]').forEach(link => {
      const srcset = link.getAttribute('imagesrcset') || '';
      srcset.split(',').forEach(part => {
        const u = cleanText(part.split(' ')[0]);
        if (/profile-image|plot-cover-image|image\.zeta-ai\.io/i.test(u)) imageCandidates.push(u);
      });
    });

    const imageUrl = pickBestImageUrl(imageCandidates);

    const profile = {
      id: plotId,
      kind: 'character',
      name,
      description,
      imageUrl,
      source: 'plot-profile-page',
      updatedAt: Date.now(),
    };

    save(CONFIG.STORAGE.CHARACTER, profile);
    return profile;
  }

  function buildDraftFromCache() {
    const character = load(CONFIG.STORAGE.CHARACTER, {
      id: null,
      kind: 'character',
      name: '캐릭터',
      description: '',
      imageUrl: '',
    });

    const userProfile = load(CONFIG.STORAGE.USER, {
      id: null,
      kind: 'user',
      name: '유저',
      description: '',
      imageUrl: '',
    });

    const global = load(CONFIG.STORAGE.GLOBAL, {});
    const messages = collectRecentMessages();
    const recentText = messages.map(m => m.text).join('\n');

    return {
      source: 'cache',
      roomId: getRoomId(),
      anchor: buildAnchor(messages),
      messages,
      stylePreset: global.stylePreset || '2d',
      additionalInstructions: global.additionalInstructions || CONFIG.DEFAULT_INSTRUCTIONS,
      character: {
        ...character,
        appearancePrompt:
          character.manualAppearancePrompt ||
          buildAutoAppearance(character, recentText, '캐릭터'),
      },
      userProfile: {
        ...userProfile,
        appearancePrompt:
          userProfile.manualAppearancePrompt ||
          buildAutoAppearance(userProfile, recentText, '유저'),
      },
    };
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
        appearancePrompt: buildAutoAppearance(character, recentText, '캐릭터'),
      },
      userProfile: {
        ...baseUser,
        appearancePrompt: buildAutoAppearance(baseUser, recentText, '유저'),
      },
    };
  }

  async function fetchBlobWithCreds(url) {
    if (url.startsWith('data:')) {
      const res = await fetch(url);
      return await res.blob();
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

  async function sendDraftToRelay(draft) {
    const payload = {
      clientId: getClientId(),
      roomId: draft.roomId || 'manual-room',
      anchor: draft.anchor || { messageId: null, hash: null, preview: '' },
      messages: draft.messages || [],
      character: {
        id: draft.character.id || null,
        kind: 'character',
        name: draft.character.name || '',
        description: draft.character.description || '',
        imageUrl: draft.character.imageUrl || '',
        appearancePrompt: draft.character.appearancePrompt || '',
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
      if (draft.character.imageUrl) {
        charUpload = await uploadImageToRelay(token, 'character', draft.character.imageUrl);
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

    return {
      create: createData,
      uploads: {
        character: charUpload,
        user: userUpload,
      },
      getSnapshotUrl: `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}`,
      getStatusUrl: `${CONFIG.RELAY_BASE}/snapshots/${encodeURIComponent(token)}/status`,
    };
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

        <div class="zs-tools">
          <button type="button" data-zs-action="load-real">실제 초안 불러오기</button>
          <button type="button" data-zs-action="mock-image-only">테스트: 프사만</button>
          <button type="button" data-zs-action="mock-full">테스트: 프사+설명</button>
          <button type="button" data-zs-action="mock-empty">테스트: 아무것도 없음</button>
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
              <label>캐릭터 이름</label>
              <input id="zs-char-name" type="text" />
            </div>

            <div class="zs-field zs-span2">
              <label>캐릭터 원본 설명</label>
              <textarea id="zs-char-desc"></textarea>
            </div>

            <div class="zs-field zs-span2">
              <label>캐릭터 외형 프롬프트 (자동 수집 + 수정 가능)</label>
              <textarea id="zs-char-appearance"></textarea>
            </div>

            <div class="zs-field">
              <label>캐릭터 이미지 URL</label>
              <input id="zs-char-image" type="text" />
            </div>

            <div class="zs-field">
              <label>캐릭터 프리뷰</label>
              <div class="zs-preview"><img id="zs-char-preview" /></div>
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
              <label>유저 외형 프롬프트 (자동 수집 + 수정 가능)</label>
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
            <button type="button" class="primary" data-zs-action="save-local">로컬 저장</button>
            <button type="button" class="primary" data-zs-action="send-relay">서버로 테스트 전송</button>
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
      if (action === 'load-real') return openDraft(buildDraftFromCache());
      if (action === 'mock-image-only') return openDraft(getMockDraft('image-only'));
      if (action === 'mock-full') return openDraft(getMockDraft('full'));
      if (action === 'mock-empty') return openDraft(getMockDraft('empty'));

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
          state.resultBox.textContent = JSON.stringify(result, null, 2);
          flash('서버 전송 성공');
        } catch (err) {
          console.error(err);
          state.resultBox.textContent = `오류:\n${String(err.message || err)}`;
          flash('전송 실패');
        }
      }
    });

    overlay.addEventListener('input', e => {
      if (e.target.id === 'zs-char-image') {
        qs('#zs-char-preview', overlay).src = e.target.value || '';
      }
      if (e.target.id === 'zs-user-image') {
        qs('#zs-user-preview', overlay).src = e.target.value || '';
      }
    });
  }

  function openModal() {
    ensureModal();
    state.overlay.style.display = 'flex';
  }

  function closeModal() {
    if (state.overlay) state.overlay.style.display = 'none';
  }

  function openDraft(draft) {
    ensureModal();
    openModal();
    state.currentDraft = structuredClone(draft);

    qs('#zs-style').value = draft.stylePreset || '2d';
    qs('#zs-room').value = draft.roomId || '';

    qs('#zs-char-name').value = draft.character.name || '';
    qs('#zs-char-desc').value = draft.character.description || '';
    qs('#zs-char-appearance').value = draft.character.appearancePrompt || '';
    qs('#zs-char-image').value = draft.character.imageUrl || '';
    qs('#zs-char-preview').src = draft.character.imageUrl || '';

    qs('#zs-user-name').value = draft.userProfile.name || '';
    qs('#zs-user-desc').value = draft.userProfile.description || '';
    qs('#zs-user-appearance').value = draft.userProfile.appearancePrompt || '';
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

    return {
      source: state.currentDraft?.source || 'form',
      roomId: qs('#zs-room').value.trim() || getRoomId(),
      anchor,
      messages,
      stylePreset: qs('#zs-style').value,
      additionalInstructions: qs('#zs-extra').value.trim(),
      character: {
        ...(state.currentDraft?.character || {}),
        name: qs('#zs-char-name').value.trim(),
        description: qs('#zs-char-desc').value.trim(),
        imageUrl: qs('#zs-char-image').value.trim(),
        appearancePrompt: qs('#zs-char-appearance').value.trim(),
        manualAppearancePrompt: qs('#zs-char-appearance').value.trim(),
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
      updatedAt: Date.now(),
    });

    save(CONFIG.STORAGE.USER, {
      ...(load(CONFIG.STORAGE.USER, {}) || {}),
      ...draft.userProfile,
      updatedAt: Date.now(),
    });
  }

  function createLauncher() {
    if (qs('.zs-launcher')) return;

    const wrap = document.createElement('div');
    wrap.className = 'zs-launcher';
    wrap.innerHTML = `
      <button type="button" data-zs-launch="draft" title="스냅샷 초안">📷</button>
      <button type="button" data-zs-launch="character" title="현재 페이지 캐릭터 저장">🎭</button>
      <button type="button" data-zs-launch="user" title="체크된 유저 프로필 저장">👤</button>
      <button type="button" data-zs-launch="test" title="테스트 케이스">🧪</button>
    `;

    wrap.addEventListener('click', e => {
      const btn = e.target.closest('[data-zs-launch]');
      if (!btn) return;

      const type = btn.dataset.zsLaunch;

      try {
        if (type === 'character') {
          const profile = collectCharacterProfileFromCurrentPage();
          flash(`캐릭터 저장: ${profile.name}`);
          return;
        }

        if (type === 'user') {
          const profile = collectSelectedUserProfileFromDialog();
          flash(`유저 저장: ${profile.name}`);
          return;
        }

        if (type === 'draft') {
          openDraft(buildDraftFromCache());
          return;
        }

        if (type === 'test') {
          openDraft(getMockDraft('image-only'));
        }
      } catch (err) {
        console.error(err);
        alert(String(err.message || err));
      }
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
      .zs-tools{
        display:flex;
        gap:8px;
        flex-wrap:wrap;
        padding:12px 18px 0;
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
        max-width:100%;
        max-height:180px;
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
      }
    `;

    document.head.appendChild(style);
  }

  function init() {
    injectStyles();
    createLauncher();
    console.log('[ZETA Snapshot Test] ready');
  }

  init();
})();