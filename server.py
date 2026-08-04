#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Memo Superform - 本地代理服务器
解决墨墨 API 不支持 CORS 的问题，同时提供静态文件服务。

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
from urllib.parse import urlparse, parse_qs

# 修复 Windows 控制台编码问题
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

PORT = 8888
WEB_DIR = os.path.dirname(os.path.abspath(__file__))
MAIMEMO_BASE = "https://open.maimemo.com/open"

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

        # 代理墨墨 API: /proxy/memo/xxx -> https://open.maimemo.com/open/api/v1/memo/xxx
        if parsed.path.startswith("/proxy/memo/"):
            api_path = parsed.path[len("/proxy/memo/"):]
            target_url = MAIMEMO_BASE + "/api/v1/memo/" + api_path
            if parsed.query:
                target_url += "?" + parsed.query
            self._proxy_request(target_url, method="GET")
            return

        # 普通静态文件
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        # 代理墨墨 API
        if parsed.path.startswith("/proxy/memo/"):
            api_path = parsed.path[len("/proxy/memo/"):]
            target_url = MAIMEMO_BASE + "/api/v1/memo/" + api_path
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self._proxy_request(target_url, method="POST", body=body)
            return

        # 代理 AI API: /proxy/ai
        if parsed.path == "/proxy/ai":
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

    def _proxy_request(self, target_url, method="GET", body=None):
        """转发请求到墨墨 API，去掉 Origin 头"""
        auth = self.headers.get("Authorization", "")

        req = urllib.request.Request(target_url, data=body, method=method)
        req.add_header("Accept", "application/json")
        if auth:
            req.add_header("Authorization", auth)
        if method == "POST" and body:
            req.add_header("Content-Type", "application/json")
        # 不添加 Origin 头，避免被墨墨 API 拒绝

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


def main():
    for port in [PORT, 8889, 8890, 3000, 5000]:
        try:
            with socketserver.ThreadingTCPServer(("127.0.0.1", port), MemoProxyHandler) as httpd:
                print("")
                print("  ========================================")
                print("  Memo Superform proxy server started")
                print("  ========================================")
                print("")
                print("  Web dir:  %s" % WEB_DIR)
                print("  URL:      http://localhost:%d" % port)
                print("  API proxy: /proxy/memo/* -> open.maimemo.com")
                print("  AI proxy:  /proxy/ai")
                print("")
                print("  Press Ctrl+C to stop")
                print("")
                print("  %s" % ("-" * 40))
                httpd.serve_forever()
                return
        except OSError:
            continue

    print("Error: Cannot find available port (8888-8890, 3000, 5000 all in use)")
    sys.exit(1)


if __name__ == "__main__":
    main()

