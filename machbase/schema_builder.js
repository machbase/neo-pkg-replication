'use strict';

const { ColumnType, Column, TableSchema } = require('./machbase.js');

/**
 * TAG 테이블 스키마 빌드
 * Step 1: _{table}_META 컬럼 조회 → metadata columns
 * Step 2: DATA 파티션 컬럼 조회 → data columns (NAME은 key category + VARCHAR 오버라이드)
 *
 * @param {MachbaseClient} client
 * @param {string} logicalTable
 * @param {number} dataTableId
 * @returns {Promise<TableSchema>}
 */
async function buildTagSchema(client, logicalTable, dataTableId) {
  const metaTableName = `_${logicalTable}_META`;
  const metaRows = await client.getColumnsByTableName(metaTableName);

  const metadataColumns = [];
  let nameSkipped = false;
  for (const r of (metaRows || [])) {
    if (r.NAME.startsWith('_')) continue;
    if (!nameSkipped) { nameSkipped = true; continue; }
    metadataColumns.push(new Column(r.NAME, ColumnType.fromCode(r.TYPE), r.ID, 'metadata'));
  }

  const dataRows = await client.getColumnsByTableId(dataTableId);
  const dataColumns = [];
  for (const r of (dataRows || [])) {
    if (r.NAME.startsWith('_')) continue;
    // DATA 파티션의 NAME 컬럼은 내부적으로 tag_id(ulong)이지만
    // 논리적으로는 VARCHAR 문자열이므로 타입을 VARCHAR로 오버라이드
    const columnType = r.NAME.toLowerCase() === 'name'
      ? ColumnType.VARCHAR
      : ColumnType.fromCode(r.TYPE);
    const category = r.NAME.toLowerCase() === 'name' ? 'key' : 'data';
    dataColumns.push(new Column(r.NAME, columnType, r.ID, category));
  }

  if (dataColumns.length === 0) {
    throw new Error(`buildTagSchema: no data columns found for '${logicalTable}' (dataTableId=${dataTableId})`);
  }

  return new TableSchema('TAG', logicalTable, [...dataColumns, ...metadataColumns]);
}

/**
 * LOG 테이블 스키마 빌드
 *
 * @param {MachbaseClient} client
 * @param {string} logicalTable
 * @returns {Promise<TableSchema>}
 */
async function buildLogSchema(client, logicalTable) {
  const rows = await client.getColumnsByTableName(logicalTable);
  const columns = (rows || []).map(r => new Column(r.NAME, ColumnType.fromCode(r.TYPE), r.ID, 'data'));
  return new TableSchema('LOG', logicalTable, columns);
}

module.exports = { buildTagSchema, buildLogSchema };
