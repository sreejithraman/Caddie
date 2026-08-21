import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'skills', 'caddie', 'tool', 'vendor');

export async function vendorPackage({
  artifact,
  entry,
  license = 'LICENSE',
  normalizeLicenseNewlines = false,
  packageDirectory,
  packageName,
  staleLabel,
  tempPrefix,
}) {
  const check = process.argv.slice(2).includes('--check');
  const outputRoot = check ? await mkdtemp(path.join(os.tmpdir(), tempPrefix)) : vendorRoot;
  const packageRoot = path.join(root, 'node_modules', packageDirectory);
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const licenseText = await readFile(path.join(packageRoot, license), 'utf8');
  const bannerLicense = normalizeLicenseNewlines ? licenseText.replace(/\r\n/g, '\n') : licenseText;

  try {
    await mkdir(outputRoot, { recursive: true });
    await build({
      entryPoints: [path.join(packageRoot, ...entry)],
      outfile: path.join(outputRoot, artifact),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      minify: true,
      legalComments: 'none',
      banner: { js: `/*!
${packageName} ${packageJson.version} — ${packageJson.license}

${bannerLicense.trim()}
*/` },
    });

    if (check) {
      const [generated, committed] = await Promise.all([
        readFile(path.join(outputRoot, artifact)),
        readFile(path.join(vendorRoot, artifact)),
      ]);
      if (!generated.equals(committed)) throw new Error(`Vendored ${staleLabel} artifact is stale: ${artifact}`);
    }
  } finally {
    if (check) await rm(outputRoot, { recursive: true, force: true });
  }
}
