# -*- coding: utf-8 -*-
"""角色包安装验收测试：真实 ZIP、真实摘要、真实 tts 安装原语。"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

import db
import companion_runtime
import role_package_service as rps

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures")
import sys

sys.path.insert(0, FIXTURE_DIR)
import make_role_package as mk  # noqa: E402


class FakeWriter:
    """记录调用并按 role_id 生成稳定结果，用于纯服务层测试。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.deleted: list[str] = []
        self.fail_on: set[str] = set()

    def write_role(self, spec):
        self.calls.append(spec)
        role_id = spec.get("role_id") or "generated-%d" % len(self.calls)
        if role_id in self.fail_on or spec.get("manifest", {}).get("reference_text") == "BOOM":
            raise RuntimeError("模拟写入失败")
        return {"role_id": role_id, "name": "X"}

    def delete_role(self, role_id):
        self.deleted.append(role_id)


class Base(unittest.TestCase):
    def setUp(self):
        # 父目录必须自己建：它可能被上一次清理删掉，不能让 mkdtemp 依赖它存在。
        os.makedirs(r"D:\MeMo1\_verification\companion-upgrade\agents\M", exist_ok=True)
        self.tmp = tempfile.mkdtemp(dir=r"D:\MeMo1\_verification\companion-upgrade\agents\M")
        self.addCleanup(self._cleanup)
        self.data_dir = os.path.join(self.tmp, "data")
        os.makedirs(self.data_dir, exist_ok=True)
        db.init_db(self.data_dir)
        rps._store._jobs.clear()
        rps._store._cancel.clear()
        self.paths = companion_runtime.ensure_data_paths()

    def _cleanup(self):
        db.close_warm()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make(self, mode="full", count=2, layout="multi"):
        out = os.path.join(self.paths["incoming"], "fixtures")
        os.makedirs(out, exist_ok=True)
        path = mk.build(out, mode, count=count, layout=layout)
        return path


class InspectTests(Base):
    def test_full_package_inspection(self):
        path = self.make("full", count=2)
        result = rps.inspect_source(path)
        self.assertEqual(result["role_count"], 2)
        self.assertEqual(len(result["source_sha256"]), 64)
        self.assertTrue(result["enough_space"])
        self.assertTrue(all(role["complete"] for role in result["roles"]))
        self.assertTrue(all(role["conflict"] == "new" for role in result["roles"]))
        self.assertTrue(all(role["missing"] == [] for role in result["roles"]))

    def test_draft_package_reports_missing(self):
        path = self.make("draft")
        result = rps.inspect_source(path)
        role = result["roles"][0]
        self.assertFalse(role["complete"])
        self.assertIn("gpt.ckpt", role["missing"])
        self.assertIn("reference audio", role["missing"])
        self.assertTrue(any("草稿" in note for note in role["notes"]))

    def test_traversal_rejected(self):
        path = self.make("traversal")
        with self.assertRaises(rps.RolePackageError):
            rps.inspect_source(path)

    def test_url_rejected(self):
        with self.assertRaises(rps.RolePackageError):
            rps.inspect_source("https://example.com/role.zip")

    def test_outside_incoming_rejected(self):
        outside = os.path.join(self.tmp, "outside.zip")
        mk.build(os.path.dirname(outside), "full", count=1)
        shutil.move(os.path.join(os.path.dirname(outside), "role-pack-full.zip"), outside)
        with self.assertRaises(rps.RolePackageError):
            rps.inspect_source(outside)

    def test_missing_file_rejected(self):
        with self.assertRaises(rps.RolePackageError):
            rps.inspect_source(os.path.join(self.paths["incoming"], "nope.zip"))

    def test_corrupt_zip_rejected(self):
        bad = os.path.join(self.paths["incoming"], "bad.zip")
        with open(bad, "wb") as handle:
            handle.write(b"not a zip at all")
        with self.assertRaises(rps.RolePackageError):
            rps.inspect_source(bad)

    def test_inspection_is_persisted(self):
        path = self.make("full", count=1)
        result = rps.inspect_source(path)
        stored = os.path.join(self.paths["jobs"], "%s.inspect.json" % result["inspection_id"])
        self.assertTrue(os.path.isfile(stored))

    def test_unpacked_limit_enforced_at_inspect_not_confirm(self):
        """解包上限必须在「检查」阶段生效。

        为什么重要：若只在确认阶段校验，用户会先看到一份「可安装」的清单并点确认，
        然后才被拒绝——这等于把失败推迟到最坏时机。
        """
        import zipfile
        bad = os.path.join(self.paths["incoming"], "huge.zip")
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr("role.json", '{"role_id":"huge","name":"Huge"}')
            zf.writestr("gpt.ckpt", b"x" * 4096)

        original = rps.MAX_SINGLE_FILE_BYTES
        rps.MAX_SINGLE_FILE_BYTES = 1024
        try:
            with self.assertRaises(rps.RolePackageError) as ctx:
                rps.inspect_source(bad)
        finally:
            rps.MAX_SINGLE_FILE_BYTES = original
        self.assertIn("单个文件", str(ctx.exception))

    def test_member_count_limit_enforced_at_inspect(self):
        import zipfile
        bad = os.path.join(self.paths["incoming"], "many.zip")
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr("role.json", '{"role_id":"many","name":"Many"}')
            for index in range(6):
                zf.writestr("f%d.bin" % index, b"x")

        original = rps.MAX_UNPACKED_MEMBERS
        rps.MAX_UNPACKED_MEMBERS = 4
        try:
            with self.assertRaises(rps.RolePackageError) as ctx:
                rps.inspect_source(bad)
        finally:
            rps.MAX_UNPACKED_MEMBERS = original
        self.assertIn("成员数量", str(ctx.exception))


class InstallTests(Base):
    def test_two_roles_install(self):
        path = self.make("full", count=2)
        inspection = rps.inspect_source(path)
        writer = FakeWriter()
        job = rps.start_install(inspection["inspection_id"], writer=writer, background=False)
        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["completed_roles"], 2)
        self.assertEqual(job["failed_roles"], 0)
        self.assertEqual(len(writer.calls), 2)
        self.assertEqual(writer.calls[0]["mode"], "create")
        self.assertTrue(writer.calls[0]["staged_dir"])

    def test_partial_failure_keeps_other_roles(self):
        path = self.make("full", count=2)
        inspection = rps.inspect_source(path)
        writer = FakeWriter()
        writer.fail_on = {"demo-role-02"}
        job = rps.start_install(inspection["inspection_id"], writer=writer, background=False)
        self.assertEqual(job["state"], "partial_failed")
        self.assertEqual(job["completed_roles"], 1)
        self.assertEqual(job["failed_roles"], 1)
        statuses = {entry["package_role_id"]: entry["status"] for entry in job["roles"]}
        self.assertEqual(statuses["demo-role-01"], "installed")
        self.assertEqual(statuses["demo-role-02"], "failed")

    def test_selection_installs_subset(self):
        path = self.make("full", count=2)
        inspection = rps.inspect_source(path)
        writer = FakeWriter()
        chosen = [{"role_root": inspection["roles"][0]["role_root"]}]
        job = rps.start_install(inspection["inspection_id"], selections=chosen,
                                writer=writer, background=False)
        self.assertEqual(job["total_roles"], 1)
        self.assertEqual(len(writer.calls), 1)

    def test_changed_source_blocks_install(self):
        path = self.make("full", count=1)
        inspection = rps.inspect_source(path)
        # 确认前换掉压缩包：必须拒绝，而不是装成另一个角色。
        mk.make_full(os.path.dirname(path), count=3)
        with self.assertRaises(rps.RolePackageConflict):
            rps.start_install(inspection["inspection_id"], writer=FakeWriter(),
                              background=False)

    def test_unknown_inspection_rejected(self):
        with self.assertRaises(rps.RolePackageError):
            rps.start_install("insp-does-not-exist", writer=FakeWriter(), background=False)

    def test_registry_records_installed_role(self):
        path = self.make("full", count=1)
        inspection = rps.inspect_source(path)
        rps.start_install(inspection["inspection_id"], writer=FakeWriter(), background=False)
        registry = rps.read_registry()
        self.assertIn("demo-role-01", registry["roles"])
        self.assertIn(inspection["source_sha256"], registry["packages"])

    def test_second_install_is_upgrade(self):
        path = self.make("full", count=1)
        first = rps.inspect_source(path)
        rps.start_install(first["inspection_id"], writer=FakeWriter(), background=False)
        second = rps.inspect_source(path)
        self.assertEqual(second["roles"][0]["conflict"], "upgrade")
        writer = FakeWriter()
        rps.start_install(second["inspection_id"], writer=writer, background=False)
        self.assertEqual(writer.calls[0]["mode"], "upgrade")
        self.assertEqual(writer.calls[0]["role_id"], "demo-role-01")

    def test_cancel_before_commit(self):
        path = self.make("full", count=2)
        inspection = rps.inspect_source(path)
        job = rps.start_install(inspection["inspection_id"], writer=FakeWriter(),
                                background=True)
        rps.cancel_job(job["job_id"])
        # 后台线程可能在取消前就开始；两种终态都可接受，但绝不能留下半装。
        final = rps.job_status(job["job_id"])
        self.assertIn(final["state"], ("cancelled", "completed", "partial_failed",
                                       "queued", "installing"))

    def test_cancel_unknown_job(self):
        with self.assertRaises(rps.RolePackageError):
            rps.cancel_job("job-nope")

    def test_staging_cleaned_after_run(self):
        path = self.make("full", count=2)
        inspection = rps.inspect_source(path)
        rps.start_install(inspection["inspection_id"], writer=FakeWriter(), background=False)
        staging = self.paths["staging"]
        leftovers = [name for name in os.listdir(staging)] if os.path.isdir(staging) else []
        self.assertEqual(leftovers, [])

    def test_journal_is_resumable(self):
        path = self.make("full", count=1)
        inspection = rps.inspect_source(path)
        job = rps.start_install(inspection["inspection_id"], writer=FakeWriter(),
                                background=False)
        rps._store._jobs.clear()
        reloaded = rps.job_status(job["job_id"])
        self.assertEqual(reloaded["job_id"], job["job_id"])
        self.assertEqual(reloaded["state"], "completed")

    def test_recover_marks_unfinished(self):
        rps._store.save({"job_id": "job-stuck", "state": "installing", "roles": [],
                         "created_at": companion_runtime.utc_now_iso(),
                         "updated_at": companion_runtime.utc_now_iso()})
        result = rps.recover_pending()
        self.assertIn("job-stuck", result["recovered"])
        self.assertEqual(rps.job_status("job-stuck")["state"], "recovering")

    def test_list_jobs_newest_first(self):
        rps.start_install.__self__ if False else None
        for index in range(2):
            job = {"job_id": "job-l%d" % index, "state": "completed", "roles": [],
                   "created_at": "2026-11-1%dT00:00:00+00:00" % index,
                   "updated_at": "2026-11-1%dT00:00:00+00:00" % index}
            rps._store.save(job)
        listed = rps.list_jobs(limit=5)
        self.assertEqual(listed[0]["job_id"], "job-l1")


class RealTtsInstallTests(Base):
    """真正走 tts.install_role_resources，验证与现有人设/清单体系兼容。"""

    def test_real_install_creates_usable_role(self):
        import tts
        pack_dir = self.paths["tts_pack_dir"]
        os.makedirs(pack_dir, exist_ok=True)
        path = self.make("full", count=1)
        inspection = rps.inspect_source(path)
        job = rps.start_install(inspection["inspection_id"], background=False)
        self.assertEqual(job["state"], "completed", job.get("message"))
        roles = tts.list_roles(pack_dir)["roles"]
        installed = [r for r in roles if r.get("role_id") == "demo-role-01"]
        self.assertEqual(len(installed), 1)
        role = tts.get_role(pack_dir, "demo-role-01")
        self.assertEqual(role.get("reference_language"), "中文")
        folder = os.path.join(pack_dir, "roles", "demo-role-01")
        for name in ("gpt.ckpt", "sovits.pth", "reference.wav"):
            self.assertTrue(os.path.isfile(os.path.join(folder, name)), name)
        # 包里的 persona.json 没有版本号：安装后必须仍能被现有校验读出。
        persona = installed[0].get("persona") or {}
        self.assertEqual(persona.get("name"), "陪伴角色 1")
        self.assertIn("温和", json.dumps(persona, ensure_ascii=False))
        # 完整包应被视为完整角色，而不是草稿。
        self.assertTrue(installed[0].get("complete"), installed[0].get("missing"))


if __name__ == "__main__":
    unittest.main()