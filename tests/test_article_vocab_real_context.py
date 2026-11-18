# -*- coding: utf-8 -*-
"""真实上下文集成测试 —— 不替换 `_companion_context`。

## 为什么必须单独有这一组

`tests/test_article_vocab_routes.py` 的 `RouteHarness` 把
`_companion_context()` 换成 `{"account_epoch": 7, ...}` 这样的替身。
它能验证路由逻辑，但**验证不了真实上下文里真的有这些键**。

实际发生过的缺陷：`companion_runtime.account_context()` 只返回
`{account_key, profile_pk, data_epoch, has_token}`，没有 `account_epoch`，
而 `app_api.py` 有 7 处直接读 `context["account_epoch"]`。
结果是真实环境下 `/status` 抛 KeyError、连接直接断开、一个字节都没返回，
`/add` 一律 500 —— 而当时 543 项测试全绿，因为它们全都在用替身。

这组测试专门守住这一点：走真实的 `companion_runtime.account_context()`。
"""

import os
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
_SANDBOX = ROOT / "_verification" / "perfvocab" / "G" / "realcontext-tests"
_SANDBOX.mkdir(parents=True, exist_ok=True)
if not os.environ.get("MEMO_DATA_DIR"):
    os.environ["MEMO_DATA_DIR"] = str(_SANDBOX)
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import companion_runtime  # noqa: E402
import db  # noqa: E402

_REAL_DB = (ROOT / "data" / "memo-superform.db").resolve()


class RealContextContractTests(unittest.TestCase):
    """`account_context()` 的返回契约。"""

    @classmethod
    def setUpClass(cls):
        # 全量套件里别的测试模块可能已经改过 `MEMO_DATA_DIR`（甚至用过临时目录
        # 并把它删掉），`db._DB_PATH` 因此可能指向一个不存在的目录。
        # 这里自己保证目录存在并完成初始化，与本模块的相对独立性一致。
        pathlib.Path(str(db._DB_PATH)).parent.mkdir(parents=True, exist_ok=True)
        db.init_db()
        # 硬断言：任何情况下都不许连真实库。
        if pathlib.Path(str(db._DB_PATH)).resolve() == _REAL_DB:
            raise AssertionError("测试正在使用真实数据库，已中止")

    def _make_account(self, key="real-ctx-account"):
        profile_pk = db.ensure_sync_profile(key)
        db.companion_account_state(profile_pk)
        return key, profile_pk

    def test_account_context_exposes_account_epoch(self):
        """`account_epoch` 必须在返回字典里，否则 7 个调用点全部 KeyError。"""
        key, profile_pk = self._make_account()
        context = companion_runtime.account_context("token-abc", key)

        self.assertIn("account_epoch", context,
                      "account_context() 缺少 account_epoch；"
                      "app_api.py 有 7 处直接读这个键")
        self.assertIsInstance(context["account_epoch"], int)
        self.assertEqual(context["account_epoch"],
                         db.companion_account_epoch(profile_pk))

    def test_account_epoch_matches_the_persisted_row(self):
        """返回值必须与库里那一行一致，不能是临时造出来的数字。

        这里刻意不直接 `sqlite3.connect(db._DB_PATH)`：全量套件里数据库路径
        由外层 `MEMO_DATA_DIR` 决定，直连会绕过 db 模块的初始化顺序。
        改用 db 自己的读取接口，读到的就是同一行。
        """
        key, profile_pk = self._make_account("real-ctx-epoch-match")
        persisted = db.companion_account_state(profile_pk)
        self.assertIn("account_epoch", persisted)
        self.assertEqual(companion_runtime.account_context("t", key)["account_epoch"],
                         int(persisted["account_epoch"]))

    def test_data_epoch_is_still_present_and_distinct(self):
        """`data_epoch` 不能因为新增 `account_epoch` 而消失或被混用。"""
        key, profile_pk = self._make_account("real-ctx-data-epoch")
        context = companion_runtime.account_context("t", key)
        self.assertIn("data_epoch", context)
        # 两者是独立屏障：推进 data_epoch 不应改动 account_epoch。
        before = context["account_epoch"]
        db.companion_bump_data_epoch(profile_pk)
        after = companion_runtime.account_context("t", key)
        self.assertGreater(after["data_epoch"], context["data_epoch"])
        self.assertEqual(after["account_epoch"], before,
                         "推进 data_epoch 时 account_epoch 被改动了")

    def test_missing_account_key_still_raises(self):
        """没有账号身份时仍必须抛错，不能为了修 KeyError 而放宽。"""
        with self.assertRaises(ValueError):
            companion_runtime.account_context("t", "")


class StatusRouteUsesRealContextTests(unittest.TestCase):
    """`/status` 走真实 `_companion_context` 时不得抛 KeyError。"""

    @classmethod
    def setUpClass(cls):
        pathlib.Path(str(db._DB_PATH)).parent.mkdir(parents=True, exist_ok=True)
        db.init_db()
        if pathlib.Path(str(db._DB_PATH)).resolve() == _REAL_DB:
            raise AssertionError("测试正在使用真实数据库，已中止")

    def test_status_route_reads_both_epochs_without_keyerror(self):
        import app_api

        # `DB_READY` 是 server.configure_local_api() 注入的模块级全局；
        # 这里直接调路由就要自己置位，否则会先撞 NameError 而不是被测契约。
        original_ready = getattr(app_api, "DB_READY", None)
        app_api.DB_READY = True
        self.addCleanup(setattr, app_api, "DB_READY", original_ready)

        key = "real-ctx-status"
        db.ensure_sync_profile(key)
        context = companion_runtime.account_context("t", key)

        sent = []

        class Handler(app_api.LocalApiMixin):
            def __init__(self):
                self.headers = {}

            def _send_json(self, code, data):
                sent.append((code, data))

            def _memo_identity(self, required=False):
                return "t", key

        handler = Handler()
        result = handler._article_vocab_get("/api/article-vocab/status", {})

        self.assertIsNone(result, "GET 路由应返回 None（响应已自行发送）")
        self.assertEqual(len(sent), 1, "应当只发送一个响应，实际发送 %d 个" % len(sent))
        code, data = sent[0]
        self.assertEqual(code, 200)
        self.assertEqual(data["account_epoch"], context["account_epoch"])
        self.assertEqual(data["data_epoch"], context["data_epoch"])


if __name__ == "__main__":
    unittest.main()