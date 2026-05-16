import { ChartRepository, DocumentRepository } from '../db/chartRepository.js';
import { QueueService } from '../db/queueService.js';
import { calculateSLAHours, calculateProcessingDuration } from '../utils/slaTracker.js';

class ChartController {

  /**
   * Get all charts (work queue)
   * GET /api/charts
   */
  async getCharts(req, res) {
    try {
      const {
        facility,
        specialty,
        aiStatus,
        reviewStatus,
        search,
        page = 1,
        limit = 10,
        sortBy,
        sortOrder
      } = req.query;

      const result = await ChartRepository.getAll({
        facility,
        specialty,
        aiStatus,
        reviewStatus,
        search,
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder
      });

      // Add SLA info to each chart (processing duration: upload → AI completion)
      // UPDATED: Now includes error tracking fields
      const chartsWithSLA = result.charts.map(chart => {
        const slaInfo = calculateProcessingDuration(chart.created_at, chart.processing_completed_at);

        return {
          id: chart.id,
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          provider: chart.provider,
          documentCount: chart.document_count,
          aiStatus: chart.ai_status,
          reviewStatus: chart.review_status,
          // NEW: Error tracking fields
          lastError: chart.last_error,
          lastErrorAt: chart.last_error_at,
          retryCount: chart.retry_count,
          // SLA info
          sla: slaInfo ? {
            display: slaInfo.display,
            hours: slaInfo.display, // Keep 'hours' for backward compatibility with frontend
            isComplete: slaInfo.isComplete,
            isExcellent: slaInfo.isExcellent,
            isGood: slaInfo.isGood,
            isWarning: slaInfo.isWarning,
            isCritical: slaInfo.isCritical
          } : null,
          createdAt: chart.created_at,
          updatedAt: chart.updated_at
        };
      });

      res.json({
        success: true,
        charts: chartsWithSLA,
        pagination: result.pagination
      });

    } catch (error) {
      console.error('❌ Error fetching charts:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get single chart with full details
   * GET /api/charts/:chartNumber
   */
  async getChart(req, res) {
    try {
      const { chartNumber } = req.params;

      const chart = await ChartRepository.getWithDocuments(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      const slaInfo = calculateProcessingDuration(chart.created_at, chart.processing_completed_at);

      res.json({
        success: true,
        chart: {
          id: chart.id,
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          provider: chart.provider,
          documentCount: chart.document_count,
          aiStatus: chart.ai_status,
          reviewStatus: chart.review_status,

          // Encounter/report IDs for review workflow
          encounterId: chart.encounter_id,
          reportIds: chart.report_ids || [],

          // AI Results (current state - may include modifications)
          aiSummary: chart.ai_summary,
          diagnosisCodes: chart.diagnosis_codes,
          procedures: chart.procedures,
          medications: chart.medications,
          vitalsSummary: chart.vitals_summary,
          labResultsSummary: chart.lab_results_summary,
          codingNotes: chart.coding_notes,

          // Original AI codes (unmodified - for comparison)
          originalAICodes: chart.original_ai_codes,

          // User modifications tracking
          userModifications: chart.user_modifications,

          // Final submitted codes
          finalCodes: chart.final_codes,
          submittedAt: chart.submitted_at,
          submittedBy: chart.submitted_by,

          // Error tracking (NEW)
          lastError: chart.last_error,
          lastErrorAt: chart.last_error_at,
          retryCount: chart.retry_count,

          // SLA
          slaData: chart.sla_data,
          sla: slaInfo,
          processingStartedAt: chart.processing_started_at,
          processingCompletedAt: chart.processing_completed_at,

          // Documents
          documents: chart.documents?.map(doc => ({
            id: doc.id,
            documentType: doc.document_type,
            filename: doc.original_name,
            fileSize: doc.file_size,
            mimeType: doc.mime_type,
            s3Url: doc.s3_url,
            s3Key: doc.s3_key,
            ocrStatus: doc.ocr_status,
            ocrText: doc.ocr_text,
            ocrProcessingTime: doc.ocr_processing_time,
            aiDocumentSummary: doc.ai_document_summary,
            createdAt: doc.created_at
          })),

          createdAt: chart.created_at,
          updatedAt: chart.updated_at
        }
      });

    } catch (error) {
      console.error('❌ Error fetching chart:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get chart by session ID with full details
   * GET /api/charts/session/:sessionId
   */
  async getChartBySessionId(req, res) {
    try {
      const { sessionId } = req.params;

      const chart = await ChartRepository.getWithDocumentsBySessionId(sessionId);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'No data found for this session'
        });
      }

      // Look up active (non-terminal) processing job for this chart
      let activeJobId = null;
      let activeJobPhase = null;
      let activeJobStatus = null;
      if (chart.chart_number) {
        const jobs = await QueueService.getJobsByChart(chart.chart_number);
        const activeJob = jobs.find(j => j.status === 'pending' || j.status === 'processing');
        if (activeJob) {
          activeJobId = activeJob.job_id;
          activeJobPhase = activeJob.current_phase || activeJob.status;
          activeJobStatus = activeJob.status;
        }
      }

      const slaInfo = calculateProcessingDuration(chart.created_at, chart.processing_completed_at);

      res.json({
        success: true,
        chart: {
          id: chart.id,
          sessionId: chart.session_id,
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          provider: chart.provider,
          documentCount: chart.document_count,
          aiStatus: chart.ai_status,
          reviewStatus: chart.review_status,
          activeJobId,
          activeJobPhase,
          activeJobStatus,

          // Encounter/report IDs for review workflow
          encounterId: chart.encounter_id,
          reportIds: chart.report_ids || [],

          // AI Results
          aiSummary: chart.ai_summary,
          diagnosisCodes: chart.diagnosis_codes,
          procedures: chart.procedures,
          medications: chart.medications,
          vitalsSummary: chart.vitals_summary,
          labResultsSummary: chart.lab_results_summary,
          codingNotes: chart.coding_notes,

          // Raw encounter payload from the ICD Predictor (clinical_summary, final_codes_json,
          // agent4_full.feedback, coding_categories, etc.) — pipeline_timing is stripped upstream
          encounterPayload: chart.encounter_payload,

          // Original AI codes (unmodified - for comparison)
          originalAICodes: chart.original_ai_codes,

          // User modifications tracking
          userModifications: chart.user_modifications,

          // Final submitted codes
          finalCodes: chart.final_codes,
          submittedAt: chart.submitted_at,
          submittedBy: chart.submitted_by,

          // Error tracking
          lastError: chart.last_error,
          lastErrorAt: chart.last_error_at,
          retryCount: chart.retry_count,

          // SLA
          slaData: chart.sla_data,
          sla: slaInfo,
          processingStartedAt: chart.processing_started_at,
          processingCompletedAt: chart.processing_completed_at,

          // Documents
          documents: chart.documents?.map(doc => ({
            id: doc.id,
            documentType: doc.document_type,
            filename: doc.original_name,
            fileSize: doc.file_size,
            mimeType: doc.mime_type,
            s3Url: doc.s3_url,
            s3Key: doc.s3_key,
            ocrStatus: doc.ocr_status,
            ocrText: doc.ocr_text,
            ocrProcessingTime: doc.ocr_processing_time,
            aiDocumentSummary: doc.ai_document_summary,
            transactionId: doc.transaction_id,
            transactionLabel: doc.transaction_label,
            createdAt: doc.created_at
          })),

          createdAt: chart.created_at,
          updatedAt: chart.updated_at
        }
      });

    } catch (error) {
      console.error('❌ Error fetching chart by session ID:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Save user modifications to codes
   * POST /api/charts/:chartNumber/modifications
   */
  async saveModifications(req, res) {
    try {
      const { chartNumber } = req.params;
      const { modifications } = req.body;

      if (!modifications) {
        return res.status(400).json({
          success: false,
          error: 'Modifications data is required'
        });
      }

      // Add timestamp to modifications
      const timestampedModifications = {
        ...modifications,
        last_modified_at: new Date().toISOString()
      };

      const chart = await ChartRepository.saveUserModifications(chartNumber, timestampedModifications);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Modifications saved',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status,
          userModifications: chart.user_modifications
        }
      });

    } catch (error) {
      console.error('❌ Error saving modifications:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Submit final codes to NextCode
   * POST /api/charts/:chartNumber/submit
   */
  async submitCodes(req, res) {
    try {
      const { chartNumber } = req.params;
      const { finalCodes, modifications, submittedBy } = req.body;

      if (!finalCodes) {
        return res.status(400).json({
          success: false,
          error: 'Final codes are required'
        });
      }

      // First save the modifications if provided
      if (modifications) {
        await ChartRepository.saveUserModifications(chartNumber, {
          ...modifications,
          submitted_at: new Date().toISOString()
        });
      }

      // Then submit the final codes
      const chart = await ChartRepository.submitFinalCodes(chartNumber, finalCodes, submittedBy);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      console.log(`✅ Chart ${chartNumber} submitted to NextCode`);
      console.log(`   Final codes:`, JSON.stringify(finalCodes, null, 2).substring(0, 500));

      res.json({
        success: true,
        message: 'Codes submitted successfully to NextCode',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status,
          submittedAt: chart.submitted_at,
          submittedBy: chart.submitted_by,
          finalCodes: chart.final_codes
        }
      });

    } catch (error) {
      console.error('❌ Error submitting codes:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Update chart review status
   * PATCH /api/charts/:chartNumber/status
   */
  async updateStatus(req, res) {
    try {
      const { chartNumber } = req.params;
      const { reviewStatus } = req.body;

      const validStatuses = ['pending', 'in_review', 'submitted', 'rejected'];
      if (!validStatuses.includes(reviewStatus)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
      }

      const chart = await ChartRepository.updateReviewStatus(chartNumber, reviewStatus);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Status updated',
        chart: {
          chartNumber: chart.chart_number,
          reviewStatus: chart.review_status
        }
      });

    } catch (error) {
      console.error('❌ Error updating status:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Retry a failed chart's processing
   * POST /api/charts/:chartNumber/retry
   */
  async retryChart(req, res) {
    try {
      const { chartNumber } = req.params;

      // Get the chart
      const chart = await ChartRepository.getByChartNumber(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      // Only allow retry for failed or retry_pending charts
      if (!['failed', 'retry_pending'].includes(chart.ai_status)) {
        return res.status(400).json({
          success: false,
          error: `Cannot retry chart with status '${chart.ai_status}'. Only failed charts can be retried.`
        });
      }

      // Get the documents for this chart
      const documents = await DocumentRepository.getByChartId(chart.id);

      if (documents.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No documents found for this chart'
        });
      }

      // Reset the chart status
      await ChartRepository.resetForRetry(chartNumber);

      // Create new job data
      const jobData = {
        chartId: chart.id,
        chartNumber,
        chartInfo: {
          mrn: chart.mrn,
          chartNumber: chart.chart_number,
          facility: chart.facility,
          specialty: chart.specialty,
          dateOfService: chart.date_of_service,
          provider: chart.provider
        },
        documentType: documents[0]?.document_type || 'unknown',
        documents: documents.map(doc => ({
          documentId: doc.id,
          documentType: doc.document_type,
          originalName: doc.original_name,
          mimeType: doc.mime_type,
          fileSize: doc.file_size,
          s3Key: doc.s3_key,
          s3Url: doc.s3_url,
          transactionId: doc.transaction_id
        }))
      };

      // Add new job to queue
      const job = await QueueService.addJob(chart.id, chartNumber, jobData);

      res.json({
        success: true,
        message: 'Chart queued for retry',
        chartNumber,
        jobId: job.job_id,
        previousError: chart.last_error,
        previousAttempts: chart.retry_count
      });

    } catch (error) {
      console.error('Retry chart error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get SLA statistics
   * GET /api/charts/stats/sla
   */
  async getSLAStats(req, res) {
    try {
      const stats = await ChartRepository.getSLAStats();

      res.json({
        success: true,
        stats: {
          pendingReview: parseInt(stats.pending_review || 0),
          queued: parseInt(stats.queued || 0),
          processing: parseInt(stats.processing || 0),
          retry_pending: parseInt(stats.retry_pending || 0),
          failed: parseInt(stats.failed || 0),
          inReview: parseInt(stats.in_review || 0),
          submitted: parseInt(stats.submitted || 0),
          slaWarning: parseInt(stats.sla_warning || 0),
          slaCritical: parseInt(stats.sla_critical || 0),
          total: parseInt(stats.total || 0)
        }
      });
    } catch (error) {
      console.error('Get SLA stats error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get modification analytics
   * GET /api/charts/analytics/modifications
   */
  async getModificationAnalytics(req, res) {
    try {
      const { startDate, endDate, facility } = req.query;

      const data = await ChartRepository.getModificationAnalytics({
        startDate,
        endDate,
        facility
      });

      // user_modifications is a flat array of { action, code_type, reason, ... }
      // where action ∈ {ACCEPT,EDIT,DELETE,ADD} and code_type ∈ {primary,secondary,cpt}.
      // Only EDIT/DELETE/ADD count as corrections; ACCEPT is a no-op confirmation.
      const isCorrection = (action) => {
        if (!action) return false;
        const a = String(action).toLowerCase();
        return a !== 'accept' && a !== 'accepted';
      };

      const totalSubmitted = data.length;
      const reasonCounts = {};
      const categoryModCounts = { primary: 0, secondary: 0, cpt: 0 };
      let chartsWithMods = 0;

      data.forEach(chart => {
        const mods = Array.isArray(chart.user_modifications) ? chart.user_modifications : [];
        let chartHasCorrection = false;

        for (const m of mods) {
          if (!isCorrection(m.action)) continue;
          chartHasCorrection = true;

          if (m.code_type && categoryModCounts[m.code_type] !== undefined) {
            categoryModCounts[m.code_type] += 1;
          }
          if (m.reason && String(m.reason).trim()) {
            const key = String(m.reason).trim();
            reasonCounts[key] = (reasonCounts[key] || 0) + 1;
          }
        }

        if (chartHasCorrection) chartsWithMods += 1;
      });

      res.json({
        success: true,
        analytics: {
          summary: {
            totalSubmitted,
            chartsWithModifications: chartsWithMods,
            modificationRate: totalSubmitted > 0
              ? parseFloat((chartsWithMods / totalSubmitted * 100).toFixed(1))
              : 0
          },
          byCategory: categoryModCounts,
          byReason: reasonCounts,
          recentSubmissions: data.slice(0, 20).map(d => {
            const m = Array.isArray(d.user_modifications) ? d.user_modifications : [];
            return {
              chartNumber: d.chart_number,
              facility: d.facility,
              submittedAt: d.submitted_at,
              hasModifications: m.some(x => isCorrection(x.action))
            };
          })
        }
      });

    } catch (error) {
      console.error('❌ Error fetching analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get comprehensive analytics for dashboard
   * GET /api/charts/analytics/dashboard
   */
  async getDashboardAnalytics(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const { period = '30' } = req.query;
      const periodDays = parseInt(period);

      // Optional specialty + client filters applied to every chart-scoped
      // query below. A single helper builds the SQL fragment + the params.
      const specialtyRaw = typeof req.query.specialty === 'string' ? req.query.specialty.trim() : '';
      const specialtyFilter = specialtyRaw && specialtyRaw.toLowerCase() !== 'all' ? specialtyRaw : null;
      const clientRaw = typeof req.query.client === 'string' ? req.query.client.trim() : '';
      const clientFilter = clientRaw && clientRaw.toLowerCase() !== 'all' ? clientRaw : null;
      const buildFiltersClause = (startIndex = 1) => {
        const parts = [];
        const params = [];
        let idx = startIndex;
        if (specialtyFilter) { parts.push(`AND specialty = $${idx++}`); params.push(specialtyFilter); }
        if (clientFilter)    { parts.push(`AND client = $${idx++}`);    params.push(clientFilter); }
        return { clause: parts.length ? ' ' + parts.join(' ') : '', params };
      };
      const baseFilters = buildFiltersClause(1);

      // Get overall stats. When a specialty filter is set, it constrains every
      // counter — including the "in period" counter — to that specialty.
      const overallStats = await query(
        `
        SELECT
          COUNT(*) as total_charts,
          COUNT(*) FILTER (WHERE review_status = 'submitted') as submitted_charts,
          COUNT(*) FILTER (WHERE review_status = 'pending') as pending_charts,
          COUNT(*) FILTER (WHERE review_status = 'in_review') as in_review_charts,
          COUNT(*) FILTER (WHERE ai_status = 'processing') as processing_charts,
          COUNT(*) FILTER (WHERE ai_status = 'queued') as queued_charts,
          COUNT(*) FILTER (WHERE ai_status = 'failed') as failed_charts,
          COUNT(*) FILTER (WHERE ai_status = 'retry_pending') as retry_pending_charts,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as charts_in_period
        FROM charts
        WHERE 1=1
        ${baseFilters.clause}
        `,
        baseFilters.params
      );

      // Get submitted charts with original codes and modifications for CODE-LEVEL accuracy
      const submittedChartsData = await query(
        `
        SELECT
          original_ai_codes,
          user_modifications,
          final_codes,
          facility,
          specialty,
          submitted_at,
          processing_started_at,
          processing_completed_at
        FROM charts
        WHERE review_status = 'submitted'
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
        ${baseFilters.clause}
        `,
        baseFilters.params
      );

      // Calculate AI accuracy at code level.
      // original_ai_codes is a category-keyed object ({ primary_diagnosis: [], procedures: [], ... });
      // user_modifications is a flat array tagged with code_type (primary/secondary/cpt) and
      // uppercase action (ACCEPT/EDIT/DELETE/ADD).
      const AI_CATEGORIES = ['ed_em_level', 'procedures', 'primary_diagnosis', 'secondary_diagnoses', 'modifiers'];
      const normalizeAction = (raw) => {
        if (!raw) return null;
        const s = String(raw).toLowerCase();
        if (s === 'edit' || s === 'edited' || s === 'modified') return 'modified';
        if (s === 'delete' || s === 'deleted' || s === 'rejected') return 'rejected';
        if (s === 'add' || s === 'added') return 'added';
        return null; // ACCEPT and unknown values are unchanged / ignored here
      };

      let totalAICodes = 0;
      let modifiedCodes = 0;
      let rejectedCodes = 0;
      let addedCodes = 0;
      const reasonCounts = {};

      // Track weekly data for trends
      const weeklyData = {};

      submittedChartsData.rows.forEach(chart => {
        const originalCodes = chart.original_ai_codes || {};
        const mods = Array.isArray(chart.user_modifications) ? chart.user_modifications : [];

        // Get week key for trend tracking
        let weekKey = 'unknown';
        if (chart.submitted_at) {
          const date = new Date(chart.submitted_at);
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          weekKey = weekStart.toISOString().split('T')[0];
        }

        if (!weeklyData[weekKey]) {
          weeklyData[weekKey] = { totalCodes: 0, unchangedCodes: 0, charts: 0 };
        }
        weeklyData[weekKey].charts++;

        // Count original AI codes per chart (denominator for accuracy).
        let chartTotalCodes = 0;
        for (const category of AI_CATEGORIES) {
          if (Array.isArray(originalCodes[category])) {
            chartTotalCodes += originalCodes[category].length;
          }
        }
        totalAICodes += chartTotalCodes;

        // Count coder actions from the flat mods array.
        let chartModified = 0;
        let chartRejected = 0;
        for (const mod of mods) {
          const action = normalizeAction(mod.action);
          if (action === 'modified') {
            modifiedCodes++;
            chartModified++;
            if (mod.reason) reasonCounts[mod.reason] = (reasonCounts[mod.reason] || 0) + 1;
          } else if (action === 'rejected') {
            rejectedCodes++;
            chartRejected++;
            if (mod.reason) reasonCounts[mod.reason] = (reasonCounts[mod.reason] || 0) + 1;
          } else if (action === 'added') {
            addedCodes++;
          }
        }

        weeklyData[weekKey].totalCodes += chartTotalCodes;
        weeklyData[weekKey].unchangedCodes += (chartTotalCodes - chartModified - chartRejected);
      });

      const unchangedCodes = totalAICodes - modifiedCodes - rejectedCodes;
      const aiAccuracy = totalAICodes > 0 ? ((unchangedCodes / totalAICodes) * 100) : 0;
      const correctionRate = totalAICodes > 0 ? (((modifiedCodes + rejectedCodes) / totalAICodes) * 100) : 0;
      const totalModifications = modifiedCodes + rejectedCodes;

      // Format weekly trends
      const sortedWeeks = Object.keys(weeklyData).filter(k => k !== 'unknown').sort();
      const formattedTrends = sortedWeeks.map((week, idx) => {
        const data = weeklyData[week];
        const weekAccuracy = data.totalCodes > 0
          ? ((data.unchangedCodes / data.totalCodes) * 100)
          : 0;

        return {
          week: `Week ${idx + 1}`,
          date: week,
          total: data.charts,
          totalCodes: data.totalCodes,
          unchangedCodes: data.unchangedCodes,
          acceptanceRate: parseFloat(weekAccuracy.toFixed(1)),
          accuracy: parseFloat(weekAccuracy.toFixed(1))
        };
      });

      // Volume by facility
      const volumeByFacility = await query(
        `
        SELECT
          facility,
          COUNT(*) as chart_count
        FROM charts
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        AND facility IS NOT NULL AND facility != ''
        ${baseFilters.clause}
        GROUP BY facility
        ORDER BY chart_count DESC
        LIMIT 10
        `,
        baseFilters.params
      );

      // Get processing times
      const processingTimes = await query(
        `
        SELECT
          AVG(EXTRACT(EPOCH FROM (processing_completed_at - processing_started_at))/60) as avg_processing_min,
          AVG(EXTRACT(EPOCH FROM (submitted_at - processing_completed_at))/60) as avg_review_min
        FROM charts
        WHERE review_status = 'submitted'
        AND processing_completed_at IS NOT NULL
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
        ${baseFilters.clause}
        `,
        baseFilters.params
      );

      // Get SLA compliance
      const slaCompliance = await query(
        `
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (
            WHERE EXTRACT(EPOCH FROM (submitted_at - processing_completed_at))/3600 <= 24
          ) as within_sla
        FROM charts
        WHERE review_status = 'submitted'
        AND processing_completed_at IS NOT NULL
        AND submitted_at >= NOW() - INTERVAL '${periodDays} days'
        ${baseFilters.clause}
        `,
        baseFilters.params
      );

      // Get charts per day average
      const chartsPerDay = await query(
        `
        SELECT
          COUNT(*)::float / NULLIF(${periodDays}, 0) as avg_per_day
        FROM charts
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        ${baseFilters.clause}
        `,
        baseFilters.params
      );

      // Specialty accuracy — same shape handling as the main loop above.
      const specialtyData = {};
      submittedChartsData.rows.forEach(chart => {
        if (!chart.specialty) return;
        if (!specialtyData[chart.specialty]) {
          specialtyData[chart.specialty] = { totalCodes: 0, unchangedCodes: 0 };
        }

        const originalCodes = chart.original_ai_codes || {};
        const mods = Array.isArray(chart.user_modifications) ? chart.user_modifications : [];

        let chartTotal = 0;
        for (const category of AI_CATEGORIES) {
          if (Array.isArray(originalCodes[category])) {
            chartTotal += originalCodes[category].length;
          }
        }

        let chartChanged = 0;
        for (const mod of mods) {
          const action = normalizeAction(mod.action);
          if (action === 'modified' || action === 'rejected') chartChanged++;
        }

        specialtyData[chart.specialty].totalCodes += chartTotal;
        specialtyData[chart.specialty].unchangedCodes += (chartTotal - chartChanged);
      });

      const specialtyAccuracy = Object.entries(specialtyData)
        .map(([specialty, data]) => ({
          week: specialty,
          specialty,
          accuracy: data.totalCodes > 0
            ? parseFloat(((data.unchangedCodes / data.totalCodes) * 100).toFixed(1))
            : 0,
          totalCodes: data.totalCodes
        }))
        .sort((a, b) => b.totalCodes - a.totalCodes);

      // Calculate metrics
      const slaTotal = parseInt(slaCompliance.rows[0]?.total || 0);
      const slaWithin = parseInt(slaCompliance.rows[0]?.within_sla || 0);
      const slaComplianceRate = slaTotal > 0 ? (slaWithin / slaTotal * 100) : 0;

      // Format correction reasons
      const totalReasonCount = Object.values(reasonCounts).reduce((a, b) => a + b, 0);
      const sortedReasons = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({
          reason,
          count,
          percentage: totalReasonCount > 0 ? parseFloat((count / totalReasonCount * 100).toFixed(1)) : 0
        }));

      // Build dynamic alerts
      const alerts = [];
      const pendingCharts = parseInt(overallStats.rows[0]?.pending_charts || 0);
      const queuedCharts = parseInt(overallStats.rows[0]?.queued_charts || 0);
      const failedCharts = parseInt(overallStats.rows[0]?.failed_charts || 0);

      if (aiAccuracy < 70 && totalAICodes > 0) {
        alerts.push({
          type: 'warning',
          title: 'Low AI Accuracy',
          message: `AI accuracy is ${aiAccuracy.toFixed(1)}%, below 70% threshold`
        });
      }

      if (correctionRate > 30 && totalAICodes > 0) {
        alerts.push({
          type: 'warning',
          title: 'High Correction Rate',
          message: `${correctionRate.toFixed(1)}% of AI codes required correction`
        });
      }

      if (failedCharts > 0) {
        alerts.push({
          type: 'error',
          title: 'Failed Charts',
          message: `${failedCharts} chart(s) failed processing`
        });
      }

      if (pendingCharts > 0) {
        alerts.push({
          type: pendingCharts > 50 ? 'warning' : 'info',
          title: 'Queue Status',
          message: `${pendingCharts} charts pending review`
        });
      }

      if (queuedCharts > 20) {
        alerts.push({
          type: 'warning',
          title: 'Processing Queue',
          message: `${queuedCharts} charts queued for AI processing`
        });
      }

      if (slaComplianceRate < 90 && slaTotal > 0) {
        alerts.push({
          type: 'warning',
          title: 'SLA Alert',
          message: `SLA compliance at ${slaComplianceRate.toFixed(1)}%`
        });
      }

      if (alerts.length === 0) {
        alerts.push({
          type: 'success',
          title: 'All Systems Normal',
          message: 'No issues detected'
        });
      }

      res.json({
        success: true,
        analytics: {
          summary: {
            aiAccuracy: parseFloat(aiAccuracy.toFixed(1)),
            aiAcceptanceRate: parseFloat(aiAccuracy.toFixed(1)),
            overallAccuracy: parseFloat(aiAccuracy.toFixed(1)),
            correctionRate: parseFloat(correctionRate.toFixed(1)),
            chartsProcessed: parseInt(overallStats.rows[0]?.charts_in_period || 0),
            totalSubmitted: submittedChartsData.rows.length,
            totalAICodes,
            unchangedCodes,
            modifiedCodes,
            rejectedCodes,
            addedCodes,
            totalModifications,
            failedCharts: parseInt(overallStats.rows[0]?.failed_charts || 0),
            retryPendingCharts: parseInt(overallStats.rows[0]?.retry_pending_charts || 0)
          },
          trends: {
            acceptanceRate: formattedTrends,
            weeklyVolume: formattedTrends.map(t => ({ week: t.week, count: t.total }))
          },
          specialtyAccuracy: specialtyAccuracy.length > 0 ? specialtyAccuracy : formattedTrends.map(t => ({
            week: t.week,
            accuracy: t.accuracy
          })),
          volumeByFacility: volumeByFacility.rows.map(r => ({
            facility: r.facility,
            count: parseInt(r.chart_count)
          })),
          correctionReasons: sortedReasons,
          performance: {
            avgProcessingTime: parseFloat(processingTimes.rows[0]?.avg_processing_min || 0).toFixed(1),
            avgReviewTime: parseFloat(processingTimes.rows[0]?.avg_review_min || 0).toFixed(1),
            totalCycleTime: (
              parseFloat(processingTimes.rows[0]?.avg_processing_min || 0) +
              parseFloat(processingTimes.rows[0]?.avg_review_min || 0)
            ).toFixed(1),
            queueBacklog: pendingCharts,
            processingQueue: queuedCharts,
            slaCompliance: parseFloat(slaComplianceRate.toFixed(1)),
            chartsPerDay: parseFloat(chartsPerDay.rows[0]?.avg_per_day || 0).toFixed(1)
          },
          alerts
        }
      });

    } catch (error) {
      console.error('❌ Error fetching dashboard analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get distinct facilities
   * GET /api/charts/filters/facilities
   */
  async getFacilities(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const result = await query(
        `SELECT DISTINCT facility FROM charts WHERE facility IS NOT NULL AND facility != '' ORDER BY facility`
      );

      res.json({
        success: true,
        facilities: result.rows.map(r => r.facility)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get distinct specialties
   * GET /api/charts/filters/specialties
   */
  async getSpecialties(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const result = await query(
        `SELECT DISTINCT specialty FROM charts WHERE specialty IS NOT NULL AND specialty != '' ORDER BY specialty`
      );

      res.json({
        success: true,
        specialties: result.rows.map(r => r.specialty)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get distinct clients
   * GET /api/charts/filters/clients
   */
  async getClients(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const result = await query(
        `SELECT DISTINCT client FROM charts WHERE client IS NOT NULL AND client != '' ORDER BY client`
      );

      res.json({
        success: true,
        clients: result.rows.map(r => r.client)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Backfill the `client` column from Valerion's chart listing.
   * POST /api/charts/sync-clients
   * Body: { mappings: [{ sessionId, client }, ...] }
   *
   * Charts in our DB are keyed by session_id (== Valerion chart Id). The
   * frontend dashboards pass us the (session_id, client) pairs they got from
   * Valerion so we can populate the column without a separate batch job.
   * Unknown session_ids are silently ignored — they may belong to a chart we
   * never ingested.
   */
  async syncClients(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];

      // Filter and normalize: keep only well-formed entries with non-empty client.
      const valid = [];
      for (const m of mappings) {
        if (!m) continue;
        const sessionId = m.sessionId != null ? String(m.sessionId) : null;
        const client = typeof m.client === 'string' ? m.client.trim() : null;
        if (!sessionId || !client) continue;
        valid.push({ sessionId, client });
      }

      if (valid.length === 0) {
        return res.json({ success: true, updated: 0, received: mappings.length });
      }

      // Build a single UPDATE ... FROM (VALUES ...) so we touch each row at most
      // once, regardless of input size. Only overwrite when the value is empty
      // or actually different — keeps updated_at meaningful.
      const placeholders = [];
      const params = [];
      valid.forEach((m, i) => {
        const a = i * 2 + 1;
        const b = i * 2 + 2;
        placeholders.push(`($${a}, $${b})`);
        params.push(m.sessionId, m.client);
      });

      const result = await query(
        `
        UPDATE charts c
        SET client = v.client,
            updated_at = CURRENT_TIMESTAMP
        FROM (VALUES ${placeholders.join(', ')}) AS v(session_id, client)
        WHERE c.session_id = v.session_id
          AND (c.client IS NULL OR c.client = '' OR c.client <> v.client)
        `,
        params
      );

      res.json({
        success: true,
        received: mappings.length,
        considered: valid.length,
        updated: result.rowCount || 0
      });
    } catch (error) {
      console.error('Error syncing clients:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Delete chart
   * DELETE /api/charts/:chartNumber
   */
  async deleteChart(req, res) {
    try {
      const { chartNumber } = req.params;

      const chart = await ChartRepository.delete(chartNumber);

      if (!chart) {
        return res.status(404).json({
          success: false,
          error: 'Chart not found'
        });
      }

      res.json({
        success: true,
        message: 'Chart deleted',
        chartNumber
      });

    } catch (error) {
      console.error('❌ Error deleting chart:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get AI processing status for multiple charts by session IDs
   * POST /api/charts/batch-status
   * Body: { sessionIds: [1, 2, 3, ...] }
   */
  async getBatchStatus(req, res) {
    try {
      const { sessionIds } = req.body;
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return res.json({ success: true, data: {} });
      }

      const { query: dbQuery } = await import('../db/connection.js');
      const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(', ');
      const result = await dbQuery(
        `SELECT session_id, ai_status FROM charts WHERE session_id IN (${placeholders})`,
        sessionIds.map(String)
      );

      const statusMap = {};
      for (const row of result.rows) {
        statusMap[row.session_id] = row.ai_status;
      }

      res.json({ success: true, data: statusMap });
    } catch (error) {
      console.error('Error fetching batch status:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
  /**
   * Processing Analytics for Admin
   * GET /api/charts/analytics/processing
   */
  async getProcessingAnalytics(req, res) {
    try {
      const { query: dbQuery } = await import('../db/connection.js');
      const { period = '30' } = req.query;
      const periodDays = parseInt(period, 10) || 30;

      // Optional specialty / client filters. Empty/missing means "all".
      const specialtyRaw = typeof req.query.specialty === 'string' ? req.query.specialty.trim() : '';
      const specialtyFilter = specialtyRaw && specialtyRaw.toLowerCase() !== 'all' ? specialtyRaw : null;
      const clientRaw = typeof req.query.client === 'string' ? req.query.client.trim() : '';
      const clientFilter = clientRaw && clientRaw.toLowerCase() !== 'all' ? clientRaw : null;

      // Pagination params — only affect the per-chart details table, never the
      // aggregate numbers. Clamp pageSize so a request can't ask for a huge page.
      const requestedPage = parseInt(req.query.page, 10);
      const requestedPageSize = parseInt(req.query.pageSize, 10);
      const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0
        ? Math.min(requestedPageSize, 100)
        : 20;

      // Build a parameterized filter predicate (specialty + client) that we
      // append to every chart-scoped query. Returns the SQL fragment, the
      // params, and the next free placeholder index for the caller's own
      // params (e.g. LIMIT/OFFSET).
      const buildFiltersClause = (startIndex = 1) => {
        const parts = [];
        const params = [];
        let idx = startIndex;
        if (specialtyFilter) { parts.push(`AND specialty = $${idx++}`); params.push(specialtyFilter); }
        if (clientFilter)    { parts.push(`AND client = $${idx++}`);    params.push(clientFilter); }
        return { clause: parts.length ? ' ' + parts.join(' ') : '', params, nextIndex: idx };
      };
      const baseFilters = buildFiltersClause(1);

      // A timing row is "valid" (contributes to averages, SLA distribution, and
      // the paginated list) iff sla_data.durations_ms exists. We reuse this
      // predicate in every query below so the aggregates and the page agree.
      const validTimingWhere = `
        sla_data IS NOT NULL
        AND sla_data->'durations_ms' IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${periodDays} days'
      `;

      // Overall processing stats
      const overallStats = await dbQuery(
        `
        SELECT
          COUNT(*) as total_charts,
          COUNT(*) FILTER (WHERE ai_status = 'ready' OR review_status = 'submitted') as completed,
          COUNT(*) FILTER (WHERE ai_status = 'processing') as processing,
          COUNT(*) FILTER (WHERE ai_status = 'queued') as queued,
          COUNT(*) FILTER (WHERE ai_status = 'failed') as failed,
          COUNT(*) FILTER (WHERE ai_status = 'retry_pending') as retry_pending
        FROM charts
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        ${baseFilters.clause}
        `,
        baseFilters.params
      );

      // Aggregate timing + SLA distribution over the full set in SQL so we
      // don't stream every row back to Node just to count them.
      const timingAgg = await dbQuery(
        `
        SELECT
          COUNT(*)::int AS total,
          AVG((sla_data->'durations_ms'->>'ocr')::bigint)   AS avg_ocr,
          AVG((sla_data->'durations_ms'->>'ai')::bigint)    AS avg_ai,
          AVG((sla_data->'durations_ms'->>'total')::bigint) AS avg_total,
          COUNT(*) FILTER (WHERE sla_data->'slaStatus'->>'status' = 'excellent')  AS sla_excellent,
          COUNT(*) FILTER (WHERE sla_data->'slaStatus'->>'status' = 'good')       AS sla_good,
          COUNT(*) FILTER (WHERE sla_data->'slaStatus'->>'status' = 'acceptable') AS sla_acceptable,
          COUNT(*) FILTER (WHERE sla_data->'slaStatus'->>'status' = 'delayed' OR sla_data->'slaStatus'->>'status' IS NULL) AS sla_delayed
        FROM charts
        WHERE ${validTimingWhere}
        ${baseFilters.clause}
        `,
        baseFilters.params
      );

      const aggRow = timingAgg.rows[0] || {};
      const totalTimings = parseInt(aggRow.total || 0, 10);
      const totalPages = totalTimings > 0 ? Math.ceil(totalTimings / pageSize) : 1;
      // Clamp page so the client can't paginate past the last row.
      const safePage = Math.min(page, totalPages);
      const offset = (safePage - 1) * pageSize;

      const averages = totalTimings > 0 ? {
        avgOcrMs:   Math.round(parseFloat(aggRow.avg_ocr   || 0)),
        avgAiMs:    Math.round(parseFloat(aggRow.avg_ai    || 0)),
        avgTotalMs: Math.round(parseFloat(aggRow.avg_total || 0)),
        chartsAnalyzed: totalTimings
      } : null;

      const slaDistribution = {
        excellent:  parseInt(aggRow.sla_excellent  || 0, 10),
        good:       parseInt(aggRow.sla_good       || 0, 10),
        acceptable: parseInt(aggRow.sla_acceptable || 0, 10),
        delayed:    parseInt(aggRow.sla_delayed    || 0, 10)
      };

      // Fetch only the current page's rows for the per-chart table.
      const pageFilters = buildFiltersClause(1);
      const pageRowsLimitIdx = pageFilters.nextIndex;
      const pageRowsOffsetIdx = pageFilters.nextIndex + 1;
      const pageRows = await dbQuery(
        `
        SELECT
          id, chart_number, session_id, facility, specialty, client, ai_status,
          document_count, sla_data, created_at
        FROM charts
        WHERE ${validTimingWhere}
        ${pageFilters.clause}
        ORDER BY created_at DESC
        LIMIT $${pageRowsLimitIdx} OFFSET $${pageRowsOffsetIdx}
        `,
        [...pageFilters.params, pageSize, offset]
      );

      const chartTimings = pageRows.rows.map(row => {
        const sla = row.sla_data || {};
        const d = sla.durations_ms || {};
        return {
          id: row.id,
          chartNumber: row.chart_number,
          sessionId: row.session_id,
          facility: row.facility,
          specialty: row.specialty,
          client: row.client,
          documentCount: row.document_count,
          ocrMs: d.ocr,
          aiMs: d.ai,
          totalMs: d.total,
          overheadMs: d.overhead,
          slaStatus: sla.slaStatus?.status,
          createdAt: row.created_at
        };
      });

      // Queue stats. When any chart-side filter is active we join to charts
      // so the queue numbers reflect only jobs belonging to those charts.
      const anyChartFilter = specialtyFilter || clientFilter;
      const queueStats = anyChartFilter
        ? await (async () => {
            const joinFilters = [];
            const joinParams = [];
            let idx = 1;
            if (specialtyFilter) { joinFilters.push(`AND c.specialty = $${idx++}`); joinParams.push(specialtyFilter); }
            if (clientFilter)    { joinFilters.push(`AND c.client = $${idx++}`);    joinParams.push(clientFilter); }
            return dbQuery(
              `
              SELECT
                COUNT(*) as total_jobs,
                COUNT(*) FILTER (WHERE pq.status = 'pending') as pending,
                COUNT(*) FILTER (WHERE pq.status = 'processing') as processing,
                COUNT(*) FILTER (WHERE pq.status = 'completed') as completed,
                COUNT(*) FILTER (WHERE pq.status = 'permanently_failed') as failed,
                AVG(pq.attempts) FILTER (WHERE pq.status = 'completed') as avg_attempts
              FROM processing_queue pq
              JOIN charts c ON c.id = pq.chart_id
              WHERE pq.created_at >= NOW() - INTERVAL '${periodDays} days'
              ${joinFilters.join(' ')}
              `,
              joinParams
            );
          })()
        : await dbQuery(`
            SELECT
              COUNT(*) as total_jobs,
              COUNT(*) FILTER (WHERE status = 'pending') as pending,
              COUNT(*) FILTER (WHERE status = 'processing') as processing,
              COUNT(*) FILTER (WHERE status = 'completed') as completed,
              COUNT(*) FILTER (WHERE status = 'permanently_failed') as failed,
              AVG(attempts) FILTER (WHERE status = 'completed') as avg_attempts
            FROM processing_queue
            WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
          `);

      // Daily volume
      const dailyVolume = await dbQuery(
        `
        SELECT
          DATE(created_at) as date,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE ai_status = 'ready' OR review_status = 'submitted') as completed,
          COUNT(*) FILTER (WHERE ai_status = 'failed') as failed
        FROM charts
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        ${baseFilters.clause}
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30
        `,
        baseFilters.params
      );

      res.json({
        success: true,
        data: {
          overview: overallStats.rows[0],
          averages,
          slaDistribution,
          chartTimings,
          chartTimingsPagination: {
            page: safePage,
            pageSize,
            total: totalTimings,
            totalPages
          },
          queueStats: queueStats.rows[0],
          dailyVolume: dailyVolume.rows
        }
      });

    } catch (error) {
      console.error('Error fetching processing analytics:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Team-lead correction analytics.
   * GET /api/charts/analytics/team-lead
   *
   * Aggregates coder actions stored in charts.user_modifications (flat array
   * of { action, code, code_type, description, reason, ... } written by
   * reviewController.submitReview) to answer:
   *   - which categories (primary / secondary / cpt) get corrected most, and
   *   - per-chart correction counts, so admins can drill into outliers.
   *
   * An "action" is considered a correction when it is EDIT, DELETE, or ADD;
   * ACCEPT is a no-op the coder confirmed.
   *
   * Optional query params (all act as filters):
   *   startDate, endDate  ISO date strings, filter submitted_at.
   *   facility, specialty plain string equality.
   *   coderId             filter submitted_by.
   */
  async getTeamLeadAnalytics(req, res) {
    try {
      const { query } = await import('../db/connection.js');
      const { startDate, endDate, facility, specialty, client, coderId } = req.query;

      const where = [
        `review_status = 'submitted'`,
        `user_modifications IS NOT NULL`,
        `jsonb_typeof(user_modifications) = 'array'`
      ];
      const params = [];
      const addParam = (val) => { params.push(val); return `$${params.length}`; };

      if (startDate) where.push(`submitted_at >= ${addParam(startDate)}`);
      if (endDate)   where.push(`submitted_at <= ${addParam(endDate)}`);
      if (facility)  where.push(`facility = ${addParam(facility)}`);
      if (specialty) where.push(`specialty = ${addParam(specialty)}`);
      if (client)    where.push(`client = ${addParam(client)}`);
      if (coderId)   where.push(`submitted_by = ${addParam(coderId)}`);

      const sql = `
        SELECT id, chart_number, facility, specialty, client, submitted_at,
               submitted_by, user_modifications
        FROM charts
        WHERE ${where.join(' AND ')}
        ORDER BY submitted_at DESC
      `;
      const { rows } = await query(sql, params);

      const CATEGORIES = ['primary', 'secondary', 'cpt'];
      const makeCategoryBucket = () => ({
        total: 0, accepted: 0, edited: 0, deleted: 0, added: 0,
        correctionCount: 0, correctionRate: 0
      });
      const makeChartCategoryBucket = () => ({
        accepted: 0, edited: 0, deleted: 0, added: 0
      });

      const byCategory = Object.fromEntries(
        CATEGORIES.map(c => [c, makeCategoryBucket()])
      );

      const summary = {
        totalCharts: rows.length,
        totalActions: 0,
        accepted: 0, edited: 0, deleted: 0, added: 0,
        correctionCount: 0, correctionRate: 0
      };

      const reasonCounts = {};
      const chartsOut = [];

      // Normalize an action string from the DB to our internal key.
      // Writer uses uppercase ACCEPT/EDIT/DELETE/ADD (reviewController.submitReview),
      // but be tolerant of legacy lowercase values too.
      const actionKey = (raw) => {
        if (!raw) return null;
        const s = String(raw).toLowerCase();
        if (s === 'accept' || s === 'accepted')       return 'accepted';
        if (s === 'edit' || s === 'edited' || s === 'modified') return 'edited';
        if (s === 'delete' || s === 'deleted' || s === 'rejected') return 'deleted';
        if (s === 'add' || s === 'added')             return 'added';
        return null;
      };

      for (const row of rows) {
        const mods = Array.isArray(row.user_modifications) ? row.user_modifications : [];

        const perChartCategories = Object.fromEntries(
          CATEGORIES.map(c => [c, makeChartCategoryBucket()])
        );
        let perChartActions = 0;
        let perChartCorrections = 0;

        for (const m of mods) {
          const cat = CATEGORIES.includes(m.code_type) ? m.code_type : null;
          const act = actionKey(m.action);
          if (!cat || !act) continue; // skip malformed entries

          perChartActions += 1;
          perChartCategories[cat][act] += 1;

          byCategory[cat].total += 1;
          byCategory[cat][act]  += 1;

          summary.totalActions += 1;
          summary[act]         += 1;

          if (act !== 'accepted') {
            perChartCorrections  += 1;
            byCategory[cat].correctionCount += 1;
            summary.correctionCount         += 1;

            // Only edits/deletes carry a "reason" from the coder.
            if (m.reason && String(m.reason).trim()) {
              const key = String(m.reason).trim();
              reasonCounts[key] = (reasonCounts[key] || 0) + 1;
            }
          }
        }

        chartsOut.push({
          chartId: row.id,
          chartNumber: row.chart_number,
          facility: row.facility,
          specialty: row.specialty,
          client: row.client,
          submittedBy: row.submitted_by,
          submittedAt: row.submitted_at,
          totalActions: perChartActions,
          correctionCount: perChartCorrections,
          correctionRate: perChartActions > 0
            ? +((perChartCorrections / perChartActions) * 100).toFixed(1)
            : 0,
          byCategory: perChartCategories
        });
      }

      const pct = (num, denom) => denom > 0 ? +((num / denom) * 100).toFixed(1) : 0;
      for (const c of CATEGORIES) {
        byCategory[c].correctionRate = pct(byCategory[c].correctionCount, byCategory[c].total);
      }
      summary.correctionRate = pct(summary.correctionCount, summary.totalActions);

      const byReason = Object.entries(reasonCounts)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);

      res.json({
        success: true,
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          facility: facility || null,
          specialty: specialty || null,
          client: client || null,
          coderId: coderId || null
        },
        summary,
        byCategory,
        byReason,
        charts: chartsOut
      });
    } catch (error) {
      console.error('Error fetching team-lead analytics:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

export const chartController = new ChartController();
