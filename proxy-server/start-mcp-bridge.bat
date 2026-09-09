@echo off
cd /d "%~dp0"
echo [MCP Bridge] Starting on port 18099...
node mcp-bridge-local.mjs
pause
