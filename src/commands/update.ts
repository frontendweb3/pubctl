/**
 * Ghost CMS Tenant Upgrade Command (`update`)
 *
 * Upgrades or downgrades a Ghost CMS tenant container with automatic rollback:
 * 1. Inspects existing container environment variables, storage binds, and labels.
 * 2. Pulls the new Ghost Docker image tag.
 * 3. Safely renames the current container to `<name>-rollback-<timestamp>`.
 * 4. Deploys the replacement container under the original name and starts it.
 * 5. Polls the replacement container until it passes HTTP readiness checks.
 * 6. Automatically rolls back to the previous container if the upgrade fails.
 */

import chalk from 'chalk';
import ora from 'ora';
import type Docker from 'dockerode';
import { defineCommand } from 'zodline';
import { CONFIG } from '../config.js';
import {
  docker,
  findTenantContainer,
  pullImage,
  reportFailure,
  waitForGhostReady,
} from '../lib/docker.js';
import { resolveUpdateOptions } from '../prompts/updatePrompt.js';
import { updateOptions, updateStrictSchema, type UpdateOptions } from '../schemas/update.js';

/**
 * Zodline command definition for `pubctl update`.
 */
export const updateCommand = defineCommand({
  description: 'Update a site to a newer Ghost version with automatic rollback on failure',
  options: updateOptions,
  action: async (options: UpdateOptions) => {
    let resolved;
    try {
      resolved = await resolveUpdateOptions(options);
    } catch (err: unknown) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
      return;
    }

    const validated = updateStrictSchema.parse(resolved);
    const { name, to: newVersion } = validated;

    const spinner = ora(`Updating ${name} to ghost:${newVersion}...`).start();
    let oldContainer: Docker.Container | undefined;
    let oldContainerName: string | undefined;
    let rollbackName: string | undefined;
    let replacement: Docker.Container | undefined;

    try {
      oldContainer = await findTenantContainer(name);
      const info = await oldContainer.inspect();
      const containerName = info.Name.replace(/^\//, '');
      oldContainerName = containerName;

      // Pull new image
      const imageTag =
        newVersion.includes(':') || newVersion.includes('/') ? newVersion : `ghost:${newVersion}`;
      spinner.text = `Pulling ${imageTag}...`;
      await pullImage(imageTag);

      spinner.text = 'Creating recoverable container swap...';
      rollbackName = `${containerName}-rollback-${Date.now()}`;
      if (info.State.Running) await oldContainer.stop();
      await oldContainer.rename({ name: rollbackName });

      replacement = await docker.createContainer({
        Image: imageTag,
        name: containerName,
        Env: info.Config.Env,
        HostConfig: info.HostConfig,
        Labels: {
          ...info.Config.Labels,
          [CONFIG.LABELS.VERSION]: newVersion,
        },
      });

      await replacement.start();
      spinner.text = 'Waiting for the replacement to become healthy...';
      await waitForGhostReady(replacement);
      await oldContainer.remove();
      spinner.succeed(chalk.green(`Successfully updated ${name} to ${imageTag}!`));
    } catch (err: unknown) {
      if (replacement) {
        try {
          const replacementInfo = await replacement.inspect();
          if (replacementInfo.State.Running) await replacement.stop();
          await replacement.remove();
        } catch {}
      }
      if (oldContainer && oldContainerName && rollbackName) {
        try {
          await oldContainer.rename({ name: oldContainerName });
          await oldContainer.start();
        } catch {
          console.error(chalk.red('Rollback failed; the previous container is retained under its rollback name.'));
        }
      }
      reportFailure(spinner, 'Update', err);
    }
  },
});
