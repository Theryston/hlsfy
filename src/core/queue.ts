import { promise as fastq } from 'fastq';
import { ConverterParams, converter } from './converter.js';
import { CONCURRENCY, TEMP_DIR } from '../constants.js';
import betterSqlite3 from 'better-sqlite3';
import fs from 'fs';

const internalQueue = fastq(converter, CONCURRENCY)

class Queue {
    db = betterSqlite3('queue.sqlite', { verbose: console.log });

    constructor() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS process_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT)`);
        this.db.prepare(`UPDATE process_queue SET status = ? WHERE status = ?`).run('failed', 'pending');

        if (fs.existsSync(TEMP_DIR)) {
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        }

        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    push(params: ConverterParams) {
        const result = this.db
            .prepare(`INSERT INTO process_queue (status) VALUES (?)`)
            .run('pending');
        internalQueue.push(params)
            .then(() => {
                console.log(`[QUEUE] Success while processing ${params.source} of id ${result.lastInsertRowid}`);
                this.db
                    .prepare(`UPDATE process_queue SET status = ? WHERE id = ?`)
                    .run('done', result.lastInsertRowid);
            })
            .catch((error) => {
                console.log(`[QUEUE] Failed while processing ${params.source} of id ${result.lastInsertRowid}`, error);
                this.db
                    .prepare(`UPDATE process_queue SET status = ? WHERE id = ?`)
                    .run('failed', result.lastInsertRowid);
            })
        return result.lastInsertRowid;
    }

    hasPending() {
        const result = this.db
            .prepare(`SELECT * FROM process_queue WHERE status = ?`)
            .get('pending');
        return !!result
    }

    getProcess(id: number) {
        const result = this.db
            .prepare(`SELECT * FROM process_queue WHERE id = ?`)
            .get(id);
        return result
    }
}

const queue = new Queue();

export default queue;
