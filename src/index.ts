#!/usr/bin/env node
/**
 * =============================================================================
 * pubctl - Zero-Configuration Multi-Tenant CLI & Docker Orchestrator for Ghost
 * =============================================================================
 *
 * Runtime & Compilation Compatibility:
 * ------------------------------------
 * - Standalone Binary (Bun):
 *     Compiled with `bun build --compile --target=bun-linux-x64 --external cpu-features ...`
 *     to produce a single, self-contained ELF executable with zero runtime dependencies.
 * - Node.js Fallback:
 *     Compatible with Node.js 18+ (NodeNext ESM) via `tsc` -> `node dist/index.js` or `tsx`.
 *
 * Storage Architecture:
 * ---------------------
 * - Local (default): Ghost content persisted via Docker named volume.
 * - S3/R2 Cloud Storage: Offloads media assets to AWS S3, Cloudflare R2, MinIO,
 *   or DigitalOcean Spaces using `ghost-storage-adapter-s3`.
 *   See Dockerfile.ghost-s3 for building custom Ghost images with the adapter installed
 *   at `/var/lib/ghost/content/adapters/storage/s3/index.js`.
 * =============================================================================
 */

import { Command } from 'commander';
import Docker from 'dockerode';
import mysql from 'mysql2/promise';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { PassThrough } from 'stream';
import { APP_NAME, CONFIG, StorageType } from './config.js';
import { validateDomain, validateEmail, validateTenantName } from './validation.js';

const docker = new Docker({ socketPath: CONFIG.DOCKER_SOCKET_PATH });
const program = new Command();

program
  .name(APP_NAME)
  .description('Deploy, manage, and update Ghost blogs on Docker with zero configuration')
  .version('1.0.0');

function getRootPassword(): string {
  const password = process.env.MYSQL_ROOT_PASSWORD;
  if (!password) {
    throw new Error('MYSQL_ROOT_PASSWORD is required. Set it to the password used with `pubctl init`.');
  }
  return password;
}

async function pullImage(image: string): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

function reportFailure(spinner: ora.Ora, action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  spinner.fail(chalk.red(`${action} failed: ${message}`));
  process.exitCode = 1;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function waitForGhostReady(container: Docker.Container, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Ghost did not respond';
  while (Date.now() < deadline) {
    const info = await container.inspect();
    if (!info.State.Running) throw new Error('Replacement Ghost container exited before becoming ready.');
    const ip = info.NetworkSettings?.Networks?.[CONFIG.NETWORK_NAME]?.IPAddress;
    if (ip) {
      try {
        const response = await fetchWithTimeout(`http://${ip}:2368/`, { method: 'GET' }, 5_000);
        if (response.ok || (response.status >= 300 && response.status < 400)) return;
        lastError = `Ghost returned HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Ghost did not become ready within ${timeoutMs / 1000}s: ${lastError}`);
}

function mysqlIsLocalOnly(info: Docker.ContainerInspectInfo): boolean {
  const bindings = info.HostConfig.PortBindings?.[`${CONFIG.DEFAULT_DB_PORT}/tcp`];
  return Array.isArray(bindings) && bindings.length > 0 && bindings.every((binding) => binding.HostIp === '127.0.0.1');
}

async function removeVolumeIfPresent(name: string): Promise<void> {
  const volume = docker.getVolume(name);
  try {
    await volume.inspect();
  } catch (err: any) {
    if (err?.statusCode === 404) return;
    throw err;
  }
  await volume.remove();
}

// -------------------------------------------------------------
// Database Helper with Connection Retry
// -------------------------------------------------------------
async function getDbConnection(retries = 5, delayMs = 1500) {
  const rootPassword = getRootPassword();
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await mysql.createConnection({
        host: '127.0.0.1',
        port: CONFIG.DEFAULT_DB_PORT,
        user: 'root',
        password: rootPassword,
      });
    } catch (err: any) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// -------------------------------------------------------------
// Safe Docker Stream Demuxing Helper
// -------------------------------------------------------------
/**
 * Safely demuxes a Docker exec duplex stream into stdout and stderr streams.
 * Handles stream completion, error propagation, backpressure, and resource cleanup
 * for standalone binary compilation (Bun/Node).
 *
 * @param modem The Dockerode modem instance
 * @param stream Duplex/Readable stream returned from exec.start()
 * @param stdoutDest Destination writable stream (e.g., fs.WriteStream for db.sql)
 * @param checkExitCode Optional callback to inspect container process exit code
 */
async function safeDemuxExecStream(
  modem: any,
  stream: NodeJS.ReadableStream,
  stdoutDest: NodeJS.WritableStream,
  checkExitCode?: () => Promise<number | null | undefined>
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderrBuffer = '';
    let isSettled = false;

    const stderrStream = new PassThrough();
    stderrStream.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    const cleanup = () => {
      stream.removeAllListeners('error');
      stream.removeAllListeners('end');
      stream.removeAllListeners('close');
      stdoutDest.removeAllListeners('error');
      stdoutDest.removeAllListeners('finish');
      stderrStream.removeAllListeners('error');
    };

    const handleError = (err: Error) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(err);
    };

    // Attach stream error listeners to prevent uncaught exceptions
    stream.on('error', handleError);
    stdoutDest.on('error', handleError);
    stderrStream.on('error', handleError);

    // Attach demuxStream from docker-modem
    modem.demuxStream(stream, stdoutDest, stderrStream);

    // Safely end destination streams when the source stream finishes transmitting
    const onStreamDone = () => {
      stdoutDest.end();
      stderrStream.end();
    };

    stream.on('end', onStreamDone);
    stream.on('close', onStreamDone);

    // Wait until stdoutDest has completely flushed and closed on disk
    stdoutDest.on('finish', async () => {
      if (isSettled) return;
      isSettled = true;
      cleanup();

      if (checkExitCode) {
        try {
          const exitCode = await checkExitCode();
          if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
            return reject(
              new Error(
                `Process inside container exited with code ${exitCode}. Stderr: ${
                  stderrBuffer.trim() || '(none)'
                }`
              )
            );
          }
        } catch (inspectErr) {
          return reject(inspectErr);
        }
      }

      resolve({ stderr: stderrBuffer });
    });
  });
}

// -------------------------------------------------------------
// Container Resolution Helper (Supports current & legacy naming)
// -------------------------------------------------------------
async function findTenantContainer(name: string): Promise<Docker.Container> {
  const primaryName = CONFIG.getTenantContainerName(name);
  const legacyName = `ghost-${name}`;
  try {
    const containers = await docker.listContainers({ all: true });
    const match = containers.find(
      (c) => c.Names.includes(`/${primaryName}`) || c.Names.includes(`/${legacyName}`)
    );
    if (match) {
      return docker.getContainer(match.Id);
    }
  } catch {
    // If listing fails, fall through to primary container handle
  }
  return docker.getContainer(primaryName);
}

// -------------------------------------------------------------
// COMMAND: INIT (Sets up shared network, MySQL, and Traefik SSL)
// -------------------------------------------------------------
program
  .command('init')
  .description('Initialize base Docker infrastructure (Traefik SSL Proxy + MySQL)')
  .requiredOption('--email <email>', "Let's Encrypt email for automatic SSL")
  .option('--mysql-root-password <password>', 'MySQL root password (otherwise MYSQL_ROOT_PASSWORD is used)')
  .option('--rotate-mysql-root-password', 'Rotate the existing root password using PUBCTL_NEW_ROOT_PASSWORD; MYSQL_ROOT_PASSWORD must contain the current password')
  .action(async (options) => {
    const spinner = ora('Setting up base infrastructure...').start();
    try {
      validateEmail(options.email);
      const newRootPassword = process.env.PUBCTL_NEW_ROOT_PASSWORD;
      if (options.mysqlRootPassword && options.rotateMysqlRootPassword) {
        throw new Error('Use either --mysql-root-password or --rotate-mysql-root-password, not both.');
      }
      if (options.rotateMysqlRootPassword && !newRootPassword) {
        throw new Error('PUBCTL_NEW_ROOT_PASSWORD is required with --rotate-mysql-root-password.');
      }
      if (options.mysqlRootPassword) process.env.MYSQL_ROOT_PASSWORD = options.mysqlRootPassword;
      const rootPassword = getRootPassword();
      // 1. Create Docker Network
      const networks = await docker.listNetworks();
      if (!networks.some((n) => n.Name === CONFIG.NETWORK_NAME)) {
        await docker.createNetwork({ Name: CONFIG.NETWORK_NAME, Driver: 'bridge' });
      }

      // 2. Start MySQL
      const containers = await docker.listContainers({ all: true });
      const mysqlExists = containers.some((c) => c.Names.includes(`/${CONFIG.DB_CONTAINER}`));
      if (!mysqlExists) {
        spinner.text = `Pulling and starting MySQL (${CONFIG.DEFAULT_MYSQL_IMAGE})...`;
        await pullImage(CONFIG.DEFAULT_MYSQL_IMAGE);
        const mysqlContainer = await docker.createContainer({
          Image: CONFIG.DEFAULT_MYSQL_IMAGE,
          name: CONFIG.DB_CONTAINER,
          Env: [`MYSQL_ROOT_PASSWORD=${rootPassword}`],
          HostConfig: {
            RestartPolicy: { Name: 'always' },
            Binds: [`${CONFIG.DB_VOLUME}:/var/lib/mysql`],
            PortBindings: {
              [`${CONFIG.DEFAULT_DB_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: `${CONFIG.DEFAULT_DB_PORT}` }],
            },
            NetworkMode: CONFIG.NETWORK_NAME,
          },
          Labels: {
            [CONFIG.LABELS.MANAGED_BY]: APP_NAME,
          },
        });
        await mysqlContainer.start();
      } else {
        const mysqlContainer = docker.getContainer(CONFIG.DB_CONTAINER);
        const mysqlInfo = await mysqlContainer.inspect();
        const usesLegacyDefault = mysqlInfo.Config.Env?.includes('MYSQL_ROOT_PASSWORD=pubctl_root_secret');
        if (usesLegacyDefault && !options.rotateMysqlRootPassword) {
          throw new Error('Existing MySQL uses the retired default root password. Rotate it before continuing; this command will not silently retain an insecure credential.');
        }
        if (!mysqlIsLocalOnly(mysqlInfo)) {
          spinner.text = 'Repairing MySQL localhost-only port binding...';
          if (mysqlInfo.State.Running) await mysqlContainer.stop();
          await mysqlContainer.remove();
          const repairedMysql = await docker.createContainer({
            Image: mysqlInfo.Config.Image,
            name: CONFIG.DB_CONTAINER,
            Env: mysqlInfo.Config.Env,
            HostConfig: {
              RestartPolicy: mysqlInfo.HostConfig.RestartPolicy,
              Binds: mysqlInfo.HostConfig.Binds,
              PortBindings: {
                [`${CONFIG.DEFAULT_DB_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: `${CONFIG.DEFAULT_DB_PORT}` }],
              },
              NetworkMode: CONFIG.NETWORK_NAME,
            },
            Labels: { ...mysqlInfo.Config.Labels, [CONFIG.LABELS.MANAGED_BY]: APP_NAME },
          });
          await repairedMysql.start();
        } else if (!mysqlInfo.State.Running) {
          await mysqlContainer.start();
        }
      }

      // Do not report a successful init until MySQL accepts authenticated connections.
      const db = await getDbConnection(30, 1000);
      if (options.rotateMysqlRootPassword) {
        const [rootUsers] = await db.query('SELECT Host FROM mysql.user WHERE User = ?', ['root']);
        if (!Array.isArray(rootUsers) || rootUsers.length === 0) {
          throw new Error('Could not find a MySQL root account to rotate.');
        }
        for (const rootUser of rootUsers as Array<{ Host: string }>) {
          const host = rootUser.Host.replace(/'/g, "''");
          await db.query(`ALTER USER 'root'@'${host}' IDENTIFIED BY ?`, [newRootPassword]);
        }
        process.env.MYSQL_ROOT_PASSWORD = newRootPassword;
      }
      await db.end();

      // 3. Start Traefik (Auto SSL)
      const traefikExists = containers.some((c) => c.Names.includes(`/${CONFIG.PROXY_CONTAINER}`));
      if (!traefikExists) {
        spinner.text = `Configuring Traefik (${CONFIG.DEFAULT_TRAEFIK_IMAGE}) with automatic Let's Encrypt...`;
        await pullImage(CONFIG.DEFAULT_TRAEFIK_IMAGE);
        const traefikContainer = await docker.createContainer({
          Image: CONFIG.DEFAULT_TRAEFIK_IMAGE,
          name: CONFIG.PROXY_CONTAINER,
          Cmd: [
            '--providers.docker=true',
            '--providers.docker.exposedbydefault=false',
            '--entrypoints.web.address=:80',
            '--entrypoints.web.http.redirections.entrypoint.to=websecure',
            '--entrypoints.web.http.redirections.entrypoint.scheme=https',
            '--entrypoints.websecure.address=:443',
            `--certificatesresolvers.${CONFIG.DEFAULT_CERT_RESOLVER}.acme.tlschallenge=true`,
            `--certificatesresolvers.${CONFIG.DEFAULT_CERT_RESOLVER}.acme.email=${options.email}`,
            `--certificatesresolvers.${CONFIG.DEFAULT_CERT_RESOLVER}.acme.storage=/letsencrypt/acme.json`,
          ],
          HostConfig: {
            RestartPolicy: { Name: 'always' },
            PortBindings: {
              '80/tcp': [{ HostPort: '80' }],
              '443/tcp': [{ HostPort: '443' }],
            },
            Binds: [
              `${CONFIG.DOCKER_SOCKET_PATH}:/var/run/docker.sock:ro`,
              `${CONFIG.CERTS_VOLUME}:/letsencrypt`,
            ],
            NetworkMode: CONFIG.NETWORK_NAME,
          },
          Labels: {
            [CONFIG.LABELS.MANAGED_BY]: APP_NAME,
          },
        });
        await traefikContainer.start();
      } else {
        const traefikContainer = docker.getContainer(CONFIG.PROXY_CONTAINER);
        const traefikInfo = await traefikContainer.inspect();
        if (!traefikInfo.State.Running) await traefikContainer.start();
      }

      spinner.succeed(chalk.green('Base infrastructure is running with automated SSL support!'));
    } catch (err: unknown) {
      reportFailure(spinner, 'Init', err);
    }
  });

// -------------------------------------------------------------
// COMMAND: CREATE (Provisions Ghost, creates DB, sets password, configures S3/R2)
// -------------------------------------------------------------
program
  .command('create')
  .description('Deploy a new Ghost CMS site with automated zero-touch login')
  .requiredOption('-n, --name <name>', 'Unique tenant name (e.g., techblog)')
  .requiredOption('-d, --domain <domain>', 'Domain or subdomain (e.g., blog.example.com)')
  .requiredOption('-e, --admin-email <email>', 'Admin email address for Ghost')
  .option('-t, --title <title>', 'Blog title', 'My Ghost Publication')
  .option('-v, --version <version>', 'Ghost image version or custom tag (e.g., 6-alpine, 5-alpine)', CONFIG.DEFAULT_GHOST_VERSION)
  .option('--smtp-host <host>', 'SMTP host for transactional emails')
  .option('--smtp-user <user>', 'SMTP username')
  .option('--smtp-pass <pass>', 'SMTP password')
  .option('--storage <type>', 'Storage adapter type (local | s3)', CONFIG.DEFAULT_STORAGE_TYPE)
  .option('--s3-bucket <bucket>', 'S3/R2 storage bucket name')
  .option('--s3-key <key>', 'S3/R2 Access Key ID')
  .option('--s3-secret <secret>', 'S3/R2 Secret Access Key')
  .option('--s3-endpoint <endpoint>', 'Custom S3 endpoint URL (e.g., https://<account_id>.r2.cloudflarestorage.com)')
  .option('--s3-asset-host <host>', 'Public CDN or custom domain for media URLs (e.g., https://media.example.com)')
  .option('--s3-region <region>', 'S3 region (e.g., auto, us-east-1, eu-central-1)', CONFIG.DEFAULT_S3_REGION)
  .option('--s3-force-path-style', 'Force path-style URLs for MinIO / self-hosted S3')
  .action(async (options) => {
    const { name, domain, adminEmail, title, version, storage = CONFIG.DEFAULT_STORAGE_TYPE } = options;
    const spinner = ora(`Provisioning ${domain}...`).start();
    let container: Docker.Container | undefined;
    let databaseProvisioned = false;

    try {
      validateTenantName(name);
      validateDomain(domain);
      validateEmail(adminEmail);
      // 1. Storage Configuration Validation
      if (storage === 's3') {
        if (!options.s3Bucket || !options.s3Key || !options.s3Secret) {
          throw new Error(
            'Missing required S3 credentials. When --storage s3 is specified, ' +
            '--s3-bucket, --s3-key, and --s3-secret must all be provided.'
          );
        }
      } else if (storage !== 'local') {
        throw new Error(`Unsupported storage type: '${storage}'. Supported types: 'local', 's3'.`);
      }
      if (options.smtpHost && (!options.smtpUser || !options.smtpPass)) {
        throw new Error('--smtp-user and --smtp-pass are required when --smtp-host is provided.');
      }

      const dbName = CONFIG.getTenantDbName(name);
      const dbUser = CONFIG.getTenantDbUser(name);
      const dbPassword = crypto.randomBytes(16).toString('hex');
      const generatedAdminPassword =
        crypto.randomBytes(10).toString('base64').replace(/[^a-zA-Z0-9]/g, 'a') + 'A1!';

      // 2. MySQL Database Creation
      spinner.text = 'Creating isolated database...';
      const db = await getDbConnection();
      try {
        const containers = await docker.listContainers({ all: true });
        const containerName = CONFIG.getTenantContainerName(name);
        if (containers.some((candidate) => candidate.Names.includes(`/${containerName}`))) {
          throw new Error(`Tenant '${name}' already has a container. Use update or delete it before creating again.`);
        }
        const [schemas] = await db.query(
          'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
          [dbName]
        );
        if (Array.isArray(schemas) && schemas.length > 0) {
          throw new Error(`Tenant '${name}' already has a database. Refusing to overwrite existing data.`);
        }
        const volumes = await docker.listVolumes();
        if (volumes.Volumes.some((volume) => volume.Name === CONFIG.getTenantVolumeName(name))) {
          throw new Error(`Tenant '${name}' already has a content volume. Refusing to attach existing data.`);
        }
        await db.query(`CREATE DATABASE \`${dbName}\`;`);
        await db.query(`CREATE USER '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}';`);
        await db.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%';`);
        await db.query('FLUSH PRIVILEGES;');
        databaseProvisioned = true;
      } finally {
        await db.end();
      }

      // 3. Prepare Environment Variables
      const envVars = [
        `url=https://${domain}`,
        `NODE_ENV=production`,
        `database__client=mysql`,
        `database__connection__host=${CONFIG.DB_CONTAINER}`,
        `database__connection__user=${dbUser}`,
        `database__connection__password=${dbPassword}`,
        `database__connection__database=${dbName}`,
      ];

      // SMTP Configuration injection if provided
      if (options.smtpHost) {
        envVars.push(
          'mail__transport=SMTP',
          `mail__options__host=${options.smtpHost}`,
          'mail__options__port=587',
          'mail__options__service=SMTP',
          'mail__options__auth__type=LOGIN',
          `mail__options__auth__user=${options.smtpUser}`,
          `mail__options__auth__pass=${options.smtpPass}`
        );
      }

      // S3-Compatible Cloud Storage configuration injection
      if (storage === 's3') {
        const region = options.s3Region || CONFIG.DEFAULT_S3_REGION;
        envVars.push(
          'storage__active=s3',
          `storage__s3__bucket=${options.s3Bucket}`,
          `storage__s3__accessKeyId=${options.s3Key}`,
          `storage__s3__secretAccessKey=${options.s3Secret}`,
          `storage__s3__region=${region}`
        );

        if (options.s3Endpoint) {
          envVars.push(`storage__s3__endpoint=${options.s3Endpoint}`);
        }
        if (options.s3AssetHost) {
          envVars.push(`storage__s3__assetHost=${options.s3AssetHost}`);
        }
        if (options.s3ForcePathStyle) {
          envVars.push('storage__s3__forcePathStyle=true');
        }
      }

      // 4. Start Ghost Container
      const imageTag = version.includes(':') || version.includes('/') ? version : `ghost:${version}`;
      spinner.text = `Starting Ghost (${imageTag}) container...`;
      await pullImage(imageTag);

      const containerName = CONFIG.getTenantContainerName(name);
      const volumeName = CONFIG.getTenantVolumeName(name);

      container = await docker.createContainer({
        Image: imageTag,
        name: containerName,
        Env: envVars,
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          Binds: [`${volumeName}:/var/lib/ghost/content`],
          NetworkMode: CONFIG.NETWORK_NAME,
        },
        Labels: {
          'traefik.enable': 'true',
          [`traefik.http.routers.${name}.rule`]: `Host(\`${domain}\`)`,
          [`traefik.http.routers.${name}.entrypoints`]: 'websecure',
          [`traefik.http.routers.${name}.tls.certresolver`]: CONFIG.DEFAULT_CERT_RESOLVER,
          [`traefik.http.services.${name}.loadbalancer.server.port`]: '2368',
          [CONFIG.LABELS.TENANT]: name,
          [CONFIG.LABELS.VERSION]: version,
          [CONFIG.LABELS.STORAGE]: storage,
          [CONFIG.LABELS.MANAGED_BY]: APP_NAME,
        },
      });

      await container.start();

      // 5. Headless Automated Ghost Setup (Bypasses manual /ghost/#/setup)
      spinner.text = 'Waiting for Ghost migration to complete & bootstrapping admin...';
      let setupSuccess = false;
      const inspectData = await container.inspect();
      const internalIp = inspectData.NetworkSettings?.Networks?.[CONFIG.NETWORK_NAME]?.IPAddress;

      if (internalIp) {
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const res = await fetchWithTimeout(`http://${internalIp}:2368/ghost/api/admin/authentication/setup/`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                setup: [
                  {
                    name: 'Administrator',
                    email: adminEmail,
                    password: generatedAdminPassword,
                    blogTitle: title,
                  },
                ],
              }),
            }, 5_000);
            if (res.ok) {
              setupSuccess = true;
              break;
            }
          } catch {
            // Ghost is still performing Knex database migrations; keep polling
          }
        }
      }

      if (!setupSuccess) {
        throw new Error('Ghost did not complete automated administrator setup within 60 seconds; the deployment was rolled back.');
      }

      spinner.succeed(chalk.green(`Site ${name} deployed successfully!`));

      console.log('\n' + chalk.bold.cyan('================ Deployment Details ================'));
      console.log(`${chalk.bold('Blog URL:')}           https://${domain}`);
      console.log(`${chalk.bold('Admin Panel:')}        https://${domain}/ghost/`);
      console.log(`${chalk.bold('Admin Email:')}        ${adminEmail}`);
      console.log(`${chalk.bold('Temporary Password:')}   ${chalk.yellow(generatedAdminPassword)}`);
      console.log(
        `${chalk.bold('Storage:')}            ${storage.toUpperCase()}${
          storage === 's3' ? ` (Bucket: ${options.s3Bucket})` : ' (Local volume)'
        }`
      );
      console.log(chalk.bold.cyan('===================================================='));

    } catch (err: unknown) {
      // Creation spans Docker and MySQL. Clean up resources created by this
      // invocation so a retry cannot inherit half-configured credentials.
      if (container) {
        try {
          const info = await container.inspect();
          if (info.State.Running) await container.stop();
          await container.remove();
        } catch {
          // Preserve the original provisioning error.
        }
      }
      if (databaseProvisioned) {
        try {
          const db = await getDbConnection();
          const dbName = CONFIG.getTenantDbName(name);
          const dbUser = CONFIG.getTenantDbUser(name);
          await db.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
          await db.query(`DROP USER IF EXISTS '${dbUser}'@'%';`);
          await db.end();
        } catch {
          // Report the provisioning failure; an operator can inspect leftovers.
        }
      }
      reportFailure(spinner, 'Creation', err);
    }
  });

// -------------------------------------------------------------
// COMMAND: BACKUP (Creates a paused point-in-time database + content snapshot)
// -------------------------------------------------------------
program
  .command('backup')
  .description('Create a point-in-time backup of MySQL data and uploads')
  .requiredOption('-n, --name <name>', 'Tenant name')
  .option('-o, --output <dir>', 'Destination directory', CONFIG.DEFAULT_BACKUP_DIR)
  .action(async (options) => {
    const { name, output } = options;
    const spinner = ora(`Backing up ${name}...`).start();
    let pausedContainer: Docker.Container | undefined;
    let isPaused = false;
    let archiveContainer: Docker.Container | undefined;

    try {
      validateTenantName(name);
      if (!fs.existsSync(output)) fs.mkdirSync(output, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.resolve(output, `${name}_backup_${timestamp}`);
      fs.mkdirSync(backupPath, { recursive: true });

      // 1. Export MySQL Database via mysqldump inside the database container
      spinner.text = 'Dumping MySQL database...';
      const rootPassword = getRootPassword();
      const mysqlContainer = docker.getContainer(CONFIG.DB_CONTAINER);
      const dbName = CONFIG.getTenantDbName(name);

      // Fetch the helper image before pausing the publication so an uncached
      // image cannot turn a short snapshot into an extended outage.
      await pullImage(CONFIG.DEFAULT_BACKUP_IMAGE);

      // Pausing the tenant makes the database and its content volume a single
      // point-in-time snapshot. It is resumed in both success and failure paths.
      pausedContainer = await findTenantContainer(name);
      const tenantInfo = await pausedContainer.inspect();
      if (tenantInfo.State.Running) {
        await pausedContainer.pause();
        isPaused = true;
      }

      const exec = await mysqlContainer.exec({
        Cmd: ['mysqldump', '-u', 'root', `-p${rootPassword}`, dbName],
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ Detach: false });
      const dumpFilePath = path.join(backupPath, 'db.sql');
      const dumpFile = fs.createWriteStream(dumpFilePath);

      // Safe stream handling with demuxing, error capture, and completion awaiting
      await safeDemuxExecStream(mysqlContainer.modem, stream, dumpFile, async () => {
        const inspectRes = await exec.inspect();
        return inspectRes.ExitCode;
      });

      // Verify dump file integrity
      const dumpStats = fs.statSync(dumpFilePath);
      if (dumpStats.size === 0) {
        throw new Error('Database dump resulted in an empty file. Ensure the tenant database exists.');
      }

      // 2. Export Content Volume
      spinner.text = 'Archiving content volume...';
      const volumeName = CONFIG.getTenantVolumeName(name);

      // Check if volume exists; fallback to legacy naming if applicable
      const volumes = await docker.listVolumes();
      const targetVolume = volumes.Volumes.some((v) => v.Name === volumeName)
        ? volumeName
        : `ghost-content-${name}`;

      archiveContainer = await docker.createContainer({
        Image: CONFIG.DEFAULT_BACKUP_IMAGE,
        Cmd: ['tar', '-czf', '/backup/content.tar.gz', '-C', '/data', '.'],
        HostConfig: {
          Binds: [`${targetVolume}:/data:ro`, `${backupPath}:/backup`],
        },
      });

      await archiveContainer.start();
      const waitResult = await archiveContainer.wait();

      if (waitResult.StatusCode !== 0) {
        throw new Error(`Content volume archiving failed with exit code ${waitResult.StatusCode}`);
      }

      spinner.succeed(chalk.green(`Backup created at: ${backupPath}`));
    } catch (err: unknown) {
      reportFailure(spinner, 'Backup', err);
    } finally {
      if (archiveContainer) {
        try {
          await archiveContainer.remove({ force: true });
        } catch {
          // Best-effort cleanup of the short-lived archiver.
        }
      }
      if (pausedContainer && isPaused) {
        try {
          await pausedContainer.unpause();
        } catch {
          process.exitCode = 1;
          console.error(chalk.red('Backup warning: the tenant could not be resumed; inspect it with Docker immediately.'));
        }
      }
    }
  });

// -------------------------------------------------------------
// COMMAND: UPDATE (Recoverable restart image updates)
// -------------------------------------------------------------
program
  .command('update')
  .description('Update a site to a newer Ghost version with automatic rollback on failure')
  .requiredOption('-n, --name <name>', 'Tenant name')
  .requiredOption('-t, --to <version>', 'Target Ghost image tag (e.g. 6-alpine, 5-alpine)')
  .action(async (options) => {
    const { name, to: newVersion } = options;
    const spinner = ora(`Updating ${name} to ghost:${newVersion}...`).start();
    let oldContainer: Docker.Container | undefined;
    let oldContainerName: string | undefined;
    let rollbackName: string | undefined;
    let replacement: Docker.Container | undefined;

    try {
      validateTenantName(name);
      oldContainer = await findTenantContainer(name);
      const info = await oldContainer.inspect();
      const containerName = info.Name.replace(/^\//, '');
      oldContainerName = containerName;

      // Pull new image
      const imageTag =
        newVersion.includes(':') || newVersion.includes('/') ? newVersion : `ghost:${newVersion}`;
      spinner.text = `Pulling ${imageTag}...`;
      await pullImage(imageTag);

      // Docker cannot run two containers with the same name. Rename the old
      // container instead of deleting it so it can be restored if replacement
      // creation or startup fails.
      spinner.text = 'Creating recoverable container swap...';
      rollbackName = `${containerName}-rollback-${Date.now()}`;
      if (info.State.Running) await oldContainer.stop();
      await oldContainer.rename({ name: rollbackName });

      replacement = await docker.createContainer({
        Image: imageTag,
        name: containerName,
        Env: info.Config.Env,
        HostConfig: info.HostConfig,
        Labels: {
          ...info.Config.Labels,
          [CONFIG.LABELS.VERSION]: newVersion,
        },
      });

      await replacement.start();
      spinner.text = 'Waiting for the replacement to become healthy...';
      await waitForGhostReady(replacement);
      await oldContainer.remove();
      spinner.succeed(chalk.green(`Successfully updated ${name} to ${imageTag}!`));
    } catch (err: unknown) {
      // Roll back the old container whenever it still exists. This cannot be
      // zero-downtime because Docker names/routes are shared, but it avoids a
      // failed update permanently taking a publication offline.
      if (replacement) {
        try {
          const replacementInfo = await replacement.inspect();
          if (replacementInfo.State.Running) await replacement.stop();
          await replacement.remove();
        } catch {}
      }
      if (oldContainer && oldContainerName && rollbackName) {
        try {
          await oldContainer.rename({ name: oldContainerName });
          await oldContainer.start();
        } catch {
          console.error(chalk.red('Rollback failed; the previous container is retained under its rollback name.'));
        }
      }
      reportFailure(spinner, 'Update', err);
    }
  });

// -------------------------------------------------------------
// COMMAND: DELETE (Drops database and wipes volumes)
// -------------------------------------------------------------
program
  .command('delete')
  .description('Delete a Ghost CMS instance and purge data')
  .requiredOption('-n, --name <name>', 'Tenant name')
  .option('--keep-data', 'Retain MySQL database and storage volume')
  .action(async (options) => {
    const { name, keepData } = options;
    const spinner = ora(`Deleting ${name}...`).start();

    try {
      validateTenantName(name);
      try {
        const container = await findTenantContainer(name);
        const containerInfo = await container.inspect();
        if (containerInfo.State.Running) await container.stop();
        await container.remove();
      } catch (err: any) {
        if (err?.statusCode !== 404) throw err;
      }

      if (!keepData) {
        spinner.text = 'Dropping MySQL database...';
        const db = await getDbConnection();
        const dbName = CONFIG.getTenantDbName(name);
        const dbUser = CONFIG.getTenantDbUser(name);
        await db.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
        await db.query(`DROP USER IF EXISTS '${dbUser}'@'%';`);
        // Also cleanup legacy database/user if differently named
        if (dbName !== `ghost_${name}`) {
          await db.query(`DROP DATABASE IF EXISTS \`ghost_${name}\`;`);
          await db.query(`DROP USER IF EXISTS 'usr_${name}'@'%';`);
        }
        await db.end();

        spinner.text = 'Removing content volume...';
        const primaryVol = CONFIG.getTenantVolumeName(name);
        await removeVolumeIfPresent(primaryVol);
        await removeVolumeIfPresent(`ghost-content-${name}`);
      }

      spinner.succeed(chalk.green(`Site ${name} removed.`));
    } catch (err: unknown) {
      reportFailure(spinner, 'Deletion', err);
    }
  });

program.parse(process.argv);
