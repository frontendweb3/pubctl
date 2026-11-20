/**
 * Ghost CMS Tenant Backup Command (`backup`)
 *
 * Performs consistent point-in-time backups of a Ghost tenant:
 * 1. Safely pauses the tenant container to ensure database and filesystem consistency.
 * 2. Streams an isolated MySQL database dump via `mysqldump` directly to `db.sql`.
 * 3. Spins up an ephemeral backup helper container to compress the content volume into `content.tar.gz`.
 * 4. Resumes the tenant container and cleans up temporary container resources.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import type Docker from 'dockerode';
import { defineCommand } from 'zodline';
import { CONFIG } from '../config.js';
import {
  docker,
  findTenantContainer,
  getRootPassword,
  pullImage,
  reportFailure,
  safeDemuxExecStream,
} from '../lib/docker.js';
import { resolveBackupOptions } from '../prompts/backupPrompt.js';
import { backupOptions, backupStrictSchema, type BackupOptions } from '../schemas/backup.js';

/**
 * Zodline command definition for `pubctl backup`.
 */
export const backupCommand = defineCommand({
  description: 'Create a point-in-time backup of MySQL data and uploads',
  options: backupOptions,
  action: async (options: BackupOptions) => {
    let resolved;
    try {
      resolved = await resolveBackupOptions(options);
    } catch (err: unknown) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
      return;
    }

    const validated = backupStrictSchema.parse(resolved);
    const { name, output } = validated;
    process.env.MYSQL_ROOT_PASSWORD = validated.mysqlRootPassword;

    const spinner = ora(`Backing up ${name}...`).start();
    let pausedContainer: Docker.Container | undefined;
    let isPaused = false;
    let archiveContainer: Docker.Container | undefined;

    try {
      if (!fs.existsSync(output)) fs.mkdirSync(output, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.resolve(output, `${name}_backup_${timestamp}`);
      fs.mkdirSync(backupPath, { recursive: true });

      // 1. Export MySQL Database via mysqldump inside the database container
      spinner.text = 'Dumping MySQL database...';
      const rootPassword = getRootPassword();
      const mysqlContainer = docker.getContainer(CONFIG.DB_CONTAINER);
      const dbName = CONFIG.getTenantDbName(name);

      await pullImage(CONFIG.DEFAULT_BACKUP_IMAGE);

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

      await safeDemuxExecStream(mysqlContainer.modem, stream, dumpFile, async () => {
        const inspectRes = await exec.inspect();
        return inspectRes.ExitCode;
      });

      const dumpStats = fs.statSync(dumpFilePath);
      if (dumpStats.size === 0) {
        throw new Error('Database dump resulted in an empty file. Ensure the tenant database exists.');
      }

      // 2. Export Content Volume
      spinner.text = 'Archiving content volume...';
      const volumeName = CONFIG.getTenantVolumeName(name);

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
          // Best-effort cleanup
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
  },
});
