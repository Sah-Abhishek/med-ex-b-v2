import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config.js';

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
    if (error) console.error(`    └─ Error:`, error.message || error);
  },
  warn: (stage, message, data = null) => {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] ⚠️  [${stage}] ${message}`);
    if (data) console.warn(`    └─ Data:`, data);
  }
};

class AIService {
  constructor() {
    this.baseUrl = config.icdPredictor.baseUrl;
    this.token = config.icdPredictor.token;
    this.encounterType = config.icdPredictor.encounterType;
    this.pollInterval = config.icdPredictor.pollInterval;
    this.pollTimeout = config.icdPredictor.pollTimeout;

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.token}`
      },
      timeout: 60000
    });
  }

  /**
   * Upload a single file to the ICD Predictor and get predicted codes.
   * Used when there's only one document for a chart.
   *
   * Single-file workflow:
   *   POST /api/upload → poll /api/task/{task_id} → GET /api/report/{report_id}
   *   Codes are in report.predicted_codes[]
   */
  async processSingleFile(fileBuffer, filename, mimeType, reportType) {
    try {
      // Step 1: Upload file
      log.info('ICD_UPLOAD', `Uploading single file: ${filename}`);
      const form = new FormData();
      form.append('file', fileBuffer, { filename, contentType: mimeType });
      form.append('encounter_type', this.encounterType);
      form.append('report_type', reportType || 'CLINIC_NOTE');

      const uploadRes = await this.client.post('/api/upload', form, {
        headers: { ...form.getHeaders() },
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024
      });

      const { report_id, task_id } = uploadRes.data;
      log.success('ICD_UPLOAD', `File uploaded`, { report_id, task_id });

      // Step 2: Poll task until done
      await this.pollTask(`/api/task/${task_id}`, task_id);

      // Step 3: Retrieve coded report
      log.info('ICD_RETRIEVE', `Fetching report: ${report_id}`);
      const reportRes = await this.client.get(`/api/report/${report_id}`);
      const report = reportRes.data;
      log.success('ICD_RETRIEVE', `Report retrieved`, { codesCount: report.predicted_codes?.length });

      // Step 4: Transform to internal format
      const transformed = this.transformPredictedCodes(report.predicted_codes || [], report);
      return { success: true, data: transformed, reportId: report_id };
    } catch (error) {
      log.error('ICD_SINGLE', `Single file processing failed`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process multiple files using the Encounter workflow.
   *
   * Encounter workflow (from API docs):
   *   1. POST /api/encounters                          → create encounter, get encounter_id
   *   2. POST /api/upload/batch                         → upload all files with encounter_id + report_types
   *   3. POST /api/encounters/{id}/run                  → trigger pipeline
   *   4. GET  /api/encounters/{id}/status/{task_id}     → poll until COMPLETE
   *   5. GET  /api/encounters/{id}                      → retrieve encounter with consolidated codes
   *
   * Encounter response shape:
   *   { id, status, clinical_summary, final_codes_json: { codes: [...], audit_notes }, pipeline_timing }
   *
   * Codes are in final_codes_json.codes[] (NOT predicted_codes).
   * Each code: { code, description, code_type, confidence, sequence_pos, justification }
   */
  async processEncounter(files, chartInfo) {
    try {
      chartInfo = chartInfo || {};
      // Step 1: Create encounter
      log.info('ICD_ENCOUNTER', `Creating encounter for ${files.length} files`);
      // Validate encounter_date — API rejects empty string, needs valid date or null
      let encounterDate = null;
      if (chartInfo.dateOfService && chartInfo.dateOfService.trim()) {
        // Extract YYYY-MM-DD from possible ISO datetime or MM/DD/YYYY string
        const raw = chartInfo.dateOfService.trim();
        const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
        const usMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (isoMatch) {
          encounterDate = isoMatch[1];
        } else if (usMatch) {
          encounterDate = `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
        }
      }

      const encounterBody = {
        mrn: chartInfo.mrn && chartInfo.mrn.trim() ? chartInfo.mrn.trim() : '00000000',
        encounter_type: this.encounterType || 'OUTPATIENT'
      };

      // Only include optional fields if they have valid values — API rejects empty strings
      if (encounterDate) encounterBody.encounter_date = encounterDate;
      if (chartInfo.facility && chartInfo.facility.trim()) encounterBody.facility = chartInfo.facility.trim();
      if (chartInfo.specialty && chartInfo.specialty.trim()) encounterBody.department = chartInfo.specialty.trim();

      const encounterRes = await this.client.post('/api/encounters', encounterBody);
      const encounterId = encounterRes.data.id || encounterRes.data.encounter_id;
      log.success('ICD_ENCOUNTER', `Encounter created: ${encounterId}`);

      // Step 2: Upload all files via batch
      log.info('ICD_BATCH_UPLOAD', `Uploading ${files.length} files to encounter ${encounterId}`);
      const form = new FormData();

      for (const file of files) {
        form.append('files', file.buffer, { filename: file.filename, contentType: file.mimeType });
      }
      form.append('encounter_type', this.encounterType);
      form.append('encounter_id', encounterId);

      // Build report_types string — e.g. "HP,OPERATIVE_NOTE"
      const reportTypes = files.map(f => f.reportType || 'CLINIC_NOTE').join(',');
      form.append('report_types', reportTypes);
      log.info('ICD_BATCH_UPLOAD', `Report types: ${reportTypes}`);

      const batchRes = await this.client.post('/api/upload/batch', form, {
        headers: { ...form.getHeaders() },
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024
      });

      log.success('ICD_BATCH_UPLOAD', `Batch upload complete`, {
        saved: batchRes.data.saved,
        failed: batchRes.data.failed
      });

      if (batchRes.data.saved === 0) {
        throw new Error('All files failed to upload to ICD Predictor');
      }

      // Save report IDs for review API (report-level review works, encounter-level doesn't)
      const reportIds = (batchRes.data.results || [])
        .filter(r => r.success && r.report_id)
        .map(r => r.report_id);

      // Step 3: Trigger encounter pipeline
      log.info('ICD_RUN', `Triggering pipeline for encounter ${encounterId}`);
      const runRes = await this.client.post(`/api/encounters/${encounterId}/run`);
      const taskId = runRes.data.task_id;
      log.success('ICD_RUN', `Pipeline triggered`, { task_id: taskId });

      // Step 4: Poll encounter task status
      await this.pollTask(`/api/encounters/${encounterId}/status/${taskId}`, taskId);

      // Step 5: Retrieve encounter with consolidated codes
      log.info('ICD_RETRIEVE', `Fetching encounter results: ${encounterId}`);
      const resultRes = await this.client.get(`/api/encounters/${encounterId}`);
      const encounter = resultRes.data;

      // Codes live in final_codes_json.codes (encounter endpoint does NOT have predicted_codes)
      const codes = encounter.final_codes_json?.codes || [];
      const auditNotes = encounter.final_codes_json?.audit_notes || '';
      log.success('ICD_RETRIEVE', `Encounter retrieved`, {
        status: encounter.status,
        codesCount: codes.length,
        hasClinicalSummary: !!encounter.clinical_summary,
        auditNotes: auditNotes.substring(0, 100)
      });

      // Step 6: Transform to internal format
      const transformed = this.transformEncounterCodes(codes, encounter);

      // Preserve the raw encounter payload (for frontend rendering of clinical_summary,
      // final_codes_json, agent4_full.feedback, coding_categories, etc.).
      // pipeline_timing is intentionally excluded here — it's reserved for admin analytics
      // and should be persisted separately when that view is built.
      const { pipeline_timing, ...encounterPayload } = encounter;

      return { success: true, data: transformed, encounterId, reportIds, encounterPayload };
    } catch (error) {
      log.error('ICD_ENCOUNTER', `Encounter processing failed`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Poll a task endpoint until status is SUCCESS or FAILURE.
   * Throws on FAILURE or timeout.
   */
  async pollTask(endpoint, taskId) {
    const startTime = Date.now();
    log.info('ICD_POLL', `Polling task ${taskId} (interval: ${this.pollInterval}ms, timeout: ${this.pollTimeout}ms)`);

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.pollTimeout) {
        throw new Error(`Task ${taskId} timed out after ${Math.round(elapsed / 1000)}s`);
      }

      await this.sleep(this.pollInterval);

      const pollRes = await this.client.get(endpoint);
      const status = pollRes.data.status;

      log.info('ICD_POLL', `Task ${taskId}: ${status} (${Math.round(elapsed / 1000)}s elapsed)`);

      if (status === 'SUCCESS' || status === 'COMPLETE') {
        log.success('ICD_POLL', `Task ${taskId} completed`);
        return pollRes.data;
      }

      if (status === 'FAILURE' || status === 'ERROR') {
        const errorMsg = pollRes.data.error || pollRes.data.detail || 'Pipeline failed';
        throw new Error(`ICD Predictor pipeline failed: ${errorMsg}`);
      }

      // PENDING or STARTED — keep polling
    }
  }

  /**
   * Transform encounter final_codes_json.codes into the internal format.
   *
   * Encounter code shape (from final_codes_json.codes):
   *   { code, description, code_type, confidence, sequence_pos, justification }
   *
   * Note: field names differ from single-report predicted_codes:
   *   encounter uses "code" + "justification"
   *   single-report uses "icd_code" + evidence_json.justification
   */
  transformEncounterCodes(codes, encounter) {
    const primaryDiagnosis = [];
    const secondaryDiagnoses = [];
    const procedures = [];

    for (const code of codes) {
      // Encounter codes use "code" field; single-report uses "icd_code"
      const icdCode = code.code || code.icd_code || '';
      const justification = code.justification || code.evidence_json?.justification || '';

      const transformed = {
        icd_10_code: icdCode,
        code: icdCode,
        description: code.description || '',
        confidence: code.confidence,
        ai_reasoning: justification,
        status: code.status || 'PENDING_REVIEW',
        sequence_pos: code.sequence_pos
      };

      switch (code.code_type) {
        case 'primary':
          primaryDiagnosis.push(transformed);
          break;
        case 'secondary':
          secondaryDiagnoses.push(transformed);
          break;
        case 'procedure':
        case 'cpt':
          procedures.push({
            cpt_code: icdCode,
            code: icdCode,
            procedure_name: code.description || '',
            description: code.description || '',
            confidence: code.confidence,
            ai_reasoning: justification,
            status: code.status || 'PENDING_REVIEW',
            sequence_pos: code.sequence_pos
          });
          break;
        default:
          secondaryDiagnoses.push(transformed);
          break;
      }
    }

    // Sort by sequence_pos
    primaryDiagnosis.sort((a, b) => (a.sequence_pos || 0) - (b.sequence_pos || 0));
    secondaryDiagnoses.sort((a, b) => (a.sequence_pos || 0) - (b.sequence_pos || 0));
    procedures.sort((a, b) => (a.sequence_pos || 0) - (b.sequence_pos || 0));

    // Map encounter clinical_summary to the structure the frontend expects
    const cs = encounter.clinical_summary || {};
    const aiSummary = {
      chief_complaint: {
        text: cs.chief_complaint || '',
      },
      history_of_present_illness: {
        text: cs.clinical_context || '',
      },
      assessment_and_plan: {
        diagnoses: [
          ...(cs.primary_diagnoses || []),
          ...(cs.secondary_diagnoses || [])
        ],
      },
      diagnostic_results: {
        labs: Object.entries(cs.significant_labs || {}).map(([test, value]) => ({
          test,
          value: typeof value === 'string' ? value : String(value),
        })),
        imaging: [],
        other_tests: [],
      },
      // Pass through any extra fields the encounter summary may have
      ...Object.fromEntries(
        Object.entries(cs).filter(([k]) => ![
          'chief_complaint', 'clinical_context', 'significant_labs',
          'primary_diagnoses', 'secondary_diagnoses', 'procedures_performed'
        ].includes(k))
      ),
    };

    return {
      ai_narrative_summary: aiSummary,

      diagnosis_codes: {
        reason_for_admit: [],
        ed_em_level: [],
        primary_diagnosis: primaryDiagnosis,
        secondary_diagnoses: secondaryDiagnoses,
        modifiers: [],
        principal_diagnosis: primaryDiagnosis[0] || null
      },

      procedures,

      coding_notes: {
        documentation_gaps: [],
        physician_queries_needed: [],
        coding_tips: [],
        compliance_alerts: [],
        audit_notes: encounter.final_codes_json?.audit_notes || ''
      },

      medications: [],
      vitals_summary: {},
      lab_results_summary: [],
      metadata: {
        source: 'icd_predictor_gateway',
        encounter_type: encounter.encounter_type || this.encounterType,
        pipeline_timing: encounter.pipeline_timing || {},
        total_codes_extracted: codes.length
      }
    };
  }

  /**
   * Transform single-report predicted_codes array into the internal format.
   *
   * Single-report code shape (from predicted_codes):
   *   { id, icd_code, description, confidence, code_type, sequence_pos, evidence_json, status }
   */
  transformPredictedCodes(predictedCodes, sourceResponse) {
    const primaryDiagnosis = [];
    const secondaryDiagnoses = [];
    const procedures = [];

    for (const code of predictedCodes) {
      const icdCode = code.icd_code || code.code || '';
      const justification = code.evidence_json?.justification || code.justification || '';

      const transformed = {
        icd_10_code: icdCode,
        code: icdCode,
        description: code.description || '',
        confidence: code.confidence,
        ai_reasoning: justification,
        status: code.status,
        predicted_code_id: code.id,
        sequence_pos: code.sequence_pos
      };

      switch (code.code_type) {
        case 'primary':
          primaryDiagnosis.push(transformed);
          break;
        case 'secondary':
          secondaryDiagnoses.push(transformed);
          break;
        case 'procedure':
        case 'cpt':
          procedures.push({
            cpt_code: icdCode,
            code: icdCode,
            procedure_name: code.description || '',
            description: code.description || '',
            confidence: code.confidence,
            ai_reasoning: justification,
            status: code.status,
            predicted_code_id: code.id,
            sequence_pos: code.sequence_pos
          });
          break;
        default:
          secondaryDiagnoses.push(transformed);
          break;
      }
    }

    // Sort by sequence_pos
    primaryDiagnosis.sort((a, b) => (a.sequence_pos || 0) - (b.sequence_pos || 0));
    secondaryDiagnoses.sort((a, b) => (a.sequence_pos || 0) - (b.sequence_pos || 0));
    procedures.sort((a, b) => (a.sequence_pos || 0) - (b.sequence_pos || 0));

    return {
      ai_narrative_summary: {},

      diagnosis_codes: {
        reason_for_admit: [],
        ed_em_level: [],
        primary_diagnosis: primaryDiagnosis,
        secondary_diagnoses: secondaryDiagnoses,
        modifiers: [],
        principal_diagnosis: primaryDiagnosis[0] || null
      },

      procedures,

      coding_notes: {
        documentation_gaps: [],
        physician_queries_needed: [],
        coding_tips: [],
        compliance_alerts: []
      },

      medications: [],
      vitals_summary: {},
      lab_results_summary: [],
      metadata: {
        source: 'icd_predictor_gateway',
        encounter_type: sourceResponse.encounter_type || this.encounterType,
        pipeline_timing: sourceResponse.pipeline_timing || {},
        total_codes_extracted: predictedCodes.length
      }
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const aiService = new AIService();
