#!/bin/bash

set -e

# Ensure bucket argument is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <s3-bucket-name>"
  exit 1
fi

S3_STORAGE_BUCKET="$1"
CACHE_CONTROL="public, max-age=86400"

npm run build

aws s3 sync "dist/" "s3://${S3_STORAGE_BUCKET}" \
  --exclude "index.html" \
  --cache-control "$CACHE_CONTROL" \
  --metadata-directive REPLACE

aws s3 cp "dist/index.html" "s3://${S3_STORAGE_BUCKET}/index.html" \
  --cache-control "no-cache, no-store, must-revalidate" \
  --metadata-directive REPLACE

echo "Waiting 30 seconds for cache refresh..."
sleep 30

aws s3 sync "dist/" "s3://${S3_STORAGE_BUCKET}" \
  --exclude "index.html" \
  --cache-control "$CACHE_CONTROL" \
  --metadata-directive REPLACE \
  --delete
