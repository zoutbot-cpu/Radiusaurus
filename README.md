# Radiusaurus

**Radiusaurus** is a web-based FreeRADIUS management platform designed to make RADIUS administration easier. 
<img src="docs/assets/radiusaurus-logo.png" alt="radiusaurus logo" width= "60%">

- **Python** - FastAPI backend
- **MariaDB** - , nginx, Freeradus, HTML/CSS/JS
- **Python** — backend/API
- **FastAPI** — API framework
- **Uvicorn** — Python ASGI server
- **HTML, CSS, JavaScript** — frontend
- **MariaDB / MySQL** — database
- **SQLAlchemy + PyMySQL** — database access
- **nginx** — reverse proxy and frontend web server
- **FreeRADIUS** — RADIUS server
- **Bash** — installer scripts

## Features
- Web UI for managing RADIUS users
- MAC authentication device management
- RADIUS client management
- Group and VLAN policy management
- Certificate creation and download
- FreeRADIUS config generation from templates
- Advanced FreeRADIUS config editor
- Config test and reload workflow
- Status dashboard for FreeRADIUS, database, recent authentications, and failures
- GitHub Pages landing page
- Interactive Ubuntu quick installer

## Repository Structure

```text
docs/
  GitHub Pages website

.github/workflows/pages.yml
  GitHub Pages deployment workflow

scripts/
  quick-install.sh       Interactive Ubuntu installer
  build-release.sh       Builds a release archive
  verify-archive.sh      Checks archive contents

templates/
  nginx-radiusaurus.conf
  radiusaurus.service

README.md
  Project documentation
```

## Quick Install on Ubuntu LTS

On a clean Ubuntu LTS server:

```bash
curl -fsSL https://raw.githubusercontent.com/zoutbot-cpu/radiusaurus/main/scripts/quick-install.sh -o quick-install.sh
chmod +x quick-install.sh
sudo ./quick-install.sh
```
The installer asks for:

- Database name, user, and password
- Radiusaurus admin username and password
- Public URL or hostname
- Certificate and FreeRADIUS defaults

## Manual Install Flow

The installer performs the following tasks:

1. Installs system packages
2. Installs FreeRADIUS, MariaDB, nginx, Python, and required tooling
3. Creates `/opt/radiusaurus`
4. Creates the Python virtual environment
5. Installs Python dependencies
6. Creates `.env`
7. Imports the database schema
8. Installs the systemd service
9. Installs nginx configuration
10. Copies the frontend to `/var/www/radiusaurus`
11. Sets permissions
12. Starts Radiusaurus and nginx

## Important Paths

```text
/opt/radiusaurus
  Backend application, settings, templates, certificates, backups

/var/www/radiusaurus
  Frontend web files

/etc/freeradius/3.0
  FreeRADIUS configuration

/etc/systemd/system/radiusaurus.service
  Radiusaurus systemd service

/etc/nginx/sites-available/radiusaurus
  nginx site configuration
```

## Environment File

Sensitive values should be stored in:

```text
/opt/radiusaurus/.env
```

Example:

```env
RADIUSAURUS_DB_URL=mysql+pymysql://radius:CHANGE_ME@localhost/radius
RADIUSAURUS_SECRET_KEY=CHANGE_ME
RADIUSAURUS_ADMIN_USER=admin
RADIUSAURUS_ADMIN_PASS=CHANGE_ME
RADIUSAURUS_CERT_BASE=/opt/radiusaurus/certs
```

Do not commit real production secrets.

## Customer Settings

Customer-specific editable settings are stored in:

```text
/opt/radiusaurus/config/settings.json
```

These include values such as:

- Company name
- Support email
- RADIUS server IP/DNS
- RADIUS ports
- Certificate organization values
- FreeRADIUS managed config paths
- Backup paths
- TLS/EAP defaults

## After Installation

Open the Radiusaurus web UI and go to:

```text
Settings → Generate all managed configs
Settings → Test FreeRADIUS config
Settings → Reload FreeRADIUS
```

Then verify the Status page.

## Managed FreeRADIUS Files

Radiusaurus can generate and manage:

```text
/etc/freeradius/3.0/clients.conf
/etc/freeradius/3.0/mods-enabled/eap
/etc/freeradius/3.0/sites-enabled/default
/etc/freeradius/3.0/sites-enabled/inner-tunnel
/etc/freeradius/3.0/mods-enabled/sql
/etc/freeradius/3.0/mods-config/sql/main/mysql/queries.conf
/etc/freeradius/3.0/mods-available/radius_request_log
```

## Development Notes

Recommended local update flow:

```bash
cd /opt/radiusaurus
python3 -m py_compile main.py
sudo systemctl restart radiusaurus
sudo systemctl status radiusaurus --no-pager
```

For frontend changes:

```bash
sudo systemctl reload nginx
```

For FreeRADIUS validation:

```bash
sudo freeradius -XC
```

## Security Notes

Before production use:

- Change all default passwords
- Use HTTPS
- Protect `/opt/radiusaurus/.env`
- Restrict SSH access
- Review sudo permissions used for FreeRADIUS testing/reload
- Keep Ubuntu, FreeRADIUS, MariaDB, and Python packages updated

## License

Add your preferred license before publishing publicly.
