#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

status=0
while IFS= read -r -d '' file; do
    if ! node scripts/checkMongoose9Compatibility.js "$file" < "$file"; then
        status=1
    fi
done < <(
    find discord \
        -type d \( -name node_modules -o -name tests -o -name public -o -name views \) -prune -o \
        -type f -name '*.js' -print0
)

if (( status != 0 )); then
    exit "$status"
fi

echo "[MONGOOSE9] Compatibility AST check passed"
