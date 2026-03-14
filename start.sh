#!/bin/bash
# Start Canva MCP server
cd "$(dirname "$0")"

# Kill any existing instance
lsof -ti:8001 | xargs kill -9 2>/dev/null

# Start server with env vars
node --env-file=.env node_modules/.bin/tsx src/server/server.ts
