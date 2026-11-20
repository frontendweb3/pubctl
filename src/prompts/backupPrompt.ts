/**
 * Interactive Wizard for the `backup` Command
 *
 * Prompts the user for missing backup arguments:
 * - Target tenant name
 * - Output directory destination
 * - MySQL root password required for `mysqldump`
 */

import chalk from 'chalk';
import { CONFIG } from '../config.js';
import { validateTenantName } from '../validation.js';
import { askPassword, askText, isInteractive } from './prompt.js';
import type { BackupOptions, BackupStrictInput } from '../schemas/backup.js';

/**
 * Resolves full options for the `backup` command by interactively requesting
 * any missing tenant parameters.
 *
 * @param options Parsed command-line options
 * @returns Complete options object ready for strict validation
 */
export async function resolveBackupOptions(options: BackupOptions): Promise<BackupStrictInput> {
  let name = options.name;
  let output = options.output || CONFIG.DEFAULT_BACKUP_DIR;
  let password = options.mysqlRootPassword || process.env.MYSQL_ROOT_PASSWORD;

  if (isInteractive(options)) {
    console.log(chalk.bold.cyan('\n=== pubctl backup wizard ==='));

    if (!name) {
      while (!name) {
        const val = await askText('Tenant name to backup');
        try {
          validateTenantName(val);
          name = val;
        } catch (err: any) {
          console.log(chalk.yellow(`! ${err.message}`));
        }
      }
    }

    output = await askText('Destination backup directory', output);

    if (!password) {
      while (!password) {
        const inputPass = await askPassword('MySQL root password');
        if (inputPass) {
          password = inputPass;
        } else {
          console.log(chalk.yellow('! MySQL root password is required for database dump.'));
        }
      }
    }
  }

  return {
    ...options,
    name: name || '',
    output,
    mysqlRootPassword: password || '',
  };
}
