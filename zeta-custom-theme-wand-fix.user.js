// ==UserScript==
// @name         Zeta 커스텀 테마 요술봉 입력창 색상 유지
// @namespace    zeta-custom-theme-wand-fix
// @version      0.1.0
// @description  요청 재생성 팝업에서 글자를 입력해 안내 문구가 사라져도 커스텀 테마를 유지합니다.
// @match        https://zeta-ai.io/ko/rooms/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(() => {
  'use strict';
  const id = 'zeta-custom-theme-wand-fix';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  // InputMultiPlaceholder는 첫 글자를 쓰면 React가 제거한다. 입력 label/input은 남는다.
  style.textContent = `
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) {
      background: rgba(43,57,66,.42) !important;
      backdrop-filter: blur(7px) !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) > div {
      background: #FFFFFF !important;
      color: #26343C !important;
      border: 1px solid #DDE4E8 !important;
      box-shadow: 0 18px 44px rgba(35,50,59,.22) !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) h5 {
      color: #202124 !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) > div > p {
      color: #66757D !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) label[data-sentry-component="Input"] {
      background: #F5F7F8 !important;
      color: #26343C !important;
      border: 1px solid #DCE3E7 !important;
      box-shadow: none !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) label[data-sentry-component="Input"]:focus-within {
      background: #FFFFFF !important;
      border-color: #D2C24C !important;
      box-shadow: 0 0 0 3px rgba(254,229,0,.18) !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) input[data-sentry-component="Input"] {
      background: transparent !important;
      color: #26343C !important;
      caret-color: #3D474C !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) > div > div:last-child > button:first-child {
      background: #ECEFF1 !important;
      color: #46545E !important;
      border: 1px solid #E0E5E8 !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) > div > div:last-child > button:last-child {
      background: var(--kt-yellow, #FEE500) !important;
      color: #191919 !important;
      border: 1px solid #E2CB00 !important;
    }
    html.kt-chat-theme-active:has(#zeta-custom-theme-style) #portal-container
      [data-sentry-component="Popup"]:has(label[data-sentry-component="Input"] input[data-sentry-component="Input"]) > div > div:last-child > button:last-child:disabled {
      background: #ECEFF1 !important;
      color: #A2AAAE !important;
      border-color: #E1E5E7 !important;
      opacity: 1 !important;
    }
  `;
  (document.head || document.documentElement).append(style);
})();
