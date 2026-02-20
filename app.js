const machbase = require('./machbase/machbase.js');
const checkpoint = require('./file/checkpoint.js');

main().catch(err => {
    console.error('Fatal:', err);
    process.exitCode = 1;
});

async function main() {
    const cp = new checkpoint('./tables.json');
    const src = new machbase.MachbaseClient({
        host: '192.168.1.189',
        port: 5656,
        user: 'SYS',
        password: 'MANAGER',
    }, "TAG");
    const desc = new machbase.MachbaseStream(new machbase.MachbaseClient({
        host: '192.168.1.189',
        port: 5656,
        user: 'SYS',
        password: 'MANAGER',
    }, "TAG2"));

    var endRids;

    try {
        await src.connect();
        if (!await src.tableExists()) {
            console.log("table not found")
        }

        try {
            endRids = (await cp.load()).getStores();
        } catch (err) {
            // 파일 읽기/파싱 실패 시 무시
        }

        if (!endRids || endRids.length === 0) {
            endRids = await src.lookupEndRIDS();
            if (endRids.length === 0) {
                console.error('No data partitions found for table. Check table structure.');
                return;
            }
            endRids.forEach(item => {
                item.rid = 0n;
            });
            cp.initFrom(endRids);
            await cp.save();
        }

        console.log('endRids:', endRids);

        await desc.open();

        for (const endRid of endRids) {
            const rows = await src.selectDataByRid(endRid, 10000, 1000);
            if (rows.length === 0) continue;
            console.log(`result (table: ${endRid.name}, rows: ${rows.length})`);

            let lastRid;
            for (const row of rows) {
                try {
                    await desc.append([[row.name, row.time, row.value]]);
                    lastRid = row._RID;
                } catch (err) {
                    console.error(`append error (table: ${endRid.name}, rid: ${row._RID}):`, err);
                    break;
                }
            }

            if (lastRid !== undefined) {
                cp.updateRid(endRid.name, lastRid);
                console.log(`last appended rid (table: ${endRid.name}): ${lastRid}`);
            }
        }

        await cp.save();
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await src.close();
        await desc.close();
    }
}