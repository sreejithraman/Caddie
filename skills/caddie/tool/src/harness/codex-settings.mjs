import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { invalid } from '../protocol/errors.mjs';

const require = createRequire(import.meta.url);
const { parse } = require('../../vendor/smol-toml.cjs');
const { harnessSettingValue } = require('../layout');

export const codexSettings = Object.freeze({
  harness: 'codex',
  ownership({ skillFile }) {
    return { key: skillFile, value: harnessSettingValue('codex') };
  },
  render({ text, skillFile, desired, owned }) {
    const token = crypto.createHash('sha256').update(skillFile).digest('hex');
    const start = `# caddie:begin skill-enablement ${token}`;
    const end = `# caddie:end skill-enablement ${token}`;
    const block = `${start}\n[[skills.config]]\npath = ${JSON.stringify(skillFile)}\nenabled = false\n${end}`;
    const pattern = new RegExp(`(?:^|\\n)${escapeRegex(start)}\\n[\\s\\S]*?\\n${escapeRegex(end)}(?:\\n|$)`);
    const match = text.match(pattern);
    const configs = readSkillConfigs(text).filter((entry) => entry?.path === skillFile);
    if (owned) {
      const markerCount = text.split(start).length - 1;
      if (markerCount !== 1 || !match || match[0].trim() !== block
        || configs.length !== 1 || configs[0].enabled !== false) {
        throw invalid('harness-setting-drift', `Caddie-owned Codex setting changed for ${skillFile}`);
      }
    }
    if (desired) {
      if (!owned) return unchanged(text, false);
      return changed(normaliseTrailingNewline(text.replace(pattern, '\n')), false);
    }
    if (owned) return unchanged(text, true);

    if (configs.length > 0) {
      if (configs.length === 1 && configs[0].enabled === false) return unchanged(text, false);
      throw invalid('harness-setting-collision', `Codex already configures selected skill: ${skillFile}`);
    }
    return changed(`${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}\n`, true);
  },
});

function readSkillConfigs(text) {
  let document;
  try { document = text.trim() ? parse(text) : {}; } catch (cause) {
    throw invalid('invalid-harness-settings', 'Codex settings are not valid TOML', { reason: cause.message });
  }
  const configs = document?.skills?.config;
  if (configs === undefined) return [];
  if (!Array.isArray(configs)) throw invalid('invalid-harness-settings', 'Codex skills.config must be an array of tables');
  return configs;
}

function changed(text, owned) {
  return { text, changed: true, owned };
}

function unchanged(text, owned) {
  return { text, changed: false, owned };
}

function normaliseTrailingNewline(text) {
  return text.trim() ? `${text.trimEnd()}\n` : '';
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
