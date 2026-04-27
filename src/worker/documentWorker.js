/**
 * Document Processing Worker
 *
 * Run this as a separate process: node workers/documentWorker.js
 *
 * UPDATED: Replaced ChatGPT/OpenAI with ICD Predictor Gateway API.
 * - Single document: POST /api/upload → poll → GET /api/report/{id}
 * - Multiple documents: Encounter workflow (create → batch upload → run → poll → GET encounter)
 * - OCR is handled by the ICD Predictor pipeline, so we skip local OCR for PDF/images.
 * - Text and Word files are still extracted locally and uploaded as-is.
 */

import { QueueService } from '../db/queueService.js';
import { ChartRepository, DocumentRepository } from '../db/chartRepository.js';
import { query } from '../db/connection.js';
import { aiService } from '../services/aiService.js';
import { createSLATracker } from '../utils/slaTracker.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import mammoth from 'mammoth';

// ═══════════════════════════════════════════════════════════════
// LOGGING UTILITY
// ═══════════════════════════════════════════════════════════════
const log = {
  info: (stage, message, data = null) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ℹ️  [${stage}] ${message}`);
    if (data) console.log(`    └─ Data:`, typeof data === 'object' ? JSON.stringify(data, null, 2).substring(0, 500) : data);
  },
  success: (stage, message, data = null) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ✅ [${stage}] ${message}`);
    if (data) console.log(`    └─ Data:`, typeof data === 'object' ? JSON.stringify(data, null, 2).substring(0, 500) : data);
  },
  error: (stage, message, error = null) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ❌ [${stage}] ${message}`);
    if (error) {
      console.error(`    └─ Error:`, error.message || error);
      if (error.stack) console.error(`    └─ Stack:`, error.stack.split('\n').slice(0, 3).join('\n'));
    }
  },
  warn: (stage, message, data = null) => {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] ⚠️  [${stage}] ${message}`);
    if (data) console.warn(`    └─ Data:`, data);
  },
  divider: () => {
    console.log('\n' + '═'.repeat(70) + '\n');
  },
  subDivider: () => {
    console.log('─'.repeat(50));
  }
};

// Word document MIME types
const WORD_MIME_TYPES = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];

class DocumentWorker {
  constructor() {
    this.workerId = `worker-${os.hostname()}-${process.pid}`;
    this.isRunning = false;
    this.pollInterval = 2000;
    this.shutdownRequested = false;
  }

  async start() {
    log.divider();
    log.info('WORKER', `Started with ID: ${this.workerId}`);
    log.info('WORKER', `Poll interval: ${this.pollInterval}ms`);
    log.divider();

    this.isRunning = true;

    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    // Release stuck jobs on startup
    try {
      const stuckJobs = await QueueService.releaseStuckJobs(30);
      if (stuckJobs.length > 0) {
        log.warn('WORKER', `Released ${stuckJobs.length} stuck jobs on startup`);
      }
    } catch (error) {
      log.error('WORKER', 'Failed to release stuck jobs', error);
    }

    // Main processing loop
    while (this.isRunning) {
      try {
        await this.processNextJob();
      } catch (error) {
        log.error('WORKER', 'Unexpected error in main loop', error);
        await this.sleep(5000);
      }

      if (this.isRunning) {
        await this.sleep(this.pollInterval);
      }
    }

    log.divider();
    log.info('WORKER', 'Stopped');
    log.divider();
  }

  async processNextJob() {
    // Try to claim a job
    const job = await QueueService.claimNextJob(this.workerId);

    if (!job) {
      return; // No jobs available
    }

    log.divider();
    log.info('JOB_START', `Claimed job: ${job.job_id}`);
    log.info('JOB_START', `Attempt ${job.attempts}/${job.max_attempts}`);

    const sla = createSLATracker();
    sla.markUploadReceived();

    let jobData;
    let chartNumber = 'unknown';

    try {
      // Parse job data
      jobData = typeof job.job_data === 'string' ? JSON.parse(job.job_data) : job.job_data;
      chartNumber = jobData.chartNumber;

      log.info('JOB_START', `Chart: ${chartNumber}`);
      log.info('JOB_START', `Documents to process: ${jobData.documents?.length || 0}`);

      const { chartId, chartInfo, documents: jobDocuments } = jobData;

      // Update chart status to processing
      log.info('STATUS', `Setting chart ${chartId} to 'processing'`);
      await ChartRepository.updateStatusById(chartId, 'processing');
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'processing', `Processing chart ${chartNumber}`);
      if (chartInfo?.sessionId) await QueueService.notifyChartStatus(chartInfo.sessionId, 'processing');

      // Fetch ALL documents for this chart (includes previously uploaded docs with same session_id)
      const allChartDocs = await DocumentRepository.getByChartId(chartId);
      const documents = allChartDocs.map(doc => ({
        documentId: doc.id,
        documentType: doc.document_type,
        originalName: doc.original_name,
        mimeType: doc.mime_type,
        fileSize: doc.file_size,
        s3Key: doc.s3_key,
        s3Url: doc.s3_url,
        transactionId: doc.transaction_id
      }));

      log.info('JOB_START', `Total documents for chart (all uploads): ${documents.length}`);

      // ═══════════════════════════════════════════════════════════════
      // PHASE 1: DOWNLOAD FILES FROM S3
      // The ICD Predictor does its own OCR, so we just need the raw files.
      // For text/Word files, we extract text and create a .txt buffer.
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('DOWNLOAD_START', `Downloading ${documents.length} file(s) from S3`);
      sla.markOCRStarted(); // Reusing SLA tracker field for download phase
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'downloading', `Downloading ${documents.length} file(s) from S3`);

      const fileBuffers = [];
      let downloadSuccessCount = 0;
      let downloadFailCount = 0;

      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        log.info('DOWNLOAD', `Downloading file ${i + 1}/${documents.length}: ${doc.originalName}`);

        try {
          let buffer;
          let filename = doc.originalName;
          let mimeType = doc.mimeType;

          if (doc.mimeType === 'text/plain') {
            // Text file: download as text, convert to buffer
            const response = await axios.get(doc.s3Url, { responseType: 'text', timeout: 30000 });
            buffer = Buffer.from(response.data, 'utf-8');
            // Upload as PDF-like text file to ICD Predictor
            // The predictor expects PDF/image, so we keep .txt extension
            log.info('DOWNLOAD', `Text file downloaded: ${buffer.length} bytes`);
          } else if (WORD_MIME_TYPES.includes(doc.mimeType)) {
            // Word file: download, extract text with mammoth, send as .txt
            const response = await axios.get(doc.s3Url, { responseType: 'arraybuffer', timeout: 60000 });
            const tempDir = os.tmpdir();
            const safeFilename = doc.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const tempPath = path.join(tempDir, `word_${Date.now()}_${safeFilename}`);
            try {
              fs.writeFileSync(tempPath, Buffer.from(response.data));
              const result = await mammoth.extractRawText({ path: tempPath });
              buffer = Buffer.from(result.value, 'utf-8');
              filename = doc.originalName.replace(/\.(doc|docx)$/i, '.txt');
              mimeType = 'text/plain';
              log.info('DOWNLOAD', `Word file extracted to text: ${buffer.length} bytes`);
            } finally {
              try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
            }
          } else {
            // PDF or image: download as binary buffer
            const response = await axios.get(doc.s3Url, { responseType: 'arraybuffer', timeout: 60000 });
            buffer = Buffer.from(response.data);
            log.info('DOWNLOAD', `File downloaded: ${(buffer.length / 1024).toFixed(1)}KB`);
          }

          // Update document OCR status to indicate it was sent to ICD Predictor
          await DocumentRepository.updateOCRResults(doc.documentId, 'Sent to ICD Predictor for processing', 0);

          fileBuffers.push({
            buffer,
            filename,
            mimeType,
            documentId: doc.documentId,
            reportType: this.mapDocumentTypeToReportType(doc.documentType, doc.originalName)
          });

          downloadSuccessCount++;
          log.success('DOWNLOAD', `File ready: ${doc.originalName}`);

        } catch (dlError) {
          downloadFailCount++;
          log.error('DOWNLOAD_FAILED', `Failed to download ${doc.originalName}`, dlError);
          await DocumentRepository.markOCRFailed(doc.documentId, dlError.message);
        }
      }

      sla.markOCRCompleted();
      log.info('DOWNLOAD_SUMMARY', `Downloads complete: ${downloadSuccessCount} success, ${downloadFailCount} failed`);

      if (fileBuffers.length === 0) {
        throw new Error(`All file downloads failed (${downloadFailCount} documents)`);
      }

      // ═══════════════════════════════════════════════════════════════
      // PHASE 2: SEND TO ICD PREDICTOR GATEWAY
      // Single file → single upload workflow
      // Multiple files → encounter workflow
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('ICD_START', `Sending ${fileBuffers.length} file(s) to ICD Predictor Gateway`);
      sla.markAIStarted();
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'ai_started', `Sending ${fileBuffers.length} file(s) to ICD Predictor`);

      let aiResult;
      const aiStartTime = Date.now();

      try {
        if (fileBuffers.length === 1) {
          // Single file — use simple upload workflow
          const file = fileBuffers[0];
          log.info('ICD_PROCESS', `Using single-file upload workflow`);
          aiResult = await aiService.processSingleFile(file.buffer, file.filename, file.mimeType, file.reportType);
        } else {
          // Multiple files — use encounter workflow
          log.info('ICD_PROCESS', `Using encounter workflow for ${fileBuffers.length} files`);
          aiResult = await aiService.processEncounter(fileBuffers, chartInfo);
        }

        const aiDuration = Date.now() - aiStartTime;
        log.info('ICD_RESPONSE', `ICD Predictor responded in ${aiDuration}ms`);
        log.info('ICD_RESPONSE', `Result success: ${aiResult?.success}`);

        if (!aiResult || !aiResult.success) {
          const errMsg = aiResult?.error || 'Unknown ICD Predictor error';
          log.error('ICD_FAILED', `ICD Predictor returned failure: ${errMsg}`);
          throw new Error(`ICD Predictor processing failed: ${errMsg}`);
        }

        if (!aiResult.data) {
          log.error('ICD_FAILED', `ICD Predictor returned success but no data`);
          throw new Error('ICD Predictor processing failed: No data in response');
        }

        log.success('ICD_COMPLETE', `ICD Predictor analysis successful for chart ${chartNumber}`, {
          hasDiagnosisCodes: !!aiResult.data?.diagnosis_codes,
          hasProcedures: !!aiResult.data?.procedures,
          totalCodes: aiResult.data?.metadata?.total_codes_extracted,
          dataKeys: Object.keys(aiResult.data || {})
        });

      } catch (aiError) {
        log.error('ICD_EXCEPTION', `ICD Predictor processing threw exception`, aiError);
        sla.markAICompleted();
        throw aiError;
      }

      sla.markAICompleted();
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'ai_completed', 'ICD Predictor analysis complete');

      // ═══════════════════════════════════════════════════════════════
      // PHASE 3: SAVE RESULTS
      // (Document summaries phase removed — ICD Predictor doesn't provide them)
      // ═══════════════════════════════════════════════════════════════
      log.subDivider();
      log.info('SAVE_START', `Saving ICD Predictor results to database`);
      await QueueService.notifyStatusChange(job.job_id, 'processing', 'saving_results', 'Saving results to database');

      sla.markComplete();
      const slaSummary = sla.getSummary();

      try {
        await ChartRepository.updateWithAIResultsById(chartId, aiResult.data, slaSummary, aiResult.encounterPayload);
        if (aiResult.encounterId) {
          await query('UPDATE charts SET encounter_id = $1, report_ids = $3 WHERE id = $2',
            [aiResult.encounterId, chartId, JSON.stringify(aiResult.reportIds || [])]);
        } else if (aiResult.reportId) {
          // Single-file upload: no encounter, but save the report_id for review/submit
          await query('UPDATE charts SET report_ids = $1 WHERE id = $2',
            [JSON.stringify([aiResult.reportId]), chartId]);
        }
        log.success('SAVE_COMPLETE', `Chart ${chartNumber} updated with ICD Predictor results`);
      } catch (saveError) {
        log.error('SAVE_FAILED', `Failed to save results`, saveError);
        throw saveError;
      }

      // Mark job as completed
      await QueueService.completeJob(job.job_id);
      await QueueService.notifyStatusChange(job.job_id, 'completed', 'completed', `Chart ${chartNumber} processed successfully`);
      if (chartInfo?.sessionId) await QueueService.notifyChartStatus(chartInfo.sessionId, 'ready');

      log.divider();
      log.success('JOB_COMPLETE', `Chart ${chartNumber} processed successfully`, {
        totalDuration: slaSummary.durations.total,
        downloadDuration: slaSummary.durations.ocr,
        icdPredictorDuration: slaSummary.durations.ai,
        slaStatus: slaSummary.slaStatus.status
      });

    } catch (error) {
      log.divider();
      log.error('JOB_FAILED', `Chart ${chartNumber} processing failed`, error);

      await this.handleJobFailure(job, error.message, chartNumber);
    }
  }

  /**
   * Map internal document types to ICD Predictor report_type values.
   * ICD Predictor accepts: HP | DISCHARGE_SUMMARY | OPERATIVE_NOTE | LAB | RADIOLOGY | ED_NOTE | CLINIC_NOTE | PATHOLOGY
   */
  mapDocumentTypeToReportType(documentType, filename = '') {
    const mapping = {
      'hp': 'HP',
      'history-physical': 'HP',
      'discharge': 'DISCHARGE_SUMMARY',
      'discharge-summary': 'DISCHARGE_SUMMARY',
      'operative': 'OPERATIVE_NOTE',
      'operative-note': 'OPERATIVE_NOTE',
      'lab': 'LAB',
      'laboratory': 'LAB',
      'radiology': 'RADIOLOGY',
      'imaging': 'RADIOLOGY',
      'ed-note': 'ED_NOTE',
      'emergency': 'ED_NOTE',
      'clinic-note': 'CLINIC_NOTE',
      'clinical-text': 'CLINIC_NOTE',
      'pathology': 'PATHOLOGY',
      'word-document': 'CLINIC_NOTE'
    };

    const normalized = (documentType || '').toLowerCase().trim();
    const mapped = mapping[normalized];
    if (mapped) return mapped;

    // Infer report type from filename when documentType is generic (mixed, unknown, etc.)
    const fn = filename.toLowerCase();
    if (fn.includes('hp report') || fn.includes('h&p') || fn.includes('history') || fn.includes('_hp'))
      return 'HP';
    if (fn.includes('op report') || fn.includes('operative') || fn.includes('_op'))
      return 'OPERATIVE_NOTE';
    if (fn.includes('discharge'))
      return 'DISCHARGE_SUMMARY';
    if (fn.includes('ed note') || fn.includes('emergency'))
      return 'ED_NOTE';
    if (fn.includes('lab'))
      return 'LAB';
    if (fn.includes('radiology') || fn.includes('imaging'))
      return 'RADIOLOGY';
    if (fn.includes('pathology'))
      return 'PATHOLOGY';

    return 'CLINIC_NOTE';
  }

  /**
   * Handle job failure with proper status updates and logging
   */
  async handleJobFailure(job, errorMessage, chartNumber) {
    log.info('FAILURE_HANDLING', `Processing failure for chart ${chartNumber}`);

    try {
      // Mark job as failed
      const failResult = await QueueService.failJob(job.job_id, errorMessage);

      if (!failResult) {
        log.error('FAILURE_HANDLING', `Could not update job status for ${job.job_id}`);
        return;
      }

      log.info('FAILURE_HANDLING', `Job marked as failed`, {
        attempts: failResult.attempts,
        maxAttempts: failResult.max_attempts,
        willRetry: failResult.willRetry,
        retryAfter: failResult.retryAfter
      });

      await QueueService.notifyStatusChange(
        job.job_id,
        'failed',
        'failed',
        failResult.willRetry
          ? `Failed (attempt ${failResult.attempts}/${failResult.max_attempts}), will retry`
          : `Permanently failed: ${errorMessage}`
      );

      // Get chartId from job data
      const jd = typeof job.job_data === 'string' ? JSON.parse(job.job_data) : job.job_data;
      const chartId = jd?.chartId;
      const failSessionId = jd?.chartInfo?.sessionId;

      if (!chartId) {
        log.error('FAILURE_HANDLING', `Could not extract chartId from job`);
        return;
      }

      // Update chart status
      if (failResult.isPermanentlyFailed) {
        log.warn('FAILURE_HANDLING', `Chart ${chartId} PERMANENTLY FAILED (max attempts reached)`);
        await ChartRepository.markFailedById(chartId, errorMessage);
        if (failSessionId) await QueueService.notifyChartStatus(failSessionId, 'failed');
      } else {
        const retryInSeconds = Math.round((failResult.retryAfter - new Date()) / 1000);
        log.info('FAILURE_HANDLING', `Chart ${chartId} set to RETRY_PENDING (retry in ${retryInSeconds}s)`);
        await ChartRepository.updateWithErrorById(
          chartId,
          errorMessage,
          true,
          failResult.attempts
        );
        if (failSessionId) await QueueService.notifyChartStatus(failSessionId, 'retry_pending');
      }

    } catch (handlingError) {
      log.error('FAILURE_HANDLING', `Error while handling failure`, handlingError);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  shutdown() {
    if (this.shutdownRequested) return;
    log.warn('WORKER', 'Shutdown requested, finishing current job...');
    this.shutdownRequested = true;
    this.isRunning = false;
  }
}

// Run the worker
const worker = new DocumentWorker();
worker.start().catch(error => {
  log.error('FATAL', 'Worker crashed', error);
  process.exit(1);
});

export default DocumentWorker;
