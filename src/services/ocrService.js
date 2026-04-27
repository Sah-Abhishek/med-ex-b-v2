import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { config } from '../config.js';

class OCRService {
  constructor() {
    // Old endpoint (single file)
    this.extractTextUrl = config.ocr.serviceUrl || 'https://8i1g7j94qekjwr-9000.proxy.runpod.net/extract-text';
    
    // New endpoint (batch + grouping)
    this.processDocumentsUrl = this.extractTextUrl.replace('/extract-text', '/api/documents/process');
  }

  /**
   * Extract text from a single file (OLD METHOD - Still works)
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

      const response = await axios.post(this.extractTextUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          'accept': 'application/json'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const endTime = Date.now();

      return {
        success: true,
        filename: file.originalname,
        documentType: documentType,
        extractedText: response.data,
        processingTime: endTime - startTime
      };
    } catch (error) {
      return {
        success: false,
        filename: file.originalname,
        documentType: documentType,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Process multiple files with transaction grouping (NEW METHOD)
   * 
   * @param {Array} files - Array of file objects from multer
   * @param {Object} metadata - Chart information
   * @param {Array} transactions - Transaction metadata (optional, auto-generated if not provided)
   * 
   * Example transactions:
   * [
   *   { type: 'pdf', fileIndex: 0, label: 'Report 1' },
   *   { type: 'image_group', fileIndices: [1, 2, 3], label: 'Lab Results' }
   * ]
   */
  async processDocuments(files, metadata, transactions = null) {
    const startTime = Date.now();

    try {
      const formData = new FormData();

      // Add all files
      files.forEach((file) => {
        const fileStream = fs.createReadStream(file.path);
        formData.append('files', fileStream, {
          filename: file.originalname,
          contentType: file.mimetype
        });
      });

      // Auto-generate transactions if not provided
      // Each file becomes its own PDF transaction
      const txns = transactions || files.map((file, idx) => ({
        type: 'pdf',
        fileIndex: idx,
        label: file.originalname
      }));

      // Add metadata
      formData.append('documentType', metadata.documentType || 'single');
      formData.append('chartNumber', metadata.chartNumber || 'N/A');
      formData.append('mrn', metadata.mrn || '');
      formData.append('facility', metadata.facility || '');
      formData.append('specialty', metadata.specialty || '');
      formData.append('dateOfService', metadata.dateOfService || '');
      formData.append('provider', metadata.provider || '');
      formData.append('transactions', JSON.stringify(txns));

      const response = await axios.post(this.processDocumentsUrl, formData, {
        headers: {
          ...formData.getHeaders(),
          'accept': 'application/json'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const endTime = Date.now();

      return {
        success: response.data.success,
        message: response.data.message,
        transactions: response.data.transactions,
        metadata: response.data.metadata,
        combinedText: response.data.combinedText,
        processingTime: endTime - startTime
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Process image group (multiple images as one document)
   */
  async processImageGroup(images, label, metadata) {
    const fileIndices = images.map((_, idx) => idx);
    
    const transactions = [{
      type: 'image_group',
      fileIndices: fileIndices,
      label: label || `${images.length}-page document`
    }];

    return this.processDocuments(images, metadata, transactions);
  }

  /**
   * Process files sequentially using old method (LEGACY - for compatibility)
   */
  async processFiles(files, documentType) {
    const results = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const result = await this.extractText(file, documentType);
      results.push(result);
    }

    return results;
  }

  /**
   * Process files in batch using new method (RECOMMENDED)
   */
  async processBatch(files, metadata) {
    return this.processDocuments(files, metadata);
  }

  /**
   * Format OCR results for AI processing (works with both old and new methods)
   */
  formatForAI(ocrResults) {
    const formattedDocuments = [];

    // Handle new format (from processDocuments)
    if (ocrResults.transactions) {
      ocrResults.transactions.forEach((txn, docIndex) => {
        if (!txn.success) return;

        const text = txn.extractedText || '';
        const lines = text.split('\n');
        const numberedLines = lines.map((line, idx) => ({
          lineNumber: idx + 1,
          text: line
        }));

        formattedDocuments.push({
          documentIndex: docIndex + 1,
          documentName: txn.label,
          documentType: txn.type,
          totalLines: lines.length,
          content: numberedLines,
          rawText: text
        });
      });

      return formattedDocuments;
    }

    // Handle old format (from extractText/processFiles)
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

  /**
   * Smart process: auto-detect and use best method
   */
  async smartProcess(files, metadata = {}) {
    // Use new batch method if we have metadata or multiple files
    if (metadata.chartNumber || files.length > 1) {
      return this.processBatch(files, metadata);
    }

    // Use old method for single files without metadata
    const result = await this.extractText(files[0], metadata.documentType || 'single');
    return {
      success: result.success,
      transactions: [result],
      combinedText: result.extractedText
    };
  }
}

export const ocrService = new OCRService();