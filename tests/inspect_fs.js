'use strict';
const fs = require('fs');

// /work 디렉토리 내용 및 권한 확인
try {
  const entries = fs.readdirSync('/work');
  console.println('/work contents: ' + entries.join(', '));
} catch(e) { console.println('readdirSync /work error: ' + e.message); }

try {
  const stat = fs.statSync('/work');
  console.println('/work stat mode: ' + stat.mode.toString(8));
} catch(e) { console.println('statSync /work error: ' + e.message); }

// /work/logs 디렉토리 확인
try {
  const stat2 = fs.statSync('/work/logs');
  console.println('/work/logs stat mode: ' + stat2.mode.toString(8));
} catch(e) { console.println('statSync /work/logs: ' + e.message); }

// /work/logs에 쓰기
try {
  fs.mkdirSync('/work/logs', { recursive: true });
  fs.writeFileSync('/work/logs/test.txt', 'hello', 'utf-8');
  console.println('writeFileSync /work/logs/test.txt: OK');
  fs.unlinkSync('/work/logs/test.txt');
} catch(e) { console.println('write /work/logs error: ' + e.message); }
