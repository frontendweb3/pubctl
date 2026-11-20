/**
 * Interactive Wizard for the `update` Command
 *
 * Prompts the user for missing update arguments:
 * - Target tenant name to upgrade or downgrade
 * - Destination Ghost Docker image tag (e.g. 5-alpine, 6-alpine)
 */

import chalk from 'chalk';
import { validateTenantName } from '../validation.js';
import { askText, isInteractive } from './prompt.js';
import type { UpdateOptions, UpdateStrictInput } from '../schemas/update.js';

/**
 * Resolves full options for the `update` command by interactively requesting
 * the tenant name and target Ghost image version if missing.
 *
 * @param options Parsed command-line options
 * @returns Complete options object ready for strict validation
 */
export async function resolveUpdateOptions(options: UpdateOptions): Promise<UpdateStrictInput> {
  let name = options.name;
  let to = options.to;

  if (isInteractive(options)) {
    console.log(chalk.bold.cyan('\n=== pubctl update site wizard ==='));

    if (!name) {
      while (!name) {
        const val = await askText('Tenant name to update');
        try {
          validateTenantName(val);
          name = val;
        } catch (err: any) {
          console.log(chalk.yellow(`! ${err.message}`));
        }
      }
    }

    if (!to) {
      to = await askText('Target Ghost version or image tag (e.g. 5-alpine, 6-alpine)', '5-alpine');
    }
  }

  return {
    ...options,
    name: name || '',
    to: to || '',
  };
}
