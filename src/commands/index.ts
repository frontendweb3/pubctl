/**
 * Central Commands Barrel Export
 *
 * Aggregates all Zodline command definitions for pubctl:
 * - init: Base Docker infrastructure (Traefik + MySQL)
 * - create: Ghost CMS site provisioning with local dev & SSL support
 * - backup: Consistent database & content volume point-in-time backups
 * - update: Zero-downtime Ghost container upgrade with automatic rollback
 * - delete: Ghost instance and persistent storage teardown
 */

import { initCommand } from './init.js';
import { createCommand } from './create.js';
import { backupCommand } from './backup.js';
import { updateCommand } from './update.js';
import { deleteCommand } from './delete.js';

export const commands = {
  init: initCommand,
  create: createCommand,
  backup: backupCommand,
  update: updateCommand,
  delete: deleteCommand,
};

export { initCommand, createCommand, backupCommand, updateCommand, deleteCommand };
