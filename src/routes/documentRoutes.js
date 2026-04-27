import { Router } from 'express';
import { documentController } from '../controllers/documentController.js';
import { upload } from '../middleware/upload.js';

const router = Router();

// Health check
router.get('/health', documentController.healthCheck.bind(documentController));

// Get queue statistics
router.get('/queue/stats', documentController.getQueueStats.bind(documentController));

// Get transaction statistics
router.get('/transactions/stats', documentController.getTransactionStats.bind(documentController));

// Get combined dashboard statistics (charts + transactions)
router.get('/dashboard/stats', documentController.getDashboardStats.bind(documentController));

// Get processing status for a chart
router.get('/status/:chartNumber', documentController.getProcessingStatus.bind(documentController));

// Process documents - uploads to S3 and queues for background processing
// Now supports transaction metadata for grouping images
router.post(
  '/process',
  upload.array('files', 20),
  documentController.processDocuments.bind(documentController)
);

export default router;
