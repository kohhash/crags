"""Production entry point: python serve.py  (uses the waitress WSGI server)."""
import os

from waitress import serve

from app import app

if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", 8000))
    print(f"Crags Job Log running on http://{'localhost' if host == '0.0.0.0' else host}:{port}", flush=True)
    serve(app, host=host, port=port, threads=8)
