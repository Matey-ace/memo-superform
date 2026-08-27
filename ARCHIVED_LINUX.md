# Linux 支持归档（不再维护）

此分支 `codex/linux-archived` **只保留 Linux 相关的构建与运行支持**，供需要 Linux 版本的开发者/用户使用。

> **状态：不再主动维护。** 主分支已停止维护 Linux 支持，相关文件与说明已归档到本分支。

## 本分支保留的 Linux 内容

- `build_linux.sh`：在 Linux 上打包单文件 `dist/MemoSuperform`。
- `launcher-linux.sh`：Linux 下的启动脚本（`./launcher-linux.sh web|desktop`）。
- `requirements-linux.txt`：Linux 依赖列表。
- `README.md` 中的「Linux 支持 / Linux Support」章节。
- `tts.py` 中 `.venv311/bin/python` 的 Linux 路径适配与安装提示。

## 说明

- 主分支（Windows 交付）中的上述内容已删除，并在对应位置标注“已归档到本分支”。
- 本分支不做功能迭代，仅作为历史/能力保留；遇到问题请以主分支（Windows 版）为准。
