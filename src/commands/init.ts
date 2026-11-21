/**
 * Base Infrastructure Initialization Command (`init`)
 *
 * Bootstraps the foundational Docker infrastructure required for hosting multi-tenant Ghost blogs:
 * 1. Creates an isolated Docker bridge network (`pubctl-net`).
 * 2. Deploys a MySQL 8.0 server with data persistence and strict localhost-only port binding (`127.0.0.1:3306`).
 * 3. Deploys Traefik reverse proxy configured with automated Let's Encrypt SSL/TLS certificates and Docker API compatibility.
 */

import chalk from 'chalk';
import ora from 'ora';
import { defineCommand } from 'zodline';
import { CONFIG } from '../config.js';
import {
  docker,
  getDbConnection,
  mysqlIsLocalOnly,
  pullImage,
  reportFailure,
} from '../lib/docker.js';
import { resolveInitOptions } from '../prompts/initPrompt.js';
import { initOptions, initStrictSchema, type InitOptions } from '../schemas/init.js';

/**
 * Zodline command definition for `pubctl init`.
 */
export const initCommand = defineCommand({
  description: 'Initialize base Docker infrastructure (Traefik SSL Proxy + MySQL)',
  options: initOptions,
  action: async (options: InitOptions) => {
    let resolved;
    try {
      resolved = await resolveInitOptions(options);
    } catch (err: unknown) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
      return;
    }

    const validated = initStrictSchema.parse(resolved);
    const { name: appName, email, mysqlRootPassword: password } = validated;
    process.env.MYSQL_ROOT_PASSWORD = password;

    const newRootPassword = process.env.PUBCTL_NEW_ROOT_PASSWORD;
    if (options.rotateMysqlRootPassword && !newRootPassword) {
      console.error(chalk.red('Error: PUBCTL_NEW_ROOT_PASSWORD must be set to rotate the root password.'));
      process.exitCode = 1;
      return;
    }

    const spinner = ora('Initializing base Docker infrastructure...').start();

    try {
      // 1. Create Bridge Network
      const networkName = CONFIG.NETWORK_NAME;
      const networks = await docker.listNetworks();
      if (!networks.some((n) => n.Name === networkName)) {
        spinner.text = `Creating Docker network '${networkName}'...`;
        await docker.createNetwork({
          Name: networkName,
          Driver: 'bridge',
          Labels: {
            [CONFIG.LABELS.MANAGED_BY]: appName,
          },
        });
      }

      // 2. Start MySQL Server
      const dbContainer = CONFIG.DB_CONTAINER;
      const proxyContainer = CONFIG.PROXY_CONTAINER;
      const dbVolume = CONFIG.DB_VOLUME;
      const certsVolume = CONFIG.CERTS_VOLUME;

      const containers = await docker.listContainers({ all: true });
      const mysqlExists = containers.some((c) => c.Names.includes(`/${dbContainer}`));

      if (!mysqlExists) {
        spinner.text = `Deploying MySQL (${CONFIG.DEFAULT_MYSQL_IMAGE})...`;
        await pullImage(CONFIG.DEFAULT_MYSQL_IMAGE);
        const mysqlContainer = await docker.createContainer({
          Image: CONFIG.DEFAULT_MYSQL_IMAGE,
          name: dbContainer,
          Env: [`MYSQL_ROOT_PASSWORD=${password}`],
          HostConfig: {
            RestartPolicy: { Name: 'always' },
            Binds: [`${dbVolume}:/var/lib/mysql`],
            PortBindings: {
              [`${CONFIG.DEFAULT_DB_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: `${CONFIG.DEFAULT_DB_PORT}` }],
            },
            NetworkMode: networkName,
          },
          Labels: {
            [CONFIG.LABELS.MANAGED_BY]: appName,
          },
        });
        await mysqlContainer.start();
      } else {
        const mysqlContainer = docker.getContainer(dbContainer);
        const mysqlInfo = await mysqlContainer.inspect();
        const usesLegacyDefault = mysqlInfo.Config.Env?.includes('MYSQL_ROOT_PASSWORD=pubctl_root_secret');
        if (usesLegacyDefault && !options.rotateMysqlRootPassword) {
          throw new Error('Existing MySQL uses the retired default root password. Rotate it before continuing; this command will not silently retain an insecure credential.');
        }
        if (!mysqlIsLocalOnly(mysqlInfo)) {
          spinner.text = 'Repairing MySQL localhost-only port binding...';
          if (mysqlInfo.State.Running) await mysqlContainer.stop();
          await mysqlContainer.remove();
          const repairedMysql = await docker.createContainer({
            Image: mysqlInfo.Config.Image,
            name: dbContainer,
            Env: mysqlInfo.Config.Env,
            HostConfig: {
              RestartPolicy: mysqlInfo.HostConfig.RestartPolicy,
              Binds: mysqlInfo.HostConfig.Binds,
              PortBindings: {
                [`${CONFIG.DEFAULT_DB_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: `${CONFIG.DEFAULT_DB_PORT}` }],
              },
              NetworkMode: networkName,
            },
            Labels: { ...mysqlInfo.Config.Labels, [CONFIG.LABELS.MANAGED_BY]: appName },
          });
          await repairedMysql.start();
        } else if (!mysqlInfo.State.Running) {
          await mysqlContainer.start();
        }
      }

      // Do not report a successful init until MySQL accepts authenticated connections.
      const db = await getDbConnection(30, 1000);
      if (options.rotateMysqlRootPassword && newRootPassword) {
        const [rootUsers] = await db.query('SELECT Host FROM mysql.user WHERE User = ?', ['root']);
        if (!Array.isArray(rootUsers) || rootUsers.length === 0) {
          throw new Error('Could not find a MySQL root account to rotate.');
        }
        for (const rootUser of rootUsers as Array<{ Host: string }>) {
          const host = rootUser.Host.replace(/'/g, "''");
          await db.query(`ALTER USER 'root'@'${host}' IDENTIFIED BY ?`, [newRootPassword]);
        }
        process.env.MYSQL_ROOT_PASSWORD = newRootPassword;
      }
      await db.end();

      // 3. Start Traefik (Supports Automated SSL for Production + Plain HTTP for Local Dev)
      const traefikExists = containers.some((c) => c.Names.includes(`/${proxyContainer}`));
      const traefikCmd = [
        '--providers.docker=true',
        '--providers.docker.exposedbydefault=false',
        '--entrypoints.web.address=:80',
        '--entrypoints.websecure.address=:443',
        `--certificatesresolvers.${CONFIG.DEFAULT_CERT_RESOLVER}.acme.tlschallenge=true`,
        `--certificatesresolvers.${CONFIG.DEFAULT_CERT_RESOLVER}.acme.email=${email}`,
        `--certificatesresolvers.${CONFIG.DEFAULT_CERT_RESOLVER}.acme.storage=/letsencrypt/acme.json`,
      ];

      const startNewTraefik = async () => {
        spinner.text = `Configuring Traefik (${CONFIG.DEFAULT_TRAEFIK_IMAGE}) with automated SSL & local HTTP support...`;
        await pullImage(CONFIG.DEFAULT_TRAEFIK_IMAGE);
        // On Windows named pipes, Docker Desktop bridges Linux container mounts to /var/run/docker.sock
        const traefikSocketMount =
          CONFIG.DOCKER_SOCKET_PATH.startsWith('//./pipe/') || CONFIG.DOCKER_SOCKET_PATH.startsWith('\\\\.\\pipe\\')
            ? '/var/run/docker.sock'
            : CONFIG.DOCKER_SOCKET_PATH;

        const traefikContainer = await docker.createContainer({
          Image: CONFIG.DEFAULT_TRAEFIK_IMAGE,
          name: proxyContainer,
          Env: ['DOCKER_API_VERSION=1.44'],
          Cmd: traefikCmd,
          HostConfig: {
            RestartPolicy: { Name: 'always' },
            PortBindings: {
              '80/tcp': [{ HostPort: '80' }],
              '443/tcp': [{ HostPort: '443' }],
            },
            Binds: [
              `${traefikSocketMount}:/var/run/docker.sock:ro`,
              `${certsVolume}:/letsencrypt`,
            ],
            NetworkMode: networkName,
          },
          Labels: {
            [CONFIG.LABELS.MANAGED_BY]: appName,
          },
        });
        await traefikContainer.start();
      };

      if (!traefikExists) {
        await startNewTraefik();
      } else {
        const traefikContainer = docker.getContainer(proxyContainer);
        const traefikInfo = await traefikContainer.inspect();
        const hasLegacyGlobalRedirect = traefikInfo.Config.Cmd?.some((arg) =>
          arg.includes('redirections.entrypoint.to=websecure')
        );
        const needsUpgrade =
          traefikInfo.Config.Image !== CONFIG.DEFAULT_TRAEFIK_IMAGE ||
          hasLegacyGlobalRedirect;

        if (needsUpgrade) {
          spinner.text = 'Updating Traefik to latest version with Docker 29+ compatibility...';
          if (traefikInfo.State.Running) await traefikContainer.stop();
          await traefikContainer.remove();
          await startNewTraefik();
        } else if (!traefikInfo.State.Running) {
          await traefikContainer.start();
        }
      }

      spinner.succeed(chalk.green('Base infrastructure is running with automated SSL support!'));

      console.log('\n' + chalk.bold.cyan('================ Infrastructure Status ================'));
      console.log(`${chalk.bold('Namespace Prefix:')}   ${appName}`);
      console.log(`${chalk.bold('Network:')}            ${networkName}`);
      console.log(`${chalk.bold('MySQL Server:')}       ${dbContainer} (127.0.0.1:${CONFIG.DEFAULT_DB_PORT})`);
      console.log(`${chalk.bold('Traefik Proxy:')}      ${proxyContainer} (HTTP :80, HTTPS :443)`);
      console.log(`${chalk.bold("Let's Encrypt Email:")} ${email}`);
      console.log(chalk.bold.cyan('=======================================================\n'));
    } catch (err: unknown) {
      reportFailure(spinner, 'Init', err);
    }
  },
});
