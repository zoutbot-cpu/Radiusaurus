#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/radiusaurus}"
WEB_DIR="${2:-/var/www/radiusaurus}"
OUT="${3:-$APP_DIR/installer/radiusaurus-installer.tar.gz}"

if [ ! -d "$APP_DIR" ]; then
  echo "App directory not found: $APP_DIR"
  exit 1
fi

mkdir -p "$APP_DIR/installer/frontend"
rsync -a --delete "$WEB_DIR/" "$APP_DIR/installer/frontend/"
find "$APP_DIR/installer/frontend" -name "*.backup*" -delete
find "$APP_DIR/installer/frontend" -name "*.bak" -delete
find "$APP_DIR/installer/frontend" -name "*~" -delete

cd "$APP_DIR"

tar \
  --exclude='venv' \
  --exclude='backups' \
  --exclude='certs/clients' \
  --exclude='certs/exports' \
  --exclude='installer/radiusaurus-installer.tar.gz' \
  -czf "$OUT" \
  main.py \
  requirements.txt \
  config/settings.json \
  templates \
  installer

file "$OUT"
tar -tzf "$OUT" | head -40
