/**
 * Interactive Wizard for the `create` Command
 *
 * Prompts the user through step-by-step configuration for deploying a new Ghost CMS tenant:
 * - Local development vs production mode
 * - Tenant name and domain resolution (e.g. `<name>.localhost` or custom FQDN)
 * - Admin email and publication title
 * - Host theme directory mounting for live reload
 * - MySQL root password validation
 * - Storage adapter selection (local volume or S3/Cloudflare R2)
 */

import chalk from 'chalk';
import { CONFIG } from '../config.js';
import { validateDomain, validateEmail, validateTenantName } from '../validation.js';
import { askConfirm, askPassword, askSelect, askText, isInteractive } from './prompt.js';
import type { CreateOptions, CreateStrictInput } from '../schemas/create.js';

/**
 * Resolves full options for the `create` command by gathering missing parameters
 * interactively or applying intelligent defaults for local development.
 *
 * @param options Parsed command-line options
 * @returns Complete options object ready for strict validation
 */
export async function resolveCreateOptions(options: CreateOptions): Promise<CreateStrictInput> {
  let name = options.name;
  let isLocal = options.local ?? false;
  let domain = options.domain;
  let adminEmail = options.adminEmail;
  let title = options.title || 'My Ghost Publication';
  let version = options.version || CONFIG.DEFAULT_GHOST_VERSION;
  let password = options.mysqlRootPassword || process.env.MYSQL_ROOT_PASSWORD;
  let themeDir = options.themeDir;
  let port = options.port;
  let storage = options.storage || 'local';
  let s3Bucket = options.s3Bucket;
  let s3Key = options.s3Key;
  let s3Secret = options.s3Secret;
  let s3Endpoint = options.s3Endpoint;
  let s3AssetHost = options.s3AssetHost;
  let s3Region = options.s3Region || CONFIG.DEFAULT_S3_REGION;
  let s3ForcePathStyle = options.s3ForcePathStyle ?? false;

  if (isInteractive(options)) {
    console.log(chalk.bold.cyan('\n=== pubctl create site wizard ==='));

    if (options.local === undefined) {
      isLocal = await askConfirm('Configure for local development / theme editing (HTTP on *.localhost)?', false);
    }

    if (!name) {
      while (!name) {
        const val = await askText('Tenant name (e.g. techblog)');
        try {
          validateTenantName(val);
          name = val;
        } catch (err: any) {
          console.log(chalk.yellow(`! ${err.message}`));
        }
      }
    }

    if (!domain) {
      const defaultDomain = isLocal ? (port ? 'localhost' : `${name}.localhost`) : '';
      while (!domain) {
        const promptLabel = isLocal
          ? `Domain (e.g. ${port ? 'localhost' : `${name}.localhost`})`
          : 'Domain or subdomain (e.g. blog.example.com)';
        const val = await askText(promptLabel, defaultDomain);
        try {
          validateDomain(val, isLocal);
          domain = val;
        } catch (err: any) {
          console.log(chalk.yellow(`! ${err.message}`));
        }
      }
    }

    if (!adminEmail) {
      while (!adminEmail) {
        const val = await askText('Admin email address for Ghost');
        try {
          validateEmail(val);
          adminEmail = val;
        } catch (err: any) {
          console.log(chalk.yellow(`! ${err.message}`));
        }
      }
    }

    title = await askText('Publication title', isLocal ? `${title} (Local Dev)` : title);

    if (isLocal && !themeDir) {
      const wantTheme = await askConfirm('Mount a host directory for live theme development?', false);
      if (wantTheme) {
        themeDir = await askText('Path to local theme folder (e.g. ./my-theme)');
      }
    }

    if (!password) {
      while (!password) {
        const inputPass = await askPassword('MySQL root password (configured during pubctl init)');
        if (inputPass) {
          password = inputPass;
        } else {
          console.log(chalk.yellow('! MySQL root password is required to create tenant database.'));
        }
      }
    }

    const selectedStorage = await askSelect('Storage adapter', ['local', 's3'], storage);
    storage = selectedStorage as 'local' | 's3';

    if (storage === 's3') {
      if (!s3Bucket) s3Bucket = await askText('S3/R2 Bucket name');
      if (!s3Key) s3Key = await askText('S3/R2 Access Key ID');
      if (!s3Secret) s3Secret = await askPassword('S3/R2 Secret Access Key');
      if (!s3Endpoint) {
        const ep = await askText('Custom S3 endpoint URL (optional, press Enter to skip)');
        if (ep) s3Endpoint = ep;
      }
      if (!s3AssetHost) {
        const ah = await askText('Public CDN / asset host URL (optional, press Enter to skip)');
        if (ah) s3AssetHost = ah;
      }
    }
  } else {
    // Non-interactive fallback: if local mode is set and domain is omitted, default to localhost (if port given) or <name>.localhost
    if (isLocal && !domain && name) {
      domain = port ? 'localhost' : `${name}.localhost`;
    }
  }

  return {
    ...options,
    name: name || '',
    domain: domain || '',
    adminEmail: adminEmail || '',
    title,
    version,
    mysqlRootPassword: password || '',
    local: isLocal,
    themeDir,
    port,
    storage,
    s3Bucket,
    s3Key,
    s3Secret,
    s3Endpoint,
    s3AssetHost,
    s3Region,
    s3ForcePathStyle,
  };
}
