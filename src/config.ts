/**
 * pubctl configuration module
 * Central configuration constants, container names, labels, and defaults.
 *
 * NOTE: Changing APP_NAME will automatically re-namespace all containers,
 * volumes, networks, and Docker labels across the orchestrator.
 */

import fs from 'fs';
import path from 'path';

export const APP_NAME = 'pubctl';

/**
 * Ghost CMS Version Configuration:
 * Default: Ghost 6 ('6-alpine').
 *
 * Forward & Backward Compatibility:
 * - Ghost 6 (default): '6-alpine'
 * - Ghost 5 (legacy supported): Pass '-v 5-alpine'
 * - Custom S3/Docker images: Pass any custom tag, e.g. 'my-ghost:6-s3'
 */
export const DEFAULT_GHOST_VERSION = process.env.PUBCTL_DEFAULT_GHOST_VERSION || '6-alpine';

/**
 * Safely checks if a file or socket exists at the given path without throwing.
 */
function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Resolves the Docker daemon socket path across different operating systems and setups:
 * 1. Explicit user override: `process.env.DOCKER_SOCKET`
 * 2. Standard Docker CLI environment: `process.env.DOCKER_HOST` (`unix://` or `npipe://`)
 * 3. Windows Native (PowerShell/CMD): `//./pipe/docker_engine`
 * 4. macOS (Darwin): checks `/var/run/docker.sock`, Docker Desktop (`~/.docker/run/docker.sock`),
 *    OrbStack (`~/.orbstack/run/docker.sock`), and Colima (`~/.colima/default/docker.sock`)
 * 5. Linux & NixOS: checks standard `/var/run/docker.sock`, `/run/docker.sock`, and
 *    rootless Docker/Podman (`$XDG_RUNTIME_DIR/docker.sock`, `/run/user/<uid>/docker.sock`)
 *
 * @param env Environment variables object (defaults to process.env)
 * @param platform Operating system platform (defaults to process.platform)
 * @returns Resolved filesystem path or Windows named pipe
 */
export function resolveDockerSocket(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  // 1. Explicit user override via DOCKER_SOCKET
  if (env.DOCKER_SOCKET) {
    return env.DOCKER_SOCKET;
  }

  // 2. Standard DOCKER_HOST variable
  if (env.DOCKER_HOST) {
    if (env.DOCKER_HOST.startsWith('unix://')) {
      return env.DOCKER_HOST.replace(/^unix:\/\//, '');
    }
    if (env.DOCKER_HOST.startsWith('npipe://')) {
      return env.DOCKER_HOST.replace(/^npipe:\/\//, '');
    }
    return env.DOCKER_HOST;
  }

  // 3. Windows Native named pipe
  if (platform === 'win32') {
    return '//./pipe/docker_engine';
  }

  // 4. macOS (Darwin) socket locations
  if (platform === 'darwin') {
    const home = env.HOME || '';
    const macCandidates = [
      '/var/run/docker.sock',
      path.join(home, '.docker', 'run', 'docker.sock'),
      path.join(home, '.orbstack', 'run', 'docker.sock'),
      path.join(home, '.colima', 'default', 'docker.sock'),
    ];

    for (const candidate of macCandidates) {
      if (pathExists(candidate)) {
        return candidate;
      }
    }
    return '/var/run/docker.sock';
  }

  // 5. Linux & NixOS (Rootful, Systemd, or Rootless)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const xdgRuntime = env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : undefined);

  const linuxCandidates = [
    '/var/run/docker.sock',
    '/run/docker.sock',
  ];

  if (xdgRuntime) {
    linuxCandidates.push(
      path.join(xdgRuntime, 'docker.sock'),
      path.join(xdgRuntime, 'podman', 'podman.sock')
    );
  }

  for (const candidate of linuxCandidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  // Default fallback
  return '/var/run/docker.sock';
}

export const CONFIG = {
  APP_NAME,

  // Infrastructure containers & network
  NETWORK_NAME: `${APP_NAME}-net`,
  DB_CONTAINER: `${APP_NAME}-mysql`,
  PROXY_CONTAINER: `${APP_NAME}-traefik`,

  // Docker volume names
  DB_VOLUME: `${APP_NAME}-mysql-data`,
  CERTS_VOLUME: `${APP_NAME}-certs`,

  // Database defaults
  DEFAULT_DB_PORT: 3306,
  // The root password is deliberately not given a default. Operators must supply
  // MYSQL_ROOT_PASSWORD (or --mysql-root-password during init) and retain it.
  // A predictable fallback here would expose every installation to the same
  // credential.

  // Traefik defaults
  DEFAULT_CERT_RESOLVER: 'myresolver',

  // Image defaults
  DEFAULT_GHOST_VERSION,
  DEFAULT_MYSQL_IMAGE: 'mysql:8.0',
  // Use Traefik latest (v3.7+) with Docker API negotiation support for Docker Engine 29+ compatibility
  DEFAULT_TRAEFIK_IMAGE: 'traefik:latest',
  DEFAULT_BACKUP_IMAGE: 'alpine',

  // Storage adapter defaults
  DEFAULT_STORAGE_TYPE: 'local',
  DEFAULT_S3_REGION: 'auto',

  // Backup defaults
  DEFAULT_BACKUP_DIR: './backups',

  // Docker socket path (dynamically resolved with multi-platform & rootless support)
  get DOCKER_SOCKET_PATH(): string {
    return resolveDockerSocket();
  },

  // Docker label namespaces
  LABELS: {
    TENANT: `${APP_NAME}.tenant`,
    VERSION: `${APP_NAME}.version`,
    STORAGE: `${APP_NAME}.storage`,
    MANAGED_BY: `${APP_NAME}.managed-by`,
  },

  // Dynamic naming helpers
  getTenantContainerName: (name: string): string => `${APP_NAME}-${name}`,
  getTenantVolumeName: (name: string): string => `${APP_NAME}-content-${name}`,
  getTenantDbName: (name: string): string => `${APP_NAME}_${name}`,
  getTenantDbUser: (name: string): string => `usr_${name}`,
};

export type StorageType = 'local' | 's3';

/**
 * ARCHITECTURAL REFERENCE: GHOST S3 STORAGE ADAPTER
 * -----------------------------------------------------------------------------
 * Ghost CMS does not include cloud storage adapters (S3, Cloudflare R2, MinIO)
 * in its official base image (`ghost:6-alpine`, `ghost:5-alpine`).
 *
 * For Ghost to locate and activate an S3 adapter, the package `ghost-storage-adapter-s3`
 * must be located at:
 *   /var/lib/ghost/content/adapters/storage/s3/index.js
 *
 * When building a custom Ghost Docker image for S3 storage, use the following pattern:
 *
 * ```dockerfile
 * ARG GHOST_VERSION=6-alpine
 * FROM ghost:${GHOST_VERSION}
 *
 * # Install ghost-storage-adapter-s3 into Ghost content adapters path
 * RUN mkdir -p /var/lib/ghost/content/adapters/storage/s3 && \
 *     cd /var/lib/ghost/content/adapters/storage/s3 && \
 *     npm install --no-save ghost-storage-adapter-s3 && \
 *     echo "module.exports = require('ghost-storage-adapter-s3');" > index.js && \
 *     chown -R node:node /var/lib/ghost/content/adapters
 * ```
 *
 * When the container starts with `storage__active=s3`, Ghost automatically loads
 * `/var/lib/ghost/content/adapters/storage/s3` and reads configuration from the
 * injected `storage__s3__*` environment variables.
 * -----------------------------------------------------------------------------
 */
