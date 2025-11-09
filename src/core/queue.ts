import { promise as fastq } from "fastq";
import { ConverterParams } from "./converter.js";
import { CONCURRENCY, TEMP_DIR } from "../constants.js";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import cleanTemp from "../clean-temp.js";
import { spawn } from "child_process";
import axios from "axios";
import formatTime from "../utils/format-time.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function worker(params: ConverterParams) {
  const tempParamsFolder = fs.mkdtempSync(path.join(TEMP_DIR, "_"));
  const paramsFile = path.join(tempParamsFolder, "params.json");
  const outputMetadataFile = path.join(
    tempParamsFolder,
    "output-metadata.json"
  );

  fs.writeFileSync(paramsFile, JSON.stringify(params));

  const converterPath = path.join(__dirname, "converter.ts");
  console.log(`[QUEUE] Running ${converterPath}...`);

  const childProcess = spawn("bun", [
    converterPath,
    paramsFile,
    outputMetadataFile,
  ]);

  childProcess.stdout.on("data", (data) => process.stdout.write(data));
  childProcess.stderr.on("data", (data) => process.stderr.write(data));

  let outputMetadata: any;

  try {
    await new Promise<void>((resolve, reject) => {
      childProcess.on("exit", (code) => {
        if (code === 0) resolve();
        else {
          console.log(`[QUEUE] ${converterPath} exited with code ${code}`);
          reject("exit");
        }
      });
    });

    outputMetadata = JSON.parse(fs.readFileSync(outputMetadataFile, "utf8"));
  } finally {
    fs.rmSync(tempParamsFolder, { recursive: true, force: true });
  }

  return outputMetadata || null;
}

const internalQueue = fastq(worker, CONCURRENCY);

class Queue {
  db: Database;

  constructor() {
    const dbDir = path.resolve("db");
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const dbPath = path.join(dbDir, "queue.sqlite");
    this.db = new Database(dbPath);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS process_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT,
        source TEXT
      )
    `);

    this.db.run(`
      UPDATE process_queue
      SET status = 'failed'
      WHERE status IN ('pending', 'processing')
    `);

    if (fs.existsSync(TEMP_DIR)) {
      cleanTemp();
    } else {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    console.log(`[QUEUE] Queue initialized with concurrency ${CONCURRENCY}`);

    let initialItems = JSON.parse(process.env.INITIAL_ITEMS || "[]");
    if (!Array.isArray(initialItems)) initialItems = [initialItems];

    for (const item of initialItems) {
      this.push(item);
      console.log(`[QUEUE] Initial item detected: ${JSON.stringify(item)}`);
    }
  }

  push(params: ConverterParams) {
    const insertStmt = this.db.query(
      `INSERT INTO process_queue (status, source) VALUES (?, ?)`
    );

    const processId =
      params.processId ||
      insertStmt.run("pending", params.source).lastInsertRowId;

    const start = Date.now();

    internalQueue
      .push({
        ...params,
        onStart: () => {
          console.log(
            `[QUEUE] Start processing ${params.source} of id ${processId}`
          );
          this.db
            .query(`UPDATE process_queue SET status = ? WHERE id = ?`)
            .run("processing", processId);
        },
      })
      .then(async (outputMetadata) => {
        console.log("outputMetadata", outputMetadata);
        console.log(
          `[QUEUE] Success while processing ${params.source} of id ${processId}`
        );

        this.db
          .query(`UPDATE process_queue SET status = ? WHERE id = ?`)
          .run("done", processId);

        if (params.callbackUrl) {
          try {
            await axios.post(params.callbackUrl, {
              id: processId,
              status: "done",
              sourceDuration: outputMetadata?.sourceDuration || null,
              params,
            });
            console.log(`[QUEUE] Sent callback: ${params.callbackUrl}`);
          } catch (error) {
            console.log(`[QUEUE] Failed to send callback: ${error}`);
          }
        }
      })
      .catch(async () => {
        console.error(
          `[QUEUE] Failed while processing ${params.source} of id ${processId}`
        );

        this.db
          .query(`UPDATE process_queue SET status = ? WHERE id = ?`)
          .run("failed", processId);

        if (params.callbackUrl) {
          try {
            await axios.post(params.callbackUrl, {
              id: processId,
              status: "failed",
              params,
            });
            console.log(`[QUEUE] Sent callback: ${params.callbackUrl}`);
          } catch (error) {
            console.log(`[QUEUE] Failed to send callback: ${error}`);
          }
        }
      })
      .finally(() => {
        const duration = Date.now() - start;
        console.log(
          `[QUEUE] Done processing ${params.source} of id ${processId} in ${formatTime(duration)}`
        );
      });

    return this.getProcess(processId);
  }

  hasPending() {
    const rows = this.db
      .query(`SELECT * FROM process_queue WHERE status IN (?, ?)`)
      .all("pending", "processing");
    return rows.length > 0;
  }

  getProcess(id: number | bigint) {
    return this.db.query(`SELECT * FROM process_queue WHERE id = ?`).get(id);
  }

  listProcess(limit?: number) {
    const sql = `SELECT * FROM process_queue ORDER BY id DESC ${
      limit ? `LIMIT ${limit}` : ""
    }`;
    return this.db.query(sql).all();
  }
}

const queue = new Queue();

export default queue;
