#!/bin/sh
# Builds register.ts with esbuild and runs the offline harness.
set -e
cd "$(dirname "$0")/.."
npx -y esbuild hooks/register.ts --format=esm --outfile=/tmp/er.mjs --log-level=warning
sed -i 's#^import type.*##' /tmp/er.mjs
node test/harness.mjs
