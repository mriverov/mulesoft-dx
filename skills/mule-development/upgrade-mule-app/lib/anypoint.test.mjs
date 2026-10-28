// Run: node --test skills/mule-development/upgrade-mule-app/lib/anypoint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDxPluginVersion, isDxPluginAtLeastMin, DX_PLUGIN_MIN_LABEL } from './anypoint.mjs';

test('parseDxPluginVersion reads "name x.y.z" from plugins output', () => {
  const out = '@salesforce/anypoint-cli-dx-mule-plugin 1.3.1\nanother-plugin 2.0.0\n';
  assert.deepEqual(parseDxPluginVersion(out), { major: 1, minor: 3, patch: 1, version: '1.3.1' });
});

test('parseDxPluginVersion accepts an optional leading "v"', () => {
  assert.deepEqual(
    parseDxPluginVersion('@salesforce/anypoint-cli-dx-mule-plugin v1.3.1'),
    { major: 1, minor: 3, patch: 1, version: '1.3.1' }
  );
});

test('parseDxPluginVersion returns null when the plugin line is absent', () => {
  assert.equal(parseDxPluginVersion('some-other-plugin 1.0.0\n'), null);
  assert.equal(parseDxPluginVersion(''), null);
});

test('isDxPluginAtLeastMin: exactly at the floor passes', () => {
  assert.equal(isDxPluginAtLeastMin({ major: 1, minor: 3, patch: 1 }), true);
  assert.equal(DX_PLUGIN_MIN_LABEL, '1.3.1');
});

test('isDxPluginAtLeastMin: below the floor on patch/minor fails', () => {
  assert.equal(isDxPluginAtLeastMin({ major: 1, minor: 3, patch: 0 }), false);
  assert.equal(isDxPluginAtLeastMin({ major: 1, minor: 2, patch: 9 }), false);
});

test('isDxPluginAtLeastMin: above the floor on minor/major passes', () => {
  assert.equal(isDxPluginAtLeastMin({ major: 1, minor: 4, patch: 0 }), true);
  assert.equal(isDxPluginAtLeastMin({ major: 2, minor: 0, patch: 0 }), true);
});
