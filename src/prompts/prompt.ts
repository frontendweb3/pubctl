/**
 * Interactive Terminal Prompt Utilities
 *
 * Lightweight readline-based prompting primitives with zero external runtime dependencies.
 * Supports text input with defaults/skipping, masked password entry, confirmations, and selections.
 */

import readline from 'readline';
import readlinePromises from 'readline/promises';
import { Writable } from 'stream';
import chalk from 'chalk';

/**
 * Determines whether the CLI should run in interactive wizard mode.
 *
 * @param options Object containing `--no-interactive` or `--yes` flags
 * @returns `true` if stdin is a TTY and non-interactive flags were not provided
 */
export function isInteractive(options: { noInteractive?: boolean; yes?: boolean }): boolean {
  if (options.noInteractive || options.yes) return false;
  return Boolean(process.stdin.isTTY);
}

/**
 * Prompts the user for a text string, displaying the default value and allowing Enter to skip.
 *
 * @param promptText The question or prompt label to display
 * @param defaultValue Fallback value if user presses Enter without typing
 * @returns The user's trimmed input or the default value
 */
export async function askText(promptText: string, defaultValue = ''): Promise<string> {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const formattedPrompt = defaultValue
      ? `${chalk.cyan('?')} ${promptText} ${chalk.gray(`(default: ${defaultValue}, press Enter to skip)`)}: `
      : `${chalk.cyan('?')} ${promptText}: `;
    const answer = await rl.question(formattedPrompt);
    return answer.trim() || defaultValue;
  } finally {
    rl.close();
  }
}

/**
 * Prompts the user for sensitive input (e.g. passwords) with output masking/muting.
 *
 * @param promptText The password question to display
 * @param defaultValue Optional fallback value if empty
 * @returns The entered password or default value
 */
export async function askPassword(promptText: string, defaultValue = ''): Promise<string> {
  const mutableStdout = new Writable({
    write(chunk, encoding, callback) {
      if (!(this as any).muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    },
  });
  (mutableStdout as any).muted = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true,
  });

  try {
    return await new Promise<string>((resolve) => {
      const formattedPrompt = `${chalk.cyan('?')} ${promptText} ${chalk.gray('(hidden, press Enter to auto-generate)')}: `;
      rl.question(formattedPrompt, (answer) => {
        console.log('');
        resolve(answer.trim() || defaultValue);
      });
      (mutableStdout as any).muted = true;
    });
  } finally {
    rl.close();
  }
}

/**
 * Prompts the user for a boolean confirmation (yes/no).
 *
 * @param promptText The confirmation prompt message
 * @param defaultYes Whether Enter defaults to true (yes) or false (no)
 * @returns True if confirmed, false otherwise
 */
export async function askConfirm(promptText: string, defaultYes = false): Promise<boolean> {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = await rl.question(`${chalk.cyan('?')} ${promptText} ${chalk.gray(hint)}: `);
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) return defaultYes;
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Prompts the user to select from a list of options.
 *
 * @param promptText The selection prompt message
 * @param choices List of valid choices
 * @param defaultChoice The default choice if Enter is pressed
 * @returns The selected option
 */
export async function askSelect(promptText: string, choices: string[], defaultChoice = choices[0]): Promise<string> {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = choices.map((c) => (c === defaultChoice ? chalk.bold.green(c) : c)).join(' / ');
    const answer = await rl.question(`${chalk.cyan('?')} ${promptText} (${hint}) ${chalk.gray(`[default: ${defaultChoice}]`)}: `);
    const trimmed = answer.trim();
    if (!trimmed) return defaultChoice;
    const match = choices.find((c) => c.toLowerCase() === trimmed.toLowerCase());
    return match || defaultChoice;
  } finally {
    rl.close();
  }
}
