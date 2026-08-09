#!/usr/bin/env python3
"""Local dev server.

Python's default http.server sends only Last-Modified, which leaves
browsers free to heuristically cache the ES modules. During development
that means edits silently do not take effect and you debug a build that
is not the one on disk. This adds no-store to everything.

Not used in production: GitHub Pages serves the files, and the service
worker handles offline caching deliberately.

    python3 serve.py [port]
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):  # quiet
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8412
    print(f"http://localhost:{port}  (no-store)")
    ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
