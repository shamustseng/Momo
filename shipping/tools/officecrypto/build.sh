#!/usr/bin/env bash
# 重新打包 vendor/officecrypto.browser.js（officecrypto-tool 的瀏覽器版）
set -euo pipefail
cd "$(dirname "$0")"
npm install --no-save officecrypto-tool@0.0.19 buffer@6 esbuild >/dev/null
npx esbuild entry.js --bundle --format=iife --global-name=OfficeCrypto --platform=browser \
  --alias:crypto=./crypto-shim.js --alias:xml2js=./xml2js-shim.js --alias:fs=./empty.js \
  --inject:./buffer-inject.js --define:process.env.NODE_ENV='"production"' --minify \
  --outfile=../../vendor/officecrypto.browser.js
