# 第三方组件声明 / Third-Party Notices

Memo Superform 的自有源码按仓库根目录 `LICENSE` 中的 AGPL-3.0 发布。下列第三方
组件、参考实现、运行时与字体仍分别遵循其上游许可证；本文件不改变任何上游权利。

Memo Superform's original source is released under AGPL-3.0 as described by the
root `LICENSE`. The third-party components, referenced implementations,
runtimes, and fonts below remain under their respective upstream terms.

## Live2D 在线目录与下载流程 / Live2D catalogue and download flow

Memo Superform 的 Bestdori 目录读取、Cubism 2 文件下载与 `model.json` 组装流程，
参考并以 Python 重新实现了
[A-kirami/bestdori-live2d-downloader](https://github.com/A-kirami/bestdori-live2d-downloader)
中的相应逻辑。参考范围包括：读取 Bestdori 角色/资源目录、筛选 `_general` 模型、
下载 moc/贴图/动作/表情/物理文件，以及生成 Cubism 2 描述文件。Memo Superform
另行实现了本地 HTTP API、SQLite 注册表、路径与大小校验、取消/轮询、原子安装与
失败回滚、角色绑定及设置界面。

Memo Superform's Bestdori catalogue parsing, Cubism 2 asset download, and
`model.json` assembly flow was reimplemented in Python with reference to the
corresponding logic in
[A-kirami/bestdori-live2d-downloader](https://github.com/A-kirami/bestdori-live2d-downloader).
The referenced scope is limited to reading the Bestdori character/asset
catalogue, selecting `_general` models, downloading moc/textures/motions/
expressions/physics assets, and assembling a Cubism 2 descriptor. Memo
Superform independently implements its HTTP API, SQLite registry, path and size
validation, cancellation/polling, atomic installation and rollback, role
binding, and settings UI.

Upstream copyright: Copyright (c) 2023 Akirami. License: MIT (full text below).

[Bestdori](https://bestdori.com/) provides the remote catalogue and asset
service used by this optional user-triggered downloader. Memo Superform does
not bundle character models. Copyright and permitted use of downloaded models,
illustrations, audio, names, and other game assets remain with their respective
owners; users are responsible for following the source service and rights
holders' terms.

## 前端渲染组件 / Front-end rendering components

- Apache ECharts 5.5.0 — Copyright 2017-2024 The Apache Software Foundation,
  Apache License 2.0. Bundled as `vendor/echarts.min.js`; its license, NOTICE,
  and embedded d3 BSD terms are in `vendor/echarts-LICENSE.txt`,
  `vendor/echarts-NOTICE.txt`, and `vendor/echarts-LICENSE-d3.txt`.
- PixiJS 6.5.10 — Copyright (c) 2013-2017 Mathew Groves, Chad Engler, MIT
  License. Bundled as `vendor/live2d/pixi-6.5.10.min.js`; its full license is in
  `vendor/live2d/pixi-LICENSE.txt`.
- pixi-live2d-display 0.4.0 — Copyright (c) 2020 Guan, MIT License. Bundled as
  `vendor/live2d/pixi-live2d-display-0.4.0.min.js`; its upstream license is in
  `vendor/live2d/pixi-live2d-display-LICENSE`.
- Live2D Cubism Core for Web — Copyright Live2D Inc.; Live2D Proprietary
  Software License. Bundled as `vendor/live2d/live2dcubismcore.min.js`. See
  <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>.
- Legacy Live2D Cubism 2 WebGL runtime — Live2D runtime used only for rendering
  user-selected local Cubism 2 models. Bundled as
  `vendor/live2d/live2d-2.1.min.js`; Live2D's applicable SDK/runtime terms and
  <https://www.live2d.com/eula/> continue to apply.

## 本地字体 / Local fonts

- Noto Sans SC and Noto Serif SC subsets — Copyright 2014-2021 Adobe, with
  Reserved Font Name "Source"; SIL Open Font License 1.1.
- M PLUS Rounded 1c subsets — Copyright (C) 2002-2015 M+ FONTS PROJECT /
  Coji Morishita; SIL Open Font License 1.1.

The common OFL 1.1 text and font-specific notices are included in
`fonts/OFL-1.1.txt`. The WOFF2 subsets remain font software under that license.

## 桌面运行时 / Desktop runtime

The packaged desktop application uses
[pywebview](https://github.com/r0x0r/pywebview), BSD 3-Clause License,
Copyright (c) 2014-2017 Roman Sirokov. The full BSD notice appears below.

## 可选旧数据库迁移依赖 / Optional legacy-database migration dependency

旧 SQL Server 数据只读迁移器会在系统已安装时按需导入
[mkleehammer/pyodbc](https://github.com/mkleehammer/pyodbc)。它不是启动所需依赖，
源码模式可自行安装；发布 EXE 会显式排除它，以控制包体。其上游采用 MIT-0 许可证，
完整文本见下文。

The read-only legacy SQL Server migration path imports
[mkleehammer/pyodbc](https://github.com/mkleehammer/pyodbc) only when it is
already installed. It is not required for startup and is not included in the
release EXE, which explicitly excludes it to control package size. Upstream
pyodbc uses the MIT-0 License; the full text is included below.

## Codex 提供商集成参考 / Codex provider integration reference

`codex_auth.py` 参考了
[CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) 公开的 Codex
提供商集成方式，包括 PKCE 登录、OAuth 令牌刷新、ChatGPT 账户路由，以及对
Codex Responses 请求的组织。Memo Superform 以 Python 标准库独立实现本地回调、
凭据存储、请求转换和 HTTP/SSE 传输，不打包 Cherry Studio 的 Electron/TypeScript
运行时。

The Codex provider flow in `codex_auth.py` was implemented with reference to the
public [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)
integration design, including PKCE sign-in, OAuth token refresh, ChatGPT account
routing, and Codex Responses request shaping. Memo Superform independently
implements the local callback, credential storage, request conversion, and
HTTP/SSE transport with Python's standard library; it does not bundle Cherry
Studio's Electron/TypeScript runtime.

Upstream license: AGPL-3.0. Memo Superform's own source is also distributed
under AGPL-3.0; the root `LICENSE` contains those terms.

## 外置语音包 / External voice package

The released EXE and this repository do not contain voice checkpoints,
reference recordings, or a GPT-SoVITS environment. When a user separately
mounts a compatible package, Memo Superform can integrate an inference layout
adapted from [D_sakiko](https://github.com/MacchaPafe/D_sakiko) (GPL-3.0), which
in turn uses [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) (MIT). See the
bilingual README acknowledgements for the exact integration boundary. Voice
models and recordings may have additional rights separate from the code
license.

## MIT License text

The following terms apply to A-kirami/bestdori-live2d-downloader and to the
MIT-licensed renderer components identified above, together with each
component's copyright notice. Component-specific copies are also retained
beside the bundled renderer files.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## pywebview BSD 3-Clause License

Copyright (c) 2014-2017, Roman Sirokov
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## pyodbc MIT-0 License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
