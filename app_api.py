# -*- coding: utf-8 -*-
"""Memo Superform 本地 API 处理器，与代理传输层分离。"""
import json
import os
import sys
import traceback
import threading
from urllib.parse import parse_qs

import study_sync


_legacy_attempted = set()
_legacy_lock = threading.Lock()
# 角色清单和 Live2D 偏好由不同服务保存。HTTP 进程串行处理它们的耦合变更，
# 避免两个连续启用/编辑请求提交 TTS 角色 A 却留下渲染器偏好 B。
_role_live2d_lock = threading.RLock()


def configure_local_api(**values):
    globals().update(values)


def _tts_pack_mount_manager():
    """返回当前数据目录对应的后台语音包任务管理器。

    生产环境由 ``server.py`` 注入单例；测试或直接导入 ``app_api`` 时按当前
    DATA_DIR 惰性创建，避免将任务状态绑定到旧的临时目录。
    """
    import tts
    pack_dir = os.path.abspath(globals().get("TTS_PACK_DIR") or "")
    data_dir = os.path.abspath(globals().get("DATA_DIR") or "")
    manager = globals().get("TTS_PACK_MOUNT_MANAGER")
    if (manager is None or os.path.abspath(getattr(manager, "pack_dir", "")) != pack_dir or
            os.path.abspath(getattr(manager, "data_dir", "")) != data_dir):
        manager = tts.TTSPackMountJobManager(pack_dir, data_dir)
        globals()["TTS_PACK_MOUNT_MANAGER"] = manager
    return manager


def _tts_pack_mount_active():
    try:
        return _tts_pack_mount_manager().is_active()
    except Exception:
        return False


class LocalApiMixin:
    def _memo_identity(self, required=True):
        """返回 ``(access_token, stable_profile_id)``。

        旧页面携带 Bearer Token 时仍按旧规则工作；新的桌面页面不再读取令牌，
        由本机 DPAPI 凭据库在这里附加授权。OAuth 档案键永远基于 OIDC ``sub``。
        """
        auth = (self.headers.get("Authorization") or "").strip()
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
            if token:
                return token, study_sync.token_profile_id(token)
        service = globals().get("MAIMEMO_OAUTH")
        if service is not None:
            try:
                token = service.access_token()
                return token, service.profile_key()
            except Exception as exc:
                if required:
                    self._send_json(401, {"error": str(exc) or "请先连接墨墨账号"})
                return None, None
        if required:
            self._send_json(401, {"error": "请先连接墨墨账号"})
        return None, None

    def _memo_token(self, required=True):
        return self._memo_identity(required=required)[0]

    def _profile_id(self, required=False):
        return self._memo_identity(required=required)[1]

    def _active_role_live2d_binding(self, live2d):
        """只把当前角色公开为 Live2D 运行时来源。

        ``live2d_preferences.active_model_id`` 早于角色包，可能仍保存过期的
        手工选择模型。为兼容保留此存储细节，但陪伴渲染时绝不允许它覆盖
        已启用角色。
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

    # ===================== /api/* 查询 =====================
    def _handle_api_get(self, path, parsed):
        # 与数据库无关的本地接口（运行模式 / 语音资源包状态）
        if path == "/api/app/current-mode":
            return self._send_json(200, {
                "mode": _current_mode(),
                "is_frozen": bool(getattr(sys, "frozen", False)),
                "data_dir": DATA_DIR,
            })

        if path in ("/api/app/update-status", "/api/app/update/check"):
            manager = globals().get("UPDATE_MANAGER")
            if manager is None:
                return self._send_json(503, {"error": "更新服务未就绪"})
            query = parse_qs(parsed.query)
            force = query.get("force", ["0"])[0] == "1"
            return self._send_json(200, manager.get_status(force=force))

        if path == "/api/tts/status":
            import tts
            status = tts.get_status(TTS_PACK_DIR, DATA_DIR)
            status["mounting"] = _tts_pack_mount_active()
            live2d = globals().get("LIVE2D_SERVICE")
            if live2d and status.get("active_role_id"):
                binding = self._active_role_live2d_binding(live2d)
                status["live2d_role_ready"] = bool(binding.get("ready"))
                if not binding.get("ready"):
                    status["role_ready"] = False
                    status["role_error"] = binding.get("reason") or "当前角色绑定的 Live2D 模型不可用"
            return self._send_json(200, status)

        if path.startswith("/api/tts/mount-pack/jobs/"):
            import tts
            job_id = path.rsplit("/", 1)[-1]
            if not job_id:
                return self._send_json(404, {"error": "未指定语音包安装任务"})
            try:
                return self._send_json(200, _tts_pack_mount_manager().get_job(job_id))
            except tts.TTSException as exc:
                return self._send_json(404, {"error": str(exc)})

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
                        # 这个只读标注让浏览器把旧角色 ID 人设迁入各自的角色清单，
                        # 同时不允许 Live2D 模型在运行时决定当前人设。
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

        if path == "/api/maimemo-auth/status":
            service = globals().get("MAIMEMO_OAUTH")
            if service is None:
                return self._send_json(503, {"error": "墨墨账号服务未就绪"})
            return self._send_json(200, service.status())

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
                token, profile_id = self._memo_identity(required=True)
                if not token or not profile_id:
                    return
                persistent = db.get_sync_state(profile_id)
                live = STUDY_SYNC_MANAGER.status(profile_id) if STUDY_SYNC_MANAGER else {
                    "status": "unavailable", "active": False, "error": "同步服务未就绪"
                }
                result = dict(persistent)
                result.update(live)
                # records_count 是 SQLite 已提交的完整状态，不只是本次拉取数量。
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

    # ===================== /api/* 写入 =====================
    def _handle_api_post(self, path, parsed):
        try:
            # 写接口 CSRF 防护：要求自定义头（跨域简单请求无法携带，
            # 会触发 CORS 预检并被同源策略拦截）
            if self.headers.get("X-Requested-With") != "XMLHttpRequest":
                return self._send_json(403, {"error": "缺少 X-Requested-With 头"})
            if path == "/api/tts/import-model":
                # 角色包之前的客户端可在此写入任意 pack.json 音色目录；继续保留
                # 该入口会重新引入模型与参考音频混用。
                return self._send_json(410, {
                    "error": "旧模型上传入口已移除；请在角色编辑器中上传模型文件",
                    "migration": "使用 /api/tts/roles/<role_id>/upload",
                })
            if path == "/api/tts/mount-pack":
                return self._mount_tts_pack_archive(parsed)
            if path.startswith("/api/tts/") and _tts_pack_mount_active():
                return self._send_json(409, {
                    "error": "语音包正在后台挂载，请等待安装完成后再操作语音资料",
                    "mounting": True,
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
                            # 此回调同时处于协调锁和 tts.py 角色锁内，因而读取的是
                            # 正在提交的准确清单，而非并发请求留下的过期当前角色快照。
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

            if path == "/api/app/update/download":
                manager = globals().get("UPDATE_MANAGER")
                if manager is None:
                    return self._send_json(503, {"error": "更新服务未就绪"})
                try:
                    state = manager.start_download()
                    code = 202 if state.get("state") == "downloading" else 200
                    return self._send_json(code, {"ok": True, "download": state})
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/app/update/apply":
                manager = globals().get("UPDATE_MANAGER")
                apply_update = globals().get("_apply_update")
                if manager is None or not callable(apply_update):
                    return self._send_json(503, {"error": "更新服务未就绪"})
                try:
                    staged = manager.prepare_apply()
                    # 更新前先结束常驻的 GPT-SoVITS worker。它本身不会持有主 EXE，
                    # 但可避免更新重启后遗留一份旧角色/旧模型的后台推理进程。
                    try:
                        import tts
                        tts.shutdown(TTS_PACK_DIR, DATA_DIR)
                    except Exception:
                        pass
                    ok, msg = apply_update(staged)
                    if not ok:
                        manager.apply_failed(msg)
                        return self._send_json(400, {"error": msg})
                    return self._send_json(200, {"ok": True, "installing": True, "message": msg})
                except Exception as exc:
                    manager.apply_failed(str(exc))
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/codex/login":
                try:
                    return self._send_json(200, CODEX_OAUTH.start_login())
                except Exception as e:
                    return self._send_json(500, {"error": str(e)})

            if path == "/api/codex/logout":
                CODEX_OAUTH.logout()
                return self._send_json(200, {"ok": True})

            if path == "/api/maimemo-auth/start":
                service = globals().get("MAIMEMO_OAUTH")
                if service is None:
                    return self._send_json(503, {"error": "墨墨账号服务未就绪"})
                try:
                    return self._send_json(200, service.start_login())
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/maimemo-auth/manual-token":
                service = globals().get("MAIMEMO_OAUTH")
                if service is None:
                    return self._send_json(503, {"error": "墨墨账号服务未就绪"})
                try:
                    status = service.set_manual_token(str(body.get("token") or ""))
                    return self._send_json(200, status)
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/maimemo-auth/disconnect":
                service = globals().get("MAIMEMO_OAUTH")
                if service is None:
                    return self._send_json(503, {"error": "墨墨账号服务未就绪"})
                try:
                    service.disconnect()
                    return self._send_json(200, {"ok": True, "data_preserved": True})
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            # 语音资源包接口（与数据库无关）
            if path == "/api/tts/roles":
                import tts
                live2d_id = str(body.get("live2d_model_id") or "")
                live2d = globals().get("LIVE2D_SERVICE")
                try:
                    with _role_live2d_lock:
                        # 任一侧变化前先同时校验两侧；编辑当前角色时尤其重要，
                        # TTS 与 Live2D 绑定必须同步推进。
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
                    # 此路由以校验为主；模型绑定不可用或过期时返回可操作的 4xx，
                    # 不向角色编辑器显示笼统的服务端失败。
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
                        # 提交前先校验。``after_commit`` 在 tts.py 的角色锁内运行；
                        # 渲染器偏好写入失败时会一并回滚清单。
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
                        # 当前角色是唯一允许的合成来源。忽略旧客户端残留的 `voice`
                        # 字段，绝不让它另选资料包。
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
                    # 旧客户端仍可能用此路由打开或关闭陪伴模式。保留该开关，但始终
                    # 把保存的模型偏好归一到当前角色绑定。
                    return self._send_json(200, live2d.set_active(
                        self._profile_id(required=False), binding["active_model_id"], enabled
                    ))

            if path == "/api/study-sync":
                if not DB_READY or not STUDY_SYNC_MANAGER:
                    return self._send_json(503, {"error": "同步服务未就绪"})
                token, profile_id = self._memo_identity(required=True)
                if not token or not profile_id:
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
                self._start_legacy_import_once(profile_id)
                # 浏览器仅在检查可见性、拖拽、设置/全屏和学习状态后发送 startup-idle；
                # 是否确实已过七天由服务端状态决定。
                sync_state = db.get_sync_state(profile_id)
                if (mode == "incremental" and reason == "startup-idle" and
                        sync_state.get("bootstrap_complete") and
                        STUDY_SYNC_SERVICE.should_run_weekly_reconcile(profile_id)):
                    mode, reason = "reconcile", "weekly"
                started = STUDY_SYNC_MANAGER.start(
                    token, mode, reason=reason, seed_records=seed_records, profile_id=profile_id
                )
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
        """把上传的角色资源写入清单支持的规范路径。"""
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

    def _mount_tts_pack_archive(self, parsed):
        """网页模式的小包后备入口；真正安装交给后台任务。"""
        import tts
        query = parse_qs(parsed.query)
        source_name = (query.get("name") or [""])[0]
        # 名称只用于显示，实际内容由 tts.py 的 ZIP 解析器校验。此处保留扩展名
        # 检查，让拖错文件在可能数 GB 的上传开始前就得到提示。
        if source_name and not source_name.lower().endswith(".zip"):
            return self._send_json(400, {"error": "请拖入完整的语音包 ZIP 文件"})
        content_length = self._safe_content_length()
        if content_length > tts.TTS_PACK_WEB_UPLOAD_MAX_BYTES:
            return self._send_json(413, {
                "error": "浏览器模式仅支持不超过 256 MiB 的语音包，请使用桌面 EXE 原生导入",
                "requires_native_import": True,
                "max_bytes": tts.TTS_PACK_WEB_UPLOAD_MAX_BYTES,
            })
        try:
            job = _tts_pack_mount_manager().start_stream(
                self.rfile,
                content_length,
                source_name=source_name,
            )
            return self._send_json(202, {"ok": True, "job_id": job["job_id"], "job": job})
        except tts.TTSException as exc:
            return self._send_json(400, {"error": str(exc)})

    # ===================== /api/* 删除 =====================
    def _handle_api_delete(self, path, parsed):
        if self.headers.get("X-Requested-With") != "XMLHttpRequest":
            return self._send_json(403, {"error": "缺少 X-Requested-With 头"})
        if path.startswith("/api/tts/") and _tts_pack_mount_active():
            return self._send_json(409, {
                "error": "语音包正在后台挂载，请等待安装完成后再操作语音资料",
                "mounting": True,
            })
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
                # 请求执行期间角色可能绑定该模型；删除操作需与所有角色/渲染器切换
                # 协调，使校验和引用检查始终观察同一份一致状态。
                with _role_live2d_lock:
                    deleted = live2d.delete_model(path.rsplit("/", 1)[-1])
                return self._send_json(200 if deleted else 404, {"ok": deleted})
            except Exception as exc:
                return self._send_json(400, {"error": str(exc)})
        if path == "/api/maimemo-auth/data":
            if not DB_READY:
                return self._send_json(503, {"error": "数据库未就绪"})
            profile_id = self._profile_id(required=True)
            if not profile_id:
                return
            try:
                deleted = db.delete_profile_learning_data(profile_id)
                return self._send_json(200, {"ok": True, "deleted": deleted})
            except Exception as exc:
                return self._send_json(500, {"error": str(exc)})
        if path != "/api/study-sync/current":
            return self._send_json(404, {"error": "未知接口"})
        if not STUDY_SYNC_MANAGER:
            return self._send_json(503, {"error": "同步服务未就绪"})
        _token, profile_id = self._memo_identity(required=True)
        if not profile_id:
            return
        return self._send_json(200, STUDY_SYNC_MANAGER.cancel(profile_id))

