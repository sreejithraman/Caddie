import { vendorPackage } from './vendor-build.mjs';

await vendorPackage({
  artifact: 'jsonc-parser.cjs',
  entry: ['lib', 'esm', 'main.js'],
  license: 'LICENSE.md',
  normalizeLicenseNewlines: true,
  packageDirectory: 'jsonc-parser',
  packageName: 'jsonc-parser',
  staleLabel: 'JSONC',
  tempPrefix: 'caddie-jsonc-vendor-',
});
