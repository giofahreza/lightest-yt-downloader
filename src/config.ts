import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  outputDir: path.resolve(process.env.OUTPUT_DIR || path.join(ROOT, 'output')),
};
