/**
 * Zod Validation Schemas and Options for the `update` Command
 *
 * Defines CLI option flags, single-character aliases, and strict runtime
 * validation schemas for upgrading or rolling back a Ghost CMS tenant container.
 */

import { z } from 'zod';
import { defineOptions } from 'zodline';
import { validateTenantName } from '../validation.js';

/**
 * Permissive schema for parsing CLI arguments for the `update` command.
 * Allows tenant name and target version to be omitted for interactive prompt fallback.
 */
export const updateOptionsSchema = z.object({
  name: z.string().optional().describe('Tenant name'),
  to: z.string().optional().describe('Target Ghost image tag (e.g. 6-alpine, 5-alpine)'),
  noInteractive: z.boolean().default(false).describe('Disable interactive prompts'),
  yes: z.boolean().default(false).describe('Skip confirmation prompts'),
});

/**
 * Parsed CLI options type for the `update` command.
 */
export type UpdateOptions = z.infer<typeof updateOptionsSchema>;

/**
 * Single-character CLI flag aliases for the `update` command options.
 */
export const updateAliases = {
  n: 'name',
  t: 'to',
  y: 'yes',
};

/**
 * Zodline options definition configuring flags and aliases for `update`.
 */
export const updateOptions = defineOptions(updateOptionsSchema, updateAliases);

/**
 * Strict schema executed after interactive prompts to guarantee all required
 * update parameters (valid tenant name and target Ghost version) are present.
 */
export const updateStrictSchema = z.object({
  name: z.string().min(1, 'Tenant name is required').refine((val) => {
    try {
      validateTenantName(val);
      return true;
    } catch {
      return false;
    }
  }, { message: 'Tenant name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (max 31 characters).' }),
  to: z.string().min(1, 'Target Ghost version is required'),
  noInteractive: z.boolean().default(false),
  yes: z.boolean().default(false),
});

/**
 * Validated input type containing guaranteed options for tenant upgrade operations.
 */
export type UpdateStrictInput = z.infer<typeof updateStrictSchema>;
