# pubctl 🚀 `Beta`

> **Zero-configuration, multi-tenant CLI and Docker orchestrator for self-hosting Ghost CMS across any cloud provider or local development machine.**

[![Status: Beta](https://img.shields.io/badge/Status-Beta-orange.svg)](https://github.com/frontendweb3/pubctl)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](#prerequisites)
[![npm](https://img.shields.io/npm/v/pubctl.svg?color=CB3837&logo=npm)](https://www.npmjs.com/package/pubctl)

> [!IMPORTANT]
> **Beta Stage Notice**: `pubctl` is currently in active beta. Core orchestration features (Traefik SSL, isolated MySQL, local theme live reload, S3 storage, backups, and zero-runtime-dependency bundle) are operational. Please report feedback, issues, or feature requests on GitHub!

`pubctl` (**Pub**lishing / Publication + **ctl**) automates the full lifecycle of multi-tenant Ghost CMS instances on a single virtual server (AWS EC2, Hetzner, DigitalOcean, Linode, etc.) or local workstation (NixOS, Linux, macOS, Windows WSL 2).

It orchestrates automatic Let's Encrypt SSL certificates via Traefik v3, per-tenant isolated MySQL 8.0 databases, S3-compatible cloud media storage, automated zero-touch administrative login, live theme development, point-in-time backups, and recoverable zero-downtime updates.

---

## ⚡ Highlights

- 🔒 **Automated SSL/TLS**: Traefik reverse proxy automatically provisions and renews Let's Encrypt certificates over HTTP/HTTPS with zero manual configuration.
- 💻 **Dedicated Local Dev Mode (`--local`)**: Develop Ghost themes locally with live Handlebars reload on `*.localhost`, host theme directory mounting, and custom host port binding.
- 🧙 **Interactive CLI Wizards**: Run any command without flags to launch an interactive step-by-step terminal wizard with smart defaults and Enter-to-skip.
- 🗄️ **Multi-Tenant Database Isolation**: Automatically creates a dedicated database and restricted MySQL user per blog.
- ☁️ **S3 / Cloudflare R2 Media Offloading**: Native support for AWS S3, Cloudflare R2, MinIO, and DigitalOcean Spaces to keep local disk usage minimal.
- 🔑 **Headless Zero-Touch Setup**: Bootstraps the Ghost admin account and password automatically, completely bypassing the manual `/ghost/#/setup` onboarding wizard.
- 📦 **Point-in-Time Backups**: Safely pauses tenant containers during MySQL dumps and creates a compressed content archive.
- 🔄 **Recoverable Updates**: Performs atomic container swaps and restores the previous container automatically if the replacement fails health checks.
- 🐧 **Cross-Platform Auto-Detection**: Auto-detects Docker daemon sockets across NixOS, standard Linux, Rootless Docker, macOS (Docker Desktop, OrbStack, Colima), and Windows WSL 2.
- 🚀 **Zero Runtime Dependencies**: Shipped as a single, self-contained JavaScript bundle on npm with zero external subdependencies.

---

## 📥 Installation

### Option 1: Global Install via `pnpm` or `npm` (Recommended)

Requires Node.js (v18+) or Bun:

```bash
# Using pnpm
pnpm add -g pubctl

# Using npm
npm install -g pubctl
```

---

### Option 2: Instant Run via `npx` or `pnpm dlx`

Run commands instantly without installing globally:

```bash
# Using npx
npx pubctl --help

# Using pnpm dlx
pnpm dlx pubctl --help
```

---

### Option 3: One-Line Installer Script

Installs `pubctl` directly to `/usr/local/bin/pubctl`:

```bash
curl -sSL https://raw.githubusercontent.com/frontendweb3/pubctl/main/install.sh | bash
```

---

## 📋 Prerequisites

1. **Docker Engine**: Docker must be running on your system:
   ```bash
   docker --version
   ```
2. **Ports 80 & 443**: Available on the host for Traefik to bind HTTP/HTTPS traffic and issue Let's Encrypt SSL certificates (for production mode).
3. **DNS Records (Production)**: Point your domain or subdomain (A / AAAA record) to your server's public IP address.
4. **Docker Daemon Socket**: Works out of the box across NixOS, standard Linux (`/var/run/docker.sock`), Rootless Docker (`$XDG_RUNTIME_DIR/docker.sock`), macOS (`~/.docker/run/docker.sock`, OrbStack, Colima), and Windows Named Pipes (`//./pipe/docker_engine`).

---

## 📚 Real-Life Step-by-Step Guides

### Guide 1: Production Deployment Workflow (`init` ➔ `create` ➔ `update`)

Here is a real-world scenario: Setting up a VPS on Hetzner or DigitalOcean, deploying a production blog `blog.example.com`, and later upgrading Ghost versions safely.

#### Step 1: Initialize Base Infrastructure (`pubctl init`)

Run this once on your server. It deploys the shared Docker network (`pubctl-net`), an isolated MySQL 8.0 server, and the Traefik reverse proxy with automated Let's Encrypt SSL.

**Interactive Wizard:**
```bash
pubctl init
```
```text
=== pubctl init setup wizard ===
? Container namespace / prefix (default: pubctl, press Enter to skip): [Enter]
? Let's Encrypt email for SSL certificates: admin@example.com
? MySQL root password (hidden, press Enter to auto-generate): [Enter]
✓ Auto-generated MySQL root password: a8f9c1b2d4e5A1!
  (Save this password or run: export MYSQL_ROOT_PASSWORD="a8f9c1b2d4e5A1!")

✔ Base infrastructure is running with automated SSL support!

================ Infrastructure Status ================
Namespace Prefix:   pubctl
Network:            pubctl-net
MySQL Server:       pubctl-mysql (127.0.0.1:3306)
Traefik Proxy:      pubctl-traefik (HTTP :80, HTTPS :443)
Let's Encrypt Email: admin@example.com
=======================================================
```

**Or as a non-interactive one-liner:**
```bash
pubctl init --email admin@example.com --mysql-root-password "MySecretPass123!" --yes
```

---

#### Step 2: Deploy Your Publication (`pubctl create`)

Provision an isolated Ghost CMS blog with its own MySQL database, restricted credentials, and automated admin user bootstrapping:

```bash
pubctl create \
  --name techblog \
  --domain blog.example.com \
  --admin-email admin@example.com \
  --title "My Tech Publication" \
  --mysql-root-password "MySecretPass123!"
```

```text
✔ Site techblog deployed successfully!

================ Deployment Details ================
Blog URL:           https://blog.example.com
Admin Panel:        https://blog.example.com/ghost/
Admin Email:        admin@example.com
Temporary Password: a1b2c3d4e5A1!
Mode:               PRODUCTION (Automated SSL)
Storage:            LOCAL (Local volume)
====================================================
```

> [!TIP]
> Your blog is immediately live! Traefik automatically negotiates the SSL certificate from Let's Encrypt, routes traffic to Ghost, and sets up your admin user so you can log in directly at `https://blog.example.com/ghost/` without running the manual onboarding wizard.

---

#### Step 3: Upgrade Ghost with Automatic Rollback (`pubctl update`)

When a new Ghost release comes out (e.g. upgrading from Ghost 5 to Ghost 6), `pubctl` pulls the new Docker image, renames the old container to a temporary rollback alias, starts the new version with the same volumes and database, and tests health responsiveness.

**Interactive Wizard:**
```bash
pubctl update
```
```text
=== pubctl update site wizard ===
? Tenant name to update: techblog
? Target Ghost version or image tag (default: 5-alpine, press Enter to skip): 6-alpine
```

**Or via command-line flags:**
```bash
pubctl update --name techblog --to 6-alpine
```

```text
✔ Successfully updated techblog to ghost:6-alpine!
```

> [!NOTE]
> If the new Ghost container fails migrations or crashes during startup, `pubctl` automatically triggers an atomic rollback: it removes the faulty replacement container and immediately restarts your previous container under its original name with zero data loss.

---

### Guide 2: Local Theme Development Workflow (`--local`, `--theme-dir`, `--port`)

Developing a custom Ghost theme and want live Handlebars auto-reload and direct local access without public DNS or SSL warnings? `pubctl` includes dedicated local development mode.

#### Step 1: Deploy a Local Site Mounted to Your Theme Folder

Navigate to your theme directory and deploy a local Ghost instance:

```bash
pubctl create \
  --name devblog \
  --domain devblog.localhost \
  --admin-email dev@example.com \
  --local \
  --theme-dir ./my-custom-theme \
  --port 2853 \
  --mysql-root-password "MySecretPass123!"
```

```text
✔ Site devblog deployed successfully!

================ Deployment Details ================
Blog URL:           http://devblog.localhost:2853
Admin Panel:        http://devblog.localhost:2853/ghost/
Admin Email:        dev@example.com
Temporary Password: g7h8j9k0l1A1!
Mode:               LOCAL DEV (HTTP, Theme Live Reload)
Mounted Theme:      /home/user/my-custom-theme -> /content/themes/my-custom-theme
Direct Host Port:   http://127.0.0.1:2853
Storage:            LOCAL (Local volume)
====================================================
```

**Key Local Development Features:**
- **Live Theme Reload**: Ghost runs with `NODE_ENV=development`, watching your local Handlebars files (`.hbs`) for changes instantly.
- **Dual HTTP & HTTPS Routing**: Traefik routes both HTTP `:80` and self-signed TLS `:443` for `*.localhost`, so browsers that enforce HTTPS won't show errors.
- **Direct Host Port Access**: Access your blog directly at `http://localhost:2853` or `http://127.0.0.1:2853`.

---

### Guide 3: Production Site with Cloudflare R2 / AWS S3 Cloud Storage

Offload all uploaded media and images to an S3-compatible bucket to keep your server disk light and serve assets via a fast CDN.

```bash
pubctl create \
  --name mediahub \
  --domain media.example.com \
  --admin-email admin@example.com \
  --storage s3 \
  --s3-bucket my-ghost-bucket \
  --s3-key "<YOUR_R2_ACCESS_KEY_ID>" \
  --s3-secret "<YOUR_R2_SECRET_ACCESS_KEY>" \
  --s3-endpoint "https://<account_id>.r2.cloudflarestorage.com" \
  --s3-asset-host "https://media-cdn.example.com" \
  --mysql-root-password "MySecretPass123!"
```

---

### Guide 4: Consistent Point-in-Time Backups (`pubctl backup`)

Creates an atomic snapshot of a blog's database and uploaded content:

```bash
pubctl backup --name techblog --output ./backups --mysql-root-password "MySecretPass123!"
```

```text
✔ Backup created at: /home/user/pubctl/backups/techblog_backup_2026-11-21T16-00-00-000Z
```

The backup directory contains:
- `db.sql`: Complete MySQL dump created with `mysqldump` while the tenant is paused.
- `content.tar.gz`: Compressed archive of all themes, images, and content files.

---

## 📖 Command & Options Reference

`pubctl` supports both standard kebab-case (`--mysql-root-password`) and snake_case (`--mysql_root_password`), as well as short aliases (`-n`, `-d`, `-e`, `-t`, `-v`, `-l`, `-y`, `-o`).

### `pubctl init`

Bootstraps the shared Docker bridge network, MySQL 8.0 server, and Traefik reverse proxy.

```bash
pubctl init [options]
```

| Option | Alias | Default | Description |
| :--- | :---: | :---: | :--- |
| `--email <email>` | `-e` | — | Let's Encrypt email address for SSL certificate notifications |
| `--name <prefix>` | `-n` | `pubctl` | Container and network namespace prefix |
| `--mysql-root-password <pass>` | — | `$MYSQL_ROOT_PASSWORD` | Root password for MySQL (or auto-generated in wizard) |
| `--rotate-mysql-root-password` | — | `false` | Rotate root password using `PUBCTL_NEW_ROOT_PASSWORD` |
| `--no-interactive` | — | `false` | Disable interactive wizard prompts |
| `--yes` | `-y` | `false` | Skip confirmation prompts |

---

### `pubctl create`

Provisions a new isolated Ghost publication.

```bash
pubctl create [options]
```

#### Core Options

| Option | Alias | Default | Description |
| :--- | :---: | :---: | :--- |
| `--name <name>` | `-n` | — | Unique tenant identifier (lowercase letters, digits, underscores, max 31 chars) |
| `--domain <domain>` | `-d` | — | Target domain (e.g. `blog.example.com` or `myblog.localhost`) |
| `--admin-email <email>` | `-e` | — | Admin email address for Ghost |
| `--title <title>` | `-t` | `My Ghost Publication` | Publication title |
| `--version <tag>` | `-v` | `6-alpine` | Ghost Docker image tag (e.g. `6-alpine`, `5-alpine`) |
| `--mysql-root-password <pass>` | — | `$MYSQL_ROOT_PASSWORD` | MySQL root password |
| `--local` | `-l` | `false` | Enable local development mode (HTTP on `*.localhost`, live theme reload) |
| `--theme-dir <path>` | — | — | Path to host theme directory to mount into Ghost for live editing |
| `--port <port>` | — | — | Direct host port to bind for Ghost (e.g. `2368`, `2853`) |
| `--no-interactive` | — | `false` | Disable interactive prompts |
| `--yes` | `-y` | `false` | Skip confirmation prompts |

#### Cloud Storage Options (`--storage s3`)

| Option | Default | Description |
| :--- | :---: | :--- |
| `--storage <type>` | `local` | Storage adapter (`local` or `s3`) |
| `--s3-bucket <bucket>` | — | S3 or Cloudflare R2 bucket name |
| `--s3-key <key>` | — | S3 Access Key ID |
| `--s3-secret <secret>` | — | S3 Secret Access Key |
| `--s3-endpoint <url>` | — | Custom S3 endpoint (e.g. `https://<id>.r2.cloudflarestorage.com`) |
| `--s3-asset-host <url>` | — | Custom CDN or public asset URL |
| `--s3-region <region>` | `auto` | S3 region (e.g. `auto`, `us-east-1`) |
| `--s3-force-path-style` | `false` | Force path-style URLs (useful for MinIO / self-hosted S3) |

#### Transactional Email Options (SMTP)

| Option | Description |
| :--- | :--- |
| `--smtp-host <host>` | Outgoing SMTP host (e.g. `smtp.mailgun.org`, `smtp.sendgrid.net`) |
| `--smtp-user <user>` | SMTP username |
| `--smtp-pass <pass>` | SMTP password |

---

### `pubctl update`

Upgrades or downgrades a Ghost publication with automatic health checks and atomic rollback.

```bash
pubctl update [options]
```

| Option | Alias | Default | Description |
| :--- | :---: | :---: | :--- |
| `--name <name>` | `-n` | — | Tenant identifier to update |
| `--to <version>` | `-t` | — | Target Ghost version image tag (e.g. `6-alpine`, `5-alpine`) |
| `--no-interactive` | — | `false` | Disable interactive wizard prompts |
| `--yes` | `-y` | `false` | Skip confirmation prompts |

---

### `pubctl backup`

Creates a point-in-time snapshot by pausing the tenant container during `mysqldump` and archiving the content volume.

```bash
pubctl backup [options]
```

| Option | Alias | Default | Description |
| :--- | :---: | :---: | :--- |
| `--name <name>` | `-n` | — | Tenant identifier to backup |
| `--output <dir>` | `-o` | `./backups` | Target directory to store the backup archive |
| `--mysql-root-password <pass>` | — | `$MYSQL_ROOT_PASSWORD` | MySQL root password |
| `--no-interactive` | — | `false` | Disable interactive prompts |

---

### `pubctl delete`

Tears down a Ghost publication container, database, and content volume.

```bash
pubctl delete [options]
```

| Option | Alias | Default | Description |
| :--- | :---: | :---: | :--- |
| `--name <name>` | `-n` | — | Tenant identifier to delete |
| `--keep-data` | — | `false` | Retain MySQL database and storage volume on disk |
| `--mysql-root-password <pass>` | — | `$MYSQL_ROOT_PASSWORD` | MySQL root password (required if `--keep-data` is false) |
| `--yes` | `-y` | `false` | Skip deletion confirmation warning |

---

## 🏗️ Architecture & Multi-Tenancy

```text
                    Internet (Port 80 / 443)
                                │
                                ▼
               ┌───────────────────────────────────┐
               │    Traefik SSL Proxy Container    │
               │   (Auto Let's Encrypt SSL & HTTP) │
               └─────────┬───────────────┬─────────┘
                         │               │
            ┌────────────┘               └────────────┐
            ▼                                         ▼
   ┌───────────────────┐                     ┌───────────────────┐
   │ Ghost: blog-1     │                     │ Ghost: blog-2     │
   │ (tenant: blog1)   │                     │ (tenant: blog2)   │
   └─────────┬─────────┘                     └─────────┬─────────┘
             │                                         │
             ▼                                         ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                  MySQL 8.0 (pubctl-mysql)                   │
   │   - Database: pubctl_blog1       - Database: pubctl_blog2   │
   │   - User: usr_blog1              - User: usr_blog2          │
   └─────────────────────────────────────────────────────────────┘
             │                                         │
             ▼                                         ▼
   ┌───────────────────┐                     ┌───────────────────┐
   │ Local / S3 Media  │                     │ Local / S3 Media  │
   └───────────────────┘                     └───────────────────┘
```

- **Dynamic Ingress**: Traefik watches the Docker socket and inspects labels dynamically (`traefik.http.routers.<name>.rule=Host(...)`). Adding, modifying, or removing tenants requires zero downtime and zero reverse proxy reload commands.
- **Zero Public DB Exposure**: MySQL binds strictly to localhost (`127.0.0.1:3306`) and the internal `pubctl-net` Docker bridge. Database ports are never accessible over the public internet.
- **Customizable Namespace**: All resource names, Docker labels, and database prefixes derive from `APP_NAME` in [src/config.ts](file:///home/officialrajdeepsingh/pubctl/src/config.ts).

---

## 🛠️ Development & Contributing

```bash
# Clone repository
git clone https://github.com/officialrajdeepsingh/pubctl.git
cd pubctl

# Install dependencies
pnpm install

# Run CLI directly during development
pnpm dev --help

# Run unit test suite (31 tests)
pnpm test

# Build single-file production bundle to dist/index.js
pnpm run build
```

---

## 📄 License

MIT © [Rajdeep Singh](https://github.com/officialrajdeepsingh)
