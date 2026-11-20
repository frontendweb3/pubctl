/**
 * Interactive Wizard for the `init` Command
 *
 * Prompts the user for missing base infrastructure configurations:
 * container namespace prefix, Let's Encrypt email, and MySQL root password.
 * Generates a secure random password if left empty in interactive mode.
 */

import crypto from 'crypto';
import chalk from 'chalk';
import { APP_NAME } from '../config.js';
import { validateEmail } from '../validation.js';
import { askPassword, askText, isInteractive } from './prompt.js';
import type { InitOptions, InitStrictInput } from '../schemas/init.js';

/**
 * Resolves full options for the `init` command by combining CLI flags,
 * environment variables, and interactive prompts.
 *
 * @param options Parsed command-line options
 * @returns Complete options object ready for strict validation
 */
export async function resolveInitOptions(options: InitOptions): Promise<InitStrictInput> {
  let name = options.name || APP_NAME;
  let email = options.email;
  let password = options.mysqlRootPassword || process.env.MYSQL_ROOT_PASSWORD;

  if (isInteractive(options)) {
    console.log(chalk.bold.cyan('\n=== pubctl init setup wizard ==='));

    name = await askText('Container namespace / prefix', name);

    if (!email) {
      while (!email) {
        const inputEmail = await askText("Let's Encrypt email for SSL certificates");
        try {
          validateEmail(inputEmail);
          email = inputEmail;
        } catch (err: any) {
          console.log(chalk.yellow(`! ${err.message}`));
        }
      }
    }

    if (!password && !options.rotateMysqlRootPassword) {
      const inputPass = await askPassword('MySQL root password');
      if (inputPass) {
        password = inputPass;
      } else {
        password = crypto.randomBytes(12).toString('hex') + 'A1!';
        console.log(chalk.green(`✓ Auto-generated MySQL root password: ${chalk.bold.yellow(password)}`));
        console.log(chalk.gray(`  (Save this password or run: export MYSQL_ROOT_PASSWORD="${password}")\n`));
      }
    }
  }

  return {
    ...options,
    name,
    email: email || '',
    mysqlRootPassword: password || '',
  };
}
