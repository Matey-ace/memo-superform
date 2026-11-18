# -*- coding: utf-8 -*-
"""为视觉重设计提供截图用的本地服务。

与 `tests/browser/dashboard-server.py` 的区别：那个用临时目录并在测试结束时删除；
这个允许指定固定数据目录，便于多轮截图之间保持同一份数据（基线可比）。

用法：
    python tests/redesign/serve.py --data-dir <dir>      # 输出 READY <url>
然后按 stdin 收到换行后退出。
"""
import argparse
import os
import pathlib
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    data_dir = pathlib.Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ["MEMO_DATA_DIR"] = str(data_dir)
    sys.path.insert(0, str(ROOT))

    import server

    httpd = server.MemoThreadingTCPServer(("127.0.0.1", args.port), server.MemoProxyHandler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print("READY http://127.0.0.1:%d" % port, flush=True)
    try:
        # 常驻运行：不能用 sys.stdin.readline()，非交互式启动时 stdin 立刻 EOF，
        # 服务会在打印 READY 后马上关闭（连接被拒）。改为显式阻塞。
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()