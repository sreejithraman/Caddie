import { readFile } from 'node:fs/promises';
import {
  inspectLocalGitSourceInProcess,
  inspectProjectCheckoutInProcess,
  inspectProjectCheckoutMarkerInProcess,
} from './local-source.mjs';

const [, , operation, rawInput] = process.argv;

try {
  const input = JSON.parse(rawInput);
  let result;
  if (operation === 'read-text') {
    result = { text: await readFile(input.filePath, 'utf8') };
  } else if (operation === 'inspect-local-git') {
    result = await inspectLocalGitSourceInProcess(input);
  } else if (operation === 'inspect-project-checkout') {
    result = await inspectProjectCheckoutInProcess(input);
  } else if (operation === 'inspect-project-marker') {
    result = await inspectProjectCheckoutMarkerInProcess(input);
  } else {
    throw Object.assign(new Error('Local source worker operation is not supported'), { code: 'invalid-worker-operation' });
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'source-unavailable',
      message: typeof error?.message === 'string' ? error.message : 'Local source could not be inspected',
      details: error?.details && typeof error.details === 'object' ? error.details : {},
    },
  }));
}
