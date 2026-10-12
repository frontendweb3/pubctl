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

const docker = new Docker({ socketPath: CONFIG.DOCKER_SOCKET_PATH });
const program = new Command();

program
  .name(APP_NAME)
  .description('Deploy, manage, and update Ghost blogs on Docker with zero configuration')
  .version('1.0.0');

// -------------------------------------------------------------
// Database Helper with Connection Retry
// -------------------------------------------------------------
async function getDbConnection(retries = 5, delayMs = 1500) {
  const rootPassword = process.env.MYSQL_ROOT_PASSWORD || CONFIG.DEFAULT_DB_ROOT_PASSWORD;
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
  .action(async (options) => {
    const spinner = ora('Setting up base infrastructure...').start();
    try {
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
        await docker.pull(CONFIG.DEFAULT_MYSQL_IMAGE);
        const rootPassword = process.env.MYSQL_ROOT_PASSWORD || CONFIG.DEFAULT_DB_ROOT_PASSWORD;
        const mysqlContainer = await docker.createContainer({
          Image: CONFIG.DEFAULT_MYSQL_IMAGE,
          name: CONFIG.DB_CONTAINER,
          Env: [`MYSQL_ROOT_PASSWORD=${rootPassword}`],
          HostConfig: {
            RestartPolicy: { Name: 'always' },
            Binds: [`${CONFIG.DB_VOLUME}:/var/lib/mysql`],
            PortBindings: {
              [`${CONFIG.DEFAULT_DB_PORT}/tcp`]: [{ HostPort: `${CONFIG.DEFAULT_DB_PORT}` }],
            },
            NetworkMode: CONFIG.NETWORK_NAME,
          },
          Labels: {
            [CONFIG.LABELS.MANAGED_BY]: APP_NAME,
          },
        });
        await mysqlContainer.start();
      }

      // 3. Start Traefik (Auto SSL)
      const traefikExists = containers.some((c) => c.Names.includes(`/${CONFIG.PROXY_CONTAINER}`));
      if (!traefikExists) {
        spinner.text = `Configuring Traefik (${CONFIG.DEFAULT_TRAEFIK_IMAGE}) with automatic Let's Encrypt...`;
        await docker.pull(CONFIG.DEFAULT_TRAEFIK_IMAGE);
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
      }

      spinner.succeed(chalk.green('Base infrastructure is running with automated SSL support!'));
    } catch (err: any) {
      spinner.fail(chalk.red(`Init failed: ${err.message}`));
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

    try {
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

      const dbName = CONFIG.getTenantDbName(name);
      const dbUser = CONFIG.getTenantDbUser(name);
      const dbPassword = crypto.randomBytes(16).toString('hex');
      const generatedAdminPassword =
        crypto.randomBytes(10).toString('base64').replace(/[^a-zA-Z0-9]/g, 'a') + 'A1!';

      // 2. MySQL Database Creation
      spinner.text = 'Creating isolated database...';
      const db = await getDbConnection();
      await db.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
      await db.query(`CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}';`);
      await db.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%';`);
      await db.query(`FLUSH PRIVILEGES;`);
      await db.end();

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
      await docker.pull(imageTag);

      const containerName = CONFIG.getTenantContainerName(name);
      const volumeName = CONFIG.getTenantVolumeName(name);

      const container = await docker.createContainer({
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
            const res = await fetch(`http://${internalIp}:2368/ghost/api/admin/authentication/setup/`, {
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
            });
            if (res.ok) {
              setupSuccess = true;
              break;
            }
          } catch {
            // Ghost is still performing Knex database migrations; keep polling
          }
        }
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

      if (!setupSuccess) {
        console.log(
          chalk.yellow(
            '\nNote: Automatic login injection timed out. Please visit https://' +
              domain +
              '/ghost/#/setup to finish setting your password.'
          )
        );
      }
    } catch (err: any) {
      spinner.fail(chalk.red(`Creation failed: ${err.message}`));
    }
  });

// -------------------------------------------------------------
// COMMAND: BACKUP (Creates atomic zip of database + content)
// -------------------------------------------------------------
program
  .command('backup')
  .description('Create an atomic backup of MySQL data and uploads')
  .requiredOption('-n, --name <name>', 'Tenant name')
  .option('-o, --output <dir>', 'Destination directory', CONFIG.DEFAULT_BACKUP_DIR)
  .action(async (options) => {
    const { name, output } = options;
    const spinner = ora(`Backing up ${name}...`).start();

    try {
      if (!fs.existsSync(output)) fs.mkdirSync(output, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.resolve(output, `${name}_backup_${timestamp}`);
      fs.mkdirSync(backupPath, { recursive: true });

      // 1. Export MySQL Database via mysqldump inside the database container
      spinner.text = 'Dumping MySQL database...';
      const rootPassword = process.env.MYSQL_ROOT_PASSWORD || CONFIG.DEFAULT_DB_ROOT_PASSWORD;
      const mysqlContainer = docker.getContainer(CONFIG.DB_CONTAINER);
      const dbName = CONFIG.getTenantDbName(name);

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

      const archiveContainer = await docker.createContainer({
        Image: CONFIG.DEFAULT_BACKUP_IMAGE,
        Cmd: ['tar', '-czf', '/backup/content.tar.gz', '-C', '/data', '.'],
        HostConfig: {
          Binds: [`${targetVolume}:/data:ro`, `${backupPath}:/backup`],
        },
      });

      await archiveContainer.start();
      const waitResult = await archiveContainer.wait();
      await archiveContainer.remove();

      if (waitResult.StatusCode !== 0) {
        throw new Error(`Content volume archiving failed with exit code ${waitResult.StatusCode}`);
      }

      spinner.succeed(chalk.green(`Backup created at: ${backupPath}`));
    } catch (err: any) {
      spinner.fail(chalk.red(`Backup failed: ${err.message}`));
    }
  });

// -------------------------------------------------------------
// COMMAND: UPDATE (Safe rolling image updates)
// -------------------------------------------------------------
program
  .command('update')
  .description('Update a site to a newer Ghost version')
  .requiredOption('-n, --name <name>', 'Tenant name')
  .requiredOption('-t, --to <version>', 'Target Ghost image tag (e.g. 6-alpine, 5-alpine)')
  .action(async (options) => {
    const { name, to: newVersion } = options;
    const spinner = ora(`Updating ${name} to ghost:${newVersion}...`).start();

    try {
      const oldContainer = await findTenantContainer(name);
      const info = await oldContainer.inspect();
      const containerName = info.Name.replace(/^\//, '');

      // Pull new image
      const imageTag =
        newVersion.includes(':') || newVersion.includes('/') ? newVersion : `ghost:${newVersion}`;
      spinner.text = `Pulling ${imageTag}...`;
      await docker.pull(imageTag);

      // Stop & remove old container (Volume and DB remain intact)
      spinner.text = 'Swapping container...';
      await oldContainer.stop();
      await oldContainer.remove();

      const newContainer = await docker.createContainer({
        Image: imageTag,
        name: containerName,
        Env: info.Config.Env,
        HostConfig: info.HostConfig,
        Labels: {
          ...info.Config.Labels,
          [CONFIG.LABELS.VERSION]: newVersion,
        },
      });

      await newContainer.start();
      spinner.succeed(chalk.green(`Successfully updated ${name} to ${imageTag}!`));
    } catch (err: any) {
      spinner.fail(chalk.red(`Update failed: ${err.message}`));
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
      try {
        const container = await findTenantContainer(name);
        await container.stop();
        await container.remove();
      } catch {
        // Container might already be stopped/deleted
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
        try {
          const volume = docker.getVolume(primaryVol);
          await volume.remove();
        } catch {
          try {
            const legacyVol = docker.getVolume(`ghost-content-${name}`);
            await legacyVol.remove();
          } catch {}
        }
      }

      spinner.succeed(chalk.green(`Site ${name} removed.`));
    } catch (err: any) {
      spinner.fail(chalk.red(`Deletion failed: ${err.message}`));
    }
  });

program.parse(process.argv);