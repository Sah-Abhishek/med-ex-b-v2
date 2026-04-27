import { query } from './connection.js';

export const ChartRepository = {

  /**
   * Create a new chart with 'queued' status (for async processing)
   * Use this when documents are uploaded but not yet processed
   */
  async createQueued(chartData) {
    const {
      sessionId,
      chartNumber,
      mrn,
      facility,
      specialty,
      dateOfService,
      provider,
      documentCount = 0
    } = chartData;

    const result = await query(
      `INSERT INTO charts (
        session_id, chart_number, mrn, facility, specialty, date_of_service,
        provider, document_count, ai_status, review_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 'pending')
      ON CONFLICT (session_id)
      DO UPDATE SET
        chart_number = COALESCE(NULLIF(EXCLUDED.chart_number, ''), charts.chart_number),
        mrn = COALESCE(NULLIF(EXCLUDED.mrn, ''), charts.mrn),
        facility = COALESCE(NULLIF(EXCLUDED.facility, ''), charts.facility),
        specialty = COALESCE(NULLIF(EXCLUDED.specialty, ''), charts.specialty),
        date_of_service = COALESCE(EXCLUDED.date_of_service, charts.date_of_service),
        provider = COALESCE(NULLIF(EXCLUDED.provider, ''), charts.provider),
        document_count = charts.document_count + EXCLUDED.document_count,
        ai_status = CASE
          WHEN charts.ai_status IN ('ready', 'submitted') THEN charts.ai_status
          ELSE 'queued'
        END,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [sessionId, chartNumber, mrn, facility, specialty, dateOfService, provider, documentCount]
    );

    return result.rows[0];
  },

  /**
   * Create a new chart (sets to 'processing' immediately - for sync processing)
   */
  async create(chartData) {
    const {
      sessionId,
      chartNumber,
      mrn,
      facility,
      specialty,
      dateOfService,
      provider,
      documentCount = 0
    } = chartData;

    const result = await query(
      `INSERT INTO charts (
        session_id, chart_number, mrn, facility, specialty, date_of_service,
        provider, document_count, ai_status, review_status, processing_started_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing', 'pending', CURRENT_TIMESTAMP)
      ON CONFLICT (session_id)
      DO UPDATE SET
        chart_number = EXCLUDED.chart_number,
        mrn = EXCLUDED.mrn,
        facility = EXCLUDED.facility,
        specialty = EXCLUDED.specialty,
        date_of_service = EXCLUDED.date_of_service,
        provider = EXCLUDED.provider,
        document_count = EXCLUDED.document_count,
        ai_status = 'processing',
        processing_started_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [sessionId, chartNumber, mrn, facility, specialty, dateOfService, provider, documentCount]
    );

    return result.rows[0];
  },

  /**
   * Update chart with AI results - also saves original_ai_codes for comparison
   * Clears any previous error state
   */
  async updateWithAIResults(chartNumber, aiResults, slaData, encounterPayload) {
    // Store the original AI codes separately for comparison/analytics
    const originalAICodes = {
      ed_em_level: aiResults.diagnosis_codes?.ed_em_level || [],
      procedures: aiResults.procedures || [],
      primary_diagnosis: aiResults.diagnosis_codes?.primary_diagnosis || [],
      secondary_diagnoses: aiResults.diagnosis_codes?.secondary_diagnoses || [],
      modifiers: aiResults.diagnosis_codes?.modifiers || [],
      generated_at: new Date().toISOString()
    };

    const result = await query(
      `UPDATE charts SET
        ai_status = 'ready',
        ai_summary = $2,
        diagnosis_codes = $3,
        procedures = $4,
        medications = $5,
        vitals_summary = $6,
        lab_results_summary = $7,
        coding_notes = $8,
        sla_data = $9,
        original_ai_codes = $10,
        encounter_payload = COALESCE($11::jsonb, encounter_payload),
        processing_completed_at = CURRENT_TIMESTAMP,
        last_error = NULL,
        last_error_at = NULL,
        retry_count = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE chart_number = $1
      RETURNING *`,
      [
        chartNumber,
        JSON.stringify(aiResults.ai_narrative_summary || {}),
        JSON.stringify(aiResults.diagnosis_codes || {}),
        JSON.stringify(aiResults.procedures || []),
        JSON.stringify(aiResults.medications || []),
        JSON.stringify(aiResults.vitals_summary || {}),
        JSON.stringify(aiResults.lab_results_summary || []),
        JSON.stringify(aiResults.coding_notes || {}),
        JSON.stringify(slaData || {}),
        JSON.stringify(originalAICodes),
        encounterPayload ? JSON.stringify(encounterPayload) : null
      ]
    );

    return result.rows[0];
  },

  async updateWithAIResultsById(chartId, aiResults, slaData, encounterPayload) {
    const originalAICodes = {
      ed_em_level: aiResults.diagnosis_codes?.ed_em_level || [],
      procedures: aiResults.procedures || [],
      primary_diagnosis: aiResults.diagnosis_codes?.primary_diagnosis || [],
      secondary_diagnoses: aiResults.diagnosis_codes?.secondary_diagnoses || [],
      modifiers: aiResults.diagnosis_codes?.modifiers || [],
      generated_at: new Date().toISOString()
    };

    const result = await query(
      `UPDATE charts SET
        ai_status = 'ready',
        ai_summary = $2,
        diagnosis_codes = $3,
        procedures = $4,
        medications = $5,
        vitals_summary = $6,
        lab_results_summary = $7,
        coding_notes = $8,
        sla_data = $9,
        original_ai_codes = $10,
        encounter_payload = COALESCE($11::jsonb, encounter_payload),
        processing_completed_at = CURRENT_TIMESTAMP,
        last_error = NULL,
        last_error_at = NULL,
        retry_count = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
      [
        chartId,
        JSON.stringify(aiResults.ai_narrative_summary || {}),
        JSON.stringify(aiResults.diagnosis_codes || {}),
        JSON.stringify(aiResults.procedures || []),
        JSON.stringify(aiResults.medications || []),
        JSON.stringify(aiResults.vitals_summary || {}),
        JSON.stringify(aiResults.lab_results_summary || []),
        JSON.stringify(aiResults.coding_notes || {}),
        JSON.stringify(slaData || {}),
        JSON.stringify(originalAICodes),
        encounterPayload ? JSON.stringify(encounterPayload) : null
      ]
    );

    return result.rows[0];
  },

  /**
   * NEW: Update chart with error information when processing fails
   * Sets appropriate status based on whether it will retry
   */
  async updateWithError(chartNumber, errorMessage, willRetry, attemptCount) {
    const aiStatus = willRetry ? 'retry_pending' : 'failed';

    const result = await query(
      `UPDATE charts SET
        ai_status = $2,
        last_error = $3,
        last_error_at = CURRENT_TIMESTAMP,
        retry_count = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE chart_number = $1
      RETURNING *`,
      [chartNumber, aiStatus, errorMessage, attemptCount]
    );

    return result.rows[0];
  },

  async updateWithErrorById(chartId, errorMessage, willRetry, attemptCount) {
    const aiStatus = willRetry ? 'retry_pending' : 'failed';

    const result = await query(
      `UPDATE charts SET
        ai_status = $2,
        last_error = $3,
        last_error_at = CURRENT_TIMESTAMP,
        retry_count = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
      [chartId, aiStatus, errorMessage, attemptCount]
    );

    return result.rows[0];
  },

  /**
   * NEW: Mark chart as permanently failed
   */
  async markFailed(chartNumber, errorMessage) {
    const result = await query(
      `UPDATE charts SET
        ai_status = 'failed',
        last_error = $2,
        last_error_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE chart_number = $1
      RETURNING *`,
      [chartNumber, errorMessage]
    );

    return result.rows[0];
  },

  async markFailedById(chartId, errorMessage) {
    const result = await query(
      `UPDATE charts SET
        ai_status = 'failed',
        last_error = $2,
        last_error_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
      [chartId, errorMessage]
    );

    return result.rows[0];
  },

  /**
   * Save user modifications to codes
   */
  async saveUserModifications(chartNumber, modifications) {
    const result = await query(
      `UPDATE charts SET
        user_modifications = $2,
        review_status = 'in_review',
        updated_at = CURRENT_TIMESTAMP
      WHERE chart_number = $1
      RETURNING *`,
      [chartNumber, JSON.stringify(modifications)]
    );

    return result.rows[0];
  },

  /**
   * Submit final codes to NextCode
   */
  async submitFinalCodes(chartNumber, finalCodes, submittedBy = null) {
    const result = await query(
      `UPDATE charts SET
        final_codes = $2,
        review_status = 'submitted',
        submitted_at = CURRENT_TIMESTAMP,
        submitted_by = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE chart_number = $1
      RETURNING *`,
      [chartNumber, JSON.stringify(finalCodes), submittedBy]
    );

    return result.rows[0];
  },

  /**
   * Update chart status
   */
  async updateStatus(chartNumber, aiStatus, reviewStatus = null) {
    let queryText = `UPDATE charts SET ai_status = $2`;
    const params = [chartNumber, aiStatus];

    if (aiStatus === 'processing') {
      queryText += `, processing_started_at = CURRENT_TIMESTAMP`;
    }

    if (reviewStatus) {
      queryText += `, review_status = $${params.length + 1}`;
      params.push(reviewStatus);
    }

    queryText += `, updated_at = CURRENT_TIMESTAMP WHERE chart_number = $1 RETURNING *`;

    const result = await query(queryText, params);
    return result.rows[0];
  },

  async updateStatusById(chartId, aiStatus, reviewStatus = null) {
    let queryText = `UPDATE charts SET ai_status = $2`;
    const params = [chartId, aiStatus];

    if (aiStatus === 'processing') {
      queryText += `, processing_started_at = CURRENT_TIMESTAMP`;
    }

    if (reviewStatus) {
      queryText += `, review_status = $${params.length + 1}`;
      params.push(reviewStatus);
    }

    queryText += `, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`;

    const result = await query(queryText, params);
    return result.rows[0];
  },

  /**
   * Update review status only
   */
  async updateReviewStatus(chartNumber, reviewStatus) {
    const result = await query(
      `UPDATE charts SET review_status = $2, updated_at = CURRENT_TIMESTAMP WHERE chart_number = $1 RETURNING *`,
      [chartNumber, reviewStatus]
    );
    return result.rows[0];
  },

  /**
   * Get chart by chart number
   */
  async getByChartNumber(chartNumber) {
    const result = await query(
      `SELECT * FROM charts WHERE chart_number = $1`,
      [chartNumber]
    );
    return result.rows[0];
  },

  /**
   * Get chart by session ID
   */
  async getBySessionId(sessionId) {
    const result = await query(
      `SELECT * FROM charts WHERE session_id = $1`,
      [sessionId]
    );
    return result.rows[0];
  },

  /**
   * Get chart with documents by session ID
   */
  async getWithDocumentsBySessionId(sessionId) {
    const chartResult = await query(
      `SELECT * FROM charts WHERE session_id = $1`,
      [sessionId]
    );

    if (chartResult.rows.length === 0) return null;

    const chart = chartResult.rows[0];

    const docsResult = await query(
      `SELECT * FROM documents WHERE chart_id = $1 ORDER BY created_at`,
      [chart.id]
    );

    chart.documents = docsResult.rows;
    return chart;
  },

  /**
   * Get chart with documents
   */
  async getWithDocuments(chartNumber) {
    const chartResult = await query(
      `SELECT * FROM charts WHERE chart_number = $1`,
      [chartNumber]
    );

    if (chartResult.rows.length === 0) return null;

    const chart = chartResult.rows[0];

    const docsResult = await query(
      `SELECT * FROM documents WHERE chart_id = $1 ORDER BY created_at`,
      [chart.id]
    );

    chart.documents = docsResult.rows;
    return chart;
  },

  /**
   * Get all charts with filters and pagination
   * UPDATED: Now includes error info in response
   */
  async getAll(filters = {}) {
    const {
      facility,
      specialty,
      aiStatus,
      reviewStatus,
      search,
      page = 1,
      limit = 10,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = filters;

    let whereConditions = [];
    let params = [];
    let paramIndex = 1;

    if (facility) {
      whereConditions.push(`facility = $${paramIndex}`);
      params.push(facility);
      paramIndex++;
    }

    if (specialty) {
      whereConditions.push(`specialty = $${paramIndex}`);
      params.push(specialty);
      paramIndex++;
    }

    if (aiStatus) {
      whereConditions.push(`ai_status = $${paramIndex}`);
      params.push(aiStatus);
      paramIndex++;
    }

    if (reviewStatus) {
      whereConditions.push(`review_status = $${paramIndex}`);
      params.push(reviewStatus);
      paramIndex++;
    }

    if (search) {
      whereConditions.push(`(mrn ILIKE $${paramIndex} OR chart_number ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) FROM charts ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results (now includes error fields)
    const offset = (page - 1) * limit;
    const validSortColumns = ['created_at', 'updated_at', 'date_of_service', 'mrn', 'chart_number'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const dataResult = await query(
      `SELECT
        id, session_id, chart_number, mrn, facility, specialty, date_of_service, provider,
        ai_status, review_status, document_count,
        last_error, last_error_at, retry_count,
        processing_started_at, processing_completed_at,
        created_at, updated_at
       FROM charts ${whereClause} 
       ORDER BY ${sortColumn} ${order} 
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return {
      charts: dataResult.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  },

  /**
   * Get SLA statistics - includes 'queued', 'retry_pending', and 'failed' statuses
   */
  async getSLAStats() {
    const result = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE ai_status = 'ready' AND review_status = 'pending') as pending_review,
        COUNT(*) FILTER (WHERE ai_status = 'queued') as queued,
        COUNT(*) FILTER (WHERE ai_status = 'processing') as processing,
        COUNT(*) FILTER (WHERE ai_status = 'retry_pending') as retry_pending,
        COUNT(*) FILTER (WHERE ai_status = 'failed') as failed,
        COUNT(*) FILTER (WHERE review_status = 'in_review') as in_review,
        COUNT(*) FILTER (WHERE review_status = 'submitted') as submitted,
        COUNT(*) FILTER (
          WHERE ai_status = 'ready' 
          AND review_status = 'pending'
          AND processing_completed_at < NOW() - INTERVAL '24 hours'
        ) as sla_warning,
        COUNT(*) FILTER (
          WHERE ai_status = 'ready' 
          AND review_status = 'pending'
          AND processing_completed_at < NOW() - INTERVAL '48 hours'
        ) as sla_critical,
        COUNT(*) as total
      FROM charts
    `);

    return result.rows[0];
  },

  /**
   * Get transaction statistics
   * A transaction = 1 PDF upload OR 1 image group upload
   */
  async getTransactionStats() {
    const result = await query(`
      SELECT 
        COUNT(DISTINCT transaction_id) as total_transactions,
        COUNT(DISTINCT transaction_id) FILTER (WHERE is_group_member = FALSE) as pdf_transactions,
        COUNT(DISTINCT transaction_id) FILTER (WHERE is_group_member = TRUE) as image_group_transactions,
        COUNT(*) as total_files,
        COUNT(*) FILTER (WHERE mime_type = 'application/pdf') as total_pdfs,
        COUNT(*) FILTER (WHERE mime_type LIKE 'image/%') as total_images
      FROM documents
      WHERE transaction_id IS NOT NULL
    `);

    return result.rows[0];
  },

  /**
   * Get combined dashboard stats (charts + transactions)
   * UPDATED: Includes retry_pending and failed counts
   */
  async getDashboardStats() {
    // Get chart stats
    const chartStats = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE ai_status = 'ready' AND review_status = 'pending') as pending_review,
        COUNT(*) FILTER (WHERE ai_status = 'queued') as queued,
        COUNT(*) FILTER (WHERE ai_status = 'processing') as processing,
        COUNT(*) FILTER (WHERE ai_status = 'retry_pending') as retry_pending,
        COUNT(*) FILTER (WHERE ai_status = 'failed') as failed,
        COUNT(*) FILTER (WHERE review_status = 'in_review') as in_review,
        COUNT(*) FILTER (WHERE review_status = 'submitted') as submitted,
        COUNT(*) as total
      FROM charts
    `);

    // Get transaction stats (all transactions)
    const transactionStats = await query(`
      SELECT 
        COUNT(DISTINCT transaction_id) as total_transactions,
        COUNT(DISTINCT transaction_id) FILTER (WHERE is_group_member = FALSE) as pdf_transactions,
        COUNT(DISTINCT transaction_id) FILTER (WHERE is_group_member = TRUE) as image_group_transactions,
        COUNT(*) as total_files
      FROM documents
      WHERE transaction_id IS NOT NULL
    `);

    // Get done transactions (transactions from submitted charts)
    const doneTransactionStats = await query(`
      SELECT 
        COUNT(DISTINCT d.transaction_id) as done_transactions,
        COUNT(DISTINCT d.transaction_id) FILTER (WHERE d.is_group_member = FALSE) as done_pdf_transactions,
        COUNT(DISTINCT d.transaction_id) FILTER (WHERE d.is_group_member = TRUE) as done_image_group_transactions
      FROM documents d
      JOIN charts c ON c.id = d.chart_id
      WHERE d.transaction_id IS NOT NULL
      AND c.review_status = 'submitted'
    `);

    return {
      charts: chartStats.rows[0],
      transactions: {
        ...transactionStats.rows[0],
        ...doneTransactionStats.rows[0]
      }
    };
  },

  /**
   * Get analytics data for modifications
   */
  async getModificationAnalytics(filters = {}) {
    const { startDate, endDate, facility } = filters;

    let whereConditions = [`review_status = 'submitted'`];
    let params = [];
    let paramIndex = 1;

    if (startDate) {
      whereConditions.push(`submitted_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereConditions.push(`submitted_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    if (facility) {
      whereConditions.push(`facility = $${paramIndex}`);
      params.push(facility);
      paramIndex++;
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

    const result = await query(`
      SELECT 
        original_ai_codes,
        user_modifications,
        final_codes,
        chart_number,
        facility,
        submitted_at
      FROM charts
      ${whereClause}
      ORDER BY submitted_at DESC
    `, params);

    return result.rows;
  },

  /**
   * Delete chart
   */
  async delete(chartNumber) {
    const result = await query(
      `DELETE FROM charts WHERE chart_number = $1 RETURNING *`,
      [chartNumber]
    );
    return result.rows[0];
  },

  /**
   * NEW: Get failed charts for admin view
   */
  async getFailedCharts(limit = 50) {
    const result = await query(`
      SELECT 
        chart_number, mrn, facility, specialty,
        ai_status, last_error, last_error_at, retry_count,
        created_at
      FROM charts
      WHERE ai_status IN ('failed', 'retry_pending')
      ORDER BY last_error_at DESC NULLS LAST
      LIMIT $1
    `, [limit]);

    return result.rows;
  },

  /**
   * NEW: Reset a failed chart to retry processing
   */
  async resetForRetry(chartNumber) {
    const result = await query(`
      UPDATE charts SET
        ai_status = 'queued',
        last_error = NULL,
        last_error_at = NULL,
        retry_count = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE chart_number = $1 AND ai_status IN ('failed', 'retry_pending')
      RETURNING *
    `, [chartNumber]);

    return result.rows[0];
  }
};

export const DocumentRepository = {

  /**
   * Add document to chart with S3 info and transaction tracking
   */
  async create(chartId, documentData) {
    const {
      documentType,
      filename,
      originalName,
      fileSize,
      mimeType,
      s3Key,
      s3Url,
      s3Bucket,
      transactionId = null,
      transactionLabel = null,
      isGroupMember = false
    } = documentData;

    const result = await query(
      `INSERT INTO documents (
        chart_id, document_type, filename, original_name, file_size, mime_type,
        s3_key, s3_url, s3_bucket, ocr_status, transaction_id, transaction_label, is_group_member
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12)
      RETURNING *`,
      [chartId, documentType, filename, originalName, fileSize, mimeType, s3Key, s3Url, s3Bucket, transactionId, transactionLabel, isGroupMember]
    );

    return result.rows[0];
  },

  /**
   * Update document with OCR results
   */
  async updateOCRResults(documentId, ocrText, ocrProcessingTime = null) {
    const result = await query(
      `UPDATE documents SET 
        ocr_text = $2, 
        ocr_status = 'completed',
        ocr_processing_time = $3,
        ocr_completed_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
      [documentId, ocrText, ocrProcessingTime]
    );

    return result.rows[0];
  },

  /**
   * Update document with AI summary
   */
  async updateAISummary(documentId, aiDocumentSummary) {
    const result = await query(
      `UPDATE documents SET 
        ai_document_summary = $2
      WHERE id = $1
      RETURNING *`,
      [documentId, JSON.stringify(aiDocumentSummary)]
    );

    return result.rows[0];
  },

  /**
   * Mark document OCR as failed
   */
  async markOCRFailed(documentId, errorMessage = null) {
    const result = await query(
      `UPDATE documents SET 
        ocr_status = 'failed',
        ocr_completed_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *`,
      [documentId]
    );

    return result.rows[0];
  },

  /**
   * Get documents by chart ID
   */
  async getByChartId(chartId) {
    const result = await query(
      `SELECT * FROM documents WHERE chart_id = $1 ORDER BY document_type, created_at`,
      [chartId]
    );
    return result.rows;
  },

  /**
   * Get documents by chart number
   */
  async getByChartNumber(chartNumber) {
    const result = await query(
      `SELECT d.* FROM documents d
       JOIN charts c ON c.id = d.chart_id
       WHERE c.chart_number = $1
       ORDER BY d.document_type, d.created_at`,
      [chartNumber]
    );
    return result.rows;
  },

  /**
   * Get document by ID
   */
  async getById(documentId) {
    const result = await query(
      `SELECT * FROM documents WHERE id = $1`,
      [documentId]
    );
    return result.rows[0];
  },

  /**
   * Get documents by transaction ID
   */
  async getByTransactionId(transactionId) {
    const result = await query(
      `SELECT * FROM documents WHERE transaction_id = $1 ORDER BY created_at`,
      [transactionId]
    );
    return result.rows;
  }
};
