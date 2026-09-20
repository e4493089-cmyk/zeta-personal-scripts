// ==UserScript==
// @name         Zeta 방 프로필 화면 수집 테스트 (최대 3개)
// @namespace    zeta-room-manager-diagnostic
// @version      0.1.0
// @description  Room Manager 백업과 내 플롯을 ID로 대조하고, 빈 방 세 개까지 실제 화면 이동으로 검사합니다.
// @match        https://zeta-ai.io/ko/rooms*
// @match        https://zeta-ai.io/ko/rooms/*
// @match        https://zeta-ai.io/ko/plots/*/profile*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  const KEY = 'zeta-room-profile-macro-test-v1';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const save = data => sessionStorage.setItem(KEY, JSON.stringify(data));
  let data = read();
  const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
  const roomPath = /^\/ko\/rooms\/([\da-f-]{36})\/?$/;
  const profilePath = /^\/ko\/plots\/([\da-f-]{36})\/profile\/?$/;
  const clean = value => String(value || '').trim();
  const unique = values => [...new Set(values.filter(Boolean))];
  const names = value => unique(Array.isArray(value) ? value.map(clean) : []);
  const getRoom = () => data?.state?.index?.['room:' + data.current];

  function observe(stage) {
    if (!data) return;
    const urls = performance.getEntriesByType('resource')
      .filter(e => ['fetch', 'xmlhttprequest'].includes(e.initiatorType))
      .map(e => e.name)
      .filter(url => /^https:\/\/(?:[^/]+\.)?zeta-ai\.io\//i.test(url))
      .map(url => { try { return new URL(url).pathname; } catch { return url; } });
    data.trace.push({ stage, roomId: data.current, page: location.pathname, observedFetchXhr: urls.length, paths: urls.slice(0, 30) });
    save(data);
  }

  function stop(message) {
    if (!data) return;
    data.active = false;
    data.message = message;
    save(data);
    draw();
  }

  function next() {
    if (!data?.active) return;
    if (!data.queue.length) { stop('테스트 완료. 아래에서 결과를 저장하세요.'); return; }
    data.current = data.queue.shift();
    data.stage = 'room';
    data.message = '방 화면으로 이동 중: ' + data.current;
    save(data);
    location.assign('/ko/rooms/' + data.current);
  }

  function extractProfile() {
    const root = document.querySelector('[data-sentry-component="PlotProfile"]');
    if (!root) return null;
    const creatorLinks = [...root.querySelectorAll('a[href*="/creators/"][href*="/profile"]')];
    const creatorNames = unique(creatorLinks.map(a => clean(a.querySelector('span:not([data-sentry-element="Span"])')?.textContent)));
    const characterNames = unique([...root.querySelectorAll('img[alt^="Profile image of "]')]
      .map(img => clean(img.getAttribute('alt').slice('Profile image of '.length))));
    return { creatorNames, characterNames, creatorPaths: unique(creatorLinks.map(a => a.getAttribute('href'))) };
  }

  let waiting = false;
  function process() {
    if (!data?.active) return;
    const roomId = location.pathname.match(roomPath)?.[1];
    const profileId = location.pathname.match(profilePath)?.[1];
    if (waiting) return;
    if (data.stage === 'room' && roomId === data.current) {
      waiting = true;
      waitFor(() => [...document.querySelectorAll('button[data-sentry-component="LogRawButton"]')]
        .find(button => button.querySelector('span.title16')?.textContent.trim() === clean(getRoom()?.original)), button => {
        observe('room-before-header-click');
        data.stage = 'profile'; save(data);
        button.click(); // 사이트의 실제 채팅 헤더 버튼을 누른다.
        setTimeout(() => { if (read()?.active && read()?.stage === 'profile' && location.pathname.match(roomPath)) stop('헤더를 눌렀지만 프로필로 이동하지 않았습니다.'); }, 12000);
      }, '방 헤더 버튼을 찾지 못했습니다.');
    } else if (data.stage === 'profile') {
      // 클릭 후 Next.js가 새로고침 없이 주소를 바꿀 수 있다.
      if (!profileId) return;
      waiting = true;
      waitFor(() => profileId && extractProfile(), result => {
        observe('profile-after-header-click');
        const room = getRoom();
        if (!room) { stop('현재 방을 백업에서 찾지 못했습니다.'); return; }
        if (!result.creatorNames.length) { stop('프로필은 열렸지만 제작자 이름을 읽지 못했습니다. 현재 방에서 멈췄습니다.'); return; }
        room.creatorNames = unique([...names(room.creatorNames), ...result.creatorNames]);
        room.characterNames = unique([...names(room.characterNames), ...result.characterNames]);
        data.state.plotMeta ||= {};
        const plotId = room.plotId;
        if (uuid.test(plotId || '')) {
          const old = data.state.plotMeta[plotId] || {};
          data.state.plotMeta[plotId] = { ...old, plotId, canonicalId: profileId,
            creatorNames: room.creatorNames, characterNames: room.characterNames };
        }
        data.results.push({ roomId: data.current, plotId, profileId, ...result });
        data.current = null;
        data.stage = 'list';
        save(data);
        location.assign('/ko/rooms');
      }, '프로필 DOM 또는 제작자 링크를 찾지 못했습니다.');
    } else if (data.stage === 'list' && location.pathname === '/ko/rooms') {
      observe('list-after-profile');
      next();
    } else {
      stop('예상하지 못한 화면입니다: ' + location.pathname);
    }
  }

  function waitFor(find, done, failure) {
    let attempts = 0;
    const timer = setInterval(() => {
      if (!read()?.active) { clearInterval(timer); return; }
      const found = find();
      if (found) { clearInterval(timer); done(found); }
      else if (++attempts >= 40) { clearInterval(timer); stop(failure); }
    }, 300);
  }

  function addExport(filename, object) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(object, null, 2)], { type: 'application/json' }));
    a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  function draw() {
    let box = document.getElementById('zeta-room-macro-test');
    if (!box) {
      box = document.createElement('div'); box.id = 'zeta-room-macro-test';
      box.style.cssText = 'position:fixed;z-index:2147483647;bottom:75px;right:10px;max-width:min(330px,90vw);background:#1d1b24;color:white;padding:12px;border:1px solid #aaa;border-radius:12px;font:13px/1.5 sans-serif;box-shadow:0 2px 12px #0008';
      document.body.append(box);
    }
    box.replaceChildren();
    const heading = document.createElement('div'); heading.textContent = '방 프로필 화면 수집 테스트'; heading.style.fontWeight = 'bold'; box.append(heading);
    const info = document.createElement('div');
    info.textContent = data ? `${data.message || ''} | 수집 ${data.results.length}개 / 남은 ${data.queue.length}개` : 'Room Manager JSON을 선택하세요. 최대 3개 방만 방문합니다.';
    box.append(info);
    function button(label, action) { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'padding:6px;margin:4px;color:#111;background:#fff;border-radius:6px'; b.onclick = action; box.append(b); }
    if (!data?.active && location.pathname === '/ko/rooms') {
      button('JSON 선택', () => { const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.onchange = async () => {
        try {
          const backup = JSON.parse(await input.files[0].text());
          if (backup.format !== 'zeta-room-manager-backup' || !backup.state?.index) throw Error('Room Manager 백업 JSON이 아닙니다.');
          const state = backup.state;
          const plots = new Map(Object.values(state.index).filter(x => x.type === 'plot' && uuid.test(x.plotId || '')).map(x => [x.plotId, x]));
          let matched = 0;
          for (const room of Object.values(state.index).filter(x => x.type === 'room')) {
            const plot = plots.get(room.plotId);
            if (!plot) continue;
            matched++;
            room.creatorNames = unique([...names(room.creatorNames), ...names(plot.creatorNames)]);
            room.characterNames = unique([...names(room.characterNames), ...names(plot.characterNames)]);
          }
          const missing = Object.values(state.index).filter(x => x.type === 'room' && !names(x.creatorNames).length && uuid.test(x.id || ''));
          data = { format: backup.format, version: backup.version, exportedAt: backup.exportedAt, state,
            queue: missing.slice(0, 3).map(x => x.id), results: [], trace: [], active: false, stage: 'list', current: null,
            message: `내 플롯 ID 매칭 ${matched}개. 미수집 ${missing.length}개 중 앞의 ${Math.min(3,missing.length)}개 테스트 준비.` };
          save(data); draw();
        } catch (e) { alert('JSON을 읽지 못했습니다: ' + e.message); }
      }; input.click(); });
      if (data?.queue.length) button('3개 테스트 시작', () => { data.active = true; save(data); next(); });
    }
    if (data?.active) button('중지', () => stop('사용자가 중지했습니다.'));
    if (data) {
      button('결과 JSON', () => addExport('zeta-room-profile-test-results.json', { results: data.results, trace: data.trace, message: data.message, remaining: data.queue, current: data.current }));
      button('수정된 백업', () => addExport('zeta-room-manager-macro-test.json', { format: data.format, version: data.version, exportedAt: new Date().toISOString(), state: data.state }));
    }
  }

  draw();
  if (data?.active) { process(); setInterval(process, 400); }
})();
