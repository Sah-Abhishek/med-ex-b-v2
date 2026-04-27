import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { config } from '../config.js';

class OCRService {
  constructor() {
    this.serviceUrl = config.ocr.serviceUrl;
  }

  /**
   * Extract text from a single file
   */
  async extractText(file, documentType) {
    const startTime = Date.now();

    try {
      const formData = new FormData();
      const fileStream = fs.createReadStream(file.path);

      formData.append('pdf', fileStream, {
        filename: file.originalname,
        contentType: file.mimetype
      });

      console.log(`   📤 OCR: ${file.originalname}`);

      const response = await axios.post(this.serviceUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          'accept': 'application/json'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const endTime = Date.now();
      console.log(`   ✅ OCR completed: ${file.originalname} (${endTime - startTime}ms)`);

      return {
        success: true,
        filename: file.originalname,
        documentType: documentType,
        extractedText: response.data,
        processingTime: endTime - startTime
      };
    } catch (error) {
      console.error(`   ❌ OCR failed: ${file.originalname} - ${error.message}`);

      return {
        success: false,
        filename: file.originalname,
        documentType: documentType,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Process multiple files sequentially
   */
  async processFiles(files, documentType) {
    const results = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`   [${i + 1}/${files.length}] Processing ${file.originalname}...`);

      const result = await this.extractText(file, documentType);
      results.push(result);
    }

    return results;
  }

  /**
   * Format OCR results for AI processing
   */
  formatForAI(ocrResults) {
    const formattedDocuments = [];

    ocrResults.forEach((result, docIndex) => {
      if (!result.success) return;

      const text = typeof result.extractedText === 'string'
        ? result.extractedText
        : JSON.stringify(result.extractedText);

      const lines = text.split('\n');
      const numberedLines = lines.map((line, idx) => ({
        lineNumber: idx + 1,
        text: line
      }));

      formattedDocuments.push({
        documentIndex: docIndex + 1,
        documentName: result.filename,
        documentType: result.documentType,
        totalLines: lines.length,
        content: numberedLines,
        rawText: text
      });
    });

    return formattedDocuments;
  }
}

export const ocrService = new OCRService();
