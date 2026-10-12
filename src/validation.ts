export const TENANT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

export function validateTenantName(name: string): void {
  if (!TENANT_NAME_PATTERN.test(name)) {
    throw new Error('Tenant name must start with a lowercase letter and contain only lowercase letters, digits, and underscores (max 31 characters).');
  }
}

export function validateDomain(domain: string): void {
  try {
    const url = new URL(`https://${domain}`);
    if (url.hostname !== domain.toLowerCase() || !domain.includes('.')) throw new Error();
  } catch {
    throw new Error('Domain must be a fully qualified hostname without a protocol, port, or path.');
  }
}

export function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Admin email must be a valid email address.');
  }
}
