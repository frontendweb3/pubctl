#!/usr/bin/env node
/**
 * =============================================================================
 * pubctl - Zero-Configuration Multi-Tenant CLI & Docker Orchestrator for Ghost
 * =============================================================================
 *
 * Runtime & Compilation Compatibility:
 * ------------------------------------
 * - Bundled Node.js CLI powered by zodline + zod.
 * - Bundled into a single, self-contained JavaScript executable via:
 *   `bun build src/index.ts --target=node --outfile=dist/index.js --minify --external cpu-features`
 *   with zero runtime subdependencies.
 *
 * Architecture & Features:
 * ------------------------
 * - Modular architecture: `src/schemas`, `src/prompts`, `src/commands`, `src/lib`.
 * - Interactive wizards with skip/default capability for all commands.
 * - Local development mode (`--local`, `-l`) with live Handlebars theme reload.
 * - Flexible flag normalization supporting snake_case, camelCase, and kebab-case.
 * =============================================================================
 */

import { defineConfig, processConfig, ZodlineError } from 'zodline';
import { z } from 'zod';
import chalk from 'chalk';
import { APP_NAME } from './config.js';
import { commands } from './commands/index.js';
import pkg from '../package.json' with { type: 'json' };

const { version } = pkg;

/**
 * Top-level Zodline configuration registering CLI metadata and all modular subcommands.
 */
export const config = defineConfig({
  meta: {
    name: APP_NAME,
    version,
    description: 'Deploy, manage, and update Ghost blogs on Docker with zero configuration',
  },
  commands,
});

/**
 * Normalizes command-line arguments before passing them to Zodline.
 * Converts snake_case flags (e.g. `--mysql_root_password`, `--admin_email`) and
 * uppercase flags (e.g. `--MYSQL_ROOT_PASSWORD`) to standard kebab-case.
 *
 * @param argv Raw argument array (defaults to `process.argv.slice(2)`)
 * @returns Normalized argument array
 */
export function normalizeArgv(argv: string[]): string[] {
  return argv.map((arg) => {
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex !== -1) {
        const flag = arg.slice(0, eqIndex);
        const val = arg.slice(eqIndex);
        if (flag.includes('_') || (flag === flag.toUpperCase() && flag !== '--')) {
          return `${flag.toLowerCase().replace(/_/g, '-')}${val}`;
        }
        return arg;
      }
      if (arg.includes('_') || (arg === arg.toUpperCase() && arg !== '--')) {
        return arg.toLowerCase().replace(/_/g, '-');
      }
      return arg;
    }
    return arg;
  });
}

/**
 * Main CLI execution entry point.
 * Normalizes arguments, handles `--version` and empty invocation help display,
 * executes Zodline parsing and command actions, and prints structured errors.
 *
 * @param rawArgv CLI argument array to process
 */
export async function runCli(rawArgv = process.argv.slice(2)): Promise<void> {
  const argv = normalizeArgv(rawArgv);

  // If no arguments provided, display help and exit
  if (argv.length === 0) {
    try {
      processConfig(config, ['--help']);
    } catch {
      // processConfig --help exits with 0
    }
    process.exit(0);
  }

  // Handle root-level version flags: -v, -V, --version
  if (argv.length === 1 && (argv[0] === '-v' || argv[0] === '-V' || argv[0] === '--version')) {
    console.log(version);
    process.exit(0);
  }

  try {
    const result = processConfig(config, argv);
    if (result.command?.action) {
      await result.command.action(result.options, result.args);
    }
  } catch (error) {
    if (error instanceof ZodlineError) {
      console.error(chalk.red(`Error: ${error.message}`));
      console.error(chalk.gray('(run with --help for available commands and options)'));
      process.exit(2);
    }

    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        console.error(chalk.red(`Error [${issue.path.join('.')}]: ${issue.message}`));
      }
      process.exit(2);
    }

    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

/**
 * Entry-script detection to prevent executing the CLI when running under test harnesses.
 */
const isEntryScript = Boolean(
  process.argv[1] &&
  !process.argv[1].includes('test') &&
  (
    process.argv[1].endsWith('src/index.ts') ||
    process.argv[1].endsWith('dist/index.js') ||
    process.argv[1].endsWith('pubctl')
  )
);

if (isEntryScript) {
  runCli();
}
