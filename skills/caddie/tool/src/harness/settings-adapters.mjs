import { createRequire } from 'node:module';

import { claudeSettings } from './claude-settings.mjs';
import { codexSettings } from './codex-settings.mjs';

const require = createRequire(import.meta.url);
const { supportedHarnesses } = require('../layout');
const adapters = [codexSettings, claudeSettings];
const actual = adapters.map(({ harness }) => harness).sort();
const expected = [...supportedHarnesses()].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`Harness settings adapters do not cover the descriptor registry: ${actual.join(', ')}`);
}

export const settingsAdapters = Object.freeze(adapters);
