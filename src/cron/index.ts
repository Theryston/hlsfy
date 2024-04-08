import cron from 'node-cron';
import checkProcess from '../core/check-process.js';

cron.schedule('* * * * *', async () => {
    await checkProcess();
})