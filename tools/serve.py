#!/usr/bin/env python3
"""音准可视化 · 本地静态服务

只监听 127.0.0.1。浏览器把 localhost 视为安全上下文，麦克风与
AudioWorklet 才能正常工作；直接双击 HTML（file://）会被浏览器拦截。

用法：
    python tools/serve.py
    python tools/serve.py --port 8124 --no-browser
"""

import argparse
import http.server
import mimetypes
import socket
import sys
import threading
import webbrowser
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = BASE_DIR / "app"
PAGE = "pitch-scope.html"

EXTRA_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".wav": "audio/wav",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def end_headers(self):
        # 开发期禁用缓存，避免改了 worklet 还在跑旧版本
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def guess_type(self, path):
        suffix = Path(path).suffix.lower()
        if suffix in EXTRA_TYPES:
            return EXTRA_TYPES[suffix]
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def log_message(self, fmt, *args):
        sys.stdout.write("  %s\n" % (fmt % args))
        sys.stdout.flush()


def pick_port(start: int, attempts: int = 20) -> int:
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("找不到可用端口，请用 --port 指定。")


def main() -> None:
    parser = argparse.ArgumentParser(description="音准可视化本地服务")
    parser.add_argument("--port", type=int, default=8123, help="监听端口（默认 8123）")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    if not (APP_DIR / PAGE).exists():
        raise SystemExit(f"找不到页面：{APP_DIR / PAGE}")

    port = pick_port(args.port)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/{PAGE}"

    print()
    print("音准可视化 · 本地服务已启动")
    print(f"  {url}")
    print("  只监听本机，音频不会上传；按 Ctrl+C 停止。")
    print()

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
