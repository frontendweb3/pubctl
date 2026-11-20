/**
 * Interactive Wizard for the `delete` Command
 *
 * Prompts the user before tearing down a Ghost CMS tenant:
 * - Identifies target tenant name
 * - Confirms whether to retain or drop MySQL database and content volume
 * - Requests MySQL root password if dropping database
 * - Enforces explicit user confirmation before executing destructive deletion
 */

import chalk from 'chalk';
import { validateTenantName } from '../validation.js';
import { askConfirm, askPassword, askText, isInteractive } from './prompt.js';
import type { DeleteOptions, DeleteStrictInput } from '../schemas/delete.js';

/**
 * Resolves full options for the `delete` command by interactively confirming
 * deletion scope and obtaining necessary credentials.
 *
 * @param options Parsed command-line options
 * @returns Complete options object ready for strict validation
 * @throws Error if the user explicitly cancels confirmation
 */
export async function resolveDeleteOptions(options: DeleteOptions): Promise<DeleteStrictInput> {
  let name = options.name;
  let keepData = options.keepData ?? false;
  let password = options.mysqlRootPassword || process.env.MYSQL_ROOT_PASSWORD;
  let yes = options.yes ?? false;

  if (isInteractive(options)) {
    console.log(chalk.bold.red('\n=== pubctl delete site wizard ==='));

    if (!name) {
      while (!name) {
        const val = await askText('Tenant name to delete');
        try {
          validateTenantName(val);
          name = val;
        } catch (err: any) {
          console.log(chalk.yellow(`! ${err.message}`));
        }
      }
    }

    if (!options.keepData) {
      keepData = await askConfirm('Retain MySQL database and storage volume?', false);
    }

    if (!keepData && !password) {
      while (!password) {
        const inputPass = await askPassword('MySQL root password (required to drop database)');
        if (inputPass) {
          password = inputPass;
        } else {
          console.log(chalk.yellow('! MySQL root password is required to drop the database.'));
        }
      }
    }

    if (!yes) {
      const confirmed = await askConfirm(`Are you sure you want to delete tenant '${name}'?`, false);
      if (!confirmed) {
        throw new Error('Deletion cancelled by user.');
      }
      yes = true;
    }
  }

  return {
    ...options,
    name: name || '',
    keepData,
    mysqlRootPassword: password,
    yes,
  };
}
