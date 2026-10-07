import json
import os
import pathlib
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
with tempfile.TemporaryDirectory(prefix="dashboard-smoke-", dir=root / "_verification") as data:
    os.environ["MEMO_DATA_DIR"] = data
    import server
    httpd = server.MemoThreadingTCPServer(("127.0.0.1", 0), server.MemoProxyHandler)
    print("DASHBOARD_URL=http://127.0.0.1:%s" % httpd.server_address[1], flush=True)
    import threading
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        sys.stdin.readline()
    finally:
        httpd.shutdown()
        httpd.server_close()
