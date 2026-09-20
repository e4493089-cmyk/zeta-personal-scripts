// ==UserScript==
// @name         Zeta Room Manager 숨김 프로필 수집
// @namespace    zeta-room-manager-hidden-collector
// @version      0.1.5
// @description  대화방 목록을 유지하며 숨긴 화면에서 방과 플롯 프로필을 차례로 열어 이름을 채웁니다.
// @match        https://zeta-ai.io/ko/rooms
// @match        https://zeta-ai.io/ko/rooms/
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  if (window !== window.top) return;
  const STATE_KEY = 'zeta-room-manager:v1';
  const SESSION_KEY = 'zrm-hidden-collector-session:v1';
  const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const names = value => Array.isArray(value) ? [...new Set(value.map(x => String(x || '').trim()).filter(Boolean))] : [];
  let active = false;
  const frames = new Set();
  let jobs = [];
  let completed = 0;
  let results = [];
  let failures = [];
  let status = '';
  let verified = false;
  let wakeLock = null;
  let wakeStatus = '';
  let wakeEvents = [];
  try {
    const previous = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
    results = Array.isArray(previous.results) ? previous.results : [];
    failures = Array.isArray(previous.failures) ? previous.failures : [];
    wakeEvents = Array.isArray(previous.wakeEvents) ? previous.wakeEvents : [];
    completed = results.length;
    verified = completed > 0;
  } catch (_) {}
  function preserve() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ results, failures, wakeEvents })); } catch (_) {}
  }
  const logWake = (event, detail = '') => wakeEvents.push({ at: new Date().toISOString(), event, detail });

  async function holdScreen() {
    if (!navigator.wakeLock?.request) { wakeStatus = '화면 켜짐 기능 미지원'; logWake('unsupported'); panel(); return; }
    if (wakeLock || !active || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      if (!active) { await releaseScreen(); return; }
      logWake('acquired');
      const held = wakeLock;
      held.addEventListener('release', () => {
        if (wakeLock !== held) return;
        wakeLock = null;
        wakeStatus = '화면 켜짐 유지가 해제됐습니다';
        logWake('released-by-browser', document.visibilityState);
        panel();
      });
      wakeStatus = '화면 켜짐 유지 중';
    } catch (error) {
      wakeStatus = '화면 켜짐 유지 실패: ' + (error?.name || '브라우저 제한');
      logWake('rejected', String(error?.name || error));
    }
    panel();
  }
  async function releaseScreen() {
    const held = wakeLock;
    wakeLock = null;
    wakeStatus = '';
    if (held) { try { await held.release(); } catch (_) {} }
  }
  document.addEventListener('visibilitychange', () => {
    if (active) logWake('visibility', document.visibilityState);
    if (active && document.visibilityState === 'visible') void holdScreen();
  });
  window.addEventListener('pagehide', () => { active = false; void releaseScreen(); });

  function getState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch { return {}; }
  }
  function putState(state) {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }
  function mergeKnown(state) {
    const plots = new Map(Object.values(state.index || {}).filter(e => e?.type === 'plot' && uuid.test(e.plotId || '')).map(e => [e.plotId, e]));
    let joined = 0;
    for (const room of Object.values(state.index || {})) {
      if (room?.type !== 'room') continue;
      const plot = plots.get(room.plotId);
      if (!plot) continue;
      joined++;
      room.characterNames = names([...names(room.characterNames), ...names(plot.characterNames)]);
      room.creatorNames = names([...names(room.creatorNames), ...names(plot.creatorNames)]);
    }
    return joined;
  }
  function prepare() {
    const state = getState();
    const joined = mergeKnown(state);
    putState(state);
    const failedIds = new Set(failures.map(item => item.roomId));
    const missing = Object.values(state.index || {}).filter(e => e?.type === 'room' && uuid.test(e.id || '') && !failedIds.has(e.id) &&
      (!names(e.characterNames).length || !names(e.creatorNames).length));
    const seen = new Set();
    jobs = missing.filter(e => !seen.has(e.plotId) && seen.add(e.plotId)).map(e => e.id);
    return { joined, rooms: missing.length, uniquePlots: jobs.length };
  }

  function downloadJson(filename, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function panel() {
    let element = document.getElementById('zrm-hidden-collector');
    if (!element) {
      element = document.createElement('div');
      element.id = 'zrm-hidden-collector';
      element.style.cssText = 'position:fixed;z-index:2147483646;bottom:90px;right:10px;width:min(315px,90vw);box-sizing:border-box;padding:12px;border-radius:12px;background:#231e30;color:white;box-shadow:0 3px 16px #000a;font:13px/1.45 sans-serif';
      document.body.append(element);
    }
    element.replaceChildren();
    const title = document.createElement('strong'); title.textContent = '방 이름 수집'; element.append(title);
    const detail = document.createElement('div'); detail.style.margin = '6px 0';
    detail.textContent = status || '대화방 목록에서 숨김 화면 수집을 시작할 수 있습니다.'; element.append(detail);
    const count = document.createElement('div'); count.textContent = `수집 ${completed}개 · 남은 플롯 ${jobs.length}개 · 실패 ${failures.length}개`; element.append(count);
    if (wakeStatus) { const wake = document.createElement('div'); wake.textContent = wakeStatus; wake.style.color = wakeLock ? '#baf2ba' : '#ffb7b7'; element.append(wake); }
    if (failures.length) {
      const failed = document.createElement('div'); failed.textContent = '최근 실패: ' + failures.at(-1).reason; failed.style.color = '#ffb7b7'; element.append(failed);
    }
    const button = (label, handler) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'margin:6px 5px 0 0;padding:7px;border:0;border-radius:6px;background:#fff;color:#17121f'; b.onclick = handler; element.append(b); };
    if (!active) {
      button('1개 숨김 테스트', () => start(1));
      button('3개 창 동시 수집', () => start(3));
      if (failures.length) button('실패 항목 재시도', () => { failures = []; preserve(); prepare(); status = '실패 항목을 다시 수집할 수 있습니다.'; panel(); });
    } else {
      button('중지', () => {
        active = false;
        for (const frame of frames) frame.remove();
        frames.clear();
        void releaseScreen(); status = '중지됨. 수집한 이름은 저장됐습니다.'; panel();
      });
      if (!wakeLock) button('화면 켜짐 재시도', () => { void holdScreen(); });
    }
    if (completed || failures.length) {
      button('수정된 백업 JSON', () => downloadJson('zeta-room-manager-hidden-collection.json', {
        format: 'zeta-room-manager-backup', version: 1, exportedAt: new Date().toISOString(), state: getState()
      }));
      button('테스트 결과 JSON', () => downloadJson('zeta-room-hidden-test-results.json', {
        exportedAt: new Date().toISOString(), completed, remaining: jobs.length, results, failures, status, wakeEvents
      }));
    }
    button('창 닫기', () => { if (!active) element.remove(); });
  }

  async function until(find, ms, detail) {
    const end = Date.now() + ms;
    while (active && Date.now() < end) {
      try { const result = find(); if (result) return result; }
      catch (e) { if (e instanceof DOMException && e.name === 'SecurityError') throw new Error('숨김 화면 접근이 차단됐습니다.'); throw e; }
      await sleep(250);
    }
    if (!active) throw new Error('사용자가 중지했습니다.');
    throw new Error(detail);
  }

  async function visit(roomId) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:390px;height:850px;opacity:0;pointer-events:none;border:0';
    frames.add(frame);
    document.body.append(frame);
    frame.src = '/ko/rooms/' + roomId;
    try {
      const button = await until(() => {
        const win = frame.contentWindow;
        if (!win || !win.location.pathname.includes(roomId)) return null;
        return win.document.querySelector('button[data-testid="chat-header-profile"][aria-label="Open plot profile"]');
      }, 18000, '숨긴 방 화면이 열리지 않았습니다. 프레임 차단 또는 로딩 실패일 수 있습니다.');
      button.click();
      const result = await until(() => {
        const win = frame.contentWindow;
        if (!win || !/^\/ko\/plots\/[a-f\d-]{36}\/profile\/?$/i.test(win.location.pathname)) return null;
        const root = win.document.querySelector('[data-sentry-component="PlotProfile"]');
        if (!root) return null;
        const creator = names([...root.querySelectorAll('a[href*="/creators/"][href*="/profile"]')]
          .map(a => a.querySelector('span.caption1:not([data-sentry-element="Span"])')?.textContent));
        if (!creator.length) return null;
        const characters = names([...root.querySelectorAll('img[alt^="Profile image of "]')]
          .map(img => img.getAttribute('alt').slice('Profile image of '.length)));
        return { creator, characters, profileId: win.location.pathname.split('/')[3] };
      }, 18000, '프로필 또는 제작자명을 읽지 못했습니다.');
      return result;
    } finally {
      if (frame.isConnected) { frame.src = 'about:blank'; frame.remove(); }
      frames.delete(frame);
    }
  }

  function commit(roomId, result) {
    const state = getState();
    const entry = state.index?.['room:' + roomId];
    if (!entry) throw new Error('방이 Room Manager 인덱스에 없습니다.');
    const plotId = entry.plotId;
    for (const room of Object.values(state.index)) {
      if (room?.plotId !== plotId) continue;
      room.creatorNames = names([...names(room.creatorNames), ...result.creator]);
      room.characterNames = names([...names(room.characterNames), ...result.characters]);
    }
    state.plotMeta ||= {};
    const meta = state.plotMeta[plotId] || {};
    state.plotMeta[plotId] = { ...meta, plotId, canonicalId: result.profileId,
      creatorNames: names([...names(meta.creatorNames), ...result.creator]),
      characterNames: names([...names(meta.characterNames), ...result.characters]), updatedAt: Date.now() };
    putState(state);
  }

  async function start(limit) {
    if (active) return;
    active = true;
    // 터치 핸들러 안에서 첫 비동기 요청을 즉시 시작해야 모바일 브라우저가 허용할 수 있다.
    const wakePromise = holdScreen();
    const counts = prepare();
    if (!counts.rooms) { active = false; await wakePromise; await releaseScreen(); status = '빈 이름이 없습니다. Room Manager의 대화방 전체 수집을 먼저 실행했는지도 확인하세요.'; panel(); return; }
    await wakePromise;
    let successes = 0;
    status = `내 플롯 ${counts.joined}개 매칭 · 빈 방 ${counts.rooms}개 (${counts.uniquePlots}개 플롯).`;
    panel();
    const batch = jobs.slice(0, limit);
    status = `수집 중… 숨긴 창 ${batch.length}개를 동시에 열어 프로필을 확인합니다.`;
    panel();
    await Promise.all(batch.map(async roomId => {
      try {
        const result = await visit(roomId);
        if (!active) return;
        commit(roomId, result);
        results.push({ roomId, ...result });
        completed++;
        successes++;
        verified = true;
        preserve();
      } catch (e) {
        if (!active) return;
        failures.push({ roomId, reason: String(e.message || e) });
        preserve();
      }
      jobs = jobs.filter(id => id !== roomId);
      panel();
    }));
    if (!active) return;
    active = false;
    await releaseScreen();
    status = limit === 1 ?
      (successes ? '숨김 테스트 완료. JSON을 저장하거나 다음 3개를 수집하세요.' : '숨김 테스트 실패. 테스트 결과 JSON에서 이유를 확인하세요.') :
      (jobs.length ? '동시 3개 수집 종료. 숨긴 창을 모두 닫았습니다. 새로고침한 뒤 다음 3개를 누르세요.' : '수집 완료. JSON을 저장하고 Room Manager 화면을 새로고침하면 반영됩니다.');
    panel();
  }
  prepare();
  panel();
})();
