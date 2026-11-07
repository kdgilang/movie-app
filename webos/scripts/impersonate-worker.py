#!/usr/bin/env python3
"""Chrome TLS impersonation worker (curl_cffi). One JSON line in, one JSON line out."""
import base64
import json
import sys

from curl_cffi import requests

SITE = "https://z2.idlixku.com/"
IMPERSONATE = "chrome131"

session = requests.Session(impersonate=IMPERSONATE)
session.headers.update(
    {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Origin": "https://z2.idlixku.com",
        "Referer": SITE,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
    }
)


def reply(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle(msg):
    url = msg.get("url") or ""
    method = (msg.get("method") or "GET").upper()
    headers = msg.get("headers") or {}
    body_b64 = msg.get("bodyB64") or ""
    req_id = msg.get("id")
    data = base64.b64decode(body_b64) if body_b64 else None
    kwargs = {
        "headers": headers,
        "timeout": 45,
        "allow_redirects": True,
    }
    if data and method not in ("GET", "HEAD"):
        kwargs["data"] = data
    r = session.request(method, url, **kwargs)
    hdrs = {}
    for k, v in r.headers.items():
        hdrs[k.lower()] = v
    return {
        "id": req_id,
        "ok": True,
        "status": r.status_code,
        "headers": hdrs,
        "bodyB64": base64.b64encode(r.content).decode("ascii"),
    }


def main():
    try:
        session.get(SITE, timeout=45)
        sys.stderr.write("impersonate warmup ok chrome131\n")
        sys.stderr.flush()
    except Exception as e:
        sys.stderr.write("impersonate warmup failed: %s\n" % e)
        sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            msg = json.loads(line)
            req_id = msg.get("id")
            reply(handle(msg))
        except Exception as e:
            reply({"id": req_id, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
