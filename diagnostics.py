"""Bounded local diagnostic logs with credential redaction."""
import os
import re
import threading

_LOCK = threading.Lock()
MAX_LOG_BYTES = 2 * 1024 * 1024
_SECRET = r"(?:access_token|refresh_token|id_token|token|api[_-]?key|authorization|password|secret|code|code_verifier)"


def redact_sensitive_text(value):
    text = str(value)
    text = re.sub(r"(?i)([?&]" + _SECRET + r"=)[^&\s\"']+", r"\1[redacted]", text)
    text = re.sub(r"(?i)(\bBearer\s+)[A-Za-z0-9._~+/-]+=*", r"\1[redacted]", text)
    text = re.sub(r"(?i)([\"']" + _SECRET + r"[\"']\s*:\s*[\"'])[^\"']*", r"\1[redacted]", text)
    return text[:8000]


def append_log(path, message):
    line = redact_sensitive_text(message)
    with _LOCK:
        if os.path.isfile(path) and os.path.getsize(path) >= MAX_LOG_BYTES:
            os.replace(path, path + ".previous")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(line)
