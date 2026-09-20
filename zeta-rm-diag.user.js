// ==UserScript==
// @name         Zeta RM 진단 스크립트
// @namespace    zeta-room-manager-diag
// @version      1.0.0
// @description  Zeta Room Manager 통합 진단 스크립트 — 방 데이터, API, 검색 커버리지, 플롯 조회 탐색.
// @match        https://zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;

  const capturedRooms = [];

  function scanPlotKeys(value, path = [], depth = 0, seen = new WeakSet(), out = []) {
    if (value == null || depth > 7 || out.length >= 120) return out;
    if (typeof value !== 'object') return out;
    if (seen.has(value)) return out;
    seen.add(value);

    if (Array.isArray(value)) {
      value.slice(0, 80).forEach((v, i) => scanPlotKeys(v, path.concat(i), depth + 1, seen, out));
      return out;
    }

    for (const [key, child] of Object.entries(value)) {
      const next = path.concat(key);
      if (/plot|origin|scenario|character|creator|author/i.test(key)) {
        let preview = child;
        if (child && typeof child === 'object') {
          try { preview = JSON.stringify(child).slice(0, 500); }
          catch (_) { preview = '[object]'; }
        }
        out.push(next.join('.') + ' = ' + String(preview).slice(0, 500));
        if (out.length >= 120) break;
      }
      if (child && typeof child === 'object') scanPlotKeys(child, next, depth + 1, seen, out);
      if (out.length >= 120) break;
    }
    return out;
  }

  function inspectRoomsPayload(payload, url) {
    const roots = [];
    if (Array.isArray(payload)) roots.push(...payload);
    if (payload && typeof payload === 'object') {
      for (const key of ['rooms', 'items', 'data', 'results', 'content']) {
        const v = payload[key];
        if (Array.isArray(v)) roots.push(...v);
        else if (v && typeof v === 'object') {
          for (const sub of ['rooms', 'items', 'results', 'content']) {
            if (Array.isArray(v[sub])) roots.push(...v[sub]);
          }
        }
      }
    }

    const room = roots.find(v => v && typeof v === 'object') || payload;
    capturedRooms.unshift({
      at: new Date().toISOString(),
      url: String(url || ''),
      sample: room,
      keys: scanPlotKeys(room)
    });
    if (capturedRooms.length > 5) capturedRooms.length = 5;
  }

  function isRoomsUrl(url) {
    return /\/v2\/rooms(?:[/?#]|$)/i.test(String(url || ''));
  }

  function installRoomsInterceptor() {
    if (window.__zrmDiagRoomsInterceptor) return;
    window.__zrmDiagRoomsInterceptor = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = async function () {
        const response = await originalFetch.apply(this, arguments);
        try {
          const req = arguments[0];
          const url = typeof req === 'string' ? req : req && req.url;
          if (isRoomsUrl(url)) {
            response.clone().json().then(data => inspectRoomsPayload(data, url)).catch(() => {});
          }
        } catch (_) {}
        return response;
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const urls = new WeakMap();

    XMLHttpRequest.prototype.open = function (method, url) {
      try { urls.set(this, String(url || '')); } catch (_) {}
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const url = urls.get(xhr) || '';
      if (isRoomsUrl(url)) {
        xhr.addEventListener('load', () => {
          try {
            const data = xhr.responseType === 'json'
              ? xhr.response
              : JSON.parse(xhr.responseText || 'null');
            inspectRoomsPayload(data, url);
          } catch (_) {}
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  }

  installRoomsInterceptor();

  function collect() {
    const out = [];
    const L = s => out.push(String(s));

    const items = new Set(document.querySelectorAll('[data-sentry-component="SwipeableRoomListItem"]'));
    document.querySelectorAll('a[href*="/rooms/"]').forEach(a => {
      const it = a.closest('[data-sentry-component="SwipeableRoomListItem"], li, [role="listitem"]')
        || a.parentElement?.parentElement;
      if (it) items.add(it);
    });
    const arr = [...items];

    L('URL: ' + location.pathname);
    L('=== 화면의 방 아이템: ' + arr.length + '개 ===');

    L('');
    L('=== /v2/rooms 응답 캡처 ===');
    if (!capturedRooms.length) {
      L('아직 캡처 없음 — 진단 스크립트를 켠 상태로 /ko/rooms를 새로고침하세요.');
    } else {
      const cap = capturedRooms[0];
      L('URL: ' + cap.url);
      L('캡처 시각: ' + cap.at);
      L('--- plot/character/creator 관련 키 ---');
      if (cap.keys.length) cap.keys.forEach(x => L(x));
      else L('(관련 키 없음)');
      L('--- 방 객체 샘플 (최대 5000자) ---');
      try { L(JSON.stringify(cap.sample, null, 2).slice(0, 5000)); }
      catch (_) { L(String(cap.sample).slice(0, 5000)); }
    }

    try {
      const st = JSON.parse(localStorage.getItem('zeta-room-manager:v1') || '{}');
      const idx = Object.values(st.index || {}).filter(e => e && e.type === 'room');
      let wc = 0, wr = 0;
      idx.forEach(e => {
        if ((e.characterNames || []).length) wc++;
        if ((e.creatorNames || []).length) wr++;
      });
      L('저장된 인덱스: ' + idx.length + '개 / 캐릭터명 있음: ' + wc + ' / 제작자명 있음: ' + wr);
      idx.slice(0, 5).forEach(e => L('  · ' + (e.alias || e.original)
        + ' | char=[' + (e.characterNames || []).join(', ') + ']'
        + ' | creator=[' + (e.creatorNames || []).join(', ') + ']'));
    } catch (err) {
      L('state 읽기 실패: ' + err);
    }

    const it = arr[0];
    if (!it) {
      L('');
      L('!! 방 아이템 없음 — 방 목록 화면(/ko/rooms)에서 눌러주세요');
      return out.join('\n');
    }

    L('');
    L('=== 첫 방 아이템 HTML (1200자) ===');
    L(it.outerHTML.slice(0, 1200));

    L('');
    L('=== dataset / alt / aria-label ===');
    [it, ...it.querySelectorAll('*')].slice(0, 60).forEach((el, i) => {
      const d = el.dataset || {};
      const ks = Object.keys(d);
      if (ks.length) L('[' + i + '] ' + el.tagName.toLowerCase() + ': ' + ks.map(k => k + '=' + d[k]).join(' | '));
      const al = el.getAttribute?.('alt');
      if (al) L('[' + i + '] alt=' + al);
      const ar = el.getAttribute?.('aria-label');
      if (ar) L('[' + i + '] aria-label=' + ar);
    });

    L('');
    L('=== React props 문자열 (최대 150줄) ===');
    const fk = Object.keys(it).find(k => k.startsWith('__reactFiber'));
    let f = fk ? it[fk] : null;
    if (!f) {
      L('!! __reactFiber 키 없음');
      return out.join('\n');
    }

    const seen = new WeakSet();
    let n = 0;
    const walk = (v, p, d) => {
      if (n >= 150 || v == null || d > 10) return;
      if (typeof v === 'string') {
        if (v.length > 0 && v.length < 160) { L(p.join('.') + ' = ' + JSON.stringify(v)); n++; }
        return;
      }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) {
        v.slice(0, 20).forEach((x, i) => walk(x, p.concat(i), d + 1));
        return;
      }
      for (const [k, x] of Object.entries(v)) {
        if (['children', 'ref', '_owner', 'return', 'stateNode', 'memoizedState', '_store', '_debugOwner'].includes(k)) continue;
        walk(x, p.concat(k), d + 1);
        if (n >= 150) break;
      }
    };
    for (let d = 0; f && d < 15; d++, f = f.return) {
      const nm = f.type?.name || f.elementType?.name || (typeof f.type === 'string' ? f.type : '?');
      L('--- depth ' + d + ' (' + nm + ') ---');
      walk(f.memoizedProps, ['d' + d], 0);
      if (n >= 150) break;
    }
    L('총 ' + n + '줄');

    return out.join('\n');
  }

  function show() {
    const text = collect();
    document.getElementById('zrm-diag-overlay')?.remove();

    const o = document.createElement('div');
    o.id = 'zrm-diag-overlay';
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#111;color:#eee;'
      + 'font:12px/1.5 ui-monospace,monospace;padding:12px;overflow:auto;'
      + 'white-space:pre-wrap;word-break:break-all;-webkit-overflow-scrolling:touch';

    const bar = document.createElement('div');
    bar.style.cssText = 'position:sticky;top:0;background:#111;padding:8px 0;display:flex;gap:8px;'
      + 'padding-top:calc(8px + env(safe-area-inset-top,0px))';

    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:10px 18px;background:#6d52ff;color:#fff;border:0;border-radius:8px;font:inherit;font-size:14px';
      b.addEventListener('click', fn);
      return b;
    };

    const copy = () => {
      const done = () => alert('복사됐어요!');
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else fallback();
      function fallback() {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        try { document.execCommand('copy'); done(); }
        catch (_) { alert('자동 복사 실패 — 아래 텍스트를 길게 눌러 직접 복사하세요'); }
        ta.remove();
      }
    };

    bar.append(mk('복사', copy), mk('닫기', () => o.remove()));

    const pre = document.createElement('div');
    pre.textContent = text;
    pre.style.userSelect = 'text';
    pre.style.webkitUserSelect = 'text';

    o.append(bar, pre);
    document.body.appendChild(o);
  }

  function addButton() {
    if (document.getElementById('zrm-diag-btn')) return;
    const b = document.createElement('button');
    b.id = 'zrm-diag-btn';
    b.textContent = '진단';
    b.style.cssText = 'position:fixed;right:14px;bottom:88px;z-index:2147483646;'
      + 'padding:12px 16px;background:#ff5c5c;color:#fff;border:0;border-radius:24px;'
      + 'font:700 14px/1 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4)';
    b.addEventListener('click', show);
    document.body.appendChild(b);
  }

  addButton();
  setInterval(addButton, 1500);
})();


/* ===== API 탐색 ===== */
(() => {
  'use strict';
  if (window.top !== window.self) return;
  const log = [], MAX = 60;
  function note(method, url, bodyText) {
    if (log.length >= MAX) return;
    let hit = '', keys = '';
    if (bodyText) {
      try { keys = summarizeKeys(JSON.parse(bodyText), 0).slice(0, 40).join(', '); } catch (_) { keys = '(JSON 아님)'; }
      const found = new Set();
      const re = /"([a-zA-Z_]*(?:creator|character|author|nickname)[a-zA-Z_]*)"\s*:\s*("(?:[^"\\]|\\.){0,60}")/gi;
      let m; while ((m = re.exec(bodyText)) && found.size < 12) found.add(m[1] + '=' + m[2]);
      if (found.size) hit = [...found].join(' | ');
    }
    log.push({ method, url, keys, hit });
  }
  function summarizeKeys(v, depth, prefix = '') {
    if (depth > 3 || v == null || typeof v !== 'object') return [];
    if (Array.isArray(v)) return v.length ? summarizeKeys(v[0], depth + 1, prefix + '[].') : [];
    const out = [];
    for (const k of Object.keys(v).slice(0, 25)) {
      out.push(prefix + k);
      const child = v[k];
      if (child && typeof child === 'object') out.push(...summarizeKeys(child, depth + 1, prefix + k + '.'));
      if (out.length > 60) break;
    }
    return out;
  }
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const method = args[1]?.method || 'GET';
    return origFetch.apply(this, args).then(res => {
      try {
        if (/zeta-ai\.io|api/i.test(url) && !/image\.|_next\/static|\.js$|\.css$|sentry/i.test(url))
          res.clone().text().then(t => note('fetch ' + method, url, t.slice(0, 200000))).catch(() => {});
      } catch (_) {}
      return res;
    });
  };
  const origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__zrmMethod = m; this.__zrmUrl = u; return origOpen.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        const u = this.__zrmUrl || '';
        if (/zeta-ai\.io|api/i.test(u) && !/image\.|_next\/static|\.js$|\.css$|sentry/i.test(u))
          note('xhr ' + (this.__zrmMethod || ''), u, String(this.responseText || '').slice(0, 200000));
      } catch (_) {}
    });
    return origSend.apply(this, a);
  };
  function buildReport() {
    const out = [], L = s => out.push(String(s));
    L('=== 가로챈 요청: ' + log.length + '개 ==='); L('');
    log.forEach((e, i) => { L('[' + i + '] ' + e.method + ' ' + e.url); if (e.hit) L('   ★ 제작자/캐릭터 후보: ' + e.hit); if (e.keys) L('   keys: ' + e.keys); L(''); });
    L('=== __NEXT_DATA__ ===');
    try { const nd = window.__NEXT_DATA__; L(nd ? JSON.stringify(nd).slice(0, 800) : '없음'); } catch (_) { L('읽기 실패'); }
    return out.join('\n');
  }
  function show() {
    const report = buildReport(); document.getElementById('zrm-diag2-overlay')?.remove();
    const o=document.createElement('div'); o.id='zrm-diag2-overlay'; o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#111;color:#eee;font:12px/1.5 ui-monospace,monospace;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all';
    const bar=document.createElement('div'); bar.style.cssText='position:sticky;top:0;background:#111;padding:8px 0;display:flex;gap:8px;padding-top:calc(8px + env(safe-area-inset-top,0px))';
    const mk=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.style.cssText='padding:10px 18px;background:#6d52ff;color:#fff;border:0;border-radius:8px;font:inherit;font-size:14px';b.addEventListener('click',fn);return b;};
    const copy=()=>navigator.clipboard?.writeText(report).then(()=>alert('복사됐어요!')).catch(()=>{});
    bar.append(mk('복사',copy),mk('닫기',()=>o.remove())); const pre=document.createElement('div');pre.textContent=report;pre.style.userSelect='text';o.append(bar,pre);document.body.appendChild(o);
  }
  function addButton(){if(!document.body||document.getElementById('zrm-diag2-btn'))return;const b=document.createElement('button');b.id='zrm-diag2-btn';b.textContent='API';b.style.cssText='position:fixed;right:14px;bottom:150px;z-index:2147483646;padding:12px 16px;background:#2ea44f;color:#fff;border:0;border-radius:24px;font:700 14px/1 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4)';b.addEventListener('click',show);document.body.appendChild(b);}
  setInterval(addButton,1000);
})();

/* ===== 검색 커버리지 ===== */
(() => {
'use strict'; if (window.top !== window.self) return;
const KEY='zeta-room-manager:v1';
const load=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch(_){return{}}};
const norm=v=>String(v||'').replace(/\s+/g,' ').trim();
const rooms=st=>Object.values(st.index||{}).filter(e=>e&&e.type==='room');
const metaOf=(st,e)=>(st.plotMeta&&e&&e.plotId)?st.plotMeta[e.plotId]:null;
const allNames=(st,e)=>{const m=metaOf(st,e);return [].concat(e.characterNames||[],e.creatorNames||[],m?.characterNames||[],m?.creatorNames||[],m?.name?[m.name]:[]).map(norm).filter(Boolean)};
function overview(){const st=load(),rs=rooms(st),out=[],L=s=>out.push(String(s));L('=== 개요 ===');L('인덱싱된 방: '+rs.length);let hc=0,hr=0,hp=0,ho=0;rs.forEach(e=>{const m=metaOf(st,e);if((e.characterNames||[]).length||(m?.characterNames||[]).length)hc++;if((e.creatorNames||[]).length||(m?.creatorNames||[]).length)hr++;if(e.plotId)hp++;if(e.originatedId)ho++});L('plotId 있음: '+hp+' / originatedId 있음: '+ho);L('캐릭터명 확보: '+hc+' / 제작자명 확보: '+hr);const pm=Object.values(st.plotMeta||{}),failed=pm.filter(p=>p&&p.failedAt);L('플롯 캐시: '+pm.length+'개 / 조회 실패 기록: '+failed.length+'개');L('');L('=== 데이터 없는 방 (최대 15개) ===');const missing=rs.filter(e=>{const m=metaOf(st,e);return !((e.creatorNames||[]).length||(m?.creatorNames||[]).length)});L('제작자명 없는 방: '+missing.length+'개');missing.slice(0,15).forEach(e=>{const m=metaOf(st,e);L('· '+(e.alias||e.original));L('   plotId='+(e.plotId||'없음')+' originatedId='+(e.originatedId||'없음'));L('   캐시='+(m?('char'+((m.characterNames||[]).length)+'/cre'+((m.creatorNames||[]).length)):'없음'))});return out.join('\n')}
function explain(query){const st=load(),q=norm(query).toLocaleLowerCase('ko-KR'),out=[],L=s=>out.push(String(s));L('=== 검색어: "'+query+'" ===');if(!q){L('(비어있음)');return out.join('\n')}const hits=[];rooms(st).forEach(e=>{const fields=[];if(norm(e.alias).toLocaleLowerCase('ko-KR').includes(q))fields.push('별명');if(norm(e.original).toLocaleLowerCase('ko-KR').includes(q))fields.push('방제목');const m=metaOf(st,e);if(m&&norm(m.name).toLocaleLowerCase('ko-KR').includes(q))fields.push('플롯명');[].concat(e.characterNames||[],m?.characterNames||[]).forEach(n=>{if(norm(n).toLocaleLowerCase('ko-KR').includes(q))fields.push('캐릭터:'+n)});[].concat(e.creatorNames||[],m?.creatorNames||[]).forEach(n=>{if(norm(n).toLocaleLowerCase('ko-KR').includes(q))fields.push('제작자:'+n)});if(fields.length)hits.push({e,fields:[...new Set(fields)]})});L('걸린 방: '+hits.length+'개');hits.slice(0,20).forEach(h=>L('· '+(h.e.alias||h.e.original)+'  ['+h.fields.join(', ')+']'));return out.join('\n')}
function panel(text){document.getElementById('zrm-diag3-overlay')?.remove();const o=document.createElement('div');o.id='zrm-diag3-overlay';o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#111;color:#eee;font:12px/1.5 ui-monospace,monospace;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all';const bar=document.createElement('div');bar.style.cssText='position:sticky;top:0;background:#111;padding:8px 0;display:flex;gap:8px;flex-wrap:wrap';const input=document.createElement('input');input.placeholder='캐릭터/제작자명 입력';input.style.cssText='flex:1;min-width:120px;padding:9px 12px;background:#222;color:#eee';const body=document.createElement('div');body.textContent=text;body.style.userSelect='text';const mk=(l,f)=>{const b=document.createElement('button');b.textContent=l;b.onclick=f;return b};const run=()=>body.textContent=explain(input.value);input.addEventListener('keydown',e=>{if(e.key==='Enter')run()});bar.append(input,mk('검색',run),mk('개요',()=>body.textContent=overview()),mk('복사',()=>navigator.clipboard?.writeText(body.textContent)),mk('닫기',()=>o.remove()));o.append(bar,body);document.body.appendChild(o)}
function addButton(){if(!document.body||document.getElementById('zrm-diag3-btn'))return;const b=document.createElement('button');b.id='zrm-diag3-btn';b.textContent='검색진단';b.style.cssText='position:fixed;right:14px;bottom:214px;z-index:2147483646;padding:12px 14px';b.onclick=()=>panel(overview());document.body.appendChild(b)}setInterval(addButton,1000);
})();

/* ===== 플롯 조회 탐색 ===== */
(() => {
'use strict';if(window.top!==window.self)return;const API='https://api.zeta-ai.io',VER='3.44.7';const norm=v=>String(v||'').replace(/\s+/g,' ').trim();
function cookie(name){try{const w=name+'=';for(const p of String(document.cookie||'').split(';')){const t=p.trim();if(t.startsWith(w))return decodeURIComponent(t.slice(w.length))}}catch(_){}return''}
function tokenFrom(v){let t=norm(v);if(!t)return'';try{const p=JSON.parse(t);if(typeof p==='string')t=p;else if(p&&typeof p==='object')t=norm(p.accessToken||p.access_token||p.token||p.TOKEN)}catch(_){}t=t.replace(/^Bearer\s+/i,'');const m=t.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);return m?m[0]:''}
function token(){const c=tokenFrom(cookie('TOKEN'));if(c)return c;for(const s of [localStorage,sessionStorage])try{for(let i=0;i<s.length;i++){const k=s.key(i)||'';if(!/token|auth|session/i.test(k))continue;const t=tokenFrom(s.getItem(k));if(t)return t}}catch(_){}return''}
function headers(){const t=token(),h={Accept:'application/json','X-Client-Version':VER,'X-Client-Native-Version':VER,'X-Client-Type':'web','X-Device-Type':/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)?'web':'pc_web','X-User-Language':'KOREAN'};if(t)h.Authorization='Bearer '+t;const d=norm(cookie('DEVICE_ID'));if(d)h['X-Sticky']=d;return h}
async function probe(path){try{const res=await fetch(API+path,{headers:headers(),credentials:'include',cache:'no-store'});return res.status+' — '+(await res.text()).slice(0,600)}catch(e){return'ERR '+e}}
async function findRoomRaw(plotId){let cursor='';for(let page=0;page<30;page++){const url=API+'/v2/rooms?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):'');let json;try{const res=await fetch(url,{headers:headers(),credentials:'include',cache:'no-store'});if(!res.ok)return'방 목록 조회 실패: '+res.status;json=await res.json()}catch(e){return'방 목록 오류: '+e}for(const r of Array.isArray(json.rooms)?json.rooms:[]){const p=r.plot||{};if(norm(p.id)===plotId||norm(p.originatedId)===plotId)return JSON.stringify(r,null,1).slice(0,2500)}const next=norm(json.nextCursor);if(!next)break;cursor=next}return'(이 plotId를 가진 방을 /v2/rooms 응답에서 못 찾음)'}
async function run(plotId,body){const out=[],L=s=>{out.push(String(s));body.textContent=out.join('\n')};L('plotId: '+plotId);L('토큰: '+(token()?'있음':'없음'));L('');L('=== /v2/rooms 원본 데이터 찾는 중… ===');L(await findRoomRaw(plotId));const paths=['/v1/plots/'+plotId,'/v2/plots/'+plotId,'/v1/plots/'+plotId+'/about','/v1/plots/'+plotId+'/characters','/v1/me/plots?limit=30','/v1/plots/mine?limit=30','/v1/plots/private?limit=30','/v1/plots/created?limit=30'];L('');L('=== 엔드포인트 탐색 ===');for(const p of paths){L('');L('▶ '+p);L(await probe(p))}L('');L('완료')}
function panel(){document.getElementById('zrm-diag4')?.remove();const o=document.createElement('div');o.id='zrm-diag4';o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#111;color:#eee;font:12px/1.5 ui-monospace,monospace;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all';const bar=document.createElement('div');bar.style.cssText='position:sticky;top:0;background:#111;padding:8px 0;display:flex;gap:8px;flex-wrap:wrap';const input=document.createElement('input');input.value='f7fcfbcb-45e6-4a96-b325-3fd366beedf7';input.style.cssText='flex:1;min-width:140px;padding:9px 12px;background:#222;color:#eee';const body=document.createElement('div');body.textContent='플롯 ID 확인하고 [실행]을 누르세요.';body.style.userSelect='text';const mk=(l,f)=>{const b=document.createElement('button');b.textContent=l;b.onclick=f;return b};bar.append(input,mk('실행',()=>run(norm(input.value),body)),mk('복사',()=>navigator.clipboard?.writeText(body.textContent)),mk('닫기',()=>o.remove()));o.append(bar,body);document.body.appendChild(o)}
function addButton(){if(!document.body||document.getElementById('zrm-diag4-btn'))return;const b=document.createElement('button');b.id='zrm-diag4-btn';b.textContent='플롯탐색';b.style.cssText='position:fixed;right:14px;bottom:278px;z-index:2147483646;padding:12px 14px';b.onclick=panel;document.body.appendChild(b)}setInterval(addButton,1000);
})();
