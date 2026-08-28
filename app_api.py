# -*- coding: utf-8 -*-
"""Local Memo Superform API handlers, separated from proxy transport."""
import json
import os
import sys
import traceback
import threading
from urllib.parse import parse_qs

import study_sync


_legacy_attempted = set()
_legacy_lock = threading.Lock()
# Role manifests and the Live2D preference are stored by different services.
# Serialize their coupled changes in the HTTP process so two rapid activate/
# edit requests cannot commit TTS role A with renderer preference B.
_role_live2d_lock = threading.RLock()


def configure_local_api(**values):
    globals().update(values)


class LocalApiMixin:
    def _memo_token(self, required=True):
        auth = (self.headers.get("Authorization") or "").strip()
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
            if token:
                return token
        if required:
            self._send_json(401, {"error": "请先配置墨墨 API Token"})
        return None

    def _profile_id(self, required=False):
        token = self._memo_token(required=required)
        return study_sync.token_profile_id(token) if token else None

    def _active_role_live2d_binding(self, live2d):
        """Expose the active role as the only Live2D runtime source.

        ``live2d_preferences.active_model_id`` predates role packages and can
        still contain a stale manually selected model.  Keep it as a storage
        detail for compatibility, but never let it override the enabled role
        while rendering the companion.
        """
        result = {
            "enforced": True,
            "ready": False,
            "active_role_id": "",
            "active_role_name": "",
            "configured_model_id": "",
            "active_model_id": None,
            "model_character_id": "",
            "persona": {},
            "reason": "尚未启用资料完整的角色",
        }
        try:
            import tts
            library = tts.list_roles(TTS_PACK_DIR)
            role_id = str(library.get("active_role_id") or "")
            result["active_role_id"] = role_id
            role = next((item for item in library.get("roles") or [] if item.get("role_id") == role_id), None)
            if not role:
                return result
            result["active_role_name"] = str(role.get("name") or role_id)
            result["configured_model_id"] = str(role.get("live2d_model_id") or "")
            result["persona"] = role.get("persona") if isinstance(role.get("persona"), dict) else {}
            if not role.get("complete"):
                missing = "、".join(role.get("missing") or [])
                result["reason"] = "当前角色资料未配齐" + ("：" + missing if missing else "")
                return result
            if not result["configured_model_id"]:
                result["reason"] = "当前角色未绑定 Live2D 模型"
                return result
            model = live2d.validate_model(result["configured_model_id"])
            result.update({
                "ready": True,
                "active_model_id": result["configured_model_id"],
                "model_character_id": str(model.get("character_id") or ""),
                "reason": "",
            })
        except Exception as exc:
            result["reason"] = "角色绑定的 Live2D 模型不可用：%s" % exc
        return result

    def _start_legacy_import_once(self, profile_id):
        if not profile_id or not DB_READY:
            return
        with _legacy_lock:
            if profile_id in _legacy_attempted:
                return
            _legacy_attempted.add(profile_id)
        threading.Thread(target=db.try_import_legacy_sqlserver, args=(profile_id,),
                         name="memo-legacy-readonly-import", daemon=True).start()

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
            status = tts.get_status(TTS_PACK_DIR, DATA_DIR)
            live2d = globals().get("LIVE2D_SERVICE")
            if live2d and status.get("active_role_id"):
                binding = self._active_role_live2d_binding(live2d)
                status["live2d_role_ready"] = bool(binding.get("ready"))
                if not binding.get("ready"):
                    status["role_ready"] = False
                    status["role_error"] = binding.get("reason") or "当前角色绑定的 Live2D 模型不可用"
            return self._send_json(200, status)

        if path == "/api/tts/roles":
            import tts
            library = tts.list_roles(TTS_PACK_DIR)
            live2d = globals().get("LIVE2D_SERVICE")
            if live2d:
                for role in library.get("roles") or []:
                    model_id = str(role.get("live2d_model_id") or "")
                    if not model_id:
                        continue
                    try:
                        model = live2d.validate_model(model_id)
                        # This read-only annotation lets the browser migrate
                        # legacy character-id personas into distinct role
                        # manifests without letting a Live2D model define the
                        # active persona at runtime.
                        role["live2d_character_id"] = str(model.get("character_id") or "")
                    except Exception:
                        missing = list(role.get("missing") or [])
                        if "Live2D 模型（不可用）" not in missing:
                            missing.append("Live2D 模型（不可用）")
                        role["missing"] = missing
                        role["complete"] = False
            return self._send_json(200, library)

        if path == "/api/codex/status":
            return self._send_json(200, CODEX_OAUTH.status())

        live2d = globals().get("LIVE2D_SERVICE")
        if path.startswith("/api/live2d/assets/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            parts = path.split("/")
            if len(parts) < 6:
                return self._send_json(404, {"error": "模型资源不存在"})
            try:
                asset = live2d.asset_path(parts[4], "/".join(parts[5:]))
                self.send_response(200)
                self.send_header("Content-Type", live2d.asset_content_type(asset))
                self.send_header("Content-Length", str(asset.stat().st_size))
                self.send_header("Cache-Control", "private, max-age=3600")
                self.end_headers()
                with open(asset, "rb") as handle:
                    while chunk := handle.read(64 * 1024):
                        self.wfile.write(chunk)
                return
            except Exception as exc:
                return self._send_json(404, {"error": str(exc)})

        if path == "/api/live2d/catalog":
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            query = parse_qs(parsed.query)
            try:
                return self._send_json(200, live2d.catalog(query.get("q", [""])[0], query.get("refresh", ["0"])[0] == "1"))
            except Exception as exc:
                return self._send_json(502, {"error": str(exc)})

        if path == "/api/live2d/models":
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            data = live2d.list_models(self._profile_id(required=False))
            data["role_binding"] = self._active_role_live2d_binding(live2d)
            return self._send_json(200, data)

        if path.startswith("/api/live2d/downloads/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            return self._send_json(200, live2d.download_status(path.rsplit("/", 1)[-1]))

        known_db_paths = {
            "/api/recommendations/today",
            "/api/stats/history",
            "/api/db/status",
            "/api/study-records",
            "/api/study-sync/status",
        }
        if path not in known_db_paths:
            return self._send_json(404, {"error": "未知接口"})

        # 参数错误和状态查询不应被可选数据库的离线状态掩盖。
        if path == "/api/stats/history":
            raw = parse_qs(parsed.query).get("days", ["30"])[0]
            try:
                days = int(raw)
            except (ValueError, TypeError):
                return self._send_json(400, {"error": "days must be an integer"})
            if not (1 <= days <= 3650):
                return self._send_json(400, {"error": "days out of range (1-3650)"})

        if path == "/api/db/status" and not DB_READY:
            return self._send_json(200, {
                "db_ready": False,
                "has_snapshot": False,
                "has_recommendations": False,
            })

        if not DB_READY:
            return self._send_json(503, {"error": "数据库未就绪"})
        try:
            if path == "/api/study-records":
                profile_id = self._profile_id(required=True)
                if not profile_id:
                    return
                records = db.get_records(profile_id)
                state = db.get_sync_state(profile_id)
                return self._send_json(200, {"records": records, "count": len(records), "sync": state})

            if path == "/api/study-sync/status":
                token = self._memo_token(required=True)
                if not token:
                    return
                profile_id = study_sync.token_profile_id(token)
                persistent = db.get_sync_state(profile_id)
                live = STUDY_SYNC_MANAGER.status(token) if STUDY_SYNC_MANAGER else {
                    "status": "unavailable", "active": False, "error": "同步服务未就绪"
                }
                result = dict(persistent)
                result.update(live)
                # records_count is the full committed SQLite state, not merely this run's fetched count.
                result["records_count"] = len(db.get_records(profile_id))
                if persistent.get("needs_reconcile"):
                    result["needs_reconcile"] = True
                return self._send_json(200, result)

            if path == "/api/recommendations/today":
                profile_id = self._profile_id(required=False)
                recs = recommender.get_today_recommendations(profile_id)
                summary = recommender.get_recommendation_summary(profile_id)
                return self._send_json(200, {"recommendations": recs, "summary": summary})

            if path == "/api/stats/history":
                return self._send_json(200, {"stats": db.get_history_stats(days, self._profile_id(required=False))})

            if path == "/api/db/status":
                profile_id = self._profile_id(required=False)
                return self._send_json(200, {
                    "db_ready": True,
                    "engine": "sqlite",
                    "database_path": db.database_path(),
                    "has_snapshot": db.has_today_snapshot(profile_id),
                    "has_recommendations": db.has_today_recommendations(profile_id),
                })

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
            if path == "/api/tts/import-model":
                # Pre-role-package clients could write to an arbitrary
                # pack.json voice directory here.  Keeping that endpoint alive
                # would reintroduce model/reference-audio cross-contamination.
                return self._send_json(410, {
                    "error": "旧模型上传入口已移除；请在角色编辑器中上传模型文件",
                    "migration": "使用 /api/tts/roles/<role_id>/upload",
                })
            if path == "/api/tts/repair":
                import tts
                try:
                    return self._send_json(200, tts.repair_environment(TTS_PACK_DIR, DATA_DIR))
                except tts.TTSException as exc:
                    return self._send_json(400, {"error": str(exc)})
            if path.startswith("/api/tts/roles/") and path.endswith("/upload"):
                return self._upload_tts_role_file(path, parsed)
            try:
                body = self._read_json_body()
            except (json.JSONDecodeError, ValueError):
                return self._send_json(400, {"error": "Invalid JSON body"})

            if path.startswith("/api/tts/roles/") and path.endswith("/persona"):
                import tts
                role_id = path.split("/")[-2]
                try:
                    role = tts.update_role_persona(TTS_PACK_DIR, role_id, body.get("persona"))
                    return self._send_json(200, {"ok": True, "role": role})
                except tts.TTSException as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path.startswith("/api/tts/roles/") and path.endswith("/begin-update"):
                import tts
                role_id = path.split("/")[-2]
                try:
                    return self._send_json(200, {"ok": True, "batch_id": tts.begin_role_update(TTS_PACK_DIR, role_id)})
                except tts.TTSException as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path.startswith("/api/tts/roles/") and path.endswith("/discard-update"):
                import tts
                role_id = path.split("/")[-2]
                try:
                    return self._send_json(200, {
                        "ok": tts.discard_role_update(TTS_PACK_DIR, role_id, body.get("batch_id")),
                    })
                except tts.TTSException as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path.startswith("/api/tts/roles/") and path.endswith("/commit-update"):
                import tts
                role_id = path.split("/")[-2]
                live2d = globals().get("LIVE2D_SERVICE")
                try:
                    with _role_live2d_lock:
                        active_id = tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""
                        is_active = role_id == active_id
                        live2d_id = str(body.get("live2d_model_id") or "")
                        if live2d_id:
                            if not live2d:
                                return self._send_json(503, {"error": "Live2D 服务未就绪"})
                            live2d.validate_model(live2d_id)
                        if is_active and not live2d_id:
                            return self._send_json(400, {"error": "当前已启用角色必须绑定可用的 Live2D 模型"})

                        def sync_live2d(role):
                            # This callback runs under both the coordinator and
                            # tts.py's role lock.  It therefore observes the
                            # exact manifest being committed, not a stale
                            # active-role snapshot from a concurrent request.
                            committed_active = tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""
                            if role["role_id"] == committed_active:
                                if not live2d:
                                    raise RuntimeError("Live2D 服务未就绪")
                                live2d.set_active(self._profile_id(required=False), role["live2d_model_id"], True)

                        role = tts.commit_role_update(
                            TTS_PACK_DIR, role_id, body.get("batch_id"), body, after_commit=sync_live2d
                        )
                    return self._send_json(200, {"ok": True, "role": role})
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

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

            if path == "/api/codex/login":
                try:
                    return self._send_json(200, CODEX_OAUTH.start_login())
                except Exception as e:
                    return self._send_json(500, {"error": str(e)})

            if path == "/api/codex/logout":
                CODEX_OAUTH.logout()
                return self._send_json(200, {"ok": True})

            # 语音资源包接口（与数据库无关）
            if path == "/api/tts/roles":
                import tts
                live2d_id = str(body.get("live2d_model_id") or "")
                live2d = globals().get("LIVE2D_SERVICE")
                try:
                    with _role_live2d_lock:
                        # Validate both halves before changing either one.  This is
                        # especially important for editing the active role, which
                        # must keep its TTS and Live2D bindings in lockstep.
                        preview = tts.preview_role_save(TTS_PACK_DIR, body)
                        active_id = tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""
                        is_active = preview["role_id"] == active_id
                        if live2d_id:
                            if not live2d:
                                return self._send_json(503, {"error": "Live2D 服务未就绪"})
                            live2d.validate_model(live2d_id)

                        def sync_live2d(role):
                            if role["role_id"] != (tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""):
                                return
                            if not live2d:
                                raise RuntimeError("Live2D 服务未就绪")
                            live2d.set_active(self._profile_id(required=False), role["live2d_model_id"], True)

                        role = tts.save_role(TTS_PACK_DIR, body, after_commit=sync_live2d if is_active else None)
                    return self._send_json(200, {"ok": True, "role": role})
                except Exception as exc:
                    # This route is validation-driven; retain an actionable 4xx
                    # response for unavailable/stale model bindings rather than
                    # presenting a generic server failure to the role editor.
                    return self._send_json(400, {"error": str(exc)})

            if path.startswith("/api/tts/roles/") and path.endswith("/activate"):
                import tts
                role_id = path.split("/")[-2]
                try:
                    with _role_live2d_lock:
                        candidate = tts.get_role(TTS_PACK_DIR, role_id, require_complete=True)
                        live2d = globals().get("LIVE2D_SERVICE")
                        if not live2d:
                            return self._send_json(503, {"error": "Live2D 服务未就绪"})
                        # Validate before committing.  ``after_commit`` runs
                        # under tts.py's role lock and rolls the manifest back
                        # if the renderer preference write fails.
                        live2d.validate_model(candidate["live2d_model_id"])
                        role = tts.activate_role(
                            TTS_PACK_DIR,
                            role_id,
                            after_commit=lambda activated: live2d.set_active(
                                self._profile_id(required=False), activated["live2d_model_id"], True
                            ),
                        )
                    return self._send_json(200, {"ok": True, "role": role})
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/tts/speak":
                import tts
                try:
                    live2d = globals().get("LIVE2D_SERVICE")
                    if live2d:
                        binding = self._active_role_live2d_binding(live2d)
                        if not binding.get("ready"):
                            return self._send_json(409, {"error": binding.get("reason") or "当前角色的 Live2D 模型不可用"})
                    wav_path = tts.speak(
                        TTS_PACK_DIR,
                        DATA_DIR,
                        body.get("text", ""),
                        # The active role is the only permitted synthesis
                        # source.  Ignore a stale legacy client's `voice`
                        # field instead of allowing it to select a pack.
                        voice=None,
                        language=body.get("language"),
                        speed=body.get("speed"),
                        top_k=body.get("top_k"),
                        fragment_interval=body.get("fragment_interval"),
                        text_split_method=body.get("text_split_method"),
                        seed=body.get("seed"),
                        use_cuda_graph=body.get("use_cuda_graph"),
                        parallel_infer=body.get("parallel_infer"),
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
                    live2d = globals().get("LIVE2D_SERVICE")
                    if live2d:
                        binding = self._active_role_live2d_binding(live2d)
                        if not binding.get("ready"):
                            return self._send_json(400, {"error": binding.get("reason") or "请先修复当前角色的 Live2D 模型绑定"})
                    state = tts.set_enabled(TTS_PACK_DIR, DATA_DIR, True)
                    return self._send_json(200, {
                        "ok": True,
                        "enabled": True,
                        "active_role_id": tts.list_roles(TTS_PACK_DIR).get("active_role_id") or "",
                    })
                except tts.TTSException as e:
                    return self._send_json(400, {"error": str(e)})

            if path == "/api/tts/disable":
                import tts
                tts.set_enabled(TTS_PACK_DIR, DATA_DIR, False)
                return self._send_json(200, {"ok": True, "enabled": False})

            if path == "/api/tts/preload":
                import tts
                try:
                    live2d = globals().get("LIVE2D_SERVICE")
                    if live2d:
                        binding = self._active_role_live2d_binding(live2d)
                        if not binding.get("ready"):
                            return self._send_json(409, {"error": binding.get("reason") or "当前角色的 Live2D 模型不可用"})
                    tts.preload(TTS_PACK_DIR, DATA_DIR, voice=None)
                    return self._send_json(200, {"ok": True})
                except tts.TTSException as e:
                    return self._send_json(400, {"error": str(e)})

            if path == "/api/tts/shutdown":
                import tts
                tts.shutdown(TTS_PACK_DIR, DATA_DIR)
                return self._send_json(200, {"ok": True})

            live2d = globals().get("LIVE2D_SERVICE")
            if path == "/api/live2d/download":
                if not live2d:
                    return self._send_json(503, {"error": "Live2D 服务未就绪"})
                model_name = str(body.get("catalog_name") or "")
                if not model_name:
                    return self._send_json(400, {"error": "缺少 catalog_name"})
                return self._send_json(202, live2d.start_download(model_name, self._profile_id(required=False)))

            if path == "/api/live2d/import":
                if not live2d:
                    return self._send_json(503, {"error": "Live2D 服务未就绪"})
                return self._send_json(200, live2d.import_directory(str(body.get("source_path") or ""), self._profile_id(required=False)))

            if path == "/api/live2d/active":
                if not live2d:
                    return self._send_json(503, {"error": "Live2D 服务未就绪"})
                with _role_live2d_lock:
                    enabled = body.get("companion_enabled")
                    if enabled is not None and not isinstance(enabled, bool):
                        return self._send_json(400, {"error": "companion_enabled 必须是布尔值"})
                    binding = self._active_role_live2d_binding(live2d)
                    if not binding.get("ready"):
                        return self._send_json(409, {"error": binding.get("reason") or "请先启用资料完整的角色"})
                    requested_id = str(body.get("model_id") or "").strip()
                    if requested_id and requested_id != binding["active_model_id"]:
                        return self._send_json(409, {
                            "error": "Live2D 由当前已启用角色绑定；请在角色编辑器中更换模型后再启用角色",
                        })
                    # Legacy clients may still use this route to open/close the
                    # companion.  Keep that toggle, but always normalize the
                    # stored preference back to the active role's model.
                    return self._send_json(200, live2d.set_active(
                        self._profile_id(required=False), binding["active_model_id"], enabled
                    ))

            if path == "/api/study-sync":
                if not DB_READY or not STUDY_SYNC_MANAGER:
                    return self._send_json(503, {"error": "同步服务未就绪"})
                token = self._memo_token(required=True)
                if not token:
                    return
                mode = str(body.get("mode") or "incremental")
                if mode not in ("incremental", "bootstrap", "reconcile"):
                    return self._send_json(400, {"error": "mode 必须是 incremental、bootstrap 或 reconcile"})
                reason = str(body.get("reason") or "manual")[:80]
                seed_records = body.get("seed_records")
                if seed_records is not None and not isinstance(seed_records, list):
                    return self._send_json(400, {"error": "seed_records 必须是数组"})
                if isinstance(seed_records, list) and len(seed_records) > 200000:
                    return self._send_json(413, {"error": "seed_records 数量过大"})
                profile_id = study_sync.token_profile_id(token)
                self._start_legacy_import_once(profile_id)
                # The browser only sends startup-idle after checking visibility, drag,
                # settings/fullscreen and active study state.  Server state decides
                # whether seven days have actually elapsed.
                sync_state = db.get_sync_state(profile_id)
                if (mode == "incremental" and reason == "startup-idle" and
                        sync_state.get("bootstrap_complete") and
                        STUDY_SYNC_SERVICE.should_run_weekly_reconcile(profile_id)):
                    mode, reason = "reconcile", "weekly"
                started = STUDY_SYNC_MANAGER.start(token, mode, reason=reason, seed_records=seed_records)
                return self._send_json(202, started)

            # 保存当日快照并生成推荐
            if path == "/api/snapshot":
                records = body.get("records", []) or []
                if not isinstance(records, list):
                    return self._send_json(400, {"error": "records 必须是数组"})
                if not DB_READY:
                    return self._send_json(503, {"error": "数据库未就绪"})
                profile_id = self._profile_id(required=False)
                force = bool(body.get("force"))
                if not force and db.has_today_snapshot(profile_id) and db.has_today_recommendations(profile_id):
                    return self._send_json(200, {
                        "skipped": True,
                        "summary": recommender.get_recommendation_summary(profile_id),
                    })
                n = db.save_snapshot(records, profile_id)
                stats = db.compute_and_save_daily_stats(profile_id=profile_id)
                cnt = recommender.generate_recommendations(30, profile_id)
                return self._send_json(200, {
                    "skipped": False,
                    "saved": n,
                    "recommendations": cnt,
                    "stats": stats,
                    "summary": recommender.get_recommendation_summary(profile_id),
                })

            # 标记推荐为已复习: /api/recommendations/<id>/review
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "recommendations" and parts[3] == "review":
                try:
                    rec_id = int(parts[2])
                except (TypeError, ValueError):
                    return self._send_json(400, {"error": "推荐 ID 必须是正整数"})
                if rec_id <= 0:
                    return self._send_json(400, {"error": "推荐 ID 必须是正整数"})
                if not DB_READY:
                    return self._send_json(503, {"error": "数据库未就绪"})
                rc = recommender.mark_reviewed(rec_id, self._profile_id(required=False))
                if not rc:
                    return self._send_json(404, {"error": "推荐记录不存在"})
                return self._send_json(200, {"ok": True, "updated": rc})

            return self._send_json(404, {"error": "未知接口"})
        except Exception as e:
            traceback.print_exc()
            return self._send_json(500, {"error": str(e)})

    def _upload_tts_role_file(self, path, parsed):
        """Write an uploaded role asset to its canonical, manifest-backed path."""
        import tts
        parts = path.strip("/").split("/")
        if len(parts) != 5 or parts[:3] != ["api", "tts", "roles"] or parts[4] != "upload":
            return self._send_json(404, {"error": "未知接口"})
        query = parse_qs(parsed.query)
        kind = (query.get("kind") or [""])[0]
        name = (query.get("name") or [""])[0]
        batch_id = (query.get("batch") or [""])[0]
        length = self._safe_content_length()
        data = self.rfile.read(length) if length > 0 else b""
        try:
            if batch_id:
                staged = tts.stage_role_file(TTS_PACK_DIR, parts[3], batch_id, kind, name, data)
                return self._send_json(200, {"ok": True, "staged": staged})
            active_id = tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""
            if parts[3] == active_id:
                return self._send_json(409, {
                    "error": "当前已启用角色必须通过一次性角色更新保存，避免模型与参考资料半更新",
                })
            role = tts.upload_role_file(TTS_PACK_DIR, parts[3], kind, name, data)
            return self._send_json(200, {"ok": True, "role": role})
        except tts.TTSException as exc:
            return self._send_json(400, {"error": str(exc)})

    # ===================== /api/* DELETE =====================
    def _handle_api_delete(self, path, parsed):
        if self.headers.get("X-Requested-With") != "XMLHttpRequest":
            return self._send_json(403, {"error": "缺少 X-Requested-With 头"})
        live2d = globals().get("LIVE2D_SERVICE")
        if path.startswith("/api/tts/roles/"):
            import tts
            role_id = path.rsplit("/", 1)[-1]
            try:
                return self._send_json(200, {"ok": tts.delete_role(TTS_PACK_DIR, role_id)})
            except tts.TTSException as exc:
                return self._send_json(400, {"error": str(exc)})
        if path.startswith("/api/live2d/downloads/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            return self._send_json(200, live2d.cancel_download(path.rsplit("/", 1)[-1]))
        if path.startswith("/api/live2d/models/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            try:
                # A role can bind a model while this request is in flight;
                # coordinate deletion with all role/renderer transitions so
                # validation and reference checks observe one consistent view.
                with _role_live2d_lock:
                    deleted = live2d.delete_model(path.rsplit("/", 1)[-1])
                return self._send_json(200 if deleted else 404, {"ok": deleted})
            except Exception as exc:
                return self._send_json(400, {"error": str(exc)})
        if path != "/api/study-sync/current":
            return self._send_json(404, {"error": "未知接口"})
        if not STUDY_SYNC_MANAGER:
            return self._send_json(503, {"error": "同步服务未就绪"})
        token = self._memo_token(required=True)
        if not token:
            return
        return self._send_json(200, STUDY_SYNC_MANAGER.cancel(token))

