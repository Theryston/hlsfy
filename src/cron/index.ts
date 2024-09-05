import cron from "node-cron";
import checkProcess from "../core/check-process.js";

cron.schedule("*/5 * * * * *", async () => {
  await checkProcess();
});
