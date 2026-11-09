@echo off
REM One-command install + run for Windows. Double-click or run: start.bat
cd /d "%~dp0"
where python >nul 2>nul || (echo Python 3.9+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
if not exist .venv\Scripts\python.exe (
  echo Creating virtual environment...
  python -m venv .venv || (pause & exit /b 1)
)
if not exist .venv\.installed (
  echo Installing dependencies...
  .venv\Scripts\python -m pip install --quiet --upgrade pip
  .venv\Scripts\python -m pip install --quiet -r requirements.txt || (pause & exit /b 1)
  type nul > .venv\.installed
)
.venv\Scripts\python serve.py
pause
