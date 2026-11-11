# OpenProfiles: Deployment & Hosting Guide
### Self-Hosting OpenProfiles Permanently on Render (Free) + Supabase (Free PostgreSQL) + UptimeRobot (Free)

This guide walks you step-by-step through deploying OpenProfiles for free without managing any Virtual Private Servers (VPS), AWS, GCP, Azure, or home servers.

---

## Table of Contents
1. [A. Project Overview & Architecture](#a-project-overview--architecture)
2. [B. Prerequisites](#b-prerequisites)
3. [C. Supabase PostgreSQL Setup](#c-supabase-postgresql-setup)
4. [D. GitHub Repository Setup](#d-github-repository-setup)
5. [E. Render Web Service Deployment](#e-render-web-service-deployment)
6. [F. UptimeRobot Configuration](#f-uptimerobot-configuration)
7. [G. Stremio Add-on Installation & Usage](#g-stremio-add-on-installation--usage)
8. [H. Data Migration (SQLite to Supabase)](#h-data-migration-sqlite-to-supabase)
9. [I. Comprehensive Troubleshooting](#i-comprehensive-troubleshooting)
10. [J. Maintenance, Backups & Quotas](#j-maintenance-backups--quotas)
11. [K. Monthly Cost & Free Tier Breakdown](#k-monthly-cost--free-tier-breakdown)

---

## A. Project Overview & Architecture

Originally, OpenProfiles was designed to run inside a single Docker container storing SQLite databases (`/data/openprofiles.db`) and local encryption keys (`/data/secret.key`) on a persistent host filesystem.

On platform-as-a-service free tiers (such as **Render Free Web Services**), the local filesystem is **ephemeral**. Any files saved to local disk vanish when the instance restarts, redeploys, or spins down after inactivity.

To achieve 100% data persistence on free hosting, this fork migrates the database layer to **Supabase PostgreSQL** and moves the encryption secret to an environment variable (`SECRET_KEY`).

### System Communication Flow

```
                                  +------------------------------+
                                  |   Stremio Desktop / Android  |
                                  |  (Fetches Catalogs / Streams)|
                                  +--------------+---------------+
                                                 |
                                                 | HTTPS /manifest.json
                                                 v
+------------------+  Pings /health  +------------------------------+  PostgreSQL SSL   +-------------------------+
|   UptimeRobot    +---------------->+      Render Web Service      +------------------>+   Supabase PostgreSQL   |
| (5-min Monitors) |                 | (OpenProfiles Node.js Engine)|                   | (Persistent Database)   |
+------------------+                 +--------------+---------------+                   +-------------------------+
                                                    ^
                                                    | Push on commit
                                     +--------------+---------------+
                                     |    GitHub Fork Repository    |
                                     +------------------------------+
```

1. **GitHub**: Houses your source code. Whenever you push changes or pull updates, Render automatically redeploys.
2. **Render Web Service**: Runs OpenProfiles inside a secure Node.js 20 environment, binds to `0.0.0.0:$PORT`, serves the Web UI, and acts as the Stremio add-on transport.
3. **Supabase PostgreSQL**: Permanently stores encrypted user accounts, profile definitions, libraries, add-ons, backup snapshots, switch journals, and audit activity.
4. **Stremio**: Communicates with Render via public HTTPS. Stremio requests add-on manifests, displays profile rows on the Home screen, and switches profiles upon selecting a stream.
5. **UptimeRobot**: Pings Render's `/health` endpoint every 5 minutes to keep the service responsive and detect failures.

---

## B. Prerequisites

You only need free accounts on the following platforms:

| Service | Purpose | Free Plan Details |
| :--- | :--- | :--- |
| **GitHub** | Source repository & Render integration | Unlimited public/private repositories |
| **Supabase** | Cloud PostgreSQL Database | 2 free projects, 500 MB database, pooled connections |
| **Render** | Application Web Service | 750 free compute hours/month, automatic HTTPS |
| **UptimeRobot** | HTTP uptime monitoring | Up to 50 monitors at 5-minute intervals |
| **Stremio** | Streaming client | Free application (Desktop, Android, Android TV) |

---

## C. Supabase Setup

### 1. Create a Supabase Project
1. Log in to [Supabase](https://supabase.com).
2. Click **New Project**.
3. Fill in the project details:
   - **Name**: `openprofiles-db` (or any name you prefer)
   - **Database Password**: Choose a strong, random password. **Save this password securely**—you will need it for the connection string.
   - **Region**: Choose a region geographically close to where Render will host your web service (e.g., `US East (N. Virginia)` / `Oregon` for US, or `Frankfurt` for EU) to minimize latency.
   - **Pricing Plan**: Free.
4. Click **Create new project** and wait 1–2 minutes for database provisioning.

### 2. Obtain Your PostgreSQL Connection String
1. In your Supabase Project dashboard, click the **Project Settings** (gear icon) in the left sidebar.
2. Select **Database**.
3. Scroll down to the **Connection string** section.
4. Click the **URI** tab.
5. Select **Mode: Session** or **Mode: Transaction** (Supabase Connection Pooler):
   - **Session Pooler (Port 5432)** or **Transaction Pooler (Port 6543)** is recommended because Render free instances resolve IPv4 addresses, and the Supabase pooler provides full IPv4 and connection reuse support.
   - Example URI format:
     ```
     postgresql://postgres.[project-ref]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
     ```
   - If using the Direct Connection:
     ```
     postgresql://postgres:[YOUR-PASSWORD]@db.[project-ref].supabase.co:5432/postgres
     ```
6. Replace `[YOUR-PASSWORD]` with your actual database password.

> [!IMPORTANT]
> If your password contains special characters (like `@`, `#`, `:`, `/`, `?`), they must be URL-encoded (e.g., `@` becomes `%40`, `#` becomes `%23`).

### 3. Automatic Schema Initialization
You **do not** need to manually execute SQL scripts in Supabase. OpenProfiles automatically checks and executes schema migrations on startup, creating all 11 required tables, foreign keys, indexes, and initial metadata.

---

## D. GitHub Setup

### 1. Fork and Clone
1. Fork the OpenProfiles repository into your own GitHub account:
   - Repository: `https://github.com/kgenovz/openprofiles` (or your forked URL)
2. Clone your forked repository locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/stremio-openprofiles.git
   cd stremio-openprofiles
   ```
3. Ensure your local branch contains the Supabase PostgreSQL migration commits.
4. Push your changes to GitHub:
   ```bash
   git push origin main
   ```

---

## E. Render Deployment

### Option 1: Standard Manual Setup (Recommended)

1. Log in to [Render](https://render.com).
2. In the top navigation, click **New +** and select **Web Service**.
3. Under **Connect a repository**, select your forked GitHub repository (`stremio-openprofiles`).
4. Configure the Web Service settings:
   - **Name**: `stremio-openprofiles` (or a custom name; this determines your `.onrender.com` URL)
   - **Region**: Choose the region closest to your Supabase project (e.g., `Oregon (US West)` or `Frankfurt (EU Central)`).
   - **Branch**: `main`
   - **Root Directory**: Leave blank (root).
   - **Runtime**: `Node`
   - **Build Command**:
     ```bash
     npm ci --omit=dev
     ```
   - **Start Command**:
     ```bash
     node src/server.js
     ```
   - **Instance Type**: Select **Free** ($0/month).

5. Scroll down to **Environment Variables** and add the following required keys:

| Environment Variable | Value | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | `postgresql://...` | The complete pooled Supabase connection URI from Step C. |
| `SECRET_KEY` | `64-character hex` | 32-byte cryptographic secret (see generation below). |
| `PUBLIC_URL` | `https://<service-name>.onrender.com` | Your Render web service HTTPS address. |
| `NODE_ENV` | `production` | Enables production optimizations. |
| `ACCESS` | `owner` | Only the first Stremio account to sign in owns and uses the server. |
| `TRUST_PROXY` | `1` | Enables secure cookie handling and client IP logging behind Render. |

#### Generating Your `SECRET_KEY`:
Run this one-liner in your terminal or Node.js to create a cryptographically secure 32-byte key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the resulting 64-character hexadecimal string into Render's `SECRET_KEY` field.

> [!WARNING]
> Save your `SECRET_KEY` in a secure password manager. If you ever lose or modify this variable, previously encrypted profiles, backups, and Stremio credentials stored in Supabase **cannot be decrypted**. OpenProfiles enforces key fingerprinting and will refuse to boot with a mismatched key to prevent data corruption.

6. Under **Advanced**, set **Health Check Path** to:
   ```
   /health
   ```
7. Click **Create Web Service**.

### Option 2: Render Blueprint (`render.yaml`)
A `render.yaml` specification is already included in the repository. In Render, select **New +** -> **Blueprint**, link your repository, and input your `DATABASE_URL`, `SECRET_KEY`, and `PUBLIC_URL` when prompted.

---

## F. UptimeRobot Setup

Render's free tier spins down web services after 15 minutes of inactivity. When a subsequent request arrives, Render spins the service back up (which typically takes 30–50 seconds).

Uptime monitoring periodically pings your `/health` endpoint to minimize cold-start latency.

### Steps to Configure:
1. Log in to [UptimeRobot](https://uptimerobot.com).
2. Click **+ Add New Monitor**.
3. Configure the monitor:
   - **Monitor Type**: `HTTP(s)`
   - **Friendly Name**: `OpenProfiles Render`
   - **URL (or IP)**: `https://YOUR_SERVICE_NAME.onrender.com/health`
   - **Monitoring Interval**: `Every 5 minutes`
   - **Monitor Timeout**: `30 seconds`
4. Click **Create Monitor**.

### Limitations & Reality on Render Free Tier:
- UptimeRobot pings keep the container active during regular hours.
- Render allocates **750 free instance hours per calendar month** per account. Running one single service continuously 24/7 consumes 720–744 hours (within the free quota). If you have other free web services on Render, they share this 750-hour pool.
- Render may still occasionally recycle or restart instances during infrastructure updates. If spun down, the first ping will wake it back up.
- UptimeRobot does not bypass Render's platform constraints, but it significantly reduces latency for daily Stremio use.

---

## G. Stremio Add-on Installation & Usage

Once deployed, OpenProfiles acts as an authorized Stremio add-on that provides your profile switcher row.

### 1. Sign In & Setup
1. Open your browser and navigate to your public Render URL:
   ```
   https://YOUR_SERVICE_NAME.onrender.com
   ```
2. Sign in with your **Stremio Account email and password**.
3. OpenProfiles connects to Stremio's API, securely stores your session and library snapshots in Supabase (encrypted with your `SECRET_KEY`), and creates an **"Original"** profile representing your current setup with an automatic permanent backup.

### 2. Creating Profiles
1. Click **+ New Profile** or **Profile Wizard**.
2. Give your profile a name (e.g., "Kids", "Family", "Anime").
3. Choose an avatar or upload a custom picture.
4. Select starting add-ons (copy from Original or start empty).
5. Optionally assign a 4-digit passcode to lock private profiles.

### 3. Installing the Add-on in Stremio Desktop
1. On your OpenProfiles web dashboard (`/configure`), look for the **Install Add-on** button.
2. Click **Install**. Your browser will attempt to open the `stremio://` deep link.
3. If it does not open automatically:
   - Copy the manifest link from the dashboard:
     ```
     https://YOUR_SERVICE_NAME.onrender.com/YOUR_ADDON_TOKEN/manifest.json
     ```
   - Open Stremio Desktop.
   - Go to **Addons** (puzzle piece icon).
   - In the search/URL input field at the top, paste the manifest URL and press **Enter**.
   - Click **Install**.

### 4. Installing the Add-on in Stremio Android / Android TV
1. Copy your add-on manifest URL from the web dashboard.
2. Open Stremio on Android or Android TV.
3. Navigate to **Settings** -> **Addons** -> **Install Addon via URL**.
4. Paste the manifest URL and tap **Install**.

### 5. Switching Profiles in Stremio
1. On Stremio's Home screen, locate the **OpenProfiles** catalog row.
2. Each of your created profiles appears as a poster tile.
3. Click/tap any profile tile to switch to it:
   - If unlocked: Stremio immediately switches to that profile's add-ons, catalogs, and library.
   - If locked with a passcode: Stremio opens a link to the unlock webpage where you enter the PIN.
4. Switch back anytime by choosing another profile on the Home row!

---

## H. Data Migration (SQLite to Supabase)

If you have an existing SQLite OpenProfiles database from a previous local or Docker installation, use the included migration tool.

### Running the Migration Tool
1. Locate your existing `openprofiles.db`.
2. Run the migration script:
   ```bash
   node scripts/migrate-sqlite-to-supabase.js \
     --sqlite /path/to/openprofiles.db \
     --pg "postgresql://postgres:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres"
   ```

### What the Migration Tool Does:
- Opens the SQLite database in **read-only mode** (the original file is never modified or deleted).
- Connects to Supabase and ensures all PostgreSQL tables exist.
- Transfers records in strict foreign-key dependency order:
  1. `settings`
  2. `accounts` (with `active_profile_id` temporarily unlinked)
  3. `profiles`
  4. Links `active_profile_id` on `accounts`
  5. `backups`
  6. `switch_journal`
  7. `sessions`
  8. `activity`
  9. `carryovers`
  10. `meta`
- Sets PostgreSQL `SERIAL` sequence counters so future auto-increment IDs never collide.
- Compares record counts between SQLite and PostgreSQL to guarantee 100% integrity.
- Safe to re-run: uses `ON CONFLICT DO NOTHING` to prevent duplicates.

---

## I. Comprehensive Troubleshooting

### 1. Database Connection Errors / SSL Issues
- **Symptom**: Logs show `connection refused`, `ETIMEDOUT`, or `self-signed certificate in certificate chain`.
- **Fix**:
  - OpenProfiles uses `{ ssl: { rejectUnauthorized: false } }` by default to support cloud-managed TLS certificates.
  - Verify that you used the **Pooled Connection string** (host ending in `.pooler.supabase.com` on port `6543` or `5432`).
  - In Supabase, navigate to **Project Settings** -> **Database** and confirm that **Network Restrictions** are not blocking external IPs (`0.0.0.0/0` must be allowed).

### 2. "The secret key does not match this database"
- **Symptom**: Server crashes on boot with `WrongKeyError`.
- **Reason**: The `SECRET_KEY` environment variable does not match the key previously used to initialize this Supabase database.
- **Fix**: Check your Render environment variables and restore the original 64-character hex key. Never change `SECRET_KEY` once data has been saved.

### 3. Render 503 Service Unavailable / Spin-Down
- **Symptom**: Stremio or browser shows HTTP 503 or takes 45 seconds to load.
- **Reason**: Render's free container was asleep due to 15 minutes of inactivity.
- **Fix**: Allow 30–45 seconds for cold start. Ensure UptimeRobot is configured with a 5-minute interval targeting `/health`.

### 4. Profile Data Not Persisting
- **Symptom**: Profiles disappear after a redeployment.
- **Reason**: `DATABASE_URL` is missing or invalid, causing the app to fall back to an in-memory or uninitialized state.
- **Fix**: Check Render deployment logs. Ensure `DATABASE_URL` is present and that you see the log entry: `PostgreSQL connection pool initialized`.

### 5. Stremio Manifest Errors / "Add-on could not be loaded"
- **Symptom**: Stremio fails to load the catalog row or displays "Install failed".
- **Fix**:
  - Verify `PUBLIC_URL` matches your actual Render URL exactly (including `https://` without a trailing slash).
  - Verify your Add-on Token in Stremio matches the token displayed on `/configure`.
  - Test the manifest directly in your browser: `https://YOUR_APP.onrender.com/YOUR_TOKEN/manifest.json`. You should see valid JSON starting with `"id": "community.openprofiles"`.

---

## J. Maintenance, Backups & Quotas

### Supabase Database Backups
- Supabase performs automatic daily backups on paid tiers.
- For free tier projects, you can generate a complete SQL dump at any time using standard `pg_dump`:
  ```bash
  pg_dump "postgresql://postgres:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres" > openprofiles_backup.sql
  ```
- Alternatively, use OpenProfiles' built-in **Export Everything** button in the Web UI (`/backups#everything`) to download an encrypted JSON backup of all profiles and library states.

### Keeping Supabase Free Projects Active
- Supabase pauses free-tier projects if they receive **no database queries for 7 consecutive days**.
- Because UptimeRobot queries `/health` every 5 minutes (which runs `SELECT 1` on the database pool), and Stremio queries profile rows whenever launched, your database stays continuously active and will not be paused!

### Updating the Application
To update OpenProfiles when new versions are released:
1. Sync your forked GitHub repository with upstream:
   ```bash
   git remote add upstream https://github.com/kgenovz/openprofiles.git
   git fetch upstream
   git merge upstream/main
   git push origin main
   ```
2. Render detects the new commit on `main` and automatically builds and redeploys without downtime.

---

## K. Monthly Cost & Free Tier Breakdown

| Component | Provider | Quota Limit | Monthly Cost |
| :--- | :--- | :--- | :--- |
| **Web Service** | Render Free Web Service | 750 free compute hours/month, 512 MB RAM | **$0.00** |
| **Database** | Supabase Free PostgreSQL | 500 MB storage, 2 active projects | **$0.00** |
| **Uptime Monitor**| UptimeRobot Free | 50 monitors, 5-minute check intervals | **$0.00** |
| **Code Hosting** | GitHub Free | Unlimited public/private git repositories | **$0.00** |
| **Total** | | | **$0.00 / month** |

Enjoy your self-hosted, permanently persistent OpenProfiles installation on Stremio!
