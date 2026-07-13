'use strict';

const path = require('node:path');

function isAdoptionPair(materialization, adoption) {
  return materialization?.type === 'materialize-skill'
    && adoption?.type === 'adopt-user-skill-exposure'
    && path.resolve(materialization.sourcePath) === path.resolve(adoption.linkPath)
    && path.resolve(materialization.destinationPath) === path.resolve(adoption.targetPath)
    && materialization.name === path.basename(adoption.linkPath)
    && materialization.sourceFingerprint === adoption.expected?.fingerprint
    && materialization.sourceFingerprint === adoption.targetFingerprint
    && materialization.expectedDestination?.state === 'absent';
}

module.exports = { isAdoptionPair };
