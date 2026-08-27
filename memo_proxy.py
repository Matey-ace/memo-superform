# -*- coding: utf-8 -*-
"""Declarative route resolution for the Maimemo reverse proxy."""
from dataclasses import dataclass

MAIMEMO_BASE = "https://open.maimemo.com/open"
TC_APIS_BASE = "https://tc-apis.maimemo.com"
API_BASE = "https://api.maimemo.com"
WWW_BASE = "https://www.maimemo.com"
ACCOUNTS_BASE = "https://accounts.maimemo.com"

@dataclass(frozen=True)
class WebRoute:
    prefix: str
    base: str
    inject_get: bool = False
    guard_get_errors: bool = False
    preserve_prefix: bool = False

WEB_ROUTES = (
    WebRoute("/memo-tc/", TC_APIS_BASE),
    WebRoute("/memo-api/", API_BASE),
    WebRoute("/memo-www/", WWW_BASE, inject_get=True),
    WebRoute("/memo-accounts/", ACCOUNTS_BASE, inject_get=True, guard_get_errors=True),
    WebRoute("/webstudy/", TC_APIS_BASE, preserve_prefix=True),
)

def resolve_web_route(path: str, query: str = "", method: str = "GET"):
    for route in WEB_ROUTES:
        if not path.startswith(route.prefix):
            continue
        if route.preserve_prefix:
            target = route.base + path
            sub = path.lstrip("/")
        else:
            sub = path[len(route.prefix):]
            target = route.base + "/" + sub
        if query:
            target += "?" + query
        inject = method == "GET" and (route.inject_get or (
            route.prefix == "/memo-tc/" and sub.startswith("webstudy/app")
            and "." not in sub.split("/")[-1]
        ))
        return target, inject, method == "GET" and route.guard_get_errors
    return None
