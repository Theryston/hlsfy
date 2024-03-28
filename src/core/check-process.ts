import { TEMP_DIR } from "../constants.js";
import queue from "./queue.js";
import fs from 'fs';

export default async function checkProcess() {
    if (process.env.IGNORE_CHECK_PROCESS === 'true') {
        return;
    }

    const hasPending = queue.hasPending();

    if (hasPending) {
        return;
    }

    console.log(`[CHECK_PROCESS] No pending process. Exit...`);
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    process.exit(0);
}