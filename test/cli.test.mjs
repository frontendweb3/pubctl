import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { validateDomain, validateEmail, validateTenantName } = require('../dist/validation.js');

test('validation accepts safe tenant input', () => {
  assert.doesNotThrow(() => validateTenantName('blog_2026'));
  assert.doesNotThrow(() => validateDomain('blog.example.com'));
  assert.doesNotThrow(() => validateEmail('admin@example.com'));
});

test('validation rejects unsafe tenant input', () => {
  assert.throws(() => validateTenantName('bad-name'), /Tenant name/);
  assert.throws(() => validateDomain('https://blog.example.com'), /Domain/);
  assert.throws(() => validateEmail('not-an-email'), /email/);
});
