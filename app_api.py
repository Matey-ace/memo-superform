# -*- coding: utf-8 -*-
"""Memo Superform 本地 API 处理器，与代理传输层分离。"""
import json
import os
import sys
import traceback
import threading
from urllib.parse import parse_qs

import study_sync


_legacy_attempted = set()
_legacy_lock = threading.Lock()
# 角色清单和 Live2D 偏好由不同服务保存。HTTP 进程串行处理它们的耦合变更，
# 避免两个连续启用/编辑请求提交 TTS 角色 A 却留下渲染器偏好 B。
_role_live2d_lock = threading.RLock()

# 文章选词的 operation_id 幂等表。只放进程内存：它防的是"同一次点击重复提交"，
# 不是跨进程的持久幂等；进程重启后用户再点会重新走一次官方查重（官方对已添加词
# 返回较小 added_count），因此不需要落盘，也不该让它进入用户数据目录。
_article_vocab_lock = threading.Lock()
_article_vocab_operations = {}


def configure_local_api(**values):
    globals().update(values)


def _tts_pack_mount_manager():
    """返回当前数据目录对应的后台语音包任务管理器。

    生产环境由 ``server.py`` 注入单例；测试或直接导入 ``app_api`` 时按当前
    DATA_DIR 惰性创建，避免将任务状态绑定到旧的临时目录。
    """
    import tts
    pack_dir = os.path.abspath(globals().get("TTS_PACK_DIR") or "")
    data_dir = os.path.abspath(globals().get("DATA_DIR") or "")
    manager = globals().get("TTS_PACK_MOUNT_MANAGER")
    if (manager is None or os.path.abspath(getattr(manager, "pack_dir", "")) != pack_dir or
            os.path.abspath(getattr(manager, "data_dir", "")) != data_dir):
        manager = tts.TTSPackMountJobManager(pack_dir, data_dir)
        globals()["TTS_PACK_MOUNT_MANAGER"] = manager
    return manager


def _tts_pack_mount_active():
    try:
        return _tts_pack_mount_manager().is_active()
    except Exception:
        return False


class LocalApiMixin:
    def _memo_identity(self, required=True):
        """返回 ``(access_token, stable_profile_id)``。

        旧页面携带 Bearer Token 时仍按旧规则工作；新的桌面页面不再读取令牌，
        由本机 DPAPI 凭据库在这里附加授权。OAuth 档案键永远基于 OIDC ``sub``。
        """
        auth = (self.headers.get("Authorization") or "").strip()
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
            if token:
                return token, study_sync.token_profile_id(token)
        service = globals().get("MAIMEMO_OAUTH")
        if service is not None:
            try:
                if callable(getattr(service, "authorization_context", None)):
                    return service.authorization_context()
                token = service.access_token()
                return token, service.profile_key()
            except Exception as exc:
                if required:
                    self._send_json(401, {"error": str(exc) or "请先连接墨墨账号"})
                return None, None
        if required:
            self._send_json(401, {"error": "请先连接墨墨账号"})
        return None, None

    def _memo_token(self, required=True):
        return self._memo_identity(required=required)[0]

    def _profile_id(self, required=False):
        return self._memo_identity(required=required)[1]

    def _active_role_live2d_binding(self, live2d):
        """只把当前角色公开为 Live2D 运行时来源。

        ``live2d_preferences.active_model_id`` 早于角色包，可能仍保存过期的
        手工选择模型。为兼容保留此存储细节，但陪伴渲染时绝不允许它覆盖
        已启用角色。
        """
        result = {
            "enforced": True,
            "ready": False,
            "active_role_id": "",
            "active_role_name": "",
            "configured_model_id": "",
            "active_model_id": None,
            "model_character_id": "",
            "persona": {},
            "reason": "尚未启用资料完整的角色",
        }
        try:
            import tts
            library = tts.list_roles(TTS_PACK_DIR)
            role_id = str(library.get("active_role_id") or "")
            result["active_role_id"] = role_id
            role = next((item for item in library.get("roles") or [] if item.get("role_id") == role_id), None)
            if not role:
                return result
            result["active_role_name"] = str(role.get("name") or role_id)
            result["configured_model_id"] = str(role.get("live2d_model_id") or "")
            result["persona"] = role.get("persona") if isinstance(role.get("persona"), dict) else {}
            if not role.get("complete"):
                missing = "、".join(role.get("missing") or [])
                result["reason"] = "当前角色资料未配齐" + ("：" + missing if missing else "")
                return result
            if not result["configured_model_id"]:
                result["reason"] = "当前角色未绑定 Live2D 模型"
                return result
            model = live2d.validate_model(result["configured_model_id"])
            result.update({
                "ready": True,
                "active_model_id": result["configured_model_id"],
                "model_character_id": str(model.get("character_id") or ""),
                "reason": "",
            })
        except Exception as exc:
            result["reason"] = "角色绑定的 Live2D 模型不可用：%s" % exc
        return result

    def _article_vocab_error(self, exc):
        """把选词/官方接口异常映射成统一响应，保留 ``uncertain`` 语义。

        ``uncertain`` 必须传给前端：写请求超时可能已生效，前端不能自动重试，
        也不能显示成"失败"。
        """
        import article_vocab
        import official_vocab_api
        if isinstance(exc, official_vocab_api.OfficialVocabError):
            data = exc.as_dict()
            if exc.status in (401, 403, 429):
                code = exc.status
            elif exc.code in ("invalid_request", "unauthorized", "forbidden"):
                code = 400
            else:
                code = 502
            return self._send_json(code, data)
        if isinstance(exc, (article_vocab.ArticleVocabError, ValueError)):
            return self._send_json(400, {"error": str(exc) or "输入无效", "code": "invalid"})
        return self._send_json(500, {"error": "选词服务暂时不可用"})

    def _article_vocab_transport(self, retryable):
        """把宿主 handler 的代理调用包装成 ``official_vocab_api`` 的 transport。

        ``retryable=False`` 用于 ``add_words``：非幂等写请求不允许自动重试。
        """
        import official_vocab_api

        def transport(api_path, body):
            # MAIMEMO_BASE / MAX_UPSTREAM_JSON 由 server.py 注入；测试可直接导入
            # app_api 时给一个安全默认，避免依赖注入顺序。
            base = globals().get("MAIMEMO_BASE") or "https://open.maimemo.com/open"
            limit = globals().get("MAX_UPSTREAM_JSON") or (8 * 1024 * 1024)
            url = base + "/api/v1/memo/" + api_path
            raw_body = json.dumps(body).encode("utf-8")
            status, payload, retry_after = self._proxy_call(
                url, method="POST", body=raw_body, retryable=retryable)
            if status is None:
                # 无上游响应：连接失败/超时。是否 uncertain 由 official_vocab_api 判断。
                raise RuntimeError(payload.get("error") or "上游调用失败")
            data = None
            try:
                if len(payload) <= limit:
                    data = json.loads(payload.decode("utf-8"))
            except (ValueError, UnicodeError):
                data = None
            result = {"status": status, "body": data if data is not None else {}}
            if retry_after is not None:
                result["headers"] = {"Retry-After": retry_after}
            return result

        return transport

    def _article_vocab_get(self, path, parsed):
        """文章选词 GET 路由。返回 None 表示不属于本模块。"""
        if not path.startswith("/api/article-vocab/"):
            return None
        if path != "/api/article-vocab/status":
            return self._send_json(404, {"error": "未知接口"})
        context = self._companion_context()
        if context is None:
            return None
        return self._send_json(200, {
            "ok": True,
            "account_epoch": context["account_epoch"],
            "data_epoch": context["data_epoch"],
            "auto_add_default": False,
        })

    def _article_vocab_post(self, path, parsed):
        """文章选词 POST 路由。这是唯一会写云端的功能入口。"""
        if not path.startswith("/api/article-vocab/"):
            return None
        try:
            return self._article_vocab_route(path, parsed)
        except Exception as exc:
            # 官方接口错误必须变成带 code/uncertain 的响应，而不是 500 栈。
            return self._article_vocab_error(exc)

    def _article_vocab_route(self, path, parsed):
        import article_vocab
        import official_vocab_api

        context = self._companion_context()
        if context is None:
            return None
        try:
            body = self._read_json_body()
        except (json.JSONDecodeError, ValueError):
            return self._send_json(400, {"error": "Invalid JSON body"})
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "请求体必须是 JSON 对象"})

        if path == "/api/article-vocab/select":
            # 只读：分析文章并给出候选，不写云端。
            article = body.get("article")
            extracted = article_vocab.extract_english(article)
            if not extracted["text"]:
                reason = extracted.get("reason") or "no_english"
                if reason == "empty":
                    return self._send_json(400, {"error": "文章为空", "code": "empty"})
                return self._send_json(400, {"error": "文章中没有可分析的英文", "code": "no_english"})
            candidates = article_vocab.local_candidates(extracted["text"])
            messages = article_vocab.build_prompt(
                extracted["text"], candidates,
                target_level=str(body.get("targetLevel") or ""),
                purpose=str(body.get("purpose") or ""),
                word_count=body.get("wordCount") or article_vocab.DEFAULT_WORD_COUNT)
            return self._send_json(200, {
                "chars": extracted["chars"],
                "truncated": extracted["truncated"],
                "candidates": len(candidates),
                "messages": messages,
            })

        if path == "/api/article-vocab/parse":
            # 把 AI 原始返回校验成受信任的候选列表。
            source = body.get("article")
            extracted = article_vocab.extract_english(source)
            selection = article_vocab.parse_selection(
                body.get("raw"),
                source_text=extracted["text"],
                max_words=body.get("wordCount") or article_vocab.DEFAULT_WORD_COUNT)
            return self._send_json(200, selection)

        if path == "/api/article-vocab/query-ids":
            # 只读：批量查真实词 ID。绝不按下标映射。
            lemmas = body.get("lemmas")
            if not isinstance(lemmas, list):
                return self._send_json(400, {"error": "lemmas 必须是数组"})
            transport = self._article_vocab_transport(retryable=True)
            matched_all, missing_all, ambiguous_all = {}, [], {}
            for batch in article_vocab.plan_query_batches(lemmas):
                result = official_vocab_api.query_vocabulary(
                    transport=transport, spellings=batch)
                mapped = article_vocab.map_voc_ids(batch, result["voc"])
                matched_all.update(mapped["matched"])
                missing_all.extend(mapped["missing"])
                ambiguous_all.update(mapped["ambiguous"])
            return self._send_json(200, {
                "matched": matched_all, "missing": missing_all,
                "ambiguous": ambiguous_all, "requested": len(matched_all) + len(missing_all) + len(ambiguous_all),
            })

        if path == "/api/article-vocab/add":
            # 唯一的云端写入。要求显式确认 + 账号一致 + operation_id 幂等。
            if body.get("confirm") is not True:
                return self._send_json(400, {"error": "需要用户确认后才能加入学习列表",
                                             "code": "confirm_required"})
            if body.get("advance") not in (None, False):
                return self._send_json(400, {"error": "本版本固定 advance=false", "code": "invalid"})
            lemmas = body.get("lemmas")
            if not isinstance(lemmas, list) or not lemmas:
                return self._send_json(400, {"error": "没有可提交的单词", "code": "empty"})
            expected_epoch = body.get("account_epoch")
            if expected_epoch is not None and expected_epoch != context["account_epoch"]:
                # 账号已切换：绝不能把上一个账号的选词写进当前账号。
                return self._send_json(409, {"error": "账号已切换，请重新选择",
                                             "code": "stale", "retryable": False})
            operation_id = str(body.get("operationId") or "").strip()
            if not operation_id:
                return self._send_json(400, {"error": "缺少 operationId", "code": "invalid"})
            cached = self._article_vocab_recall(operation_id)
            if cached is not None:
                # 幂等表**只按 operation_id 查**，不参与账号代次过滤。
                # 理由：这个 id 对应的操作已经真的写过云端了，无论现在问的是
                # 哪个账号，都绝不能再写一次。
                #
                # 代次不符也回 200 回放：前端每次 submit 都会新生成 operation_id
                # (article-vocab.js:831，全仓唯一生成点、不持久化)，所以这条路径
                # 现实中只可能是"同一次提交被打断后的重放"，而不是"用户想在新账号
                # 下重试"。既然都不写云端，回放完整结果比只说一句"不会重复提交"
                # 信息量更大——用户需要知道上次到底加进去多少词。
                payload = dict(cached["result"], deduplicated=True)
                if cached["account_epoch"] != context["account_epoch"]:
                    payload["account_switched"] = True
                return self._send_json(200, payload)

            transport = self._article_vocab_transport(retryable=False)
            matched, missing, ambiguous = {}, [], {}
            for batch in article_vocab.plan_query_batches(lemmas):
                result = official_vocab_api.query_vocabulary(transport=transport, spellings=batch)
                mapped = article_vocab.map_voc_ids(batch, result["voc"])
                matched.update(mapped["matched"])
                missing.extend(mapped["missing"])
                ambiguous.update(mapped["ambiguous"])

            plan = article_vocab.build_add_plan(
                [{"lemma": str(item)} for item in lemmas],
                {"matched": matched, "ambiguous": ambiguous})
            ids = [entry["id"] for entry in plan["submittable"]]
            # 未命中官方词库的词不能提交，但也不能因此不告诉用户。
            if not ids:
                payload = {"submitted": 0, "added_count": 0, "shortfall": 0,
                           "status": "none", "note": "所选词未在墨墨词库中查到，未提交",
                           "missing": missing, "ambiguous": list(ambiguous), "skipped": plan["skipped"]}
                self._article_vocab_remember(operation_id, context["account_epoch"], payload)
                return self._send_json(200, payload)

            added_total, submitted_total = 0, 0
            for batch in article_vocab.plan_add_batches(ids):
                # 查 ID 与写入之间有网络往返，用户可能在此期间切换账号。
                # 每次真正写云端之前重新核对一次代次，避免把上一个账号的选词
                # 写进当前账号。不一致就停下，已写入的批次如实报告。
                current = self._companion_context()
                if current is None:
                    # `_companion_context()` 失败时**已经**把 401/503 写给客户端了
                    # （见它的 docstring）。这里再发一次 409 会把第二个响应的
                    # 状态行塞进第一个响应的 body，客户端 `response.json()` 直接
                    # JSONDecodeError，于是"已写入多少词"的关键信息全部丢失。
                    # 直接收工，不要发第二次。
                    return
                if current["account_epoch"] != context["account_epoch"]:
                    stale = article_vocab.interpret_add_result(submitted_total, added_total)
                    payload = dict(stale, missing=missing, ambiguous=list(ambiguous),
                                   skipped=plan["skipped"], partial_account_switch=True)
                    # 必须也记住这个 operation_id：否则客户端拿同一个 id 重放时，
                    # 幂等表里没有记录，已提交的那几批会被**再写一次**。
                    # 记住"已经提交过的部分"比记住"成功"更重要。
                    self._article_vocab_remember(
                        operation_id, context["account_epoch"], payload)
                    return self._send_json(409, dict(
                        payload,
                        error="账号已切换，已停止提交；已提交的部分可能已生效，请在新账号下核对",
                        code="stale", retryable=False,
                        submitted=submitted_total, added_count=added_total))
                result = official_vocab_api.add_words(batch, transport=transport, advance=False)
                added_total += result["added_count"]
                submitted_total += result["submitted"]
            outcome = article_vocab.interpret_add_result(submitted_total, added_total)
            payload = dict(outcome, missing=missing, ambiguous=list(ambiguous),
                           skipped=plan["skipped"])
            self._article_vocab_remember(operation_id, context["account_epoch"], payload)
            return self._send_json(200, payload)

        return self._send_json(404, {"error": "未知接口"})

    def _article_vocab_recall(self, operation_id):
        """按 operation_id 读取历史结果。

        故意**不**按账号代次过滤：该 id 代表的操作可能已经写过云端，
        代次不符时调用方必须拒绝再次写入，而不是当作"没记录"重写一遍。
        """
        with _article_vocab_lock:
            cached = _article_vocab_operations.get(operation_id)
        if cached is None:
            return None
        return dict(cached)

    def _article_vocab_remember(self, operation_id, account_epoch, result):
        """记住已完成的 operation_id（进程内），保证重复提交不再写云端。"""
        with _article_vocab_lock:
            if len(_article_vocab_operations) >= 512:
                # 绝不能 clear() 整表：表里可能有**已经写过云端**的 operation_id，
                # 清掉之后同一个 id 重放就会再写一次（G 实测复现过真实重复写入）。
                # dict 保序，弹掉最早插入的一个即可。
                _article_vocab_operations.pop(next(iter(_article_vocab_operations)), None)
            _article_vocab_operations[operation_id] = {
                "account_epoch": account_epoch, "result": result}

    def _start_legacy_import_once(self, profile_id):
        if not profile_id or not DB_READY:
            return
        with _legacy_lock:
            if profile_id in _legacy_attempted:
                return
            _legacy_attempted.add(profile_id)
        threading.Thread(target=db.try_import_legacy_sqlserver, args=(profile_id,),
                         name="memo-legacy-readonly-import", daemon=True).start()

    # ===================== 陪伴升级：共享辅助 =====================
    def _companion_context(self):
        """解析当前账号并返回带持久代次的上下文；失败时已发送响应并返回 None。"""
        if not DB_READY:
            self._send_json(503, {"error": "数据库未就绪"})
            return None
        token, account_key = self._memo_identity(required=True)
        if not token or not account_key:
            return None
        import companion_runtime
        try:
            return companion_runtime.account_context(token, account_key)
        except Exception as exc:
            self._send_json(401, {"error": str(exc)})
            return None

    def _companion_error(self, exc):
        """把业务模块的异常映射成统一错误对象，不泄漏内部名词。"""
        import companion_memory
        import companion_sessions
        if isinstance(exc, companion_sessions.ConflictError):
            return self._send_json(409, {"error": str(exc), "code": "conflict", "retryable": True})
        if isinstance(exc, companion_sessions.StaleEpochError):
            return self._send_json(409, {"error": "学习数据已重置，请重新进入", "code": "stale", "retryable": False})
        if isinstance(exc, companion_memory.MemoryConflictError):
            return self._send_json(409, {"error": str(exc), "code": "conflict", "retryable": True})
        if isinstance(exc, (companion_memory.MemoryStoreError, companion_sessions.SessionError)):
            return self._send_json(400, {"error": str(exc), "code": "invalid", "retryable": False})
        traceback.print_exc()
        return self._send_json(500, {"error": "陪伴服务暂时不可用"})

    def _companion_epoch_guard(self, context, parsed_or_body):
        """客户端带上自己记得的代次时，代次不符就返回 409 stale。

        为什么需要：会话行按当前代次过滤，数据重置后旧会话只会「查不到」。
        如果只返回 ``available=False``，前端无法区分「还没结算」与「数据被清空了」，
        会一直等在错误的界面上。这里给出可区分的信号。
        """
        try:
            if hasattr(parsed_or_body, "query"):
                raw = parse_qs(parsed_or_body.query).get("data_epoch", [None])[0]
            elif isinstance(parsed_or_body, dict):
                raw = parsed_or_body.get("data_epoch")
            else:
                raw = None
            if raw in (None, ""):
                return False
            if int(raw) != int(context["data_epoch"]):
                self._send_json(409, {"error": "学习数据已重置，请重新进入",
                                      "code": "stale", "retryable": False})
                return True
        except (TypeError, ValueError):
            return False
        return False

    def _companion_get(self, path, parsed):
        """陪伴升级 GET 路由。返回 None 表示未命中，交回既有分发。"""
        if not path.startswith("/api/companion/") and not path.startswith("/api/role-packages/"):
            return None
        try:
            if path == "/api/companion/memory/settings":
                context = self._companion_context()
                if context is None:
                    return None
                import companion_memory
                return self._send_json(200, companion_memory.get_settings(context["profile_pk"]))

            if path == "/api/companion/memory/context":
                context = self._companion_context()
                if context is None:
                    return None
                import companion_memory
                import companion_runtime
                role = companion_runtime.active_role()
                query = parse_qs(parsed.query).get("q", [""])[0]
                settings = companion_memory.get_settings(context["profile_pk"])
                if not settings.get("use_enabled") or not settings.get("outbound_enabled"):
                    # 出站关闭时本地仍可检索，但不下发可发送的上下文文本。
                    return self._send_json(200, {"available": False, "items": [], "chars": 0})
                return self._send_json(200, companion_memory.retrieve(context["profile_pk"], role["role_id"], query))

            if path == "/api/companion/memories":
                context = self._companion_context()
                if context is None:
                    return None
                import companion_memory
                import companion_runtime
                query = parse_qs(parsed.query)
                role_id = (query.get("role_id") or [companion_runtime.active_role()["role_id"]])[0]
                role_epoch = companion_runtime.db.companion_role_epoch(context["profile_pk"], role_id)
                return self._send_json(200, {
                    "role_id": role_id,
                    "role_epoch": role_epoch["role_epoch"],
                    "items": companion_memory.list_memories(context["profile_pk"], role_id),
                })

            if path.startswith("/api/companion/sessions/"):
                context = self._companion_context()
                if context is None:
                    return None
                if self._companion_epoch_guard(context, parsed):
                    return None
                import companion_sessions
                parts = path.strip("/").split("/")
                session_id = parts[3] if len(parts) > 3 else ""
                if len(parts) == 5 and parts[4] == "settlement":
                    return self._send_json(200, companion_sessions.get_settlement(
                        context["profile_pk"], context["data_epoch"], session_id) or {"available": False})
                if len(parts) == 4:
                    return self._send_json(200, companion_sessions.get_session(
                        context["profile_pk"], context["data_epoch"], session_id) or {"available": False})
                return self._send_json(404, {"error": "未知接口"})

            if path == "/api/companion/sessions":
                context = self._companion_context()
                if context is None:
                    return None
                import companion_sessions
                return self._send_json(200, {
                    "items": companion_sessions.list_settlements(context["profile_pk"], context["data_epoch"]),
                })

            if path.startswith("/api/role-packages/jobs/"):
                import role_package_service
                job_id = path.rsplit("/", 1)[-1]
                return self._send_json(200, role_package_service.job_status(job_id))

            if path == "/api/role-packages/jobs":
                import role_package_service
                return self._send_json(200, {"items": role_package_service.list_jobs()})

            if path == "/api/role-packages/registry":
                import role_package_service
                return self._send_json(200, role_package_service.read_registry())

            return self._send_json(404, {"error": "未知接口"})
        except Exception as exc:
            return self._companion_error(exc)

    # ===================== /api/* 查询 =====================
    def _companion_post(self, path, parsed):
        """陪伴升级 POST 路由。所有写请求都需要自定义头与同源校验。"""
        try:
            if path.startswith("/api/role-packages/"):
                return self._role_package_post(path, parsed)
            context = self._companion_context()
            if context is None:
                return None
            body = self._read_json_body()
            profile_pk = context["profile_pk"]
            data_epoch = context["data_epoch"]
            import companion_memory
            import companion_runtime

            if path == "/api/companion/memory/settings":
                return self._send_json(200, companion_memory.update_settings(
                    profile_pk,
                    use_enabled=body.get("use_enabled"),
                    outbound_enabled=body.get("outbound_enabled"),
                    retention_days=body.get("retention_days"),
                    expected_settings_revision=body.get("expected_settings_revision"),
                ))

            if path == "/api/companion/memories":
                kind = str(body.get("kind") or "")
                text = str(body.get("text") or "")
                role_id = str(body.get("role_id") or companion_runtime.active_role()["role_id"])
                return self._send_json(200, companion_memory.set_preference(
                    profile_pk, role_id, kind, text,
                    expected_revision=body.get("expected_revision"),
                ))

            if path.startswith("/api/companion/memories/") and path.endswith("/edit"):
                parts = path.strip("/").split("/")
                memory_id = parts[3] if len(parts) > 3 else ""
                return self._send_json(200, companion_memory.set_preference(
                    profile_pk, str(body.get("role_id") or companion_runtime.active_role()["role_id"]),
                    str(body.get("kind") or ""), str(body.get("text") or ""),
                    expected_revision=body.get("expected_revision"),
                ))

            if path == "/api/companion/memory/clear":
                scope = str(body.get("scope") or "").strip()
                role_id = str(body.get("role_id") or "").strip()
                if scope == "account":
                    # 清空整个账号的记忆是破坏性操作，必须由用户显式确认。
                    if body.get("confirm") is not True:
                        return self._send_json(400, {
                            "error": "清空全部记忆需要显式确认", "code": "confirm_required"})
                    return self._send_json(200, companion_memory.clear_account(profile_pk))
                if scope == "role" or (not scope and role_id):
                    target_role = role_id or str(companion_runtime.active_role().get("role_id") or "")
                    if not target_role:
                        return self._send_json(400, {
                            "error": "没有可清空的角色记忆", "code": "invalid"})
                    return self._send_json(200, companion_memory.clear_role(profile_pk, target_role))
                # 不猜范围：默认静默清空会让用户丢数据。
                return self._send_json(400, {"error": "请指定清空范围", "code": "invalid"})

            import companion_sessions
            if path == "/api/companion/sessions":
                role = companion_runtime.active_role()
                study_day = companion_runtime.study_day()
                goal_kind = str(body.get("goal_kind") or "session_goal")
                target = body.get("target_count")
                return self._send_json(200, companion_sessions.open_session(
                    profile_pk=profile_pk, data_epoch=data_epoch, study_day=study_day,
                    task_key=companion_runtime.canonical_task_key(study_day, role["role_id"]),
                    goal_kind=goal_kind,
                    target_count=int(target) if isinstance(target, int) else None,
                    role_id=role["role_id"], role_name=role["role_name"],
                    binding=companion_runtime.identity_binding(context["account_key"]),
                    new_round=bool(body.get("new_round")),
                    operation_id=str(body.get("operation_id") or ""),
                ))

            if path.startswith("/api/companion/sessions/"):
                parts = path.strip("/").split("/")
                session_id = parts[3] if len(parts) > 3 else ""
                action = parts[4] if len(parts) > 4 else ""
                if action == "state":
                    return self._send_json(200, companion_sessions.set_state(
                        profile_pk=profile_pk, data_epoch=data_epoch, session_id=session_id,
                        action=str(body.get("action") or ""),
                        expected_revision=body.get("expected_revision"),
                        target_count=body.get("target_count"),
                    ))
                if action == "events":
                    return self._send_json(200, companion_sessions.record_events(
                        profile_pk=profile_pk, data_epoch=data_epoch, session_id=session_id,
                        events=body.get("events") or [],
                    ))
                if action == "heartbeat":
                    return self._send_json(200, companion_sessions.touch_lease(
                        profile_pk=profile_pk, data_epoch=data_epoch, session_id=session_id,
                        instance_id=str(body.get("instance_id") or ""),
                    ))
                if action == "reconcile":
                    import companion_progress_sources
                    snapshot = companion_progress_sources.build_snapshot(
                        profile_pk, data_epoch, companion_runtime.study_day(),
                        companion_runtime.canonical_task_key(),
                        body.get("raw_items") or [],
                        raw_count=body.get("raw_count"),
                        upstream_plan_known=bool(body.get("upstream_plan_known")),
                        source=str(body.get("source") or "official_today_items"),
                    )
                    return self._send_json(200, companion_sessions.reconcile(
                        profile_pk=profile_pk, data_epoch=data_epoch, session_id=session_id,
                        snapshot=snapshot,
                        binding=companion_runtime.identity_binding(context["account_key"]),
                    ))
                if action == "complete":
                    return self._send_json(200, companion_sessions.complete_session(
                        profile_pk=profile_pk, data_epoch=data_epoch, session_id=session_id,
                        expected_revision=body.get("expected_revision"),
                        evidence_refs=body.get("evidence_refs") or {},
                    ))
                return self._send_json(404, {"error": "未知接口"})

            return self._send_json(404, {"error": "未知接口"})
        except Exception as exc:
            return self._companion_error(exc)

    def _role_package_post(self, path, parsed):
        """角色包扫描/安装/队列与模型目录批量下载。"""
        import role_package_service
        body = self._read_json_body()
        if path == "/api/role-packages/inspect":
            sources = body.get("sources")
            if not isinstance(sources, list) or not sources:
                return self._send_json(400, {"error": "请至少选择一个角色包"})
            return self._send_json(200, role_package_service.inspect(sources))
        if path == "/api/role-packages/install":
            inspection_id = str(body.get("inspection_id") or "")
            selections = body.get("selections")
            if not inspection_id or not isinstance(selections, list):
                return self._send_json(400, {"error": "缺少扫描结果或角色选择"})
            return self._send_json(202, role_package_service.install(
                inspection_id, selections,
                conflict_policy=str(body.get("conflict_policy") or "keep_persona"),
            ))
        if path.startswith("/api/role-packages/jobs/") and path.endswith("/cancel"):
            return self._send_json(200, role_package_service.cancel(path.rstrip("/").split("/")[4]))
        if path == "/api/role-packages/uploads":
            return self._send_json(400, {
                "error": "浏览器上传需使用 multipart 通道，请使用桌面版原生多选",
                "code": "native_import_required",
            })
        if path == "/api/live2d/catalog-batches":
            live2d = globals().get("LIVE2D_SERVICE")
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            items = body.get("items")
            if not isinstance(items, list) or not items:
                return self._send_json(400, {"error": "请选择要下载的模型"})
            return self._send_json(202, live2d.start_catalog_batch(items, self._profile_id(required=False)))
        return self._send_json(404, {"error": "未知接口"})

    def _handle_api_get(self, path, parsed):
        # 与数据库无关的本地接口（运行模式 / 语音资源包状态）
        if path == "/api/app/current-mode":
            # 身份字段供 launcher 的健康判定核对（审计 P2-2）：
            # 只有 mode/data_dir 存在时，任何本机 HTTP 服务都可能被误判为当前实例。
            # app_id/build_version 让启动器能确认"这个端口上跑的是不是本应用、同版本"。
            try:
                from build_info import BUILD_VERSION
            except Exception:
                BUILD_VERSION = "unknown"
            return self._send_json(200, {
                "mode": _current_mode(),
                "is_frozen": bool(getattr(sys, "frozen", False)),
                # 只在诊断需要时给出完整路径；常规只读接口不外泄本机路径（审计 P3-2）。
                "data_dir": DATA_DIR if getattr(sys, "_MEMO_DIAGNOSTICS", False) else "",
                "app_id": "memo-superform",
                "build_version": BUILD_VERSION,
            })

        if path in ("/api/app/update-status", "/api/app/update/check"):
            manager = globals().get("UPDATE_MANAGER")
            if manager is None:
                return self._send_json(503, {"error": "更新服务未就绪"})
            query = parse_qs(parsed.query)
            force = query.get("force", ["0"])[0] == "1"
            return self._send_json(200, manager.get_status(force=force))

        if path == "/api/tts/status":
            import tts
            status = tts.get_status(TTS_PACK_DIR, DATA_DIR)
            status["mounting"] = _tts_pack_mount_active()
            live2d = globals().get("LIVE2D_SERVICE")
            if live2d and status.get("active_role_id"):
                binding = self._active_role_live2d_binding(live2d)
                status["live2d_role_ready"] = bool(binding.get("ready"))
                if not binding.get("ready"):
                    status["role_ready"] = False
                    status["role_error"] = binding.get("reason") or "当前角色绑定的 Live2D 模型不可用"
            return self._send_json(200, status)

        if path.startswith("/api/tts/mount-pack/jobs/"):
            import tts
            job_id = path.rsplit("/", 1)[-1]
            if not job_id:
                return self._send_json(404, {"error": "未指定语音包安装任务"})
            try:
                return self._send_json(200, _tts_pack_mount_manager().get_job(job_id))
            except tts.TTSException as exc:
                return self._send_json(404, {"error": str(exc)})

        if path == "/api/tts/roles":
            import tts
            library = tts.list_roles(TTS_PACK_DIR)
            live2d = globals().get("LIVE2D_SERVICE")
            if live2d:
                for role in library.get("roles") or []:
                    model_id = str(role.get("live2d_model_id") or "")
                    if not model_id:
                        continue
                    try:
                        model = live2d.validate_model(model_id)
                        # 这个只读标注让浏览器把旧角色 ID 人设迁入各自的角色清单，
                        # 同时不允许 Live2D 模型在运行时决定当前人设。
                        role["live2d_character_id"] = str(model.get("character_id") or "")
                    except Exception:
                        missing = list(role.get("missing") or [])
                        if "Live2D 模型（不可用）" not in missing:
                            missing.append("Live2D 模型（不可用）")
                        role["missing"] = missing
                        role["complete"] = False
            return self._send_json(200, library)

        if path == "/api/codex/status":
            return self._send_json(200, CODEX_OAUTH.status())

        if path == "/api/maimemo-auth/status":
            service = globals().get("MAIMEMO_OAUTH")
            if service is None:
                return self._send_json(503, {"error": "墨墨账号服务未就绪"})
            return self._send_json(200, service.status())

        live2d = globals().get("LIVE2D_SERVICE")
        if path.startswith("/api/live2d/assets/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            parts = path.split("/")
            if len(parts) < 6:
                return self._send_json(404, {"error": "模型资源不存在"})
            try:
                asset = live2d.asset_path(parts[4], "/".join(parts[5:]))
                self.send_response(200)
                self.send_header("Content-Type", live2d.asset_content_type(asset))
                self.send_header("Content-Length", str(asset.stat().st_size))
                self.send_header("Cache-Control", "private, max-age=3600")
                self.end_headers()
                with open(asset, "rb") as handle:
                    while chunk := handle.read(64 * 1024):
                        self.wfile.write(chunk)
                return
            except Exception as exc:
                return self._send_json(404, {"error": str(exc)})

        if path == "/api/live2d/catalog":
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            query = parse_qs(parsed.query)
            try:
                return self._send_json(200, live2d.catalog(query.get("q", [""])[0], query.get("refresh", ["0"])[0] == "1"))
            except Exception as exc:
                return self._send_json(502, {"error": str(exc)})

        if path == "/api/live2d/models":
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            data = live2d.list_models(self._profile_id(required=False))
            data["role_binding"] = self._active_role_live2d_binding(live2d)
            return self._send_json(200, data)

        if path.startswith("/api/live2d/downloads/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            return self._send_json(200, live2d.download_status(path.rsplit("/", 1)[-1]))

        if path.startswith("/api/live2d/catalog-batches/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            return self._send_json(200, live2d.catalog_batch_status(path.rsplit("/", 1)[-1]))

        # ---- 陪伴升级：记忆、角色包、学习会话 ----
        companion = self._companion_get(path, parsed)
        if companion is not None:
            return companion

        # ---- 文章选词：状态查询（只读）----
        # 注意：这个路由自己用 `_send_json` 写响应、返回 `None`。
        # 若像下面这样用 `if result is not None` 判断，`None` 会被误判成
        # "不属于本模块"，于是继续往下走并**再发一个 404** —— 第二个响应的
        # 状态行会塞进第一个响应的 body，客户端 `response.json()` 直接炸。
        # 所以先判前缀：属于本模块的一律直接返回，不再往下走。
        if path.startswith("/api/article-vocab/"):
            return self._article_vocab_get(path, parsed)

        known_db_paths = {
            "/api/recommendations/today",
            "/api/stats/history",
            "/api/db/status",
            "/api/study-records",
            "/api/study-sync/status",
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
            if path == "/api/study-records":
                profile_id = self._profile_id(required=True)
                if not profile_id:
                    return
                records = db.get_records(profile_id)
                state = db.get_sync_state(profile_id)
                return self._send_json(200, {"records": records, "count": len(records), "sync": state})

            # ---- 近期词汇阅读：服务端存档（归属由本机账号派生，客户端不能自选）----
            if path == "/api/reading/practices":
                profile_id = self._profile_id(required=True)
                if not profile_id:
                    return
                return self._send_json(200, {"practices": db.list_reading_practices(profile_id)})

            if path.startswith("/api/reading/practices/"):
                profile_id = self._profile_id(required=True)
                if not profile_id:
                    return
                practice_id = path[len("/api/reading/practices/"):].split("/")[0]
                if not practice_id:
                    return self._send_json(400, {"error": "缺少练习标识"})
                practice = db.get_reading_practice(profile_id, practice_id)
                if practice is None:
                    return self._send_json(404, {"error": "没有这份练习"})
                return self._send_json(200, {"practice": practice})

            if path == "/api/reading/attempts":
                profile_id = self._profile_id(required=True)
                if not profile_id:
                    return
                return self._send_json(200, {"attempts": db.list_reading_attempts(profile_id)})

            if path == "/api/study-sync/status":
                token, profile_id = self._memo_identity(required=True)
                if not token or not profile_id:
                    return
                persistent = db.get_sync_state(profile_id)
                live = STUDY_SYNC_MANAGER.status(profile_id) if STUDY_SYNC_MANAGER else {
                    "status": "unavailable", "active": False, "error": "同步服务未就绪"
                }
                result = dict(persistent)
                result.update(live)
                # records_count 是 SQLite 已提交的完整状态，不只是本次拉取数量。
                # 用 COUNT(*) 而不是 len(get_records())：状态接口只需要数量，
                # 不需要把 11 个投影列全部取出、按 NOCASE 排序并构造 10 键 dict 列表。
                # 语义与 get_records() 一致（同样按 profile_id + is_active=1 过滤），
                # 由 tests/perf/test_record_count_equivalence.py 逐场景对照。
                result["records_count"] = db.get_record_count(profile_id)
                if persistent.get("needs_reconcile"):
                    result["needs_reconcile"] = True
                return self._send_json(200, result)

            if path == "/api/recommendations/today":
                profile_id = self._profile_id(required=False)
                recs = recommender.get_today_recommendations(profile_id)
                summary = recommender.get_recommendation_summary(profile_id)
                return self._send_json(200, {"recommendations": recs, "summary": summary})

            if path == "/api/stats/history":
                return self._send_json(200, {"stats": db.get_history_stats(days, self._profile_id(required=False))})

            if path == "/api/db/status":
                profile_id = self._profile_id(required=False)
                return self._send_json(200, {
                    "db_ready": True,
                    "engine": "sqlite",
                    "database_path": db.database_path(),
                    "has_snapshot": db.has_today_snapshot(profile_id),
                    "has_recommendations": db.has_today_recommendations(profile_id),
                })

        except Exception as e:
            traceback.print_exc()
            return self._send_json(500, {"error": str(e)})

    # ===================== /api/* 写入 =====================
    def _handle_api_post(self, path, parsed):
        try:
            # 写接口 CSRF 防护：要求自定义头（跨域简单请求无法携带，
            # 会触发 CORS 预检并被同源策略拦截）
            if self.headers.get("X-Requested-With") != "XMLHttpRequest":
                return self._send_json(403, {"error": "缺少 X-Requested-With 头"})
            if path == "/api/tts/import-model":
                # 角色包之前的客户端可在此写入任意 pack.json 音色目录；继续保留
                # 该入口会重新引入模型与参考音频混用。
                return self._send_json(410, {
                    "error": "旧模型上传入口已移除；请在角色编辑器中上传模型文件",
                    "migration": "使用 /api/tts/roles/<role_id>/upload",
                })
            if path == "/api/tts/mount-pack":
                return self._mount_tts_pack_archive(parsed)
            if path.startswith("/api/tts/") and _tts_pack_mount_active():
                return self._send_json(409, {
                    "error": "语音包正在后台挂载，请等待安装完成后再操作语音资料",
                    "mounting": True,
                })
            if path == "/api/tts/repair":
                import tts
                try:
                    return self._send_json(200, tts.repair_environment(TTS_PACK_DIR, DATA_DIR))
                except tts.TTSException as exc:
                    return self._send_json(400, {"error": str(exc)})
            if path.startswith("/api/tts/roles/") and path.endswith("/upload"):
                return self._upload_tts_role_file(path, parsed)
            # 陪伴升级的写入口自带来源校验与正文上限，且不使用 JSON body 之外的
            # 上传流；放在通用 JSON 解析之前，避免上传路径被误判。
            if path.startswith("/api/companion/") or path.startswith("/api/role-packages/"):
                return self._companion_post(path, parsed)
            # 文章选词：自带 body 解析与账号/代次校验，放在通用 JSON 解析之前。
            if path.startswith("/api/article-vocab/"):
                return self._article_vocab_post(path, parsed)
            try:
                body = self._read_json_body()
            except (json.JSONDecodeError, ValueError):
                return self._send_json(400, {"error": "Invalid JSON body"})

            if path.startswith("/api/tts/roles/") and path.endswith("/persona"):
                import tts
                role_id = path.split("/")[-2]
                try:
                    role = tts.update_role_persona(TTS_PACK_DIR, role_id, body.get("persona"))
                    return self._send_json(200, {"ok": True, "role": role})
                except tts.TTSException as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path.startswith("/api/tts/roles/") and path.endswith("/begin-update"):
                import tts
                role_id = path.split("/")[-2]
                try:
                    return self._send_json(200, {"ok": True, "batch_id": tts.begin_role_update(TTS_PACK_DIR, role_id)})
                except tts.TTSException as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path.startswith("/api/tts/roles/") and path.endswith("/discard-update"):
                import tts
                role_id = path.split("/")[-2]
                try:
                    return self._send_json(200, {
                        "ok": tts.discard_role_update(TTS_PACK_DIR, role_id, body.get("batch_id")),
                    })
                except tts.TTSException as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path.startswith("/api/tts/roles/") and path.endswith("/commit-update"):
                import tts
                role_id = path.split("/")[-2]
                live2d = globals().get("LIVE2D_SERVICE")
                try:
                    with _role_live2d_lock:
                        active_id = tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""
                        is_active = role_id == active_id
                        live2d_id = str(body.get("live2d_model_id") or "")
                        if live2d_id:
                            if not live2d:
                                return self._send_json(503, {"error": "Live2D 服务未就绪"})
                            live2d.validate_model(live2d_id)
                        if is_active and not live2d_id:
                            return self._send_json(400, {"error": "当前已启用角色必须绑定可用的 Live2D 模型"})

                        def sync_live2d(role):
                            # 此回调同时处于协调锁和 tts.py 角色锁内，因而读取的是
                            # 正在提交的准确清单，而非并发请求留下的过期当前角色快照。
                            committed_active = tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""
                            if role["role_id"] == committed_active:
                                if not live2d:
                                    raise RuntimeError("Live2D 服务未就绪")
                                live2d.set_active(self._profile_id(required=False), role["live2d_model_id"], True)

                        role = tts.commit_role_update(
                            TTS_PACK_DIR, role_id, body.get("batch_id"), body, after_commit=sync_live2d
                        )
                    return self._send_json(200, {"ok": True, "role": role})
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            # ---- 近期词汇阅读：服务端存档与判分归属 ----
            # 归属一律由 _profile_id() 按本机当前账号派生；请求体里的任何
            # accountScope 字段都被忽略，客户端不能靠自选字符串读到别人的数据。
            if path == "/api/reading/practices":
                profile_id = self._profile_id(required=True)
                if not profile_id:
                    return
                practice = body.get("practice")
                if not isinstance(practice, dict):
                    return self._send_json(400, {"error": "practice 必须是对象"})
                try:
                    practice_id = db.save_reading_practice(profile_id, practice)
                except ValueError as exc:
                    return self._send_json(400, {"error": str(exc)})
                return self._send_json(200, {"ok": True, "practiceId": practice_id})

            if path == "/api/reading/attempts":
                profile_id = self._profile_id(required=True)
                if not profile_id:
                    return
                attempt = body.get("attempt")
                if not isinstance(attempt, dict):
                    return self._send_json(400, {"error": "attempt 必须是对象"})
                practice_id = str(attempt.get("practiceId") or "").strip()
                attempt_key = str(attempt.get("attemptKey") or "")
                # 防重复记分：同一 practice_id + attempt_key 已存在就直接返回旧记录，
                # 与客户端本地去重语义保持一致（连点不重复，重做换 key 才新增）。
                if practice_id and attempt_key:
                    existing = db.find_reading_attempt(profile_id, practice_id, attempt_key)
                    if existing:
                        return self._send_json(200, {
                            "ok": True, "duplicate": True,
                            "attemptId": str(attempt.get("id") or ""),
                            "result": existing["result"],
                        })
                try:
                    attempt_id = db.save_reading_attempt(profile_id, attempt)
                except ValueError as exc:
                    return self._send_json(400, {"error": str(exc)})
                return self._send_json(200, {"ok": True, "attemptId": attempt_id})

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

            if path == "/api/app/update/download":
                manager = globals().get("UPDATE_MANAGER")
                if manager is None:
                    return self._send_json(503, {"error": "更新服务未就绪"})
                try:
                    state = manager.start_download()
                    code = 202 if state.get("state") == "downloading" else 200
                    return self._send_json(code, {"ok": True, "download": state})
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/app/update/apply":
                manager = globals().get("UPDATE_MANAGER")
                apply_update = globals().get("_apply_update")
                if manager is None or not callable(apply_update):
                    return self._send_json(503, {"error": "更新服务未就绪"})
                try:
                    staged = manager.prepare_apply()
                    # 更新前先结束常驻的 GPT-SoVITS worker。它本身不会持有主 EXE，
                    # 但可避免更新重启后遗留一份旧角色/旧模型的后台推理进程。
                    try:
                        import tts
                        tts.shutdown(TTS_PACK_DIR, DATA_DIR)
                    except Exception:
                        pass
                    ok, msg = apply_update(staged)
                    if not ok:
                        manager.apply_failed(msg)
                        return self._send_json(400, {"error": msg})
                    return self._send_json(200, {"ok": True, "installing": True, "message": msg})
                except Exception as exc:
                    manager.apply_failed(str(exc))
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/codex/login":
                try:
                    return self._send_json(200, CODEX_OAUTH.start_login())
                except Exception as e:
                    return self._send_json(500, {"error": str(e)})

            if path == "/api/codex/logout":
                CODEX_OAUTH.logout()
                return self._send_json(200, {"ok": True})

            if path == "/api/maimemo-auth/start":
                service = globals().get("MAIMEMO_OAUTH")
                if service is None:
                    return self._send_json(503, {"error": "墨墨账号服务未就绪"})
                try:
                    return self._send_json(200, service.start_login())
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/maimemo-auth/manual-token":
                service = globals().get("MAIMEMO_OAUTH")
                if service is None:
                    return self._send_json(503, {"error": "墨墨账号服务未就绪"})
                try:
                    status = service.set_manual_token(str(body.get("token") or ""))
                    return self._send_json(200, status)
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/maimemo-auth/disconnect":
                service = globals().get("MAIMEMO_OAUTH")
                if service is None:
                    return self._send_json(503, {"error": "墨墨账号服务未就绪"})
                try:
                    service.disconnect()
                    return self._send_json(200, {"ok": True, "data_preserved": True})
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            # 语音资源包接口（与数据库无关）
            if path == "/api/tts/roles":
                import tts
                live2d_id = str(body.get("live2d_model_id") or "")
                live2d = globals().get("LIVE2D_SERVICE")
                try:
                    with _role_live2d_lock:
                        # 任一侧变化前先同时校验两侧；编辑当前角色时尤其重要，
                        # TTS 与 Live2D 绑定必须同步推进。
                        preview = tts.preview_role_save(TTS_PACK_DIR, body)
                        active_id = tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""
                        is_active = preview["role_id"] == active_id
                        if live2d_id:
                            if not live2d:
                                return self._send_json(503, {"error": "Live2D 服务未就绪"})
                            live2d.validate_model(live2d_id)

                        def sync_live2d(role):
                            if role["role_id"] != (tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""):
                                return
                            if not live2d:
                                raise RuntimeError("Live2D 服务未就绪")
                            live2d.set_active(self._profile_id(required=False), role["live2d_model_id"], True)

                        role = tts.save_role(TTS_PACK_DIR, body, after_commit=sync_live2d if is_active else None)
                    return self._send_json(200, {"ok": True, "role": role})
                except Exception as exc:
                    # 此路由以校验为主；模型绑定不可用或过期时返回可操作的 4xx，
                    # 不向角色编辑器显示笼统的服务端失败。
                    return self._send_json(400, {"error": str(exc)})

            if path.startswith("/api/tts/roles/") and path.endswith("/activate"):
                import tts
                role_id = path.split("/")[-2]
                try:
                    with _role_live2d_lock:
                        candidate = tts.get_role(TTS_PACK_DIR, role_id, require_complete=True)
                        live2d = globals().get("LIVE2D_SERVICE")
                        if not live2d:
                            return self._send_json(503, {"error": "Live2D 服务未就绪"})
                        # 提交前先校验。``after_commit`` 在 tts.py 的角色锁内运行；
                        # 渲染器偏好写入失败时会一并回滚清单。
                        live2d.validate_model(candidate["live2d_model_id"])
                        role = tts.activate_role(
                            TTS_PACK_DIR,
                            role_id,
                            after_commit=lambda activated: live2d.set_active(
                                self._profile_id(required=False), activated["live2d_model_id"], True
                            ),
                        )
                    return self._send_json(200, {"ok": True, "role": role})
                except Exception as exc:
                    return self._send_json(400, {"error": str(exc)})

            if path == "/api/tts/speak":
                import tts
                try:
                    live2d = globals().get("LIVE2D_SERVICE")
                    if live2d:
                        binding = self._active_role_live2d_binding(live2d)
                        if not binding.get("ready"):
                            return self._send_json(409, {"error": binding.get("reason") or "当前角色的 Live2D 模型不可用"})
                    wav_path = tts.speak(
                        TTS_PACK_DIR,
                        DATA_DIR,
                        body.get("text", ""),
                        # 当前角色是唯一允许的合成来源。忽略旧客户端残留的 `voice`
                        # 字段，绝不让它另选资料包。
                        voice=None,
                        language=body.get("language"),
                        speed=body.get("speed"),
                        top_k=body.get("top_k"),
                        fragment_interval=body.get("fragment_interval"),
                        text_split_method=body.get("text_split_method"),
                        seed=body.get("seed"),
                        use_cuda_graph=body.get("use_cuda_graph"),
                        parallel_infer=body.get("parallel_infer"),
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
                    live2d = globals().get("LIVE2D_SERVICE")
                    if live2d:
                        binding = self._active_role_live2d_binding(live2d)
                        if not binding.get("ready"):
                            return self._send_json(400, {"error": binding.get("reason") or "请先修复当前角色的 Live2D 模型绑定"})
                    state = tts.set_enabled(TTS_PACK_DIR, DATA_DIR, True)
                    return self._send_json(200, {
                        "ok": True,
                        "enabled": True,
                        "active_role_id": tts.list_roles(TTS_PACK_DIR).get("active_role_id") or "",
                    })
                except tts.TTSException as e:
                    return self._send_json(400, {"error": str(e)})

            if path == "/api/tts/disable":
                import tts
                tts.set_enabled(TTS_PACK_DIR, DATA_DIR, False)
                return self._send_json(200, {"ok": True, "enabled": False})

            if path == "/api/tts/preload":
                import tts
                try:
                    live2d = globals().get("LIVE2D_SERVICE")
                    if live2d:
                        binding = self._active_role_live2d_binding(live2d)
                        if not binding.get("ready"):
                            return self._send_json(409, {"error": binding.get("reason") or "当前角色的 Live2D 模型不可用"})
                    tts.preload(TTS_PACK_DIR, DATA_DIR, voice=None)
                    return self._send_json(200, {"ok": True})
                except tts.TTSException as e:
                    return self._send_json(400, {"error": str(e)})

            if path == "/api/tts/shutdown":
                import tts
                tts.shutdown(TTS_PACK_DIR, DATA_DIR)
                return self._send_json(200, {"ok": True})

            live2d = globals().get("LIVE2D_SERVICE")
            if path == "/api/live2d/download":
                if not live2d:
                    return self._send_json(503, {"error": "Live2D 服务未就绪"})
                model_name = str(body.get("catalog_name") or "")
                if not model_name:
                    return self._send_json(400, {"error": "缺少 catalog_name"})
                return self._send_json(202, live2d.start_download(model_name, self._profile_id(required=False)))

            if path == "/api/live2d/import":
                if not live2d:
                    return self._send_json(503, {"error": "Live2D 服务未就绪"})
                return self._send_json(200, live2d.import_directory(str(body.get("source_path") or ""), self._profile_id(required=False)))

            if path == "/api/live2d/active":
                if not live2d:
                    return self._send_json(503, {"error": "Live2D 服务未就绪"})
                with _role_live2d_lock:
                    enabled = body.get("companion_enabled")
                    if enabled is not None and not isinstance(enabled, bool):
                        return self._send_json(400, {"error": "companion_enabled 必须是布尔值"})
                    binding = self._active_role_live2d_binding(live2d)
                    if not binding.get("ready"):
                        return self._send_json(409, {"error": binding.get("reason") or "请先启用资料完整的角色"})
                    requested_id = str(body.get("model_id") or "").strip()
                    if requested_id and requested_id != binding["active_model_id"]:
                        return self._send_json(409, {
                            "error": "Live2D 由当前已启用角色绑定；请在角色编辑器中更换模型后再启用角色",
                        })
                    # 旧客户端仍可能用此路由打开或关闭陪伴模式。保留该开关，但始终
                    # 把保存的模型偏好归一到当前角色绑定。
                    return self._send_json(200, live2d.set_active(
                        self._profile_id(required=False), binding["active_model_id"], enabled
                    ))

            if path == "/api/study-sync":
                if not DB_READY or not STUDY_SYNC_MANAGER:
                    return self._send_json(503, {"error": "同步服务未就绪"})
                token, profile_id = self._memo_identity(required=True)
                if not token or not profile_id:
                    return
                mode = str(body.get("mode") or "incremental")
                if mode not in ("incremental", "bootstrap", "reconcile"):
                    return self._send_json(400, {"error": "mode 必须是 incremental、bootstrap 或 reconcile"})
                reason = str(body.get("reason") or "manual")[:80]
                seed_records = body.get("seed_records")
                if seed_records is not None and not isinstance(seed_records, list):
                    return self._send_json(400, {"error": "seed_records 必须是数组"})
                if isinstance(seed_records, list) and len(seed_records) > 200000:
                    return self._send_json(413, {"error": "seed_records 数量过大"})
                self._start_legacy_import_once(profile_id)
                # 浏览器仅在检查可见性、拖拽、设置/全屏和学习状态后发送 startup-idle；
                # 是否确实已过七天由服务端状态决定。
                sync_state = db.get_sync_state(profile_id)
                if (mode == "incremental" and reason == "startup-idle" and
                        sync_state.get("bootstrap_complete") and
                        STUDY_SYNC_SERVICE.should_run_weekly_reconcile(profile_id)):
                    mode, reason = "reconcile", "weekly"
                started = STUDY_SYNC_MANAGER.start(
                    token, mode, reason=reason, seed_records=seed_records, profile_id=profile_id
                )
                return self._send_json(202, started)

            # 保存当日快照并生成推荐
            if path == "/api/snapshot":
                records = body.get("records", []) or []
                if not isinstance(records, list):
                    return self._send_json(400, {"error": "records 必须是数组"})
                if not DB_READY:
                    return self._send_json(503, {"error": "数据库未就绪"})
                profile_id = self._profile_id(required=False)
                force = bool(body.get("force"))
                if not force and db.has_today_snapshot(profile_id) and db.has_today_recommendations(profile_id):
                    return self._send_json(200, {
                        "skipped": True,
                        "summary": recommender.get_recommendation_summary(profile_id),
                    })
                n = db.save_snapshot(records, profile_id)
                stats = db.compute_and_save_daily_stats(profile_id=profile_id)
                cnt = recommender.generate_recommendations(30, profile_id)
                return self._send_json(200, {
                    "skipped": False,
                    "saved": n,
                    "recommendations": cnt,
                    "stats": stats,
                    "summary": recommender.get_recommendation_summary(profile_id),
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
                rc = recommender.mark_reviewed(rec_id, self._profile_id(required=False))
                if not rc:
                    return self._send_json(404, {"error": "推荐记录不存在"})
                return self._send_json(200, {"ok": True, "updated": rc})

            return self._send_json(404, {"error": "未知接口"})
        except Exception as e:
            traceback.print_exc()
            return self._send_json(500, {"error": str(e)})

    def _upload_tts_role_file(self, path, parsed):
        """把上传的角色资源写入清单支持的规范路径。"""
        import tts
        parts = path.strip("/").split("/")
        if len(parts) != 5 or parts[:3] != ["api", "tts", "roles"] or parts[4] != "upload":
            return self._send_json(404, {"error": "未知接口"})
        query = parse_qs(parsed.query)
        kind = (query.get("kind") or [""])[0]
        name = (query.get("name") or [""])[0]
        batch_id = (query.get("batch") or [""])[0]
        length = self._safe_content_length()
        if length > tts.TTS_ROLE_UPLOAD_MAX_BYTES:
            return self._send_json(413, {
                "error": "角色资料文件超过允许大小，请使用完整语音包 ZIP 原生导入",
                "max_bytes": tts.TTS_ROLE_UPLOAD_MAX_BYTES,
            })
        try:
            if batch_id:
                staged = tts.stage_role_file_stream(
                    TTS_PACK_DIR, parts[3], batch_id, kind, name, self.rfile, length
                )
                return self._send_json(200, {"ok": True, "staged": staged})
            active_id = tts.list_roles(TTS_PACK_DIR).get("active_role_id") or ""
            if parts[3] == active_id:
                return self._send_json(409, {
                    "error": "当前已启用角色必须通过一次性角色更新保存，避免模型与参考资料半更新",
                })
            role = tts.upload_role_file_stream(
                TTS_PACK_DIR, parts[3], kind, name, self.rfile, length
            )
            return self._send_json(200, {"ok": True, "role": role})
        except tts.TTSException as exc:
            return self._send_json(400, {"error": str(exc)})

    def _mount_tts_pack_archive(self, parsed):
        """网页模式的小包后备入口；真正安装交给后台任务。"""
        import tts
        query = parse_qs(parsed.query)
        source_name = (query.get("name") or [""])[0]
        # 名称只用于显示，实际内容由 tts.py 的 ZIP 解析器校验。此处保留扩展名
        # 检查，让拖错文件在可能数 GB 的上传开始前就得到提示。
        if source_name and not source_name.lower().endswith(".zip"):
            return self._send_json(400, {"error": "请拖入完整的语音包 ZIP 文件"})
        content_length = self._safe_content_length()
        if content_length > tts.TTS_PACK_WEB_UPLOAD_MAX_BYTES:
            return self._send_json(413, {
                "error": "浏览器模式仅支持不超过 256 MiB 的语音包，请使用桌面 EXE 原生导入",
                "requires_native_import": True,
                "max_bytes": tts.TTS_PACK_WEB_UPLOAD_MAX_BYTES,
            })
        try:
            job = _tts_pack_mount_manager().start_stream(
                self.rfile,
                content_length,
                source_name=source_name,
            )
            return self._send_json(202, {"ok": True, "job_id": job["job_id"], "job": job})
        except tts.TTSException as exc:
            return self._send_json(400, {"error": str(exc)})

    # ===================== /api/* 删除 =====================
    def _handle_api_delete(self, path, parsed):
        if self.headers.get("X-Requested-With") != "XMLHttpRequest":
            return self._send_json(403, {"error": "缺少 X-Requested-With 头"})
        if path.startswith("/api/tts/") and _tts_pack_mount_active():
            return self._send_json(409, {
                "error": "语音包正在后台挂载，请等待安装完成后再操作语音资料",
                "mounting": True,
            })
        live2d = globals().get("LIVE2D_SERVICE")
        if path.startswith("/api/tts/roles/"):
            import tts
            role_id = path.rsplit("/", 1)[-1]
            try:
                return self._send_json(200, {"ok": tts.delete_role(TTS_PACK_DIR, role_id)})
            except tts.TTSException as exc:
                return self._send_json(400, {"error": str(exc)})
        if path.startswith("/api/live2d/downloads/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            return self._send_json(200, live2d.cancel_download(path.rsplit("/", 1)[-1]))
        if path.startswith("/api/live2d/models/"):
            if not live2d:
                return self._send_json(503, {"error": "Live2D 服务未就绪"})
            try:
                # 请求执行期间角色可能绑定该模型；删除操作需与所有角色/渲染器切换
                # 协调，使校验和引用检查始终观察同一份一致状态。
                with _role_live2d_lock:
                    deleted = live2d.delete_model(path.rsplit("/", 1)[-1])
                return self._send_json(200 if deleted else 404, {"ok": deleted})
            except Exception as exc:
                return self._send_json(400, {"error": str(exc)})
        if path.startswith("/api/reading/practices/"):
            if not DB_READY:
                return self._send_json(503, {"error": "数据库未就绪"})
            profile_id = self._profile_id(required=True)
            if not profile_id:
                return
            practice_id = path[len("/api/reading/practices/"):].split("/")[0]
            if not practice_id:
                return self._send_json(400, {"error": "缺少练习标识"})
            try:
                removed = db.delete_reading_practice(profile_id, practice_id)
            except Exception as exc:
                return self._send_json(500, {"error": str(exc)})
            return self._send_json(200 if removed else 404, {"ok": bool(removed), "removed": removed})
        if path == "/api/maimemo-auth/data":
            if not DB_READY:
                return self._send_json(503, {"error": "数据库未就绪"})
            profile_id = self._profile_id(required=True)
            if not profile_id:
                return
            try:
                deleted = (STUDY_SYNC_MANAGER.delete_profile_data(profile_id, db.delete_profile_learning_data)
                           if STUDY_SYNC_MANAGER else db.delete_profile_learning_data(profile_id))
                return self._send_json(200, {"ok": True, "deleted": deleted})
            except Exception as exc:
                return self._send_json(409 if isinstance(exc, study_sync.StudySyncError) else 500, {"error": str(exc)})
        if path != "/api/study-sync/current":
            return self._send_json(404, {"error": "未知接口"})
        if not STUDY_SYNC_MANAGER:
            return self._send_json(503, {"error": "同步服务未就绪"})
        _token, profile_id = self._memo_identity(required=True)
        if not profile_id:
            return
        return self._send_json(200, STUDY_SYNC_MANAGER.cancel(profile_id))

