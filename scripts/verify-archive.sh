#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-radiusaurus-installer.tar.gz}"

file "$ARCHIVE"
tar -tzf "$ARCHIVE" >/tmp/radiusaurus-archive-list.txt

required=(
  "main.py"
  "requirements.txt"
  "config/settings.json"
  "templates/freeradius/clients.conf.j2"
  "templates/freeradius/eap.j2"
  "templates/freeradius/default.j2"
  "templates/freeradius/inner-tunnel.j2"
  "templates/freeradius/sql.j2"
  "templates/freeradius/queries.conf.j2"
  "templates/freeradius/radius_request_log.j2"
  "installer/install.sh"
  "installer/schema.sql"
  "installer/frontend/index.html"
  "installer/frontend/js/radiusaurus.js"
  "installer/frontend/pages/status.html"
)

for item in "${required[@]}"; do
  if ! grep -qx "$item" /tmp/radiusaurus-archive-list.txt; then
    echo "Missing required item: $item"
    exit 1
  fi
done

echo "Archive looks complete."
