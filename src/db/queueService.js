import { pool, query } from './connection.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Database-backed job queue for async document processing
 * Uses PostgreSQL with FOR UPDATE SKIP LOCKED for safe concurrent access
 * 
 * UPDATED: Added exponential backoff for retries
 */
export const QueueService = {

  // Retry backoff configuration (in milliseconds)
  RETRY_DELAYS: [
    30 * 1000,      // 1st retry: 30 seconds
    60 * 1000,      // 2nd retry: 1 minute  
    2 * 60 * 1000,  // 3rd retry: 2 minutes
    5 * 60 * 1000,  // 4th retry: 5 minutes
    10 * 60 * 1000  // 5th+ retry: 10 minutes
  ],

  /**
   * Calculate retry delay based on attempt number
   */
  getRetryDelay(attempts) {
    const index = Math.min(attempts, this.RETRY_DELAYS.length - 1);
    return this.RETRY_DELAYS[index];
  },

  /**
   * Add a new job to the processing queue
   */
  async addJob(chartId, chartNumber, jobData) {
    const jobId = uuidv4();

    const result = await query(
      `INSERT INTO processing_queue (
        job_id, chart_id, chart_number, status, job_data
      ) VALUES ($1, $2, $3, 'pending', $4)
      RETURNING *`,
      [jobId, chartId, chartNumber, JSON.stringify(jobData)]
    );

    console.log(`📋 Job queued: ${jobId} for chart ${chartNumber}`);
    return result.rows[0];
  },

  /**
   * Claim the next available job for processing
   * Uses FOR UPDATE SKIP LOCKED to prevent race conditions
   * 
   * UPDATED: Now respects retry_after for failed jobs
   */
  async claimNextJob(workerId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Find and lock the next pending job OR failed job ready for retry
      // Failed jobs are only picked up if retry_after has passed (or is null)
      const result = await client.query(
        `SELECT * FROM processing_queue 
         WHERE 
           status = 'pending' 
           OR (
             status = 'failed' 
             AND attempts < max_attempts 
             AND (retry_after IS NULL OR retry_after <= NOW())
           )
         ORDER BY 
           CASE WHEN status = 'pending' THEN 0 ELSE 1 END,  -- Prioritize pending
           created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return null; // No jobs available
      }

      const job = result.rows[0];

      // Update job to processing status
      await client.query(
        `UPDATE processing_queue SET 
          status = 'processing',
          worker_id = $1,
          locked_at = CURRENT_TIMESTAMP,
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          attempts = attempts + 1,
          retry_after = NULL
         WHERE id = $2`,
        [workerId, job.id]
      );

      await client.query('COMMIT');

      const isRetry = job.attempts > 0;
      console.log(`🔒 Job ${isRetry ? 'retrying' : 'claimed'}: ${job.job_id} by worker ${workerId} (attempt ${job.attempts + 1}/${job.max_attempts})`);

      return { ...job, status: 'processing', worker_id: workerId, attempts: job.attempts + 1 };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Mark a job as completed
   */
  async completeJob(jobId) {
    const result = await query(
      `UPDATE processing_queue SET 
        status = 'completed',
        completed_at = CURRENT_TIMESTAMP,
        locked_at = NULL,
        retry_after = NULL,
        error_message = NULL
       WHERE job_id = $1
       RETURNING *`,
      [jobId]
    );

    if (result.rows[0]) {
      console.log(`✅ Job completed: ${jobId}`);
    }
    return result.rows[0];
  },

  /**
   * Mark a job as failed with retry scheduling
   * 
   * UPDATED: Now calculates retry_after based on attempt count
   * Returns additional info about whether it will retry
   */
  async failJob(jobId, errorMessage) {
    // First get the current job state
    const currentJob = await query(
      `SELECT attempts, max_attempts FROM processing_queue WHERE job_id = $1`,
      [jobId]
    );

    if (!currentJob.rows[0]) {
      console.log(`❌ Job not found: ${jobId}`);
      return null;
    }

    const { attempts, max_attempts } = currentJob.rows[0];
    const willRetry = attempts < max_attempts;

    // Calculate retry_after if we'll retry
    let retryAfter = null;
    if (willRetry) {
      const delayMs = this.getRetryDelay(attempts);
      retryAfter = new Date(Date.now() + delayMs);
    }

    const result = await query(
      `UPDATE processing_queue SET 
        status = 'failed',
        error_message = $2,
        locked_at = NULL,
        retry_after = $3
       WHERE job_id = $1
       RETURNING *`,
      [jobId, errorMessage, retryAfter]
    );

    if (result.rows[0]) {
      const job = result.rows[0];
      if (!willRetry) {
        console.log(`❌ Job permanently failed: ${jobId} (${job.attempts}/${job.max_attempts} attempts)`);
      } else {
        const retryInSeconds = Math.round(this.getRetryDelay(attempts) / 1000);
        console.log(`⚠️ Job failed, will retry in ${retryInSeconds}s: ${jobId} (${job.attempts}/${job.max_attempts} attempts)`);
      }
    }

    return {
      ...result.rows[0],
      willRetry,
      retryAfter,
      isPermanentlyFailed: !willRetry
    };
  },

  /**
   * Get job by ID
   */
  async getJob(jobId) {
    const result = await query(
      `SELECT * FROM processing_queue WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0];
  },

  /**
   * Get jobs by chart number
   */
  async getJobsByChart(chartNumber) {
    const result = await query(
      `SELECT * FROM processing_queue WHERE chart_number = $1 ORDER BY created_at DESC`,
      [chartNumber]
    );
    return result.rows;
  },

  /**
   * Get queue statistics
   * 
   * UPDATED: Added waiting_for_retry count
   */
  async getStats() {
    const result = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= max_attempts) as permanently_failed,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempts < max_attempts AND retry_after > NOW()) as waiting_for_retry,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempts < max_attempts AND (retry_after IS NULL OR retry_after <= NOW())) as ready_to_retry,
        COUNT(*) as total
      FROM processing_queue
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
    return result.rows[0];
  },

  /**
   * Get detailed status for a specific chart's job
   */
  async getJobStatus(chartNumber) {
    const result = await query(`
      SELECT 
        job_id,
        status,
        attempts,
        max_attempts,
        error_message,
        retry_after,
        created_at,
        started_at,
        completed_at,
        CASE 
          WHEN status = 'failed' AND attempts >= max_attempts THEN 'permanently_failed'
          WHEN status = 'failed' AND retry_after > NOW() THEN 'waiting_for_retry'
          WHEN status = 'failed' THEN 'ready_to_retry'
          ELSE status
        END as effective_status,
        CASE 
          WHEN status = 'failed' AND retry_after > NOW() 
          THEN EXTRACT(EPOCH FROM (retry_after - NOW()))::integer
          ELSE NULL
        END as retry_in_seconds
      FROM processing_queue 
      WHERE chart_number = $1 
      ORDER BY created_at DESC 
      LIMIT 1
    `, [chartNumber]);

    return result.rows[0];
  },

  /**
   * Clean up old completed jobs (run periodically)
   */
  async cleanupOldJobs(olderThanDays = 7) {
    const result = await query(
      `DELETE FROM processing_queue 
       WHERE status = 'completed' 
       AND completed_at < NOW() - INTERVAL '1 day' * $1
       RETURNING id`,
      [olderThanDays]
    );

    if (result.rows.length > 0) {
      console.log(`🧹 Cleaned up ${result.rows.length} old completed jobs`);
    }
    return result.rows.length;
  },

  /**
   * Release stuck jobs (jobs that have been processing for too long)
   * 
   * UPDATED: Sets retry_after for released jobs
   */
  async releaseStuckJobs(stuckMinutes = 30) {
    const retryAfter = new Date(Date.now() + 30000); // Retry in 30 seconds

    const result = await query(
      `UPDATE processing_queue SET 
        status = 'failed',
        worker_id = NULL,
        locked_at = NULL,
        error_message = 'Released: worker timeout after ' || $1 || ' minutes',
        retry_after = $2
       WHERE status = 'processing'
       AND locked_at < NOW() - INTERVAL '1 minute' * $1
       RETURNING *`,
      [stuckMinutes, retryAfter]
    );

    if (result.rows.length > 0) {
      console.log(`🔓 Released ${result.rows.length} stuck jobs (will retry in 30s)`);
    }
    return result.rows;
  },

  /**
   * Manually retry a permanently failed job
   */
  async retryJob(jobId) {
    const result = await query(
      `UPDATE processing_queue SET 
        status = 'pending',
        attempts = 0,
        error_message = NULL,
        retry_after = NULL,
        worker_id = NULL,
        locked_at = NULL
       WHERE job_id = $1 AND status = 'failed'
       RETURNING *`,
      [jobId]
    );

    if (result.rows[0]) {
      console.log(`🔄 Job manually reset for retry: ${jobId}`);
    }
    return result.rows[0];
  },

  /**
   * Send a PostgreSQL NOTIFY with job status update
   * Used by the worker to broadcast status changes to WebSocket clients via PG LISTEN/NOTIFY
   */
  async notifyStatusChange(jobId, status, phase, message = null) {
    // Persist current_phase so WebSocket can send it on reconnect (best-effort, don't block notify)
    try {
      await query(
        `UPDATE processing_queue SET current_phase = $2 WHERE job_id = $1`,
        [jobId, phase]
      );
    } catch (e) {
      // Column may not exist yet — continue so pg_notify still fires
    }

    const payload = JSON.stringify({
      jobId,
      status,
      phase,
      message,
      timestamp: new Date().toISOString()
    });

    await query(`SELECT pg_notify('job_status_update', $1)`, [payload]);
  },

  /**
   * Send a PostgreSQL NOTIFY with chart-level AI status update
   * Used by the worker to broadcast chart status changes to dashboard WebSocket clients
   */
  async notifyChartStatus(sessionId, aiStatus) {
    const payload = JSON.stringify({
      sessionId: String(sessionId),
      aiStatus,
      timestamp: new Date().toISOString()
    });
    console.log(`📊 [notifyChartStatus] Sending PG NOTIFY — sessionId: ${sessionId}, aiStatus: ${aiStatus}`);
    await query(`SELECT pg_notify('chart_status_update', $1)`, [payload]);
    console.log(`📊 [notifyChartStatus] PG NOTIFY sent successfully`);
  },

  /**
   * Get count of jobs waiting for retry
   */
  async getRetryingCount() {
    const result = await query(`
      SELECT COUNT(*) as count
      FROM processing_queue
      WHERE status = 'failed' 
        AND attempts < max_attempts
    `);
    return parseInt(result.rows[0].count);
  }
};

export default QueueService;
