'use strict';

const fs = require('fs/promises');
const path = require('path');

class File {
  /**
   * @param {string} fullPath
   * @param {{ bigintKeys?: string[] }} [opts]
   */
  constructor(fullPath, opts = {}) {
    if (!fullPath) {
      throw new Error('fullPath is required');
    }

    this.fullPath = fullPath;
    this.dir = path.dirname(fullPath);
    this._bigintKeys = new Set(opts.bigintKeys ?? []);
  }

  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async exists() {
    try {
      await fs.access(this.fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async read() {
    const content = await fs.readFile(this.fullPath, 'utf-8');

    return JSON.parse(content, (key, value) => {
      if (this._bigintKeys.has(key) && typeof value === 'string' && /^\d+$/.test(value)) {
        return BigInt(value);
      }
      return value;
    });
  }


  /**
   * Atomic write
   * tmp 파일에 먼저 기록 후 rename
   */
  async write(data) {
    if (typeof data !== 'object' || data === null) {
      throw new Error('JSONFile.write only accepts non-null object');
    }

    await this.ensureDir();

    const tmpPath = `${this.fullPath}.${process.hrtime.bigint()}.tmp`;

    const content = JSON.stringify(
      data,
      (key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2
    );

    await fs.writeFile(tmpPath, content, 'utf-8');
    try {
      await fs.rename(tmpPath, this.fullPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

module.exports = File;