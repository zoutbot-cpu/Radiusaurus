#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/radiusaurus"
WEB_DIR="/var/www/radiusaurus"
DEFAULT_RELEASE_URL="https://github.com/YOUR_GITHUB_USER/radiusaurus/releases/latest/download/radiusaurus-installer.tar.gz"
TMP_DIR=""

DB_HOST="localhost"
DB_NAME="radius"
DB_USER="radius"
DB_PASS=""
ADMIN_USER="admin"
ADMIN_PASS=""
SECRET_KEY=""
PUBLIC_URL=""
SERVER_NAME="_"
COMPANY_NAME="Radiusaurus"
SUPPORT_EMAIL="support@example.local"
RADIUS_IP=""
RADIUS_DNS=""
CERT_COUNTRY="BE"
CERT_STATE="Limburg"
CERT_ORG="Radiusaurus"
CERT_CA_PASS=""
CERT_SERVER_PASS=""
RELEASE_URL=""

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

require_root() {
  if [ "${EUID}" -ne 0 ]; then
    echo "Please run as root: sudo bash quick-install.sh"
    exit 1
  fi
}

ask() {
  local var_name="$1"
  local prompt="$2"
  local default_value="${3:-}"
  local value=""

  if [ -n "$default_value" ]; then
    read -r -p "$prompt [$default_value]: " value
    value="${value:-$default_value}"
  else
    while [ -z "$value" ]; do
      read -r -p "$prompt: " value
    done
  fi

  printf -v "$var_name" '%s' "$value"
}

ask_secret() {
  local var_name="$1"
  local prompt="$2"
  local value=""

  while [ -z "$value" ]; do
    read -r -s -p "$prompt: " value
    echo ""
  done

  printf -v "$var_name" '%s' "$value"
}

random_secret() {
  openssl rand -hex 32
}

install_packages() {
  echo "[1/14] Installing OS packages..."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl \
    tar \
    rsync \
    sudo \
    openssl \
    python3 \
    python3-venv \
    python3-pip \
    nginx \
    freeradius \
    freeradius-mysql \
    mariadb-server
}

prompt_values() {
  echo ""
  echo "Radiusaurus first-time configuration"
  echo "------------------------------------"
  ask RELEASE_URL "Release archive URL" "$DEFAULT_RELEASE_URL"
  ask PUBLIC_URL "Public URL" "http://$(hostname -I | awk '{print $1}')"
  ask SERVER_NAME "Nginx server_name" "_"
  ask COMPANY_NAME "Company name" "Radiusaurus"
  ask SUPPORT_EMAIL "Support email" "support@example.local"
  ask RADIUS_IP "RADIUS server IP" "$(hostname -I | awk '{print $1}')"
  ask RADIUS_DNS "RADIUS DNS name" "$(hostname -f 2>/dev/null || hostname)"

  ask DB_HOST "Database host" "localhost"
  ask DB_NAME "Database name" "radius"
  ask DB_USER "Database user" "radius"
  ask_secret DB_PASS "Database password"

  ask ADMIN_USER "Radiusaurus admin username" "admin"
  ask_secret ADMIN_PASS "Radiusaurus admin password"

  ask CERT_COUNTRY "Certificate country code" "BE"
  ask CERT_STATE "Certificate state/province" "Limburg"
  ask CERT_ORG "Certificate organization" "$COMPANY_NAME"
  ask_secret CERT_CA_PASS "Certificate CA password"
  ask_secret CERT_SERVER_PASS "Server private key password"

  SECRET_KEY="$(random_secret)"
}

download_release() {
  echo "[2/14] Downloading Radiusaurus release..."
  TMP_DIR="$(mktemp -d)"
  curl -fL "$RELEASE_URL" -o "$TMP_DIR/radiusaurus-installer.tar.gz"
  tar -xzf "$TMP_DIR/radiusaurus-installer.tar.gz" -C "$TMP_DIR"
}

copy_app_files() {
  echo "[3/14] Installing application files..."
  mkdir -p "$APP_DIR" "$WEB_DIR"

  install -m 640 "$TMP_DIR/main.py" "$APP_DIR/main.py"
  install -m 640 "$TMP_DIR/requirements.txt" "$APP_DIR/requirements.txt"

  mkdir -p "$APP_DIR/config" "$APP_DIR/templates" "$APP_DIR/installer"
  rsync -a "$TMP_DIR/templates/" "$APP_DIR/templates/"
  rsync -a "$TMP_DIR/installer/" "$APP_DIR/installer/"

  if [ -d "$TMP_DIR/installer/frontend" ]; then
    rsync -a --delete "$TMP_DIR/installer/frontend/" "$WEB_DIR/"
  else
    echo "ERROR: frontend files missing from release archive."
    exit 1
  fi
}

write_env_and_settings() {
  echo "[4/14] Writing .env and settings.json..."
  cat > "$APP_DIR/.env" <<EOF_ENV
RADIUSAURUS_DB_URL=mysql+pymysql://$DB_USER:$DB_PASS@$DB_HOST/$DB_NAME
RADIUSAURUS_SECRET_KEY=$SECRET_KEY
RADIUSAURUS_ADMIN_USER=$ADMIN_USER
RADIUSAURUS_ADMIN_PASS=$ADMIN_PASS
RADIUSAURUS_CERT_BASE=/opt/radiusaurus/certs
EOF_ENV

  mkdir -p "$APP_DIR/config"
  cat > "$APP_DIR/config/settings.json" <<EOF_JSON
{
  "company_name": "$COMPANY_NAME",
  "support_email": "$SUPPORT_EMAIL",
  "server_public_url": "$PUBLIC_URL",
  "frontend_path": "$WEB_DIR",
  "radius_server_ip": "$RADIUS_IP",
  "radius_server_dns": "$RADIUS_DNS",
  "auth_port": 1812,
  "accounting_port": 1813,
  "certificate_country": "$CERT_COUNTRY",
  "certificate_state": "$CERT_STATE",
  "certificate_organization": "$CERT_ORG",
  "certificate_ca_password": "$CERT_CA_PASS",
  "certificate_server_key_password": "$CERT_SERVER_PASS",
  "certificate_valid_days_default": 365,
  "certificate_client_dir": "/opt/radiusaurus/certs/clients",
  "certificate_export_dir": "/opt/radiusaurus/certs/exports",
  "freeradius_clients_conf": "/etc/freeradius/3.0/clients.conf",
  "freeradius_eap_conf": "/etc/freeradius/3.0/mods-enabled/eap",
  "freeradius_default_site": "/etc/freeradius/3.0/sites-enabled/default",
  "freeradius_inner_tunnel": "/etc/freeradius/3.0/sites-enabled/inner-tunnel",
  "freeradius_sql_conf": "/etc/freeradius/3.0/mods-enabled/sql",
  "freeradius_queries_conf": "/etc/freeradius/3.0/mods-config/sql/main/mysql/queries.conf",
  "freeradius_radius_request_log_conf": "/etc/freeradius/3.0/mods-available/radius_request_log",
  "freeradius_backup_dir": "/opt/radiusaurus/backups/generated-configs",
  "freeradius_default_eap_type": "peap",
  "freeradius_server_key": "/opt/radiusaurus/certs/server/server.key",
  "freeradius_server_cert": "/opt/radiusaurus/certs/server/server.pem",
  "freeradius_ca_cert": "/opt/radiusaurus/certs/ca/ca.pem",
  "freeradius_dh_file": "/opt/radiusaurus/certs/dh",
  "freeradius_tls_min_version": "1.2",
  "freeradius_tls_max_version": "1.3",
  "freeradius_service_name": "freeradius",
  "freeradius_binary_path": "/usr/sbin/freeradius",
  "sql_server": "$DB_HOST",
  "sql_port": 3306,
  "sql_login": "$DB_USER",
  "sql_password": "$DB_PASS",
  "sql_database": "$DB_NAME",
  "radius_request_log_file": "/var/log/freeradius/radius-requests.log",
  "default_user_group": "default",
  "default_mac_group": "mac-auth",
  "default_vlan": null,
  "log_retention_days": 30,
  "backup_retention_days": 30
}
EOF_JSON
}

setup_python() {
  echo "[5/14] Creating Python virtual environment..."
  cd "$APP_DIR"
  python3 -m venv venv
  "$APP_DIR/venv/bin/pip" install --upgrade pip
  "$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt"
}

setup_database() {
  echo "[6/14] Installing database schema..."
  systemctl enable mariadb
  systemctl start mariadb

  mysql -u root <<SQL_EOF
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL_EOF

  if [ -f "$APP_DIR/installer/schema.sql" ]; then
    mysql -u root "$DB_NAME" < "$APP_DIR/installer/schema.sql"
  else
    echo "WARNING: schema.sql not found at $APP_DIR/installer/schema.sql"
  fi
}

setup_certificates() {
  echo "[7/14] Creating Radiusaurus certificates..."
  mkdir -p "$APP_DIR/certs/ca" "$APP_DIR/certs/server" "$APP_DIR/certs/clients" "$APP_DIR/certs/exports"

  if [ ! -f "$APP_DIR/certs/ca/ca.key" ]; then
    openssl genrsa -aes256 -passout pass:"$CERT_CA_PASS" -out "$APP_DIR/certs/ca/ca.key" 4096
    openssl req -x509 -new -key "$APP_DIR/certs/ca/ca.key" -passin pass:"$CERT_CA_PASS" -sha256 -days 3650 -out "$APP_DIR/certs/ca/ca.pem" -subj "/C=$CERT_COUNTRY/ST=$CERT_STATE/O=$CERT_ORG/CN=Radiusaurus-CA/emailAddress=$SUPPORT_EMAIL"
  fi

  if [ ! -f "$APP_DIR/certs/server/server.key" ]; then
    openssl genrsa -aes256 -passout pass:"$CERT_SERVER_PASS" -out "$APP_DIR/certs/server/server.key" 2048
    openssl req -new -key "$APP_DIR/certs/server/server.key" -passin pass:"$CERT_SERVER_PASS" -out "$APP_DIR/certs/server/server.csr" -subj "/C=$CERT_COUNTRY/ST=$CERT_STATE/O=$CERT_ORG/CN=radiusaurus-server/emailAddress=$SUPPORT_EMAIL"
    openssl x509 -req -in "$APP_DIR/certs/server/server.csr" -CA "$APP_DIR/certs/ca/ca.pem" -CAkey "$APP_DIR/certs/ca/ca.key" -passin pass:"$CERT_CA_PASS" -CAcreateserial -out "$APP_DIR/certs/server/server.pem" -days 3650 -sha256
  fi

  if [ ! -f "$APP_DIR/certs/dh" ]; then
    openssl dhparam -out "$APP_DIR/certs/dh" 2048
  fi
}

setup_systemd() {
  echo "[8/14] Installing systemd service..."
  if [ -f "$APP_DIR/installer/radiusaurus.service" ]; then
    cp "$APP_DIR/installer/radiusaurus.service" /etc/systemd/system/radiusaurus.service
  else
    cat > /etc/systemd/system/radiusaurus.service <<EOF_SERVICE
[Unit]
Description=Radiusaurus API
After=network.target mariadb.service

[Service]
User=www-data
Group=www-data
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF_SERVICE
  fi
}

setup_nginx() {
  echo "[9/14] Installing nginx config..."
  cat > /etc/nginx/sites-available/radiusaurus <<EOF_NGINX
server {
    listen 80;
    server_name $SERVER_NAME;

    root $WEB_DIR;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF_NGINX

  ln -sf /etc/nginx/sites-available/radiusaurus /etc/nginx/sites-enabled/radiusaurus
  nginx -t
}

setup_sudoers() {
  echo "[10/14] Configuring sudo permissions for Radiusaurus..."
  cat > /etc/sudoers.d/radiusaurus <<'EOF_SUDO'
www-data ALL=(root) NOPASSWD: /usr/sbin/freeradius -XC, /bin/systemctl reload freeradius, /usr/bin/systemctl reload freeradius
EOF_SUDO
  chmod 440 /etc/sudoers.d/radiusaurus
  visudo -cf /etc/sudoers.d/radiusaurus
}

setup_permissions() {
  echo "[11/14] Setting permissions..."
  usermod -aG freerad www-data || true

  chown -R www-data:www-data "$WEB_DIR"
  find "$WEB_DIR" -type d -exec chmod 755 {} \;
  find "$WEB_DIR" -type f -exec chmod 644 {} \;

  mkdir -p "$APP_DIR/backups/generated-configs"
  chown -R root:www-data "$APP_DIR"
  find "$APP_DIR" -type d -exec chmod 750 {} \;
  find "$APP_DIR" -type f -exec chmod 640 {} \;
  find "$APP_DIR/venv/bin" -type f -exec chmod 755 {} \;

  chown -R freerad:freerad "$APP_DIR/certs"
  find "$APP_DIR/certs" -type d -exec chmod 750 {} \;
  find "$APP_DIR/certs" -type f -exec chmod 640 {} \;
  chmod 600 "$APP_DIR/certs/server/server.key" || true
  chmod 644 "$APP_DIR/certs/server/server.pem" || true
  chmod 644 "$APP_DIR/certs/ca/ca.pem" || true

  chgrp -R www-data /etc/freeradius/3.0 || true
  chmod 755 /etc/freeradius /etc/freeradius/3.0 || true
  chmod 755 /etc/freeradius/3.0/mods-enabled /etc/freeradius/3.0/mods-available /etc/freeradius/3.0/sites-enabled || true
  chmod 755 /etc/freeradius/3.0/mods-config/sql/main/mysql || true

  for file in \
    /etc/freeradius/3.0/clients.conf \
    /etc/freeradius/3.0/mods-enabled/eap \
    /etc/freeradius/3.0/sites-enabled/default \
    /etc/freeradius/3.0/sites-enabled/inner-tunnel \
    /etc/freeradius/3.0/mods-enabled/sql \
    /etc/freeradius/3.0/mods-config/sql/main/mysql/queries.conf \
    /etc/freeradius/3.0/mods-available/radius_request_log
  do
    if [ -e "$file" ]; then
      chgrp www-data "$file" || true
      chmod 664 "$file" || true
    fi
  done
}

start_services() {
  echo "[12/14] Starting services..."
  systemctl daemon-reload
  systemctl enable radiusaurus nginx freeradius
  systemctl restart radiusaurus
  systemctl reload nginx
}

final_status() {
  echo "[13/14] Checking services..."
  systemctl --no-pager --full status radiusaurus || true
  systemctl --no-pager --full status nginx || true
  systemctl --no-pager --full status freeradius || true
}

finish_message() {
  echo "[14/14] Done."
  echo ""
  echo "Radiusaurus installed."
  echo "Open: $PUBLIC_URL"
  echo "Admin username: $ADMIN_USER"
  echo ""
  echo "Next steps:"
  echo "1. Login to Radiusaurus."
  echo "2. Go to Settings."
  echo "3. Generate all managed configs."
  echo "4. Test FreeRADIUS config."
  echo "5. Reload FreeRADIUS only if the test passes."
}

require_root
prompt_values
install_packages
download_release
copy_app_files
write_env_and_settings
setup_python
setup_database
setup_certificates
setup_systemd
setup_nginx
setup_sudoers
setup_permissions
start_services
final_status
finish_message
