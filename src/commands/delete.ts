/**
 * Ghost CMS Tenant Teardown Command (`delete`)
 *
 * Removes a Ghost CMS tenant container and optionally purges persistent storage:
 * 1. Stops and removes the tenant container (supporting modern and legacy naming schemes).
 * 2. If `--keep-data` is false, connects to MySQL to drop the tenant database and user.
 * 3. Removes the persistent Docker content volume.
 */

import chalk from 'chalk';
import ora from 'ora';
import { defineCommand } from 'zodline';
import { CONFIG } from '../config.js';
import {
  docker,
  findTenantContainer,
  getDbConnection,
  removeVolumeIfPresent,
  reportFailure,
} from '../lib/docker.js';
import { resolveDeleteOptions } from '../prompts/deletePrompt.js';
import { deleteOptions, deleteStrictSchema, type DeleteOptions } from '../schemas/delete.js';

/**
 * Zodline command definition for `pubctl delete`.
 */
export const deleteCommand = defineCommand({
  description: 'Delete a Ghost CMS instance and purge data',
  options: deleteOptions,
  action: async (options: DeleteOptions) => {
    let resolved;
    try {
      resolved = await resolveDeleteOptions(options);
    } catch (err: unknown) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
      return;
    }

    const validated = deleteStrictSchema.parse(resolved);
    const { name, keepData } = validated;
    if (validated.mysqlRootPassword) {
      process.env.MYSQL_ROOT_PASSWORD = validated.mysqlRootPassword;
    }

    const spinner = ora(`Deleting ${name}...`).start();

    try {
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
  },
});
