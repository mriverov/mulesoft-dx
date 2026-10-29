// Run: node --test skills/mule-development/upgrade-mule-app/lib/maven-settings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
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

function fixtureSettingsV2Only(dir) {
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
      <id>anypoint-exchange-v2</id>
    </server>
  </servers>
</settings>
`);
  return p;
}

function fixtureSettingsV2AndV3(dir) {
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
      <id>anypoint-exchange-v2</id>
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

test('writeMavenSettings refreshes a legacy anypoint-exchange-v2 server when v3 is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettingsV2Only(dir);
  withFakeCli({ token: 'fresh-session-token' }, () => {
    const result = writeMavenSettings({ sourcePath });
    assert.equal(result.patched, true);
    assert.equal(result.credentialKind, 'token');
    const out = readFileSync(result.path, 'utf8');
    assert.match(out, /<id>anypoint-exchange-v2<\/id>/);
    assert.match(out, /<password>fresh-session-token<\/password>/);
    assert.doesNotMatch(out, /stale-expired-token/);
  });
  rmSync(dir, { recursive: true, force: true });
});

test('writeMavenSettings refreshes both anypoint-exchange-v2 and anypoint-exchange-v3 when both are present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettingsV2AndV3(dir);
  withFakeCli({ token: 'fresh-session-token' }, () => {
    const result = writeMavenSettings({ sourcePath });
    assert.equal(result.patched, true);
    const out = readFileSync(result.path, 'utf8');
    const matches = out.match(/<password>fresh-session-token<\/password>/g) || [];
    assert.equal(matches.length, 2);
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

// No acbTempDir override here is deliberately wrong — a real ACB install can
// have a live acb_settings.xml under ~/AnypointCodeBuilder/.tmp, and this
// function is the "no session anywhere" case, so it must point at a
// guaranteed-empty directory instead of trusting the ambient default.
function emptyAcbTempDir() {
  return mkdtempSync(join(tmpdir(), 'acb-tmp-empty-'));
}

function writeAcbSettingsFixture(acbTempDir, pidDirName, username, password, mtimeOffsetMs = 0) {
  const pidDir = join(acbTempDir, pidDirName);
  mkdirSync(pidDir, { recursive: true });
  const p = join(pidDir, 'acb_settings.xml');
  writeFileSync(p, `<settings>
  <servers>
    <server>
      <id>nexus3</id>
      <username>acb-nexus-user</username>
      <password>acb-nexus-secret</password>
    </server>
    <server>
      <username>${username}</username>
      <password>${password}</password>
      <id>anypoint-exchange-v3</id>
    </server>
  </servers>
</settings>
`);
  if (mtimeOffsetMs !== 0) {
    const t = new Date(Date.now() + mtimeOffsetMs);
    utimesSync(p, t, t);
  }
  return p;
}

test('writeMavenSettings is a no-op (warning, original path) when no CLI credentials and no acb_settings.xml exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettings(dir);
  const acbTempDir = emptyAcbTempDir();
  withFakeCli({}, () => {
    const result = writeMavenSettings({ sourcePath, acbTempDir });
    assert.equal(result.patched, false);
    assert.equal(result.credentialKind, null);
    assert.equal(result.path, sourcePath);
    assert.ok(result.warning);
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(acbTempDir, { recursive: true, force: true });
});

test('writeMavenSettings falls back to acb_settings.xml when the CLI session is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettings(dir);
  const acbTempDir = emptyAcbTempDir();
  writeAcbSettingsFixture(acbTempDir, '12345', '~~~Token~~~', 'acb-live-session-token');
  withFakeCli({}, () => {
    const result = writeMavenSettings({ sourcePath, acbTempDir });
    assert.equal(result.patched, true);
    assert.equal(result.credentialKind, 'acb');
    const out = readFileSync(result.path, 'utf8');
    assert.match(out, /<username>~~~Token~~~<\/username>/);
    assert.match(out, /<password>acb-live-session-token<\/password>/);
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(acbTempDir, { recursive: true, force: true });
});

test('writeMavenSettings prefers the anypoint-cli-v4 session over acb_settings.xml when both exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettings(dir);
  const acbTempDir = emptyAcbTempDir();
  writeAcbSettingsFixture(acbTempDir, '12345', '~~~Token~~~', 'acb-session-should-not-be-used');
  withFakeCli({ token: 'cli-session-token' }, () => {
    const result = writeMavenSettings({ sourcePath, acbTempDir });
    assert.equal(result.credentialKind, 'token');
    const out = readFileSync(result.path, 'utf8');
    assert.match(out, /<password>cli-session-token<\/password>/);
    assert.doesNotMatch(out, /acb-session-should-not-be-used/);
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(acbTempDir, { recursive: true, force: true });
});

test('writeMavenSettings picks the most recently modified acb_settings.xml when several PID dirs exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = fixtureSettings(dir);
  const acbTempDir = emptyAcbTempDir();
  writeAcbSettingsFixture(acbTempDir, 'old-pid', '~~~Token~~~', 'stale-backend-session', -60_000);
  writeAcbSettingsFixture(acbTempDir, 'new-pid', '~~~Token~~~', 'active-backend-session', 0);
  withFakeCli({}, () => {
    const result = writeMavenSettings({ sourcePath, acbTempDir });
    assert.equal(result.credentialKind, 'acb');
    const out = readFileSync(result.path, 'utf8');
    assert.match(out, /<password>active-backend-session<\/password>/);
    assert.doesNotMatch(out, /stale-backend-session/);
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(acbTempDir, { recursive: true, force: true });
});

test('writeMavenSettings synthesizes both exchange blocks from scratch when settings.xml has neither (Scenario H)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = join(dir, 'settings.xml');
  writeFileSync(sourcePath, '<settings><servers><server><id>nexus3</id><username>u</username><password>p</password></server></servers></settings>\n');
  withFakeCli({ token: 'fresh-session-token' }, () => {
    const result = writeMavenSettings({ sourcePath });
    assert.equal(result.patched, true);
    assert.equal(result.credentialKind, 'token');
    const out = readFileSync(result.path, 'utf8');
    assert.match(out, /<id>anypoint-exchange-v2<\/id>/);
    assert.match(out, /<id>anypoint-exchange-v3<\/id>/);
    const matches = out.match(/<password>fresh-session-token<\/password>/g) || [];
    assert.equal(matches.length, 2);
    // nexus3 and the real settings.xml on disk are both untouched.
    assert.match(out, /<id>nexus3<\/id>/);
    assert.equal(readFileSync(sourcePath, 'utf8'), '<settings><servers><server><id>nexus3</id><username>u</username><password>p</password></server></servers></settings>\n');
  });
  rmSync(dir, { recursive: true, force: true });
});

test('writeMavenSettings synthesizes a <servers> container when settings.xml has none at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = join(dir, 'settings.xml');
  writeFileSync(sourcePath, '<settings></settings>\n');
  withFakeCli({ token: 'fresh-session-token' }, () => {
    const result = writeMavenSettings({ sourcePath });
    assert.equal(result.patched, true);
    const out = readFileSync(result.path, 'utf8');
    assert.match(out, /<id>anypoint-exchange-v2<\/id>/);
    assert.match(out, /<id>anypoint-exchange-v3<\/id>/);
  });
  rmSync(dir, { recursive: true, force: true });
});

test('writeMavenSettings is a no-op when the source settings.xml has no <settings> root at all (Scenario F)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maven-settings-fixture-'));
  const sourcePath = join(dir, 'settings.xml');
  writeFileSync(sourcePath, '');
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
