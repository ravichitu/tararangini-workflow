@echo off
setlocal EnableExtensions
set "LAUNCHER=%~dp0Run Web Invoice Batch.cmd"

if not exist "%LAUNCHER%" (
  echo Tarangini batch launcher files are missing. Reinstall Tarangini Workflow Suite.
  exit /b 2
)

rem Store Main preset: defaults are safe and can be overridden by arguments after this command.
call "%LAUNCHER%" --server http://192.168.0.104:3000 --username operator1 --org-id 1 %*
exit /b %ERRORLEVEL%
