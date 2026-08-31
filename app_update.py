# -*- coding: utf-8 -*-
"""GitHub Release 更新检查、下载和安装前完整性校验。

本模块刻意不直接替换正在运行的 EXE。Windows 下文件会被当前进程锁定，真正的
替换工作由 launcher.py 在主进程退出后交给一个隐藏的临时 PowerShell 进程完成。
这里仅允许从本项目的 GitHub Release 读取元数据和已校验的 EXE 资产。
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from build_info import BUILD_VERSION, GITHUB_REPOSITORY


_VERSION_RE = re.compile(r"^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?\s*$")
_DIGEST_RE = re.compile(r"^sha256:([0-9a-fA-F]{64})$")
_ASSET_NAME_RE = re.compile(r"^MemoSuperform-v\d+(?:\.\d+){1,2}\.exe$")
_MAX_UPDATE_BYTES = 2 * 1024 * 1024 * 1024
_DOWNLOAD_CHUNK_BYTES = 256 * 1024


class UpdateError(RuntimeError):
    """可直接显示给本地设置页的更新错误。"""


def parse_version(value):
    """把 v0.78 / 1.0 / 1.0.1 解析为可比较的三元整数版本号。"""
    match = _VERSION_RE.match(str(value or ""))
    if not match:
        return None
    return tuple(int(item or 0) for item in match.groups())


def compare_versions(left, right):
    """比较两个版本；返回 -1/0/1，格式不正确时抛出 ValueError。"""
    left_value = parse_version(left)
    right_value = parse_version(right)
    if left_value is None or right_value is None:
        raise ValueError("版本号格式无效")
    return (left_value > right_value) - (left_value < right_value)


def is_important_update(current, latest):
    """跨主版本，或同一主版本连续落后三个以上小版本时标记为重要更新。"""
    current_value = parse_version(current)
    latest_value = parse_version(latest)
    if current_value is None or latest_value is None or latest_value <= current_value:
        return False
    if latest_value[0] > current_value[0]:
        return True
    return latest_value[1] - current_value[1] >= 3


class UpdateManager:
    """本地 EXE 的单一更新状态机。

    每个应用进程首次查询都会访问 GitHub；网络暂时不可用时才回退到本地缓存。下载
    在后台线程进行，状态通过 ``status`` 暴露给前端轮询，避免长下载阻塞 HTTP 请求。
    """

    def __init__(self, data_dir, current_version=BUILD_VERSION, repository=GITHUB_REPOSITORY,
                 frozen=None, platform=None, executable=None, urlopen=None, clock=None):
        self.data_dir = Path(data_dir).resolve()
        self.update_dir = self.data_dir / "updates"
        self.current_version = str(current_version)
        self.repository = str(repository).strip("/")
        self.frozen = bool(getattr(sys, "frozen", False) if frozen is None else frozen)
        self.platform = sys.platform if platform is None else str(platform)
        self.executable = os.path.abspath(executable or sys.executable)
        self.urlopen = urlopen or urllib.request.urlopen
        self.clock = clock or time.time
        self._lock = threading.RLock()
        self._checked_this_process = False
        self._last_release = None
        self._last_status = None
        self._staged = None
        self._download_state = {
            "state": "idle",
            "progress": 0,
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "message": "",
            "version": "",
        }

    @property
    def release_api_url(self):
        return "https://api.github.com/repos/%s/releases/latest" % self.repository

    @property
    def cache_path(self):
        return self.update_dir / "latest-release.json"

    def _ensure_update_dir(self):
        self.update_dir.mkdir(parents=True, exist_ok=True)

    def _release_page_url(self, tag):
        return "https://github.com/%s/releases/tag/%s" % (self.repository, tag)

    def _is_expected_release_url(self, value, tag):
        parsed = urlparse(str(value or ""))
        return (
            parsed.scheme == "https"
            and parsed.netloc.lower() == "github.com"
            and parsed.path == "/%s/releases/tag/%s" % (self.repository, tag)
        )

    def _is_expected_asset_url(self, value):
        parsed = urlparse(str(value or ""))
        return (
            parsed.scheme == "https"
            and parsed.netloc.lower() == "github.com"
            and parsed.path.startswith("/%s/releases/download/" % self.repository)
        )

    @staticmethod
    def _safe_notes(value):
        # Release note 可以很长；本地状态缓存和首屏弹窗只保留适合阅读的一段。
        text = str(value or "").replace("\x00", "").strip()
        return text[:12000]

    def _normalise_release(self, payload):
        if not isinstance(payload, dict):
            raise UpdateError("GitHub 返回的更新信息格式不正确")
        if payload.get("draft") or payload.get("prerelease"):
            raise UpdateError("GitHub 返回的不是稳定版 Release")
        tag = str(payload.get("tag_name") or "").strip()
        if parse_version(tag) is None:
            raise UpdateError("GitHub Release 的版本号格式不正确")
        version = tag[1:] if tag.lower().startswith("v") else tag
        release_url = str(payload.get("html_url") or "")
        if not self._is_expected_release_url(release_url, tag):
            release_url = self._release_page_url(tag)

        asset = None
        for item in payload.get("assets") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            url = str(item.get("browser_download_url") or "")
            if not _ASSET_NAME_RE.fullmatch(name) or not self._is_expected_asset_url(url):
                continue
            # 每个版本的发布脚本只上传唯一 EXE；名称须与当前 tag 对应，防止误拿
            # Release 中附带的旧二进制文件。
            if name != "MemoSuperform-v%s.exe" % version:
                continue
            try:
                size = int(item.get("size") or 0)
            except (TypeError, ValueError):
                size = 0
            digest_match = _DIGEST_RE.fullmatch(str(item.get("digest") or ""))
            asset = {
                "name": name,
                "size": size,
                "download_url": url,
                "sha256": digest_match.group(1).lower() if digest_match else "",
            }
            break

        return {
            "tag": tag,
            "version": version,
            "published_at": str(payload.get("published_at") or ""),
            "release_url": release_url,
            "notes": self._safe_notes(payload.get("body")),
            "asset": asset,
        }

    def _load_cached_release(self):
        try:
            with self.cache_path.open("r", encoding="utf-8") as handle:
                cached = json.load(handle)
            if not isinstance(cached, dict):
                return None
            release = cached.get("release")
            # 再次规范化，避免损坏或手工修改后的缓存绕过 URL/资产约束。
            if not isinstance(release, dict):
                return None
            tag = str(release.get("tag") or "")
            version = str(release.get("version") or "")
            if parse_version(tag) is None or parse_version(version) is None:
                return None
            release_url = str(release.get("release_url") or "")
            if not self._is_expected_release_url(release_url, tag):
                return None
            asset = release.get("asset")
            if asset is not None:
                if not isinstance(asset, dict):
                    return None
                name = str(asset.get("name") or "")
                url = str(asset.get("download_url") or "")
                sha256 = str(asset.get("sha256") or "")
                try:
                    size = int(asset.get("size") or 0)
                except (TypeError, ValueError):
                    return None
                if (
                    name != "MemoSuperform-v%s.exe" % version
                    or not _ASSET_NAME_RE.fullmatch(name)
                    or not self._is_expected_asset_url(url)
                    or (sha256 and not re.fullmatch(r"[0-9a-f]{64}", sha256))
                ):
                    return None
            return {
                "tag": tag,
                "version": version,
                "published_at": str(release.get("published_at") or ""),
                "release_url": release_url,
                "notes": self._safe_notes(release.get("notes")),
                "asset": asset,
            }
        except (OSError, ValueError, TypeError):
            return None

    def _write_cached_release(self, release):
        try:
            self._ensure_update_dir()
            temporary = self.cache_path.with_suffix(".tmp")
            payload = {"fetched_at": int(self.clock()), "release": release}
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
            os.replace(str(temporary), str(self.cache_path))
        except OSError:
            # 缓存只是离线兜底，目录不可写时不影响本次在线检查。
            pass

    def _fetch_latest_release(self):
        request = urllib.request.Request(
            self.release_api_url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "MemoSuperform/%s" % self.current_version,
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with self.urlopen(request, timeout=12) as response:
                raw = response.read()
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            raise UpdateError("暂时无法连接 GitHub 更新服务") from exc
        try:
            return self._normalise_release(json.loads(raw.decode("utf-8")))
        except (UnicodeDecodeError, ValueError, TypeError) as exc:
            raise UpdateError("GitHub 返回的更新信息无法读取") from exc

    def _target_is_writable(self):
        if not (self.frozen and self.platform == "win32"):
            return False
        target = Path(self.executable)
        # 当前 EXE 必须存在；目录可写的判断只是预检，真正替换时仍由更新器记录失败。
        return target.is_file() and os.access(str(target.parent), os.W_OK)

    def _download_public(self):
        result = dict(self._download_state)
        if self._staged and result.get("state") == "ready":
            result["ready_to_install"] = True
        return result

    def _build_status(self, release, cached=False, check_error=""):
        current_ok = parse_version(self.current_version) is not None
        latest = str(release.get("version") or "") if release else ""
        available = bool(current_ok and latest and compare_versions(self.current_version, latest) < 0)
        asset = release.get("asset") if release else None
        asset_size = int(asset.get("size") or 0) if isinstance(asset, dict) else 0
        asset_sha256 = str(asset.get("sha256") or "") if isinstance(asset, dict) else ""
        asset_ok = bool(
            isinstance(asset, dict)
            and 0 < asset_size <= _MAX_UPDATE_BYTES
            and re.fullmatch(r"[0-9a-f]{64}", asset_sha256)
        )
        install_supported = self._target_is_writable()
        can_download = bool(available and asset_ok and install_supported)
        if not current_ok:
            message = "当前应用版本格式不正确，无法检查自动更新"
        elif not release:
            message = check_error or "暂时无法检查更新"
        elif not available:
            message = "已是最新版本"
        elif not install_supported:
            message = "当前运行环境不支持原地安装，请前往发布页下载"
        elif not asset:
            message = "该 Release 未提供可用的 Windows EXE，请前往发布页下载"
        elif not asset_ok:
            message = "该 Release 缺少可验证的 SHA-256 或文件大小，已禁用自动安装"
        else:
            message = "发现可用更新"

        return {
            "current_version": self.current_version,
            "latest_version": latest or self.current_version,
            "update_available": available,
            "important": bool(available and is_important_update(self.current_version, latest)),
            "release_url": str(release.get("release_url") or "") if release else "",
            "release_notes": self._safe_notes(release.get("notes")) if release else "",
            "published_at": str(release.get("published_at") or "") if release else "",
            "is_frozen": self.frozen,
            "install_supported": install_supported,
            "can_download": can_download,
            "cached": bool(cached),
            "check_error": check_error,
            "message": message,
            "download": self._download_public(),
        }

    def get_status(self, force=False):
        """查询最新 Release；每次启动首次调用会联网，失败时使用本地缓存。"""
        with self._lock:
            if self._checked_this_process and not force and self._last_status is not None:
                result = copy.deepcopy(self._last_status)
                result["download"] = self._download_public()
                return result
            self._checked_this_process = True
            check_error = ""
            cached = False
            try:
                release = self._fetch_latest_release()
                self._write_cached_release(release)
            except UpdateError as exc:
                check_error = str(exc)
                release = self._load_cached_release()
                cached = release is not None
            if self._staged and (
                not release or self._staged.get("version") != release.get("version")
            ):
                # 手动检查期间发布了更高版本时，旧候选不可继续被安装。
                self._staged = None
                self._download_state = {
                    "state": "idle",
                    "progress": 0,
                    "downloaded_bytes": 0,
                    "total_bytes": 0,
                    "message": "发现新的 Release，请重新下载更新文件",
                    "version": "",
                }
            self._last_release = release
            self._last_status = self._build_status(release, cached=cached, check_error=check_error)
            return copy.deepcopy(self._last_status)

    def _set_download_state(self, **values):
        with self._lock:
            self._download_state.update(values)

    def start_download(self):
        """异步下载当前最新资产；客户端只获得进度，不可指定 URL 或本地路径。"""
        with self._lock:
            status = self.get_status()
            current_state = self._download_state.get("state")
            if current_state in ("downloading", "applying"):
                return self._download_public()
            if current_state == "ready" and self._staged:
                return self._download_public()
            if not status.get("can_download"):
                raise UpdateError(status.get("message") or "当前更新不可自动安装")
            release = self._last_release
            asset = release.get("asset") if release else None
            if not isinstance(asset, dict):
                raise UpdateError("未找到可下载的更新文件")
            self._staged = None
            self._download_state = {
                "state": "downloading",
                "progress": 0,
                "downloaded_bytes": 0,
                "total_bytes": int(asset["size"]),
                "message": "正在下载更新…",
                "version": release["version"],
            }
            worker = threading.Thread(
                target=self._download_worker,
                args=(copy.deepcopy(release),),
                name="memo-update-download",
                daemon=True,
            )
            worker.start()
            return self._download_public()

    def _download_worker(self, release):
        asset = release["asset"]
        expected_size = int(asset["size"])
        expected_sha256 = str(asset["sha256"]).lower()
        asset_name = str(asset["name"])
        part_path = None
        try:
            if not (0 < expected_size <= _MAX_UPDATE_BYTES):
                raise UpdateError("更新文件大小异常")
            if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
                raise UpdateError("更新文件缺少 SHA-256 校验值")
            if not self._is_expected_asset_url(asset.get("download_url")):
                raise UpdateError("更新下载地址校验失败")
            self._ensure_update_dir()
            final_path = self.update_dir / asset_name
            part_path = self.update_dir / (asset_name + ".part")
            try:
                part_path.unlink()
            except FileNotFoundError:
                pass
            digest = hashlib.sha256()
            received = 0
            request = urllib.request.Request(
                asset["download_url"],
                headers={"Accept": "application/octet-stream", "User-Agent": "MemoSuperform/%s" % self.current_version},
            )
            with self.urlopen(request, timeout=30) as response, part_path.open("wb") as handle:
                while True:
                    chunk = response.read(_DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > expected_size or received > _MAX_UPDATE_BYTES:
                        raise UpdateError("更新文件大小超过发布清单")
                    handle.write(chunk)
                    digest.update(chunk)
                    self._set_download_state(
                        state="downloading",
                        downloaded_bytes=received,
                        total_bytes=expected_size,
                        progress=min(99, int(received * 100 / expected_size)),
                        message="正在下载更新…",
                    )
            actual_sha256 = digest.hexdigest().lower()
            if received != expected_size:
                raise UpdateError("更新文件大小与发布清单不一致")
            if not hmac.compare_digest(actual_sha256, expected_sha256):
                raise UpdateError("更新文件 SHA-256 校验失败")
            os.replace(str(part_path), str(final_path))
            with self._lock:
                self._staged = {
                    "path": str(final_path),
                    "sha256": expected_sha256,
                    "size": expected_size,
                    "version": release["version"],
                    "asset_name": asset_name,
                }
                self._download_state = {
                    "state": "ready",
                    "progress": 100,
                    "downloaded_bytes": received,
                    "total_bytes": expected_size,
                    "message": "下载完成，已通过 SHA-256 校验",
                    "version": release["version"],
                }
        except Exception as exc:
            if part_path is not None:
                try:
                    part_path.unlink()
                except OSError:
                    pass
            message = str(exc) if isinstance(exc, UpdateError) else "下载更新失败，请稍后重试"
            self._set_download_state(
                state="error",
                progress=0,
                message=message,
            )

    def prepare_apply(self):
        """在交给 launcher 前再次核对已下载的 EXE，返回仅供本地回调用的路径信息。"""
        with self._lock:
            if not self._target_is_writable():
                raise UpdateError("当前安装目录不可写，无法自动安装更新")
            if not self._staged or self._download_state.get("state") != "ready":
                raise UpdateError("请先下载并校验更新文件")
            staged = dict(self._staged)
            path = Path(staged["path"])
            try:
                if path.stat().st_size != int(staged["size"]):
                    raise UpdateError("已下载的更新文件大小发生变化")
                digest = hashlib.sha256()
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(_DOWNLOAD_CHUNK_BYTES), b""):
                        digest.update(chunk)
                if not hmac.compare_digest(digest.hexdigest().lower(), staged["sha256"]):
                    raise UpdateError("已下载的更新文件校验失败")
            except OSError as exc:
                raise UpdateError("已下载的更新文件不可读取") from exc
            self._download_state.update(state="applying", message="正在交给更新器安装…")
            return staged

    def apply_failed(self, message):
        with self._lock:
            if self._staged:
                self._download_state.update(state="ready", message=str(message or "更新器启动失败"))
