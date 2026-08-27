#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local Live2D catalogue, model registry, and controlled asset delivery.

The application never ships character models.  Models are explicitly fetched
by the user into ``data/live2d/models`` or copied from a user-selected local
folder.  The service deliberately exposes only registered model files rather
than making the complete writable data directory web-accessible.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote
from urllib.request import Request, urlopen

import db


CATALOG_TTL_SECONDS = 24 * 60 * 60
MAX_MODEL_BYTES = 500 * 1024 * 1024
MAX_SINGLE_FILE_BYTES = 64 * 1024 * 1024
ASSETS_BASE = "https://bestdori.com/assets/jp"
ASSETS_INDEX = "https://bestdori.com/api/explorer/jp/assets/_info.json"
CHARACTERS_INDEX = "https://bestdori.com/api/characters/all.5.json"
_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,110}$")


class Live2DError(RuntimeError):
    pass


@dataclass
class DownloadJob:
    job_id: str
    model_name: str
    profile_id: str
    status: str = "queued"
    completed: int = 0
    total: int = 0
    error: str = ""
    model_id: str = ""
    cancel: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict[str, Any]:
        return {"job_id": self.job_id, "model_name": self.model_name, "status": self.status,
                "completed": self.completed, "total": self.total, "error": self.error,
                "model_id": self.model_id}


class Live2DService:
    def __init__(self, data_dir: str):
        self.data_dir = Path(data_dir).resolve()
        self.root = self.data_dir / "live2d"
        self.models_root = self.root / "models"
        self.partial_root = self.root / ".partial"
        self.cache_path = self.root / "catalog-cache.json"
        self.models_root.mkdir(parents=True, exist_ok=True)
        self.partial_root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._active_job: Optional[DownloadJob] = None
        self._jobs: dict[str, DownloadJob] = {}

    # ---------------- catalog ----------------
    @staticmethod
    def _fetch_json(url: str, timeout: int = 20) -> Any:
        request = Request(url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 MemoSuperform/0.73"})
        with urlopen(request, timeout=timeout) as response:  # nosec B310 -- fixed Bestdori hosts
            if response.status != 200:
                raise Live2DError("目录请求失败: HTTP %s" % response.status)
            return json.loads(response.read().decode("utf-8"))

    def _read_catalog_cache(self) -> Optional[dict[str, Any]]:
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            if time.time() - float(payload.get("fetched_at", 0)) < CATALOG_TTL_SECONDS:
                return payload
        except (OSError, ValueError, TypeError):
            pass
        return None

    @staticmethod
    def _character_map(raw: Any) -> dict[str, list[str]]:
        result: dict[str, list[str]] = {}
        items = raw.items() if isinstance(raw, dict) else enumerate(raw or [])
        for key, item in items:
            if not isinstance(item, dict):
                continue
            names = item.get("characterName") or item.get("character_name") or []
            if isinstance(names, str): names = [names]
            values = [str(value) for value in names if value]
            result[str(key).zfill(3)] = values or [str(key)]
        return result

    def _fetch_catalog(self) -> dict[str, Any]:
        assets, characters = self._fetch_json(ASSETS_INDEX), self._fetch_json(CHARACTERS_INDEX)
        try:
            entries = assets["live2d"]["chara"]
        except (KeyError, TypeError):
            raise Live2DError("Bestdori 目录未返回 Live2D 模型")
        names = self._character_map(characters)
        models = []
        for model_name in sorted(entries.keys() if isinstance(entries, dict) else []):
            match = re.match(r"^(\d{3})_", str(model_name))
            if not match:
                continue
            character_id = match.group(1)
            if str(model_name).endswith("_general"):
                continue
            aliases = names.get(character_id, ["角色 " + character_id])
            character_name = aliases[0]
            models.append({
                "catalog_name": str(model_name), "character_id": character_id,
                "character_name": character_name, "aliases": aliases,
                "display_name": character_name + " · " + str(model_name)[4:],
                "source": "bestdori-jp", "format": "cubism2",
            })
        payload = {"fetched_at": time.time(), "models": models}
        temp = self.cache_path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temp.replace(self.cache_path)
        return payload

    def catalog(self, query: str = "", refresh: bool = False) -> dict[str, Any]:
        payload = None if refresh else self._read_catalog_cache()
        if payload is None:
            payload = self._fetch_catalog()
        text = str(query or "").strip().lower()
        rows = payload.get("models") or []
        if text:
            rows = [item for item in rows if text in (item["display_name"] + " " + item["catalog_name"] + " " + " ".join(item.get("aliases") or [])).lower()]
        return {"models": rows, "count": len(rows), "cached_at": payload.get("fetched_at")}

    # ---------------- model descriptors ----------------
    @staticmethod
    def _safe_relative(value: str) -> str:
        text = str(value or "").replace("\\", "/").lstrip("/")
        if not text or "\x00" in text or any(part in ("", ".", "..") for part in text.split("/")):
            raise Live2DError("模型包含无效文件路径")
        return text

    @staticmethod
    def _bundle_file(value: Any, *, suffix: str = "") -> dict[str, str]:
        if not isinstance(value, dict):
            return {"bundle": "", "file": ""}
        name = str(value.get("fileName") or value.get("filename") or "").removesuffix(".bytes")
        if suffix and name and "." not in Path(name).name:
            name += suffix
        return {"bundle": str(value.get("bundleName") or value.get("bundlename") or ""), "file": name}

    def _bestdori_build_data(self, catalog_name: str) -> dict[str, Any]:
        url = "%s/live2d/chara/%s_rip/buildData.asset" % (ASSETS_BASE, quote(catalog_name))
        raw = self._fetch_json(url)
        base = raw.get("Base") if isinstance(raw, dict) else None
        if not isinstance(base, dict):
            raise Live2DError("模型构建数据不完整")
        model = self._bundle_file(base.get("model"))
        if not model["bundle"] or not model["file"]:
            raise Live2DError("模型缺少主文件")
        return {
            "model": model, "physics": self._bundle_file(base.get("physics")),
            "textures": [self._bundle_file(item, suffix=".png") for item in base.get("textures", [])],
            "motions": [self._bundle_file(item) for item in base.get("motions", [])],
            "expressions": [self._bundle_file(item) for item in base.get("expressions", [])],
        }

    def _download_file(self, bundle: str, file_name: str, target: Path, job: DownloadJob, optional: bool = False) -> bool:
        bundle, file_name = self._safe_relative(bundle), self._safe_relative(file_name)
        url = "%s/%s_rip/%s" % (ASSETS_BASE, quote(bundle), quote(file_name))
        request = Request(url, headers={"User-Agent": "MemoSuperform/0.73"})
        try:
            with urlopen(request, timeout=30) as response:  # nosec B310 -- fixed Bestdori path
                if response.status != 200:
                    raise Live2DError("HTTP %s" % response.status)
                length = int(response.headers.get("Content-Length") or 0)
                if length > MAX_SINGLE_FILE_BYTES:
                    raise Live2DError("单个模型文件过大")
                target.parent.mkdir(parents=True, exist_ok=True)
                total, tmp = 0, target.with_suffix(target.suffix + ".tmp")
                with open(tmp, "wb") as out:
                    while True:
                        if job.cancel.is_set():
                            raise Live2DError("下载已取消")
                        chunk = response.read(64 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_SINGLE_FILE_BYTES:
                            raise Live2DError("单个模型文件过大")
                        out.write(chunk)
                tmp.replace(target)
                job.completed += 1
                return True
        except Exception as exc:
            try:
                target.with_suffix(target.suffix + ".tmp").unlink(missing_ok=True)
            except OSError:
                pass
            if optional and "HTTP Error 404" in str(exc):
                return False
            if isinstance(exc, Live2DError):
                raise
            raise Live2DError("下载模型资源失败: %s" % exc)

    @staticmethod
    def _model_json(build: dict[str, Any]) -> dict[str, Any]:
        motions = {}
        for item in build["motions"]:
            if item["file"]:
                motions[Path(item["file"]).stem] = [{"file": "data/motions/" + item["file"]}]
        expressions = [{"name": Path(item["file"]).stem, "file": "data/expressions/" + item["file"]}
                       for item in build["expressions"] if item["file"]]
        result = {"version": "Memo Superform C2", "model": "data/model.moc",
                  "textures": ["data/textures/" + item["file"] for item in build["textures"] if item["file"]],
                  "motions": motions, "expressions": expressions}
        if build["physics"].get("file"):
            result["physics"] = "data/physics.json"
        return result

    @staticmethod
    def _directory_size(root: Path) -> int:
        return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())

    def _validate_entry(self, root: Path, entry_file: str, model_format: str) -> list[str]:
        """Validate all descriptor paths before a model becomes selectable."""
        entry = root / entry_file
        try:
            raw = json.loads(entry.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise Live2DError("模型描述文件无效: %s" % exc)
        refs: list[str] = []
        if model_format == "cubism3":
            files = raw.get("FileReferences") if isinstance(raw, dict) else None
            if not isinstance(files, dict):
                raise Live2DError("Cubism 3/4 模型缺少 FileReferences")
            refs.append(str(files.get("Moc") or ""))
            refs.extend(str(value) for value in files.get("Textures") or [])
            for key in ("Physics", "Pose", "DisplayInfo", "UserData"):
                if files.get(key): refs.append(str(files[key]))
            for item in files.get("Expressions") or []:
                if isinstance(item, dict) and item.get("File"): refs.append(str(item["File"]))
            for group in (files.get("Motions") or {}).values():
                for item in group or []:
                    if isinstance(item, dict) and item.get("File"): refs.append(str(item["File"]))
        else:
            refs.append(str(raw.get("model") or raw.get("Model") or ""))
            refs.extend(str(value) for value in (raw.get("textures") or raw.get("Textures") or []))
            for key in ("physics", "Physics", "pose"):
                if raw.get(key): refs.append(str(raw[key]))
            motions = raw.get("motions") or raw.get("Motions") or {}
            if isinstance(motions, dict):
                for group in motions.values():
                    for item in group or []:
                        if isinstance(item, dict) and item.get("file"): refs.append(str(item["file"]))
            for item in raw.get("expressions") or raw.get("Expressions") or []:
                if isinstance(item, dict) and item.get("file"): refs.append(str(item["file"]))
        refs = [self._safe_relative(value) for value in refs if value]
        if len(refs) < 2:
            raise Live2DError("模型缺少主文件或贴图")
        for relative in refs:
            target = (root / relative).resolve()
            if root not in target.parents or not target.is_file():
                raise Live2DError("模型引用文件不存在: " + relative)
        return refs

    def _register(self, root: Path, *, model_id: str, source: str, character_id: str,
                  display_name: str, catalog_name: str, entry_file: str, model_format: str) -> dict[str, Any]:
        entry_file = self._safe_relative(entry_file)
        if not (root / entry_file).is_file():
            raise Live2DError("模型入口文件不存在")
        self._validate_entry(root, entry_file, model_format)
        byte_size = self._directory_size(root)
        if byte_size <= 0 or byte_size > MAX_MODEL_BYTES:
            raise Live2DError("模型大小不在允许范围内")
        manifest = {"id": model_id, "format": model_format, "entry": entry_file,
                    "asset_base": "/api/live2d/assets/%s/" % model_id}
        (root / "memo-live2d.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        db.upsert_live2d_model({"model_id": model_id, "source": source, "character_id": character_id,
                                "display_name": display_name, "catalog_name": catalog_name,
                                "model_format": model_format, "relative_path": model_id,
                                "entry_file": entry_file, "manifest": manifest, "byte_size": byte_size,
                                "complete": True})
        return db.get_live2d_model(model_id) or {}

    def _download_job(self, job: DownloadJob, item: dict[str, Any]) -> None:
        stage = self.partial_root / job.job_id
        try:
            job.status = "fetching"
            build = self._bestdori_build_data(item["catalog_name"])
            resources: list[tuple[dict[str, str], Path, bool]] = [
                (build["model"], stage / "data" / "model.moc", False),
                (build["physics"], stage / "data" / "physics.json", True),
            ]
            resources += [(part, stage / "data" / "textures" / part["file"], False) for part in build["textures"] if part["file"]]
            resources += [(part, stage / "data" / "motions" / part["file"], False) for part in build["motions"] if part["file"]]
            resources += [(part, stage / "data" / "expressions" / part["file"], False) for part in build["expressions"] if part["file"]]
            resources = [entry for entry in resources if entry[0].get("bundle") and entry[0].get("file")]
            job.total = len(resources)
            for part, target, optional in resources:
                self._download_file(part["bundle"], part["file"], target, job, optional)
            if job.cancel.is_set():
                raise Live2DError("下载已取消")
            descriptor = "memo.model.json"
            (stage / descriptor).write_text(json.dumps(self._model_json(build), ensure_ascii=False, indent=2), encoding="utf-8")
            digest = hashlib.sha256(item["catalog_name"].encode("utf-8")).hexdigest()[:12]
            model_id = "bestdori-" + re.sub(r"[^a-z0-9_-]+", "-", item["catalog_name"].lower())[:80] + "-" + digest
            final = self.models_root / model_id
            if final.exists():
                shutil.rmtree(final)
            stage.replace(final)
            self._register(final, model_id=model_id, source="bestdori-jp", character_id=item["character_id"],
                           display_name=item["display_name"], catalog_name=item["catalog_name"],
                           entry_file=descriptor, model_format="cubism2")
            job.model_id, job.status = model_id, "completed"
        except Exception as exc:
            job.status, job.error = ("cancelled" if job.cancel.is_set() else "failed"), str(exc)
            shutil.rmtree(stage, ignore_errors=True)
        finally:
            with self._lock:
                self._active_job = None

    def start_download(self, catalog_name: str, profile_id: str) -> dict[str, Any]:
        catalog = self.catalog().get("models", [])
        item = next((row for row in catalog if row["catalog_name"] == str(catalog_name)), None)
        if not item:
            raise Live2DError("未找到所选模型")
        with self._lock:
            if self._active_job and self._active_job.status in {"queued", "fetching"}:
                return self._active_job.snapshot()
            job = DownloadJob(uuid.uuid4().hex, str(catalog_name), str(profile_id))
            self._active_job = job
            self._jobs[job.job_id] = job
            # Keep a small terminal history so polling clients cannot miss a
            # fast completion between two status requests.
            if len(self._jobs) > 24:
                for key, prior in list(self._jobs.items()):
                    if prior.status not in {"queued", "fetching"} and key != job.job_id:
                        self._jobs.pop(key, None)
                        if len(self._jobs) <= 24:
                            break
            threading.Thread(target=self._download_job, args=(job, item), name="memo-live2d-download", daemon=True).start()
            return job.snapshot()

    def download_status(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            if str(job_id) in self._jobs:
                return self._jobs[str(job_id)].snapshot()
        return {"job_id": str(job_id), "status": "unknown"}

    def cancel_download(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._jobs.get(str(job_id))
            if job and job.status in {"queued", "fetching"}:
                job.cancel.set()
                return {"ok": True, **job.snapshot()}
        return {"ok": False, "status": "unknown"}

    # ---------------- imported models / serving ----------------
    def import_directory(self, source_path: str, profile_id: str) -> dict[str, Any]:
        source = Path(str(source_path or "")).expanduser().resolve()
        if not source.is_dir():
            raise Live2DError("请选择存在的模型文件夹")
        candidates = sorted(list(source.glob("*.model3.json")) + list(source.glob("*.model.json")) + list(source.glob("model.json")))
        if not candidates:
            raise Live2DError("未找到 .model3.json、.model.json 或 model.json")
        entry = candidates[0]
        model_format = "cubism3" if entry.name.endswith(".model3.json") else "cubism2"
        raw = entry.read_text(encoding="utf-8")
        try:
            json.loads(raw)
        except json.JSONDecodeError as exc:
            raise Live2DError("模型描述文件无效: %s" % exc)
        digest = hashlib.sha256((str(source) + str(entry.stat().st_mtime_ns)).encode("utf-8")).hexdigest()[:12]
        model_id = "import-" + re.sub(r"[^a-z0-9_-]+", "-", source.name.lower())[:72] + "-" + digest
        stage, final = self.partial_root / ("import-" + uuid.uuid4().hex), self.models_root / model_id
        try:
            shutil.copytree(source, stage, ignore=shutil.ignore_patterns("*.tmp", "__pycache__"))
            if self._directory_size(stage) > MAX_MODEL_BYTES:
                raise Live2DError("导入模型超过 500 MB")
            if final.exists():
                shutil.rmtree(final)
            stage.replace(final)
            relative_entry = entry.relative_to(source).as_posix()
            return self._register(final, model_id=model_id, source="import", character_id="",
                                  display_name=source.name, catalog_name="", entry_file=relative_entry,
                                  model_format=model_format)
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise

    def list_models(self, profile_id: str) -> dict[str, Any]:
        preference = db.get_live2d_preference(profile_id)
        return {"models": db.list_live2d_models(), "preference": preference}

    def set_active(self, profile_id: str, model_id: Optional[str], companion_enabled: Optional[bool] = None) -> dict[str, Any]:
        if model_id:
            model = db.get_live2d_model(model_id)
            if not model or not model.get("complete") or not (self.models_root / model["relative_path"] / model["entry_file"]).is_file():
                raise Live2DError("所选模型不可用")
        return db.set_live2d_preference(profile_id, active_model_id=model_id, companion_enabled=companion_enabled)

    def delete_model(self, model_id: str) -> bool:
        model = db.get_live2d_model(model_id)
        if not model:
            return False
        target = (self.models_root / str(model["relative_path"])).resolve()
        if self.models_root not in target.parents:
            raise Live2DError("模型路径无效")
        shutil.rmtree(target, ignore_errors=True)
        return db.remove_live2d_model(model_id)

    def asset_path(self, model_id: str, relative_path: str) -> Path:
        if not _SAFE_ID.match(str(model_id)):
            raise Live2DError("模型标识无效")
        model = db.get_live2d_model(model_id)
        if not model or not model.get("complete"):
            raise Live2DError("模型不存在")
        relative = self._safe_relative(relative_path)
        root = (self.models_root / str(model["relative_path"])).resolve()
        target = (root / relative).resolve()
        if root not in target.parents or not target.is_file():
            raise Live2DError("模型资源不存在")
        return target

    def asset_content_type(self, path: Path) -> str:
        suffix = path.suffix.lower()
        if suffix in {".moc", ".moc3", ".mtn"}:
            return "application/octet-stream"
        if suffix in {".json", ".model", ".asset"}:
            return "application/json; charset=utf-8"
        return mimetypes.guess_type(str(path))[0] or "application/octet-stream"
