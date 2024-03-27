import { TEMP_DIR } from "../constants.js";
import queue from "./queue.js";
import fs from 'fs';

export default async function checkProcess() {
    if (process.env.IGNORE_CHECK_PROCESS === 'true') {
        console.log(`[CHECK_PROCESS] IGNORE_CHECK_PROCESS is true. Ignoring exit...`);
        return;
    }

    const hasPending = queue.hasPending();

    if (hasPending) {
        console.log(`[CHECK_PROCESS] Pending process. Ignoring exit...`);
        return;
    }

    console.log(`[CHECK_PROCESS] No pending process. Exit...`);
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    process.exit(0);
}