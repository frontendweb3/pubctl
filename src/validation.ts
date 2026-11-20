/**
 * Tenant naming pattern:
 * - Must start with a lowercase letter (a-z)
 * - May contain lowercase letters, digits (0-9), and underscores (_)
 * - Minimum 1 character, maximum 31 characters (MySQL database name / Docker label limits)
 */
export const TENANT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * Validates that a tenant name conforms to the naming standard.
 *
 * @param name The tenant identifier to validate
 * @throws Error if the name violates length or character constraints
 */
export function validateTenantName(name: string): void {
  if (!TENANT_NAME_PATTERN.test(name)) {
    throw new Error('Tenant name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (max 31 characters).');
  }
}

/**
 * Validates domain and hostname formats.
 *
 * In production mode: Requires a fully qualified domain name (FQDN) containing at least one dot.
 * In local dev mode (`isLocal = true`): Also accepts bare `localhost` and `*.localhost`.
 *
 * @param domain Hostname or domain to validate
 * @param isLocal Whether local development domains (e.g. localhost) are permitted
 * @throws Error if domain contains protocols, ports, paths, or invalid characters
 */
export function validateDomain(domain: string, isLocal = false): void {
  try {
    const url = new URL(`https://${domain}`);
    if (url.hostname !== domain.toLowerCase()) throw new Error();
    if (!domain.includes('.') && (!isLocal || domain !== 'localhost')) throw new Error();
  } catch {
    throw new Error('Domain must be a fully qualified hostname without a protocol, port, or path.');
  }
}

/**
 * Validates an email address format.
 *
 * @param email Email address string to test
 * @throws Error if email format is invalid
 */
export function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Admin email must be a valid email address.');
  }
}
