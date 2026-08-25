# -*- coding: utf-8 -*-
"""Static-file exposure rules shared by source and packaged servers."""
from urllib.parse import unquote

FORBIDDEN_STATIC_FILES = frozenset({
    'server.py', 'db.py', 'tts.py', 'recommender.py', 'launcher.py', 'app.py',
    'app_api.py', 'memo_proxy.py', 'memo_injection.py', 'static_security.py',
    'schema.sql', 'release.ps1', 'build_linux.sh', 'launcher-linux.sh',
    'requirements-linux.txt', 'requirements.txt', 'MemoSuperform.spec',
    '_backup_pre-rewrite.bundle',
})

def is_forbidden_static_path(path):
    try:
        decoded = unquote(path, errors='surrogatepass')
    except (UnicodeDecodeError, ValueError):
        return True
    if '\x00' in decoded:
        return True
    segments = [item for item in decoded.replace('\\', '/').split('/') if item]
    if not segments:
        return False
    lowered = [item.lower() for item in segments]
    if any(item.startswith('.') or item.startswith('_') for item in lowered):
        return True
    if lowered[0] in {name.lower() for name in FORBIDDEN_STATIC_FILES}:
        return True
    return lowered[0] == 'data'
