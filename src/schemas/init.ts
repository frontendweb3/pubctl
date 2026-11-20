/**
 * Zod Validation Schemas and Options for the `init` Command
 *
 * Defines command-line options, shorthand aliases, and strict runtime
 * validation schemas for initializing base Docker infrastructure (Traefik + MySQL).
 */

import { z } from 'zod';
import { defineOptions } from 'zodline';
import { APP_NAME } from '../config.js';
import { validateEmail } from '../validation.js';

/**
 * Permissive schema for parsing CLI arguments for the `init` command.
 * Allows optional email and MySQL password to support interactive prompt fallback.
 */
export const initOptionsSchema = z.object({
  name: z.string().default(APP_NAME).describe('Container prefix namespace'),
  email: z.string().optional().describe("Let's Encrypt email for automatic SSL"),
  mysqlRootPassword: z.string().optional().describe('MySQL root password (otherwise MYSQL_ROOT_PASSWORD is used)'),
  rotateMysqlRootPassword: z.boolean().default(false).describe('Rotate the existing root password using PUBCTL_NEW_ROOT_PASSWORD'),
  noInteractive: z.boolean().default(false).describe('Disable interactive prompts'),
  yes: z.boolean().default(false).describe('Skip confirmation prompts'),
});

/**
 * Parsed CLI options type for the `init` command.
 */
export type InitOptions = z.infer<typeof initOptionsSchema>;

/**
 * Single-character CLI flag aliases for the `init` command options.
 */
export const initAliases = {
  n: 'name',
  e: 'email',
  y: 'yes',
};

/**
 * Zodline options definition configuring flags and aliases for `init`.
 */
export const initOptions = defineOptions(initOptionsSchema, initAliases);

/**
 * Strict schema executed after interactive prompts to guarantee that all required
 * infrastructure parameters (namespace, SSL email, and MySQL root password) are valid.
 */
export const initStrictSchema = z.object({
  name: z.string().min(1, 'Namespace name cannot be empty'),
  email: z.string().min(1, 'Email is required').refine((val) => {
    try {
      validateEmail(val);
      return true;
    } catch {
      return false;
    }
  }, { message: "Admin email must be a valid email address." }),
  mysqlRootPassword: z.string().min(1, 'MySQL root password is required'),
  rotateMysqlRootPassword: z.boolean().default(false),
  noInteractive: z.boolean().default(false),
  yes: z.boolean().default(false),
});

/**
 * Validated input type containing guaranteed values for base infrastructure setup.
 */
export type InitStrictInput = z.infer<typeof initStrictSchema>;
