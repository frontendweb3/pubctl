/**
 * pubctl configuration module
 * Central configuration constants, container names, labels, and defaults.
 *
 * NOTE: Changing APP_NAME will automatically re-namespace all containers,
 * volumes, networks, and Docker labels across the orchestrator.
 */

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

  // Docker socket path
  DOCKER_SOCKET_PATH: process.env.DOCKER_SOCKET || '/var/run/docker.sock',

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
} as const;

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
