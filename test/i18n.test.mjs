import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, t, findDuplicateKeysInSource } from '../site/i18n.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_PATH = path.resolve(__dirname, '..', 'site', 'i18n.mjs');

test('site/i18n.mjs has zero duplicate keys in any language table and symmetric EN / zh-TW keys', () => {
  const source = fs.readFileSync(I18N_PATH, 'utf8');
  const duplicates = findDuplicateKeysInSource(source);
  assert.deepEqual(
    duplicates,
    [],
    `Found duplicate string keys in site/i18n.mjs: ${JSON.stringify(duplicates)}`
  );

  // Verify the detector itself catches duplicates when given bad source
  const sampleBadSource = `
    export const STRINGS = {
      en: {
        greeting: 'Hello',
        greeting: 'Duplicate!'
      },
      'zh-TW': {
        title: '標題'
      }
    };
  `;
  const detected = findDuplicateKeysInSource(sampleBadSource);
  assert.deepEqual(detected, [{ lang: 'en', key: 'greeting' }]);

  const enKeys = Object.keys(STRINGS.en).sort();
  const zhKeys = Object.keys(STRINGS['zh-TW']).sort();
  assert.deepEqual(enKeys, zhKeys, 'EN and zh-TW string tables must contain identical keys');

  // Verify no value is a function or stringified function source
  for (const [lang, table] of Object.entries(STRINGS)) {
    for (const [key, val] of Object.entries(table)) {
      assert.equal(typeof val, 'string', `${lang}.${key} must be a string`);
      assert.equal(
        /=>|function\s*\(/.test(val),
        false,
        `${lang}.${key} must not contain raw function source`
      );
    }
  }

  assert.equal(t('en', 'nav_docs'), 'Docs');
  assert.equal(t('zh-TW', 'nav_docs'), '規範文件');
});
