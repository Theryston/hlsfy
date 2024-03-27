import path from 'path';

export const CONCURRENCY = Number(process.env.CONCURRENCY || '3');
export const TEMP_DIR = path.join(process.cwd(), 'tmp');