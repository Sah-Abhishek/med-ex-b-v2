import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

class S3Service {
  constructor() {
    this.client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region || 'auto',
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey
      },
      forcePathStyle: true // Required for S3-compatible services
    });
    this.bucket = config.s3.bucket;
  }

  /**
   * Generate a unique key for the file
   * Structure: clinical_documents/{chartNumber}/{timestamp}_{filename}
   */
  generateKey(chartNumber, documentType, originalFilename) {
    const timestamp = Date.now();
    const ext = path.extname(originalFilename);
    const basename = path.basename(originalFilename, ext).replace(/[^a-zA-Z0-9]/g, '_');
    const folder = chartNumber || 'unassigned';
    return `clinical_documents/${folder}/${timestamp}_${basename}${ext}`;
  }

  /**
   * Upload a file to S3
   */
  async uploadFile(file, chartNumber, documentType) {
    const key = this.generateKey(chartNumber, documentType, file.originalname);

    try {
      const fileBuffer = fs.readFileSync(file.path);

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: file.mimetype,
        // Make the file publicly readable
        ACL: 'public-read',
        Metadata: {
          'original-filename': file.originalname,
          'chart-number': chartNumber || '',
          'document-type': documentType || ''
        }
      });

      await this.client.send(command);

      // Construct the public URL
      const url = `${config.s3.endpoint}/${this.bucket}/${key}`;

      console.log(`   ☁️  Uploaded to S3: ${key}`);

      return {
        success: true,
        key,
        url,
        bucket: this.bucket,
        originalFilename: file.originalname,
        contentType: file.mimetype,
        size: file.size
      };
    } catch (error) {
      console.error(`   ❌ S3 upload failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get a signed URL for temporary access
   */
  async getSignedUrl(key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      });

      const signedUrl = await getSignedUrl(this.client, command, { expiresIn });
      return { success: true, url: signedUrl };
    } catch (error) {
      console.error(`   ❌ Failed to generate signed URL: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete a file from S3
   */
  async deleteFile(key) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      });

      await this.client.send(command);
      return { success: true };
    } catch (error) {
      console.error(`   ❌ S3 delete failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Upload multiple files
   */
  async uploadFiles(files, chartNumber, documentType) {
    const results = [];

    for (const file of files) {
      const result = await this.uploadFile(file, chartNumber, documentType);
      results.push({
        ...result,
        originalFilename: file.originalname
      });
    }

    return results;
  }
}

export const s3Service = new S3Service();
