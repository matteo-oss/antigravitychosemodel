@echo off
pushd "%~dp0"
call npm run build
if errorlevel 1 (
  popd
  exit /b 1
)
node "%~dp0scripts\deploy.mjs" %*
set "patchExit=%errorlevel%"
popd
exit /b %patchExit%
