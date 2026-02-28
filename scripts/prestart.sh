#!/bin/bash
set -e

LOG_PREFIX="[her-prestart $(date '+%Y-%m-%d %H:%M:%S')]"

# Step 1: Kill any process on port 3000
echo "$LOG_PREFIX Killing any process on port 3000..."
fuser -k 3000/tcp 2>/dev/null || true
sleep 1

# Step 2: First syntax check
echo "$LOG_PREFIX Checking JS syntax..."
cd /opt/her
if ! node --check server.js 2>&1; then
    echo "$LOG_PREFIX Syntax error detected, attempting git stash..."
    git -C /opt/her stash 2>/dev/null || true
    if ! node --check server.js 2>&1; then
        echo "$LOG_PREFIX Syntax still fails after git stash, aborting startup"
        exit 1
    fi
    echo "$LOG_PREFIX Git stash recovered syntax"
fi

# Step 3: Apply patches (idempotent - safe to run every time)
echo "$LOG_PREFIX Applying patches..."

# Patch 1: Remove undefined requireAuth middleware
python3 -c "
f = '/opt/her/server.js'
c = open(f).read()
patched = c.replace(', requireAuth,', ',')
if patched != c:
    open(f, 'w').write(patched)
    print('Patch 1 applied: removed requireAuth')
else:
    print('Patch 1 skipped: already clean')
"


# Patch 2: Fix model list in index.html (Opus 4.6, remove emoji from labels)
python3 /opt/her/scripts/patch_html.py

# Step 4: Re-validate syntax after patches
echo "$LOG_PREFIX Re-checking syntax after patches..."
if ! node --check server.js 2>&1; then
    echo "$LOG_PREFIX Syntax error after patches, aborting startup"
    exit 1
fi

echo "$LOG_PREFIX Pre-start checks passed, starting server..."
exit 0
