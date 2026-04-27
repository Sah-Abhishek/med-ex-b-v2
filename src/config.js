import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

export const config = {
  port: process.env.PORT || 4000,
  ocr: {
    serviceUrl: process.env.OCR_SERVICE_URL,
  },
  icdPredictor: {
    baseUrl: process.env.ICD_PREDICTOR_BASE_URL || 'http://localhost:8080',
    token: process.env.ICD_PREDICTOR_TOKEN,
    encounterType: process.env.ICD_PREDICTOR_ENCOUNTER_TYPE || 'OUTPATIENT',
    pollInterval: parseInt(process.env.ICD_PREDICTOR_POLL_INTERVAL) || 10000,
    pollTimeout: parseInt(process.env.ICD_PREDICTOR_POLL_TIMEOUT) || 300000,
    adminSecret: process.env.ICD_PREDICTOR_ADMIN_SECRET,
    coderId: process.env.ICD_PREDICTOR_CODER_ID || '074d18ae-50e0-41d1-8e1d-50ef8a19196f',
  },
  goldDataset: {
    baseUrl: process.env.GOLD_DATASET_BASE_URL || 'http://216.48.183.225:9090',
    timeout: parseInt(process.env.GOLD_DATASET_TIMEOUT) || 30000,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT_URL,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    bucket: process.env.S3_BUCKET_NAME,
    region: process.env.S3_REGION || 'auto'
  },
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 25 * 1024 * 1024,
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    allowedMimeTypes: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/tiff',
      'image/webp',
      'text/plain',  // Added for clinical text paste functionality
      'application/msword',                                                          // .doc files
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'     // .docx files
    ]
  }
};
