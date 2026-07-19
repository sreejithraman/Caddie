import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'skills', 'caddie', 'tool', 'vendor');
const check = process.argv.slice(2).includes('--check');
const outputRoot = check ? await mkdtemp(path.join(os.tmpdir(), 'caddie-jsonc-vendor-')) : vendorRoot;
const packageRoot = path.join(root, 'node_modules', 'jsonc-parser');
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const license = await readFile(path.join(packageRoot, 'LICENSE.md'), 'utf8');

try {
  await mkdir(outputRoot, { recursive: true });
  await build({
    entryPoints: [path.join(packageRoot, 'lib', 'esm', 'main.js')],
    outfile: path.join(outputRoot, 'jsonc-parser.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    legalComments: 'none',
    banner: { js: `/*!
jsonc-parser ${packageJson.version} — ${packageJson.license}

${license.replace(/\r\n/g, '\n').trim()}
*/` },
  });

  if (check) {
    const [generated, committed] = await Promise.all([
      readFile(path.join(outputRoot, 'jsonc-parser.cjs')),
      readFile(path.join(vendorRoot, 'jsonc-parser.cjs')),
    ]);
    if (!generated.equals(committed)) throw new Error('Vendored JSONC artifact is stale: jsonc-parser.cjs');
  }
} finally {
  if (check) await rm(outputRoot, { recursive: true, force: true });
}
