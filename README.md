# pubctl 🚀 `Beta`

> **Zero-configuration, multi-tenant CLI and Docker orchestrator for self-hosting Ghost CMS across any cloud provider.**

[![Status: Beta](https://img.shields.io/badge/Status-Beta-orange.svg)](https://github.com/officialrajdeepsingh/pubctl)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](#prerequisites)
[![Bun](https://img.shields.io/badge/Bun-Compiled_Binary-fbf0df?logo=bun&logoColor=black)](#installation)

> [!IMPORTANT]
> **Beta Stage Notice**: `pubctl` is currently in active beta. Core orchestration features (Traefik SSL, isolated MySQL, S3 storage, backups, and standalone binary execution) are operational, but commands, flags, and configuration formats may evolve before the stable v1.0 release. Please report issues, feedback, or feature requests on GitHub!

`pubctl` automates the lifecycle of multi-tenant Ghost CMS instances on a single virtual server (AWS EC2, Hetzner, DigitalOcean, Linode, etc.). It orchestrates automatic Let's Encrypt SSL certificates via Traefik v3, per-tenant isolated MySQL 8.0 databases, S3-compatible cloud media storage, automated zero-touch administrative provisioning, point-in-time backups, and recoverable restart updates.

---

## ⚡ Highlights

- 🔒 **Automated SSL/TLS**: Traefik reverse proxy automatically provisions and renews Let's Encrypt certificates over HTTP/HTTPS.
- 🗄️ **Multi-Tenant Database Isolation**: Automatically creates dedicated databases and restricted MySQL users per blog.
- ☁️ **S3 / Cloudflare R2 Media Offloading**: Seamless support for AWS S3, Cloudflare R2, MinIO, and DigitalOcean Spaces to keep local disk usage minimal.
- 🔑 **Headless Zero-Touch Setup**: Automatically bootstraps the Ghost admin account and password, bypassing manual setup screens.
- 📦 **Point-in-Time Backups**: Temporarily pauses a tenant while its MySQL dump and content archive are created.
- 🔄 **Recoverable Updates**: Restores the previous container automatically if a replacement fails to start.
- 🚀 **Zero Runtime Dependencies**: Distributed as a single, self-contained native binary compiled with Bun—no Node.js or npm required on target hosts.

---

## 📥 Installation

### Option 1: One-Line Installer (Recommended)

Installs the standalone native binary to `/usr/local/bin/pubctl` with zero dependencies:

```bash
curl -sSL https://raw.githubusercontent.com/officialrajdeepsingh/pubctl/main/install.sh | bash
```

> **Note:** Works on Linux (x64 & ARM64) and macOS. Requires only Docker to be installed.

---

### Option 2: Global Install via `npm` or `pnpm`

If you have Node.js (v18+) installed:

```bash
# Using pnpm
pnpm add -g pubctl

# Using npm
npm install -g pubctl
```

---

### Option 3: Manual Binary Download

Download pre-compiled binaries directly from [GitHub Releases](https://github.com/officialrajdeepsingh/pubctl/releases):

```bash
# Example for Linux x64
curl -sSL -o pubctl https://github.com/officialrajdeepsingh/pubctl/releases/latest/download/pubctl-linux-x64
chmod +x pubctl
sudo mv pubctl /usr/local/bin/
```

---

## 📋 Prerequisites

1. **Docker Engine**: Docker must be running on your host:
   ```bash
   docker --version
   ```
2. **MySQL Root Password**: Generate and retain a strong password before initialization. It must also be available to later `create`, `backup`, and `delete` commands:
   ```bash
   export MYSQL_ROOT_PASSWORD="$(openssl rand -base64 32)"
   ```
3. **Ports 80 & 443**: Available on the host for Traefik to bind and issue Let's Encrypt SSL certificates.
4. **DNS Records**: Point your domain or subdomains (A / AAAA records) to your server's public IP address.

---

## 🚀 Quickstart Guide

### 1. Initialize Base Infrastructure

Run this once on a fresh server to launch the shared Docker bridge network, Traefik SSL proxy, and MySQL 8.0 container:

```bash
export MYSQL_ROOT_PASSWORD="$(openssl rand -base64 32)"
pubctl init --email admin@example.com
```

### 2. Deploy a Site (Local Storage)

Deploy a new publication with automated database provisioning and admin credentials:

```bash
pubctl create \
  --name techblog \
  --domain blog.example.com \
  --admin-email admin@example.com \
  --title "My Tech Blog"
```

Once provisioning completes, `pubctl` displays your live blog URL, admin panel link, and automatically generated secure admin password!

### 3. Deploy a Site with Cloudflare R2 / AWS S3 Storage

Offload all image and media uploads to S3-compatible cloud storage:

```bash
pubctl create \
  --name mediahub \
  --domain media.example.com \
  --admin-email admin@example.com \
  --storage s3 \
  --s3-bucket my-ghost-bucket \
  --s3-key YOUR_R2_ACCESS_KEY_ID \
  --s3-secret YOUR_R2_SECRET_ACCESS_KEY \
  --s3-endpoint https://<account_id>.r2.cloudflarestorage.com \
  --s3-asset-host https://cdn.example.com
```

---

## 📖 Command Reference

### `pubctl init`

Sets up Traefik v3 (with automatic ACME HTTP/TLS challenge support) and MySQL 8.0.

```bash
pubctl init --email <email>
```

| Option            | Required | Description                                                                    |
| :---------------- | :------: | :----------------------------------------------------------------------------- |
| `--email <email>` | **Yes**  | Email address registered with Let's Encrypt for certificate expiration notices |

---

### `pubctl create`

Provisions a new isolated Ghost CMS tenant.

```bash
pubctl create [options]
```

#### Core Options

| Option                | Shorthand | Required |  Default   | Description                                                                |
| :-------------------- | :-------: | :------: | :--------: | :------------------------------------------------------------------------- |
| `--name <name>`       |   `-n`    | **Yes**  |     —      | Unique tenant identifier (e.g., `techblog`)                                |
| `--domain <domain>`   |   `-d`    | **Yes**  |     —      | Fully qualified domain name (e.g., `blog.example.com`)                     |
| `--version <version>` |   `-v`    |    No    | `6-alpine` | Ghost Docker image tag or custom repository (e.g., `6-alpine`, `5-alpine`) |

#### S3-Compatible Cloud Storage Options

| Option                  | Default | Description                                        |
| :---------------------- | :-----: | :------------------------------------------------- |
| `--storage <type>`      | `local` | Storage driver: `local` or `s3`                    |
| `--s3-bucket <bucket>`  |    —    | Bucket name (**required** if `--storage s3`)       |
| `--s3-key <key>`        |    —    | Access Key ID (**required** if `--storage s3`)     |
| `--s3-secret <secret>`  |    —    | Secret Access Key (**required** if `--storage s3`) |
| `--s3-endpoint <url>`   |    —    | Custom endpoint URL (e.g., Cloudflare R2, MinIO)   |
| `--s3-asset-host <url>` |    —    | Custom CDN domain prefix for media assets          |
| `--s3-region <region>`  | `auto`  | Bucket region (e.g., `us-east-1`, `auto` for R2)   |
| `--s3-force-path-style` | `false` | Enable path-style URLs (useful for MinIO)          |

#### Transactional Email (SMTP) Options

| Option               | Description                                          |
| :------------------- | :--------------------------------------------------- |
| `--smtp-host <host>` | Outgoing SMTP server host (e.g., `smtp.mailgun.org`) |
| `--smtp-user <user>` | SMTP authentication username                         |
| `--smtp-pass <pass>` | SMTP authentication password                         |

---

### `pubctl backup`

Creates a point-in-time snapshot by pausing the tenant while it writes the MySQL dump (`db.sql`) and gzipped content archive (`content.tar.gz`).

```bash
pubctl backup -n <name> [-o <output_dir>]
```

| Option           | Shorthand | Required |   Default   | Description                          |
| :--------------- | :-------: | :------: | :---------: | :----------------------------------- |
| `--name <name>`  |   `-n`    | **Yes**  |      —      | Tenant identifier                    |
| `--output <dir>` |   `-o`    |    No    | `./backups` | Target directory to store the backup |

---

### `pubctl update`

Performs a recoverable restart update while preserving database data, environment credentials, and storage volumes. If the replacement fails, the prior container is restored automatically.

```bash
pubctl update -n <name> -t <version>
```

| Option           | Shorthand | Required | Description                                           |
| :--------------- | :-------: | :------: | :---------------------------------------------------- |
| `--name <name>`  |   `-n`    | **Yes**  | Tenant identifier                                     |
| `--to <version>` |   `-t`    | **Yes**  | Target Ghost image tag (e.g., `6-alpine`, `5-alpine`) |

---

### `pubctl delete`

Stops and removes the Ghost container. By default, it purges the isolated MySQL database, user credentials, and Docker volume.

```bash
pubctl delete -n <name> [--keep-data]
```

| Option          | Shorthand | Description                                      |
| :-------------- | :-------: | :----------------------------------------------- |
| `--name <name>` |   `-n`    | Tenant identifier                                |
| `--keep-data`   |     —     | Preserve the database and content volume on disk |

---

## ☁️ Cloud Storage Setup Guides

Ghost requires the storage adapter package [`ghost-storage-adapter-s3`](https://www.npmjs.com/package/ghost-storage-adapter-s3) inside the container at `/var/lib/ghost/content/adapters/storage/s3/`.

We provide a ready-to-build [Dockerfile.ghost-s3](file:///home/officialrajdeepsingh/pubctl/Dockerfile.ghost-s3) that defaults to Ghost 6:

```bash
# Default build (Ghost 6):
docker build -t my-ghost-s3:6-alpine -f Dockerfile.ghost-s3 .

# Legacy Ghost 5 build:
docker build --build-arg GHOST_VERSION=5-alpine -t my-ghost-s3:5-alpine -f Dockerfile.ghost-s3 .
```

### 1. Cloudflare R2

1. In Cloudflare Dashboard, go to **R2 Storage** and create a bucket (e.g., `my-ghost-bucket`).
2. Generate an **R2 API Token** with Read & Write permissions.
3. Note your Endpoint URL: `https://<account_id>.r2.cloudflarestorage.com`.
4. (Optional) Connect a custom domain to your bucket (e.g., `https://media.example.com`).
5. Deploy:
   ```bash
   pubctl create \
     --name blog \
     --domain blog.example.com \
     --admin-email admin@example.com \
     --version my-ghost-s3:6-alpine \
     --storage s3 \
     --s3-bucket my-ghost-bucket \
     --s3-key <R2_ACCESS_KEY_ID> \
     --s3-secret <R2_SECRET_ACCESS_KEY> \
     --s3-endpoint https://<account_id>.r2.cloudflarestorage.com \
     --s3-asset-host https://media.example.com \
     --s3-region auto
   ```

### 2. AWS S3

```bash
pubctl create \
  --name blog \
  --domain blog.example.com \
  --admin-email admin@example.com \
  --version my-ghost-s3:6-alpine \
  --storage s3 \
  --s3-bucket my-aws-ghost-bucket \
  --s3-key AKIAIOSFODNN7EXAMPLE \
  --s3-secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  --s3-region us-east-1
```

### 3. MinIO (Self-Hosted S3)

For MinIO or local S3 instances, pass `--s3-force-path-style`:

```bash
pubctl create \
  --name blog \
  --domain blog.example.com \
  --admin-email admin@example.com \
  --version my-ghost-s3:6-alpine \
  --storage s3 \
  --s3-bucket ghost-uploads \
  --s3-key minioadmin \
  --s3-secret minioadmin \
  --s3-endpoint https://minio.internal.example.com \
  --s3-force-path-style
```

---

## 🏗️ Architecture & Multi-Tenancy

```
                    Internet (Port 80 / 443)
                                │
                                ▼
               ┌───────────────────────────────────┐
               │    Traefik SSL Proxy Container    │
               │   (Auto Let's Encrypt Wildcard)   │
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

- **Traefik Ingress**: Dynamically routes traffic based on Docker labels (`traefik.http.routers.<name>.rule=Host(...)`). Adding or removing tenants requires zero proxy restarts or reload commands.
- **Network Isolation**: All containers run on an isolated bridge network (`pubctl-net`). Database ports are never exposed to the public internet.
- **Customizable Namespace**: Centralized in [`src/config.ts`](file:///home/officialrajdeepsingh/pubctl/src/config.ts). Changing `APP_NAME` updates all container names, networks, volumes, and labels.

---

## 🛠️ Development & Compiling

### Build Prerequisites

- [Bun](https://bun.sh/) (v1.1+)
- [pnpm](https://pnpm.io/) (v9+)
- [Node.js](https://nodejs.org/) (v18+)

```bash
# Clone the repository
git clone https://github.com/officialrajdeepsingh/pubctl.git
cd pubctl

# Install dependencies
pnpm install

# Run during development
pnpm dev --help

# Build TypeScript to dist/index.js (for Node.js & npm)
pnpm run build

# Compile standalone Linux x64 binary (zero external dependencies)
pnpm run compile:linux-x64
```

---

## 📄 License

MIT © [Rajdeep Singh](https://github.com/officialrajdeepsingh)
