/**
 * Shared Dockerode Client & Container Infrastructure Helpers
 * 
 * Provides centralized Docker daemon connectivity, image pulling,
 * database connectivity with retry, stream demuxing, and container inspection.
 */

import Docker from 'dockerode';
import mysql from 'mysql2/promise';
import chalk from 'chalk';
import ora from 'ora';
import { PassThrough } from 'stream';
import { CONFIG } from '../config.js';

/**
 * Instantiates the Docker client with support for Unix domain sockets,
 * Windows named pipes, and TCP/HTTP host configurations.
 */
function createDockerClient(): Docker {
  const socketOrHost = CONFIG.DOCKER_SOCKET_PATH;
  if (
    socketOrHost.startsWith('tcp://') ||
    socketOrHost.startsWith('http://') ||
    socketOrHost.startsWith('https://')
  ) {
    const url = new URL(socketOrHost.replace(/^tcp:/, 'http:'));
    return new Docker({
      host: url.hostname,
      port: Number(url.port) || 2375,
      protocol: socketOrHost.startsWith('https://') ? 'https' : 'http',
    });
  }
  return new Docker({ socketPath: socketOrHost });
}

/**
 * Shared Docker client connected to the configured Docker daemon.
 */
export const docker = createDockerClient();

/**
 * Retrieves the MySQL root password from environment variables.
 * 
 * @throws Error if MYSQL_ROOT_PASSWORD is not set
 */
export function getRootPassword(): string {
  const password = process.env.MYSQL_ROOT_PASSWORD;
  if (!password) {
    throw new Error('MYSQL_ROOT_PASSWORD is required. Set it to the password used with `pubctl init`.');
  }
  return password;
}

/**
 * Pulls a Docker image from a registry and tracks download progress to completion.
 *
 * @param image Image name and tag (e.g. 'mysql:8.0', 'ghost:6-alpine')
 */
export async function pullImage(image: string): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Reports command execution failure through an Ora spinner and sets process exit code.
 *
 * @param spinner Active spinner instance
 * @param action Name of failed action (e.g. 'Init', 'Creation', 'Backup')
 * @param err The thrown exception or error message
 */
export function reportFailure(spinner: ora.Ora, action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  spinner.fail(chalk.red(`${action} failed: ${message}`));
  process.exitCode = 1;
}

/**
 * Issues an HTTP fetch with an explicit timeout signal.
 *
 * @param url Target endpoint URL
 * @param init Request initialization options
 * @param timeoutMs Timeout in milliseconds
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Polls a newly created or swapped Ghost container until its HTTP port responds.
 *
 * @param container Docker container instance to inspect and poll
 * @param timeoutMs Total timeout period before reporting failure (default: 90s)
 */
export async function waitForGhostReady(container: Docker.Container, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Ghost did not respond';
  while (Date.now() < deadline) {
    const info = await container.inspect();
    if (!info.State.Running) throw new Error('Replacement Ghost container exited before becoming ready.');
    const ip = info.NetworkSettings?.Networks?.[CONFIG.NETWORK_NAME]?.IPAddress;
    if (ip) {
      try {
        const response = await fetchWithTimeout(`http://${ip}:2368/`, { method: 'GET' }, 5_000);
        if (response.ok || (response.status >= 300 && response.status < 400)) return;
        lastError = `Ghost returned HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Ghost did not become ready within ${timeoutMs / 1000}s: ${lastError}`);
}

/**
 * Verifies that a MySQL container binds its port strictly to 127.0.0.1 (localhost-only).
 *
 * @param info Container inspection data
 */
export function mysqlIsLocalOnly(info: Docker.ContainerInspectInfo): boolean {
  const bindings = info.HostConfig.PortBindings?.[`${CONFIG.DEFAULT_DB_PORT}/tcp`];
  return Array.isArray(bindings) && bindings.length > 0 && bindings.every((binding) => binding.HostIp === '127.0.0.1');
}

/**
 * Safely removes a Docker volume if it currently exists on the daemon.
 *
 * @param name Volume name
 */
export async function removeVolumeIfPresent(name: string): Promise<void> {
  const volume = docker.getVolume(name);
  try {
    await volume.inspect();
  } catch (err: any) {
    if (err?.statusCode === 404) return;
    throw err;
  }
  await volume.remove();
}

/**
 * Connects to MySQL with automatic retries and exponential polling delay.
 *
 * @param retries Number of retry attempts (default: 5)
 * @param delayMs Delay between attempts in milliseconds (default: 1500)
 */
export async function getDbConnection(retries = 5, delayMs = 1500): Promise<mysql.Connection> {
  const rootPassword = getRootPassword();
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await mysql.createConnection({
        host: '127.0.0.1',
        port: CONFIG.DEFAULT_DB_PORT,
        user: 'root',
        password: rootPassword,
      });
    } catch (err: any) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Safely demuxes a Docker exec duplex stream into stdout and stderr streams.
 * Handles backpressure, error propagation, process exit codes, and resource cleanup.
 *
 * @param modem The Dockerode modem instance
 * @param stream Duplex/Readable stream returned from exec.start()
 * @param stdoutDest Destination writable stream (e.g., fs.WriteStream for db.sql)
 * @param checkExitCode Optional callback to inspect container process exit code
 */
export async function safeDemuxExecStream(
  modem: any,
  stream: NodeJS.ReadableStream,
  stdoutDest: NodeJS.WritableStream,
  checkExitCode?: () => Promise<number | null | undefined>
): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderrBuffer = '';
    let isSettled = false;

    const stderrStream = new PassThrough();
    stderrStream.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    const cleanup = () => {
      stream.removeAllListeners('error');
      stream.removeAllListeners('end');
      stream.removeAllListeners('close');
      stdoutDest.removeAllListeners('error');
      stdoutDest.removeAllListeners('finish');
      stderrStream.removeAllListeners('error');
    };

    const handleError = (err: Error) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(err);
    };

    stream.on('error', handleError);
    stdoutDest.on('error', handleError);
    stderrStream.on('error', handleError);

    modem.demuxStream(stream, stdoutDest, stderrStream);

    const onStreamDone = () => {
      stdoutDest.end();
      stderrStream.end();
    };

    stream.on('end', onStreamDone);
    stream.on('close', onStreamDone);

    stdoutDest.on('finish', async () => {
      if (isSettled) return;
      isSettled = true;
      cleanup();

      if (checkExitCode) {
        try {
          const exitCode = await checkExitCode();
          if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
            return reject(
              new Error(
                `Process inside container exited with code ${exitCode}. Stderr: ${
                  stderrBuffer.trim() || '(none)'
                }`
              )
            );
          }
        } catch (inspectErr) {
          return reject(inspectErr);
        }
      }

      resolve({ stderr: stderrBuffer });
    });
  });
}

/**
 * Finds a tenant container supporting both current (`pubctl-<name>`) and legacy (`ghost-<name>`) naming.
 *
 * @param name Tenant name
 */
export async function findTenantContainer(name: string): Promise<Docker.Container> {
  const primaryName = CONFIG.getTenantContainerName(name);
  const legacyName = `ghost-${name}`;
  try {
    const containers = await docker.listContainers({ all: true });
    const match = containers.find(
      (c) => c.Names.includes(`/${primaryName}`) || c.Names.includes(`/${legacyName}`)
    );
    if (match) {
      return docker.getContainer(match.Id);
    }
  } catch {
    // If listing fails, fall through to primary container handle
  }
  return docker.getContainer(primaryName);
}
