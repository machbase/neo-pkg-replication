const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

class File {
  constructor(fullPath) {
    if (!fullPath) {
      throw new Error('fullPath is required');
    }

    this.fullPath = fullPath;
    this.dir = path.dirname(fullPath);
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
      if (typeof value === 'string' && /^\d+$/.test(value)) {
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

        const tmpPath = `${this.fullPath}.${Date.now()}.tmp`;
        
        const content = JSON.stringify(
            data,
            (key, value) => (typeof value === 'bigint' ? value.toString() : value),
            2
        );

        await fs.writeFile(tmpPath, content, 'utf-8');
        await fs.rename(tmpPath, this.fullPath);
    }


  /**
   * 기존 데이터 읽어서 병합 후 저장
   */
  async update(partial) {
    let current = {};

    if (await this.exists()) {
      current = await this.read();
    }

    const merged = { ...current, ...partial };
    await this.write(merged);
  }
}

module.exports = File;