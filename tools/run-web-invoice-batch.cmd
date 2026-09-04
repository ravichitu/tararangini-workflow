@echo off
setlocal EnableExtensions
set "SCRIPT=%~dp0run-web-invoice-batch.ps1"
set "APP=%~dp0..\Tarangini Workflow Suite.exe"

if not exist "%SCRIPT%" (
  echo Tarangini batch launcher files are missing. Reinstall Tarangini Workflow Suite.
  exit /b 2
)
if not exist "%APP%" (
  echo Tarangini Workflow Suite.exe was not found beside this launcher.
  exit /b 2
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -AppPath "%APP%" %*
exit /b %ERRORLEVEL%
