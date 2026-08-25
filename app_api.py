# -*- coding: utf-8 -*-
"""Local Memo Superform API handlers, separated from proxy transport."""
import json
import os
import sys
import traceback
import urllib.error


def configure_local_api(**values):
    globals().update(values)


class LocalApiMixin:
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
            if path == "/api/recommendations/today":
                recs = recommender.get_today_recommendations()
                summary = recommender.get_recommendation_summary()
                return self._send_json(200, {"recommendations": recs, "summary": summary})

            if path == "/api/stats/history":
                return self._send_json(200, {"stats": db.get_history_stats(days)})

            if path == "/api/db/status":
                return self._send_json(200, {
                    "db_ready": True,
                    "has_snapshot": db.has_today_snapshot(),
                    "has_recommendations": db.has_today_recommendations(),
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

            # 保存当日快照并生成推荐
            if path == "/api/snapshot":
                records = body.get("records", []) or []
                if not isinstance(records, list):
                    return self._send_json(400, {"error": "records 必须是数组"})
                if not DB_READY:
                    return self._send_json(503, {"error": "数据库未就绪"})
                force = bool(body.get("force"))
                if not force and db.has_today_snapshot() and db.has_today_recommendations():
                    return self._send_json(200, {
                        "skipped": True,
                        "summary": recommender.get_recommendation_summary(),
                    })
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
                try:
                    rec_id = int(parts[2])
                except (TypeError, ValueError):
                    return self._send_json(400, {"error": "推荐 ID 必须是正整数"})
                if rec_id <= 0:
                    return self._send_json(400, {"error": "推荐 ID 必须是正整数"})
                if not DB_READY:
                    return self._send_json(503, {"error": "数据库未就绪"})
                rc = recommender.mark_reviewed(rec_id)
                if not rc:
                    return self._send_json(404, {"error": "推荐记录不存在"})
                return self._send_json(200, {"ok": True, "updated": rc})

            return self._send_json(404, {"error": "未知接口"})
        except Exception as e:
            traceback.print_exc()
            return self._send_json(500, {"error": str(e)})

