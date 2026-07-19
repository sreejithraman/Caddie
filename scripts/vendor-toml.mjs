import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'skills', 'caddie', 'tool', 'vendor');
const check = process.argv.slice(2).includes('--check');
const outputRoot = check ? await mkdtemp(path.join(os.tmpdir(), 'caddie-toml-vendor-')) : vendorRoot;
const tomlRoot = path.join(root, 'node_modules', 'smol-toml');
const tomlPackage = JSON.parse(await readFile(path.join(tomlRoot, 'package.json'), 'utf8'));
const tomlLicense = await readFile(path.join(tomlRoot, 'LICENSE'), 'utf8');

try {
  await mkdir(outputRoot, { recursive: true });
  await build({
    entryPoints: [path.join(tomlRoot, 'dist', 'index.js')],
    outfile: path.join(outputRoot, 'smol-toml.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    legalComments: 'none',
    banner: { js: `/*!
smol-toml ${tomlPackage.version} — ${tomlPackage.license}

${tomlLicense.trim()}
*/` },
  });

  if (check) {
    const [generated, committed] = await Promise.all([
      readFile(path.join(outputRoot, 'smol-toml.cjs')),
      readFile(path.join(vendorRoot, 'smol-toml.cjs')),
    ]);
    if (!generated.equals(committed)) throw new Error('Vendored TOML artifact is stale: smol-toml.cjs');
  }
} finally {
  if (check) await rm(outputRoot, { recursive: true, force: true });
}
