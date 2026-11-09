# Crags Job Log

A light-mode web dashboard for logging job submissions, the people contacted through each job, and the chat history with them, with group competition and role-based administration.

- **Backend:** Python (Flask) and SQLite, stored in a single file. No database server is needed.
- **Frontend:** plain HTML/CSS/JS. There is no build step and no Node.js.

## Install & run

### Option A: one command (Linux / macOS / Windows)

Requires Python 3.9+.

```bash
./start.sh          # Linux / macOS
start.bat           # Windows (or double-click it)
```

The first run creates a `.venv`, installs the two dependencies (Flask and Waitress) and starts the server on **http://localhost:8000**.

### Option B: Docker

```bash
docker compose up -d --build
docker compose logs crags      # shows the generated admin password on first start
```

Data is stored in `./data` on the host.

### First login

On first start an administrator account is created:

- username: `admin`
- password: the value of `ADMIN_PASSWORD` if you set it, otherwise a random password. The random password is printed in the console and saved to `data/initial-admin.txt`. Delete that file after you log in and change the password under **My profile**.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / random | First admin account (used only when no admin exists) |
| `CRAGS_DATA_DIR` | `./data` | Where the database and secret key are stored |
| `CRAGS_SECURE_COOKIES` | `0` | Set to `1` when served over HTTPS |
| `CRAGS_SECRET_KEY` | auto-generated | Session signing key (saved to `data/secret.key`) |

## How it works

### Usernames & groups
Users sign up as `<group>-<name>`, e.g. **`3-ALEX`**. The number before the dash is the group, so `3-ALEX` joins group 3 and `2-SAM` joins group 2. A group is created automatically the first time someone signs up into it. Administrators can name groups and move users between them.

### Roles
| Role | Can do |
|---|---|
| **Member** | Submit jobs, add people contacted and chat history to their own jobs, see their own stats and the competition. They see their **own logs** by default; an admin can widen this to their group or to all logs. |
| **Group leader** | Everything a member can do, plus a dashboard of their group members' performance (ranking, points, daily activity). A leader always sees at least their group's logs. |
| **Administrator** | Sees and manages everything: all logs (filter by group or person), users, roles, groups, log visibility, sign-up on/off, approval of new accounts, scoring, CSV export and database backup. |

Only a job's owner or an administrator can edit it. Leaders and others with wider visibility can only read.

### Job logs
Each row holds **name, crag-username, location, job type, job title and job description**. **Name** is filled in automatically with the submitter's username (e.g. `3-ALEX`) and can't be changed. **Crag username** is optional free text that the submitter can set or edit at any time. Rows are collapsed by default and show summary counts (people contacted, successful contacts, messages, last activity). Click a row to expand it:

- **＋ Add person** records someone contacted through the job: name, contact info, platform, status and notes. You can also paste the chat history when adding them.
- Each person has a chat log. Add messages one at a time ("Me" or the contact, with an optional time) or use **Paste conversation**, where each line starts with `Me:` or `Them:` (or the person's name).
- Statuses: Contacted, Replied, In progress, Successful, Closed.

### Visibility (admin → Users)
For each user, for a whole group, for everyone, or for a selection of users, choose one of:
- **Own logs only**
- **Own group's logs**
- **All logs**

### Competition
Groups and members are ranked by points over Today, 7 days, 30 days or All time. The default weights, which you can change in **Settings**, are:
- 1 point per job submitted
- 2 points per person contacted
- 5 points per successful contact

The leaderboard can rank by total points or by points per member, so small groups can still compete.

### Sign-up control (admin → Settings)
- **Allow sign up**: turns self-registration on or off. Admins can always add users manually.
- **Require approval**: new accounts stay disabled until an admin approves them. Pending users appear at the top of the Users page and as a badge in the menu.
- **Default visibility** for new users.

## Backup & restore
- **Backup:** Settings → *Download backup*, or copy `data/crags.db` while the app is stopped.
- **Restore:** stop the app, replace `data/crags.db`, then start the app again.

## Project layout
```
app.py            Flask API: auth, jobs, contacts, messages, stats, admin
schema.sql        SQLite schema (created automatically)
serve.py          Production server entry point (Waitress)
static/           index.html, app.js, style.css (single-page frontend)
start.sh / .bat   One-command install + run
Dockerfile, docker-compose.yml
```
