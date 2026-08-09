#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Memo Superform - 本地代理服务器
解决墨墨 API 不支持 CORS 的问题，同时提供静态文件服务、AI 代理、
以及基于 SQL Server 的智能复习推荐 API。

使用方法：
  python server.py
  然后在浏览器打开 http://localhost:8888
"""

import http.server
import socketserver
import socket
import ssl
import select
import subprocess
import urllib.request
import urllib.error
import json
import os
import re
import sys
import io
import webbrowser
import threading
import traceback
from urllib.parse import urlparse, parse_qs

# 修复 Windows 控制台编码问题
if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

PORT = 8888
# 打包为 exe 时静态资源在 PyInstaller 的解压目录 _MEIPASS 中
WEB_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def _runtime_root():
    """exe 模式下返回 exe 所在目录；源码模式返回项目根目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


# 可写数据目录：资源包、生成音频、启动模式记忆等一律落在 exe 同级 data/ 下，
# 避免写入 PyInstaller 的临时解压目录。
DATA_DIR = os.path.join(_runtime_root(), "data")
TTS_PACK_DIR = os.path.join(DATA_DIR, "tts_pack")
GENERATED_AUDIO_DIR = os.path.join(DATA_DIR, "generated_audios")
LAUNCHER_CONFIG_PATH = os.path.join(DATA_DIR, "launcher.json")
for _data_dir in (DATA_DIR, TTS_PACK_DIR, GENERATED_AUDIO_DIR):
    try:
        os.makedirs(_data_dir, exist_ok=True)
    except OSError:
        pass

MAIMEMO_BASE = "https://open.maimemo.com/open"
TC_APIS_BASE = "https://tc-apis.maimemo.com"
API_BASE = "https://api.maimemo.com"
WWW_BASE = "https://www.maimemo.com"
ACCOUNTS_BASE = "https://accounts.maimemo.com"

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
    'function applyMemoTheme(){var dark=false;try{dark=localStorage.getItem("theme")==="dark"}catch(e){}'
    'document.documentElement.classList.toggle("memo-dark",!!dark)}'
    'applyMemoTheme();'
    'window.addEventListener("storage",function(e){if(e.key==="theme"||e.key===null)applyMemoTheme()});'
    'setInterval(applyMemoTheme,800);'
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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Do not follow HTTP redirects; return them to the browser instead.

    The OIDC login flow (auth/login -> oidc/auth -> interaction -> callback)
    relies on the browser following each 302/303 step through the proxy so
    that cookies set by accounts.maimemo.com are managed by the browser and
    sent back on every proxied request. urllib's default redirect following
    would drop cookies and flatten the flow."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# ---- 数据库（可选，失败不致命，不影响代理与静态服务） ----
DB_READY = False
try:
    import db
    import recommender
    db.init_db()
    DB_READY = True
    print("[db] SQL Server 已就绪，推荐功能可用")
except Exception as e:
    print("[db] 数据库不可用，推荐功能将禁用:", e)


class MemoProxyHandler(http.server.SimpleHTTPRequestHandler):
    allow_reuse_address = True
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def _rewrite_content(self, body, content_type, proxy_prefix=None):
        """Rewrite maimemo domain URLs in content to proxy paths.

        - HTML/CSS: rewrite domain URLs to relative proxy paths + rewrite
          absolute paths (/xxx) to /proxy-prefix/xxx for pages served via
          cross-domain redirect (e.g. accounts.maimemo.com login page).
        - JS: rewrite config api_host/memo_host to window.location.origin
          + proxy path so new URL() works AND window.location.replace()
          navigates to proxy URL directly (bypasses interceptor limitation).
        """
        if not body:
            return body
        ct = content_type.lower()
        is_js = 'javascript' in ct or 'json' in ct
        is_html = 'text/html' in ct
        is_css = 'text/css' in ct
        if not is_js and not is_html and not is_css:
            return body
        text = body.decode('utf-8', errors='replace') if isinstance(body, bytes) else body

        if is_js:
            # Rewrite config api_host and memo_host to absolute proxy URLs
            # so new URL(config.api_host) works AND _() returns a proxy URL
            # for window.location.replace() ? no need for interceptor to
            # catch the navigation.
            text = text.replace(
                'api_host:"https://tc-apis.maimemo.com"',
                'api_host:window.location.origin+"/memo-tc"'
            )
            text = text.replace(
                'memo_host:"https://api.maimemo.com"',
                'memo_host:window.location.origin+"/memo-api"'
            )
            # Rewrite ws_host to the local proxy so the study WebSocket goes
            # through us instead of connecting directly to tc-apis (which
            # the user's network cannot reach). The +"/memo-tc" prefix makes
            # the browser send the tc-apis session cookie (sid, Path=/memo-tc/study)
            # on the WebSocket handshake; without it the WS gets close code
            # 3401 (Unauthorized) even with a valid login session.
            text = text.replace(
                'ws_host:"wss://tc-apis.maimemo.com"',
                'ws_host:(location.protocol==="https:"?"wss://":"ws://")+location.host+"/memo-tc"'
            )
            # NOTE: login_return_url MUST stay as the original
            # https://tc-apis.maimemo.com/webstudy/app. tc-apis rejects
            # non-maimemo return_url with login_initiation_failed.
        else:
            # HTML/CSS: rewrite domain URLs to relative proxy paths
            text = text.replace('https://tc-apis.maimemo.com', '/memo-tc')
            text = text.replace('https://api.maimemo.com', '/memo-api')
            text = text.replace('https://www.maimemo.com', '/memo-www')
            text = text.replace('https://accounts.maimemo.com', '/memo-accounts')

            # For HTML pages served via cross-domain redirect (e.g. login
            # page at accounts.maimemo.com loaded via /memo-tc/ redirect),
            # rewrite absolute paths to include the proxy prefix.
            if is_html and proxy_prefix and proxy_prefix != '/memo-tc':
                # Rewrite href="/xxx", src="/xxx", action="/xxx" to
                # href="/proxy-prefix/xxx" etc. - but skip paths that
                # already start with /memo- (already proxied).
                text = re.sub(
                    r'((?:href|src|action)\s*=\s*["\'])(/(?!memo-))',
                    r'\1' + proxy_prefix + r'\2',
                    text
                )
                # Rewrite relative URLs in inline JavaScript (e.g. fetch calls)
                # so /interaction/xxx becomes /memo-accounts/interaction/xxx
                for pfx in ['/interaction/', '/oidc/', '/static/']:
                    text = text.replace("'" + pfx + "'", "'" + proxy_prefix + pfx + "'")
                    text = text.replace('"' + pfx + '"', '"' + proxy_prefix + pfx + '"')

        return text.encode('utf-8') if isinstance(body, bytes) else text

    def _web_proxy_request(self, target_url, method="GET", inject_interceptor=False):
        content_length = self._safe_content_length()
        body = self.rfile.read(content_length) if content_length > 0 else None

        req = urllib.request.Request(target_url, data=body, method=method)

        skip_headers = {'host', 'content-length', 'connection', 'accept-encoding',
                        'transfer-encoding', 'upgrade', 'origin', 'referer',
                        'x-frame-options', 'content-security-policy',
                        'strict-transport-security', 'x-content-type-options'}
        for key in self.headers:
            lk = key.lower()
            if lk not in skip_headers:
                val = self.headers[key]
                # Browsers refuse to store __Host-* cookies over plain HTTP,
                # so the proxy renames __Host-x-csrf-token -> x-csrf-token in
                # Set-Cookie. When forwarding the request, rename it back so
                # accounts.maimemo.com finds the cookie it expects.
                if lk == 'cookie':
                    val = re.sub(r'(^|;\s*)x-csrf-token=', r'\1__Host-x-csrf-token=', val)
                req.add_header(key, val)

        if not req.has_header('User-Agent'):
            req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')

        try:
            resp = urllib.request.build_opener(_NoRedirect()).open(req, timeout=30)
            resp_body = resp.read()
            status = resp.status
            resp_headers = resp.headers
        except urllib.error.HTTPError as e:
            resp_body = e.read() if e.fp else b""
            status = e.code
            resp_headers = e.headers
        except Exception as e:
            self.send_response(502)
            self._send_cors_headers()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))
            return

        # Derive proxy prefix from the current request path so relative
        # Location headers (e.g. /interaction/xxx) and absolute HTML paths
        # can be rewritten to the matching proxy prefix.
        proxy_prefix = None
        if self.path.startswith('/memo-tc/') or self.path.startswith('/webstudy/'):
            proxy_prefix = '/memo-tc'
        elif self.path.startswith('/memo-api/'):
            proxy_prefix = '/memo-api'
        elif self.path.startswith('/memo-www/'):
            proxy_prefix = '/memo-www'
        elif self.path.startswith('/memo-accounts/'):
            proxy_prefix = '/memo-accounts'

        content_type = resp_headers.get('Content-Type', '')
        if inject_interceptor and 'text/html' in content_type:
            resp_body = self._rewrite_content(resp_body, content_type, proxy_prefix)
            html = resp_body.decode('utf-8', errors='replace')
            # Cache-bust: append ?v=<timestamp> to script/link src/href to
            # force browsers to load fresh JS/CSS instead of cached old
            # versions that still point to real maimemo domains.
            import time as _time
            _bv = str(int(_time.time()))
            html = re.sub(r'(<script[^>]*src=")([^"]*)(")', lambda m: m.group(1) + m.group(2) + ('&' if '?' in m.group(2) else '?') + 'v=' + _bv + m.group(3), html)
            html = re.sub(r'(<link[^>]*href=")([^"]*)(")', lambda m: m.group(1) + m.group(2) + ('&' if '?' in m.group(2) else '?') + 'v=' + _bv + m.group(3), html)
            if '<head>' in html:
                html = html.replace('<head>', '<head>' + INTERCEPTOR_JS + MEMO_DARK_CSS + MEMO_DARK_JS + MEMO_STUDY_KEYS_JS, 1)
            elif '<head ' in html:
                html = html.replace('<head ', INTERCEPTOR_JS + MEMO_DARK_CSS + MEMO_DARK_JS + MEMO_STUDY_KEYS_JS + '<head ', 1)
            else:
                html = INTERCEPTOR_JS + MEMO_DARK_CSS + MEMO_DARK_JS + MEMO_STUDY_KEYS_JS + html
            resp_body = html.encode('utf-8')
        else:
            resp_body = self._rewrite_content(resp_body, content_type, proxy_prefix)

        self.send_response(status)
        self._send_cors_headers()

        # Force no-cache for HTML/JS so browsers never reuse an older
        # rewritten bundle that would navigate directly to maimemo.com.
        if 'text/html' in content_type or 'javascript' in content_type:
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.send_header('Pragma', 'no-cache')
        if inject_interceptor and 'text/html' in content_type:
            self.send_header('Clear-Site-Data', '"cache"')

        for key, val in resp_headers.items():
            lk = key.lower()
            if lk in ('content-length', 'transfer-encoding', 'connection',
                       'content-encoding', 'keep-alive',
                       'x-frame-options', 'content-security-policy',
                       'strict-transport-security', 'x-content-type-options',
                       'etag', 'last-modified'):
                continue
            if lk == 'set-cookie':
                val = val.replace('Domain=maimemo.com;', '').replace('Domain=maimemo.com', '')
                val = val.replace('domain=maimemo.com;', '').replace('domain=maimemo.com', '')
                # Strip Secure flag so cookies work over HTTP proxy
                val = val.replace('; Secure', '').replace('; secure', '')
                val = val.replace(';Secure', '').replace(';secure', '')
                # __Host- prefix forces Secure + Path=/ ; since we strip Secure,
                # rename the cookie so browsers accept it.
                val = val.replace('__Host-', '')
                # Prefix cookie Path with the proxy prefix so cookies set by
                # e.g. accounts.maimemo.com (Path=/interaction/xxx) are sent
                # to our proxied paths (/memo-accounts/interaction/xxx).
                # Keep root Path=/ untouched (matches only /xxx sub-paths).
                if proxy_prefix:
                    val = re.sub(r'[Pp]ath=/(?=[^/;])', 'path=' + proxy_prefix + '/', val)
                self.send_header('Set-Cookie', val)
            elif lk == 'location':
                _is_cb = 'auth/callback' in self.path
                if _is_cb:
                    try:
                        _dir = os.path.dirname(os.path.abspath(sys.executable)) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
                        with open(os.path.join(_dir, "_cblog.txt"), "a", encoding="utf-8") as _lf:
                            _lf.write("CB path=%s -> Location=%s\n" % (self.path[:100], val[:300]))
                    except Exception:
                        pass
                val = val.replace('https://tc-apis.maimemo.com', '/memo-tc')
                val = val.replace('https://api.maimemo.com', '/memo-api')
                val = val.replace('https://www.maimemo.com', '/memo-www')
                val = val.replace('https://accounts.maimemo.com', '/memo-accounts')
                # Relative Location (e.g. /interaction/xxx) -> prefix it
                if proxy_prefix and val.startswith('/') and not val.startswith('/memo-'):
                    val = proxy_prefix + val
                self.send_header('Location', val)
            else:
                self.send_header(key, val)

        self.send_header('Content-Length', str(len(resp_body)))
        self.end_headers()
        if method != 'HEAD':
            self.wfile.write(resp_body)

    def _ws_proxy(self, path, query):
        """Proxy a WebSocket connection to tc-apis.maimemo.com.

        The web study SPA keeps a WebSocket open to
        wss://tc-apis.maimemo.com/study/ws/webstudy?token=... . The user's
        network cannot reach that host directly, so the browser connects to
        ws://localhost:8888/... instead and we relay the raw bytes.
        """
        target_host = "tc-apis.maimemo.com"
        target_port = 443
        target_path = path + ("?" + query if query else "")
        # The browser now connects to /memo-tc/study/ws/webstudy so the sid
        # session cookie (Path=/memo-tc/study) is sent. Strip the proxy prefix
        # before forwarding upstream, where the path is /study/ws/webstudy.
        if target_path.startswith("/memo-tc/"):
            target_path = target_path[len("/memo-tc"):]

        _WS_DEBUG = os.environ.get("MEMO_WS_DEBUG") == "1"
        def _wlog(msg):
            if not _WS_DEBUG:
                return
            try:
                _dir = os.path.dirname(os.path.abspath(sys.executable)) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
                with open(os.path.join(_dir, "_wslog.txt"), "a", encoding="utf-8") as _f:
                    _f.write(msg + "\n")
            except Exception:
                pass
        import urllib.parse as _up
        _tok = _up.parse_qs(query).get("token", [""])[0] if query else ""
        _wlog("WS req path=%s token_len=%d" % (path, len(_tok)))

        try:
            upstream = socket.create_connection((target_host, target_port), timeout=15)
        except Exception as exc:
            _wlog("WS upstream connect failed: %s" % exc)
            self.send_error(502, "Bad Gateway: %s" % exc)
            return
        try:
            ctx = ssl.create_default_context()
            ssock = ctx.wrap_socket(upstream, server_hostname=target_host)
        except Exception as exc:
            _wlog("WS upstream TLS handshake failed: %s" % exc)
            try:
                upstream.close()
            except Exception:
                pass
            self.send_error(502, "Bad Gateway: %s" % exc)
            return

        # Forward the browser's handshake headers upstream
        lines = ["GET %s HTTP/1.1" % target_path, "Host: %s" % target_host]
        for h in ('Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version',
                  'Sec-WebSocket-Extensions', 'Sec-WebSocket-Protocol', 'Origin',
                  'User-Agent', 'Cookie', 'Authorization'):
            v = self.headers.get(h)
            if v:
                lines.append("%s: %s" % (h, v))
        lines.append("")
        lines.append("")
        try:
            ssock.sendall("\r\n".join(lines).encode("latin1"))
        except Exception as exc:
            _wlog("WS upstream handshake send failed: %s" % exc)
            try:
                ssock.close()
            except Exception:
                pass
            self.send_error(502, "Bad Gateway: %s" % exc)
            return

        # Read upstream handshake response
        resp = b""
        while b"\r\n\r\n" not in resp:
            try:
                chunk = ssock.recv(4096)
            except Exception:
                chunk = b""
            if not chunk:
                break
            resp += chunk
        header_part, _, rest = resp.partition(b"\r\n\r\n")
        status_line = header_part.split(b"\r\n", 1)[0].decode("latin1", errors="replace")
        if "101" not in status_line:
            _wlog("WS upstream non-101: %s" % status_line)
            try:
                if resp:
                    self.connection.sendall(resp)
                else:
                    self.send_error(502, "Bad Gateway: upstream closed during handshake")
            except Exception:
                pass
            ssock.close()
            return
        _wlog("WS handshake OK, relaying")

        # Handshake accepted - send 101 + headers to the browser, then relay
        last_up = b""
        last_down = b""
        try:
            self.connection.sendall(header_part + b"\r\n\r\n")
            if rest:
                self.connection.sendall(rest)
                last_up = rest
            import time as _wtime
            _WS_IDLE_TIMEOUT = 300
            _last_activity = _wtime.monotonic()
            self.connection.settimeout(300)
            ssock.settimeout(300)
            while True:
                r, _, _ = select.select([self.connection, ssock], [], [], 60)
                if not r:
                    # select 超时返回空：两端均无数据。settimeout(300) 只对
                    # recv/send 生效，对 select 无效，因此必须在此主动检查
                    # 累计空闲时间，否则纯空闲连接会永久泄漏线程与两端 socket。
                    if _wtime.monotonic() - _last_activity > _WS_IDLE_TIMEOUT:
                        _wlog("WS idle timeout (%ds), closing both sockets" % _WS_IDLE_TIMEOUT)
                        return
                    continue
                _last_activity = _wtime.monotonic()
                for s in r:
                    try:
                        data = s.recv(65536)
                    except Exception:
                        data = b""
                    if not data:
                        _dir2 = "browser" if s is self.connection else "upstream"
                        _wlog("WS closed (EOF) dir=%s last_up=%s last_down=%s" % (
                            _dir2, last_up[:60].hex(), last_down[:60].hex()))
                        return
                    if s is self.connection:
                        last_down = data
                        try:
                            ssock.sendall(data)
                        except Exception:
                            return
                    else:
                        last_up = data
                        try:
                            self.connection.sendall(data)
                        except Exception:
                            return
        finally:
            try:
                ssock.close()
            except Exception:
                pass

    def _is_allowed_host(self):
        host = (self.headers.get('Host') or '').strip().lower()
        if not host:
            return False
        if host.startswith('['):
            host = host.split(']')[0] + ']'
        elif ':' in host:
            h, _, port = host.rpartition(':')
            if port.isdigit():
                host = h
        return host in ('localhost', '127.0.0.1', '[::1]')

    _FORBIDDEN_STATIC_FILES = {
        'server.py', 'db.py', 'tts.py', 'recommender.py', 'launcher.py', 'app.py',
        'schema.sql', 'release.ps1', 'build_linux.sh', 'launcher-linux.sh',
        'requirements-linux.txt', 'requirements.txt',
        'MemoSuperform.spec', 'MemoSuperform-Web.spec', 'MemoSuperform-Desktop.spec',
        '_backup_pre-rewrite.bundle',
    }

    def _is_forbidden_static_path(self, path):
        """静态服务安全：拒绝点文件(.git/.env)、_ 前缀私有文件、源码/配置与运行数据，
        避免把项目根目录暴露给浏览器。"""
        segs = [s for s in path.split('/') if s]
        if not segs:
            return False
        if any(seg.startswith('.') or seg.startswith('_') for seg in segs):
            return True
        if segs[0] in self._FORBIDDEN_STATIC_FILES:
            return True
        if segs[0] == 'data':
            return True
        return False

    def _send_cors_headers(self):
        origin = (self.headers.get('Origin') or '').strip()
        if origin:
            try:
                o = urlparse(origin)
                host = (o.hostname or '').lower()
                if host in ('localhost', '127.0.0.1', '::1'):
                    self.send_header("Access-Control-Allow-Origin", origin)
                    self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
                    self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept")
            except Exception:
                pass

    def do_OPTIONS(self):
        if not self._is_allowed_host():
            self.send_error(403, "Forbidden")
            return
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if not self._is_allowed_host():
            self.send_error(403, "Forbidden")
            return
        parsed = urlparse(self.path)
        path = parsed.path

        # WebSocket upgrade (study connection) -> relay to tc-apis
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            self._ws_proxy(path, parsed.query)
            return

        # ---- /api/* 业务接口 ----
        if path.startswith("/api/"):
            self._handle_api_get(path, parsed)
            return

        # 代理墨墨 API: /proxy/memo/xxx -> https://open.maimemo.com/open/api/v1/memo/xxx
        if path.startswith("/proxy/memo/"):
            api_path = path[len("/proxy/memo/"):]
            target_url = MAIMEMO_BASE + "/api/v1/memo/" + api_path
            if parsed.query:
                target_url += "?" + parsed.query
            self._proxy_request(target_url, method="GET")
            return

        # 普通静态文件
        # ---- Maimemo web study reverse proxy ----
        if path.startswith("/memo-tc/"):
            sub = path[len("/memo-tc/"):]
            target = TC_APIS_BASE + "/" + sub
            if parsed.query: target += "?" + parsed.query
            inject = sub.startswith("webstudy/app") and "." not in sub.split("/")[-1]
            self._web_proxy_request(target, method="GET", inject_interceptor=inject)
            return

        if path.startswith("/memo-api/"):
            sub = path[len("/memo-api/"):]
            target = API_BASE + "/" + sub
            if parsed.query: target += "?" + parsed.query
            self._web_proxy_request(target, method="GET")
            return

        if path.startswith("/memo-www/"):
            sub = path[len("/memo-www/"):]
            target = WWW_BASE + "/" + sub
            if parsed.query: target += "?" + parsed.query
            self._web_proxy_request(target, method="GET", inject_interceptor=True)
            return

        if path.startswith("/memo-accounts/"):
            sub = path[len("/memo-accounts/"):]
            target = ACCOUNTS_BASE + "/" + sub
            if parsed.query: target += "?" + parsed.query
            try:
                self._web_proxy_request(target, method="GET", inject_interceptor=True)
            except Exception:
                self.log_error("proxy error for %s:\n%s", self.path, traceback.format_exc())
                self.send_error(500)
            return

        if path.startswith("/webstudy/"):
            target = TC_APIS_BASE + path
            if parsed.query: target += "?" + parsed.query
            self._web_proxy_request(target, method="GET")
            return

        # 生成的语音文件（data/generated_audios/）
        if path.startswith("/generated/"):
            name = os.path.basename(path)
            full = os.path.join(GENERATED_AUDIO_DIR, name)
            if name and os.path.isfile(full):
                try:
                    with open(full, "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self._send_cors_headers()
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except Exception:
                    self.send_error(500)
                return
            self.send_error(404, "Not Found")
            return

        # 静态资源安全：不暴露项目根目录下的点文件/私有文件/源码
        if self._is_forbidden_static_path(path):
            self.send_error(404, "Not Found")
            return

        super().do_GET()

    def do_HEAD(self):
        """HEAD 与 GET 同等做 Host 校验与静态安全过滤，避免绕过白名单。"""
        if not self._is_allowed_host():
            self.send_error(403, "Forbidden")
            return
        path = urlparse(self.path).path
        if self._is_forbidden_static_path(path):
            self.send_error(404, "Not Found")
            return
        super().do_HEAD()

    def do_POST(self):
        if not self._is_allowed_host():
            self.send_error(403, "Forbidden")
            return
        parsed = urlparse(self.path)
        path = parsed.path

        # ---- /api/* 业务接口 ----
        if path.startswith("/api/"):
            self._handle_api_post(path, parsed)
            return

        # 代理墨墨 API
        if path.startswith("/proxy/memo/"):
            api_path = path[len("/proxy/memo/"):]
            target_url = MAIMEMO_BASE + "/api/v1/memo/" + api_path
            body = self.rfile.read(self._safe_content_length())
            self._proxy_request(target_url, method="POST", body=body)
            return

        # 代理 AI API: /proxy/ai
        if path == "/proxy/ai":
            body = self.rfile.read(self._safe_content_length())
            try:
                req_data = json.loads(body)
                ai_endpoint = req_data.get("endpoint", "").rstrip("/")
                ai_key = req_data.get("apiKey", "")
                ai_body = req_data.get("body", {})

                if not ai_endpoint or not ai_key:
                    self._send_json(400, {"error": "Missing endpoint or apiKey"})
                    return

                if not ai_endpoint.endswith("/chat/completions"):
                    ai_endpoint += "/chat/completions"
                target_url = ai_endpoint
                ai_req_body = json.dumps(ai_body).encode("utf-8")
                ai_req = urllib.request.Request(target_url, data=ai_req_body, method="POST")
                ai_req.add_header("Content-Type", "application/json")
                ai_req.add_header("Authorization", "Bearer " + ai_key)

                try:
                    ai_resp = urllib.request.urlopen(ai_req, timeout=60)
                    _AI_MAX = 8 * 1024 * 1024
                    _len = ai_resp.headers.get("Content-Length")
                    if _len and _len.isdigit() and int(_len) > _AI_MAX:
                        self._send_json(413, {"error": "AI response too large"})
                        return
                    ai_result = ai_resp.read(_AI_MAX + 1).decode("utf-8", errors="replace")
                    if len(ai_result) > _AI_MAX:
                        self._send_json(413, {"error": "AI response too large"})
                        return
                    self._send_json(200, json.loads(ai_result))
                except urllib.error.HTTPError as e:
                    err_body = e.read().decode("utf-8") if e.fp else ""
                    self._send_json(e.code, {"error": err_body})
                except urllib.error.URLError as e:
                    # 上游不可达（DNS/连接/超时）应返回 502，而不是 500
                    self._send_json(502, {"error": "AI 上游不可达: %s" % getattr(e, "reason", e)})
                except Exception as e:
                    self._send_json(500, {"error": str(e)})
            except json.JSONDecodeError:
                self._send_json(400, {"error": "Invalid JSON body"})
            return

        # ---- Maimemo web study reverse proxy (POST) ----
        if path.startswith("/memo-tc/"):
            sub = path[len("/memo-tc/"):]
            target = TC_APIS_BASE + "/" + sub
            if parsed.query: target += "?" + parsed.query
            self._web_proxy_request(target, method="POST")
            return

        if path.startswith("/memo-api/"):
            sub = path[len("/memo-api/"):]
            target = API_BASE + "/" + sub
            if parsed.query: target += "?" + parsed.query
            self._web_proxy_request(target, method="POST")
            return

        if path.startswith("/memo-www/"):
            sub = path[len("/memo-www/"):]
            target = WWW_BASE + "/" + sub
            if parsed.query: target += "?" + parsed.query
            self._web_proxy_request(target, method="POST")
            return

        if path.startswith("/memo-accounts/"):
            sub = path[len("/memo-accounts/"):]
            target = ACCOUNTS_BASE + "/" + sub
            if parsed.query: target += "?" + parsed.query
            self._web_proxy_request(target, method="POST")
            return

        if path.startswith("/webstudy/"):
            target = TC_APIS_BASE + path
            if parsed.query: target += "?" + parsed.query
            self._web_proxy_request(target, method="POST")
            return

        self.send_error(404, "Not Found")

    # ===================== /api/* GET =====================
    def _handle_api_get(self, path, parsed):
        # 与数据库无关的本地接口（运行模式 / 语音资源包状态）
        if path == "/api/app/current-mode":
            return self._send_json(200, {
                "mode": _current_mode(),
                "is_frozen": bool(getattr(sys, "frozen", False)),
                "data_dir": DATA_DIR,
            })

        if path == "/api/tts/status":
            import tts
            return self._send_json(200, tts.get_status(TTS_PACK_DIR, DATA_DIR))

        if not DB_READY:
            return self._send_json(503, {"error": "数据库未就绪"})
        try:
            if path == "/api/recommendations/today":
                recs = recommender.get_today_recommendations()
                summary = recommender.get_recommendation_summary()
                return self._send_json(200, {"recommendations": recs, "summary": summary})

            if path == "/api/stats/history":
                raw = parse_qs(parsed.query).get("days", ["30"])[0]
                try:
                    days = int(raw)
                except (ValueError, TypeError):
                    return self._send_json(400, {"error": "days must be an integer"})
                if not (1 <= days <= 3650):
                    return self._send_json(400, {"error": "days out of range (1-3650)"})
                return self._send_json(200, {"stats": db.get_history_stats(days)})

            if path == "/api/db/status":
                return self._send_json(200, {
                    "db_ready": True,
                    "has_snapshot": db.has_today_snapshot(),
                    "has_recommendations": db.has_today_recommendations(),
                })

            return self._send_json(404, {"error": "未知接口"})
        except Exception as e:
            traceback.print_exc()
            return self._send_json(500, {"error": str(e)})

    # ===================== /api/* POST =====================
    def _handle_api_post(self, path, parsed):
        try:
            # 写接口 CSRF 防护：要求自定义头（跨域简单请求无法携带，
            # 会触发 CORS 预检并被同源策略拦截）
            if self.headers.get("X-Requested-With") != "XMLHttpRequest":
                return self._send_json(403, {"error": "缺少 X-Requested-With 头"})
            try:
                body = self._read_json_body()
            except (json.JSONDecodeError, ValueError):
                return self._send_json(400, {"error": "Invalid JSON body"})

            # 运行模式设置（与数据库无关）
            if path == "/api/app/set-default-mode":
                mode = body.get("mode")
                if mode not in ("desktop", "web"):
                    return self._send_json(400, {"error": "mode 必须是 desktop 或 web"})
                if not _write_launcher_config(mode, True):
                    return self._send_json(500, {"error": "无法写入启动配置文件"})
                return self._send_json(200, {"ok": True, "mode": mode, "remember": True})

            if path == "/api/app/relaunch":
                mode = body.get("mode")
                if mode not in ("desktop", "web"):
                    return self._send_json(400, {"error": "mode 必须是 desktop 或 web"})
                ok, msg = _relaunch_app(mode)
                if not ok:
                    return self._send_json(400, {"error": msg})
                return self._send_json(200, {"ok": True, "mode": mode, "relaunching": True})

            # 语音资源包接口（与数据库无关）
            if path == "/api/tts/speak":
                import tts
                try:
                    wav_path = tts.speak(
                        TTS_PACK_DIR,
                        DATA_DIR,
                        body.get("text", ""),
                        voice=body.get("voice"),
                        language=body.get("language"),
                        speed=body.get("speed"),
                    )
                    return self._send_json(200, {
                        "ok": True,
                        "audio_url": "/generated/" + os.path.basename(wav_path),
                    })
                except tts.TTSException as e:
                    return self._send_json(404, {"error": str(e)})

            if path == "/api/tts/enable":
                import tts
                try:
                    state = tts.set_enabled(TTS_PACK_DIR, DATA_DIR, True)
                    return self._send_json(200, {"ok": True, "enabled": True, "voice": state.get("voice")})
                except tts.TTSException as e:
                    return self._send_json(400, {"error": str(e)})

            if path == "/api/tts/disable":
                import tts
                tts.set_enabled(TTS_PACK_DIR, DATA_DIR, False)
                return self._send_json(200, {"ok": True, "enabled": False})

            if path == "/api/tts/preload":
                import tts
                try:
                    tts.preload(TTS_PACK_DIR, DATA_DIR, voice=body.get("voice"))
                    return self._send_json(200, {"ok": True})
                except tts.TTSException as e:
                    return self._send_json(400, {"error": str(e)})

            if path == "/api/tts/shutdown":
                import tts
                tts.shutdown(TTS_PACK_DIR, DATA_DIR)
                return self._send_json(200, {"ok": True})

            if not DB_READY:
                return self._send_json(503, {"error": "数据库未就绪"})

            # 保存当日快照并生成推荐
            if path == "/api/snapshot":
                force = bool(body.get("force"))
                if not force and db.has_today_snapshot() and db.has_today_recommendations():
                    return self._send_json(200, {
                        "skipped": True,
                        "summary": recommender.get_recommendation_summary(),
                    })
                records = body.get("records", []) or []
                if not isinstance(records, list):
                    return self._send_json(400, {"error": "records 必须是数组"})
                n = db.save_snapshot(records)
                stats = db.compute_and_save_daily_stats()
                cnt = recommender.generate_recommendations(30)
                return self._send_json(200, {
                    "skipped": False,
                    "saved": n,
                    "recommendations": cnt,
                    "stats": stats,
                    "summary": recommender.get_recommendation_summary(),
                })

            # 标记推荐为已复习: /api/recommendations/<id>/review
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "recommendations" and parts[3] == "review":
                rc = recommender.mark_reviewed(parts[2])
                return self._send_json(200, {"ok": True, "updated": rc})

            return self._send_json(404, {"error": "未知接口"})
        except Exception as e:
            traceback.print_exc()
            return self._send_json(500, {"error": str(e)})

    # ===================== helpers =====================
    def _safe_content_length(self):
        """安全读取 Content-Length 头。畸形值(非数字/空串等)返回 0，避免
        int() 抛出未捕获的 ValueError/TypeError 导致请求被丢弃。"""
        raw = self.headers.get('Content-Length', 0)
        try:
            n = int(raw)
            return n if n > 0 else 0
        except (ValueError, TypeError):
            return 0

    def _read_json_body(self):
        length = self._safe_content_length()
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _proxy_request(self, target_url, method="GET", body=None):
        """转发请求到墨墨 API，去掉 Origin 头"""
        auth = self.headers.get("Authorization", "")

        req = urllib.request.Request(target_url, data=body, method=method)
        req.add_header("Accept", "application/json")
        if auth:
            req.add_header("Authorization", auth)
        if method == "POST" and body:
            req.add_header("Content-Type", "application/json")

        try:
            resp = urllib.request.urlopen(req, timeout=30)
            result = resp.read().decode("utf-8")
            self.send_response(resp.status)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(result.encode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8") if e.fp else ""
            self.send_response(e.code)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(err_body.encode("utf-8"))
        except Exception as e:
            self.send_response(502)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

    def _send_json(self, code, data):
        self.send_response(code)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def log_message(self, format, *args):
        sys.stderr.write("[%s] %s %s %s\n" % (
            self.log_date_time_string(), args[0] if len(args) > 0 else '', args[1] if len(args) > 1 else '', args[2] if len(args) > 2 else ''
        ))


def _current_mode():
    """当前运行模式；未设置时默认视为网页模式。"""
    return os.environ.get("MEMO_MODE", "web")


_relaunch_handler = None


def set_relaunch_handler(handler):
    """由 launcher 在启动时注册“重启到另一模式”的处理函数。

    launcher.py 以 __main__ 运行时，server 内 `import launcher` 会得到
    另一个模块实例，无法共享其中的单实例锁状态，因此改为显式注册回调。
    """
    global _relaunch_handler
    _relaunch_handler = handler


def _write_launcher_config(mode, remember):
    try:
        with open(LAUNCHER_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump({"mode": mode, "remember": bool(remember)}, f, ensure_ascii=False, indent=2)
        return True
    except OSError:
        return False


def _relaunch_app(mode):
    """仅打包（exe）模式支持自动重启到另一模式；源码模式给出提示。"""
    if not getattr(sys, "frozen", False):
        return False, "源码模式不支持自动重启，请手动运行：python launcher.py --mode " + mode
    if _relaunch_handler is None:
        return False, "重启处理函数未注册（请通过 launcher.py 启动）"
    try:
        _relaunch_handler(mode)
    except Exception as e:
        return False, "重启失败：" + str(e)
    return True, "正在重启..."


def start_server(open_browser=True, block=True):
    """启动服务器。block=False 时在后台守护线程运行，返回 (httpd, url)。"""
    for port in [PORT, 8889, 8890, 3000, 5000]:
        try:
            httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), MemoProxyHandler)
            httpd.allow_reuse_address = True
            url = "http://localhost:%d/index.html" % port
            print("")
            print("  ========================================")
            print("  Memo Superform proxy server started")
            print("  ========================================")
            print("")
            print("  Web dir:  %s" % WEB_DIR)
            print("  URL:      %s" % url)
            print("  API proxy: /proxy/memo/* -> open.maimemo.com")
            print("  AI proxy:  /proxy/ai")
            print("  DB API:    /api/*  (ready=%s)" % DB_READY)
            print("")
            print("  Press Ctrl+C to stop")
            print("")
            print("  %s" % ("-" * 40))
            if open_browser:
                threading.Timer(1.0, lambda u=url: webbrowser.open(u)).start()
            if block:
                httpd.serve_forever()
                return None
            t = threading.Thread(target=httpd.serve_forever, daemon=True)
            t.start()
            return httpd, url
        except OSError:
            continue
    if block:
        raise RuntimeError("无法启动本地服务器：端口 8888-8890、3000、5000 均被占用")
    return None


def main():
    try:
        result = start_server(open_browser=True, block=True)
    except RuntimeError as exc:
        print(exc)
        sys.exit(1)
    if not result:
        print("Error: Cannot find available port (8888-8890, 3000, 5000 all in use)")
        sys.exit(1)


if __name__ == "__main__":
    main()
