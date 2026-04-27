/**
 * SLA Tracker - Tracks processing times across pipeline stages
 */
export class SLATracker {
  constructor() {
    this.timestamps = {
      uploadReceived: null,
      ocrStarted: null,
      ocrCompleted: null,
      aiStarted: null,
      aiCompleted: null,
      processingComplete: null
    };
  }
  markUploadReceived() {
    this.timestamps.uploadReceived = Date.now();
    return this;
  }
  markOCRStarted() {
    this.timestamps.ocrStarted = Date.now();
    return this;
  }
  markOCRCompleted() {
    this.timestamps.ocrCompleted = Date.now();
    return this;
  }
  markAIStarted() {
    this.timestamps.aiStarted = Date.now();
    return this;
  }
  markAICompleted() {
    this.timestamps.aiCompleted = Date.now();
    return this;
  }
  markComplete() {
    this.timestamps.processingComplete = Date.now();
    return this;
  }
  getSummary() {
    const {
      uploadReceived,
      ocrStarted,
      ocrCompleted,
      aiStarted,
      aiCompleted,
      processingComplete
    } = this.timestamps;
    const totalTime = processingComplete - uploadReceived;
    const ocrTime = ocrCompleted - ocrStarted;
    const aiTime = aiCompleted - aiStarted;
    const overheadTime = totalTime - ocrTime - aiTime;
    return {
      timestamps: {
        uploadReceived: new Date(uploadReceived).toISOString(),
        ocrStarted: new Date(ocrStarted).toISOString(),
        ocrCompleted: new Date(ocrCompleted).toISOString(),
        aiStarted: new Date(aiStarted).toISOString(),
        aiCompleted: new Date(aiCompleted).toISOString(),
        processingComplete: new Date(processingComplete).toISOString()
      },
      durations: {
        total: `${totalTime}ms`,
        ocr: `${ocrTime}ms`,
        ai: `${aiTime}ms`,
        overhead: `${overheadTime}ms`
      },
      durations_ms: {
        total: totalTime,
        ocr: ocrTime,
        ai: aiTime,
        overhead: overheadTime
      },
      slaStatus: this.calculateSLAStatus(totalTime)
    };
  }
  calculateSLAStatus(totalTimeMs) {
    const SLA_EXCELLENT = 30000;
    const SLA_GOOD = 60000;
    const SLA_ACCEPTABLE = 120000;
    if (totalTimeMs < SLA_EXCELLENT) {
      return { status: 'excellent', message: 'Processed within 30 seconds' };
    } else if (totalTimeMs < SLA_GOOD) {
      return { status: 'good', message: 'Processed within 1 minute' };
    } else if (totalTimeMs < SLA_ACCEPTABLE) {
      return { status: 'acceptable', message: 'Processed within 2 minutes' };
    } else {
      return { status: 'delayed', message: 'Processing exceeded 2 minutes' };
    }
  }
}

export const createSLATracker = () => new SLATracker();

/**
 * Calculate SLA hours since completion (for review queue aging)
 * Shows how long a chart has been waiting for review
 */
export function calculateSLAHours(completedAt) {
  if (!completedAt) return null;
  const completed = new Date(completedAt);
  const now = new Date();
  const diffMs = now - completed;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  return {
    hours: diffHours,
    isWarning: diffHours >= 24,
    isCritical: diffHours >= 48
  };
}

/**
 * Calculate processing duration SLA (upload → AI completion)
 * Shows how long it took to process a chart
 * 
 * @param {Date|string} uploadTime - created_at (when chart was uploaded/queued)
 * @param {Date|string} completionTime - processing_completed_at (when AI finished)
 * @returns {object|null} SLA info with formatted duration, warning/critical flags
 */
export function calculateProcessingDuration(uploadTime, completionTime) {
  if (!uploadTime) return null;

  const startTime = new Date(uploadTime);
  const endTime = completionTime ? new Date(completionTime) : null;

  // If not completed yet, show as "processing"
  if (!endTime) {
    const now = new Date();
    const elapsedMs = now - startTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);

    return {
      display: elapsedMinutes > 0 ? `${elapsedMinutes}m` : `${elapsedSeconds}s`,
      rawMs: elapsedMs,
      rawSeconds: elapsedSeconds,
      isComplete: false,
      isWarning: elapsedMinutes >= 2,   // Warning if processing > 2 min
      isCritical: elapsedMinutes >= 5   // Critical if processing > 5 min
    };
  }

  // Calculate completed duration
  const diffMs = endTime - startTime;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);

  // Format display string
  let display;
  if (diffHours > 0) {
    const remainingMinutes = diffMinutes % 60;
    display = remainingMinutes > 0 ? `${diffHours}h ${remainingMinutes}m` : `${diffHours}h`;
  } else if (diffMinutes > 0) {
    const remainingSeconds = diffSeconds % 60;
    display = remainingSeconds > 0 ? `${diffMinutes}m ${remainingSeconds}s` : `${diffMinutes}m`;
  } else {
    display = `${diffSeconds}s`;
  }

  return {
    display,
    rawMs: diffMs,
    rawSeconds: diffSeconds,
    rawMinutes: diffMinutes,
    isComplete: true,
    // SLA thresholds for processing time
    isExcellent: diffSeconds <= 30,     // Excellent: ≤ 30 seconds
    isGood: diffSeconds <= 60,          // Good: ≤ 1 minute
    isWarning: diffMinutes >= 2,        // Warning: ≥ 2 minutes
    isCritical: diffMinutes >= 5        // Critical: ≥ 5 minutes
  };
}
