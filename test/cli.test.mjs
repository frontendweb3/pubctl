import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { validateDomain, validateEmail, validateTenantName } from '../src/validation.ts';
import { APP_NAME, CONFIG } from '../src/config.ts';

describe('Validation Tests', () => {
  describe('validateTenantName', () => {
    it('accepts valid tenant names', () => {
      assert.doesNotThrow(() => validateTenantName('blog'));
      assert.doesNotThrow(() => validateTenantName('blog_2026'));
      assert.doesNotThrow(() => validateTenantName('my_tech_publication'));
      assert.doesNotThrow(() => validateTenantName('a')); // single letter lowercase (min length: 1)
      assert.doesNotThrow(() => validateTenantName('a'.repeat(31))); // exactly 31 characters (max allowed)
    });

    it('rejects invalid tenant names', () => {
      assert.throws(() => validateTenantName('1blog'), /Tenant name/); // cannot start with digit
      assert.throws(() => validateTenantName('_blog'), /Tenant name/); // cannot start with underscore
      assert.throws(() => validateTenantName('Blog'), /Tenant name/); // cannot have uppercase
      assert.throws(() => validateTenantName('bad-name'), /Tenant name/); // hyphens not allowed (only underscore)
      assert.throws(() => validateTenantName('blog.com'), /Tenant name/); // no dots
      assert.throws(() => validateTenantName('blog@site'), /Tenant name/); // no special characters
      assert.throws(() => validateTenantName(''), /Tenant name/); // cannot be empty
      assert.throws(() => validateTenantName('a'.repeat(32)), /Tenant name/); // cannot exceed 31 chars
    });
  });

  describe('validateDomain', () => {
    it('accepts valid FQDN domains and subdomains', () => {
      assert.doesNotThrow(() => validateDomain('example.com'));
      assert.doesNotThrow(() => validateDomain('blog.example.com'));
      assert.doesNotThrow(() => validateDomain('deep.sub.domain.org'));
      assert.doesNotThrow(() => validateDomain('ghost.internal.io'));
      assert.doesNotThrow(() => validateDomain('site.co.uk'));
    });

    it('rejects invalid domains, protocols, ports, and paths', () => {
      assert.throws(() => validateDomain('https://blog.example.com'), /Domain/); // protocol not allowed
      assert.throws(() => validateDomain('http://example.com'), /Domain/);
      assert.throws(() => validateDomain('blog.example.com:8080'), /Domain/); // port not allowed
      assert.throws(() => validateDomain('blog.example.com/ghost'), /Domain/); // path not allowed
      assert.throws(() => validateDomain('localhost'), /Domain/); // must contain a dot
      assert.throws(() => validateDomain('invalid domain.com'), /Domain/); // spaces not allowed
      assert.throws(() => validateDomain(''), /Domain/); // cannot be empty
    });
  });

  describe('validateEmail', () => {
    it('accepts valid email addresses', () => {
      assert.doesNotThrow(() => validateEmail('admin@example.com'));
      assert.doesNotThrow(() => validateEmail('john.doe+ghost@domain.org'));
      assert.doesNotThrow(() => validateEmail('support@sub.domain.co'));
    });

    it('rejects invalid email formats', () => {
      assert.throws(() => validateEmail('not-an-email'), /email/);
      assert.throws(() => validateEmail('admin@'), /email/);
      assert.throws(() => validateEmail('@example.com'), /email/);
      assert.throws(() => validateEmail('admin@example'), /email/); // no TLD
      assert.throws(() => validateEmail('admin @example.com'), /email/); // spaces not allowed
      assert.throws(() => validateEmail(''), /email/); // cannot be empty
    });
  });
});

describe('Config & Naming Helpers', () => {
  it('generates correct tenant-specific Docker and DB resource names', () => {
    const tenant = 'techblog';
    assert.equal(CONFIG.getTenantContainerName(tenant), 'pubctl-techblog');
    assert.equal(CONFIG.getTenantVolumeName(tenant), 'pubctl-content-techblog');
    assert.equal(CONFIG.getTenantDbName(tenant), 'pubctl_techblog');
    assert.equal(CONFIG.getTenantDbUser(tenant), 'usr_techblog');
  });

  it('provides expected infrastructure defaults', () => {
    assert.equal(APP_NAME, 'pubctl');
    assert.equal(CONFIG.NETWORK_NAME, 'pubctl-net');
    assert.equal(CONFIG.DB_CONTAINER, 'pubctl-mysql');
    assert.equal(CONFIG.PROXY_CONTAINER, 'pubctl-traefik');
    assert.equal(CONFIG.DB_VOLUME, 'pubctl-mysql-data');
    assert.equal(CONFIG.CERTS_VOLUME, 'pubctl-certs');
    assert.equal(CONFIG.DEFAULT_DB_PORT, 3306);
    assert.equal(CONFIG.DEFAULT_STORAGE_TYPE, 'local');
    assert.equal(CONFIG.DEFAULT_CERT_RESOLVER, 'myresolver');
  });

  it('correctly namespaces Docker labels', () => {
    assert.equal(CONFIG.LABELS.TENANT, 'pubctl.tenant');
    assert.equal(CONFIG.LABELS.VERSION, 'pubctl.version');
    assert.equal(CONFIG.LABELS.STORAGE, 'pubctl.storage');
    assert.equal(CONFIG.LABELS.MANAGED_BY, 'pubctl.managed-by');
  });
});
