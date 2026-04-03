/**
 * POST /cgi-bin/api/table/columns
 * body: { host, port, user, password, table }
 *
 * 지정한 DB에 연결하여 테이블 컬럼 정보를 반환한다.
 */

'use strict';

const path = require('path');
const process = require('process');
const _argv = process.argv[1];
const ROOT = _argv.slice(0, _argv.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const CGI = require(path.join(ROOT, 'src', 'cgi', 'cgi_util.js'));
const { MachbaseClient, ColumnType } = require(path.join(ROOT, 'src', 'db', 'client.js'));
const { FLAG_PRIMARY, FLAG_BASETIME, FLAG_SUMMARIZED, FLAG_METADATA } = require(path.join(ROOT, 'src', 'db', 'types.js'));

function POST() {
  const { host, port, user, password, table } = CGI.readBody();

  if (!host)     return CGI.reply({ ok: false, reason: 'host is required' });
  if (!port)     return CGI.reply({ ok: false, reason: 'port is required' });
  if (!user)     return CGI.reply({ ok: false, reason: 'user is required' });
  if (!password) return CGI.reply({ ok: false, reason: 'password is required' });
  if (!table)    return CGI.reply({ ok: false, reason: 'table is required' });

  const client = new MachbaseClient({ host, port: parseInt(port, 10), user, password });
  try {
    client.connect();

    const { type: tableType } = client.selectTableType(table.toUpperCase());
    if (tableType === 'UNSUPPORTED') {
      return CGI.reply({ ok: false, reason: `table '${table}' not found` });
    }

    const rows = client.selectColumnsByTableName(table.toUpperCase());
    const columns = rows.map(r => {
      const colType = ColumnType.fromCode(r.TYPE);
      const sqlType = colType.ddlType !== null ? colType.ddlType : `VARCHAR(${r.LENGTH})`;
      return {
        name:        r.NAME,
        type:        sqlType,
        isPrimary:   !!(r.FLAG & FLAG_PRIMARY),
        isBasetime:  !!(r.FLAG & FLAG_BASETIME),
        isSummarized:!!(r.FLAG & FLAG_SUMMARIZED),
        isMetadata:  !!(r.FLAG & FLAG_METADATA),
      };
    });

    CGI.reply({ ok: true, data: { table: table.toUpperCase(), tableType, columns } });
  } catch (err) {
    CGI.reply({ ok: false, reason: err.message });
  } finally {
    client.close();
  }
}

const handlers = { POST };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
(handlers[method] || (() => CGI.reply({ ok: false, reason: 'method not allowed' })))();
