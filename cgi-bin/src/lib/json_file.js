'use strict';

const fs = require('fs');

/**
 * 파일 단위 JSON read/write
 *
 * 사용 예:
 *   const file = new JsonFile('/work/config.json');
 *   const data = file.read();
 *   file.write({ ...data, updated: true });
 */
class JsonFile {
  constructor(filePath) {
    this.filePath = filePath;
  }

  /**
   * JSON 파일 읽기
   * @returns {any}
   */
  read() {
    const content = fs.readFileSync(this.filePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * JSON 파일 atomic write (tmp → rename)
   * @param {any} data
   */
  write(data) {
    const tmp = `${this.filePath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { JsonFile };
