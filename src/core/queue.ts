import { promise as fastq } from 'fastq';
import { ConverterParams, converter } from './converter.js';
import { CONCURRENCY, TEMP_DIR, MAX_RETRY } from '../constants.js';
import betterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import cleanTemp from '../clean-temp.js';

const internalQueue = fastq(converter, CONCURRENCY)

class Queue {
    db = betterSqlite3('db/queue.sqlite', { verbose: console.log });

    constructor() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS process_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, source TEXT)`);
        this.db.prepare(`UPDATE process_queue SET status = ? WHERE status = ? OR status = ?`).run('failed', 'pending', 'processing');

        if (fs.existsSync(TEMP_DIR)) {
            cleanTemp();
        } else {
            fs.mkdirSync(TEMP_DIR, { recursive: true });
        }

        console.log(`[QUEUE] Queue initialized with concurrency ${CONCURRENCY}`);
    }

    push(params: ConverterParams, attempt = 0) {
        const processId = params.processId || this.db.prepare(`INSERT INTO process_queue (status, source) VALUES (?, ?)`).run('pending', params.source).lastInsertRowid;

        internalQueue.push({
            ...params,
            onStart: () => {
                console.log(`[QUEUE] Start processing ${params.source} of id ${processId}`);
                this.db
                    .prepare(`UPDATE process_queue SET status = ? WHERE id = ?`)
                    .run('processing', processId);
            }
        })
            .then(() => {
                console.log(`[QUEUE] Success while processing ${params.source} of id ${processId}`);
                this.db
                    .prepare(`UPDATE process_queue SET status = ? WHERE id = ?`)
                    .run('done', processId);
            })
            .catch((error) => {
                console.log(`[QUEUE] Failed while processing ${params.source} of id ${processId}:`);
                console.log(error);

                if (attempt >= MAX_RETRY) {
                    console.log(`[QUEUE] Retry limit reached while processing ${params.source} of id ${processId}`);
                    this.db
                        .prepare(`UPDATE process_queue SET status = ? WHERE id = ?`)
                        .run('failed', processId);
                    return
                }

                this.push({ ...params, processId: Number(processId) }, attempt + 1)
                console.log(`[QUEUE] added ${params.source} of id ${processId} to queue for retry...`);
            })
    }

    hasPending() {
        const result = this.db
            .prepare(`SELECT * FROM process_queue WHERE status = ? OR status = ?`)
            .all('pending', 'processing');

        return result.length > 0
    }

    getProcess(id: number | bigint) {
        const result = this.db
            .prepare(`SELECT * FROM process_queue WHERE id = ?`)
            .get(id);
        return result
    }

    listProcess(limit?: number) {
        const result = this.db
            .prepare(`SELECT * FROM process_queue ORDER BY id DESC${limit ? ' LIMIT ?' : ''}`)
            .all(limit);

        return result
    }
}

const queue = new Queue();

export default queue;
