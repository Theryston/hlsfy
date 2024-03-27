import cron from 'node-cron';
import checkProcess from '../core/check-process.js';

cron.schedule('*/5 * * * *', async () => {
    console.log(`[CRON] Running at ${new Date()}`);
    await checkProcess();
    console.log(`[CRON] Done at ${new Date()}`);
})