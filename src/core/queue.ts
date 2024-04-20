import { promise as fastq } from 'fastq';
import { ConverterParams } from './converter.js';
import { CONCURRENCY, TEMP_DIR } from '../constants.js';
import betterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import cleanTemp from '../clean-temp.js';
import { spawn } from 'child_process'
import axios from 'axios';

const __dirname = path.dirname(import.meta.url).replace('file://', '');

async function worker(params: ConverterParams) {
    const tempParamsFolder = fs.mkdtempSync(path.join(TEMP_DIR, '_'));
    const paramsFile = path.join(tempParamsFolder, 'params.json');
    fs.writeFileSync(paramsFile, JSON.stringify(params));

    const converterPath = path.join(__dirname, 'converter.js');
    console.log(`[QUEUE] Running ${converterPath}...`);

    const childProcess = spawn('node', [converterPath, paramsFile]);

    childProcess.stdout.on('data', (data) => {
        process.stdout.write(data);
    })

    childProcess.stderr.on('data', (data) => {
        process.stderr.write(data);
    })

    try {
        await new Promise<void>((resolve, reject) => {
            childProcess.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    console.log(`[QUEUE] ${converterPath} exited with code ${code}`);
                    reject('exit');
                }
            })
        })
    } finally {
        fs.rmSync(tempParamsFolder, { recursive: true, force: true });
    }
}

const internalQueue = fastq(worker, CONCURRENCY)

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

        let initialItems = JSON.parse(process.env.INITIAL_ITEMS || '[]');

        if (!Array.isArray(initialItems)) {
            initialItems = [initialItems];
        }

        for (const item of initialItems) {
            this.push(item);
            console.log(`[QUEUE] Initial item detected: ${JSON.stringify(item)}`);
        }
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
            .then(async () => {
                console.log(`[QUEUE] Success while processing ${params.source} of id ${processId}`);
                this.db
                    .prepare(`UPDATE process_queue SET status = ? WHERE id = ?`)
                    .run('done', processId);

                if (params.callbackUrl) {
                    try {
                        await axios.post(params.callbackUrl, {
                            id: processId,
                            status: 'done',
                            message: 'Success'
                        })
                        console.log(`[QUEUE] Sent callback: ${params.callbackUrl}`);
                    } catch (error) {
                        console.log(`[QUEUE] Failed to send callback: ${error}`);
                    }
                }
            })
            .catch(async () => {
                console.error(`[QUEUE] Failed while processing ${params.source} of id ${processId}`);
                this.db
                    .prepare(`UPDATE process_queue SET status = ? WHERE id = ?`)
                    .run('failed', processId);

                if (params.callbackUrl) {
                    try {
                        await axios.post(params.callbackUrl, {
                            id: processId,
                            status: 'failed',
                            message: 'Failed'
                        })
                        console.log(`[QUEUE] Sent callback: ${params.callbackUrl}`);
                    } catch (error) {
                        console.log(`[QUEUE] Failed to send callback: ${error}`);
                    }
                }
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
