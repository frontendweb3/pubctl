/**
 * Zod Validation Schemas and Options for the `create` Command
 *
 * Defines CLI option flags, single-character aliases, and strict runtime
 * validation rules for deploying a new Ghost CMS tenant, including support
 * for local theme development, host directory mounting, S3 storage, and SMTP.
 */

import fs from 'fs';
import { z } from 'zod';
import { defineOptions } from 'zodline';
import { CONFIG } from '../config.js';
import { validateDomain, validateEmail, validateTenantName } from '../validation.js';

/**
 * Permissive schema for parsing CLI arguments for the `create` command.
 * Leaves required tenant parameters optional to allow interactive prompts to fill them.
 */
export const createOptionsSchema = z.object({
  name: z.string().optional().describe('Unique tenant name (e.g., techblog)'),
  domain: z.string().optional().describe('Domain or subdomain (e.g., blog.example.com or techblog.localhost)'),
  adminEmail: z.string().optional().describe('Admin email address for Ghost'),
  title: z.string().default('My Ghost Publication').describe('Blog title'),
  version: z.string().default(CONFIG.DEFAULT_GHOST_VERSION).describe('Ghost image version or custom tag (e.g., 5-alpine)'),
  mysqlRootPassword: z.string().optional().describe('MySQL root password (otherwise MYSQL_ROOT_PASSWORD is used)'),
  local: z.boolean().default(false).describe('Run in local development mode for theme development (HTTP on *.localhost with live reload)'),
  themeDir: z.string().optional().describe('Path to local theme directory on host to mount for live theme development'),
  port: z.string().optional().describe('Direct host port to bind for Ghost (e.g. 2368)'),
  storage: z.enum(['local', 's3']).default('local').describe('Storage adapter type (local | s3)'),
  s3Bucket: z.string().optional().describe('S3/R2 storage bucket name'),
  s3Key: z.string().optional().describe('S3/R2 Access Key ID'),
  s3Secret: z.string().optional().describe('S3/R2 Secret Access Key'),
  s3Endpoint: z.string().optional().describe('Custom S3 endpoint URL (e.g., https://<account_id>.r2.cloudflarestorage.com)'),
  s3AssetHost: z.string().optional().describe('Public CDN or custom domain for media URLs'),
  s3Region: z.string().default(CONFIG.DEFAULT_S3_REGION).describe('S3 region (e.g., auto, us-east-1)'),
  s3ForcePathStyle: z.boolean().default(false).describe('Force path-style URLs for MinIO / self-hosted S3'),
  smtpHost: z.string().optional().describe('SMTP host for transactional emails'),
  smtpUser: z.string().optional().describe('SMTP username'),
  smtpPass: z.string().optional().describe('SMTP password'),
  noInteractive: z.boolean().default(false).describe('Disable interactive prompts'),
  yes: z.boolean().default(false).describe('Skip confirmation prompts'),
});

/**
 * Parsed CLI options type for the `create` command.
 */
export type CreateOptions = z.infer<typeof createOptionsSchema>;

/**
 * Shorthand CLI flag aliases for common `create` command options.
 */
export const createAliases = {
  n: 'name',
  d: 'domain',
  e: 'adminEmail',
  t: 'title',
  v: 'version',
  l: 'local',
  y: 'yes',
};

/**
 * Zodline options definition configuring flags and aliases for `create`.
 */
export const createOptions = defineOptions(createOptionsSchema, createAliases);

/**
 * Strict schema executed after interactive prompts to validate tenant configuration.
 * Performs deep semantic checks using `.superRefine()`:
 * - Tenant name format (regex compliant with MySQL database naming)
 * - Domain structure (standard FQDN or .localhost for local dev)
 * - Admin email address RFC compliance
 * - Host theme directory existence and type check
 * - Complete credential sets when S3 or SMTP configurations are selected
 */
export const createStrictSchema = z
  .object({
    name: z.string().min(1, 'Tenant name is required').refine((val) => {
      try {
        validateTenantName(val);
        return true;
      } catch {
        return false;
      }
    }, { message: 'Tenant name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (max 31 characters).' }),
    domain: z.string().min(1, 'Domain is required'),
    adminEmail: z.string().min(1, 'Admin email is required').refine((val) => {
      try {
        validateEmail(val);
        return true;
      } catch {
        return false;
      }
    }, { message: 'Admin email must be a valid email address.' }),
    title: z.string().default('My Ghost Publication'),
    version: z.string().default(CONFIG.DEFAULT_GHOST_VERSION),
    mysqlRootPassword: z.string().min(1, 'MySQL root password is required'),
    local: z.boolean().default(false),
    themeDir: z.string().optional(),
    port: z.string().optional(),
    storage: z.enum(['local', 's3']).default('local'),
    s3Bucket: z.string().optional(),
    s3Key: z.string().optional(),
    s3Secret: z.string().optional(),
    s3Endpoint: z.string().optional(),
    s3AssetHost: z.string().optional(),
    s3Region: z.string().default(CONFIG.DEFAULT_S3_REGION),
    s3ForcePathStyle: z.boolean().default(false),
    smtpHost: z.string().optional(),
    smtpUser: z.string().optional(),
    smtpPass: z.string().optional(),
    noInteractive: z.boolean().default(false),
    yes: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    try {
      validateDomain(data.domain, data.local);
    } catch (err: any) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err.message || 'Domain must be a fully qualified hostname without a protocol, port, or path.',
        path: ['domain'],
      });
    }

    if (data.themeDir) {
      if (!fs.existsSync(data.themeDir)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Theme directory '${data.themeDir}' does not exist on host.`,
          path: ['themeDir'],
        });
      } else if (!fs.statSync(data.themeDir).isDirectory()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Theme path '${data.themeDir}' is not a directory.`,
          path: ['themeDir'],
        });
      }
    }

    if (data.storage === 's3') {
      if (!data.s3Bucket) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--s3-bucket is required when storage is s3', path: ['s3Bucket'] });
      }
      if (!data.s3Key) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--s3-key is required when storage is s3', path: ['s3Key'] });
      }
      if (!data.s3Secret) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--s3-secret is required when storage is s3', path: ['s3Secret'] });
      }
    }

    if (data.smtpHost) {
      if (!data.smtpUser) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--smtp-user is required when --smtp-host is provided', path: ['smtpUser'] });
      }
      if (!data.smtpPass) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--smtp-pass is required when --smtp-host is provided', path: ['smtpPass'] });
      }
    }
  });

/**
 * Validated input type containing guaranteed, sanitized options for tenant deployment.
 */
export type CreateStrictInput = z.infer<typeof createStrictSchema>;
