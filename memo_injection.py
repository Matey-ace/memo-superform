# -*- coding: utf-8 -*-
"""Browser injections used by the Maimemo reverse proxy."""

INTERCEPTOR_JS = (
    '<script>(function(){'
    + "var TC='https://tc-apis.maimemo.com',API='https://api.maimemo.com',WWW='https://www.maimemo.com',ACC='https://accounts.maimemo.com';"
    + "function rw(u){if(typeof u!=='string')return u;return u.replace(TC,'/memo-tc').replace(API,'/memo-api').replace(WWW,'/memo-www').replace(ACC,'/memo-accounts');}"
    + "var of=window.fetch;window.fetch=function(i,n){if(typeof i==='string'){i=rw(i);}else if(i&&i.url){i=new Request(rw(i.url),i);}return of.call(this,i,n);};"
    + "var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);a[1]=rw(u);return oo.apply(this,a)};"
    + "var origOpen=window.open;window.open=function(u){if(typeof u==='string')u=rw(u);return origOpen.call(this,u);};"
    + "try{var loc=window.location;var origHref=Object.getOwnPropertyDescriptor(Location.prototype,'href');if(origHref&&origHref.set){var origSet=origHref.set;Object.defineProperty(Location.prototype,'href',{set:function(v){return origSet.call(this,rw(v));},get:origHref.get,configurable:true});}}catch(e){};"
    + "try{var origReplace=Location.prototype.replace;Location.prototype.replace=function(u){return origReplace.call(this,rw(u));};var origAssign=Location.prototype.assign;Location.prototype.assign=function(u){return origAssign.call(this,rw(u));};}catch(e){};"
    + '})();</script>'
)

# Dark theme injection for the embedded maimemo webstudy SPA.
# The dashboard stores its theme in localStorage('theme') and the iframe is
# same-origin, so we read that and toggle html.memo-dark, then override the
# SPA's own CSS variables (which natively support dark mode) plus a few
# hard-coded colors so the study UI follows the dashboard's dark theme.
MEMO_DARK_CSS = (
    '<style id="memo-dark-theme">'
    'html.memo-dark,html.memo-dark body{--text-color-primary:#DBDBDB;--text-color-secondary:#A1A1A1;'
    '--text-color-title:#FFF;--bg-color-primary:#222324;--bg-color-secondary:#1D1E1E;--bg-color-review:#18191A;'
    '--bg-color-group-line:#101010;--divider-color:#303030;--border-color:#303030;--popup-background-color:#1D1E1E;'
    '--white:#222324;background-color:#222324;color:#DBDBDB}'
    'html.memo-dark .taro-navigation-bar,html.memo-dark .taro-navigation-bar-no-icon{background-color:#1D1E1E!important}'
    'html.memo-dark .rev-top{background:linear-gradient(180deg,rgb(20 45 60/100%) 0%,rgb(24 58 68/100%) 51%,rgb(30 70 75/100%) 100%)!important}'
    'html.memo-dark .rev-content-header{color:#8A94A6!important;border-bottom-color:#303030!important}'
    'html.memo-dark .spelling-hint,html.memo-dark .phrase-play-btn{color:#A1A1A1!important}'
    'html.memo-dark .phrase-play-btn{border-color:#A1A1A1!important}'
    'html.memo-dark .phrase-hl{color:#4FD6BC!important}'
    'html.memo-dark .verify-input{color:#DBDBDB!important;caret-color:#DBDBDB!important}'
    'html.memo-dark .taro-modal__mask{background-color:rgba(0,0,0,.75)!important}'
    'html.memo-dark .taro-modal__content,html.memo-dark .taro-modal__inner,html.memo-dark .taro-model__bd{background-color:#1D1E1E!important;color:#DBDBDB!important}'
    '</style>'
)

MEMO_DARK_JS = (
    '<script>(function(){'
    'function parentNotebook(){try{return window.parent!==window&&window.parent.document.body.classList.contains("notebook-mode")}catch(e){return false}}'
    'function applyMemoTheme(){var dark=false;try{dark=!parentNotebook()&&localStorage.getItem("theme")==="dark"}catch(e){}'
    'document.documentElement.classList.toggle("memo-dark",!!dark)}'
    'applyMemoTheme();'
    'window.addEventListener("storage",function(e){if(e.key==="theme"||e.key===null)applyMemoTheme()});'
    'try{if(window.parent!==window){new MutationObserver(applyMemoTheme).observe(window.parent.document.body,{attributes:true,attributeFilter:["class","data-ui-style"]})}}catch(e){}'
    'setInterval(applyMemoTheme,800);'
    '})();</script>'
)

# Load exactly one iframe theme.  The standard branch never requests notebook
 # fonts or paper assets; the Anon的笔记本 branch never requests the standard skin.
MEMO_STUDY_THEME = (
    '<script>(function(){'
    'var VERSION="20260825-unified-ui";'
    'function parentStyle(){try{return window.parent!==window&&window.parent.document.body.classList.contains("notebook-mode")?"notebook":"standard"}catch(e){return "standard"}}'
    'function addCss(id,href){var link=document.getElementById(id);if(link&&link.getAttribute("href")===href)return;'
    'if(link)link.remove();link=document.createElement("link");link.id=id;link.rel="stylesheet";link.href=href;document.head.appendChild(link)}'
    'function syncMemoStudyTheme(){var mode=parentStyle(),root=document.documentElement;'
    'root.classList.toggle("memo-notebook",mode==="notebook");root.classList.toggle("memo-standard",mode==="standard");'
    'var skin=mode==="notebook"?"/css/maimemo-notebook.css?v="+VERSION:"/css/maimemo-standard.css?v="+VERSION;'
    'addCss("memo-study-skin",skin);var fonts=document.getElementById("memo-notebook-fonts");'
    'if(mode==="notebook"){addCss("memo-notebook-fonts","/css/fonts.css?v="+VERSION)}else if(fonts){fonts.remove()}}'
    'syncMemoStudyTheme();'
    'try{if(window.parent!==window){new MutationObserver(syncMemoStudyTheme).observe(window.parent.document.body,{attributes:true,attributeFilter:["class","data-ui-style"]})}}catch(e){}'
    'window.addEventListener("pageshow",syncMemoStudyTheme);'
    '})();</script>'
)

# Taro occasionally leaves the navigation bar in its root/no-icon state when
# opening nested SPA settings.  Keep the native visual fallback for pages that
# actually own a back handler, but give the TTS page a Memo-controlled exit:
# try the native Taro stack first, then ask the embedding parent to reload the
# Maimemo home route if the TTS page is still visible.
MEMO_NAV_GUARD_JS = (
    '<script>(function(){'
    'var EXIT_ID="memo-tts-exit",busy=false,fallbackTimer=0,resetTimer=0;'
    'function activeTaroPage(){var pages=[].slice.call(document.querySelectorAll(".taro_page.taro_page_show"));'
    'var visible=pages.filter(function(page){if(page.classList.contains("taro_page_shade"))return false;'
    'var style=getComputedStyle(page);return style.display!=="none"&&style.visibility!=="hidden"});'
    'return visible.length?visible[visible.length-1]:null}'
    'function isTtsPage(){var page=activeTaroPage();return!!(page&&page.querySelector(".tts-settings"))}'
    'function requestParentHome(){if(!isTtsPage())return;'
    'if(window.parent!==window){window.parent.postMessage({type:"memo-study-navigation",action:"home-fallback"},location.origin)}'
    'else{location.replace("/memo-tc/webstudy/app?memo_home=1")}}'
    'function runExit(){if(busy||!isTtsPage())return;busy=true;var button=document.getElementById(EXIT_ID);'
    'if(button){button.disabled=true;button.setAttribute("aria-busy","true")}clearTimeout(fallbackTimer);clearTimeout(resetTimer);'
    'var pages=[].slice.call(document.querySelectorAll(".taro_page.taro_page_show")).filter(function(page){return!page.classList.contains("taro_page_shade")});'
    'var nativeBack=document.querySelector("#taro-navigation-bar > .taro-navigation-bar-back");'
    'if(pages.length>1&&nativeBack){try{nativeBack.click()}catch(e){}}'
    'else if(pages.length>1&&window.Taro&&typeof window.Taro.navigateBack==="function"){try{window.Taro.navigateBack({delta:1})}catch(e){}}'
    'fallbackTimer=setTimeout(function(){if(isTtsPage())requestParentHome()},400);'
    'resetTimer=setTimeout(function(){if(isTtsPage()){busy=false;var current=document.getElementById(EXIT_ID);'
    'if(current){current.disabled=false;current.removeAttribute("aria-busy")}}},2500)}'
    'function createExit(){var button=document.createElement("button");button.id=EXIT_ID;button.type="button";'
    'button.setAttribute("aria-label","退出例句发音设置并返回");button.innerHTML="<span aria-hidden=true>&#8592;</span><span>返回</span>";'
    'button.addEventListener("click",runExit);return button}'
    'function syncMemoNavigation(){var nav=document.getElementById("taro-navigation-bar"),page=activeTaroPage();'
    'var tts=!!(page&&page.querySelector(".tts-settings"));'
    'var nativeNested=!!(page&&page.querySelector(".shortcut-settings,.word-search,.gp"));'
    'if(nav)nav.classList.toggle("memo-navigation-back-fallback",nativeNested);'
    'var button=document.getElementById(EXIT_ID);if(tts){if(!button&&document.body){button=createExit();document.body.appendChild(button)}}'
    'else{busy=false;clearTimeout(fallbackTimer);clearTimeout(resetTimer);if(button)button.remove()}}'
    'document.addEventListener("keydown",function(event){if(event.key!=="Escape"||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;'
    'if(!isTtsPage())return;event.preventDefault();event.stopPropagation();runExit()},true);'
    'var observer=new MutationObserver(syncMemoNavigation);'
    'observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["class","style"]});'
    'window.addEventListener("pageshow",syncMemoNavigation);setInterval(syncMemoNavigation,500);syncMemoNavigation();'
    '})();</script>'
)

# 墨墨网页版自带快捷键系统（localStorage: shortcut_settings）。
# 给 START_SPELLING（开始拼写，聚焦输入框）绑定空格键，并把“显示答案”让位到 S 键，
# 这样背单词时按一下空格即可直接开始输入，无需再用鼠标点击输入框。
MEMO_STUDY_KEYS_JS = (
    '<script>(function(){'
    'if(location.pathname.indexOf("/webstudy/app")<0)return;'
    'try{'
    'var KEY="shortcut_settings";'
    'var cur=null;'
    'try{cur=JSON.parse(localStorage.getItem(KEY)||"null");}catch(e){}'
    'var base=(cur&&cur.version===1&&cur.shortcuts)?cur.shortcuts:{};'
    'var show=base.SHOW_ANSWER;'
    'var patch={START_SPELLING:{action:"START_SPELLING",key:"Space",modifiers:[],enabled:true}};'
    'if(!show||show.key===""||show.key==="Space"){'
    'patch.SHOW_ANSWER={action:"SHOW_ANSWER",key:"s",modifiers:[],enabled:true};'
    '}'
    'var merged={};'
    'for(var k in base){merged[k]=base[k];}'
    'for(var k2 in patch){merged[k2]=patch[k2];}'
    'localStorage.setItem(KEY,JSON.stringify({version:1,shortcuts:merged}));'
    '}catch(e){}'
    '})();</script>'
)
