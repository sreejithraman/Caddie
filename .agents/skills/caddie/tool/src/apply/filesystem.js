'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

async function exists(candidate) {
  try {
    await fsp.lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function fingerprint(candidate) {
  const { fingerprintDirectory } = await import('../fingerprint/index.mjs');
  const evidence = await fingerprintDirectory(candidate);
  if (!evidence.complete || !evidence.digest) {
    throw Object.assign(new Error(`cannot fingerprint incomplete filesystem evidence: ${candidate}`), {
      code: 'incomplete-fingerprint',
      findings: evidence.findings,
    });
  }
  return evidence.digest;
}

async function fingerprintIfPresent(candidate) {
  if (!await exists(candidate)) return null;
  try {
    return await fingerprint(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(candidate, value) {
  await fsp.mkdir(path.dirname(candidate), { recursive: true });
  const temporary = `${candidate}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let published = false;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fsp.rename(temporary, candidate);
    published = true;
  } finally {
    if (!published) await fsp.rm(temporary, { force: true });
  }
}

async function copyDirectory(source, destination) {
  const stat = await fsp.lstat(source);
  if (!stat.isDirectory()) throw new Error(`skill source is not a directory: ${source}`);
  await fsp.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
}

module.exports = { copyDirectory, exists, fingerprint, fingerprintIfPresent, writeJsonAtomic };
