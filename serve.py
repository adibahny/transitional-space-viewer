#!/usr/bin/env python3
"""
serve.py — Local development server for GeoWeb 3D
Serves files with CORS headers so Three.js / fetch() can load .ply data.

Usage:
    python serve.py            # serves on http://localhost:8000
    python serve.py 9000       # custom port
"""

import sys
import http.server
import socketserver
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Allow all origins (needed for Three.js / fetch to load local files)
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        # Cache-Control: no-cache during development
        self.send_header("Cache-Control", "no-cache, no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def log_message(self, format, *args):
        # Compact log
        path = args[0].split('"')[1] if '"' in args[0] else args[0]
        status = args[1]
        color = "\033[32m" if status.startswith("2") else "\033[33m" if status.startswith("3") else "\033[31m"
        reset = "\033[0m"
        print(f"  {color}{status}{reset}  {path}")


if __name__ == "__main__":
    # Serve from the directory where this script lives
    server_dir = Path(__file__).parent
    import os
    os.chdir(server_dir)

    with socketserver.TCPServer(("", PORT), CORSHandler) as httpd:
        print(f"\n  GeoWeb 3D — Local Server")
        print(f"  ─────────────────────────────")
        print(f"  URL:   \033[36mhttp://localhost:{PORT}\033[0m")
        print(f"  Dir:   {server_dir}")
        print(f"\n  Put your .ply files in:  data/splats/")
        print(f"  Put seg JSON in:         data/segmentation/")
        print(f"\n  Press Ctrl+C to stop.\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Server stopped.")
