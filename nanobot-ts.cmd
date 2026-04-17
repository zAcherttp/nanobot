@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nanobot-ts.ps1" %*
exit /b %ERRORLEVEL%
