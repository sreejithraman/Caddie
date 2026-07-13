import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'skills', 'caddie', 'tool', 'vendor');
const check = process.argv.slice(2).includes('--check');
const outputRoot = check ? await mkdtemp(path.join(os.tmpdir(), 'caddie-yaml-vendor-')) : vendorRoot;
const yamlPackage = JSON.parse(await readFile(path.join(root, 'node_modules', 'yaml', 'package.json'), 'utf8'));
const yamlLicense = await readFile(path.join(root, 'node_modules', 'yaml', 'LICENSE'), 'utf8');

try {
  await mkdir(outputRoot, { recursive: true });
  await build({
    entryPoints: [path.join(root, 'node_modules', 'yaml', 'dist', 'index.js')],
    outfile: path.join(outputRoot, 'yaml.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    legalComments: 'none',
    banner: { js: `/*!
yaml ${yamlPackage.version} — ${yamlPackage.license}

${yamlLicense.trim()}
*/` },
  });

  if (check) {
    for (const name of ['yaml.cjs']) {
      const [generated, committed] = await Promise.all([
        readFile(path.join(outputRoot, name)),
        readFile(path.join(vendorRoot, name)),
      ]);
      if (!generated.equals(committed)) throw new Error(`Vendored YAML artifact is stale: ${name}`);
    }
  }
} finally {
  if (check) await rm(outputRoot, { recursive: true, force: true });
}
