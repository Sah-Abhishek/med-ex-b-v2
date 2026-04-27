import axios from 'axios';
import { config } from '../config.js';
import { query } from '../db/connection.js';

class ReviewController {
  constructor() {
    this.baseUrl = config.icdPredictor.baseUrl;
    this.adminSecret = config.icdPredictor.adminSecret;
    this._token = null;
    this._tokenExpiry = 0;
  }

  /**
   * Get a valid JWT for the review API.
   * The review endpoints require a token issued via POST /auth/token (not the static upload token).
   */
  async getToken() {
    console.log('[ReviewController] Requesting fresh JWT');
    const res = await axios.post(`${this.baseUrl}/auth/token`, {
      client_id: 'medex_review',
      hospital_name: 'MedEx Hospital',
      daily_limit: 500
    }, {
      headers: { 'X-Admin-Secret': this.adminSecret, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log('[ReviewController] Fresh JWT obtained');
    return res.data.access_token;
  }

  /**
   * Look up chart by chart_number or session_id
   */
  async findChart(identifier) {
    let result = await query(
      'SELECT id, chart_number, encounter_id, report_ids, diagnosis_codes, procedures FROM charts WHERE chart_number = $1', [identifier]
    );
    if (!result.rows.length) {
      result = await query(
        'SELECT id, chart_number, encounter_id, report_ids, diagnosis_codes, procedures FROM charts WHERE session_id = $1', [identifier]
      );
    }
    return result.rows[0] || null;
  }

  /**
   * GET /api/review/:identifier/codes
   * Fetches review codes from report-level endpoints first.
   * Falls back to encounter-level final_codes_json when report-level codes are empty
   * (multi-report encounters store codes at encounter level, not per-report).
   */
  async getReviewCodes(req, res) {
    try {
      const { identifier } = req.params;
      const chart = await this.findChart(identifier);

      const reportIds = chart?.report_ids || [];
      if (!chart || (reportIds.length === 0 && !chart.encounter_id)) {
        return res.status(404).json({ success: false, error: 'No encounter or report IDs found for this chart' });
      }

      const allCodes = [];

      // 1. Try report-level review codes first
      for (const reportId of reportIds) {
        try {
          const token = await this.getToken();
          const response = await axios.get(`${this.baseUrl}/api/review/report/${reportId}/codes`, {
            headers: { 'Authorization': `Bearer ${token}` }, timeout: 30000
          });
          const codes = Array.isArray(response.data) ? response.data : [];
          for (const code of codes) {
            code._report_id = reportId;
            allCodes.push(code);
          }
        } catch (e) {
          console.warn(`Failed to fetch review codes for report ${reportId}:`, e.message);
        }
      }

      // 2. Merge encounter-level final_codes_json (multi-report encounters store
      //    AI predictions at encounter level, not per-report predicted_codes)
      if (chart.encounter_id) {
        try {
          const token = await this.getToken();
          const encRes = await axios.get(`${this.baseUrl}/api/encounters/${chart.encounter_id}`, {
            headers: { 'Authorization': `Bearer ${token}` }, timeout: 30000
          });
          const finalCodes = encRes.data?.final_codes_json?.codes || [];
          if (finalCodes.length > 0) {
            // Build set of codes already present from report-level
            const existingCodes = new Set(allCodes.map(c => (c.icd_code || '').replace(/\./g, '')));
            let added = 0;
            for (const fc of finalCodes) {
              const normalized = (fc.code || '').replace(/\./g, '');
              if (!existingCodes.has(normalized)) {
                allCodes.push({
                  id: null,
                  icd_code: fc.code,
                  description: fc.description,
                  confidence: fc.confidence,
                  code_type: fc.code_type,
                  sequence_pos: fc.sequence_pos,
                  evidence_json: fc.justification ? { reason: fc.justification } : null,
                  status: 'PENDING_REVIEW',
                  _report_id: reportIds[0] || null,
                  _source: 'encounter',
                });
                added++;
              }
            }
            if (added > 0) {
              console.log(`[ReviewController] Merged ${added} encounter-level codes for ${identifier} (${finalCodes.length} total in encounter)`);
            }
          }
        } catch (e) {
          console.warn(`Failed to fetch encounter codes for ${chart.encounter_id}:`, e.message);
        }
      }

      res.json({ success: true, encounterId: chart.encounter_id, reportIds, codes: allCodes });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Build clean actions for the ICD Predictor review API.
   * In encounter mode, predicted_code_id may not be available (the ICD Predictor
   * stores encounter codes in final_codes_json, not the predicted_codes table).
   * Actions without predicted_code_id are converted appropriately.
   */
  _buildCleanActions(actions) {
    const cleanActions = [];
    // Gateway requires reason >= 20 chars for ADD/EDIT actions
    const ensureReason = (reason, fallback) => {
      if (reason && reason.length >= 20) return reason;
      return fallback;
    };

    for (const a of actions) {
      if (a.predicted_code_id) {
        const clean = { action: a.action, predicted_code_id: a.predicted_code_id };
        if (a.correct_code) clean.correct_code = a.correct_code;
        if (a.correct_description) clean.correct_description = a.correct_description;
        if (a.code_type) clean.code_type = a.code_type;
        if (a.sequence_pos != null) clean.sequence_pos = a.sequence_pos;
        if (a.action === 'ADD' || a.action === 'EDIT') {
          clean.reason = ensureReason(a.reason, a.action === 'EDIT' ? 'Code corrected by coder during review' : 'Code added by coder during review');
        } else if (a.reason) {
          clean.reason = a.reason;
        }
        cleanActions.push(clean);
      } else if (a.action === 'ACCEPT') {
        continue;
      } else if (a.action === 'EDIT') {
        cleanActions.push({
          action: 'ADD',
          correct_code: a.correct_code,
          correct_description: a.correct_description,
          code_type: a.code_type || 'secondary',
          sequence_pos: a.sequence_pos,
          reason: ensureReason(a.reason, 'Code corrected by coder during review'),
        });
      } else if (a.action === 'DELETE') {
        console.log(`[ReviewController] Skipping DELETE action (no predicted_code_id) for code: ${a.correct_code || 'unknown'}`);
        continue;
      } else if (a.action === 'ADD') {
        cleanActions.push({
          action: 'ADD',
          correct_code: a.correct_code,
          correct_description: a.correct_description,
          code_type: a.code_type || 'secondary',
          sequence_pos: a.sequence_pos,
          reason: ensureReason(a.reason, 'Code added by coder during review'),
        });
      }
    }
    return cleanActions;
  }

  /**
   * Build final codes object from original diagnosis_codes + user review actions.
   * Applies accepts, edits, deletes, and adds to produce the final submitted codes.
   */
  _buildFinalCodes(originalDiagnosisCodes, originalProcedures, actions) {
    const dc = originalDiagnosisCodes || {};
    const procs = originalProcedures || [];

    // Normalize codes: strip dots and uppercase for matching (K63.5 == K635)
    const norm = (code) => (code || '').replace(/\./g, '').toUpperCase();

    // Build action map keyed by normalized code.
    // EDIT/DELETE take priority over ACCEPT — process ACCEPTs first so
    // EDIT/DELETE overwrite them (handles same code in multiple categories).
    const actionMap = new Map();
    const addedCodes = [];
    const acceptActions = [];
    const priorityActions = [];

    for (const a of actions) {
      if (a.action === 'ADD') {
        addedCodes.push({
          code: a.correct_code,
          icd_10_code: a.correct_code,
          description: a.correct_description,
          code_type: a.code_type,
          status: 'added',
          sequence_pos: a.sequence_pos || null,
        });
      } else if (a.action === 'ACCEPT') {
        acceptActions.push(a);
      } else {
        priorityActions.push(a);
      }
    }

    // ACCEPTs first, then EDIT/DELETE overwrite
    for (const a of acceptActions) {
      actionMap.set(norm(a.correct_code), a);
    }
    for (const a of priorityActions) {
      const key = a.action === 'EDIT' ? norm(a.original_code || a.correct_code) : norm(a.correct_code);
      actionMap.set(key, a);
    }

    // Helper: apply an action to a code item, return null if deleted
    const applyAction = (item) => {
      const code = item?.icd_10_code || item?.code || item?.cpt_code || '';
      const action = actionMap.get(norm(code));
      if (!action) return { ...item, status: 'accepted' };
      if (action.action === 'DELETE') return null;
      if (action.action === 'EDIT') {
        return {
          ...item,
          icd_10_code: action.correct_code,
          code: action.correct_code,
          description: action.correct_description,
          status: 'edited',
        };
      }
      return { ...item, status: 'accepted' };
    };

    // Process each category
    const processArray = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr.map(applyAction).filter(Boolean);
    };

    const processSingle = (item) => {
      if (!item) return null;
      return applyAction(item);
    };

    const finalCodes = {};
    if (dc.principal_diagnosis) finalCodes.principal_diagnosis = processSingle(dc.principal_diagnosis);
    if (dc.primary_diagnosis) finalCodes.primary_diagnosis = processArray(dc.primary_diagnosis);
    if (dc.secondary_diagnoses) finalCodes.secondary_diagnoses = processArray(dc.secondary_diagnoses);
    if (dc.reason_for_admit) finalCodes.reason_for_admit = processArray(dc.reason_for_admit);
    if (dc.ed_em_level) finalCodes.ed_em_level = processArray(dc.ed_em_level);
    finalCodes.procedures = processArray(procs);

    // Append added codes to the appropriate category
    for (const added of addedCodes) {
      const target = added.code_type === 'cpt' ? 'procedures'
        : added.code_type === 'primary' ? 'primary_diagnosis'
        : 'secondary_diagnoses';
      if (!finalCodes[target]) finalCodes[target] = [];
      finalCodes[target].push(added);
    }

    return finalCodes;
  }

  /**
   * POST /api/review/:identifier/submit
   * Submits review actions via report-level endpoints.
   * Groups actions by report_id and submits to each report separately.
   */
  async submitReview(req, res) {
    try {
      const { identifier } = req.params;
      const { coder_id, actions } = req.body;

      console.log(`[ReviewController] Submit for ${identifier}: ${actions?.length} actions received`);
      if (actions) {
        for (const a of actions) {
          console.log(`[ReviewController]   ${a.action} | code=${a.correct_code || 'n/a'} | predicted_code_id=${a.predicted_code_id || 'none'} | reason=${(a.reason || '').substring(0, 50)}`);
        }
      }

      if (!actions || !Array.isArray(actions) || actions.length === 0) {
        return res.status(400).json({ success: false, error: 'Actions array is required' });
      }

      const chart = await this.findChart(identifier);
      if (!chart) {
        return res.status(404).json({ success: false, error: 'Chart not found for this identifier' });
      }

      // Gateway requires a valid UUID for coder_id — fall back to config if missing or not UUID-shaped
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const coderId = (coder_id && uuidRegex.test(coder_id))
        ? coder_id
        : (config.icdPredictor.coderId || '074d18ae-50e0-41d1-8e1d-50ef8a19196f');

      const reportIds = chart.report_ids || [];
      if (reportIds.length === 0) {
        return res.status(400).json({ success: false, error: 'No report IDs found for this chart' });
      }

      // Group actions by report_id if present, otherwise send to first report
      const actionsByReport = {};
      const unassigned = [];

      for (const action of actions) {
        if (action._report_id && reportIds.includes(action._report_id)) {
          if (!actionsByReport[action._report_id]) actionsByReport[action._report_id] = [];
          actionsByReport[action._report_id].push(action);
        } else {
          unassigned.push(action);
        }
      }

      if (unassigned.length > 0) {
        const firstReport = reportIds[0];
        if (!actionsByReport[firstReport]) actionsByReport[firstReport] = [];
        actionsByReport[firstReport].push(...unassigned);
      }

      const allResults = [];
      let totalActions = 0;

      for (const [reportId, reportActions] of Object.entries(actionsByReport)) {
        const cleanActions = this._buildCleanActions(reportActions);
        if (cleanActions.length === 0) continue;

        try {
          const token = await this.getToken();
          const url = `${this.baseUrl}/api/review/report/${reportId}/submit`;
          const body = { coder_id: coderId, actions: cleanActions };
          console.log(`[ReviewController] POST ${url}`);
          console.log(`[ReviewController] Token: ${token.substring(0, 30)}...`);
          console.log(`[ReviewController] Body: ${JSON.stringify(body).substring(0, 300)}`);

          let response;
          try {
            response = await axios.post(url, body, {
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              timeout: 30000
            });
          } catch (firstErr) {
            // Retry once on 502 Gateway proxy error per API docs
            if (firstErr.response?.status === 502) {
              console.log(`[ReviewController] Got 502 for report ${reportId}, retrying once after 2s...`);
              await new Promise(r => setTimeout(r, 2000));
              const retryToken = await this.getToken();
              response = await axios.post(url, body, {
                headers: { 'Authorization': `Bearer ${retryToken}`, 'Content-Type': 'application/json' },
                timeout: 30000
              });
            } else {
              throw firstErr;
            }
          }

          console.log(`[ReviewController] Response: ${response.status} ${JSON.stringify(response.data).substring(0, 200)}`);
          totalActions += cleanActions.length;
          allResults.push({ reportId, success: true, data: response.data });
        } catch (e) {
          console.error(`[ReviewController] Submit failed for report ${reportId}:`);
          console.error(`[ReviewController] Status: ${e.response?.status}`);
          console.error(`[ReviewController] Data: ${JSON.stringify(e.response?.data)}`);
          console.error(`[ReviewController] Message: ${e.message}`);
          allResults.push({ reportId, success: false, error: e.response?.data?.detail || e.message });
        }
      }

      // Build final codes from the original diagnosis_codes + user actions
      const finalCodes = this._buildFinalCodes(chart.diagnosis_codes, chart.procedures, actions);
      const userModifications = actions.map(a => ({
        action: a.action,
        code: a.correct_code,
        description: a.correct_description,
        code_type: a.code_type,
        reason: a.reason || null,
        reason_option_id: a.reason_option_id || null,
        reason_option_label: a.reason_option_label || null,
        predicted_code_id: a.predicted_code_id || null,
      }));

      // Store final codes, user modifications, and update statuses in the database
      await query(
        `UPDATE charts SET
          final_codes = $1,
          user_modifications = $2,
          diagnosis_codes = $3,
          ai_status = 'submitted',
          review_status = 'submitted',
          submitted_at = CURRENT_TIMESTAMP,
          submitted_by = $4,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $5`,
        [
          JSON.stringify(finalCodes),
          JSON.stringify(userModifications),
          JSON.stringify(finalCodes),
          coderId,
          chart.id
        ]
      );

      res.json({
        success: true,
        total_actions: totalActions,
        reports: allResults
      });
    } catch (error) {
      console.error('Review submit error:', error.response?.data || error.message);
      res.status(500).json({ success: false, error: error.response?.data?.detail || error.message });
    }
  }

  /**
   * GET /api/review/rules
   */
  async listRules(req, res) {
    try {
      const token = await this.getToken();
      const { priority, applies_to, include_inactive } = req.query;
      const params = {};
      if (priority) params.priority = priority;
      if (applies_to) params.applies_to = applies_to;
      if (include_inactive) params.include_inactive = include_inactive;
      const response = await axios.get(`${this.baseUrl}/api/rules`, {
        headers: { 'Authorization': `Bearer ${token}` },
        params,
        timeout: 30000
      });
      res.json({ success: true, ...response.data });
    } catch (error) {
      console.error('List rules error:', error.response?.data || error.message);
      res.status(500).json({ success: false, error: error.response?.data?.detail || error.message });
    }
  }

  /**
   * POST /api/review/rules
   */
  async createRule(req, res) {
    try {
      const token = await this.getToken();
      const { rule_text, applies_to, priority } = req.body;
      const response = await axios.post(`${this.baseUrl}/api/rules`, {
        rule_text,
        applies_to: applies_to || 'ALL',
        priority: priority || 'NORMAL',
        created_by: config.icdPredictor.coderId || '074d18ae-50e0-41d1-8e1d-50ef8a19196f'
      }, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 30000
      });
      res.status(201).json({ success: true, rule: response.data });
    } catch (error) {
      console.error('Create rule error:', error.response?.data || error.message);
      const status = error.response?.status || 500;
      res.status(status).json({ success: false, error: error.response?.data?.detail || error.message });
    }
  }

  /**
   * PATCH /api/review/rules/:ruleId/deactivate
   */
  async deactivateRule(req, res) {
    try {
      const token = await this.getToken();
      const { ruleId } = req.params;
      const response = await axios.patch(`${this.baseUrl}/api/rules/${ruleId}/deactivate`, null, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 30000
      });
      res.json({ success: true, ...response.data });
    } catch (error) {
      console.error('Deactivate rule error:', error.response?.data || error.message);
      const status = error.response?.status || 500;
      res.status(status).json({ success: false, error: error.response?.data?.detail || error.message });
    }
  }

  /**
   * Map Xeno gateway report_type values to the doc_type codes the
   * gold-dataset API accepts: HP · OP · PATH · RAD · DS · LAB · CONSULT · OP_NOTE
   *
   * Xeno report_type values (from /api/report/{id}/text response):
   *   HP · DISCHARGE_SUMMARY · OPERATIVE_NOTE · LAB · RADIOLOGY ·
   *   ED_NOTE · CLINIC_NOTE · PATHOLOGY · null
   */
  _mapReportTypeToGoldDocType(reportType) {
    const table = {
      'HP': 'HP',
      'DISCHARGE_SUMMARY': 'DS',
      'OPERATIVE_NOTE': 'OP',
      'LAB': 'LAB',
      'RADIOLOGY': 'RAD',
      'ED_NOTE': 'CONSULT',
      'CLINIC_NOTE': 'CONSULT',
      'PATHOLOGY': 'PATH',
    };
    return table[reportType] || 'CONSULT';
  }

  /**
   * Fetch de-identified OCR text for every report belonging to a chart,
   * using the Xeno gateway text endpoints.
   *
   * Prefers the single-call encounter endpoint when chart.encounter_id is
   * set; falls back to looping per report_id otherwise.
   *
   * Returns an array of { report_id, report_type, status, deidentified_text }
   * with empty-text reports filtered out.
   */
  async _fetchXenoReportText(chart) {
    const token = await this.getToken();
    const headers = { Authorization: `Bearer ${token}` };

    // Preferred path: one call for all reports in the encounter.
    if (chart.encounter_id) {
      try {
        const resp = await axios.get(
          `${this.baseUrl}/api/encounters/${chart.encounter_id}/text`,
          { headers, timeout: 30000 }
        );
        const reports = Array.isArray(resp.data?.reports) ? resp.data.reports : [];
        console.log(
          `[ReviewController] Xeno encounter-text: encounter=${chart.encounter_id} ` +
          `report_count=${resp.data?.report_count ?? reports.length}`
        );
        return reports.filter(r => (r.deidentified_text || '').trim().length > 0);
      } catch (err) {
        const status = err.response?.status;
        console.warn(
          `[ReviewController] Xeno encounter-text failed (${status || err.code || 'err'}) for ` +
          `encounter=${chart.encounter_id} — falling back to per-report lookup`
        );
        // Fall through to per-report lookup
      }
    }

    // Fallback: loop over report_ids individually.
    const reportIds = Array.isArray(chart.report_ids) ? chart.report_ids : [];
    const out = [];
    for (const reportId of reportIds) {
      try {
        const resp = await axios.get(
          `${this.baseUrl}/api/report/${reportId}/text`,
          { headers, timeout: 30000 }
        );
        const text = resp.data?.deidentified_text || '';
        if (text.trim().length > 0) out.push(resp.data);
      } catch (err) {
        console.warn(
          `[ReviewController] Xeno report-text failed for ${reportId}:`,
          err.response?.status || err.message
        );
      }
    }
    console.log(
      `[ReviewController] Xeno per-report fallback: fetched ${out.length}/${reportIds.length}`
    );
    return out;
  }

  /**
   * Find the chart row that corresponds to the gold-dataset payload.
   * Tries (in order) the payload's chart_id (= our chart_number), then
   * encounter_id as-is, then with a leading "ENC-" prefix stripped so
   * synthetic encounter_ids like "ENC-<chart_number>" still resolve.
   */
  async _findChartForGoldDataset(encounterId, chartIdFallback) {
    const tryQuery = async (col, val) => {
      if (!val) return null;
      const r = await query(
        `SELECT id, chart_number, encounter_id FROM charts WHERE ${col} = $1 LIMIT 1`,
        [val]
      );
      return r.rows[0] || null;
    };

    // 1. Explicit chart_id from the payload (frontend sets this from chart.ChartNo)
    let chart = await tryQuery('chart_number', chartIdFallback);
    if (chart) return chart;

    // 2. encounter_id as provided
    chart = await tryQuery('encounter_id', encounterId);
    if (chart) return chart;

    // 3. Strip synthetic "ENC-" prefix and try chart_number / session_id
    const stripped = String(encounterId || '').replace(/^ENC-/, '');
    if (stripped && stripped !== encounterId) {
      chart = await tryQuery('chart_number', stripped);
      if (chart) return chart;
      chart = await tryQuery('session_id', stripped);
      if (chart) return chart;
    }

    // 4. Last resort — session_id = encounter_id
    chart = await tryQuery('session_id', encounterId);
    return chart;
  }

  /**
   * POST /api/review/gold-dataset/submit
   * Proxies the coder's annotated session to the Valerion Gold Dataset API.
   *
   * The gold-dataset server requires OCR text to be pre-stored via
   * POST /api/encounter-documents before a submit can succeed (otherwise 422).
   * This handler therefore:
   *   1. Looks up the chart by chart_id / encounter_id in our DB to get its
   *      Xeno encounter_id and report_ids.
   *   2. Pulls de-identified OCR text for every report from the Xeno gateway
   *      (GET /api/encounters/{id}/text — single call — with a per-report
   *      fallback).
   *   3. POSTs each report's text to GOLD_DATASET_BASE_URL/api/encounter-documents,
   *      classified by Xeno's report_type (HP, OPERATIVE_NOTE → OP, etc.).
   *   4. Forwards the gold-dataset submit payload to
   *      GOLD_DATASET_BASE_URL/api/gold-dataset/submit.
   *
   * The browser never talks to the gold-dataset host directly — avoids CORS
   * and HTTPS-to-HTTP mixed-content issues — and the OCR text is pulled
   * server-to-server from the Xeno gateway on submit (so we don't have to
   * persist it locally).
   */
  async submitGoldDataset(req, res) {
    const goldBaseUrl = config.goldDataset.baseUrl;
    const timeout = config.goldDataset.timeout;
    const payload = req.body || {};

    console.log(
      `[ReviewController] Gold dataset submit: session=${payload.session_id} ` +
      `encounter=${payload.encounter_id} coder=${payload.coder_id} ` +
      `specialty=${payload.primary_specialty} ` +
      `annotations=${Object.keys(payload.code_annotations || {}).length}`
    );

    if (!payload.session_id || !payload.encounter_id || !payload.code_annotations) {
      return res.status(400).json({
        success: false,
        error: 'session_id, encounter_id and code_annotations are required',
      });
    }

    try {
      // ── 1. Resolve chart ──────────────────────────────────────────────
      // We need the full chart row (including report_ids) to look up OCR
      // text on the Xeno gateway, so re-query here — the lightweight helper
      // only selects enough columns to resolve identity.
      const chartLookup = await this._findChartForGoldDataset(
        payload.encounter_id,
        payload.chart_id
      );
      if (!chartLookup) {
        return res.status(404).json({
          success: false,
          error: `Chart not found for encounter_id=${payload.encounter_id} / chart_id=${payload.chart_id}`,
        });
      }
      const chartRes = await query(
        `SELECT id, chart_number, encounter_id, report_ids
         FROM charts WHERE id = $1`,
        [chartLookup.id]
      );
      const chart = chartRes.rows[0];

      // ── 2. Fetch OCR text from Xeno gateway ───────────────────────────
      const xenoReports = await this._fetchXenoReportText(chart);
      if (xenoReports.length === 0) {
        console.warn(
          `[ReviewController] No OCR text from Xeno for chart_id=${chart.id} ` +
          `(chart_number=${chart.chart_number}, encounter_id=${chart.encounter_id})`
        );
        return res.status(422).json({
          success: false,
          error: `No de-identified OCR text available from Xeno gateway for ` +
                 `chart ${chart.chart_number || chart.id}. The reports may still ` +
                 `be in PENDING_OCR, or the gateway has no text for them.`,
        });
      }

      // ── 3. Pre-upload each report's text to /api/encounter-documents ──
      const uploadResults = [];
      let uploadedCount = 0;
      for (const rpt of xenoReports) {
        const docType = this._mapReportTypeToGoldDocType(rpt.report_type);
        const docName = `${rpt.report_type || 'REPORT'}_${(rpt.report_id || '').slice(0, 8)}`;
        try {
          const resp = await axios.post(
            `${goldBaseUrl}/api/encounter-documents`,
            {
              encounter_id: payload.encounter_id,
              doc_type: docType,
              doc_name: docName,
              ocr_text: rpt.deidentified_text,
              ocr_task_id: rpt.report_id || undefined,
            },
            { headers: { 'Content-Type': 'application/json' }, timeout }
          );
          uploadedCount++;
          uploadResults.push({
            report_id: rpt.report_id,
            report_type: rpt.report_type,
            doc_type: docType,
            char_count: resp.data?.char_count ?? (rpt.deidentified_text || '').length,
            status: 'uploaded',
          });
          console.log(
            `[ReviewController]   OCR uploaded: ${docType} (${rpt.report_type} ${rpt.report_id}) ` +
            `chars=${resp.data?.char_count ?? '?'}`
          );
        } catch (docErr) {
          const errBody = docErr.response?.data;
          const msg = errBody?.detail || errBody?.message || docErr.message;
          console.error(
            `[ReviewController]   OCR upload failed for ${docType} (${rpt.report_id}):`,
            msg
          );
          uploadResults.push({
            report_id: rpt.report_id,
            report_type: rpt.report_type,
            doc_type: docType,
            status: 'failed',
            error: msg,
          });
        }
      }

      if (uploadedCount === 0) {
        return res.status(502).json({
          success: false,
          error: `All ${xenoReports.length} document OCR upload(s) to the gold-dataset server failed.`,
          documentsUploaded: uploadResults,
        });
      }

      // ── 4. Forward the submit ─────────────────────────────────────────
      const response = await axios.post(
        `${goldBaseUrl}/api/gold-dataset/submit`,
        payload,
        { headers: { 'Content-Type': 'application/json' }, timeout }
      );
      console.log(
        `[ReviewController] Gold dataset accepted: sft=${response.data?.accepted_sft_records} ` +
        `dpo=${response.data?.accepted_dpo_pairs} docs=${uploadedCount}/${xenoReports.length}`
      );
      return res.json({
        success: true,
        documentsUploaded: uploadResults,
        ...response.data,
      });
    } catch (error) {
      const status = error.response?.status || 500;
      const body = error.response?.data;
      console.error(
        '[ReviewController] Gold dataset submit failed:',
        status,
        body || error.message
      );
      return res.status(status).json({
        success: false,
        error: body?.message || body?.detail || error.message,
        details: body,
      });
    }
  }
}

export const reviewController = new ReviewController();
