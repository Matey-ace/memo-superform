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
import urllib.request
import urllib.error
import json
import os
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
MAIMEMO_BASE = "https://open.maimemo.com/open"

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

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

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
        super().do_GET()

    def do_POST(self):
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
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self._proxy_request(target_url, method="POST", body=body)
            return

        # 代理 AI API: /proxy/ai
        if path == "/proxy/ai":
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            try:
                req_data = json.loads(body)
                ai_endpoint = req_data.get("endpoint", "").rstrip("/")
                ai_key = req_data.get("apiKey", "")
                ai_body = req_data.get("body", {})

                if not ai_endpoint or not ai_key:
                    self._send_json(400, {"error": "Missing endpoint or apiKey"})
                    return

                target_url = ai_endpoint + "/chat/completions"
                ai_req_body = json.dumps(ai_body).encode("utf-8")
                ai_req = urllib.request.Request(target_url, data=ai_req_body, method="POST")
                ai_req.add_header("Content-Type", "application/json")
                ai_req.add_header("Authorization", "Bearer " + ai_key)

                try:
                    ai_resp = urllib.request.urlopen(ai_req, timeout=60)
                    ai_result = ai_resp.read().decode("utf-8")
                    self._send_json(200, json.loads(ai_result))
                except urllib.error.HTTPError as e:
                    err_body = e.read().decode("utf-8") if e.fp else ""
                    self._send_json(e.code, {"error": err_body})
                except Exception as e:
                    self._send_json(500, {"error": str(e)})
            except json.JSONDecodeError:
                self._send_json(400, {"error": "Invalid JSON body"})
            return

        self.send_error(404, "Not Found")

    # ===================== /api/* GET =====================
    def _handle_api_get(self, path, parsed):
        if not DB_READY:
            return self._send_json(503, {"error": "数据库未就绪"})
        try:
            if path == "/api/recommendations/today":
                recs = recommender.get_today_recommendations()
                summary = recommender.get_recommendation_summary()
                return self._send_json(200, {"recommendations": recs, "summary": summary})

            if path == "/api/stats/history":
                days = int(parse_qs(parsed.query).get("days", ["30"])[0])
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
        if not DB_READY:
            return self._send_json(503, {"error": "数据库未就绪"})
        try:
            try:
                body = self._read_json_body()
            except (json.JSONDecodeError, ValueError):
                return self._send_json(400, {"error": "Invalid JSON body"})

            # 保存当日快照并生成推荐
            if path == "/api/snapshot":
                force = bool(body.get("force"))
                if not force and db.has_today_snapshot() and db.has_today_recommendations():
                    return self._send_json(200, {
                        "skipped": True,
                        "summary": recommender.get_recommendation_summary(),
                    })
                records = body.get("records", []) or []
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
    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
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
            self.log_date_time_string(), args[0], args[1], args[2]
        ))


def start_server(open_browser=True, block=True):
    """启动服务器。block=False 时在后台守护线程运行，返回 (httpd, url)。"""
    for port in [PORT, 8889, 8890, 3000, 5000]:
        try:
            httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), MemoProxyHandler)
            httpd.allow_reuse_address = True
            url = "http://localhost:%d" % port
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
    return None


def main():
    result = start_server(open_browser=True, block=True)
    if not result:
        print("Error: Cannot find available port (8888-8890, 3000, 5000 all in use)")
        sys.exit(1)


if __name__ == "__main__":
    main()