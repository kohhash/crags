"""Crags Job Log - submission tracking dashboard.

Roles:
  member  - submits jobs, logs contacted people + chat history, sees own logs
            (or group / all logs if an administrator allows it)
  leader  - everything a member can do + sees performance of their group
  admin   - sees and manages everything: users, groups, permissions, sign-up

Usernames follow "<group>-<name>", e.g. 3-ALEX belongs to group 3.
"""
import csv
import io
import os
import re
import secrets
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, g, jsonify, request, send_file, send_from_directory, session, Response
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("CRAGS_DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "crags.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")

USERNAME_RE = re.compile(r"^(\d{1,4})-([A-Za-z0-9_.]{1,32})$")
ADMIN_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,40}$")
ROLES = ("member", "leader", "admin")
SCOPES = ("own", "group", "all")
CONTACT_STATUSES = ("contacted", "replied", "in_progress", "success", "closed")

DEFAULT_SETTINGS = {
    "signup_enabled": "1",
    "require_approval": "0",
    "default_view_scope": "own",
    "points_job": "1",
    "points_contact": "2",
    "points_success": "5",
}

FIELD_LIMITS = {
    "name": 200, "crag_username": 100, "location": 200, "job_type": 100,
    "job_title": 300, "job_description": 20000,
    "contact_info": 500, "platform": 100, "notes": 5000, "content": 20000,
}


# --------------------------------------------------------------------------- #
# App / DB setup
# --------------------------------------------------------------------------- #

def _load_secret_key():
    env = os.environ.get("CRAGS_SECRET_KEY")
    if env:
        return env
    path = os.path.join(DATA_DIR, "secret.key")
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(path, "w") as f:
        f.write(key)
    os.chmod(path, 0o600)
    return key


os.makedirs(DATA_DIR, exist_ok=True)
app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=_load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("CRAGS_SECURE_COOKIES") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def _close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def init_db():
    conn = connect()
    conn.execute("PRAGMA journal_mode = WAL")
    with open(os.path.join(BASE_DIR, "schema.sql")) as f:
        conn.executescript(f.read())
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))

    has_admin = conn.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone()
    if not has_admin:
        username = os.environ.get("ADMIN_USERNAME", "admin")
        password = os.environ.get("ADMIN_PASSWORD") or secrets.token_urlsafe(9)
        conn.execute(
            "INSERT INTO users(username, full_name, password_hash, role, view_scope, active) "
            "VALUES (?, '', ?, 'admin', 'all', 1)",
            (username, generate_password_hash(password)),
        )
        cred_file = os.path.join(DATA_DIR, "initial-admin.txt")
        with open(cred_file, "w") as f:
            f.write(f"username: {username}\npassword: {password}\n")
        os.chmod(cred_file, 0o600)
        print("=" * 60)
        print(" Administrator account created")
        print(f"   username: {username}")
        print(f"   password: {password}")
        print(f" (also saved to {cred_file} - delete it after first login)")
        print("=" * 60, flush=True)
    conn.commit()
    conn.close()


def get_settings():
    rows = db().execute("SELECT key, value FROM settings").fetchall()
    s = dict(DEFAULT_SETTINGS)
    s.update({r["key"]: r["value"] for r in rows})
    return s


def ensure_group(number):
    if number is not None:
        db().execute("INSERT OR IGNORE INTO groups(number) VALUES (?)", (number,))


# --------------------------------------------------------------------------- #
# Errors, auth helpers
# --------------------------------------------------------------------------- #

class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def _api_error(e):
    return jsonify(error=e.message), e.status


@app.errorhandler(HTTPException)
def _http_error(e):
    if request.path.startswith("/api/"):
        return jsonify(error=e.description or e.name), e.code
    return e


@app.before_request
def _csrf_guard():
    # Every state-changing API call must come from our own frontend (custom header
    # cannot be set cross-site without CORS preflight, which we never allow).
    if request.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("X-Requested-With") != "crags":
            raise ApiError("Missing request header", 403)


def current_user():
    if "user" in g:
        return g.user
    uid = session.get("uid")
    user = None
    if uid:
        user = db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if user is None or not user["active"] or session.get("pwv") != user["password_hash"][-12:]:
            session.clear()
            user = None
    g.user = user
    return user


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if current_user() is None:
            raise ApiError("Please sign in", 401)
        return fn(*a, **kw)
    return wrapper


def roles_required(*roles):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if u is None:
                raise ApiError("Please sign in", 401)
            if u["role"] not in roles:
                raise ApiError("You do not have permission for this", 403)
            return fn(*a, **kw)
        return wrapper
    return deco


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Expected a JSON body")
    return data


def text(data, key, required=False, default=""):
    val = data.get(key, default)
    if val is None:
        val = ""
    if not isinstance(val, (str, int, float)):
        raise ApiError(f"Invalid value for {key}")
    val = str(val).strip()
    if required and not val:
        raise ApiError(f"{key.replace('_', ' ').capitalize()} is required")
    limit = FIELD_LIMITS.get(key, 500)
    if len(val) > limit:
        raise ApiError(f"{key.replace('_', ' ').capitalize()} is too long (max {limit} characters)")
    return val


def parse_group_from_username(username):
    m = USERNAME_RE.match(username)
    return int(m.group(1)) if m else None


def user_public(u):
    return {
        "id": u["id"], "username": u["username"], "full_name": u["full_name"],
        "role": u["role"], "group_number": u["group_number"],
        "view_scope": u["view_scope"], "effective_scope": effective_scope(u),
        "active": bool(u["active"]), "created_at": u["created_at"], "last_login": u["last_login"],
    }


def effective_scope(u):
    if u["role"] == "admin":
        return "all"
    scope = u["view_scope"]
    if u["role"] == "leader" and scope == "own":
        scope = "group"
    return scope


def visibility_clause(u):
    """SQL fragment limiting jobs (alias j) / owners (alias ju) to what `u` may see."""
    scope = effective_scope(u)
    if scope == "all":
        return "1=1", []
    if scope == "group" and u["group_number"] is not None:
        return "(ju.group_number = ? OR j.user_id = ?)", [u["group_number"], u["id"]]
    return "j.user_id = ?", [u["id"]]


def can_edit_job(u, job_owner_id):
    return u["role"] == "admin" or u["id"] == job_owner_id


def load_job_for(u, job_id, for_edit=False):
    vis, params = visibility_clause(u)
    job = db().execute(
        f"SELECT j.*, ju.username, ju.full_name AS owner_name, ju.group_number "
        f"FROM jobs j JOIN users ju ON ju.id = j.user_id WHERE j.id = ? AND {vis}",
        [job_id] + params,
    ).fetchone()
    if job is None:
        raise ApiError("Job not found", 404)
    if for_edit and not can_edit_job(u, job["user_id"]):
        raise ApiError("Only the owner or an administrator can change this job", 403)
    return job


def load_contact_for(u, contact_id, for_edit=False):
    c = db().execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
    if c is None:
        raise ApiError("Contact not found", 404)
    load_job_for(u, c["job_id"], for_edit=for_edit)
    return c


def touch_job(job_id):
    db().execute("UPDATE jobs SET updated_at = ? WHERE id = ?", (utcnow(), job_id))


# --------------------------------------------------------------------------- #
# Static frontend
# --------------------------------------------------------------------------- #

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


@app.route("/healthz")
def healthz():
    return "ok"


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #

@app.get("/api/public/settings")
def public_settings():
    s = get_settings()
    return jsonify(signup_enabled=s["signup_enabled"] == "1",
                   require_approval=s["require_approval"] == "1")


@app.post("/api/auth/signup")
def signup():
    s = get_settings()
    if s["signup_enabled"] != "1":
        raise ApiError("Sign up is currently disabled by the administrator", 403)
    data = body()
    username = text(data, "username", required=True)
    password = str(data.get("password") or "")
    group = parse_group_from_username(username)
    if group is None:
        raise ApiError("Username must look like <group>-<name>, e.g. 3-ALEX")
    if len(password) < 6:
        raise ApiError("Password must be at least 6 characters")
    if db().execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise ApiError("That username is already taken")
    active = 0 if s["require_approval"] == "1" else 1
    scope = s["default_view_scope"] if s["default_view_scope"] in SCOPES else "own"
    ensure_group(group)
    cur = db().execute(
        "INSERT INTO users(username, full_name, password_hash, role, group_number, view_scope, active) "
        "VALUES (?, '', ?, 'member', ?, ?, ?)",
        (username, generate_password_hash(password), group, scope, active),
    )
    db().commit()
    if not active:
        return jsonify(ok=True, pending=True,
                       message="Account created. An administrator must approve it before you can sign in.")
    user = db().execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    _start_session(user)
    return jsonify(ok=True, user=user_public(user))


def _start_session(user):
    session.clear()
    session.permanent = True
    session["uid"] = user["id"]
    session["pwv"] = user["password_hash"][-12:]  # invalidates sessions on password change
    db().execute("UPDATE users SET last_login = ? WHERE id = ?", (utcnow(), user["id"]))
    db().commit()


@app.post("/api/auth/login")
def login():
    data = body()
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")
    user = db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if user is None or not check_password_hash(user["password_hash"], password):
        raise ApiError("Wrong username or password", 401)
    if not user["active"]:
        raise ApiError("This account is disabled or waiting for administrator approval", 403)
    _start_session(user)
    return jsonify(ok=True, user=user_public(user))


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/auth/me")
def me():
    u = current_user()
    if u is None:
        return jsonify(user=None)
    group = None
    if u["group_number"] is not None:
        row = db().execute("SELECT * FROM groups WHERE number = ?", (u["group_number"],)).fetchone()
        group = dict(row) if row else {"number": u["group_number"], "name": ""}
    return jsonify(user=user_public(u), group=group)


@app.post("/api/auth/password")
@login_required
def change_password():
    data = body()
    u = current_user()
    if not check_password_hash(u["password_hash"], str(data.get("current_password") or "")):
        raise ApiError("Current password is wrong")
    new = str(data.get("new_password") or "")
    if len(new) < 6:
        raise ApiError("New password must be at least 6 characters")
    db().execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(new), u["id"]))
    db().commit()
    user = db().execute("SELECT * FROM users WHERE id = ?", (u["id"],)).fetchone()
    _start_session(user)
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #

SORTABLE = {
    "created_at": "j.created_at", "name": "j.name", "username": "ju.username", "crag_username": "j.crag_username",
    "location": "j.location", "job_type": "j.job_type", "job_title": "j.job_title",
    "contact_count": "contact_count", "last_activity": "last_activity",
}


DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _date_arg(value, end):
    """Accept a UTC 'YYYY-MM-DD HH:MM:SS' (sent by the browser) or a plain date."""
    value = value.strip()
    if DATETIME_RE.match(value):
        return value
    if DATE_RE.match(value):
        return value + (" 23:59:59" if end else " 00:00:00")
    raise ApiError("Invalid date filter")


def build_job_filter(u):
    """Translate query-string filters into SQL (always within the user's visibility)."""
    vis, params = visibility_clause(u)
    where = [vis]
    a = request.args

    view = a.get("view", "")
    if view == "mine":
        where.append("j.user_id = ?")
        params.append(u["id"])
    elif view == "group" and u["group_number"] is not None:
        where.append("ju.group_number = ?")
        params.append(u["group_number"])

    if a.get("group", "").strip().lstrip("-").isdigit():
        where.append("ju.group_number = ?")
        params.append(int(a["group"]))
    if a.get("user_id", "").isdigit():
        where.append("j.user_id = ?")
        params.append(int(a["user_id"]))
    if a.get("job_type"):
        where.append("j.job_type = ?")
        params.append(a["job_type"])
    if a.get("date_from"):
        where.append("j.created_at >= ?")
        params.append(_date_arg(a["date_from"], end=False))
    if a.get("date_to"):
        where.append("j.created_at <= ?")
        params.append(_date_arg(a["date_to"], end=True))
    q = a.get("q", "").strip()
    if q:
        like = f"%{q}%"
        where.append(
            "(j.name LIKE ? OR j.crag_username LIKE ? OR j.location LIKE ? OR j.job_type LIKE ? "
            "OR j.job_title LIKE ? OR j.job_description LIKE ? OR ju.username LIKE ? "
            "OR EXISTS (SELECT 1 FROM contacts c WHERE c.job_id = j.id AND (c.name LIKE ? OR c.contact_info LIKE ?)))"
        )
        params.extend([like] * 9)
    return " AND ".join(where), params


JOB_LIST_SELECT = """
SELECT j.*, ju.username, ju.full_name AS owner_name, ju.group_number,
  (SELECT COUNT(*) FROM contacts c WHERE c.job_id = j.id) AS contact_count,
  (SELECT COUNT(*) FROM contacts c WHERE c.job_id = j.id AND c.status = 'success') AS success_count,
  (SELECT COUNT(*) FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.job_id = j.id) AS message_count,
  COALESCE((SELECT MAX(m.sent_at) FROM messages m JOIN contacts c ON c.id = m.contact_id
            WHERE c.job_id = j.id), j.updated_at) AS last_activity
FROM jobs j JOIN users ju ON ju.id = j.user_id
"""


@app.get("/api/jobs")
@login_required
def list_jobs():
    u = current_user()
    where, params = build_job_filter(u)
    sort = SORTABLE.get(request.args.get("sort", "created_at"), "j.created_at")
    direction = "ASC" if request.args.get("dir") == "asc" else "DESC"
    try:
        page = max(1, int(request.args.get("page", 1)))
        per_page = min(200, max(5, int(request.args.get("per_page", 25))))
    except ValueError:
        page, per_page = 1, 25

    total = db().execute(
        f"SELECT COUNT(*) FROM jobs j JOIN users ju ON ju.id = j.user_id WHERE {where}", params
    ).fetchone()[0]
    totals = db().execute(
        f"SELECT COUNT(*) AS contacts, COALESCE(SUM(c.status = 'success'), 0) AS successes "
        f"FROM contacts c JOIN jobs j ON j.id = c.job_id JOIN users ju ON ju.id = j.user_id WHERE {where}",
        params,
    ).fetchone()
    rows = db().execute(
        f"{JOB_LIST_SELECT} WHERE {where} ORDER BY {sort} {direction}, j.id DESC LIMIT ? OFFSET ?",
        params + [per_page, (page - 1) * per_page],
    ).fetchall()
    jobs = []
    for r in rows:
        d = dict(r)
        d["can_edit"] = can_edit_job(u, r["user_id"])
        jobs.append(d)
    return jsonify(jobs=jobs, total=total, page=page, per_page=per_page,
                   total_contacts=totals["contacts"], total_successes=totals["successes"])


@app.get("/api/jobs/export.csv")
@roles_required("admin", "leader")
def export_jobs():
    u = current_user()
    where, params = build_job_filter(u)
    rows = db().execute(f"{JOB_LIST_SELECT} WHERE {where} ORDER BY j.created_at DESC", params).fetchall()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["id", "created_at_utc", "group", "account", "name", "crag_username", "location", "job_type",
                "job_title", "job_description", "people_contacted", "successful", "messages", "last_activity_utc"])
    for r in rows:
        w.writerow([r["id"], r["created_at"], r["group_number"], r["username"], r["name"], r["crag_username"],
                    r["location"], r["job_type"], r["job_title"], r["job_description"], r["contact_count"],
                    r["success_count"], r["message_count"], r["last_activity"]])
    fname = f"job-logs-{datetime.now().strftime('%Y%m%d-%H%M')}.csv"
    return Response("﻿" + out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.post("/api/jobs")
@login_required
def create_job():
    u = current_user()
    data = body()
    fields = {
        # The job's Name is always the submitter's username; crag username is free text and optional.
        "name": u["username"],
        "crag_username": text(data, "crag_username"),
        "location": text(data, "location"),
        "job_type": text(data, "job_type"),
        "job_title": text(data, "job_title", required=True),
        "job_description": text(data, "job_description"),
    }
    now = utcnow()
    cur = db().execute(
        "INSERT INTO jobs(user_id, name, crag_username, location, job_type, job_title, job_description, "
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (u["id"], fields["name"], fields["crag_username"], fields["location"], fields["job_type"],
         fields["job_title"], fields["job_description"], now, now),
    )
    db().commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.get("/api/jobs/<int:job_id>")
@login_required
def get_job(job_id):
    u = current_user()
    load_job_for(u, job_id)
    job = db().execute(f"{JOB_LIST_SELECT} WHERE j.id = ?", (job_id,)).fetchone()
    contacts = db().execute(
        "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id) AS message_count "
        "FROM contacts c WHERE c.job_id = ? ORDER BY c.created_at, c.id", (job_id,)
    ).fetchall()
    msgs = db().execute(
        "SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.job_id = ? "
        "ORDER BY m.sent_at, m.id", (job_id,)
    ).fetchall()
    by_contact = {}
    for m in msgs:
        by_contact.setdefault(m["contact_id"], []).append(dict(m))
    result = dict(job)
    result["can_edit"] = can_edit_job(u, job["user_id"])
    result["contacts"] = [dict(c, messages=by_contact.get(c["id"], [])) for c in contacts]
    return jsonify(job=result)


@app.put("/api/jobs/<int:job_id>")
@login_required
def update_job(job_id):
    u = current_user()
    job = load_job_for(u, job_id, for_edit=True)
    data = body()
    db().execute(
        "UPDATE jobs SET name = ?, crag_username = ?, location = ?, job_type = ?, job_title = ?, "
        "job_description = ?, updated_at = ? WHERE id = ?",
        (job["name"], text(data, "crag_username"), text(data, "location"),
         text(data, "job_type"), text(data, "job_title", required=True), text(data, "job_description"),
         utcnow(), job_id),
    )
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/jobs/<int:job_id>")
@login_required
def delete_job(job_id):
    u = current_user()
    load_job_for(u, job_id, for_edit=True)
    db().execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    db().commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# Contacts (people contacted via a job) and chat messages
# --------------------------------------------------------------------------- #

def _contact_fields(data):
    status = str(data.get("status") or "contacted")
    if status not in CONTACT_STATUSES:
        raise ApiError("Invalid status")
    return {
        "name": text(data, "name", required=True),
        "contact_info": text(data, "contact_info"),
        "platform": text(data, "platform"),
        "status": status,
        "notes": text(data, "notes"),
    }


def _parse_sent_at(value):
    """Accepts ISO strings from the browser (already converted to UTC by the client)."""
    if not value:
        return utcnow()
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise ApiError("Invalid message date")
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _insert_messages(contact_id, user_id, messages):
    if not isinstance(messages, list):
        raise ApiError("Messages must be a list")
    if len(messages) > 500:
        raise ApiError("Too many messages at once (max 500)")
    for m in messages:
        if not isinstance(m, dict):
            raise ApiError("Invalid message")
        content = text(m, "content")
        if not content:
            continue
        sender = m.get("sender") if m.get("sender") in ("me", "contact") else "me"
        db().execute(
            "INSERT INTO messages(contact_id, sender, content, sent_at, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (contact_id, sender, content, _parse_sent_at(m.get("sent_at")), user_id, utcnow()),
        )


@app.post("/api/jobs/<int:job_id>/contacts")
@login_required
def create_contact(job_id):
    u = current_user()
    load_job_for(u, job_id, for_edit=True)
    data = body()
    f = _contact_fields(data)
    now = utcnow()
    cur = db().execute(
        "INSERT INTO contacts(job_id, name, contact_info, platform, status, notes, created_by, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (job_id, f["name"], f["contact_info"], f["platform"], f["status"], f["notes"], u["id"], now, now),
    )
    _insert_messages(cur.lastrowid, u["id"], data.get("messages") or [])
    touch_job(job_id)
    db().commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.put("/api/contacts/<int:contact_id>")
@login_required
def update_contact(contact_id):
    u = current_user()
    c = load_contact_for(u, contact_id, for_edit=True)
    f = _contact_fields(body())
    db().execute(
        "UPDATE contacts SET name = ?, contact_info = ?, platform = ?, status = ?, notes = ?, updated_at = ? "
        "WHERE id = ?",
        (f["name"], f["contact_info"], f["platform"], f["status"], f["notes"], utcnow(), contact_id),
    )
    touch_job(c["job_id"])
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/contacts/<int:contact_id>")
@login_required
def delete_contact(contact_id):
    u = current_user()
    c = load_contact_for(u, contact_id, for_edit=True)
    db().execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
    touch_job(c["job_id"])
    db().commit()
    return jsonify(ok=True)


@app.post("/api/contacts/<int:contact_id>/messages")
@login_required
def add_messages(contact_id):
    u = current_user()
    c = load_contact_for(u, contact_id, for_edit=True)
    data = body()
    msgs = data.get("messages") if "messages" in data else [data]
    _insert_messages(contact_id, u["id"], msgs)
    db().execute("UPDATE contacts SET updated_at = ? WHERE id = ?", (utcnow(), contact_id))
    touch_job(c["job_id"])
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/messages/<int:message_id>")
@login_required
def delete_message(message_id):
    u = current_user()
    m = db().execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    if m is None:
        raise ApiError("Message not found", 404)
    c = load_contact_for(u, m["contact_id"], for_edit=True)
    db().execute("DELETE FROM messages WHERE id = ?", (message_id,))
    touch_job(c["job_id"])
    db().commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# Lookups for filters
# --------------------------------------------------------------------------- #

@app.get("/api/meta")
@login_required
def meta():
    u = current_user()
    vis, params = visibility_clause(u)
    job_types = [r[0] for r in db().execute(
        f"SELECT DISTINCT j.job_type FROM jobs j JOIN users ju ON ju.id = j.user_id "
        f"WHERE {vis} AND j.job_type != '' ORDER BY j.job_type", params)]
    locations = [r[0] for r in db().execute(
        f"SELECT DISTINCT j.location FROM jobs j JOIN users ju ON ju.id = j.user_id "
        f"WHERE {vis} AND j.location != '' ORDER BY j.location LIMIT 300", params)]
    scope = effective_scope(u)
    if scope == "all":
        users = db().execute("SELECT id, username, full_name, group_number FROM users ORDER BY username").fetchall()
        groups = db().execute("SELECT number, name FROM groups ORDER BY number").fetchall()
    elif scope == "group" and u["group_number"] is not None:
        users = db().execute("SELECT id, username, full_name, group_number FROM users WHERE group_number = ? "
                             "ORDER BY username", (u["group_number"],)).fetchall()
        groups = db().execute("SELECT number, name FROM groups WHERE number = ?", (u["group_number"],)).fetchall()
    else:
        users = [u]
        groups = []
    return jsonify(
        job_types=job_types, locations=locations,
        users=[{"id": x["id"], "username": x["username"], "full_name": x["full_name"],
                "group_number": x["group_number"]} for x in users],
        groups=[dict(x) for x in groups],
    )


# --------------------------------------------------------------------------- #
# Performance & competition
# --------------------------------------------------------------------------- #

def _since():
    try:
        days = int(request.args.get("days", 7))
    except ValueError:
        days = 7
    if days <= 0:
        return days, "0000-00-00 00:00:00"
    since = datetime.now(timezone.utc) - timedelta(days=days)
    return days, since.strftime("%Y-%m-%d %H:%M:%S")


def _points():
    s = get_settings()
    def num(k):
        try:
            return float(s[k])
        except (TypeError, ValueError):
            return float(DEFAULT_SETTINGS[k])
    return {"job": num("points_job"), "contact": num("points_contact"), "success": num("points_success")}


MEMBER_STATS_SELECT = """
SELECT u.id, u.username, u.full_name, u.role, u.group_number, u.active,
  (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id AND j.created_at >= :since) AS jobs,
  (SELECT COUNT(*) FROM contacts c JOIN jobs j ON j.id = c.job_id
     WHERE j.user_id = u.id AND c.created_at >= :since) AS contacts,
  (SELECT COUNT(*) FROM contacts c JOIN jobs j ON j.id = c.job_id
     WHERE j.user_id = u.id AND c.status = 'success' AND c.created_at >= :since) AS successes,
  (SELECT COUNT(*) FROM messages m JOIN contacts c ON c.id = m.contact_id JOIN jobs j ON j.id = c.job_id
     WHERE j.user_id = u.id AND m.created_at >= :since) AS messages,
  (SELECT MAX(j.created_at) FROM jobs j WHERE j.user_id = u.id) AS last_submission
FROM users u
"""


def _with_points(rows, pts):
    out = []
    for r in rows:
        d = dict(r)
        d["active"] = bool(d.get("active", 1))
        d["points"] = round(d["jobs"] * pts["job"] + d["contacts"] * pts["contact"]
                            + d["successes"] * pts["success"], 2)
        out.append(d)
    return out


def _daily_trend(where_sql, params, days):
    span = days if 0 < days <= 60 else 30
    start = (datetime.now(timezone.utc) - timedelta(days=span - 1)).strftime("%Y-%m-%d")
    jobs = dict(db().execute(
        f"SELECT date(j.created_at) d, COUNT(*) FROM jobs j JOIN users ju ON ju.id = j.user_id "
        f"WHERE {where_sql} AND j.created_at >= ? GROUP BY d", params + [start]).fetchall())
    contacts = dict(db().execute(
        f"SELECT date(c.created_at) d, COUNT(*) FROM contacts c JOIN jobs j ON j.id = c.job_id "
        f"JOIN users ju ON ju.id = j.user_id WHERE {where_sql} AND c.created_at >= ? GROUP BY d",
        params + [start]).fetchall())
    out = []
    base = datetime.strptime(start, "%Y-%m-%d")
    for i in range(span):
        d = (base + timedelta(days=i)).strftime("%Y-%m-%d")
        out.append({"date": d, "jobs": jobs.get(d, 0), "contacts": contacts.get(d, 0)})
    return out


@app.get("/api/stats/me")
@login_required
def stats_me():
    u = current_user()
    days, since = _since()
    pts = _points()
    row = db().execute(f"{MEMBER_STATS_SELECT} WHERE u.id = :uid", {"since": since, "uid": u["id"]}).fetchone()
    me_stats = _with_points([row], pts)[0]
    rank = None
    if u["group_number"] is not None:
        peers = _with_points(db().execute(
            f"{MEMBER_STATS_SELECT} WHERE u.group_number = :g AND u.role != 'admin' AND u.active = 1",
            {"since": since, "g": u["group_number"]}).fetchall(), pts)
        peers.sort(key=lambda x: -x["points"])
        for i, p in enumerate(peers):
            if p["id"] == u["id"]:
                rank = {"position": i + 1, "of": len(peers)}
    trend = _daily_trend("j.user_id = ?", [u["id"]], days)
    return jsonify(stats=me_stats, group_rank=rank, trend=trend, points=pts, days=days)


@app.get("/api/stats/group")
@roles_required("admin", "leader")
def stats_group():
    u = current_user()
    days, since = _since()
    if u["role"] == "admin":
        g_arg = request.args.get("group", "")
        if not g_arg.lstrip("-").isdigit():
            raise ApiError("Choose a group")
        group = int(g_arg)
    else:
        group = u["group_number"]
        if group is None:
            raise ApiError("You are not assigned to a group")
    pts = _points()
    members = _with_points(db().execute(
        f"{MEMBER_STATS_SELECT} WHERE u.group_number = :g AND u.role != 'admin' ORDER BY u.username",
        {"since": since, "g": group}).fetchall(), pts)
    members.sort(key=lambda x: (-x["points"], x["username"].lower()))
    info = db().execute("SELECT * FROM groups WHERE number = ?", (group,)).fetchone()
    totals = {k: sum(m[k] for m in members) for k in ("jobs", "contacts", "successes", "messages", "points")}
    totals["members"] = len([m for m in members if m["active"]])
    totals["points"] = round(totals["points"], 2)
    trend = _daily_trend("ju.group_number = ?", [group], days)
    return jsonify(group={"number": group, "name": info["name"] if info else ""},
                   members=members, totals=totals, trend=trend, points=pts, days=days)


@app.get("/api/stats/competition")
@login_required
def stats_competition():
    days, since = _since()
    pts = _points()
    groups = db().execute("""
        SELECT g.number, g.name,
          (SELECT COUNT(*) FROM users u WHERE u.group_number = g.number AND u.active = 1 AND u.role != 'admin') AS members,
          (SELECT COUNT(*) FROM jobs j JOIN users u ON u.id = j.user_id
             WHERE u.group_number = g.number AND j.created_at >= :since) AS jobs,
          (SELECT COUNT(*) FROM contacts c JOIN jobs j ON j.id = c.job_id JOIN users u ON u.id = j.user_id
             WHERE u.group_number = g.number AND c.created_at >= :since) AS contacts,
          (SELECT COUNT(*) FROM contacts c JOIN jobs j ON j.id = c.job_id JOIN users u ON u.id = j.user_id
             WHERE u.group_number = g.number AND c.status = 'success' AND c.created_at >= :since) AS successes,
          (SELECT GROUP_CONCAT(u.username, ', ') FROM users u
             WHERE u.group_number = g.number AND u.role = 'leader' AND u.active = 1) AS leaders
        FROM groups g ORDER BY g.number
    """, {"since": since}).fetchall()
    out = []
    for r in groups:
        d = dict(r)
        d["points"] = round(d["jobs"] * pts["job"] + d["contacts"] * pts["contact"] + d["successes"] * pts["success"], 2)
        d["points_per_member"] = round(d["points"] / d["members"], 2) if d["members"] else 0
        out.append(d)
    out = [d for d in out if d["members"] or d["points"]]
    top = _with_points(db().execute(
        f"{MEMBER_STATS_SELECT} WHERE u.role != 'admin' AND u.active = 1", {"since": since}).fetchall(), pts)
    top = sorted([t for t in top if t["points"] > 0], key=lambda x: -x["points"])[:10]
    return jsonify(groups=out, top_members=top, points=pts, days=days)


# --------------------------------------------------------------------------- #
# Administration
# --------------------------------------------------------------------------- #

def _active_admin_count(exclude_id=None):
    q = "SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1"
    params = []
    if exclude_id is not None:
        q += " AND id != ?"
        params.append(exclude_id)
    return db().execute(q, params).fetchone()[0]


@app.get("/api/admin/users")
@roles_required("admin")
def admin_users():
    rows = db().execute("""
        SELECT u.*, (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id) AS job_count
        FROM users u ORDER BY u.active ASC, COALESCE(u.group_number, -1), u.username
    """).fetchall()
    return jsonify(users=[dict(user_public(r), job_count=r["job_count"]) for r in rows])


@app.post("/api/admin/users")
@roles_required("admin")
def admin_create_user():
    data = body()
    username = text(data, "username", required=True)
    password = str(data.get("password") or "")
    role = data.get("role", "member")
    if role not in ROLES:
        raise ApiError("Invalid role")
    group = parse_group_from_username(username)
    if role != "admin" and group is None:
        raise ApiError("Username must look like <group>-<name>, e.g. 3-ALEX")
    if role == "admin" and group is None and not ADMIN_USERNAME_RE.match(username):
        raise ApiError("Invalid username")
    if len(password) < 6:
        raise ApiError("Password must be at least 6 characters")
    if db().execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise ApiError("That username is already taken")
    scope = data.get("view_scope", "own")
    if scope not in SCOPES:
        scope = "own"
    ensure_group(group)
    db().execute(
        "INSERT INTO users(username, full_name, password_hash, role, group_number, view_scope, active) "
        "VALUES (?, '', ?, ?, ?, ?, 1)",
        (username, generate_password_hash(password), role, group, scope),
    )
    db().commit()
    return jsonify(ok=True)


@app.put("/api/admin/users/<int:user_id>")
@roles_required("admin")
def admin_update_user(user_id):
    me_ = current_user()
    target = db().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if target is None:
        raise ApiError("User not found", 404)
    data = body()
    role = data.get("role", target["role"])
    scope = data.get("view_scope", target["view_scope"])
    active = 1 if data.get("active", bool(target["active"])) else 0
    full_name = text(data, "full_name", default=target["full_name"])
    group = data.get("group_number", target["group_number"])
    if group in ("", None):
        group = None
    else:
        try:
            group = int(group)
        except (TypeError, ValueError):
            raise ApiError("Group must be a number")
    if role not in ROLES or scope not in SCOPES:
        raise ApiError("Invalid role or view scope")
    if role != "admin" and group is None:
        raise ApiError("Members and group leaders need a group")
    if target["role"] == "admin" and (role != "admin" or not active) and _active_admin_count(exclude_id=user_id) == 0:
        raise ApiError("There must be at least one active administrator")
    if target["id"] == me_["id"] and not active:
        raise ApiError("You cannot disable your own account")
    ensure_group(group)
    db().execute(
        "UPDATE users SET role = ?, view_scope = ?, active = ?, full_name = ?, group_number = ? WHERE id = ?",
        (role, scope, active, full_name, group, user_id),
    )
    db().commit()
    return jsonify(ok=True)


@app.post("/api/admin/users/<int:user_id>/password")
@roles_required("admin")
def admin_reset_password(user_id):
    data = body()
    pw = str(data.get("password") or "")
    if len(pw) < 6:
        raise ApiError("Password must be at least 6 characters")
    cur = db().execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(pw), user_id))
    if cur.rowcount == 0:
        raise ApiError("User not found", 404)
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/admin/users/<int:user_id>")
@roles_required("admin")
def admin_delete_user(user_id):
    me_ = current_user()
    target = db().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if target is None:
        raise ApiError("User not found", 404)
    if target["id"] == me_["id"]:
        raise ApiError("You cannot delete your own account")
    if target["role"] == "admin" and _active_admin_count(exclude_id=user_id) == 0:
        raise ApiError("There must be at least one active administrator")
    db().execute("DELETE FROM users WHERE id = ?", (user_id,))
    db().commit()
    return jsonify(ok=True)


@app.post("/api/admin/users/bulk")
@roles_required("admin")
def admin_bulk_users():
    """Apply view scope / active state to everyone, a whole group, or selected users."""
    data = body()
    target = data.get("target")
    where, params = ["role != 'admin'"], []
    if target == "group":
        try:
            params.append(int(data.get("group")))
        except (TypeError, ValueError):
            raise ApiError("Choose a group")
        where.append("group_number = ?")
    elif target == "ids":
        ids = [int(i) for i in (data.get("ids") or []) if str(i).isdigit()]
        if not ids:
            raise ApiError("No users selected")
        where.append(f"id IN ({','.join('?' * len(ids))})")
        params.extend(ids)
    elif target != "all":
        raise ApiError("Invalid target")

    sets, set_params = [], []
    if "view_scope" in data:
        if data["view_scope"] not in SCOPES:
            raise ApiError("Invalid view scope")
        sets.append("view_scope = ?")
        set_params.append(data["view_scope"])
    if "active" in data:
        sets.append("active = ?")
        set_params.append(1 if data["active"] else 0)
    if not sets:
        raise ApiError("Nothing to change")
    cur = db().execute(f"UPDATE users SET {', '.join(sets)} WHERE {' AND '.join(where)}", set_params + params)
    db().commit()
    return jsonify(ok=True, updated=cur.rowcount)


@app.get("/api/admin/settings")
@roles_required("admin")
def admin_get_settings():
    return jsonify(settings=get_settings())


@app.put("/api/admin/settings")
@roles_required("admin")
def admin_put_settings():
    data = body()
    for key in ("signup_enabled", "require_approval"):
        if key in data:
            db().execute("UPDATE settings SET value = ? WHERE key = ?", ("1" if data[key] else "0", key))
    if "default_view_scope" in data:
        if data["default_view_scope"] not in SCOPES:
            raise ApiError("Invalid view scope")
        db().execute("UPDATE settings SET value = ? WHERE key = 'default_view_scope'", (data["default_view_scope"],))
    for key in ("points_job", "points_contact", "points_success"):
        if key in data:
            try:
                v = float(data[key])
            except (TypeError, ValueError):
                raise ApiError("Points must be numbers")
            if v < 0 or v > 1000:
                raise ApiError("Points must be between 0 and 1000")
            db().execute("UPDATE settings SET value = ? WHERE key = ?", (str(v).rstrip("0").rstrip("."), key))
    db().commit()
    return jsonify(ok=True, settings=get_settings())


@app.get("/api/admin/groups")
@roles_required("admin")
def admin_groups():
    rows = db().execute("""
        SELECT g.*,
          (SELECT COUNT(*) FROM users u WHERE u.group_number = g.number) AS user_count,
          (SELECT GROUP_CONCAT(u.username, ', ') FROM users u WHERE u.group_number = g.number AND u.role = 'leader') AS leaders
        FROM groups g ORDER BY g.number
    """).fetchall()
    return jsonify(groups=[dict(r) for r in rows])


@app.put("/api/admin/groups/<int:number>")
@roles_required("admin")
def admin_put_group(number):
    data = body()
    name = text(data, "name")
    db().execute("INSERT INTO groups(number, name) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET name = excluded.name",
                 (number, name))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/admin/groups/<int:number>")
@roles_required("admin")
def admin_delete_group(number):
    if db().execute("SELECT 1 FROM users WHERE group_number = ? LIMIT 1", (number,)).fetchone():
        raise ApiError("Move or delete this group's users first")
    db().execute("DELETE FROM groups WHERE number = ?", (number,))
    db().commit()
    return jsonify(ok=True)


@app.get("/api/admin/backup")
@roles_required("admin")
def admin_backup():
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    dst = sqlite3.connect(tmp)
    db().backup(dst)
    dst.close()
    fname = f"crags-backup-{datetime.now().strftime('%Y%m%d-%H%M')}.db"
    resp = send_file(tmp, as_attachment=True, download_name=fname, mimetype="application/octet-stream")
    resp.call_on_close(lambda: os.path.exists(tmp) and os.remove(tmp))
    return resp


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8000)), debug=True)
