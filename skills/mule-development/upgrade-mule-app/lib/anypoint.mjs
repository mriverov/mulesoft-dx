// anypoint.mjs — wrap anypoint-cli-v4 invocations and toolchain probes.
import { spawnSync } from 'node:child_process';

/** @param {Record<string,string>} [extra] Overrides merged last. @returns {Record<string,string>} A child env with ANYPOINT_ENV unset and NODE_NO_WARNINGS=1. */
export function anypointEnv(extra = {}) {
  const env = { ...process.env };
  delete env.ANYPOINT_ENV;
  env.NODE_NO_WARNINGS = '1';
  return { ...env, ...extra };
}

// Required DX Mule plugin floor. Two independent failure modes land on the
// same floor: (1) `dx mule jdk download` — used to auto-provision the
// source/target JDK (Steps 3b/13) — only exists in
// @salesforce/anypoint-cli-dx-mule-plugin >= 1.3.0; older plugins pass the
// `dx --help` presence check but fail at JDK-download time. (2)
// `describe-connector`'s session-token auth path for Exchange-gated
// connectors (objectstore, secure-config) only works correctly >= 1.3.1 —
// below that it authenticates fine for connectors resolvable without
// Exchange but exits 0 with an empty/failed response for Exchange-gated ones.
// 1.3.1 is a strict superset of 1.3.0, so one floor covers both.
export const DX_PLUGIN_MIN_MAJOR = 1;
export const DX_PLUGIN_MIN_MINOR = 3;
export const DX_PLUGIN_MIN_PATCH = 1;
export const DX_PLUGIN_MIN_LABEL = `${DX_PLUGIN_MIN_MAJOR}.${DX_PLUGIN_MIN_MINOR}.${DX_PLUGIN_MIN_PATCH}`;
export const DX_PLUGIN_UPGRADE_CMD = 'npm install -g @salesforce/anypoint-cli-dx-mule-plugin@latest';

/** Parse "@salesforce/anypoint-cli-dx-mule-plugin 1.3.1" from `anypoint-cli-v4
 * plugins`. @param {string} out @returns {{major:number,minor:number,patch:number,version:string}|null} */
export function parseDxPluginVersion(out) {
  const m = /@salesforce\/anypoint-cli-dx-mule-plugin\s+v?(\d+)\.(\d+)\.(\d+)/i.exec(out);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    version: `${m[1]}.${m[2]}.${m[3]}`,
  };
}

/** True when the parsed DX plugin version is >= the required floor (DX_PLUGIN_MIN_LABEL).
 * @param {{major:number,minor:number,patch:number}} v @returns {boolean} */
export function isDxPluginAtLeastMin(v) {
  if (v.major !== DX_PLUGIN_MIN_MAJOR) return v.major > DX_PLUGIN_MIN_MAJOR;
  if (v.minor !== DX_PLUGIN_MIN_MINOR) return v.minor > DX_PLUGIN_MIN_MINOR;
  return v.patch >= DX_PLUGIN_MIN_PATCH;
}

/** Read the installed DX plugin version via `anypoint-cli-v4 plugins` and report
 * whether it meets DX_PLUGIN_MIN_LABEL. Used both at Step 1 (pre-check) and
 * reactively at describe-connector's failure point (correlate, don't guess).
 * @returns {{parsed:{major:number,minor:number,patch:number,version:string}|null, inRange:boolean}} */
export function checkDxPluginVersion() {
  const r = spawnSync('anypoint-cli-v4', ['plugins'], { env: anypointEnv(), encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return { parsed: null, inRange: false };
  const parsed = parseDxPluginVersion(`${r.stdout || ''}${r.stderr || ''}`);
  if (!parsed) return { parsed: null, inRange: false };
  return { parsed, inRange: isDxPluginAtLeastMin(parsed) };
}

/** @param {string} cmd Executable. @param {string[]} args Argv. @param {{env?:Record<string,string>}} [opts] @returns {{status:number|null, signal:string|null, error:Error|undefined, stdout:string, stderr:string}} Synchronous spawn capture with anypointEnv() applied. */
export function runProbe(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    env: anypointEnv(opts.env),
    encoding: 'utf8',
    shell: false,
    // Exchange `asset describe --output json` for large connectors (http, db)
    // exceeds Node's 1 MB default, yielding ENOBUFS/SIGTERM/status:null. Lift
    // the cap so the full JSON is captured.
    maxBuffer: Infinity,
  });
  return {
    status: r.status,
    signal: r.signal,
    error: r.error,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// The CLI prints a "Fetching..." preamble before the JSON. Slice from the first { or [.
function sliceCliJson(out) {
  const o = out.indexOf('{'), a = out.indexOf('[');
  const start = a === -1 ? o : (o === -1 ? a : Math.min(o, a));
  if (start === -1) return null;
  try { return JSON.parse(out.slice(start)); } catch { return null; }
}

/** Page `exchange asset list` (fuzzy and paginated; API caps limit at 250) to
 * exhaustion and return every row whose groupId+assetId match exactly.
 * @param {string} groupId @param {string} artifactId @returns {object[]} */
export function listExactGaRows(groupId, artifactId) {
  const PAGE_SIZE = 200; // must stay <= the API's 250 ceiling
  const MAX_PAGES = 50;  // runaway guard (~10k rows)
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = runProbe('anypoint-cli-v4',
      ['exchange', 'asset', 'list', artifactId, '--output', 'json',
       '--limit', String(PAGE_SIZE), '--offset', String(page * PAGE_SIZE)]);
    if (r.status !== 0) break;
    const rows = sliceCliJson(r.stdout);
    if (!Array.isArray(rows)) break;
    for (const a of rows) if (a && a.groupId === groupId && a.assetId === artifactId) out.push(a);
    if (rows.length < PAGE_SIZE) break; // short page => list exhausted
  }
  return out;
}
