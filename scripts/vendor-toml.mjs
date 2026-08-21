import { vendorPackage } from './vendor-build.mjs';

await vendorPackage({
  artifact: 'smol-toml.cjs',
  entry: ['dist', 'index.js'],
  packageDirectory: 'smol-toml',
  packageName: 'smol-toml',
  staleLabel: 'TOML',
  tempPrefix: 'caddie-toml-vendor-',
});
