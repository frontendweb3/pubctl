/**
 * Zod Validation Schemas and Options for the `delete` Command
 *
 * Defines CLI option flags, single-character aliases, and strict runtime
 * validation rules for tearing down Ghost tenant containers, associated storage
 * volumes, and MySQL databases.
 */

import { z } from 'zod';
import { defineOptions } from 'zodline';
import { validateTenantName } from '../validation.js';

/**
 * Permissive schema for parsing CLI arguments for the `delete` command.
 * Allows tenant name and credentials to be provided via interactive prompt.
 */
export const deleteOptionsSchema = z.object({
  name: z.string().optional().describe('Tenant name'),
  keepData: z.boolean().default(false).describe('Retain MySQL database and storage volume'),
  mysqlRootPassword: z.string().optional().describe('MySQL root password (otherwise MYSQL_ROOT_PASSWORD is used)'),
  noInteractive: z.boolean().default(false).describe('Disable interactive prompts'),
  yes: z.boolean().default(false).describe('Skip deletion confirmation prompt'),
});

/**
 * Parsed CLI options type for the `delete` command.
 */
export type DeleteOptions = z.infer<typeof deleteOptionsSchema>;

/**
 * Single-character CLI flag aliases for the `delete` command options.
 */
export const deleteAliases = {
  n: 'name',
  y: 'yes',
};

/**
 * Zodline options definition configuring flags and aliases for `delete`.
 */
export const deleteOptions = defineOptions(deleteOptionsSchema, deleteAliases);

/**
 * Strict schema executed after interactive prompts to validate deletion requirements.
 * Enforces that MySQL root password is required if tenant data/database is not retained (`--keep-data` is false).
 */
export const deleteStrictSchema = z.object({
  name: z.string().min(1, 'Tenant name is required').refine((val) => {
    try {
      validateTenantName(val);
      return true;
    } catch {
      return false;
    }
  }, { message: 'Tenant name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (max 31 characters).' }),
  keepData: z.boolean().default(false),
  mysqlRootPassword: z.string().optional(),
  noInteractive: z.boolean().default(false),
  yes: z.boolean().default(false),
}).superRefine((data, ctx) => {
  if (!data.keepData && !data.mysqlRootPassword) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'MySQL root password is required to drop database when deleting tenant data',
      path: ['mysqlRootPassword'],
    });
  }
});

/**
 * Validated input type containing guaranteed options for tenant deletion.
 */
export type DeleteStrictInput = z.infer<typeof deleteStrictSchema>;
