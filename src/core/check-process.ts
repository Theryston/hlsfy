import cleanTemp from "../clean-temp.js";
import queue from "./queue.js";
import * as Sentry from "@sentry/node";

export default async function checkProcess() {
  if (process.env.IGNORE_CHECK_PROCESS === "true") {
    return;
  }

  const hasPending = queue.hasPending();

  if (hasPending) {
    return;
  }

  console.log(`[CHECK_PROCESS] No pending process. Exit...`);
  cleanTemp();

  if (process.env.SENTRY_DSN) {
    await Sentry.flush();
  }

  process.exit(0);
}
