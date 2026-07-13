<div align="center">

<img src="docs/assets/radiusaurus-logo.png" alt="Radiusaurus logo" width="240">

# Radiusaurus

**A web-based management platform for FreeRADIUS.**

Manage users, devices, certificates, and RADIUS clients through a browser instead of hand-editing config files.

[![License: GPL v3](https://img.shields.io/github/license/zoutbot-cpu/Radiusaurus)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/zoutbot-cpu/Radiusaurus)](https://github.com/zoutbot-cpu/Radiusaurus/releases/latest)
![Platform](https://img.shields.io/badge/platform-Ubuntu%20LTS-E95420?logo=ubuntu&logoColor=white)

Tested on: ![22.04](https://img.shields.io/badge/Ubuntu_LTS-22.04-orange) ![24.04](https://img.shields.io/badge/Ubuntu_LTS-24.04-orange) ![26.04](https://img.shields.io/badge/Ubuntu_LTS-26.04-orange)

[Website](https://zoutbot-cpu.github.io/Radiusaurus/) · [Quick Install](#quick-install-on-ubuntu-lts) · [Repository Structure](#repository-structure)

</div>

---

## Why Radiusaurus

FreeRADIUS is powerful but its configuration is spread across a dozen text files and a SQL schema that's easy to get wrong by hand. Radiusaurus puts a browser-based admin layer in front of it: generate config from templates, test it, reload it, and manage users/devices/certificates without SSH-ing in for routine changes.

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
- Interactive Ubuntu quick installer

## Tech Stack

| Layer | Technology |
|---|---|
| Backend / API | Python, FastAPI, Uvicorn |
| Frontend | HTML, CSS, JavaScript |
| Database | MariaDB / MySQL via SQLAlchemy + PyMySQL |
| Reverse proxy | nginx |
| RADIUS server | FreeRADIUS |
| Installer | Bash |

## Quick Install on Ubuntu LTS

On a clean Ubuntu LTS server:

```bash
curl -fsSL https://raw.githubusercontent.com/zoutbot-cpu/radiusaurus/main/scripts/quick-install.sh -o quick-install.sh
chmod +x quick-install.sh
sudo ./quick-install.sh
```

The installer asks for:

- HTTP port for the web UI (defaults to 80)
- Database name, user, and password
- Radiusaurus admin username and password
- Public URL or hostname
- Certificate and FreeRADIUS defaults

<details>
<summary><strong>What the installer actually does</strong></summary>

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

</details>

## After Installation

Open the Radiusaurus web UI and go to:

```text
Settings → Generate all managed configs
Settings → Test FreeRADIUS config
Settings → Reload FreeRADIUS
```

Then verify the Status page.

## Repository Structure

<details>
<summary>Expand</summary>

```text
app/
  main.py                          FastAPI backend
  requirements.txt                 Python dependencies
  config/settings.example.json     Template settings (real settings.json is generated at install time)
  templates/freeradius/*.j2        Jinja templates for generated FreeRADIUS config files

frontend/
  index.html, css/, js/, pages/, img/
    The Radiusaurus web UI

installer/
  schema.sql                       Database schema (no data, safe to version)

docs/
  GitHub Pages website

.github/workflows/pages.yml
  GitHub Pages deployment workflow

scripts/
  quick-install.sh       Interactive Ubuntu installer (the supported install path)
  build-release.sh       Builds a release archive from app/, frontend/, installer/, and templates/
  verify-archive.sh      Checks archive contents

templates/
  nginx-radiusaurus.conf.template
  radiusaurus.service.template
    Canonical nginx/systemd templates. build-release.sh renders these into the
    release archive, so they're the single source of truth (quick-install.sh's
    own inline fallback matches them too).

README.md
  Project documentation
```

Everything the app needs to run is committed here — `scripts/build-release.sh` builds the release archive entirely from this repo, so a fresh clone is all that's needed to produce a new release.

</details>

## Configuration

<details>
<summary><strong>Important paths</strong></summary>

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

</details>

<details>
<summary><strong>Environment file</strong></summary>

Sensitive values are stored in `/opt/radiusaurus/.env`:

```env
RADIUSAURUS_DB_URL=mysql+pymysql://radius:CHANGE_ME@localhost/radius
RADIUSAURUS_SECRET_KEY=CHANGE_ME
RADIUSAURUS_ADMIN_USER=admin
RADIUSAURUS_ADMIN_PASS=CHANGE_ME
RADIUSAURUS_CERT_BASE=/opt/radiusaurus/certs
```

</details>

<details>
<summary><strong>Customer settings</strong></summary>

Customer-specific editable settings live in `/opt/radiusaurus/config/settings.json`, including:

- Company name
- Support email
- RADIUS server IP/DNS
- RADIUS ports
- Certificate organization values
- FreeRADIUS managed config paths
- Backup paths
- TLS/EAP defaults

</details>

<details>
<summary><strong>Managed FreeRADIUS files</strong></summary>

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

</details>

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

> Before production use:

- Change all default passwords
- Use HTTPS
- Protect `/opt/radiusaurus/.env`
- Restrict SSH access
- Review sudo permissions used for FreeRADIUS testing/reload
- Keep Ubuntu, FreeRADIUS, MariaDB, and Python packages updated

## License

[GNU GPL v3](LICENSE)
