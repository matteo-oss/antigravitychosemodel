@echo off
chcp 65001 >nul
echo 正在执行 Antigravity 补丁部署...
node scripts/deploy.mjs
pause