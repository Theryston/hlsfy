import path from 'path';

export const CONCURRENCY = Number(process.env.CONCURRENCY || '3');
export const TEMP_DIR = path.join(process.cwd(), 'tmp');
export const MAX_RETRY = Number(process.env.MAX_RETRY || '3');