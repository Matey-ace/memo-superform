#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Memo Superform - 本地代理服务器
解决墨墨 API 不支持 CORS 的问题，同时提供静态文件服务、AI 代理、
以及基于 SQLite 的增量数据中心与智能复习推荐 API。

使用方法：
  python server.py
  然后在浏览器打开 http://localhost:8888
"""

import http.server
import socketserver
import socket
import ssl
import select
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
from urllib.parse import urlparse

import codex_auth
from live2d_service import Live2DService
from app_api import LocalApiMixin, configure_local_api
from static_security import is_forbidden_static_path

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
DATA_DIR = os.environ.get("MEMO_DATA_DIR") or os.path.join(_runtime_root(), "data")
DATA_DIR = os.path.abspath(DATA_DIR)
TTS_PACK_DIR = os.path.join(DATA_DIR, "tts_pack")
GENERATED_AUDIO_DIR = os.path.join(DATA_DIR, "generated_audios")
LAUNCHER_CONFIG_PATH = os.path.join(DATA_DIR, "launcher.json")
for _data_dir in (DATA_DIR, TTS_PACK_DIR, GENERATED_AUDIO_DIR):
    try:
        os.makedirs(_data_dir, exist_ok=True)
    except OSError:
        pass

CODEX_OAUTH = codex_auth.CodexOAuth(DATA_DIR)
LIVE2D_SERVICE = Live2DService(DATA_DIR)

from memo_proxy import MAIMEMO_BASE, resolve_web_route

from memo_injection import (
    INTERCEPTOR_JS, MEMO_DARK_CSS, MEMO_DARK_JS, MEMO_STUDY_THEME,
    MEMO_NAV_GUARD_JS, MEMO_STUDY_KEYS_JS,
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不在服务端跟随 HTTP 重定向，而是把响应交还浏览器。

    The OIDC login flow (auth/login -> oidc/auth -> interaction -> callback)
    relies on the browser following each 302/303 step through the proxy so
    that cookies set by accounts.maimemo.com are managed by the browser and
    sent back on every proxied request. urllib's default redirect following
    would drop cookies and flatten the flow."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# ---- 数据库（可选，失败不致命，不影响代理与静态服务） ----
DB_READY = False
STUDY_SYNC_SERVICE = None
STUDY_SYNC_MANAGER = None
try:
    import db
    import recommender
    import study_sync
    db.init_db(DATA_DIR)
    _sync_repository = study_sync.DbStudySyncRepository(db)
    STUDY_SYNC_SERVICE = study_sync.StudySyncService(_sync_repository)
    STUDY_SYNC_MANAGER = study_sync.SyncManager(STUDY_SYNC_SERVICE)
    DB_READY = True
    print("[db] SQLite 已就绪：%s" % db.database_path())
except Exception as e:
    print("[db] SQLite 数据中心不可用:", e)


class MemoThreadingTCPServer(socketserver.ThreadingTCPServer):
    """请求线程不阻塞退出，并避免 Windows 上多个进程同时占用同一端口。"""
    # Unix 允许复用 TIME_WAIT 地址以便快速重启；Windows 的 SO_REUSEADDR
    # 会允许两个监听进程绑定同一端口，因此必须改用独占地址。
    allow_reuse_address = os.name != "nt"
    allow_reuse_port = False
    daemon_threads = True
    block_on_close = False

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class MemoProxyHandler(LocalApiMixin, http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def _rewrite_content(self, body, content_type, proxy_prefix=None):
        """把内容中的墨墨域名 URL 重写为本地代理路径。

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
            # 把配置中的 api_host 和 memo_host 重写为绝对代理 URL，使
            # new URL(config.api_host) 与 window.location.replace() 都直接
            # 获得代理地址，无需再由拦截器捕获跳转。
            text = text.replace(
                'api_host:"https://tc-apis.maimemo.com"',
                'api_host:window.location.origin+"/memo-tc"'
            )
            text = text.replace(
                'memo_host:"https://api.maimemo.com"',
                'memo_host:window.location.origin+"/memo-api"'
            )
            # 把 ws_host 重写到本地代理，使学习 WebSocket 经由本服务而非直接
            # 连接用户网络可能访问不到的 tc-apis。附加 "/memo-tc" 前缀后，浏览器
            # 会在 WebSocket 握手时发送 tc-apis 会话 Cookie
            # （sid，Path=/memo-tc/study）；缺少它时，即使登录有效也会收到 3401。
            text = text.replace(
                'ws_host:"wss://tc-apis.maimemo.com"',
                'ws_host:(location.protocol==="https:"?"wss://":"ws://")+location.host+"/memo-tc"'
            )
            # 注意：login_return_url 必须保持原始
            # https://tc-apis.maimemo.com/webstudy/app；tc-apis 会以
            # login_initiation_failed 拒绝非墨墨域名的 return_url。
        else:
            # HTML/CSS：把域名 URL 重写为相对代理路径。
            text = text.replace('https://tc-apis.maimemo.com', '/memo-tc')
            text = text.replace('https://api.maimemo.com', '/memo-api')
            text = text.replace('https://www.maimemo.com', '/memo-www')
            text = text.replace('https://accounts.maimemo.com', '/memo-accounts')

            # 对跨域重定向得到的 HTML 页面（例如经 /memo-tc/ 重定向加载的
            # accounts.maimemo.com 登录页），为绝对路径补上代理前缀。
            if is_html and proxy_prefix and proxy_prefix != '/memo-tc':
                # 把 href="/xxx"、src="/xxx"、action="/xxx" 等重写为
                # "/代理前缀/xxx"；已以 /memo- 开头的代理路径跳过。
                text = re.sub(
                    r'((?:href|src|action)\s*=\s*["\'])(/(?!memo-))',
                    r'\1' + proxy_prefix + r'\2',
                    text
                )
                # 重写内联 JavaScript 中的相对 URL（例如 fetch 调用），使
                # /interaction/xxx 变为 /memo-accounts/interaction/xxx。
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
                # 浏览器拒绝通过纯 HTTP 保存 __Host-* Cookie，因此代理在
                # Set-Cookie 中把 __Host-x-csrf-token 改为 x-csrf-token；
                # 转发请求时再改回，让 accounts.maimemo.com 找到预期 Cookie。
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

        # 根据当前请求路径推导代理前缀，使相对 Location 头（如
        # /interaction/xxx）和 HTML 绝对路径都能重写到匹配前缀。
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
            # 缓存失效：为 script/link 的 src/href 附加 ?v=<时间戳>，强制浏览器
            # 加载最新 JS/CSS，避免复用仍指向真实墨墨域名的旧缓存。
            import time as _time
            _bv = str(int(_time.time()))
            html = re.sub(r'(<script[^>]*src=")([^"]*)(")', lambda m: m.group(1) + m.group(2) + ('&' if '?' in m.group(2) else '?') + 'v=' + _bv + m.group(3), html)
            html = re.sub(r'(<link[^>]*href=")([^"]*)(")', lambda m: m.group(1) + m.group(2) + ('&' if '?' in m.group(2) else '?') + 'v=' + _bv + m.group(3), html)
            if '<head>' in html:
                html = html.replace('<head>', '<head>' + INTERCEPTOR_JS + MEMO_DARK_CSS + MEMO_DARK_JS + MEMO_STUDY_THEME + MEMO_NAV_GUARD_JS + MEMO_STUDY_KEYS_JS, 1)
            elif '<head ' in html:
                html = html.replace('<head ', INTERCEPTOR_JS + MEMO_DARK_CSS + MEMO_DARK_JS + MEMO_STUDY_THEME + MEMO_NAV_GUARD_JS + MEMO_STUDY_KEYS_JS + '<head ', 1)
            else:
                html = INTERCEPTOR_JS + MEMO_DARK_CSS + MEMO_DARK_JS + MEMO_STUDY_THEME + MEMO_NAV_GUARD_JS + MEMO_STUDY_KEYS_JS + html
            resp_body = html.encode('utf-8')
        else:
            resp_body = self._rewrite_content(resp_body, content_type, proxy_prefix)

        self.send_response(status)
        self._send_cors_headers()

        # 对 HTML/JS 强制禁用缓存，避免浏览器复用会直接跳转 maimemo.com 的旧重写包。
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
                # 去掉 Secure 标记，使 Cookie 可用于 HTTP 代理。
                val = val.replace('; Secure', '').replace('; secure', '')
                val = val.replace(';Secure', '').replace(';secure', '')
                # __Host- 前缀强制 Secure + Path=/；既然已去掉 Secure，就同步
                # 重命名 Cookie，确保浏览器接受。
                val = val.replace('__Host-', '')
                # 为 Cookie Path 加上代理前缀，使 accounts.maimemo.com 等设置的
                # Path=/interaction/xxx 会发送到 /memo-accounts/interaction/xxx。
                # 根 Path=/ 保持不变（仅匹配 /xxx 子路径）。
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
                # 相对 Location（如 /interaction/xxx）需要补代理前缀。
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
        """把 WebSocket 连接代理到 tc-apis.maimemo.com。

        The web study SPA keeps a WebSocket open to
        wss://tc-apis.maimemo.com/study/ws/webstudy?token=... . The user's
        network cannot reach that host directly, so the browser connects to
        ws://localhost:8888/... instead and we relay the raw bytes.
        """
        target_host = "tc-apis.maimemo.com"
        target_port = 443
        target_path = path + ("?" + query if query else "")
        # 浏览器连接 /memo-tc/study/ws/webstudy 后会发送会话 Cookie sid
        #（Path=/memo-tc/study）。向上游转发前去掉代理前缀，恢复为
        # /study/ws/webstudy。
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

        # 向上游转发浏览器的握手请求头。
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

        # 读取上游握手响应。
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

        # 握手成功：向浏览器发送 101 和响应头，然后开始双向转发。
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

    def _is_forbidden_static_path(self, path):
        return is_forbidden_static_path(path)

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

    def _dispatch_web_proxy(self, parsed, method):
        """解析并转发一条墨墨 SPA 路由，返回是否匹配。"""
        resolved = resolve_web_route(parsed.path, parsed.query, method)
        if not resolved:
            return False
        target, inject, guard_errors = resolved
        if guard_errors:
            try:
                self._web_proxy_request(target, method=method, inject_interceptor=inject)
            except Exception:
                self.log_error("proxy error for %s:\n%s", self.path, traceback.format_exc())
                self.send_error(500)
        else:
            self._web_proxy_request(target, method=method, inject_interceptor=inject)
        return True

    def do_GET(self):
        if not self._is_allowed_host():
            self.send_error(403, "Forbidden")
            return
        parsed = urlparse(self.path)
        path = parsed.path

        # WebSocket 升级（学习连接）→ 转发到 tc-apis。
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

        # ---- 墨墨网页版学习反向代理 ----
        if self._dispatch_web_proxy(parsed, "GET"):
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

                if req_data.get("provider") == "codex":
                    try:
                        self._send_json(200, CODEX_OAUTH.chat(ai_body))
                    except urllib.error.HTTPError as e:
                        err_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
                        self._send_json(e.code, {"error": err_body or str(e)})
                    except urllib.error.URLError as e:
                        self._send_json(502, {"error": "Codex 上游不可达: %s" % getattr(e, "reason", e)})
                    except Exception as e:
                        self._send_json(401 if "登录" in str(e) else 500, {"error": str(e)})
                    return

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

        # ---- 墨墨网页版学习反向代理（POST）----
        if self._dispatch_web_proxy(parsed, "POST"):
            return

        self.send_error(404, "Not Found")

    def do_DELETE(self):
        if not self._is_allowed_host():
            self.send_error(403, "Forbidden")
            return
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api_delete(parsed.path, parsed)
            return
        self.send_error(404, "Not Found")

    # ===================== 辅助方法 =====================
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
        line = "[%s] %s %s %s\n" % (
            self.log_date_time_string(), args[0] if len(args) > 0 else '',
            args[1] if len(args) > 1 else '', args[2] if len(args) > 2 else '',
        )
        try:
            if sys.stderr is not None:
                sys.stderr.write(line)
                return
        except Exception:
            pass
        # 窗口版 EXE 没有控制台输出流；应用从托盘运行时，HTTP 日志绝不能因此
        # 中断响应。
        try:
            with open(os.path.join(DATA_DIR, "server.log"), "a", encoding="utf-8") as handle:
                handle.write(line)
        except OSError:
            pass


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


configure_local_api(
    CODEX_OAUTH=CODEX_OAUTH, DATA_DIR=DATA_DIR, TTS_PACK_DIR=TTS_PACK_DIR,
    DB_READY=DB_READY, db=globals().get("db"), recommender=globals().get("recommender"),
    STUDY_SYNC_SERVICE=STUDY_SYNC_SERVICE, STUDY_SYNC_MANAGER=STUDY_SYNC_MANAGER,
    LIVE2D_SERVICE=LIVE2D_SERVICE,
    _current_mode=_current_mode, _write_launcher_config=_write_launcher_config,
    _relaunch_app=_relaunch_app,
)


def start_server(open_browser=True, block=True):
    """启动服务器。block=False 时在后台守护线程运行，返回 (httpd, url)。"""
    for port in [PORT, 8889, 8890, 3000, 5000]:
        try:
            httpd = MemoThreadingTCPServer(("127.0.0.1", port), MemoProxyHandler)
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
