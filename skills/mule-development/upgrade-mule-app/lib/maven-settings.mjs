// maven-settings.mjs — refresh the Exchange <server> credential in a temp
// copy of the user's ~/.m2/settings.xml, for the skill's OWN direct `mvn`
// invocations (baseline build, Step 16/17, verify_dependency_tree.mjs).
//
// Why this exists: @salesforce/anypoint-cli-dx-mule-plugin's
// describe-connector subprocess does this same refresh internally (its own
// embedded Aether resolver merges a live CLI-session credential into a temp
// settings.xml before resolving) — that is why describe-connector needs
// DX_PLUGIN_MIN_LABEL (lib/anypoint.mjs). The skill's own `mvn` calls are a
// SEPARATE Maven invocation that the plugin has no part in, so they need the
// same refresh applied here, independently.
//
// Scope is deliberately narrow: this only refreshes the `anypoint-exchange-v3`
// <server> credential. It does NOT synthesize settings.xml from scratch and
// does NOT touch Nexus/orbit <server> entries — those are long-lived personal
// credentials that are already present in a provisioned ~/.m2/settings.xml
// and pass through untouched. If the exchange-v3 block isn't present at all,
// this is a no-op (patched: false) — synthesizing one from scratch is the
// plugin's job (lib/helpers/exchange-settings.js), not the skill's.
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { anypointEnv } from './anypoint.mjs';

const EXCHANGE_SERVER_ID = 'anypoint-exchange-v3';

// ACB (Anypoint Code Builder) has its own, separate Maven settings file —
// acb_settings.xml, written by mule-dx-platform's DefaultSettingsManager
// under <mule.homeDirectory, default ~/AnypointCodeBuilder>/.tmp/<backend-pid>/.
// ACB keeps the anypoint-exchange-v3 <server> credential in that file fresh
// on its own token-refresh timer, driven by the IDE's native "Sign in"
// session (VS Code AuthenticationSession + its own KeyStore) — a DIFFERENT
// credential store than `anypoint-cli-v4 conf`, which only knows about a
// separate `anypoint-cli-v4 login`. A customer who only ever signs in
// through ACB's own UI has nothing in `anypoint-cli-v4 conf`, so this is the
// fallback: if the CLI has no session, look for a live acb_settings.xml and
// borrow its already-fresh Exchange credential.
const ACB_TEMP_DIR_DEFAULT = join(homedir(), 'AnypointCodeBuilder', '.tmp');

// Same precedence as the plugin: a static Connected App beats the short-lived
// session bearer token.
function readConfValue(key) {
  const r = spawnSync('anypoint-cli-v4', ['conf', key], { env: anypointEnv(), encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return '';
  return (r.stdout || '').trim();
}

// `anypoint-cli-v4 conf token` has been observed printing either a bare token
// string or a JSON-ish `{token: '...'}` wrapper (same two shapes the plugin's
// own Conf.get('token') unwraps) — handle both without assuming either.
function unwrapToken(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string') return parsed.token;
  } catch {
    // Not JSON — fall through to treating it as the raw token string.
  }
  return raw;
}

// Find the <server> block whose <id> is EXCHANGE_SERVER_ID. Returns the
// matched block text, or null.
function findExchangeServerBlock(xml) {
  const serverRe = /<server\b[^>]*>[\s\S]*?<\/server>/g;
  let m;
  while ((m = serverRe.exec(xml)) !== null) {
    const idMatch = /<id>\s*([^<]*?)\s*<\/id>/.exec(m[0]);
    if (idMatch && idMatch[1] === EXCHANGE_SERVER_ID) return m[0];
  }
  return null;
}

// Read-only: extract { username, password } from the anypoint-exchange-v3
// <server> block of an arbitrary settings-shaped XML file (used against
// ACB's acb_settings.xml, never against the real ~/.m2/settings.xml).
function extractExchangeServerCredential(xml) {
  const block = findExchangeServerBlock(xml);
  if (!block) return null;
  const username = /<username>([\s\S]*?)<\/username>/.exec(block)?.[1]?.trim();
  const password = /<password>([\s\S]*?)<\/password>/.exec(block)?.[1]?.trim();
  if (!username || !password) return null;
  return { username, password };
}

// Scan <acbTempDir>/<any-subdir>/acb_settings.xml and return the credential
// from whichever one was modified most recently — ACB refreshes the file on
// a timer while its backend is running, so recency is the best signal for
// "the currently active session" without knowing the backend's actual PID.
function readAcbSettingsCredentials(acbTempDir) {
  if (!existsSync(acbTempDir)) return null;
  let entries;
  try {
    entries = readdirSync(acbTempDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => join(acbTempDir, e.name, 'acb_settings.xml'))
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p, mtimeMs: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) return null;

  const xml = readFileSync(candidates[0].path, 'utf8');
  return extractExchangeServerCredential(xml);
}

function readCredentials(opts) {
  const clientId = readConfValue('client_id');
  const clientSecret = readConfValue('client_secret');
  if (clientId && clientSecret) {
    return { kind: 'client', username: '~~~Client~~~', password: `${clientId}~?~${clientSecret}` };
  }
  const token = unwrapToken(readConfValue('token'));
  if (token) {
    return { kind: 'token', username: '~~~Token~~~', password: token };
  }

  const acbTempDir = opts.acbTempDir || ACB_TEMP_DIR_DEFAULT;
  const acbCreds = readAcbSettingsCredentials(acbTempDir);
  if (acbCreds) {
    return { kind: 'acb', username: acbCreds.username, password: acbCreds.password };
  }

  return null;
}

// Replace (or insert) <username>/<password> inside the <server> block whose
// <id> is EXCHANGE_SERVER_ID. Tolerant of child-element order and whitespace;
// every other <server>/<profile>/<mirror> in the file is left byte-for-byte
// untouched. Returns { xml, found }.
function patchExchangeServer(xml, creds) {
  const serverRe = /<server\b[^>]*>[\s\S]*?<\/server>/g;
  let found = false;
  const patched = xml.replace(serverRe, (block) => {
    const idMatch = /<id>\s*([^<]*?)\s*<\/id>/.exec(block);
    if (!idMatch || idMatch[1] !== EXCHANGE_SERVER_ID) return block;
    found = true;
    let next = block;
    next = /<username>[\s\S]*?<\/username>/.test(next)
      ? next.replace(/<username>[\s\S]*?<\/username>/, `<username>${creds.username}</username>`)
      : next.replace(/<\/server>/, `  <username>${creds.username}</username>\n</server>`);
    next = /<password>[\s\S]*?<\/password>/.test(next)
      ? next.replace(/<password>[\s\S]*?<\/password>/, `<password>${creds.password}</password>`)
      : next.replace(/<\/server>/, `  <password>${creds.password}</password>\n</server>`);
    return next;
  });
  return { xml: patched, found };
}

/**
 * Writes a temp copy of the user's ~/.m2/settings.xml with the
 * anypoint-exchange-v3 <server> credential refreshed from the live CLI
 * session (or, when that session is empty, ACB's own acb_settings.xml).
 * Never mutates the real settings.xml.
 *
 * @param {{ sourcePath?: string, acbTempDir?: string }} [opts] sourcePath
 *   overrides ~/.m2/settings.xml, acbTempDir overrides
 *   ~/AnypointCodeBuilder/.tmp (for tests).
 * @returns {{ path: string, patched: boolean, credentialKind: 'client'|'token'|'acb'|null, warning?: string }}
 *   path is always usable with `mvn -s <path>` — when nothing could be
 *   patched, path points at an unmodified copy of the source (or the source
 *   itself, if there is no source) so the caller can pass -s unconditionally.
 */
export function writeMavenSettings(opts = {}) {
  const sourcePath = opts.sourcePath || join(homedir(), '.m2', 'settings.xml');

  if (!existsSync(sourcePath)) {
    return { path: sourcePath, patched: false, credentialKind: null, warning: `${sourcePath} not found; mvn will run with no custom settings.` };
  }

  const creds = readCredentials(opts);
  const xml = readFileSync(sourcePath, 'utf8');
  if (!creds) {
    return { path: sourcePath, patched: false, credentialKind: null, warning: 'No Anypoint CLI session credentials found (anypoint-cli-v4 conf client_id/client_secret/token empty, and no acb_settings.xml session found); using settings.xml as-is.' };
  }

  const { xml: patchedXml, found } = patchExchangeServer(xml, creds);
  if (!found) {
    return { path: sourcePath, patched: false, credentialKind: null, warning: `No <server><id>${EXCHANGE_SERVER_ID}</id> block found in ${sourcePath}; using settings.xml as-is.` };
  }

  const dir = mkdtempSync(join(tmpdir(), 'upgrade-mule-app-mvn-settings-'));
  const outPath = join(dir, 'settings.xml');
  writeFileSync(outPath, patchedXml, { mode: 0o600 });
  return { path: outPath, patched: true, credentialKind: creds.kind };
}

// writeMavenSettings() can only forward whatever credential the live CLI
// session currently reports — it has no way to know that credential is dead
// until Maven actually tries to use it. A 401 at that point is an EXPIRED
// SESSION, not a build defect: no code edit will fix it, and the Step 16/17
// retry classifiers must not burn a retry guessing at one. This is the
// signal callers check to route to "ask the user to re-login" instead.
const AUTH_FAILURE_RE =
  /\b401\b|status code:\s*401|ReasonPhrase:\s*Unauthorized|Not authorized to access|\bUnauthorized\b/i;

/**
 * @param {string} mvnOutput combined stdout+stderr from a failed mvn run.
 * @returns {boolean} true when the failure looks like an expired/invalid
 *   Anypoint CLI session rather than a code/XSD/dependency defect.
 */
export function looksLikeAuthFailure(mvnOutput) {
  return AUTH_FAILURE_RE.test(mvnOutput || '');
}
