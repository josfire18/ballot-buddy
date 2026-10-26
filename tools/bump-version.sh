#!/usr/bin/env bash
# Stamps a new cache-busting version on every script, stylesheet and data URL.
set -e
cd "$(dirname "$0")/.."
V=$(date -u +%Y%m%d%H%M)
sed -i -E "s#(css/styles\.css|js/app\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g" index.html
sed -i -E "s#\"\./(geo|wiki|match)\.js(\?v=[0-9]+)?\"#\"./\1.js?v=$V\"#g" js/app.js js/match.js
sed -i -E "s#^const V = \"[0-9]*\";#const V = \"$V\";#" js/app.js
echo "version $V"
