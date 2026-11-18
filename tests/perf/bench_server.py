"""性能基准服务：独立数据目录 + 合成数据 + 随机端口 + 桩账号身份。

与 tests/browser/dashboard-server.py 一样只绑定 127.0.0.1 并使用端口 0（系统分配），
数据目录由调用方指定（默认在项目 `_verification/` 下新建临时目录）。
账号身份替换为桩对象：**不读取本机凭据、不访问墨墨云端、不触碰 `data/`**。
桩只提供本地 API 解析档案所需的两个方法，用于让仪表盘按已连接账号的真实代码路径
读取 SQLite 合成记录。
"""

import argparse
import os
import pathlib
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))


class _StubOAuth:
    """只实现本地 API 需要的身份接口；任何云端行为都不存在。"""

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
            "configured": True,
            "callback_ready": True,
            "callback_error": "",
            "connected": True,
            "mode": "manual",
            "subject": "",
            "display_name": "bench-synthetic",
            "profile_id": self._profile,
            "pending": False,
            "error": "",
            "redirect_uri": "",
        }


def main():
    parser = argparse.ArgumentParser(description="启动性能基准服务")
    parser.add_argument("--data-dir", default=None)
    parser.add_argument("--count", type=int, default=0, help="大于 0 时生成合成记录")
    parser.add_argument("--seed", type=int, default=20261008)
    parser.add_argument("--token", default="bench-token")
    parser.add_argument("--no-keep-warm", action="store_true", help="对照测量：不启用 WAL 保活连接")
    args = parser.parse_args()

    if args.data_dir:
        data_dir = os.path.abspath(args.data_dir)
        os.makedirs(data_dir, exist_ok=True)
    else:
        data_dir = tempfile.mkdtemp(prefix="bench-data-", dir=str(ROOT / "_verification"))

    os.environ["MEMO_DATA_DIR"] = data_dir

    profile_key = None
    if args.count > 0:
        import synthetic_dataset
        records = synthetic_dataset.generate_records(args.count, seed=args.seed)
        info = synthetic_dataset.seed_database(data_dir, records, token=args.token, seed=args.seed)
        profile_key = info["profile_key"]
        print("BENCH_SEEDED=" + str(info["count"]), flush=True)
    if profile_key is None:
        import hashlib
        profile_key = hashlib.sha256(args.token.encode("utf-8")).hexdigest()

    import server
    import app_api
    import db
    # 与生产启动路径 server.start_server() 一致：长驻服务保持 WAL 保活连接。
    # --no-keep-warm 用于对照测量。
    if not args.no_keep_warm:
        db.keep_warm(True)
    app_api.configure_local_api(MAIMEMO_OAUTH=_StubOAuth(args.token, profile_key))

    httpd = server.MemoThreadingTCPServer(("127.0.0.1", 0), server.MemoProxyHandler)
    port = httpd.server_address[1]
    print("BENCH_DATA_DIR=" + data_dir, flush=True)
    print("BENCH_PROFILE=" + profile_key, flush=True)
    print("BENCH_URL=http://127.0.0.1:%s" % port, flush=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        sys.stdin.readline()
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()
