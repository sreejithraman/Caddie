import { vendorPackage } from './vendor-build.mjs';

await vendorPackage({
  artifact: 'yaml.cjs',
  entry: ['dist', 'index.js'],
  packageDirectory: 'yaml',
  packageName: 'yaml',
  staleLabel: 'YAML',
  tempPrefix: 'caddie-yaml-vendor-',
});
