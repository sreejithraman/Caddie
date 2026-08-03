#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [version, diskImage, downloadURL, output] = process.argv.slice(2);
const versionParts = (version ?? '').split('.');
const validVersion = versionParts.length === 3 && versionParts.every((part) =>
  /^(?:0|[1-9]\d*)$/.test(part) && part.length <= 10 && Number(part) <= 2_147_483_647);
const expectedURL = `https://github.com/sreejithraman/Caddie/releases/download/v${version}/Caddie-${version}.dmg`;
let parsedURL;
try { parsedURL = new URL(downloadURL); } catch {}
if (!validVersion || !diskImage || !output
    || !parsedURL || parsedURL.username || parsedURL.password || parsedURL.search || parsedURL.hash
    || parsedURL.protocol !== 'https:' || parsedURL.hostname !== 'github.com'
    || parsedURL.port || downloadURL !== expectedURL || parsedURL.href !== expectedURL) {
  throw new Error('Usage: render-caddie-cask.mjs <version> <dmg> <GitHub Release HTTPS URL> <output>');
}

const bytes = await readFile(diskImage);
const digest = createHash('sha256').update(bytes).digest('hex');
const template = await readFile(new URL('../packaging/homebrew/Caddie.rb.template', import.meta.url), 'utf8');
const rendered = template
  .replace('__VERSION__', version)
  .replace('__SHA256__', digest)
  .replace('__DOWNLOAD_URL__', downloadURL);
if (rendered.includes('__')) throw new Error('The Cask template still has an unset value.');
await writeFile(path.resolve(output), rendered, { flag: 'wx' });
