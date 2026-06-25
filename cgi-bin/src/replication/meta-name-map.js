'use strict';

/**
 * @fileoverview TAG metadata source-name map file helper
 *
 * _LAST_UPDATE_TIME delta sync는 rename 처리 시 이전 source NAME을 알아야 한다.
 * 이 파일은 source _ID -> 마지막으로 target 반영까지 끝난 source NAME을 저장한다.
 */

const fs = require('fs');
const path = require('path');
const { getInstance: getLogger } = require('../lib/logger.js');

function _normalizeTime(value) {
  if (value == null) return '';
  return String(value).trim();
}

function _normalizeNames(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    const id = String(key).trim();
    if (!id) continue;
    const value = raw[key];
    if (value == null) continue;
    out[id] = String(value);
  }
  return out;
}

function _normalizeMap(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      previousMetaUpdateTime: '',
      lastMetaUpdateTime: '',
      names: {},
    };
  }
  return {
    previousMetaUpdateTime: _normalizeTime(raw.previousMetaUpdateTime),
    lastMetaUpdateTime: _normalizeTime(raw.lastMetaUpdateTime),
    names: _normalizeNames(raw.names),
  };
}

class MetaNameMapStore {
  constructor(directory) {
    if (!directory) throw new Error('directory is required');
    this.filePath = path.join(directory, 'meta-name-map.json');
  }

  load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { exists: false, map: null, err: null };
      }
      getLogger().error('meta_name_map', { msg: `load failed: ${err.message}` });
      return { exists: false, map: null, err };
    }

    if (!data || data.kind !== 'tag-meta-name-map' || !data.map) {
      const err = new Error('invalid meta name map file');
      getLogger().error('meta_name_map', { msg: err.message });
      return { exists: false, map: null, err };
    }

    try {
      return { exists: true, map: _normalizeMap(data.map), err: null };
    } catch (err) {
      getLogger().error('meta_name_map', { msg: `normalize failed: ${err.message}` });
      return { exists: false, map: null, err };
    }
  }

  save(map) {
    const normalized = _normalizeMap(map);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const content = JSON.stringify({
        version: 1,
        kind: 'tag-meta-name-map',
        map: normalized,
      }, null, 2);

      const tmpPath = `${this.filePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, this.filePath);
      return null;
    } catch (err) {
      getLogger().error('meta_name_map', { msg: `save failed: ${err.message}` });
      return err;
    }
  }
}

module.exports = { MetaNameMapStore };
