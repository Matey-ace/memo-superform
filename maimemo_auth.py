#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""墨墨开放平台的本机 OAuth 身份服务。

桌面应用是公开客户端：不保存 client_secret，使用 Authorization Code +
PKCE(S256)。浏览器完成 HTTPS 回调后，静态页只把授权码交给
``memo-superform://``，令牌交换与持久化始终在本机完成。
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from ctypes import wintypes
from pathlib import Path
from typing import Any, Callable, Mapping, Optional


ISSUER = "https://accounts.maimemo.com/oidc"
AUTHORIZE_URL = ISSUER + "/auth"
TOKEN_URL = ISSUER + "/token"
REVOCATION_URL = TOKEN_URL + "/revocation"
PUBLIC_SITE_ORIGIN = "https://matey-ace.github.io"
PUBLIC_SITE_BASE = PUBLIC_SITE_ORIGIN + "/memo-superform"
REDIRECT_URI = PUBLIC_SITE_BASE + "/oauth/callback.html"
START_URI = PUBLIC_SITE_BASE + "/oauth/start.html"
DEFAULT_SCOPES = (
    "openid profile offline_access "
    "open.memo.study open.memo.content"
)
PENDING_TTL_SECONDS = 10 * 60
MAX_CALLBACK_VALUE = 8192

# 墨墨开放平台审核通过的公开客户端标识。它会随 Windows EXE 一起发布；client_id
# 本身不是密钥，也不会让任何 Token 泄露。开发/测试时仍可用
# MEMO_MAIMEMO_CLIENT_ID 临时覆盖。当前获批的业务 scope 是完整的 study/content
# scope；即使如此，server.py 仍只白名单放行产品需要的只读开放 API。
#
# 纯前端应用不能也不需要保存 client_secret，桌面端始终使用 PKCE S256。
MAIMEMO_CLIENT_ID = "6a968536c8e75d605a3c9f13"


class MaimemoAuthError(RuntimeError):
    """用户可见的墨墨授权错误。"""


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _jwt_claims(token: str) -> dict[str, Any]:
    try:
        part = str(token).split(".")[1]
        part += "=" * (-len(part) % 4)
        value = json.loads(base64.urlsafe_b64decode(part.encode("ascii")))
        return value if isinstance(value, dict) else {}
    except (IndexError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _blob(data: bytes):
    buffer = ctypes.create_string_buffer(data, max(1, len(data)))
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


class DPAPIProtector:
    """绑定当前 Windows 用户的 DPAPI 保护层。"""

    _FLAG_UI_FORBIDDEN = 0x1

    def __init__(self, description: str = "Memo Superform Maimemo credential"):
        self.description = description

    @staticmethod
    def _available() -> bool:
        return os.name == "nt" and hasattr(ctypes, "windll")

    def protect(self, plaintext: bytes) -> bytes:
        if not self._available():
            raise MaimemoAuthError("墨墨一键授权仅支持 Windows 桌面版")
        source, source_buffer = _blob(plaintext)
        result = _DataBlob()
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        crypt32.CryptProtectData.argtypes = [
            ctypes.POINTER(_DataBlob), wintypes.LPCWSTR, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob),
        ]
        crypt32.CryptProtectData.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        ok = crypt32.CryptProtectData(
            ctypes.byref(source), self.description, None, None, None,
            self._FLAG_UI_FORBIDDEN, ctypes.byref(result),
        )
        del source_buffer
        if not ok:
            raise MaimemoAuthError("Windows 凭据保护失败（错误码 %d）" % ctypes.get_last_error())
        try:
            return ctypes.string_at(result.pbData, result.cbData)
        finally:
            kernel32.LocalFree(result.pbData)

    def unprotect(self, ciphertext: bytes) -> bytes:
        if not self._available():
            raise MaimemoAuthError("墨墨一键授权仅支持 Windows 桌面版")
        source, source_buffer = _blob(ciphertext)
        result = _DataBlob()
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob),
        ]
        crypt32.CryptUnprotectData.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(source), None, None, None, None,
            self._FLAG_UI_FORBIDDEN, ctypes.byref(result),
        )
        del source_buffer
        if not ok:
            raise MaimemoAuthError("Windows 凭据读取失败（错误码 %d）" % ctypes.get_last_error())
        try:
            return ctypes.string_at(result.pbData, result.cbData)
        finally:
            kernel32.LocalFree(result.pbData)


class CredentialStore:
    """原子读写 DPAPI 加密的认证与短期 PKCE 状态。"""

    def __init__(self, path: str | Path, protector: Optional[Any] = None):
        self.path = Path(path)
        self.protector = protector or DPAPIProtector()

    def load(self) -> dict[str, Any]:
        try:
            raw = self.path.read_bytes()
            plain = self.protector.unprotect(raw)
            data = json.loads(plain.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, MaimemoAuthError):
            return {}

    def save(self, value: Mapping[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        plain = json.dumps(dict(value), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        protected = self.protector.protect(plain)
        temporary = self.path.with_name(self.path.name + ".tmp-" + secrets.token_hex(8))
        try:
            temporary.write_bytes(protected)
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, self.path)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def clear(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise MaimemoAuthError("本机凭据删除失败：%s" % exc) from exc


class MaimemoOAuth:
    """将 OAuth 与旧手动 Token 收敛为一个本机身份来源。"""

    def __init__(
        self,
        data_dir: str | Path,
        *,
        client_id: Optional[str] = None,
        issuer: str = ISSUER,
        redirect_uri: str = REDIRECT_URI,
        start_uri: str = START_URI,
        scopes: str = DEFAULT_SCOPES,
        credential_store: Optional[CredentialStore] = None,
        pending_store: Optional[CredentialStore] = None,
        now: Callable[[], float] = time.time,
        opener: Callable[..., bool] = webbrowser.open,
        post_form: Optional[Callable[[str, Mapping[str, str]], Mapping[str, Any]]] = None,
    ):
        directory = Path(data_dir)
        if client_id is not None:
            configured = client_id
        else:
            # 空环境变量不应意外关闭已审核发布包的一键授权；只有非空值才作为
            # 开发/测试用覆盖项。
            configured = os.environ.get("MEMO_MAIMEMO_CLIENT_ID", "").strip() or MAIMEMO_CLIENT_ID
        self.client_id = str(configured or "").strip()
        self.issuer = str(issuer).rstrip("/")
        self.authorize_url = self.issuer + "/auth"
        self.token_url = self.issuer + "/token"
        self.revocation_url = self.token_url + "/revocation"
        self.redirect_uri = str(redirect_uri)
        self.start_uri = str(start_uri)
        self.scopes = " ".join(part for part in str(scopes).split() if part)
        self.credentials = credential_store or CredentialStore(directory / "maimemo_auth.bin")
        self.pending = pending_store or CredentialStore(directory / "maimemo_auth_pending.bin")
        self.now = now
        self.opener = opener
        self.post_form = post_form or self._post_form
        # ``None`` 保持给独立单元测试/嵌入式调用的兼容；正式桌面启动器会在
        # 创建本地服务前明确写入 True 或 False。只有已知注册失败时才阻止登录。
        self._callback_protocol_ready: Optional[bool] = None
        self._callback_protocol_error = ""

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_id != "__MAIMEMO_CLIENT_ID__")

    def set_callback_protocol_status(self, ready: bool, error: str = "") -> None:
        """记录桌面 ``memo-superform://`` 回调协议是否可用。

        该状态只决定能否开始新的浏览器授权；手动 Token 与已开始的回调处理不受
        影响。错误文案由启动器提供的固定用户提示构成，不包含注册表路径或本机
        异常细节。
        """
        self._callback_protocol_ready = bool(ready)
        if self._callback_protocol_ready:
            self._callback_protocol_error = ""
        else:
            self._callback_protocol_error = str(error or "一键授权回调协议未注册，请重新启动 Memo Superform.exe 后重试。")[:300]

    @staticmethod
    def _post_form(url: str, fields: Mapping[str, str]) -> Mapping[str, Any]:
        request = urllib.request.Request(
            url,
            data=urllib.parse.urlencode(dict(fields)).encode("utf-8"),
            method="POST",
        )
        request.add_header("Accept", "application/json")
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise MaimemoAuthError("墨墨授权服务返回内容过大")
                data = json.loads(raw.decode("utf-8"))
                if not isinstance(data, dict):
                    raise MaimemoAuthError("墨墨授权服务返回格式错误")
                return data
        except urllib.error.HTTPError as exc:
            raw = exc.read(64 * 1024) if exc.fp else b""
            try:
                detail = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = {}
            message = detail.get("error_description") or detail.get("error") or "HTTP %s" % exc.code
            raise MaimemoAuthError("墨墨授权失败：%s" % message) from exc
        except urllib.error.URLError as exc:
            raise MaimemoAuthError("墨墨授权服务连接失败：%s" % getattr(exc, "reason", exc)) from exc

    def _credential_data(self) -> dict[str, Any]:
        return self.credentials.load()

    def _subject(self, data: Mapping[str, Any]) -> str:
        subject = str(data.get("subject") or "").strip()
        if subject:
            return subject
        tokens = data.get("tokens") if isinstance(data.get("tokens"), Mapping) else {}
        claims = _jwt_claims(str(tokens.get("id_token") or ""))
        return str(claims.get("sub") or "").strip()

    def _display_name(self, data: Mapping[str, Any]) -> str:
        value = str(data.get("display_name") or "").strip()
        if value:
            return value
        tokens = data.get("tokens") if isinstance(data.get("tokens"), Mapping) else {}
        claims = _jwt_claims(str(tokens.get("id_token") or ""))
        return str(claims.get("name") or claims.get("preferred_username") or "").strip()

    def status(self) -> dict[str, Any]:
        data = self._credential_data()
        mode = str(data.get("mode") or "")
        pending = self.pending.load()
        pending_active = bool(pending and self.now() - float(pending.get("created_at") or 0) <= PENDING_TTL_SECONDS)
        if pending and not pending_active:
            self.pending.clear()
        if mode == "oauth":
            tokens = data.get("tokens") if isinstance(data.get("tokens"), Mapping) else {}
            connected = bool(tokens.get("access_token") and self._subject(data))
        elif mode == "manual":
            connected = bool(str(data.get("manual_token") or "").strip())
        else:
            connected = False
        return {
            "configured": self.configured,
            # 未标记时保留测试/嵌入调用的可用状态；正规的 launcher 总会在载入
            # server.py 前标记结果，直接运行 server.py 则明确返回 False。
            "callback_ready": self._callback_protocol_ready is not False,
            "callback_error": self._callback_protocol_error if self._callback_protocol_ready is False else "",
            "connected": connected,
            "mode": mode if connected else "",
            "subject": self._subject(data) if connected and mode == "oauth" else "",
            "display_name": self._display_name(data) if connected and mode == "oauth" else "",
            # 哈希后的稳定档案键只用于本机缓存隔离/SQLite 关联，不是 Token 或 OIDC sub。
            "profile_id": self._profile_key_from_data(data) if connected else "",
            "pending": pending_active,
            "error": str(pending.get("error") or "") if pending_active else "",
            "redirect_uri": self.redirect_uri,
        }

    def start_login(self, *, open_browser: bool = True) -> dict[str, Any]:
        if not self.configured:
            raise MaimemoAuthError("墨墨开放平台 client_id 尚未配置")
        if self._callback_protocol_ready is False:
            raise MaimemoAuthError(self._callback_protocol_error or "一键授权回调协议未注册，请重新启动 Memo Superform.exe 后重试。")
        verifier = _b64url(secrets.token_bytes(64))
        challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
        state = _b64url(secrets.token_bytes(32))
        created_at = self.now()
        self.pending.save({
            "version": 1,
            "state": state,
            "verifier": verifier,
            "created_at": created_at,
            "error": "",
        })
        query = urllib.parse.urlencode({
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": self.scopes,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "issuer": self.issuer,
        })
        authorization_url = self.start_uri + "?" + query
        opened = bool(self.opener(authorization_url, new=2)) if open_browser else False
        return {"authorization_url": authorization_url, "opened": opened, "expires_at": int(created_at + PENDING_TTL_SECONDS)}

    def complete_callback_url(self, callback_url: str) -> dict[str, Any]:
        if len(str(callback_url or "")) > MAX_CALLBACK_VALUE:
            raise MaimemoAuthError("授权回调过长")
        parsed = urllib.parse.urlparse(str(callback_url or ""))
        if parsed.scheme.lower() != "memo-superform" or parsed.netloc.lower() != "maimemo-oauth":
            raise MaimemoAuthError("授权回调地址无效")
        values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        pending = self.pending.load()
        if not pending:
            raise MaimemoAuthError("未找到待完成的墨墨授权")
        if self.now() - float(pending.get("created_at") or 0) > PENDING_TTL_SECONDS:
            self.pending.clear()
            raise MaimemoAuthError("墨墨授权已过期，请重新连接")
        state = str(values.get("state", [""])[0])
        expected = str(pending.get("state") or "")
        if not expected or not state or not hmac.compare_digest(expected, state):
            raise MaimemoAuthError("墨墨授权状态校验失败")
        if values.get("error"):
            message = str(values.get("error_description", values["error"])[0] or values["error"][0])
            self.pending.save(dict(pending, error=message))
            raise MaimemoAuthError("墨墨授权未完成：%s" % message)
        code = str(values.get("code", [""])[0]).strip()
        if not code or len(code) > MAX_CALLBACK_VALUE:
            raise MaimemoAuthError("墨墨授权码无效")
        try:
            tokens = dict(self.post_form(self.token_url, {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.redirect_uri,
                "client_id": self.client_id,
                "code_verifier": str(pending.get("verifier") or ""),
            }))
            self._save_oauth_tokens(tokens)
            self.pending.clear()
            return self.status()
        except Exception as exc:
            self.pending.save(dict(pending, error=str(exc)))
            if isinstance(exc, MaimemoAuthError):
                raise
            raise MaimemoAuthError("墨墨令牌交换失败：%s" % exc) from exc

    def _save_oauth_tokens(self, tokens: Mapping[str, Any]) -> None:
        access_token = str(tokens.get("access_token") or "").strip()
        if not access_token:
            raise MaimemoAuthError("墨墨授权响应缺少 access_token")
        id_token = str(tokens.get("id_token") or "")
        claims = _jwt_claims(id_token)
        subject = str(claims.get("sub") or "").strip()
        if not subject:
            raise MaimemoAuthError("墨墨授权响应缺少稳定用户标识")
        now = self.now()
        try:
            expires_in = max(0, int(tokens.get("expires_in") or 0))
        except (TypeError, ValueError):
            expires_in = 0
        self.credentials.save({
            "version": 1,
            "mode": "oauth",
            "tokens": dict(tokens),
            "subject": subject,
            "display_name": str(claims.get("name") or claims.get("preferred_username") or ""),
            "expires_at": int(now + expires_in) if expires_in else 0,
            "updated_at": int(now),
        })

    def set_manual_token(self, token: str) -> dict[str, Any]:
        value = str(token or "").strip()
        if not value:
            raise MaimemoAuthError("请输入墨墨 API Token")
        if len(value) > 4096:
            raise MaimemoAuthError("墨墨 API Token 长度异常")
        self.credentials.save({"version": 1, "mode": "manual", "manual_token": value, "updated_at": int(self.now())})
        self.pending.clear()
        return self.status()

    def _refresh(self, data: Mapping[str, Any]) -> dict[str, Any]:
        tokens = data.get("tokens") if isinstance(data.get("tokens"), Mapping) else {}
        refresh_token = str(tokens.get("refresh_token") or "").strip()
        if not refresh_token:
            raise MaimemoAuthError("墨墨授权已过期，请重新连接")
        refreshed = dict(self.post_form(self.token_url, {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.client_id,
        }))
        if not refreshed.get("refresh_token"):
            refreshed["refresh_token"] = refresh_token
        if not refreshed.get("id_token") and tokens.get("id_token"):
            refreshed["id_token"] = tokens["id_token"]
        self._save_oauth_tokens(refreshed)
        return self._credential_data()

    def access_token(self) -> str:
        data = self._credential_data()
        mode = str(data.get("mode") or "")
        if mode == "manual":
            token = str(data.get("manual_token") or "").strip()
            if token:
                return token
        if mode != "oauth":
            raise MaimemoAuthError("请先连接墨墨账号")
        tokens = data.get("tokens") if isinstance(data.get("tokens"), Mapping) else {}
        token = str(tokens.get("access_token") or "").strip()
        if not token:
            raise MaimemoAuthError("请重新连接墨墨账号")
        expires_at = int(data.get("expires_at") or 0)
        claims_exp = int(_jwt_claims(token).get("exp") or 0)
        if claims_exp:
            expires_at = claims_exp
        if expires_at and self.now() >= expires_at - 300:
            data = self._refresh(data)
            tokens = data.get("tokens") if isinstance(data.get("tokens"), Mapping) else {}
            token = str(tokens.get("access_token") or "").strip()
        return token

    def profile_key(self) -> str:
        data = self._credential_data()
        return self._profile_key_from_data(data, require_access_token=True)

    def _profile_key_from_data(self, data: Mapping[str, Any], *, require_access_token: bool = False) -> str:
        if str(data.get("mode") or "") == "oauth":
            subject = self._subject(data)
            if subject:
                source = "maimemo-oidc:%s:%s" % (self.client_id, subject)
                return hashlib.sha256(source.encode("utf-8")).hexdigest()
        token = self.access_token() if require_access_token else str(data.get("manual_token") or "").strip()
        if not token:
            # OAuth 凭据在损坏或已被删除时不能隐式创建默认档案。
            raise MaimemoAuthError("请先连接墨墨账号")
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def disconnect(self) -> None:
        data = self._credential_data()
        tokens = data.get("tokens") if isinstance(data.get("tokens"), Mapping) else {}
        refresh_token = str(tokens.get("refresh_token") or "").strip()
        if refresh_token and self.configured:
            try:
                self.post_form(self.revocation_url, {"client_id": self.client_id, "token": refresh_token})
            except Exception:
                # 断开始终优先清理本机凭据；网络暂时失败不应留下可继续使用的 Token。
                pass
        self.credentials.clear()
        self.pending.clear()


__all__ = [
    "AUTHORIZE_URL", "CredentialStore", "DEFAULT_SCOPES", "DPAPIProtector", "ISSUER",
    "MAIMEMO_CLIENT_ID", "MaimemoAuthError", "MaimemoOAuth", "PUBLIC_SITE_BASE",
    "PUBLIC_SITE_ORIGIN", "REDIRECT_URI", "START_URI",
]
