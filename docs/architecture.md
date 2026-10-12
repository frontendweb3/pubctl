# pubctl Architecture & Multi-Tenancy Design

This document details the architectural design of `pubctl`, explaining how it orchestrates multi-tenant Ghost instances, manages Docker resources, and guarantees data integrity.

---

## 1. High-Level System Architecture

`pubctl` orchestrates a decoupled, multi-container environment on a single Docker host:

```
                            [ Inbound Web Traffic ]
                                       │
                                       ▼
                   ┌───────────────────────────────────────┐
                   │       pubctl-traefik (Reverse Proxy)  │
                   │    - Port 80 -> HTTPS redirect        │
                   │    - Port 443 -> SSL termination      │
                   │    - ACME Let's Encrypt automated TLS │
                   └───────────────────┬───────────────────┘
                                       │
                      Docker Bridge Network: pubctl-net
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌───────────────────────┐                             ┌───────────────────────┐
│ pubctl-<tenant-A>     │                             │ pubctl-<tenant-B>     │
│ Ghost CMS instance    │                             │ Ghost CMS instance    │
│ Host: tenant-a.com    │                             │ Host: tenant-b.com    │
└───────────┬───────────┘                             └───────────┬───────────┘
            │                                                     │
            └──────────────────────────┬──────────────────────────┘
                                       │
                                       ▼
                   ┌───────────────────────────────────────┐
                   │         pubctl-mysql (MySQL 8.0)      │
                   │  - Database: pubctl_<tenant-A>        │
                   │  - User: usr_<tenant-A>               │
                   │  - Database: pubctl_<tenant-B>        │
                   │  - User: usr_<tenant-B>               │
                   └───────────────────────────────────────┘
```

---

## 2. Infrastructure Components

### A. Reverse Proxy & Automated SSL (`pubctl-traefik`)
- Uses **Traefik v3.1** running in Docker provider mode.
- Does **not** expose containers by default (`--providers.docker.exposedbydefault=false`).
- Listens on host ports 80 and 443. Port 80 automatically redirects to HTTPS.
- Discovers new Ghost instances purely via Docker labels attached to the container at launch:
  ```ini
  traefik.enable=true
  traefik.http.routers.<name>.rule=Host(`<domain>`)
  traefik.http.routers.<name>.entrypoints=websecure
  traefik.http.routers.<name>.tls.certresolver=myresolver
  traefik.http.services.<name>.loadbalancer.server.port=2368
  ```
- ACME certificates are stored persistently in the named volume `pubctl-certs`.

### B. Shared Isolated Database Server (`pubctl-mysql`)
- Single **MySQL 8.0** server listening internally on `pubctl-net`.
- Port 3306 is bound to localhost (`127.0.0.1:3306`) for CLI management tasks and is **never** accessible over the public network interface. The root password must be supplied through `MYSQL_ROOT_PASSWORD`; it has no built-in default.
- Each tenant receives:
  - An isolated database: `pubctl_<tenant_name>`
  - A unique user: `usr_<tenant_name>` with a randomly generated 32-character hexadecimal password.
  - Privileges restricted strictly to that tenant's database (`GRANT ALL PRIVILEGES ON pubctl_<tenant_name>.* TO usr_<tenant_name>@'%'`).

### C. Persistent Storage
- Ghost content (themes, settings, sqlite caches) is stored in a dedicated named volume: `pubctl-content-<tenant_name>`.
- Media uploads can either remain in the local content volume or be offloaded via S3/R2 storage adapters.

---

## 3. Safe Stream Demuxing for Standalone Binaries

When compiling TypeScript into a single standalone binary using `bun build --compile`, Docker streams must be handled with care to prevent hanging or uncaught exceptions.

### The Problem
- Docker multiplexes stdout and stderr over a single TCP/Unix socket stream with 8-byte framing headers.
- Dockerode's `modem.demuxStream()` splits these frames, but does not close the output streams or forward error events.
- If `mysqldump` fails (e.g. invalid credentials or missing database), stderr is emitted, but the stream ends normally without raising an error in the calling function.

### The Solution: `safeDemuxExecStream`
`pubctl` wraps Dockerode stream demuxing in a robust lifecycle handler:
1. Pipes stderr to an in-memory `PassThrough` stream to capture warnings and error messages without corrupting terminal UI output.
2. Registers `'error'`, `'end'`, and `'close'` listeners on both the incoming Docker stream and the outgoing file write stream.
3. Automatically calls `dumpFile.end()` when Docker finishes transmitting.
4. Waits for `dumpFile.on('finish')` to guarantee all buffers are completely flushed to disk.
5. Executes `exec.inspect()` to verify the process exited with code `0`. If not, it rejects with the captured stderr output and aborts the backup cleanly.

---

## 4. Renaming & Customization

The orchestrator is completely dynamic. If you want to re-brand the CLI or change container naming schemes:

Edit [src/config.ts](../src/config.ts):
```typescript
export const APP_NAME = 'pubctl'; // Change this single constant
```

All network names (`${APP_NAME}-net`), container names (`${APP_NAME}-mysql`), volumes (`${APP_NAME}-mysql-data`), and label namespaces (`${APP_NAME}.tenant`) will automatically update across the codebase.
