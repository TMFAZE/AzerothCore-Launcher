<div align="center">
  <img src="launcher/assets/icon.png" alt="AzerothCore Launcher" width="120" />

  # AzerothCore Launcher

  [![CodeFactor](https://www.codefactor.io/repository/github/tmfaze/azerothcore-launcher/badge)](https://www.codefactor.io/repository/github/tmfaze/azerothcore-launcher)

  A full-featured, custom launcher system for AzerothCore. Includes a Windows desktop launcher for players, a backend API server, and a web-based admin tool for server operators.
</div>

---

## Table of Contents

- [Overview](#overview)
- [System Requirements](#system-requirements)
- [Architecture](#architecture)
- [Backend Setup](#backend-setup)
- [Dev Tool Setup](#dev-tool-setup)
- [Launcher Setup & Build](#launcher-setup--build)
- [Database Requirements](#database-requirements)
- [Configuration Reference](#configuration-reference)
- [Shop System](#shop-system)
- [Deploying Updates](#deploying-updates)
- [Running in Production](#running-in-production)
- [Troubleshooting](#troubleshooting)

---

## Overview

This project is a three-component system:

| Component | Description | Default Port |
|-----------|-------------|-------------|
| **Backend** | Express.js REST API server | 3001 |
| **Launcher** | Electron desktop app for players | — |
| **Dev Tool** | Web admin panel for server operators | 3002 |

**Player-facing features:**
- Account registration and login (SRP6 + bcrypt, compatible with AzerothCore)
- Character viewer with stats, gear, and achievements
- In-game gold shop (mounts, services, gear sets)
- Game patch downloader with real-time progress
- News feed
- Automatic launcher self-update system (bypasses Windows execution policy)
- Auto-login with encrypted credential storage
- One-click game launch with realmlist auto-configuration

**Admin features (Dev Tool):**
- Publish and manage news posts
- Upload and deploy game patches (up to 500 MB)
- Upload and distribute launcher installer updates (up to 200 MB)
- Full shop management: categories, items, prices, and delivery commands

---

## System Requirements

### Server (Backend + Dev Tool)
- Node.js 18+
- MySQL 8.0+ (or MariaDB 10.6+)
- AzerothCore databases (`acore_auth`, `acore_characters`, `acore_world`)
- SOAP enabled on your AzerothCore worldserver (required for the shop)
- Minimum 2 GB RAM recommended

### Players (Launcher)
- Windows 10/11 (64-bit)
- Internet connection

### Building the Launcher (Developer)
- Node.js 18+
- npm 8+

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Player's Machine                      │
│  ┌──────────────────────────────────────────────────┐   │
│  │              WoW Launcher (Electron)              │   │
│  │  Login · Characters · Shop · News · Updates       │   │
│  └───────────────────────┬──────────────────────────┘   │
└──────────────────────────│──────────────────────────────┘
                           │ HTTP REST API
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    Your Server                           │
│  ┌────────────────────────────────┐                      │
│  │     Backend API  (:3001)       │◄── Dev Tool (:3002)  │
│  │  Auth · Characters · Shop      │    (admin only)      │
│  │  News · Patches · Updates      │                      │
│  └────────────┬───────────────────┘                      │
│               │                                          │
│  ┌────────────▼───────────────────┐                      │
│  │          MySQL Databases       │                      │
│  │  acore_auth · acore_characters │                      │
│  │  acore_world · itemdb · shop   │                      │
│  └────────────────────────────────┘                      │
└──────────────────────────────────────────────────────────┘
```

All three components must be running simultaneously for full functionality.

---

## Backend Setup

The backend is the central API server. Both the launcher and dev tool talk exclusively to it.

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in your values. See [Configuration Reference](#configuration-reference) for every option. At minimum you need:

- `JWT_SECRET` — a long random string (e.g. output of `openssl rand -hex 32`)
- `WOW_SERVER_IP` — your public server IP
- All database connection blocks

### 3. Create required directories

```bash
mkdir -p backend/patches/temp backend/patches/releases backend/launcher-updates
```

### 4. Start the server

```bash
# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

The server listens on port 3001 by default. Verify it's working:

```
GET http://YOUR_SERVER_IP:3001/health
```

You should receive a JSON response showing the status of each database connection pool.

---

## Dev Tool Setup

The dev tool is a web interface for server admins. It proxies requests to the backend and adds file upload capabilities.

### 1. Install dependencies

```bash
cd dev-tool
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Set `BACKEND_URL` to your backend address (e.g. `http://localhost:3001/api`).

### 3. Start the dev tool

```bash
npm start
```

Open `http://localhost:3002` in your browser. From here you can:

- **Dashboard** — overview of news, patches, and launcher files
- **News** — write and publish news posts that appear in the launcher
- **Game Updates** — upload patch archives (.zip, .rar, .7z up to 500 MB)
- **Launcher Updates** — upload new launcher installer builds (.exe/.yml/.blockmap)
- **Shop** — manage categories, items, prices, and server commands for item delivery

> **Security note:** The dev tool has no built-in authentication. Run it on localhost or behind a firewall/VPN. Do **not** expose port 3002 to the public internet.

---

## Launcher Setup & Build

### For players (using a pre-built installer)

1. Download and run the provided `WoW-Launcher-Setup-x.x.x.exe`
2. Launch the app from the desktop shortcut
3. Go to **Settings** and set the game path to your `WoW.exe`
4. Click **Update Realmlist** — this automatically writes the server IP to your `realmlist.wtf`
5. Register an account or log in with your existing AzerothCore account
6. Click **Play**

The launcher will:
- Remember your login if you check "Remember Me"
- Notify you when game patches are available for download
- Automatically check for launcher updates every 4 hours

### For developers (building from source)

#### 1. Install dependencies

```bash
cd launcher
npm install
```

#### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
API_URL=http://YOUR_SERVER_IP:3001/api
UPDATE_SERVER_URL=http://YOUR_SERVER_IP:3001
WOW_SERVER_IP=YOUR_SERVER_IP
WOW_SERVER_PORT=8085
```

> These values are baked into the compiled binary at build time. If your server IP changes, rebuild the launcher.

#### 3. Run in development mode

```bash
npm run dev
```

This opens the app with DevTools enabled for debugging the renderer.

#### 4. Build the installer

```bash
# Windows NSIS installer (recommended for distribution)
npm run build-win

# Portable executable (no install required, good for testing)
npm run build-portable

# Build all targets without publishing
npm run dist
```

Output is placed in `launcher/dist/`:

```
dist/
├── WoW Launcher-1.2.4.exe           ← NSIS installer (distribute this)
├── WoW Launcher-1.2.4-portable.exe  ← Portable build
└── ...
```

#### Required assets

These files must exist before building:

```
launcher/assets/icon.ico    ← Windows taskbar & installer icon
launcher/assets/icon.png    ← Window title bar icon
```

---

## Database Requirements

The backend connects to multiple MySQL databases. Most exist already on a standard AzerothCore installation.

### Required databases

| Database | Purpose | Source |
|----------|---------|--------|
| `acore_auth` | User accounts, SRP6 auth data | AzerothCore |
| `acore_characters` | Character stats, equipment, achievements | AzerothCore |
| `acore_world` | Zone names, achievement definitions | AzerothCore |
| `itemdb` | Item names and quality data | Custom / optional |
| Shop DB | Shop categories, items, purchases | Create manually (see below) |

### Shop database tables

Run the following SQL on the database you configure as your shop DB (can be the same as `acore_auth`):

```sql
CREATE TABLE IF NOT EXISTS shop_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon VARCHAR(255),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shop_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_id INT NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price INT NOT NULL COMMENT 'Price in copper (1 gold = 10000 copper)',
  item_type VARCHAR(50) DEFAULT 'item',
  icon VARCHAR(255),
  is_active TINYINT(1) DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES shop_categories(id)
);

CREATE TABLE IF NOT EXISTS shop_item_commands (
  id INT AUTO_INCREMENT PRIMARY KEY,
  item_id INT NOT NULL,
  command_template TEXT NOT NULL COMMENT 'Use {CHARACTER} as a placeholder for the character name',
  sort_order INT DEFAULT 0,
  FOREIGN KEY (item_id) REFERENCES shop_items(id)
);

CREATE TABLE IF NOT EXISTS shop_purchases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  character_guid INT NOT NULL,
  item_id INT NOT NULL,
  price_paid INT NOT NULL,
  purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) DEFAULT 'completed'
);
```

### SOAP configuration

The shop deducts gold and delivers items through AzerothCore's SOAP interface. Enable it in your `worldserver.conf`:

```ini
SOAP.Enabled = 1
SOAP.IP      = 0.0.0.0
SOAP.Port    = 7878
```

Create a GM account with permission to run `.send items` and `.modify money` commands, and use those credentials for `SOAP_USERNAME` / `SOAP_PASSWORD` in `backend/.env`.

---

## Configuration Reference

### Backend `.env`

```env
# ── Server ─────────────────────────────────────────────────────
PORT=3001
SERVER_PUBLIC_URL=http://YOUR_SERVER_IP:3001

# ── WoW Game Server ────────────────────────────────────────────
WOW_SERVER_IP=YOUR_SERVER_IP
WOW_SERVER_PORT=8085
REALM_NAME=My WoW Server

# ── AzerothCore SOAP ───────────────────────────────────────────
# Required for the gold shop (gold deduction + item delivery)
SOAP_HOST=YOUR_SERVER_IP
SOAP_PORT=7878
SOAP_USERNAME=admin
SOAP_PASSWORD=admin

# ── Authentication ─────────────────────────────────────────────
JWT_SECRET=change-this-to-a-long-random-secret

# AUTH_MODE:
#   flexible  tries SRP6 first, then bcrypt (recommended)
#   strict    SRP6 only
AUTH_MODE=flexible

# ── Auth Database (acore_auth) ─────────────────────────────────
AUTH_DB_HOST=localhost
AUTH_DB_USER=root
AUTH_DB_PASS=password
AUTH_DB_NAME=acore_auth

# ── Characters Database (acore_characters) ─────────────────────
CHAR_DB_HOST=localhost
CHAR_DB_USER=root
CHAR_DB_PASS=password
CHAR_DB_NAME=acore_characters

# ── World Database (acore_world) ───────────────────────────────
WORLD_DB_HOST=localhost
WORLD_DB_USER=root
WORLD_DB_PASS=password
WORLD_DB_NAME=acore_world

# ── Item Database ──────────────────────────────────────────────
ITEM_DB_HOST=localhost
ITEM_DB_USER=root
ITEM_DB_PASS=password
ITEM_DB_NAME=itemdb

# ── Shop Database ──────────────────────────────────────────────
# Can reuse acore_auth or a dedicated database
SHOP_DB_HOST=localhost
SHOP_DB_USER=root
SHOP_DB_PASS=password
SHOP_DB_NAME=acore_auth

# ── File Paths ─────────────────────────────────────────────────
PATCHES_DIR=./patches
NEWS_FILE=./news.json
```

### Launcher `.env`

```env
API_URL=http://YOUR_SERVER_IP:3001/api
UPDATE_SERVER_URL=http://YOUR_SERVER_IP:3001
WOW_SERVER_IP=YOUR_SERVER_IP
WOW_SERVER_PORT=8085
```

### Dev Tool `.env`

```env
DEV_TOOL_PORT=3002
BACKEND_URL=http://YOUR_SERVER_IP:3001/api
```

---

## Shop System

The gold shop lets players spend their in-game gold on mounts, services, gear sets, and items directly from the launcher without logging into the game.

### How it works

1. Player opens the **Shop** tab in the launcher
2. Selects which character's gold to deduct from (gold balance is shown)
3. Selects which character to deliver the item to
4. Browses categories and clicks **Purchase**
5. Backend verifies the character has enough gold
6. Gold is deducted via SOAP command
7. Item delivery commands are executed via SOAP

### Setting up shop items

1. Open the Dev Tool at `http://localhost:3002`
2. Go to **Shop → Categories** and create a category (e.g. "Mounts", "Services")
3. Go to **Shop → Items** and add an item:
   - **Name** — display name shown to players
   - **Price** — cost in copper (1 gold = 10,000 copper; 100 gold = 1,000,000 copper)
   - **Category** — which category tab it appears under
   - **Description** — optional description text
4. Add **delivery commands** to the item. These SOAP commands run automatically on purchase. Use `{CHARACTER}` as a placeholder for the receiving character's name:

```
# Give an item (item entry ID, quantity)
.additem {CHARACTER} 12345 1

# Add a mount to spellbook
.learn {CHARACTER} 33388
```

You can add multiple commands per item — they all execute in order on purchase.

### Item command examples

| Purchase type | SOAP command |
|---------------|--------------|
| Give an item | `.additem {CHARACTER} 18766 1` |
| Teach a mount spell | `.learn {CHARACTER} 34090` |
| Give gold | `.modify money {CHARACTER} 100000` |
| Change name | `.character rename {CHARACTER}` |

---

## Deploying Updates

### Deploying a game patch

Players can download patches from the launcher's **Updates** tab.

1. In the Dev Tool, go to **Game Updates**
2. Click **Upload Patch**
3. Select your patch archive (.zip, .rar, or .7z, up to 500 MB)
4. Fill in the version and description, then submit

When a player downloads the patch:
- The archive downloads to a temp folder
- It extracts into the game's `Data/` directory automatically
- Temp files are cleaned up after extraction

### Deploying a launcher update

1. Bump the version number in `launcher/package.json`
2. Build: `npm run build-win` from the `launcher/` directory
3. In the Dev Tool, go to **Launcher Updates**
4. Upload the files from `launcher/dist/`:
   - `WoW Launcher-x.x.x.exe` — the installer
   - `latest.yml` — update metadata (auto-generated by electron-builder)
   - Any `.blockmap` files
5. Submit

The launcher checks for updates on startup (after a 10-second delay) and every 4 hours. When a newer version is found:

- A dialog prompts the player to update
- The installer downloads in the background to `%USERPROFILE%/Downloads/WoWLauncherUpdates/`
- The player confirms, the launcher closes, and the installer runs automatically
- The launcher restarts after installation completes

The update system uses a custom execution policy bypass — no UAC prompt or manual policy changes are needed on the player's machine.

---

## Running in Production

### Using PM2 (recommended)

```bash
npm install -g pm2

# Start backend
pm2 start backend/src/server.js --name launcher-backend --cwd backend

# Start dev tool
pm2 start dev-tool/index.js --name launcher-devtool --cwd dev-tool

# Persist across reboots
pm2 save
pm2 startup
```

### Reverse proxy with HTTPS (optional)

If you want HTTPS, put Nginx in front of port 3001. Example config:

```nginx
server {
    listen 443 ssl;
    server_name api.yourserver.com;

    ssl_certificate     /etc/ssl/certs/yourserver.crt;
    ssl_certificate_key /etc/ssl/private/yourserver.key;

    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 500M;
    }
}
```

If you switch to HTTPS, update `API_URL` and `UPDATE_SERVER_URL` in `launcher/.env` before building the launcher.

### Firewall rules

| Port | Service | Publicly accessible? |
|------|---------|---------------------|
| 3001 | Backend API | **Yes** — players connect here |
| 3002 | Dev Tool | **No** — admin only, keep firewalled |
| 3306 | MySQL | No |
| 7878 | SOAP | No |
| 8085 | AzerothCore world server | Yes |

---

## Troubleshooting

### Backend won't start

**`Error: connect ECONNREFUSED 127.0.0.1:3306`**

MySQL is not running or the credentials in `.env` are wrong. Test your connection:

```bash
mysql -u root -p -h localhost acore_auth
```

**`JWT_SECRET is not set`**

Add `JWT_SECRET=your-secret-here` to `backend/.env`.

---

### Launcher can't connect to the server

1. Confirm the backend is reachable: `curl http://YOUR_SERVER_IP:3001/health`
2. Check that `API_URL` in `launcher/.env` matches your actual server IP and port
3. Verify your firewall allows inbound TCP on port 3001
4. In development mode (`npm run dev`) the `.env` is read at runtime. In a production build it is compiled in — rebuild if you change the IP.

---

### Login fails with "Authentication failed"

1. `AUTH_MODE=flexible` (default) tries SRP6 then bcrypt automatically
2. Confirm the account exists in the `account` table of `acore_auth`
3. Check backend logs for the exact database error
4. If you manually created an account outside of AzerothCore's tooling, the password hash format may not match — use AzerothCore's `.account create` command instead

---

### Patch download fails or extracts to the wrong place

- Verify `patches/releases/` exists and the backend process can write to it
- Check disk space on the server
- Confirm the archive is a valid .zip, .rar, or .7z file
- The player's game path in launcher Settings must point to the directory containing `WoW.exe` — patches extract to the `Data/` folder relative to that path

---

### Launcher update not detected

1. Confirm `latest.yml` was uploaded alongside the `.exe` in the Dev Tool
2. The version in `latest.yml` must be strictly greater than the current launcher version
3. Verify `UPDATE_SERVER_URL` in `launcher/.env` is correct before building
4. Update checks are disabled in dev mode (`npm run dev`) — build a production binary to test the update flow

---

### Shop purchases fail

1. Verify SOAP is enabled in `worldserver.conf`: `SOAP.Enabled = 1`
2. Check `SOAP_HOST`, `SOAP_PORT`, `SOAP_USERNAME`, `SOAP_PASSWORD` in `backend/.env`
3. Ensure the SOAP GM account has permission to run item and money commands
4. Check backend logs for the raw SOAP error response
5. Make sure the shop database tables exist (see [Database Requirements](#database-requirements))
