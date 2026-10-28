// Run: node --test skills/mule-development/upgrade-mule-app/lib/maven-settings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMavenSettings, looksLikeAuthFailure } from './maven-settings.mjs';

// These tests exercise the pure settings.xml patching path with a fixture
// source file. They don't depend on a real anypoint-cli-v4 session, so they
// stub readCredentials indirectly by pointing PATH at a fake `anypoint-cli-v4`
// shell shim that prints deterministic conf values.
function withFakeCli(confValues, fn) {
  const binDir = mkdtempSync(join(tmpdir(), 'fake-anypoint-cli-'));
  const script = `#!/bin/sh
if [ "$1" = "conf" ]; then
  case "$2" in
    client_id) printf '%s' "${confValues.client_id || ''}" ;;
    client_secret) printf '%s' "${confValues.client_secret || ''}" ;;
    token) printf '%s' "${confValues.token || ''}" ;;
    *) printf '' ;;
  esac
  exit 0
fi
exit 1
`;
  const binPath = join(binDir, 'anypoint-cli-v4');
  writeFileSync(binPath, script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    fn();
  } finally {
    process.env.PATH = prevPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

function fixtureSettings(dir) {
  const p = join(dir, 'settings.xml');
  writeFileSync(p, `<settings>
  <servers>
    <server>
      <id>nexus3</id>
      <username>marinarivero</username>
      <password>unrelated-nexus-secret</password>
    </server>
    <server>
      <username>stale-user</username>
      <password>stale-expired-token</password>
      <id>anypoint-exchange-v3</id>
    </server>
  </servers>
</settings>
`);
  return p;
}

test('writeMavenSettings refreshes only the anypoint-exchange-v3 server, leaves others untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettings(dir);
  withFakeCli({ token: 'fresh-session-token' }, () => {
    const result = writeMavenSettings({ sourcePath });
    assert.equal(result.patched, true);
    assert.equal(result.credentialKind, 'token');
    const out = readFileSync(result.path, 'utf8');
    assert.match(out, /<id>anypoint-exchange-v3<\/id>/);
    assert.match(out, /<username>~~~Token~~~<\/username>/);
    assert.match(out, /<password>fresh-session-token<\/password>/);
    // Nexus entry is untouched.
    assert.match(out, /<username>marinarivero<\/username>/);
    assert.match(out, /<password>unrelated-nexus-secret<\/password>/);
    assert.doesNotMatch(out, /stale-expired-token/);
  });
  rmSync(dir, { recursive: true, force: true });
});

test('writeMavenSettings prefers a Connected App over a bearer token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettings(dir);
  withFakeCli({ client_id: 'abc', client_secret: 'def', token: 'should-not-be-used' }, () => {
    const result = writeMavenSettings({ sourcePath });
    assert.equal(result.credentialKind, 'client');
    const out = readFileSync(result.path, 'utf8');
    assert.match(out, /<username>~~~Client~~~<\/username>/);
    assert.match(out, /<password>abc~\?~def<\/password>/);
  });
  rmSync(dir, { recursive: true, force: true });
});

test('writeMavenSettings is a no-op (warning, original path) when no CLI credentials exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettings(dir);
  withFakeCli({}, () => {
    const result = writeMavenSettings({ sourcePath });
    assert.equal(result.patched, false);
    assert.equal(result.credentialKind, null);
    assert.equal(result.path, sourcePath);
    assert.ok(result.warning);
  });
  rmSync(dir, { recursive: true, force: true });
});

test('writeMavenSettings is a no-op when the source settings.xml has no exchange-v3 server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = join(dir, 'settings.xml');
  writeFileSync(sourcePath, '<settings><servers><server><id>nexus3</id><username>u</username><password>p</password></server></servers></settings>\n');
  withFakeCli({ token: 'fresh-session-token' }, () => {
    const result = writeMavenSettings({ sourcePath });
    assert.equal(result.patched, false);
    assert.equal(result.path, sourcePath);
    assert.ok(result.warning);
  });
  rmSync(dir, { recursive: true, force: true });
});

test('writeMavenSettings is a no-op when the source file does not exist', () => {
  const result = writeMavenSettings({ sourcePath: '/nonexistent/path/settings.xml' });
  assert.equal(result.patched, false);
  assert.equal(result.path, '/nonexistent/path/settings.xml');
  assert.ok(result.warning);
});

test('looksLikeAuthFailure detects common Maven 401/Unauthorized phrasings', () => {
  assert.ok(looksLikeAuthFailure(
    'Could not transfer artifact ... from/to anypoint-exchange-v3: status code: 401, reason phrase: Unauthorized (401)'
  ));
  assert.ok(looksLikeAuthFailure('Return code is: 401, ReasonPhrase: Unauthorized.'));
  assert.ok(looksLikeAuthFailure('Not authorized to access group com.mulesoft.connectors'));
  assert.ok(looksLikeAuthFailure('401 Unauthorized'));
});

test('looksLikeAuthFailure does not flag an unrelated build failure', () => {
  assert.equal(looksLikeAuthFailure(
    '[ERROR] cvc-complex-type.3.2.2: Attribute \'method\' is not allowed to appear in element \'http:listener\''
  ), false);
  assert.equal(looksLikeAuthFailure(''), false);
  assert.equal(looksLikeAuthFailure(undefined), false);
});
