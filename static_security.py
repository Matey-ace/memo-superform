# -*- coding: utf-8 -*-
"""源码服务器和打包服务器共用的静态文件暴露规则。"""
from urllib.parse import unquote

FORBIDDEN_STATIC_FILES = frozenset({
    'server.py', 'db.py', 'tts.py', 'recommender.py', 'launcher.py', 'app.py',
    'app_api.py', 'memo_proxy.py', 'memo_injection.py', 'static_security.py',
    'schema.sql', 'release.ps1',
    'requirements.txt', 'MemoSuperform.spec',
    '_backup_pre-rewrite.bundle',
})

PUBLIC_ROOT_FILES = frozenset({"index.html", "index-anon.html", "license", "readme.md", "changelog.md", "third_party_notices.md"})
PUBLIC_ASSET_EXTENSIONS = {
    "js": {".js"}, "css": {".css"}, "pages": {".html", ".css", ".js"},
    "fonts": {".woff", ".woff2", ".ttf", ".otf"},
    "img": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"},
    "vendor": {".js", ".css", ".wasm", ".txt"},
}

def is_forbidden_static_path(path):
    try:
        decoded = unquote(path, errors="surrogatepass")
    except (UnicodeDecodeError, ValueError):
        return True
    if "\x00" in decoded or "\\" in decoded:
        return True
    segments = [item for item in decoded.split("/") if item]
    if not segments:
        return False  # Handler maps the root to index.html, never a directory listing.
    lowered = [item.lower() for item in segments]
    if any(item.startswith(".") or item.startswith("_") for item in lowered):
        return True
    if len(lowered) == 1:
        return lowered[0] not in PUBLIC_ROOT_FILES
    from pathlib import PurePosixPath
    extension = PurePosixPath(lowered[-1]).suffix
    return extension not in PUBLIC_ASSET_EXTENSIONS.get(lowered[0], set())
