import cleanTemp from "../clean-temp.js";
import queue from "./queue.js";

export default async function checkProcess() {
    if (process.env.IGNORE_CHECK_PROCESS === 'true') {
        return;
    }

    const hasPending = queue.hasPending();

    if (hasPending) {
        return;
    }

    console.log(`[CHECK_PROCESS] No pending process. Exit...`);
    cleanTemp();
    process.exit(0);
}