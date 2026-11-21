/**
 * Test Suite for `pubctl` CLI & Docker Orchestration Engine
 *
 * Verifies:
 * - Semantic input validation (tenant names, domains, RFC email compliance)
 * - Configuration naming conventions and Docker label namespacing
 * - Strict Zod validation schemas for all commands (init, create, backup, update, delete)
 * - Local development mode requirements (theme folder mounting, .localhost domain resolution)
 * - Zodline command parsing, options, and shorthand aliases
 * - Argument normalization for snake_case and uppercase flags
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { processConfig, ZodlineError } from 'zodline';
import { validateDomain, validateEmail, validateTenantName } from '../src/validation.ts';
import { APP_NAME, CONFIG, resolveDockerSocket } from '../src/config.ts';
import {
  initStrictSchema,
  createStrictSchema,
  backupStrictSchema,
  updateStrictSchema,
  deleteStrictSchema,
} from '../src/schemas/index.ts';
import { config, normalizeArgv } from '../src/index.ts';

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
      assert.doesNotThrow(() => validateDomain('techblog.localhost', true));
      assert.doesNotThrow(() => validateDomain('localhost', true));
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

  describe('resolveDockerSocket & Multi-Platform Resolution', () => {
    it('prioritizes explicit DOCKER_SOCKET override', () => {
      const socket = resolveDockerSocket({ DOCKER_SOCKET: '/custom/docker.sock' });
      assert.equal(socket, '/custom/docker.sock');
    });

    it('resolves DOCKER_HOST with unix:// scheme', () => {
      const socket = resolveDockerSocket({ DOCKER_HOST: 'unix:///var/run/custom.sock' });
      assert.equal(socket, '/var/run/custom.sock');
    });

    it('resolves DOCKER_HOST with npipe:// scheme', () => {
      const socket = resolveDockerSocket({ DOCKER_HOST: 'npipe:////./pipe/custom_pipe' });
      assert.equal(socket, '//./pipe/custom_pipe');
    });

    it('defaults to Windows named pipe on win32 when no env is set', () => {
      const socket = resolveDockerSocket({}, 'win32');
      assert.equal(socket, '//./pipe/docker_engine');
    });

    it('falls back to standard /var/run/docker.sock on macOS and Linux when special paths are absent', () => {
      const macSocket = resolveDockerSocket({ HOME: '/nonexistent/path' }, 'darwin');
      assert.equal(macSocket, '/var/run/docker.sock');

      const linuxSocket = resolveDockerSocket({ XDG_RUNTIME_DIR: '/nonexistent/dir' }, 'linux');
      assert.equal(linuxSocket, '/var/run/docker.sock');
    });

    it('dynamically reflects DOCKER_SOCKET via CONFIG.DOCKER_SOCKET_PATH getter', () => {
      const prev = process.env.DOCKER_SOCKET;
      try {
        process.env.DOCKER_SOCKET = '/tmp/test-pubctl-dynamic.sock';
        assert.equal(CONFIG.DOCKER_SOCKET_PATH, '/tmp/test-pubctl-dynamic.sock');
      } finally {
        if (prev !== undefined) {
          process.env.DOCKER_SOCKET = prev;
        } else {
          delete process.env.DOCKER_SOCKET;
        }
      }
    });
  });
});

describe('Zod Schemas Validation', () => {
  it('validates initStrictSchema properly', () => {
    const valid = initStrictSchema.parse({
      name: 'pubctl',
      email: 'admin@example.com',
      mysqlRootPassword: 'secretpassword123',
    });
    assert.equal(valid.name, 'pubctl');
    assert.equal(valid.email, 'admin@example.com');

    assert.throws(() => initStrictSchema.parse({
      name: '',
      email: 'invalid-email',
      mysqlRootPassword: '',
    }));
  });

  it('validates createStrictSchema with local storage', () => {
    const valid = createStrictSchema.parse({
      name: 'myblog',
      domain: 'blog.example.com',
      adminEmail: 'admin@example.com',
      title: 'Tech Blog',
      version: '5-alpine',
      mysqlRootPassword: 'secretpassword123',
      storage: 'local',
    });
    assert.equal(valid.name, 'myblog');
    assert.equal(valid.storage, 'local');

    // Missing S3 credentials when storage is s3
    assert.throws(() => createStrictSchema.parse({
      name: 'myblog',
      domain: 'blog.example.com',
      adminEmail: 'admin@example.com',
      mysqlRootPassword: 'secretpassword123',
      storage: 's3',
    }));
  });

  it('validates createStrictSchema with valid s3 storage', () => {
    const valid = createStrictSchema.parse({
      name: 'myblog',
      domain: 'blog.example.com',
      adminEmail: 'admin@example.com',
      mysqlRootPassword: 'secretpassword123',
      storage: 's3',
      s3Bucket: 'ghost-bucket',
      s3Key: 'access-key-id',
      s3Secret: 'secret-access-key',
    });
    assert.equal(valid.storage, 's3');
    assert.equal(valid.s3Bucket, 'ghost-bucket');
  });

  it('validates createStrictSchema in local mode for theme development', () => {
    const valid = createStrictSchema.parse({
      name: 'localblog',
      domain: 'localblog.localhost',
      adminEmail: 'admin@example.com',
      mysqlRootPassword: 'secretpassword123',
      local: true,
      themeDir: './src', // existing dir for test
    });
    assert.equal(valid.local, true);
    assert.equal(valid.domain, 'localblog.localhost');

    // Rejects non-existent theme directory
    assert.throws(() => createStrictSchema.parse({
      name: 'localblog',
      domain: 'localblog.localhost',
      adminEmail: 'admin@example.com',
      mysqlRootPassword: 'secretpassword123',
      local: true,
      themeDir: './non-existent-theme-path-xyz',
    }), /Theme directory/);
  });

  it('validates backupStrictSchema', () => {
    const valid = backupStrictSchema.parse({
      name: 'myblog',
      output: './backups',
      mysqlRootPassword: 'secretpassword123',
    });
    assert.equal(valid.name, 'myblog');

    assert.throws(() => backupStrictSchema.parse({
      name: 'Invalid_Name_With_Capital',
      output: '',
      mysqlRootPassword: '',
    }));
  });

  it('validates updateStrictSchema', () => {
    const valid = updateStrictSchema.parse({
      name: 'myblog',
      to: '6-alpine',
    });
    assert.equal(valid.to, '6-alpine');

    assert.throws(() => updateStrictSchema.parse({
      name: 'myblog',
      to: '',
    }));
  });

  it('validates deleteStrictSchema', () => {
    const valid = deleteStrictSchema.parse({
      name: 'myblog',
      keepData: false,
      mysqlRootPassword: 'rootpassword',
      yes: true,
    });
    assert.equal(valid.name, 'myblog');

    // If keepData is false, mysqlRootPassword is required
    assert.throws(() => deleteStrictSchema.parse({
      name: 'myblog',
      keepData: false,
      yes: true,
    }));

    // If keepData is true, mysqlRootPassword is not required
    assert.doesNotThrow(() => deleteStrictSchema.parse({
      name: 'myblog',
      keepData: true,
      yes: true,
    }));
  });
});

describe('Zodline CLI Flag Parsing', () => {
  it('parses create command flags and short aliases correctly', () => {
    const result = processConfig(config, [
      'create',
      '-n', 'techblog',
      '-d', 'blog.example.com',
      '-e', 'admin@example.com',
      '-t', 'My Cool Tech Blog',
      '--mysql-root-password', 'secret123',
      '--storage', 'local',
      '-l',
      '--no-interactive',
    ]);

    assert.equal(result.options.name, 'techblog');
    assert.equal(result.options.domain, 'blog.example.com');
    assert.equal(result.options.adminEmail, 'admin@example.com');
    assert.equal(result.options.title, 'My Cool Tech Blog');
    assert.equal(result.options.mysqlRootPassword, 'secret123');
    assert.equal(result.options.storage, 'local');
    assert.equal(result.options.local, true);
    assert.equal(result.options.noInteractive, true);
  });

  it('parses backup command flags and aliases', () => {
    const result = processConfig(config, [
      'backup',
      '-n', 'techblog',
      '-o', '/tmp/my-backups',
      '--mysql-root-password', 'secret123',
    ]);

    assert.equal(result.options.name, 'techblog');
    assert.equal(result.options.output, '/tmp/my-backups');
    assert.equal(result.options.mysqlRootPassword, 'secret123');
  });

  it('parses update command flags and aliases', () => {
    const result = processConfig(config, [
      'update',
      '-n', 'techblog',
      '-t', '6-alpine',
    ]);

    assert.equal(result.options.name, 'techblog');
    assert.equal(result.options.to, '6-alpine');
  });

  it('parses delete command flags and aliases', () => {
    const result = processConfig(config, [
      'delete',
      '-n', 'techblog',
      '--keep-data',
      '-y',
    ]);

    assert.equal(result.options.name, 'techblog');
    assert.equal(result.options.keepData, true);
    assert.equal(result.options.yes, true);
  });

  it('throws ZodlineError for unknown command', () => {
    assert.throws(() => processConfig(config, ['unknown-command']), (err) => {
      return err instanceof ZodlineError;
    });
  });

  it('throws ZodlineError for unknown option flag', () => {
    assert.throws(() => processConfig(config, ['create', '--non-existent-flag', 'value']), (err) => {
      return err instanceof ZodlineError;
    });
  });

  describe('normalizeArgv flag normalization', () => {
    it('normalizes snake_case flags to kebab-case while preserving values', () => {
      const normalized = normalizeArgv([
        'create',
        '--name', 'my_tenant_name',
        '--domain', 'blog.example.com',
        '--admin_email', 'admin@example.com',
        '--title', 'My_Cool_Blog',
        '--mysql_root_password', 'secret_root_123',
        '--no_interactive',
      ]);

      assert.deepEqual(normalized, [
        'create',
        '--name', 'my_tenant_name',
        '--domain', 'blog.example.com',
        '--admin-email', 'admin@example.com',
        '--title', 'My_Cool_Blog',
        '--mysql-root-password', 'secret_root_123',
        '--no-interactive',
      ]);
    });

    it('normalizes uppercase and equals-style flags', () => {
      const normalized = normalizeArgv([
        'create',
        '--MYSQL_ROOT_PASSWORD=secret_pass',
        '--KEEP_DATA',
      ]);

      assert.deepEqual(normalized, [
        'create',
        '--mysql-root-password=secret_pass',
        '--keep-data',
      ]);
    });

    it('successfully parses command with --mysql_root_password after normalization', () => {
      const args = normalizeArgv([
        'create',
        '--name', 'techblog',
        '--domain', 'blog.example.com',
        '--admin-email', 'radewala.2@gmail.com',
        '--title', 'My Tech Blog',
        '--mysql_root_password', 'RsJagjeet1997',
      ]);

      const result = processConfig(config, args);
      assert.equal(result.options.name, 'techblog');
      assert.equal(result.options.mysqlRootPassword, 'RsJagjeet1997');
      assert.equal(result.options.domain, 'blog.example.com');
      assert.equal(result.options.title, 'My Tech Blog');
    });
  });
});
