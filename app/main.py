from fastapi import FastAPI, HTTPException, Depends
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordRequestForm, OAuth2PasswordBearer
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from jose import jwt, JWTError
from datetime import datetime, timedelta
import os
import json
import shutil
import subprocess
from pathlib import Path
import re
from jinja2 import Environment, FileSystemLoader

app = FastAPI(title="Radiusaurus API")

# ---------------------------------------------------------------------------
# Application configuration
# ---------------------------------------------------------------------------
# Environment variables let you deploy the same code for different customers
# without editing this file. The current hardcoded values are kept as defaults
# so this refactor remains drop-in compatible with your existing snapshot.
DB_URL = os.getenv("RADIUSAURUS_DB_URL", "mysql+pymysql://radius:CHANGE_ME@localhost/radius")
engine = create_engine(DB_URL, pool_pre_ping=True)

SECRET_KEY = os.getenv("RADIUSAURUS_SECRET_KEY", "CHANGE_ME")
ALGORITHM = "HS256"
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/login")

ADMIN_USER = os.getenv("RADIUSAURUS_ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("RADIUSAURUS_ADMIN_PASS", "CHANGE_ME")


SETTINGS_FILE = Path("/opt/radiusaurus/config/settings.json")


def load_settings():
    """Read customer-specific Radiusaurus settings from disk."""
    if not SETTINGS_FILE.exists():
        return {}

    return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))


def save_settings(settings: dict):
    """Write customer-specific Radiusaurus settings to disk."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(settings, indent=2),
        encoding="utf-8"
    )


def create_token(username: str):
    """Create an 8-hour JWT for the Radiusaurus admin session."""
    payload = {
        "sub": username,
        "exp": datetime.utcnow() + timedelta(hours=8)
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def require_auth(token: str = Depends(oauth2_scheme)):
    """FastAPI dependency that protects all management endpoints."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload["sub"]
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

def safe_cert_name(value: str):
    """Convert user supplied names to safe file names for certificate assets."""
    name = re.sub(r"[^a-zA-Z0-9_.-]", "-", value.strip())
    if not name:
        raise HTTPException(status_code=400, detail="Invalid certificate name")
    return name

@app.post("/login")
def login(form: OAuth2PasswordRequestForm = Depends()):
    if form.username != ADMIN_USER or form.password != ADMIN_PASS:
        raise HTTPException(status_code=401, detail="Invalid login")

    return {
        "access_token": create_token(form.username),
        "token_type": "bearer"
    }

# ---------------------------------------------------------------------------
# Certificate and FreeRADIUS file locations
# ---------------------------------------------------------------------------
CERT_BASE = Path(os.getenv("RADIUSAURUS_CERT_BASE", "/opt/radiusaurus/certs"))
CA_CERT = CERT_BASE / "ca/ca.pem"
CA_KEY = CERT_BASE / "ca/ca.key"
CLIENT_DIR = CERT_BASE / "clients"
EXPORT_DIR = CERT_BASE / "exports"

ALLOWED_CONFIG_FILES = {
    "clients.conf":
        "/etc/freeradius/3.0/clients.conf",

    "eap":
        "/etc/freeradius/3.0/mods-enabled/eap",

    "default":
        "/etc/freeradius/3.0/sites-enabled/default",

    "inner-tunnel":
        "/etc/freeradius/3.0/sites-enabled/inner-tunnel",

    "sql":
        "/etc/freeradius/3.0/mods-enabled/sql",

    "queries.conf":
        "/etc/freeradius/3.0/mods-config/sql/main/mysql/queries.conf",

    "radius_request_log":
        "/etc/freeradius/3.0/mods-available/radius_request_log",
}

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class ClientCertificateRequest(BaseModel):
    common_name: str
    export_password: str
    days: int = 365
    username: str | None = None
    mac: str | None = None
    device_name: str | None = None
    description: str | None = None

class ConfigFileUpdate(BaseModel):
    key: str
    content: str

class RadiusUser(BaseModel):
    username: str
    password: str
    group: str = "default"

class RadiusUserUpdate(BaseModel):
    password: str | None = None
    group: str | None = None

class MacAddress(BaseModel):
    mac: str
    username: str | None = None
    device_name: str
    description: str | None = None
    group: str = "mac-auth"
    vlan_number: int | None = None

class MacAddressUpdate(BaseModel):
    username: str | None = None
    device_name: str
    description: str | None = None
    group: str = "mac-auth"
    vlan_number: int | None = None

class RadiusGroup(BaseModel):
    group_name: str
    group_type: str
    vlan_number: int | None = None
    session_timeout: int | None = None
    idle_timeout: int | None = None
    aruba_role: str | None = None
    filter_id: str | None = None
    allow_peap: bool = True
    allow_ttls: bool = True
    allow_mab: bool = True

class RadiusGroupUpdate(BaseModel):
    group_type: str
    vlan_number: int | None = None
    session_timeout: int | None = None
    idle_timeout: int | None = None
    aruba_role: str | None = None
    filter_id: str | None = None
    allow_peap: bool = True
    allow_ttls: bool = True
    allow_mab: bool = True

class RadiusVlan(BaseModel):
    vlan_number: int
    vlan_name: str
    location: str | None = None
    description: str | None = None

class RadiusVlanUpdate(BaseModel):
    vlan_name: str
    location: str | None = None
    description: str | None = None

class RadiusClient(BaseModel):
    nasname: str
    shortname: str
    secret: str
    type: str = "other"
    description: str | None = None

#Status
@app.get("/status/all")
def status_all(current_user: str = Depends(require_auth)):
    freeradius = subprocess.run(
        ["systemctl", "is-active", "freeradius"],
        capture_output=True,
        text=True
    )

    config_test = subprocess.run(
        ["sudo", "/usr/sbin/freeradius", "-XC"],
        capture_output=True,
        text=True,
        timeout=30
    )

    try:
        with engine.begin() as conn:
            conn.execute(text("SELECT 1"))
            db_ok = True

            failed = conn.execute(text("""
                SELECT username, reply_packet_type, created_at, nas_ip_address, calling_station_id
                FROM radius_request_log
                WHERE reply_packet_type NOT LIKE '%Accept%'
                ORDER BY created_at DESC
                LIMIT 10
            """)).mappings().all()

            recent = conn.execute(text("""
                SELECT username, reply_packet_type, created_at, nas_ip_address, calling_station_id
                FROM radius_request_log
                ORDER BY created_at DESC
                LIMIT 10
            """)).mappings().all()

    except Exception:
        db_ok = False
        failed = []
        recent = []

    return {
        "freeradius_active": freeradius.stdout.strip() == "active",
        "freeradius_status": freeradius.stdout.strip(),
        "config_ok": config_test.returncode == 0,
        "database_ok": db_ok,
        "recent_failed_auth": list(failed),
        "recent_auth": list(recent)
    }

# ---------------------------------------------------------------------------
# Shared database helpers
# ---------------------------------------------------------------------------
TEMPLATE_DIR = Path("/opt/radiusaurus/templates/freeradius")

def render_template(template_name: str, context: dict):
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True
    )

    template = env.get_template(template_name)
    return template.render(**context)

def normalize_mac(mac: str):
    """Normalize MAC addresses to FreeRADIUS no-delimiter lowercase format."""
    return mac.lower().replace(":", "").replace("-", "").replace(".", "")

def sync_mac_vlan_reply(conn, mac: str, vlan_number: int | None):
    """Replace the per-MAC VLAN reply attributes in radreply."""
    conn.execute(text("""
        DELETE FROM radreply
        WHERE username = :username
          AND attribute IN (
            'Tunnel-Type',
            'Tunnel-Medium-Type',
            'Tunnel-Private-Group-Id'
          )
    """), {
        "username": mac
    })

    if vlan_number is None:
        return

    for attribute, value in [
        ("Tunnel-Type", "VLAN"),
        ("Tunnel-Medium-Type", "IEEE-802"),
        ("Tunnel-Private-Group-Id", str(vlan_number)),
    ]:
        conn.execute(text("""
            INSERT INTO radreply(username, attribute, op, value)
            VALUES (:username, :attribute, ':=', :value)
        """), {
            "username": mac,
            "attribute": attribute,
            "value": value
        })

def sync_group_replies(conn, group_name: str, group: RadiusGroup | RadiusGroupUpdate):
    """Rebuild radgroupreply entries from a Radiusaurus group record."""
    conn.execute(
        text("DELETE FROM radgroupreply WHERE groupname = :groupname"),
        {"groupname": group_name}
    )

    replies = []

    if group.vlan_number is not None:
        replies += [
            ("Tunnel-Type", ":=", "VLAN"),
            ("Tunnel-Medium-Type", ":=", "IEEE-802"),
            ("Tunnel-Private-Group-Id", ":=", str(group.vlan_number)),
        ]

    if group.session_timeout is not None:
        replies.append(("Session-Timeout", ":=", str(group.session_timeout)))

    if group.idle_timeout is not None:
        replies.append(("Idle-Timeout", ":=", str(group.idle_timeout)))

    if group.aruba_role:
        replies.append(("Aruba-User-Role", ":=", group.aruba_role))

    if group.filter_id:
        replies.append(("Filter-Id", ":=", group.filter_id))

    for attribute, op, value in replies:
        conn.execute(text("""
            INSERT INTO radgroupreply(groupname, attribute, op, value)
            VALUES (:groupname, :attribute, :op, :value)
        """), {
            "groupname": group_name,
            "attribute": attribute,
            "op": op,
            "value": value
        })


def delete_freeradius_group_policy(conn, group_name: str):
    """Remove all FreeRADIUS policy rows linked to a group."""
    conn.execute(
        text("DELETE FROM radgroupreply WHERE groupname = :groupname"),
        {"groupname": group_name}
    )

    conn.execute(
        text("DELETE FROM radgroupcheck WHERE groupname = :groupname"),
        {"groupname": group_name}
    )

@app.get("/")
def root():
    return {"app": "Radiusaurus", "status": "running"}

# ---------------------------------------------------------------------------
# Certificate management endpoints
# ---------------------------------------------------------------------------
@app.get("/certificates")
def list_certificates(current_user: str = Depends(require_auth)):
    CLIENT_DIR.mkdir(parents=True, exist_ok=True)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    file_certs = []

    for cert in CLIENT_DIR.glob("*.crt"):
        revoked_file = CLIENT_DIR / f"{cert.stem}.revoked"

        file_certs.append({
            "name": cert.stem,
            "certificate": str(cert),
            "pfx": str(EXPORT_DIR / f"{cert.stem}.pfx"),
            "has_pfx": (EXPORT_DIR / f"{cert.stem}.pfx").exists(),
            "revoked_file": revoked_file.exists()
        })

    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT common_name, username, mac, device_name, description, revoked
            FROM radiusaurus_certificates
        """)).mappings().all()

    db_map = {row["common_name"]: dict(row) for row in rows}

    result = []

    for cert in file_certs:
        db = db_map.get(cert["name"], {})

        result.append({
            "name": cert["name"],
            "certificate": cert["certificate"],
            "pfx": cert["pfx"],
            "has_pfx": cert["has_pfx"],
            "username": db.get("username"),
            "mac": db.get("mac"),
            "device_name": db.get("device_name"),
            "description": db.get("description"),
            "revoked": bool(db.get("revoked")) or cert["revoked_file"]
        })

    return result

@app.post("/certificates/client")
def create_client_certificate(
    item: ClientCertificateRequest,
    current_user: str = Depends(require_auth)
):
    name = safe_cert_name(item.common_name)

    CLIENT_DIR.mkdir(parents=True, exist_ok=True)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    key_file = CLIENT_DIR / f"{name}.key"
    csr_file = CLIENT_DIR / f"{name}.csr"
    crt_file = CLIENT_DIR / f"{name}.crt"
    pfx_file = EXPORT_DIR / f"{name}.pfx"

    if crt_file.exists() or pfx_file.exists():
        raise HTTPException(status_code=409, detail="Certificate already exists")

    settings = load_settings()

    subj = (
        f"/C={settings.get('certificate_country', 'BE')}"
        f"/ST={settings.get('certificate_state', 'Limburg')}"
        f"/O={settings.get('certificate_organization', 'Radiusaurus')}"
        f"/CN={name}"
        f"/emailAddress={settings.get('support_email', 'support@example.local')}"
    )
    commands = [
        [
            "openssl", "req",
            "-new",
            "-newkey", "rsa:2048",
            "-nodes",
            "-keyout", str(key_file),
            "-out", str(csr_file),
            "-subj", subj
        ],
        [
            "openssl", "x509",
            "-req",
            "-in", str(csr_file),
            "-CA", str(CA_CERT),
            "-CAkey", str(CA_KEY),
            "-passin", f"pass:{settings.get('certificate_ca_password', 'whatever')}",
            "-CAcreateserial",
            "-out", str(crt_file),
            "-days", str(item.days),
            "-sha256",
            "-extfile", "/etc/freeradius/3.0/certs/xpextensions",
            "-extensions", "xpclient_ext"
        ],
        [
            "openssl", "pkcs12",
            "-export",
            "-out", str(pfx_file),
            "-inkey", str(key_file),
            "-in", str(crt_file),
            "-certfile", str(CA_CERT),
            "-passout", f"pass:{item.export_password}"
        ]
    ]

    for command in commands:
        result = subprocess.run(command, capture_output=True, text=True)

        if result.returncode != 0:
            for file in [key_file, csr_file, crt_file, pfx_file]:
                if file.exists():
                    file.unlink()

            raise HTTPException(
                status_code=500,
                detail=result.stderr or result.stdout
            )

    key_file.chmod(0o640)
    crt_file.chmod(0o644)
    pfx_file.chmod(0o640)

    # Store certificate in database
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO radiusaurus_certificates
                (
                    common_name,
                    username,
                    mac,
                    device_name,
                    description,
                    revoked
                )
            VALUES
                (
                    :common_name,
                    :username,
                    :mac,
                    :device_name,
                    :description,
                    FALSE
                )
            ON DUPLICATE KEY UPDATE
                username = VALUES(username),
                mac = VALUES(mac),
                device_name = VALUES(device_name),
                description = VALUES(description),
                revoked = FALSE
        """), {
            "common_name": name,
            "username": item.username,
            "mac": normalize_mac(item.mac) if item.mac else None,
            "device_name": item.device_name,
            "description": item.description
        })

    return {
        "status": "created",
        "name": name,
        "download": f"/certificates/client/{name}/download"
    }

@app.get("/certificates/client/{name}/download")
def download_client_certificate(name: str, current_user: str = Depends(require_auth)):
    safe_name = safe_cert_name(name)
    pfx_file = EXPORT_DIR / f"{safe_name}.pfx"

    if not pfx_file.exists():
        raise HTTPException(status_code=404, detail="PFX not found")

    return FileResponse(
        path=str(pfx_file),
        filename=f"{safe_name}.pfx",
        media_type="application/x-pkcs12"
    )

@app.get("/certificates/ca/download")
def download_ca_certificate(current_user: str = Depends(require_auth)):
    if not CA_CERT.exists():
        raise HTTPException(status_code=404, detail="CA certificate not found")

    return FileResponse(
        path=str(CA_CERT),
        filename="Radiusaurus-CA.crt",
        media_type="application/x-x509-ca-cert"
    )

@app.delete("/certificates/client/{name}")
def delete_client_certificate(name: str, current_user: str = Depends(require_auth)):
    safe_name = safe_cert_name(name)

    files = [
        CLIENT_DIR / f"{safe_name}.key",
        CLIENT_DIR / f"{safe_name}.csr",
        CLIENT_DIR / f"{safe_name}.crt",
        CLIENT_DIR / f"{safe_name}.pem",
        EXPORT_DIR / f"{safe_name}.pfx",
    ]

    deleted = []

    for file in files:
        if file.exists():
            file.unlink()
            deleted.append(str(file))

    if not deleted:
        raise HTTPException(status_code=404, detail="No certificate files found")
    
    with engine.begin() as conn:
        conn.execute(text("""
            DELETE FROM radiusaurus_certificates
            WHERE common_name = :common_name
        """), {
            "common_name": safe_name
    })

    return {
        "status": "deleted",
        "name": safe_name,
        "deleted": deleted
    }

@app.post("/certificates/client/{name}/revoke")
def revoke_client_certificate(name: str, current_user: str = Depends(require_auth)):
    safe_name = safe_cert_name(name)
    settings = load_settings()

    crt_file = CLIENT_DIR / f"{safe_name}.crt"

    if not crt_file.exists():
        raise HTTPException(status_code=404, detail="Certificate not found")

    revoke_command = [
        "openssl",
        "ca",
        "-config", "/etc/freeradius/3.0/certs/client.cnf",
        "-revoke", str(crt_file),
        "-keyfile", str(CA_KEY),
        "-cert", str(CA_CERT),
    "-passin", f"pass:{settings.get('certificate_ca_password', 'whatever')}",
        "-batch"
    ]

    revoke = subprocess.run(
        revoke_command,
        capture_output=True,
        text=True,
        cwd="/etc/freeradius/3.0/certs"
    )

    if revoke.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=revoke.stderr or revoke.stdout
        )

    crl_file = CERT_BASE / "ca" / "crl.pem"

    crl_command = [
        "openssl",
        "ca",
        "-gencrl",
        "-config", "/etc/freeradius/3.0/certs/client.cnf",
        "-keyfile", str(CA_KEY),
        "-cert", str(CA_CERT),
        "-passin", f"pass:{settings.get('certificate_ca_password', 'whatever')}",
        "-out", str(crl_file)
    ]

    crl = subprocess.run(
        crl_command,
        capture_output=True,
        text=True,
        cwd="/etc/freeradius/3.0/certs"
    )

    if crl.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=crl.stderr or crl.stdout
        )
    
    revoked_file = CLIENT_DIR / f"{safe_name}.revoked"

    revoked_file.write_text(
        datetime.utcnow().isoformat() + "Z",
        encoding="utf-8"
    )
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE radiusaurus_certificates
            SET revoked = TRUE
            WHERE common_name = :common_name
        """), {
            "common_name": safe_name
        })

    return {
        "status": "revoked",
        "certificate": safe_name,
        "crl": str(crl_file)
    }

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
@app.get("/settings")
def get_settings(current_user: str = Depends(require_auth)):
    """Return customer-specific settings for the Settings page."""
    settings = load_settings()

    # Do not send the stored CA password back to the browser.
    settings.pop("certificate_ca_password", None)

    return settings


@app.put("/settings")
def update_settings(
    body: dict,
    current_user: str = Depends(require_auth)
):
    """Save customer-specific settings from the Settings page."""
    current_settings = load_settings()

    # Keep the old CA password if the password field is left empty in the UI.
    if not body.get("certificate_ca_password"):
        existing_password = current_settings.get("certificate_ca_password")
        if existing_password:
            body["certificate_ca_password"] = existing_password

    save_settings(body)

    return {"success": True}

# ---------------------------------------------------------------------------
# FreeRADIUS config file editor endpoints
# ---------------------------------------------------------------------------
def generate_queries_conf_content():
    template_path = TEMPLATE_DIR / "queries.conf.j2"
    return template_path.read_text(encoding="utf-8")

@app.post("/settings/generate/queries-conf")
def generate_queries_conf(current_user: str = Depends(require_auth)):
    settings = load_settings()

    target = Path(settings.get(
        "freeradius_queries_conf",
        "/etc/freeradius/3.0/mods-config/sql/main/mysql/queries.conf"
    ))

    backup_dir = Path(settings.get(
        "freeradius_backup_dir",
        "/opt/radiusaurus/backups/generated-configs"
    ))

    backup = backup_file(target, backup_dir)
    target.write_text(generate_queries_conf_content(), encoding="utf-8")

    return {
        "status": "generated",
        "file": str(target),
        "backup": backup
    }

def generate_sql_content():
    settings = load_settings()

    return render_template("sql.j2", {
        "sql_server": settings.get("sql_server", "localhost"),
        "sql_port": settings.get("sql_port", 3306),
        "sql_login": settings.get("sql_login", "radius"),
        "sql_password": settings.get("sql_password", ""),
        "sql_database": settings.get("sql_database", "radius"),
    })

def backup_file(path: Path, backup_dir: Path):
    backup_dir.mkdir(parents=True, exist_ok=True)

    if not path.exists():
        return None

    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    backup_path = backup_dir / f"{path.name}-{timestamp}.bak"
    shutil.copy2(path, backup_path)

    return str(backup_path)


def safe_freeradius_name(value: str):
    name = re.sub(r"[^a-zA-Z0-9_.-]", "-", str(value or "").strip())
    return name or "radius-client"

def generate_clients_conf_content():
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT nasname, shortname, type, secret
            FROM nas
            ORDER BY shortname, nasname
        """)).mappings().all()

    clients = []

    for row in rows:
        clients.append({
            "section_name": safe_freeradius_name(row["shortname"]),
            "nasname": row["nasname"],
            "shortname": safe_freeradius_name(row["shortname"]),
            "type": row["type"] or "other",
            "secret": row["secret"]
        })

    return render_template("clients.conf.j2", {
        "clients": clients
    })

@app.post("/settings/generate/sql")
def generate_sql_config(current_user: str = Depends(require_auth)):
    settings = load_settings()

    target = Path(settings.get(
        "freeradius_sql_conf",
        "/etc/freeradius/3.0/mods-enabled/sql"
    ))

    backup_dir = Path(settings.get(
        "freeradius_backup_dir",
        "/opt/radiusaurus/backups/generated-configs"
    ))

    backup = backup_file(target, backup_dir)
    target.write_text(generate_sql_content(), encoding="utf-8")

    return {
        "status": "generated",
        "file": str(target),
        "backup": backup
    }

@app.post("/settings/generate/clients-conf")
def generate_clients_conf(current_user: str = Depends(require_auth)):
    settings = load_settings()

    target = Path(
        settings.get(
            "freeradius_clients_conf",
            "/etc/freeradius/3.0/clients.conf"
        )
    )

    backup_dir = Path(
        settings.get(
            "freeradius_backup_dir",
            "/opt/radiusaurus/backups/generated-configs"
        )
    )

    backup = backup_file(target, backup_dir)
    content = generate_clients_conf_content()

    target.write_text(content, encoding="utf-8")

    return {
        "status": "generated",
        "file": str(target),
        "backup": backup
    }

def generate_eap_content():
    settings = load_settings()

    return render_template("eap.j2", {
        "default_eap_type": settings.get("freeradius_default_eap_type", "peap"),
        "private_key_password": settings.get("certificate_server_key_password", ""),
        "private_key_file": settings.get("freeradius_server_key", "/opt/radiusaurus/certs/server/server.key"),
        "certificate_file": settings.get("freeradius_server_cert", "/opt/radiusaurus/certs/server/server.pem"),
        "ca_file": settings.get("freeradius_ca_cert", "/opt/radiusaurus/certs/ca/ca.pem"),
        "dh_file": settings.get("freeradius_dh_file", "/opt/radiusaurus/certs/dh"),
        "tls_min_version": settings.get("freeradius_tls_min_version", "1.2"),
        "tls_max_version": settings.get("freeradius_tls_max_version", "1.3"),
    })

def generate_default_site_content():
    settings = load_settings()

    return render_template("default.j2", {
        "auth_port": settings.get("auth_port", 1812),
        "accounting_port": settings.get("accounting_port", 1813),
    })

def generate_inner_tunnel_content():
    return """#
# This file is generated by Radiusaurus.
# Handles tunneled PEAP/TTLS username/password auth.
#

server inner-tunnel {
    listen {
        ipaddr = 127.0.0.1
        port = 18120
        type = auth
    }

    authorize {
        chap
        mschap
        suffix
        update control {
            &Proxy-To-Realm := LOCAL
        }

        sql
        expiration
        logintime

        pap
    }

    authenticate {
        Auth-Type PAP {
            pap
        }

        Auth-Type CHAP {
            chap
        }

        Auth-Type MS-CHAP {
            mschap
        }
    }

    session {
        sql
    }

    post-auth {
        sql

        Post-Auth-Type REJECT {
            sql
            attr_filter.access_reject
        }
    }
}
"""

def generate_radius_request_log_content():
    settings = load_settings()

    return render_template("radius_request_log.j2", {
        "radius_request_log_file": settings.get(
            "radius_request_log_file",
            "/var/log/freeradius/radius-requests.log"
        )
    })

@app.post("/settings/generate/radius-request-log")
def generate_radius_request_log_config(current_user: str = Depends(require_auth)):
    settings = load_settings()

    target = Path(settings.get(
        "freeradius_radius_request_log_conf",
        "/etc/freeradius/3.0/mods-available/radius_request_log"
    ))

    backup_dir = Path(settings.get(
        "freeradius_backup_dir",
        "/opt/radiusaurus/backups/generated-configs"
    ))

    backup = backup_file(target, backup_dir)
    target.write_text(generate_radius_request_log_content(), encoding="utf-8")

    return {
        "status": "generated",
        "file": str(target),
        "backup": backup
    }

@app.post("/settings/generate/eap")
def generate_eap_config(current_user: str = Depends(require_auth)):
    settings = load_settings()

    target = Path(settings.get(
        "freeradius_eap_conf",
        "/etc/freeradius/3.0/mods-enabled/eap"
    ))

    backup_dir = Path(settings.get(
        "freeradius_backup_dir",
        "/opt/radiusaurus/backups/generated-configs"
    ))

    backup = backup_file(target, backup_dir)
    target.write_text(generate_eap_content(), encoding="utf-8")

    return {
        "status": "generated",
        "file": str(target),
        "backup": backup
    }


@app.post("/settings/generate/default-site")
def generate_default_site_config(current_user: str = Depends(require_auth)):
    settings = load_settings()

    target = Path(settings.get(
        "freeradius_default_site",
        "/etc/freeradius/3.0/sites-enabled/default"
    ))

    backup_dir = Path(settings.get(
        "freeradius_backup_dir",
        "/opt/radiusaurus/backups/generated-configs"
    ))

    backup = backup_file(target, backup_dir)
    target.write_text(generate_default_site_content(), encoding="utf-8")

    return {
        "status": "generated",
        "file": str(target),
        "backup": backup
    }


@app.post("/settings/generate/inner-tunnel")
def generate_inner_tunnel_config(current_user: str = Depends(require_auth)):
    settings = load_settings()

    target = Path(settings.get(
        "freeradius_inner_tunnel",
        "/etc/freeradius/3.0/sites-enabled/inner-tunnel"
    ))

    backup_dir = Path(settings.get(
        "freeradius_backup_dir",
        "/opt/radiusaurus/backups/generated-configs"
    ))

    backup = backup_file(target, backup_dir)
    target.write_text(generate_inner_tunnel_content(), encoding="utf-8")

    return {
        "status": "generated",
        "file": str(target),
        "backup": backup
    }


@app.post("/settings/generate/all")
def generate_all_freeradius_configs(current_user: str = Depends(require_auth)):
    settings = load_settings()

    backup_dir = Path(settings.get(
        "freeradius_backup_dir",
        "/opt/radiusaurus/backups/generated-configs"
    ))

    targets = {
        "clients_conf": (
            Path(settings.get(
                "freeradius_clients_conf",
                "/etc/freeradius/3.0/clients.conf"
            )),
            generate_clients_conf_content()
        ),
        "eap": (
            Path(settings.get(
                "freeradius_eap_conf",
                "/etc/freeradius/3.0/mods-enabled/eap"
            )),
            generate_eap_content()
        ),
        "default_site": (
            Path(settings.get(
                "freeradius_default_site",
                "/etc/freeradius/3.0/sites-enabled/default"
            )),
            generate_default_site_content()
        ),
        "inner_tunnel": (
            Path(settings.get(
                "freeradius_inner_tunnel",
                "/etc/freeradius/3.0/sites-enabled/inner-tunnel"
            )),
            generate_inner_tunnel_content()
        ),"sql": (
            Path(settings.get(
                "freeradius_sql_conf",
                "/etc/freeradius/3.0/mods-enabled/sql"
            )),
            generate_sql_content()
        ),"radius_request_log": (
            Path(settings.get(
                "freeradius_radius_request_log_conf",
                "/etc/freeradius/3.0/mods-available/radius_request_log"
            )),
            generate_radius_request_log_content()
        ),"queries_conf": (
            Path(settings.get(
                "freeradius_queries_conf",
                "/etc/freeradius/3.0/mods-config/sql/main/mysql/queries.conf"
            )),
            generate_queries_conf_content()
        ),
    }

    result = {}

    for name, (target, content) in targets.items():
        backup = backup_file(target, backup_dir)
        target.write_text(content, encoding="utf-8")

        result[name] = {
            "status": "generated",
            "file": str(target),
            "backup": backup
        }

    return result

@app.get("/config-files")
def list_config_files(current_user: str = Depends(require_auth)):
    return [
        {"key": key, "path": path}
        for key, path in ALLOWED_CONFIG_FILES.items()
    ]

@app.get("/config-files/{key}")
def read_config_file(key: str, current_user: str = Depends(require_auth)):
    path = ALLOWED_CONFIG_FILES.get(key)

    if not path:
        raise HTTPException(status_code=404, detail="Config file not allowed")

    file_path = Path(path)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Config file does not exist")

    return {
        "key": key,
        "path": path,
        "content": file_path.read_text(encoding="utf-8")
    }

@app.put("/config-files/{key}")
def update_config_file(key: str, item: ConfigFileUpdate, current_user: str = Depends(require_auth)):
    path = ALLOWED_CONFIG_FILES.get(key)

    if not path or item.key != key:
        raise HTTPException(status_code=404, detail="Config file not allowed")

    file_path = Path(path)

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Config file does not exist")

    BACKUP_DIR = Path("/opt/radiusaurus/backups/config-files")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    safe_key = safe_cert_name(key)

    backup_path = BACKUP_DIR / f"{safe_key}-{timestamp}.bak"

    shutil.copy2(file_path, backup_path)
    file_path.write_text(item.content, encoding="utf-8")

    return {
        "status": "saved",
        "backup": str(backup_path)
    }

@app.post("/config-files/test")
def test_freeradius_config(current_user: str = Depends(require_auth)):
    result = subprocess.run(
        ["sudo", "/usr/sbin/freeradius", "-XC"],
        capture_output=True,
        text=True,
        timeout=30
    )

    return {
        "ok": result.returncode == 0,
        "stdout": result.stdout,
        "stderr": result.stderr
    }

@app.post("/config-files/reload")
def reload_freeradius(current_user: str = Depends(require_auth)):
    result = subprocess.run(
        ["sudo", "/bin/systemctl", "reload", "freeradius"],
        capture_output=True,
        text=True,
        timeout=30
    )

    return {
        "ok": result.returncode == 0,
        "stdout": result.stdout,
        "stderr": result.stderr
    }

# ---------------------------------------------------------------------------
# Authentication history endpoints
# ---------------------------------------------------------------------------
@app.get("/auth-history")
def auth_history(current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT
                username,
                pass,
                reply,
                authdate
            FROM radpostauth
            ORDER BY authdate DESC
            LIMIT 200
        """)).mappings().all()

        return list(rows)
    
# ---------------------------------------------------------------------------
# Policy inspection endpoints
# ---------------------------------------------------------------------------
@app.get("/policies")
def list_policies(current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT
                g.group_name,
                g.group_type,
                g.vlan_number,
                v.vlan_name,
                g.session_timeout,
                g.idle_timeout,
                g.aruba_role,
                g.filter_id,
                r.attribute,
                r.op,
                r.value
            FROM radiusaurus_groups g
            LEFT JOIN radiusaurus_vlans v
                ON g.vlan_number = v.vlan_number
            LEFT JOIN radgroupreply r
                ON g.group_name = r.groupname
            ORDER BY g.group_name, r.id
        """)).mappings().all()

        return list(rows)
    
# ---------------------------------------------------------------------------
# MAC authentication endpoints
# ---------------------------------------------------------------------------
@app.post("/mac-addresses")
def add_mac(mac: MacAddress, current_user: str = Depends(require_auth)):
    normalized = normalize_mac(mac.mac)

    if len(normalized) != 12:
        raise HTTPException(status_code=400, detail="Invalid MAC address")

    with engine.begin() as conn:
        exists = conn.execute(
            text("SELECT id FROM radcheck WHERE username = :username"),
            {"username": normalized}
        ).first()

        if exists:
            raise HTTPException(status_code=409, detail="MAC already exists")

        conn.execute(text("""
            INSERT INTO radcheck(username, attribute, op, value)
            VALUES (:username, 'Auth-Type', ':=', 'Accept')
        """), {
            "username": normalized
        })

        conn.execute(text("""
            INSERT INTO radusergroup(username, groupname, priority)
            VALUES (:username, :groupname, 1)
        """), {
            "username": normalized,
            "groupname": mac.group
        })

        conn.execute(text("""
            INSERT INTO radiusaurus_mac_devices
               (mac, username, device_name, description, groupname, vlan_number)
            VALUES
               (:mac, :username, :device_name, :description, :groupname, :vlan_number)
          """), {
             "mac": normalized,
             "username": mac.username,
             "device_name": mac.device_name,
             "description": mac.description,
             "groupname": mac.group,
             "vlan_number": mac.vlan_number
         })
        sync_mac_vlan_reply(conn, normalized, mac.vlan_number)
        return {
            "status": "created",
            "mac": normalized,
            "username": mac.username,
            "device_name": mac.device_name,
            "description": mac.description,
            "group": mac.group
        }


@app.get("/mac-addresses")
def list_macs(current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT
                m.mac,
                m.username,
                m.device_name,
                m.description,
                m.groupname,
                m.vlan_number,
                v.vlan_name,
                v.location,
                m.created_at,
                m.updated_at
            FROM radiusaurus_mac_devices m
            LEFT JOIN radiusaurus_vlans v
                ON m.vlan_number = v.vlan_number
            ORDER BY m.device_name, m.mac
        """)).mappings().all()

        return list(rows)

@app.delete("/mac-addresses/{mac}")
def delete_mac(mac: str, current_user: str = Depends(require_auth)):
    normalized = normalize_mac(mac)

    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM radcheck WHERE username = :username"),
            {"username": normalized}
        )

        conn.execute(
            text("DELETE FROM radreply WHERE username = :username"),
            {"username": normalized}
        )

        conn.execute(
            text("DELETE FROM radusergroup WHERE username = :username"),
            {"username": normalized}
        )

        conn.execute(
            text("DELETE FROM radiusaurus_mac_devices WHERE mac = :mac"),
            {"mac": normalized}
        )

        return {
            "status": "deleted",
            "mac": normalized
        }

@app.put("/mac-addresses/{mac}")
def update_mac(mac: str, item: MacAddressUpdate, current_user: str = Depends(require_auth)):
    normalized = normalize_mac(mac)

    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE radiusaurus_mac_devices
            SET username = :username,
                device_name = :device_name,
                description = :description,
                groupname = :groupname,
                vlan_number = :vlan_number
            WHERE mac = :mac
        """), {
            "mac": normalized,
            "username": item.username,
            "device_name": item.device_name,
            "description": item.description,
            "groupname": item.group,
            "vlan_number": item.vlan_number
        })

        conn.execute(
            text("DELETE FROM radusergroup WHERE username = :username"),
            {"username": normalized}
        )

        conn.execute(text("""
            INSERT INTO radusergroup(username, groupname, priority)
            VALUES (:username, :groupname, 1)
        """), {
            "username": normalized,
            "groupname": item.group
        })
        sync_mac_vlan_reply(conn, normalized, item.vlan_number)
        return {"status": "updated", "mac": normalized}

# ---------------------------------------------------------------------------
# User endpoints
# ---------------------------------------------------------------------------
@app.get("/users")
def list_users(current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT
                r.username,
                MAX(CASE WHEN r.attribute = 'Cleartext-Password' THEN r.value END) AS password_set,
                g.groupname,
                gr_vlan.value AS group_vlan,
                rr_vlan.value AS user_vlan
            FROM radcheck r
            LEFT JOIN radusergroup g
                ON r.username = g.username
            LEFT JOIN radiusaurus_mac_devices m
                ON r.username = m.mac
            LEFT JOIN radgroupreply gr_vlan
                ON g.groupname = gr_vlan.groupname
               AND gr_vlan.attribute = 'Tunnel-Private-Group-Id'
            LEFT JOIN radreply rr_vlan
                ON r.username = rr_vlan.username
               AND rr_vlan.attribute = 'Tunnel-Private-Group-Id'
            WHERE m.mac IS NULL
            GROUP BY r.username, g.groupname, gr_vlan.value, rr_vlan.value
            ORDER BY r.username
        """)).mappings().all()

        return list(rows)

@app.post("/users")
def create_user(user: RadiusUser, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        exists = conn.execute(
            text("SELECT id FROM radcheck WHERE username = :username"),
            {"username": user.username}
        ).first()

        if exists:
            raise HTTPException(status_code=409, detail="User already exists")

        conn.execute(text("""
            INSERT INTO radcheck(username, attribute, op, value)
            VALUES (:username, 'Cleartext-Password', ':=', :password)
        """), {
            "username": user.username,
            "password": user.password
        })

        conn.execute(text("""
            INSERT INTO radusergroup(username, groupname, priority)
            VALUES (:username, :groupname, 1)
        """), {
            "username": user.username,
            "groupname": user.group
        })

        return {"status": "created"}

@app.delete("/users/{username}")
def delete_user(username: str, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM radcheck WHERE username = :username"), {"username": username})
        conn.execute(text("DELETE FROM radreply WHERE username = :username"), {"username": username})
        conn.execute(text("DELETE FROM radusergroup WHERE username = :username"), {"username": username})
        return {"status": "deleted"}

@app.put("/users/{username}")
def update_user(username: str, user: RadiusUserUpdate, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        exists = conn.execute(
            text("SELECT id FROM radcheck WHERE username = :username"),
            {"username": username}
        ).first()

        if not exists:
            raise HTTPException(status_code=404, detail="User not found")

        if user.password:
            conn.execute(text("""
                UPDATE radcheck
                SET value = :password
                WHERE username = :username
                  AND attribute = 'Cleartext-Password'
            """), {
                "username": username,
                "password": user.password
            })

        if user.group:
            conn.execute(
                text("DELETE FROM radusergroup WHERE username = :username"),
                {"username": username}
            )

            conn.execute(text("""
                INSERT INTO radusergroup(username, groupname, priority)
                VALUES (:username, :groupname, 1)
            """), {
                "username": username,
                "groupname": user.group
            })

        return {"status": "updated", "username": username}


# ---------------------------------------------------------------------------
# Group endpoints
# ---------------------------------------------------------------------------
@app.get("/groups")
def list_groups(current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT
                g.id,
                g.group_name,
                g.group_type,
                g.vlan_number,
                v.vlan_name,
                g.session_timeout,
                g.idle_timeout,
                g.aruba_role,
                g.filter_id,
                g.allow_peap,
                g.allow_ttls,
                g.allow_mab,
                g.created_at,
                COUNT(DISTINCT ug.username) AS member_count
            FROM radiusaurus_groups g
            LEFT JOIN radiusaurus_vlans v
                ON g.vlan_number = v.vlan_number
            LEFT JOIN radusergroup ug
                ON g.group_name = ug.groupname
            GROUP BY
                g.id,
                g.group_name,
                g.group_type,
                g.vlan_number,
                v.vlan_name,
                g.session_timeout,
                g.idle_timeout,
                g.aruba_role,
                g.filter_id,
                g.allow_peap,
                g.allow_ttls,
                g.allow_mab,
                g.created_at
            ORDER BY g.group_name
        """)).mappings().all()

        return list(rows)


@app.post("/groups")
def create_group(group: RadiusGroup, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        exists = conn.execute(text("""
            SELECT id FROM radiusaurus_groups
            WHERE group_name = :group_name
        """), {
            "group_name": group.group_name
        }).first()

        if exists:
            raise HTTPException(status_code=409, detail="Group already exists")

        conn.execute(text("""
            INSERT INTO radiusaurus_groups(
                group_name,
                group_type,
                vlan_number,
                session_timeout,
                idle_timeout,
                aruba_role,
                filter_id,
                allow_peap,
                allow_ttls,
                allow_mab
            )
            VALUES (
                :group_name,
                :group_type,
                :vlan_number,
                :session_timeout,
                :idle_timeout,
                :aruba_role,
                :filter_id,
                :allow_peap,
                :allow_ttls,
                :allow_mab
            )
        """), {
            "group_name": group.group_name,
            "group_type": group.group_type,
            "vlan_number": group.vlan_number,
            "session_timeout": group.session_timeout,
            "idle_timeout": group.idle_timeout,
            "aruba_role": group.aruba_role,
            "filter_id": group.filter_id,
            "allow_peap": group.allow_peap,
            "allow_ttls": group.allow_ttls,
            "allow_mab": group.allow_mab
        })

        sync_group_replies(conn, group.group_name, group)

        return {"status": "created", "group_name": group.group_name}


@app.put("/groups/{group_name}")
def update_group(group_name: str, group: RadiusGroupUpdate, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE radiusaurus_groups
            SET group_type = :group_type,
                vlan_number = :vlan_number,
                session_timeout = :session_timeout,
                idle_timeout = :idle_timeout,
                aruba_role = :aruba_role,
                filter_id = :filter_id,
                allow_peap = :allow_peap,
                allow_ttls = :allow_ttls,
                allow_mab = :allow_mab
            WHERE group_name = :group_name
        """), {
            "group_name": group_name,
            "group_type": group.group_type,
            "vlan_number": group.vlan_number,
            "session_timeout": group.session_timeout,
            "idle_timeout": group.idle_timeout,
            "aruba_role": group.aruba_role,
            "filter_id": group.filter_id,
            "allow_peap": group.allow_peap,
            "allow_ttls": group.allow_ttls,
            "allow_mab": group.allow_mab
        })

        sync_group_replies(conn, group_name, group)

        return {"status": "updated", "group_name": group_name}


@app.delete("/groups/{group_name}")
def delete_group(group_name: str, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        in_use = conn.execute(text("""
            SELECT username
            FROM radusergroup
            WHERE groupname = :group_name
            LIMIT 1
        """), {
            "group_name": group_name
        }).first()

        if in_use:
            raise HTTPException(
                status_code=409,
                detail="Cannot delete group while users or MAC devices are assigned to it"
            )

        conn.execute(
            text("DELETE FROM radiusaurus_groups WHERE group_name = :group_name"),
            {"group_name": group_name}
        )

        conn.execute(
            text("DELETE FROM radgroupreply WHERE groupname = :group_name"),
            {"group_name": group_name}
        )

        conn.execute(
            text("DELETE FROM radgroupcheck WHERE groupname = :group_name"),
            {"group_name": group_name}
        )

        return {"status": "deleted", "group_name": group_name}

# ---------------------------------------------------------------------------
# VLAN endpoints
# ---------------------------------------------------------------------------
@app.get("/vlans")
def list_vlans(current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT id, vlan_number, vlan_name, location, description, created_at
            FROM radiusaurus_vlans
            ORDER BY vlan_number
        """)).mappings().all()
        return list(rows)


@app.post("/vlans")
def create_vlan(vlan: RadiusVlan, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO radiusaurus_vlans(vlan_number, vlan_name, location, description)
            VALUES (:vlan_number, :vlan_name, :location, :description)
        """), {
            "vlan_number": vlan.vlan_number,
            "vlan_name": vlan.vlan_name,
            "location": vlan.location,
            "description": vlan.description
        })
        return {"status": "created"}


@app.delete("/vlans/{vlan_number}")
def delete_vlan(vlan_number: int, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM radiusaurus_vlans WHERE vlan_number = :vlan_number"),
            {"vlan_number": vlan_number}
        )
        return {"status": "deleted", "vlan_number": vlan_number}

@app.put("/vlans/{vlan_number}")
def update_vlan(vlan_number: int, vlan: RadiusVlanUpdate, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE radiusaurus_vlans
            SET vlan_name = :vlan_name,
                location = :location,
                description = :description
            WHERE vlan_number = :vlan_number
        """), {
            "vlan_number": vlan_number,
            "vlan_name": vlan.vlan_name,
            "location": vlan.location,
            "description": vlan.description
        })

        return {"status": "updated", "vlan_number": vlan_number}

# ---------------------------------------------------------------------------
# RADIUS client endpoints
# ---------------------------------------------------------------------------
@app.get("/clients")
def list_clients(current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT id, nasname, shortname, type, ports, secret, server, community, description
            FROM nas
            ORDER BY shortname, nasname
        """)).mappings().all()
        return list(rows)


@app.post("/clients")
def create_client(client: RadiusClient, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO nas(nasname, shortname, type, secret, description)
            VALUES (:nasname, :shortname, :type, :secret, :description)
        """), {
            "nasname": client.nasname,
            "shortname": client.shortname,
            "type": client.type,
            "secret": client.secret,
            "description": client.description
        })

        return {"status": "created"}


@app.put("/clients/{client_id}")
def update_client(client_id: int, client: RadiusClient, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE nas
            SET nasname = :nasname,
                shortname = :shortname,
                type = :type,
                secret = :secret,
                description = :description
            WHERE id = :id
        """), {
            "id": client_id,
            "nasname": client.nasname,
            "shortname": client.shortname,
            "type": client.type,
            "secret": client.secret,
            "description": client.description
        })

        return {"status": "updated", "id": client_id}


@app.delete("/clients/{client_id}")
def delete_client(client_id: int, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM nas WHERE id = :id"),
            {"id": client_id}
        )

        return {"status": "deleted", "id": client_id}

# ---------------------------------------------------------------------------
# Accounting session endpoints
# ---------------------------------------------------------------------------
@app.get("/sessions")
def sessions(current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT username, acctstarttime, acctstoptime, framedipaddress, nasipaddress
            FROM radacct
            ORDER BY acctstarttime DESC
            LIMIT 100
        """)).mappings().all()
        return list(rows)


# ---------------------------------------------------------------------------
# Detailed Radiusaurus request log endpoints
# ---------------------------------------------------------------------------
@app.get("/logs")
def get_logs(limit: int = 200, current_user: str = Depends(require_auth)):
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT
                id,
                username,
                NULL AS pass,
                reply_packet_type AS reply,
                created_at AS authdate,
                NULL AS class,
                nas_ip_address,
                client_ip_address,
                calling_station_id,
                called_station_id,
                packet_type,
                module_failure_message,
                framed_protocol,
                framed_compression,
                tunnel_type,
                tunnel_medium_type,
                tunnel_private_group_id
            FROM radius_request_log
            ORDER BY created_at DESC
            LIMIT :limit
        """), {"limit": limit}).mappings().all()

        return list(rows)
