#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO_ROOT/radiusaurus-installer.tar.gz}"

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# Backend
cp "$REPO_ROOT/app/main.py" "$BUILD_DIR/main.py"
cp "$REPO_ROOT/app/requirements.txt" "$BUILD_DIR/requirements.txt"
mkdir -p "$BUILD_DIR/config" "$BUILD_DIR/templates/freeradius" "$BUILD_DIR/installer"
cp "$REPO_ROOT/app/config/settings.example.json" "$BUILD_DIR/config/settings.json"
cp "$REPO_ROOT"/app/templates/freeradius/*.j2 "$BUILD_DIR/templates/freeradius/"

# Installer extras
cp "$REPO_ROOT/installer/schema.sql" "$BUILD_DIR/installer/schema.sql"

# nginx/systemd are rendered from the single canonical templates/ files so they
# can never drift from what scripts/quick-install.sh's own fallback generates.
sed 's/__SERVER_NAME__/_/' "$REPO_ROOT/templates/nginx-radiusaurus.conf.template" > "$BUILD_DIR/installer/nginx-radiusaurus.conf"
cp "$REPO_ROOT/templates/radiusaurus.service.template" "$BUILD_DIR/installer/radiusaurus.service"

# Frontend
mkdir -p "$BUILD_DIR/installer/frontend"
cp -r "$REPO_ROOT/frontend/." "$BUILD_DIR/installer/frontend/"
find "$BUILD_DIR/installer/frontend" -name "*.backup*" -delete
find "$BUILD_DIR/installer/frontend" -name "*.bak" -delete
find "$BUILD_DIR/installer/frontend" -name "*~" -delete

cd "$BUILD_DIR"
tar -czf "$OUT" main.py requirements.txt config/settings.json templates installer

echo "Built: $OUT"
file "$OUT"
tar -tzf "$OUT" | sort
