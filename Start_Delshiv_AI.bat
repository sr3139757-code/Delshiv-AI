@echo off
title Delshiv AI 
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "%~dp0."
) else (
  npm start
)
