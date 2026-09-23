// ==UserScript==
// @name         Zeta 플롯 일괄 삭제
// @namespace    zeta-personal-scripts
// @version      0.1.0
// @description  크리에이터 센터의 삭제 버튼에서 여러 플롯을 체크해 한 번에 삭제합니다.
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

  const API = 'https://api.zeta-ai.io';
  const VERSION = '3.49.59';
  const HEADER_SELECTOR = '[data-sentry-component="CreatorCenterMyPlotListHeader"]';
  const SECTIONS = [
    { key: 'public', label: '공개', status: 'RELEASE', isPrivate: false },
    { key: 'private', label: '비공개', status: 'RELEASE', isPrivate: true },
    { key: 'draft', label: '미등록', status: 'PRERELEASE' }
  ];
  const state = {
    plots: [], selected: new Set(), search: '', visibility: 'all',
    loading: false, deleting: false, loaded: false, result: null
  };

  function cookie(name) {
    const prefix = name + '=';
    for (const part of String(document.cookie || '').split(';')) {
      const value = part.trim();
      if (value.startsWith(prefix)) {
        try { return decodeURIComponent(value.slice(prefix.length)); }
        catch (_) { return value.slice(prefix.length); }
      }
    }
    return '';
  }

  function tokenFrom(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string') text = parsed;
      else if (parsed && typeof parsed === 'object') {
        text = String(parsed.accessToken || parsed.access_token || parsed.token || parsed.TOKEN || '');
      }
    } catch (_) {}
    text = text.replace(/^Bearer\s+/i, '');
    const jwt = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return jwt ? jwt[0] : text;
  }

  function token() {
    const fromCookie = tokenFrom(cookie('TOKEN'));
    if (fromCookie) return fromCookie;
    for (const storage of [localStorage, sessionStorage]) {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) || '';
          if (!/token|auth|session/i.test(key)) continue;
          const found = tokenFrom(storage.getItem(key));
          if (found) return found;
        }
      } catch (_) {}
    }
    return '';
  }

  function headers(extra = {}) {
    const accessToken = token();
    if (!accessToken) throw new Error('제타 로그인 정보를 찾지 못했습니다.');
    const result = {
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken,
      'X-Client-Version': VERSION,
      'X-Client-Native-Version': VERSION,
      'X-Client-Type': 'web',
      'X-Device-Type': /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'web' : 'pc_web',
      'X-User-Language': 'KOREAN',
      ...extra
    };
    const sticky = cookie('DEVICE_ID');
    if (sticky) result['X-Sticky'] = sticky;
    return result;
  }

  async function readJson(response) {
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) {}
    }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error || `요청 실패 (${response.status})`);
      error.status = response.status;
      error.code = data?.code;
      throw error;
    }
    return data;
  }

  function plotName(plot) {
    return plot?.name || plot?.draft?.name || plot?.characters?.[0]?.name ||
      plot?.draft?.characters?.[0]?.name || '제목 없음';
  }

  function normalizePlot(plot, section) {
    return {
      id: plot.id,
      name: plotName(plot),
      mode: plot.mode || 'STORY_CHAT',
      language: plot.language || 'KOREAN',
      status: plot.status || section.status,
      visibility: section.key,
      visibilityLabel: section.label
    };
  }

  async function listSection(section) {
    const plots = [];
    const seenCursors = new Set();
    let cursor = '';
    for (let page = 0; page < 100; page += 1) {
      const url = new URL(API + '/v1/plots/creator');
      url.searchParams.set('limit', '100');
      url.searchParams.set('status', section.status);
      url.searchParams.set('orderBy.property', 'UPDATED_AT');
      url.searchParams.set('orderBy.direction', 'DESC');
      if (typeof section.isPrivate === 'boolean') url.searchParams.set('isPrivate', String(section.isPrivate));
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, {
        method: 'GET', headers: headers(), credentials: 'include', cache: 'no-store'
      });
      const data = await readJson(response);
      const pagePlots = Array.isArray(data?.plots) ? data.plots : [];
      plots.push(...pagePlots.map((plot) => normalizePlot(plot, section)));
      const nextCursor = data?.nextCursor;
      if (!nextCursor || pagePlots.length === 0 || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return plots;
  }

  async function listAllPlots() {
    const lists = await Promise.all(SECTIONS.map(listSection));
    const byId = new Map();
    lists.flat().forEach((plot) => { if (plot.id && !byId.has(plot.id)) byId.set(plot.id, plot); });
    return [...byId.values()];
  }

  function languageHeader(language) {
    return ({ KOREAN: 'ko', JAPANESE: 'ja', ENGLISH: 'en' })[language] || 'ko';
  }

  async function deletePlot(plot) {
    try {
      let response;
      if (plot.mode === 'VISUAL_NOVEL') {
        response = await fetch(API + '/v1/labs/visual-novel/creator/plots/' + encodeURIComponent(plot.id), {
          method: 'DELETE',
          headers: headers({ 'Accept-Language': languageHeader(plot.language) }),
          credentials: 'include'
        });
      } else {
        response = await fetch(API + '/v1/plots/' + encodeURIComponent(plot.id) + '/status', {
          method: 'PATCH',
          headers: headers({ 'Content-Type': 'application/json' }),
          credentials: 'include',
          body: JSON.stringify({ status: 'DELETE' })
        });
      }
      await readJson(response);
      return { id: plot.id, ok: true };
    } catch (error) {
      return { id: plot.id, ok: false, status: error.status || null,
        code: error.code || null, message: error.message || '삭제에 실패했습니다.' };
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    .zbd-entry-button{appearance:none;border:0;background:transparent;color:#ff7a7a;cursor:pointer;font:600 13px/1.2 system-ui,sans-serif;padding:5px 0 5px 12px}.zbd-entry-button:hover{color:#ff9b9b}
    #zbd-mode{position:fixed;inset:0;z-index:2147483647;display:none;justify-content:center;background:rgba(0,0,0,.72);font:14px/1.45 system-ui,sans-serif;color:#f7f7f7}#zbd-mode.zbd-open{display:flex}
    #zbd-page{position:relative;width:min(100vw,480px);height:100%;display:flex;flex-direction:column;overflow:hidden;background:#151516;box-shadow:0 0 48px rgba(0,0,0,.5)}
    #zbd-page *{box-sizing:border-box}#zbd-page button,#zbd-page input,#zbd-page select{font:inherit}
    .zbd-header{flex:0 0 auto;background:#151516;border-bottom:1px solid rgba(255,255,255,.07)}.zbd-title-row{height:56px;display:grid;grid-template-columns:72px 1fr 72px;align-items:center;padding:0 16px}.zbd-title{margin:0;text-align:center;font-size:16px;font-weight:700}
    .zbd-cancel,.zbd-reload{border:0;background:transparent;cursor:pointer;padding:8px 0}.zbd-cancel{color:rgba(255,255,255,.72);text-align:left}.zbd-reload{color:rgba(255,255,255,.48);text-align:right;font-size:12px}
    .zbd-controls{padding:10px 16px 12px}.zbd-toolbar{display:flex;align-items:center;gap:8px}.zbd-search,.zbd-filter{min-width:0;height:40px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:#242426;color:#fff;padding:0 12px}.zbd-search{flex:1}.zbd-select-row{display:flex;align-items:center;justify-content:space-between;min-height:34px;margin-top:8px;color:rgba(255,255,255,.55);font-size:12px}.zbd-select-visible,.zbd-clear{border:0;background:transparent;padding:6px 0;cursor:pointer}.zbd-select-visible{color:#fee500}.zbd-clear{color:rgba(255,255,255,.55);margin-left:14px}
    .zbd-list{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 16px 100px}.zbd-row{display:grid;grid-template-columns:26px minmax(0,1fr) auto;align-items:center;gap:11px;min-height:68px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.045);cursor:pointer}.zbd-row input{width:19px;height:19px;margin:0;accent-color:#fee500}.zbd-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.zbd-meta{color:rgba(255,255,255,.45);font-size:12px;margin-top:3px}.zbd-badge{border-radius:999px;padding:4px 7px;background:rgba(255,255,255,.07);color:rgba(255,255,255,.62);font-size:10px;white-space:nowrap}.zbd-badge.zbd-vn{color:#ffe66b;background:rgba(254,229,0,.09)}
    .zbd-empty,.zbd-loading{padding:54px 12px;text-align:center;color:rgba(255,255,255,.5)}.zbd-message{padding:0 16px}.zbd-alert{margin-bottom:10px;border-radius:9px;padding:9px 11px;font-size:12px}.zbd-error{background:rgba(240,82,82,.14);color:#ffb4b4}.zbd-success{background:rgba(61,201,122,.14);color:#a8f0c5}.zbd-progress{margin:0 16px 10px;height:5px;border-radius:999px;background:rgba(255,255,255,.09);overflow:hidden}.zbd-progress>i{display:block;height:100%;width:0;background:#fee500;transition:width .2s}
    .zbd-footer{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:12px 16px max(12px,env(safe-area-inset-bottom));background:linear-gradient(180deg,rgba(21,21,22,0),#151516 22%)}.zbd-delete{width:100%;min-height:48px;border:0;border-radius:12px;background:#f05252;color:#fff;font-weight:750;cursor:pointer;box-shadow:0 8px 26px rgba(0,0,0,.35)}.zbd-delete:disabled{background:#303033;color:rgba(255,255,255,.28);cursor:not-allowed;box-shadow:none}#zbd-page button:disabled{cursor:not-allowed;opacity:.45}
    .zbd-confirm-wrap{position:absolute;inset:0;z-index:4;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.72)}.zbd-confirm{width:min(390px,100%);border:1px solid rgba(255,255,255,.12);border-radius:16px;background:#242427;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.55)}.zbd-confirm h3{margin:0 0 8px;font-size:17px}.zbd-confirm p{margin:0;color:rgba(255,255,255,.65)}.zbd-confirm strong{color:#ff9b9b}.zbd-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.zbd-secondary,.zbd-danger{border:0;border-radius:10px;padding:10px 13px;cursor:pointer}.zbd-secondary{background:rgba(255,255,255,.08);color:#fff}.zbd-danger{background:#f05252;color:#fff;font-weight:700}
  `;
  document.documentElement.appendChild(style);

  const mode = document.createElement('div');
  mode.id = 'zbd-mode';
  mode.setAttribute('role', 'dialog');
  mode.setAttribute('aria-modal', 'true');
  mode.innerHTML = `<section id="zbd-page">
    <header class="zbd-header"><div class="zbd-title-row"><button class="zbd-cancel" type="button">취소</button><h2 class="zbd-title">삭제할 플롯 선택</h2><button class="zbd-reload" type="button">새로고침</button></div>
      <div class="zbd-controls"><div class="zbd-toolbar"><input class="zbd-search" type="search" placeholder="플롯 이름 검색"><select class="zbd-filter"><option value="all">전체</option><option value="public">공개</option><option value="private">비공개</option><option value="draft">미등록</option></select></div>
      <div class="zbd-select-row"><span class="zbd-total">0개 플롯</span><span><button class="zbd-select-visible" type="button">검색 결과 전체 선택</button><button class="zbd-clear" type="button">선택 해제</button></span></div></div>
      <div class="zbd-message"></div><div class="zbd-progress" hidden><i></i></div></header>
    <main class="zbd-list"></main><footer class="zbd-footer"><button class="zbd-delete" type="button" disabled>선택 삭제</button></footer>
  </section>`;
  document.body.appendChild(mode);

  const $ = (selector) => mode.querySelector(selector);
  const page = $('#zbd-page');
  const list = $('.zbd-list');
  const search = $('.zbd-search');
  const filter = $('.zbd-filter');
  const message = $('.zbd-message');
  const progress = $('.zbd-progress');
  const progressBar = $('.zbd-progress>i');
  const total = $('.zbd-total');
  const deleteButton = $('.zbd-delete');

  function visiblePlots() {
    const keyword = state.search.trim().toLocaleLowerCase('ko-KR');
    return state.plots.filter((plot) =>
      (state.visibility === 'all' || plot.visibility === state.visibility) &&
      (!keyword || plot.name.toLocaleLowerCase('ko-KR').includes(keyword))
    );
  }

  function setMessage(text, kind = '') {
    message.innerHTML = '';
    if (!text) return;
    const box = document.createElement('div');
    box.className = 'zbd-alert ' + kind;
    box.textContent = text;
    message.appendChild(box);
  }

  function updateActions() {
    const count = state.selected.size;
    deleteButton.textContent = count ? `${count.toLocaleString()}개 선택 삭제` : '선택 삭제';
    deleteButton.disabled = !count || state.loading || state.deleting;
    $('.zbd-select-visible').disabled = state.loading || state.deleting;
    $('.zbd-clear').disabled = !count || state.loading || state.deleting;
    $('.zbd-cancel').disabled = state.deleting;
    $('.zbd-reload').disabled = state.loading || state.deleting;
  }

  function render() {
    list.innerHTML = '';
    const plots = visiblePlots();
    total.textContent = `${plots.length.toLocaleString()}개 플롯`;
    if (state.loading) {
      list.innerHTML = '<div class="zbd-loading">플롯 목록을 불러오는 중…</div>';
    } else if (!plots.length) {
      list.innerHTML = '<div class="zbd-empty">조건에 맞는 플롯이 없어요.</div>';
    } else {
      const fragment = document.createDocumentFragment();
      for (const plot of plots) {
        const row = document.createElement('label');
        row.className = 'zbd-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.selected.has(plot.id);
        checkbox.disabled = state.deleting;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.selected.add(plot.id); else state.selected.delete(plot.id);
          updateActions();
        });
        const info = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'zbd-name';
        name.textContent = plot.name;
        const meta = document.createElement('div');
        meta.className = 'zbd-meta';
        meta.textContent = plot.visibilityLabel;
        info.append(name, meta);
        const badge = document.createElement('span');
        badge.className = 'zbd-badge' + (plot.mode === 'VISUAL_NOVEL' ? ' zbd-vn' : '');
        badge.textContent = plot.mode === 'VISUAL_NOVEL' ? '비주얼 노벨' : '스토리챗';
        row.append(checkbox, info, badge);
        fragment.appendChild(row);
      }
      list.appendChild(fragment);
    }
    search.disabled = state.loading || state.deleting;
    filter.disabled = state.loading || state.deleting;
    updateActions();
  }

  async function loadPlots(force = false) {
    if (state.loaded && !force) return;
    if (!token()) {
      setMessage('로그인 정보를 찾지 못했어요. 제타에 로그인한 뒤 새로고침해 주세요.', 'zbd-error');
      return;
    }
    state.loading = true;
    state.result = null;
    setMessage('');
    render();
    try {
      state.plots = await listAllPlots();
      state.loaded = true;
    } catch (error) {
      setMessage(error.message || '플롯을 불러오지 못했습니다.', 'zbd-error');
    } finally {
      state.loading = false;
      render();
    }
  }

  function enterDeleteMode() {
    mode.classList.add('zbd-open');
    document.documentElement.style.overflow = 'hidden';
    loadPlots();
  }

  function closeDeleteMode() {
    if (state.deleting) return;
    mode.classList.remove('zbd-open');
    document.documentElement.style.overflow = '';
    if (state.result?.deleted) location.reload();
  }

  function askDeleteConfirmation() {
    if (!state.selected.size || state.deleting) return;
    const wrap = document.createElement('div');
    wrap.className = 'zbd-confirm-wrap';
    wrap.innerHTML = `<div class="zbd-confirm" role="alertdialog"><h3>선택한 플롯을 삭제할까요?</h3><p><strong>${state.selected.size.toLocaleString()}개 플롯</strong>이 삭제되며 복구할 수 없습니다.</p><div class="zbd-confirm-actions"><button class="zbd-secondary" data-action="cancel">취소</button><button class="zbd-danger" data-action="confirm">삭제</button></div></div>`;
    wrap.addEventListener('click', (event) => {
      const action = event.target?.dataset?.action;
      if (action === 'cancel') wrap.remove();
      if (action === 'confirm') { wrap.remove(); deleteSelected(); }
    });
    page.appendChild(wrap);
  }

  async function deleteSelected() {
    const targets = state.plots.filter((plot) => state.selected.has(plot.id));
    if (!targets.length) return;
    state.deleting = true;
    setMessage(`0 / ${targets.length.toLocaleString()}개 삭제 중…`);
    progress.hidden = false;
    progressBar.style.width = '0%';
    render();
    const results = [];
    let completed = 0;
    let index = 0;
    async function worker() {
      while (index < targets.length) {
        const result = await deletePlot(targets[index++]);
        results.push(result);
        completed += 1;
        progressBar.style.width = Math.round(completed / targets.length * 100) + '%';
        setMessage(`${completed.toLocaleString()} / ${targets.length.toLocaleString()}개 삭제 중…`);
      }
    }
    await Promise.all([worker(), worker()]);
    const successIds = new Set(results.filter((result) => result.ok).map((result) => result.id));
    const failures = results.filter((result) => !result.ok);
    state.plots = state.plots.filter((plot) => !successIds.has(plot.id));
    successIds.forEach((id) => state.selected.delete(id));
    state.deleting = false;
    state.result = { deleted: successIds.size, failures };
    progress.hidden = true;
    if (failures.length) {
      const first = failures[0]?.message ? ` 첫 오류: ${failures[0].message}` : '';
      setMessage(`${successIds.size.toLocaleString()}개 삭제 완료, ${failures.length.toLocaleString()}개 실패.${first}`, 'zbd-error');
    } else {
      setMessage(`${successIds.size.toLocaleString()}개를 삭제했어요. 취소를 누르면 목록을 새로고침합니다.`, 'zbd-success');
    }
    render();
  }

  function injectDeleteButton() {
    const header = document.querySelector(HEADER_SELECTOR);
    if (!header || header.querySelector('.zbd-entry-button')) return;
    header.style.flexDirection = 'row';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zbd-entry-button';
    button.textContent = '삭제';
    button.addEventListener('click', enterDeleteMode);
    header.appendChild(button);
  }

  $('.zbd-cancel').addEventListener('click', closeDeleteMode);
  $('.zbd-reload').addEventListener('click', () => loadPlots(true));
  search.addEventListener('input', () => { state.search = search.value; render(); });
  filter.addEventListener('change', () => { state.visibility = filter.value; render(); });
  $('.zbd-select-visible').addEventListener('click', () => {
    visiblePlots().forEach((plot) => state.selected.add(plot.id));
    render();
  });
  $('.zbd-clear').addEventListener('click', () => { state.selected.clear(); render(); });
  deleteButton.addEventListener('click', askDeleteConfirmation);
  mode.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDeleteMode(); });

  injectDeleteButton();
  new MutationObserver(injectDeleteButton).observe(document.body, { childList: true, subtree: true });
})();
