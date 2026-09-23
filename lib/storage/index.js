'use strict';
const env = require('../env');

function createStorage() {
  if (env.STORAGE === 'oss') {
    const OssStorage = require('./oss');
    return new OssStorage(env);
  }
  const LocalDiskStorage = require('./local');
  return new LocalDiskStorage(env);
}

module.exports = { createStorage };
