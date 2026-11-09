#!/usr/bin/env bash
# One-command install + run (Linux / macOS).  Usage:  ./start.sh
#   PORT=9000 ./start.sh            run on another port
#   ADMIN_PASSWORD=secret ./start.sh  choose the first admin password
set -euo pipefail
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3.9+ is required. Install it from https://www.python.org/downloads/" >&2
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "Creating virtual environment (.venv)…"
  "$PY" -m venv .venv || { echo "Could not create venv. On Debian/Ubuntu run: sudo apt install python3-venv" >&2; exit 1; }
fi
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  echo "Installing dependencies…"
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -r requirements.txt
  touch .venv/.installed
fi

exec .venv/bin/python serve.py
