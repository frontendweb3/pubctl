/**
 * Ghost CMS Tenant Deployment Command (`create`)
 *
 * Automates end-to-end provisioning of an isolated Ghost CMS publication:
 * 1. Creates a dedicated MySQL database and scoped user with least privileges.
 * 2. Configures environment variables for database connectivity, SMTP, and S3 storage.
 * 3. Mounts isolated Docker volumes and optional host theme folders for live development.
 * 4. Configures Traefik dynamic routing:
 *    - Production mode: Strict HTTPS redirection and automated Let's Encrypt SSL/TLS certificates.
 *    - Local development mode: Plain HTTP on port 80 and self-signed TLS on port 443 with Handlebars live reload.
 * 5. Executes headless administrative bootstrapping via Ghost's internal setup API.
 * 6. Guarantees atomic rollback (cleans up container, database, and user) if setup fails.
 */

import crypto from 'crypto';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import type Docker from 'dockerode';
import { defineCommand } from 'zodline';
import { APP_NAME, CONFIG } from '../config.js';
import {
  docker,
  fetchWithTimeout,
  getDbConnection,
  pullImage,
  reportFailure,
} from '../lib/docker.js';
import { resolveCreateOptions } from '../prompts/createPrompt.js';
import { createOptions, createStrictSchema, type CreateOptions } from '../schemas/create.js';

/**
 * Zodline command definition for `pubctl create`.
 */
export const createCommand = defineCommand({
  description: 'Deploy a new Ghost CMS site with automated zero-touch login',
  options: createOptions,
  action: async (options: CreateOptions) => {
    let resolved;
    try {
      resolved = await resolveCreateOptions(options);
    } catch (err: unknown) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
      return;
    }

    const validated = createStrictSchema.parse(resolved);
    const { name, domain, adminEmail, title, version, storage = CONFIG.DEFAULT_STORAGE_TYPE } = validated;
    process.env.MYSQL_ROOT_PASSWORD = validated.mysqlRootPassword;

    const spinner = ora(`Provisioning ${domain}...`).start();
    let container: Docker.Container | undefined;
    let databaseProvisioned = false;

    try {
      const dbName = CONFIG.getTenantDbName(name);
      const dbUser = CONFIG.getTenantDbUser(name);
      const dbPassword = crypto.randomBytes(16).toString('hex');
      const generatedAdminPassword =
        crypto.randomBytes(10).toString('base64').replace(/[^a-zA-Z0-9]/g, 'a') + 'A1!';

      // 1. MySQL Database Creation
      spinner.text = 'Creating isolated database...';
      const db = await getDbConnection();
      try {
        const containers = await docker.listContainers({ all: true });
        const containerName = CONFIG.getTenantContainerName(name);
        if (containers.some((candidate) => candidate.Names.includes(`/${containerName}`))) {
          throw new Error(`Tenant '${name}' already has a container. Use update or delete it before creating again.`);
        }
        const [schemas] = await db.query(
          'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
          [dbName]
        );
        if (Array.isArray(schemas) && schemas.length > 0) {
          throw new Error(`Tenant '${name}' already has a database. Refusing to overwrite existing data.`);
        }
        const volumes = await docker.listVolumes();
        if (volumes.Volumes.some((volume) => volume.Name === CONFIG.getTenantVolumeName(name))) {
          throw new Error(`Tenant '${name}' already has a content volume. Refusing to attach existing data.`);
        }
        await db.query(`CREATE DATABASE \`${dbName}\`;`);
        await db.query(`CREATE USER '${dbUser}'@'%' IDENTIFIED BY '${dbPassword}';`);
        await db.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%';`);
        await db.query('FLUSH PRIVILEGES;');
        databaseProvisioned = true;
      } finally {
        await db.end();
      }

      // 2. Prepare Environment Variables
      const protocol = validated.local ? 'http' : 'https';
      const nodeEnv = validated.local ? 'development' : 'production';
      const siteUrl = validated.port ? `${protocol}://${domain}:${validated.port}` : `${protocol}://${domain}`;

      const envVars = [
        `url=${siteUrl}`,
        `NODE_ENV=${nodeEnv}`,
        `database__client=mysql`,
        `database__connection__host=${CONFIG.DB_CONTAINER}`,
        `database__connection__user=${dbUser}`,
        `database__connection__password=${dbPassword}`,
        `database__connection__database=${dbName}`,
      ];

      // SMTP Configuration injection if provided
      if (validated.smtpHost) {
        envVars.push(
          'mail__transport=SMTP',
          `mail__options__host=${validated.smtpHost}`,
          'mail__options__port=587',
          'mail__options__service=SMTP',
          'mail__options__auth__type=LOGIN',
          `mail__options__auth__user=${validated.smtpUser}`,
          `mail__options__auth__pass=${validated.smtpPass}`
        );
      }

      // S3-Compatible Cloud Storage configuration injection
      if (storage === 's3') {
        const region = validated.s3Region || CONFIG.DEFAULT_S3_REGION;
        envVars.push(
          'storage__active=s3',
          `storage__s3__bucket=${validated.s3Bucket}`,
          `storage__s3__accessKeyId=${validated.s3Key}`,
          `storage__s3__secretAccessKey=${validated.s3Secret}`,
          `storage__s3__region=${region}`
        );

        if (validated.s3Endpoint) {
          envVars.push(`storage__s3__endpoint=${validated.s3Endpoint}`);
        }
        if (validated.s3AssetHost) {
          envVars.push(`storage__s3__assetHost=${validated.s3AssetHost}`);
        }
        if (validated.s3ForcePathStyle) {
          envVars.push('storage__s3__forcePathStyle=true');
        }
      }

      // 3. Start Ghost Container
      const imageTag = version.includes(':') || version.includes('/') ? version : `ghost:${version}`;
      spinner.text = `Starting Ghost (${imageTag}) container...`;
      await pullImage(imageTag);

      const containerName = CONFIG.getTenantContainerName(name);
      const volumeName = CONFIG.getTenantVolumeName(name);

      const binds = [`${volumeName}:/var/lib/ghost/content`];
      let mountedThemeName: string | undefined;

      if (validated.themeDir) {
        const absThemeDir = path.resolve(validated.themeDir);
        mountedThemeName = path.basename(absThemeDir);
        binds.push(`${absThemeDir}:/var/lib/ghost/content/themes/${mountedThemeName}`);
      }

      const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
      if (validated.port) {
        portBindings['2368/tcp'] = [{ HostIp: '127.0.0.1', HostPort: `${validated.port}` }];
      }

      const labels: Record<string, string> = {
        'traefik.enable': 'true',
        [`traefik.http.services.${name}.loadbalancer.server.port`]: '2368',
        [CONFIG.LABELS.TENANT]: name,
        [CONFIG.LABELS.VERSION]: version,
        [CONFIG.LABELS.STORAGE]: storage,
        [CONFIG.LABELS.MANAGED_BY]: APP_NAME,
        'pubctl.mode': validated.local ? 'local' : 'production',
      };

      if (validated.local) {
        // HTTP routing on port 80 for local development
        const hostRules = [`Host(\`${domain}\`)`];
        if (domain !== `${name}.localhost`) {
          hostRules.push(`Host(\`${name}.localhost\`)`);
        }
        const localRule = hostRules.join(' || ');

        labels[`traefik.http.routers.${name}.rule`] = localRule;
        labels[`traefik.http.routers.${name}.entrypoints`] = 'web';

        // Also route HTTPS (port 443 with self-signed TLS) so https://<domain> works if browser auto-upgrades
        labels[`traefik.http.routers.${name}-tls.rule`] = localRule;
        labels[`traefik.http.routers.${name}-tls.entrypoints`] = 'websecure';
        labels[`traefik.http.routers.${name}-tls.tls`] = 'true';
      } else {
        // Production: HTTP (:80) redirected to HTTPS (:443) with automated SSL
        labels[`traefik.http.routers.${name}-http.rule`] = `Host(\`${domain}\`)`;
        labels[`traefik.http.routers.${name}-http.entrypoints`] = 'web';
        labels[`traefik.http.routers.${name}-http.middlewares`] = `${name}-https-redirect`;
        labels[`traefik.http.middlewares.${name}-https-redirect.redirectscheme.scheme`] = 'https';

        labels[`traefik.http.routers.${name}.rule`] = `Host(\`${domain}\`)`;
        labels[`traefik.http.routers.${name}.entrypoints`] = 'websecure';
        labels[`traefik.http.routers.${name}.tls.certresolver`] = CONFIG.DEFAULT_CERT_RESOLVER;
      }

      container = await docker.createContainer({
        Image: imageTag,
        name: containerName,
        Env: envVars,
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          Binds: binds,
          PortBindings: portBindings,
          NetworkMode: CONFIG.NETWORK_NAME,
        },
        Labels: labels,
      });

      await container.start();

      // 4. Headless Automated Ghost Setup (Bypasses manual /ghost/#/setup)
      spinner.text = 'Waiting for Ghost migration to complete & bootstrapping admin...';
      let setupSuccess = false;
      const inspectData = await container.inspect();
      const internalIp = inspectData.NetworkSettings?.Networks?.[CONFIG.NETWORK_NAME]?.IPAddress;

      if (internalIp) {
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const res = await fetchWithTimeout(`http://${internalIp}:2368/ghost/api/admin/authentication/setup/`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                setup: [
                  {
                    name: 'Administrator',
                    email: adminEmail,
                    password: generatedAdminPassword,
                    blogTitle: title,
                  },
                ],
              }),
            }, 5_000);
            if (res.ok) {
              setupSuccess = true;
              break;
            }
          } catch {
            // Ghost is still performing Knex database migrations; keep polling
          }
        }
      }

      if (!setupSuccess) {
        throw new Error('Ghost did not complete automated administrator setup within 60 seconds; the deployment was rolled back.');
      }

      spinner.succeed(chalk.green(`Site ${name} deployed successfully!`));

      console.log('\n' + chalk.bold.cyan('================ Deployment Details ================'));
      console.log(`${chalk.bold('Blog URL:')}           ${siteUrl}`);
      console.log(`${chalk.bold('Admin Panel:')}        ${siteUrl}/ghost/`);
      console.log(`${chalk.bold('Admin Email:')}        ${adminEmail}`);
      console.log(`${chalk.bold('Temporary Password:')}   ${chalk.yellow(generatedAdminPassword)}`);
      console.log(
        `${chalk.bold('Mode:')}               ${
          validated.local
            ? chalk.bold.green('LOCAL DEV (HTTP, Theme Live Reload)')
            : chalk.cyan('PRODUCTION (Automated SSL)')
        }`
      );
      if (mountedThemeName && validated.themeDir) {
        console.log(`${chalk.bold('Mounted Theme:')}      ${path.resolve(validated.themeDir)} -> /content/themes/${mountedThemeName}`);
      }
      if (validated.port) {
        console.log(`${chalk.bold('Direct Host Port:')}   http://127.0.0.1:${validated.port}`);
      }
      console.log(
        `${chalk.bold('Storage:')}            ${storage.toUpperCase()}${
          storage === 's3' ? ` (Bucket: ${validated.s3Bucket})` : ' (Local volume)'
        }`
      );
      console.log(chalk.bold.cyan('===================================================='));

    } catch (err: unknown) {
      if (container) {
        try {
          const info = await container.inspect();
          if (info.State.Running) await container.stop();
          await container.remove();
        } catch {
          // Preserve the original provisioning error.
        }
      }
      if (databaseProvisioned) {
        try {
          const db = await getDbConnection();
          const dbName = CONFIG.getTenantDbName(name);
          const dbUser = CONFIG.getTenantDbUser(name);
          await db.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
          await db.query(`DROP USER IF EXISTS '${dbUser}'@'%';`);
          await db.end();
        } catch {
          // Report the provisioning failure
        }
      }
      reportFailure(spinner, 'Creation', err);
    }
  },
});
