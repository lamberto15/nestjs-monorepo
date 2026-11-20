#!/bin/sh
# Prepares the development Garage (compose.dev.yaml, profile storage) for
# STORAGE_DRIVER=s3: one node's layout, a fixed key and the bucket. Safe to
# run again. Development values only: never a deployment's.
set -eu
# This project's ports (pnpm run setup --dev-ports), as docker compose reads them.
[ -f .env ] && . ./.env

garage() {
  docker compose -f compose.dev.yaml --profile storage exec -T garage /garage "$@"
}

KEY_ID=GK0123456789abcdef01234567
KEY_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
BUCKET=app-dev

if garage status | grep -q 'NO ROLE ASSIGNED'; then
  node=$(garage node id -q | cut -d@ -f1)
  garage layout assign -z dev -c 1G "$node"
  garage layout apply --version 1
fi
garage key info "$KEY_ID" >/dev/null 2>&1 ||
  garage key import --yes -n dev "$KEY_ID" "$KEY_SECRET"
garage bucket info "$BUCKET" >/dev/null 2>&1 || garage bucket create "$BUCKET"
garage bucket allow --read --write --owner "$BUCKET" --key "$KEY_ID"

cat <<VARS
Garage is ready. To use it (apps/api/.env.development):
  STORAGE_DRIVER=s3
  S3_BUCKET=$BUCKET
  S3_REGION=garage
  S3_ENDPOINT=http://127.0.0.1:${GARAGE_PORT:-3900}
  S3_FORCE_PATH_STYLE=on
  AWS_ACCESS_KEY_ID=$KEY_ID
  AWS_SECRET_ACCESS_KEY=$KEY_SECRET
VARS
