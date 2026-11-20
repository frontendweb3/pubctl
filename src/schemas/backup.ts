/**
 * Zod Validation Schemas and Options for the `backup` Command
 *
 * Defines CLI option flags, single-character aliases, and strict runtime
 * validation schemas for backing up a Ghost tenant's MySQL database and content files.
 */

import { z } from 'zod';
import { defineOptions } from 'zodline';
import { CONFIG } from '../config.js';
import { validateTenantName } from '../validation.js';

/**
 * Permissive schema for parsing CLI arguments for the `backup` command.
 * Leaves tenant name and MySQL password optional so interactive prompts can ask for them.
 */
export const backupOptionsSchema = z.object({
  name: z.string().optional().describe('Tenant name'),
  output: z.string().default(CONFIG.DEFAULT_BACKUP_DIR).describe('Destination directory'),
  mysqlRootPassword: z.string().optional().describe('MySQL root password (otherwise MYSQL_ROOT_PASSWORD is used)'),
  noInteractive: z.boolean().default(false).describe('Disable interactive prompts'),
  yes: z.boolean().default(false).describe('Skip confirmation prompts'),
});

/**
 * Parsed CLI options type for the `backup` command.
 */
export type BackupOptions = z.infer<typeof backupOptionsSchema>;

/**
 * Single-character CLI flag aliases for the `backup` command options.
 */
export const backupAliases = {
  n: 'name',
  o: 'output',
  y: 'yes',
};

/**
 * Zodline options definition configuring flags and aliases for `backup`.
 */
export const backupOptions = defineOptions(backupOptionsSchema, backupAliases);

/**
 * Strict schema executed after interactive prompts to guarantee all required
 * backup parameters (valid tenant name, output directory, and MySQL password) are provided.
 */
export const backupStrictSchema = z.object({
  name: z.string().min(1, 'Tenant name is required').refine((val) => {
    try {
      validateTenantName(val);
      return true;
    } catch {
      return false;
    }
  }, { message: 'Tenant name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (max 31 characters).' }),
  output: z.string().min(1, 'Output directory is required').default(CONFIG.DEFAULT_BACKUP_DIR),
  mysqlRootPassword: z.string().min(1, 'MySQL root password is required'),
  noInteractive: z.boolean().default(false),
  yes: z.boolean().default(false),
});

/**
 * Validated input type containing guaranteed options for tenant backup operations.
 */
export type BackupStrictInput = z.infer<typeof backupStrictSchema>;
