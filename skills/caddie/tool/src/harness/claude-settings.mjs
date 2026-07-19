import { createRequire } from 'node:module';

import { invalid } from '../protocol/errors.mjs';

const require = createRequire(import.meta.url);
const { harnessSettingValue } = require('../layout');
const { applyEdits, modify, parse } = require('../../vendor/jsonc-parser.cjs');

export const claudeSettings = Object.freeze({
  harness: 'claude',
  ownership({ skill }) {
    return { key: skill, value: harnessSettingValue('claude') };
  },
  render({ text, skill, desired, owned }) {
    const errors = [];
    const value = text.trim() ? parse(text, errors, { allowTrailingComma: false, disallowComments: true }) : {};
    if (errors.length > 0) {
      throw invalid('invalid-harness-settings', 'Claude settings are not valid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw invalid('invalid-harness-settings', 'Claude settings must be a JSON object');
    }
    if (value.skillOverrides !== undefined
      && (!value.skillOverrides || typeof value.skillOverrides !== 'object' || Array.isArray(value.skillOverrides))) {
      throw invalid('invalid-harness-settings', 'Claude skillOverrides must be an object');
    }
    const overrides = value.skillOverrides ?? {};
    const current = overrides[skill];
    if (owned && current !== 'off') throw invalid('harness-setting-drift', `Caddie-owned Claude setting changed for ${skill}`);
    if (desired) {
      if (!owned) return { text, changed: false, owned: false };
      const removePath = owned.containerCreated && Object.keys(overrides).length === 1
        ? ['skillOverrides']
        : ['skillOverrides', skill];
      return changedText(text, removePath, undefined, false, undefined, {
        transferContainerOwnership: owned.containerCreated && Object.keys(overrides).length > 1,
      });
    } else {
      if (owned) return { text, changed: false, owned: true };
      if (current !== undefined) {
        if (current === 'off') return { text, changed: false, owned: false };
        throw invalid('harness-setting-collision', `Claude already configures selected skill: ${skill}`);
      }
      return changedText(text, ['skillOverrides', skill], 'off', true, {
        containerCreated: value.skillOverrides === undefined,
      });
    }
  },
});

function changedText(text, jsonPath, value, owned, ownership, result = {}) {
  const source = text.trim() ? text : '{}\n';
  const edits = modify(source, jsonPath, value, { formattingOptions: formattingFor(source) });
  return { text: applyEdits(source, edits), changed: true, owned, ownership, ...result };
}

function formattingFor(text) {
  const indentation = text.match(/^(\s+)["}]/m)?.[1] ?? '  ';
  return {
    insertSpaces: !indentation.includes('\t'),
    tabSize: indentation.includes('\t') ? 1 : indentation.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}
