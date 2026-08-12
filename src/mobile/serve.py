#!/usr/bin/env python3
"""
serve.py — AQUARISE 移动端独立静态服务器
============================================================
零第三方依赖，仅使用 Python 标准库。
启动后打印局域网 IP，方便手机扫码/输入访问。

用法：
    cd src/mobile
    python serve.py              # 默认端口 8080
    python serve.py --port 9000  # 自定义端口

然后在手机浏览器打开： http://<主机IP>:8080
"""

import argparse
import http.server
import socket
import socketserver
import sys
from pathlib import Path


def get_lan_ip():
    """获取本机局域网 IP（用于手机访问）。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def main():
    parser = argparse.ArgumentParser(description="AQUARISE 移动端静态服务器")
    parser.add_argument("--port", "-p", type=int, default=8080, help="监听端口（默认 8080）")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0，允许局域网访问）")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    os_cwd = str(root)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=os_cwd, **kw)

        def end_headers(self):
            # 禁止缓存，方便开发调试
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            super().end_headers()

    lan_ip = get_lan_ip()

    print("=" * 50)
    print("  AQUARISE 移动端 · 静态服务器")
    print("=" * 50)
    print(f"  本机访问:   http://127.0.0.1:{args.port}")
    print(f"  局域网访问: http://{lan_ip}:{args.port}")
    print("-" * 50)
    print("  在手机浏览器打开「局域网访问」地址")
    print("  然后在 App 内「服务器连接设置」中填写后端地址:")
    print(f"    http://{lan_ip}:8000")
    print("=" * 50)
    print()
    print("  按 Ctrl+C 停止服务器")
    print()

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((args.host, args.port), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务器已停止")
            sys.exit(0)


if __name__ == "__main__":
    main()
