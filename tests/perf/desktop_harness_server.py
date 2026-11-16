"""D 桌面资源 —— Live2D 渲染器测量夹具（服务端）。

只绑定 127.0.0.1 并使用端口 0（系统分配）。数据目录由调用方指定，
**绝不指向真实 data/**。角色绑定在这里被替换为桩：真实的
`_active_role_live2d_binding` 需要 tts_pack 里 545 MB 的角色目录，
本夹具只需要"绑定就绪"这一前置条件，以便走真实的渲染器代码路径。

注意：不做任何降级 —— 页面、js、vendor、模型资源全部是真实未修改的文件。
"""

import argparse
import hashlib
import json
import os
import pathlib
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


class _StubOAuth:
    def __init__(self, token, profile_key):
        self._token = token
        self._profile = profile_key
        self.configured = True

    def access_token(self):
        return self._token

    def profile_key(self):
        return self._profile

    def authorization_context(self):
        return self._token, self._profile

    def status(self):
        return {
            "configured": True, "callback_ready": True, "callback_error": "",
            "connected": True, "mode": "manual", "subject": "",
            "display_name": "perf-harness", "profile_id": self._profile,
            "pending": False, "error": "", "redirect_uri": "",
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--token", default="perf-token")
    args = parser.parse_args()

    data_dir = os.path.abspath(args.data_dir)
    os.makedirs(data_dir, exist_ok=True)
    os.environ["MEMO_DATA_DIR"] = data_dir

    import server
    import app_api
    import db

    db.keep_warm(True)
    profile_key = hashlib.sha256(args.token.encode("utf-8")).hexdigest()
    app_api.configure_local_api(MAIMEMO_OAUTH=_StubOAuth(args.token, profile_key))

    # 桩：只提供"当前角色已绑定可用模型"这一个事实，其余全部走真实实现。
    models = db.list_live2d_models()
    ready_model = next((m for m in models if m.get("complete")), None)
    if ready_model is None:
        raise SystemExit("HARNESS_ERROR: 没有可用模型，无法测量")

    def _binding(self, live2d):
        return {
            "enforced": True, "ready": True,
            "active_role_id": "perf-role",
            "active_role_name": "perf-role",
            "configured_model_id": ready_model["model_id"],
            "active_model_id": ready_model["model_id"],
            "model_character_id": str(ready_model.get("character_id") or ""),
            "persona": {"name": "perf-role"},
            "reason": "",
        }

    app_api.LocalApiMixin._active_role_live2d_binding = _binding

    httpd = server.MemoThreadingTCPServer(("127.0.0.1", 0), server.MemoProxyHandler)
    port = httpd.server_address[1]
    info = {
        "url": "http://127.0.0.1:%s" % port,
        "data_dir": data_dir,
        "model_id": ready_model["model_id"],
        "model_format": ready_model.get("model_format"),
        "profile": profile_key,
    }
    print("HARNESS=" + json.dumps(info), flush=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    # 由外部测量脚本终止（job_kill / Stop-Process），不依赖 stdin，
    # 避免在后台作业里 stdin 立即 EOF 导致服务提前退出。
    stop = threading.Event()
    try:
        stop.wait()
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()
