# -*- coding: utf-8 -*-
"""AI 记忆注入的边界测试：只改 system、有上限、失败不致命。"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest

import db
import companion_runtime
import companion_memory
import ai_memory_injection as ami


class InjectTests(unittest.TestCase):
    def test_appends_to_system_only(self):
        messages = [
            {"role": "system", "content": "你是陪伴角色。"},
            {"role": "user", "content": "我今天学了什么"},
        ]
        result = ami.inject_memory(messages, "学习者偏好：简短回答")
        self.assertTrue(result["injected"])
        out = result["messages"]
        self.assertIn("学习者偏好", out[0]["content"])
        self.assertEqual(out[1]["content"], "我今天学了什么", "用户消息绝不能被改写")

    def test_does_not_mutate_input(self):
        messages = [{"role": "system", "content": "base"}]
        ami.inject_memory(messages, "记忆")
        self.assertEqual(messages[0]["content"], "base")

    def test_no_system_message_leaves_request_alone(self):
        messages = [{"role": "user", "content": "hi"}]
        result = ami.inject_memory(messages, "记忆")
        self.assertFalse(result["injected"])
        self.assertEqual(result["reason"], "no_system_message")
        self.assertEqual(result["messages"][0]["content"], "hi")

    def test_empty_block_not_injected(self):
        messages = [{"role": "system", "content": "base"}]
        result = ami.inject_memory(messages, "   ")
        self.assertFalse(result["injected"])

    def test_block_is_capped(self):
        long_block = "字" * 5000
        messages = [{"role": "system", "content": "base"}]
        result = ami.inject_memory(messages, long_block)
        self.assertLessEqual(len(result["messages"][0]["content"]),
                             ami.MAX_INJECT_CHARS + 200)

    def test_multipart_system_content_preserved(self):
        messages = [{"role": "system",
                     "content": [{"type": "text", "text": "第一段"}]}]
        result = ami.inject_memory(messages, "记忆")
        content = result["messages"][0]["content"]
        self.assertIsInstance(content, list)
        self.assertEqual(content[0]["text"], "第一段")
        self.assertIn("记忆", content[-1]["text"])

    def test_non_list_messages_untouched(self):
        result = ami.inject_memory("not a list", "记忆")
        self.assertFalse(result["injected"])

    def test_block_failure_is_silent(self):
        # 未初始化的档案主键：必须返回空串而不是抛错。
        self.assertEqual(ami.build_block(None), "")


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        # 父目录必须自己建：它可能被上一次清理删掉，不能让 mkdtemp 依赖它存在。
        os.makedirs(r"D:\MeMo1\_verification\companion-upgrade\agents\M", exist_ok=True)
        self.tmp = tempfile.mkdtemp(dir=r"D:\MeMo1\_verification\companion-upgrade\agents\M")
        self.addCleanup(self._cleanup)
        db.init_db(self.tmp)
        self.pk = db.ensure_sync_profile("acct-inject")
        self.epoch = db.companion_account_state(self.pk)["data_epoch"]

    def _cleanup(self):
        db.close_warm()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_end_to_end_memory_into_prompt(self):
        companion_memory.ensure_settings(self.pk)
        companion_memory.set_preference(self.pk, "role-a", "preference_name", "小林")
        # 记忆出站默认关闭（隐私优先）：必须由用户显式开启才注入 AI。
        companion_memory.update_settings(self.pk, outbound_enabled=True)
        block = ami.build_block(self.pk, role_id="role-a")
        self.assertIn("小林", block)
        messages = [{"role": "system", "content": "你是角色。"},
                    {"role": "user", "content": "叫我名字"}]
        result = ami.prepare_request(messages, self.pk, role_id="role-a")
        self.assertTrue(result["injected"])
        self.assertIn("小林", result["messages"][0]["content"])

    def test_outbound_defaults_off_so_nothing_leaves(self):
        """隐私默认值本身就是验收项：未经用户同意，记忆不得进入 AI 请求。"""
        companion_memory.ensure_settings(self.pk)
        companion_memory.set_preference(self.pk, "role-a", "preference_name", "小林")
        settings = companion_memory.get_settings(self.pk)
        self.assertFalse(settings["outbound_enabled"], "出站必须默认关闭")
        self.assertEqual(ami.build_block(self.pk, role_id="role-a"), "")

    def test_disabled_memory_injects_nothing(self):
        companion_memory.ensure_settings(self.pk)
        companion_memory.set_preference(self.pk, "role-a", "preference_name", "小林")
        companion_memory.update_settings(self.pk, outbound_enabled=True)
        companion_memory.update_settings(self.pk, use_enabled=False)
        self.assertEqual(ami.build_block(self.pk, role_id="role-a"), "")

    def test_outbound_disabled_injects_nothing(self):
        companion_memory.ensure_settings(self.pk)
        companion_memory.set_preference(self.pk, "role-a", "preference_name", "小林")
        companion_memory.update_settings(self.pk, outbound_enabled=True)
        companion_memory.update_settings(self.pk, outbound_enabled=False)
        self.assertEqual(ami.build_block(self.pk, role_id="role-a"), "")

    def test_deleted_memory_leaves_prompt(self):
        companion_memory.ensure_settings(self.pk)
        created = companion_memory.set_preference(self.pk, "role-a", "preference_name", "小林")
        companion_memory.update_settings(self.pk, outbound_enabled=True)
        self.assertIn("小林", ami.build_block(self.pk, role_id="role-a"))
        companion_memory.delete_memory(self.pk, "role-a", created["memory_id"])
        self.assertNotIn("小林", ami.build_block(self.pk, role_id="role-a"))


if __name__ == "__main__":
    unittest.main()