#!/usr/bin/env bash
# 重新打包 vendor/pdfjs.iife.js 與 vendor/pdf.worker.iife.js（pdfjs-dist legacy build → 全域 pdfjsLib / pdfjsWorker）
set -euo pipefail
cd "$(dirname "$0")"
npm install --no-save pdfjs-dist@4.10.38 esbuild >/dev/null
npx esbuild node_modules/pdfjs-dist/legacy/build/pdf.mjs --bundle --format=iife --global-name=pdfjsLib --platform=browser --minify --outfile=../vendor/pdfjs.iife.js
npx esbuild node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs --bundle --format=iife --global-name=pdfjsWorker --platform=browser --minify --outfile=../vendor/pdf.worker.iife.js
