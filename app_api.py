# -*- coding: utf-8 -*-
"""Local Memo Superform API handlers, separated from proxy transport."""
import json
import os
import sys
import traceback
import urllib.error
import threading
from urllib.parse import parse_qs

import study_sync


_legacy_attempted = set()
_legacy_lock = threading.Lock()


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
            return self._send_json(200, tts.get_status(TTS_PACK_DIR, DATA_DIR))

        if path == "/api/codex/status":
            return self._send_json(200, CODEX_OAUTH.status())

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

            if path == "/api/codex/login":
                try:
                    return self._send_json(200, CODEX_OAUTH.start_login())
                except Exception as e:
                    return self._send_json(500, {"error": str(e)})

            if path == "/api/codex/logout":
                CODEX_OAUTH.logout()
                return self._send_json(200, {"ok": True})

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

    # ===================== /api/* DELETE =====================
    def _handle_api_delete(self, path, parsed):
        if self.headers.get("X-Requested-With") != "XMLHttpRequest":
            return self._send_json(403, {"error": "缺少 X-Requested-With 头"})
        if path != "/api/study-sync/current":
            return self._send_json(404, {"error": "未知接口"})
        if not STUDY_SYNC_MANAGER:
            return self._send_json(503, {"error": "同步服务未就绪"})
        token = self._memo_token(required=True)
        if not token:
            return
        return self._send_json(200, STUDY_SYNC_MANAGER.cancel(token))

