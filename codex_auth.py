#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenAI Codex（ChatGPT OAuth）登录与 Responses 传输。

参考 Cherry Studio 公开的 Codex 提供商集成方式后，以 Python 独立实现 PKCE 登录、
OAuth 令牌刷新、ChatGPT 账户路由和 Codex Responses 传输；仅依赖标准库。
"""

import base64
import hashlib
import http.server
import json
import os
import secrets
import socketserver
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser


CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
ISSUER = "https://auth.openai.com"
TOKEN_URL = ISSUER + "/oauth/token"
REVOKE_URL = ISSUER + "/oauth/revoke"
CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
CALLBACK_PORTS = (1455, 1457)
SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def _b64url(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _jwt_claims(token):
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part.encode("ascii")))
    except (ValueError, IndexError, json.JSONDecodeError, UnicodeDecodeError):
        return {}


def _account_id(tokens):
    for key in ("access_token", "id_token"):
        claims = _jwt_claims(tokens.get(key, ""))
        auth = claims.get("https://api.openai.com/auth") or {}
        value = auth.get("chatgpt_account_id") or claims.get("chatgpt_account_id")
        if value:
            return value
    return None


def _identity(tokens):
    claims = _jwt_claims(tokens.get("id_token", ""))
    auth = claims.get("https://api.openai.com/auth") or {}
    return {
        "account_id": _account_id(tokens),
        "email": claims.get("email"),
        "plan": auth.get("chatgpt_plan_type"),
    }


def _form_post(url, fields, timeout=30):
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RuntimeError("OAuth response too large")
        return json.loads(raw.decode("utf-8"))


def _response_text(payload):
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    chunks = []
    for item in payload.get("output") or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if content.get("type") in ("output_text", "text") and isinstance(content.get("text"), str):
                chunks.append(content["text"])
    return "".join(chunks)


def _chat_to_responses(body):
    instructions = []
    input_items = []
    for message in body.get("messages") or []:
        role = message.get("role", "user")
        content = message.get("content", "")
        if role in ("system", "developer"):
            if isinstance(content, str):
                instructions.append(content)
            continue
        if isinstance(content, str):
            content = [{"type": "output_text" if role == "assistant" else "input_text", "text": content}]
        input_items.append({"role": role, "content": content})
    result = {
        "model": body.get("model") or "gpt-5.6-terra",
        "input": input_items,
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "reasoning": {"effort": body.get("reasoning_effort") or "medium"},
    }
    if instructions:
        result["instructions"] = "\n\n".join(instructions)
    return result


def _decode_codex_response(raw, content_type):
    text = raw.decode("utf-8", errors="replace")
    if "text/event-stream" not in (content_type or "").lower() and text.lstrip().startswith("{"):
        return json.loads(text)
    completed = None
    deltas = []
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        value = line[5:].strip()
        if not value or value == "[DONE]":
            continue
        try:
            event = json.loads(value)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "response.output_text.delta" and isinstance(event.get("delta"), str):
            deltas.append(event["delta"])
        if event.get("type") == "response.completed":
            completed = event.get("response") or event
    if completed is not None:
        if deltas and not _response_text(completed):
            completed["output_text"] = "".join(deltas)
        return completed
    if deltas:
        return {"output_text": "".join(deltas)}
    raise RuntimeError("Codex 流式响应未正常完成")


class _CallbackServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"


class CodexOAuth:
    def __init__(self, data_dir):
        self.path = os.path.join(data_dir, "codex_auth.json")
        self._lock = threading.RLock()
        self._pending = None
        self._callback_server = None

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save(self, data):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        temp = self.path + ".tmp"
        with open(temp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        try:
            os.chmod(temp, 0o600)
        except OSError:
            pass
        os.replace(temp, self.path)

    def status(self):
        data = self._load()
        tokens = data.get("tokens") or {}
        ident = _identity(tokens)
        pending = self._pending
        return {
            "connected": bool(tokens.get("access_token") and tokens.get("refresh_token")),
            "pending": bool(pending),
            "error": pending.get("error") if pending else None,
            "account_id": ident["account_id"],
            "email": ident["email"],
            "plan": ident["plan"],
        }

    def start_login(self, open_browser=True):
        with self._lock:
            self._stop_callback_server()
            verifier = _b64url(secrets.token_bytes(64))
            challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
            state = _b64url(secrets.token_bytes(32))
            service = self

            class CallbackHandler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    parsed = urllib.parse.urlparse(self.path)
                    if parsed.path != "/auth/callback":
                        self.send_error(404)
                        return
                    params = urllib.parse.parse_qs(parsed.query)
                    ok, message = service._complete_login(params)
                    body = ("<!doctype html><meta charset=utf-8><title>Memo Superform</title>"
                            "<style>body{font:16px system-ui;background:#171717;color:#eee;display:grid;"
                            "place-items:center;height:100vh;margin:0}.box{padding:32px;border-radius:16px;"
                            "background:#222;text-align:center}</style><div class=box><h2>" +
                            ("Codex 登录成功" if ok else "Codex 登录失败") + "</h2><p>" +
                            message + "</p><p>现在可以关闭此窗口。</p></div>").encode("utf-8")
                    self.send_response(200 if ok else 400)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                    threading.Thread(target=service._stop_callback_server, daemon=True).start()

                def log_message(self, _format, *_args):
                    pass

            server = None
            for port in CALLBACK_PORTS:
                try:
                    server = _CallbackServer(("127.0.0.1", port), CallbackHandler)
                    break
                except OSError:
                    continue
            if server is None:
                raise RuntimeError("Codex 登录回调端口 1455/1457 均被占用")
            port = server.server_address[1]
            redirect_uri = "http://localhost:%d/auth/callback" % port
            self._pending = {
                "state": state,
                "verifier": verifier,
                "redirect_uri": redirect_uri,
                "created_at": time.time(),
                "error": None,
            }
            self._callback_server = server
            threading.Thread(target=server.serve_forever, name="codex-oauth-callback", daemon=True).start()
            query = urllib.parse.urlencode({
                "response_type": "code",
                "client_id": CLIENT_ID,
                "redirect_uri": redirect_uri,
                "scope": SCOPES,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "id_token_add_organizations": "true",
                "codex_cli_simplified_flow": "true",
                "state": state,
                "originator": "memo-superform",
            })
            authorization_url = ISSUER + "/oauth/authorize?" + query
            opened = bool(webbrowser.open(authorization_url, new=2)) if open_browser else False
            return {"authorization_url": authorization_url, "port": port, "opened": opened}

    def _complete_login(self, params):
        with self._lock:
            pending = self._pending
            if not pending or params.get("state", [None])[0] != pending.get("state"):
                return False, "登录状态校验失败"
            if params.get("error"):
                message = params.get("error_description", params["error"])[0]
                pending["error"] = message
                return False, message
            code = params.get("code", [None])[0]
            if not code:
                pending["error"] = "缺少授权码"
                return False, pending["error"]
            try:
                tokens = _form_post(TOKEN_URL, {
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": pending["redirect_uri"],
                    "client_id": CLIENT_ID,
                    "code_verifier": pending["verifier"],
                })
                self._save({"tokens": tokens, "updated_at": int(time.time())})
                self._pending = None
                return True, "账号已连接"
            except Exception as exc:
                pending["error"] = str(exc)
                return False, "令牌交换失败"

    def _stop_callback_server(self):
        server = self._callback_server
        self._callback_server = None
        if server:
            try:
                server.shutdown()
                server.server_close()
            except OSError:
                pass

    def logout(self):
        with self._lock:
            data = self._load()
            token = (data.get("tokens") or {}).get("refresh_token")
            if token:
                try:
                    _form_post(REVOKE_URL, {"client_id": CLIENT_ID, "token": token}, timeout=10)
                except Exception:
                    pass
            try:
                os.remove(self.path)
            except FileNotFoundError:
                pass
            self._pending = None
            self._stop_callback_server()

    def _tokens(self, force_refresh=False):
        with self._lock:
            data = self._load()
            tokens = data.get("tokens") or {}
            if not tokens.get("access_token") or not tokens.get("refresh_token"):
                raise RuntimeError("请先在设置中登录 OpenAI Codex")
            expiry = (_jwt_claims(tokens["access_token"]).get("exp") or 0) - 300
            if force_refresh or time.time() >= expiry:
                refreshed = _form_post(TOKEN_URL, {
                    "client_id": CLIENT_ID,
                    "grant_type": "refresh_token",
                    "refresh_token": tokens["refresh_token"],
                })
                if not refreshed.get("refresh_token"):
                    refreshed["refresh_token"] = tokens["refresh_token"]
                if not refreshed.get("id_token") and tokens.get("id_token"):
                    refreshed["id_token"] = tokens["id_token"]
                tokens = refreshed
                self._save({"tokens": tokens, "updated_at": int(time.time())})
            return tokens

    def _request(self, body, force_refresh=False):
        tokens = self._tokens(force_refresh=force_refresh)
        req = urllib.request.Request(
            CODEX_RESPONSES_URL,
            data=json.dumps(_chat_to_responses(body)).encode("utf-8"),
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "text/event-stream")
        req.add_header("Authorization", "Bearer " + tokens["access_token"])
        account_id = _account_id(tokens)
        if account_id:
            req.add_header("ChatGPT-Account-Id", account_id)
        req.add_header("OpenAI-Beta", "responses=experimental")
        req.add_header("originator", "memo-superform")
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError("Codex response too large")
            return _decode_codex_response(raw, resp.headers.get("Content-Type", ""))

    def chat(self, body):
        try:
            payload = self._request(body)
        except urllib.error.HTTPError as exc:
            if exc.code != 401:
                raise
            payload = self._request(body, force_refresh=True)
        text = _response_text(payload)
        return {
            "id": payload.get("id"),
            "model": payload.get("model") or body.get("model"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": payload.get("usage") or {},
        }
