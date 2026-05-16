import { Router } from 'express';
import { chartController } from '../controllers/chartController.js';
import { query } from '../db/connection.js';

const router = Router();

// ═══════════════════════════════════════════════════════════════
// STATIC ROUTES (must be before :chartNumber route)
// ═══════════════════════════════════════════════════════════════

// SLA Statistics
router.get('/stats/sla', chartController.getSLAStats.bind(chartController));

// Analytics endpoints
router.get('/analytics/modifications', chartController.getModificationAnalytics.bind(chartController));
router.get('/analytics/dashboard', chartController.getDashboardAnalytics.bind(chartController));
router.get('/analytics/processing', chartController.getProcessingAnalytics.bind(chartController));
router.get('/analytics/team-lead', chartController.getTeamLeadAnalytics.bind(chartController));

// Filter options
router.get('/filters/facilities', chartController.getFacilities.bind(chartController));
router.get('/filters/specialties', chartController.getSpecialties.bind(chartController));
router.get('/filters/clients', chartController.getClients.bind(chartController));

// Backfill / sync the client column from upstream chart listings (Valerion).
// Frontend dashboards call this whenever they fetch a page of charts so the
// (session_id → client) mapping accumulates over time.
router.post('/sync-clients', chartController.syncClients.bind(chartController));

// ═══════════════════════════════════════════════════════════════
// DEBUG ENDPOINT - get raw data from database with code analysis
// ═══════════════════════════════════════════════════════════════
router.get('/debug/:chartNumber', async (req, res) => {
  try {
    const { chartNumber } = req.params;

    // Get chart
    const chartResult = await query(
      'SELECT * FROM charts WHERE chart_number = $1',
      [chartNumber]
    );

    if (chartResult.rows.length === 0) {
      return res.json({ success: false, error: 'Chart not found' });
    }

    const chart = chartResult.rows[0];

    // Get documents with all fields
    const docsResult = await query(
      `SELECT id, document_type, filename, original_name, file_size, mime_type, 
              s3_key, s3_url, s3_bucket, ocr_status, ocr_processing_time, 
              LENGTH(ocr_text) as ocr_text_length,
              SUBSTRING(ocr_text, 1, 200) as ocr_text_preview
       FROM documents WHERE chart_id = $1`,
      [chart.id]
    );

    // ═══════════════════════════════════════════════════════════════
    // Calculate code-level accuracy for this chart
    //   original_ai_codes: category-keyed object (primary_diagnosis, procedures, …)
    //   user_modifications: flat array tagged with code_type (primary/secondary/cpt)
    //                       and action (ACCEPT/EDIT/DELETE/ADD)
    // ═══════════════════════════════════════════════════════════════
    const originalCodes = chart.original_ai_codes || {};
    const mods = Array.isArray(chart.user_modifications) ? chart.user_modifications : [];
    const AI_CATEGORIES = ['ed_em_level', 'procedures', 'primary_diagnosis', 'secondary_diagnoses', 'modifiers'];

    let totalAICodes = 0;
    for (const category of AI_CATEGORIES) {
      if (Array.isArray(originalCodes[category])) {
        totalAICodes += originalCodes[category].length;
      }
    }

    let modifiedCodes = 0;
    let rejectedCodes = 0;
    let addedCodes = 0;
    const modificationDetails = [];

    const normalizeDebugAction = (raw) => {
      const s = String(raw || '').toLowerCase();
      if (s === 'edit' || s === 'edited' || s === 'modified') return 'modified';
      if (s === 'delete' || s === 'deleted' || s === 'rejected') return 'rejected';
      if (s === 'add' || s === 'added') return 'added';
      return null;
    };

    for (const mod of mods) {
      const action = normalizeDebugAction(mod.action);
      if (!action) continue;

      const entry = {
        category: mod.code_type || 'unknown',
        action,
        code: mod.code || null,
        description: mod.description || null,
        reason: mod.reason || 'No reason provided'
      };

      if (action === 'modified') { modifiedCodes++; modificationDetails.push(entry); }
      else if (action === 'rejected') { rejectedCodes++; modificationDetails.push(entry); }
      else if (action === 'added') { addedCodes++; modificationDetails.push(entry); }
    }

    const unchangedCodes = totalAICodes - modifiedCodes - rejectedCodes;
    const aiAccuracy = totalAICodes > 0 ? ((unchangedCodes / totalAICodes) * 100).toFixed(1) : 'N/A';

    res.json({
      success: true,
      chart: {
        id: chart.id,
        chart_number: chart.chart_number,
        mrn: chart.mrn,
        facility: chart.facility,
        specialty: chart.specialty,
        ai_status: chart.ai_status,
        review_status: chart.review_status,
        original_ai_codes: chart.original_ai_codes,
        user_modifications: chart.user_modifications,
        final_codes: chart.final_codes,
        submitted_at: chart.submitted_at,
        submitted_by: chart.submitted_by,
        // NEW: Error tracking fields
        last_error: chart.last_error,
        last_error_at: chart.last_error_at,
        retry_count: chart.retry_count
      },
      // Code-level accuracy analysis
      codeAnalysis: {
        totalAICodes,
        unchangedCodes,
        modifiedCodes,
        rejectedCodes,
        addedCodes,
        aiAccuracy: `${aiAccuracy}%`,
        modificationDetails
      },
      documents: docsResult.rows,
      message: 'Raw database data with code-level analysis for debugging'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// CHART CRUD OPERATIONS
// ═══════════════════════════════════════════════════════════════

// Get AI status for multiple charts by session IDs
router.post('/batch-status', chartController.getBatchStatus.bind(chartController));

// Get chart by session ID (must be before /:chartNumber)
router.get('/session/:sessionId', chartController.getChartBySessionId.bind(chartController));

// Get all charts (work queue)
router.get('/', chartController.getCharts.bind(chartController));

// Get single chart with full details
router.get('/:chartNumber', chartController.getChart.bind(chartController));

// Save user modifications (auto-save as user edits)
router.post('/:chartNumber/modifications', chartController.saveModifications.bind(chartController));

// Submit final codes to NextCode
router.post('/:chartNumber/submit', chartController.submitCodes.bind(chartController));

// NEW: Retry failed chart processing
router.post('/:chartNumber/retry', chartController.retryChart.bind(chartController));

// Update chart review status
router.patch('/:chartNumber/status', chartController.updateStatus.bind(chartController));

// Delete chart
router.delete('/:chartNumber', chartController.deleteChart.bind(chartController));

export default router;
