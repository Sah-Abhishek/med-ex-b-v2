import { Router } from 'express';
import documentRoutes from './documentRoutes.js';
import chartRoutes from './chartRoutes.js';
import reviewRoutes from './reviewRoutes.js';
import authRoutes from './authRoutes.js';
import reasonOptionsRoutes from './reasonOptionsRoutes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/documents', documentRoutes);
router.use('/charts', chartRoutes);
router.use('/review', reviewRoutes);
router.use('/reason-options', reasonOptionsRoutes);

router.get('/', (req, res) => {
  res.json({
    service: 'MedCode AI Backend',
    version: '1.1.0',
    mode: 'async-queue',
    endpoints: {
      documents: {
        process: 'POST /api/documents/process',
        status: 'GET /api/documents/status/:chartNumber',
        queueStats: 'GET /api/documents/queue/stats',
        health: 'GET /api/documents/health'
      },
      charts: {
        list: 'GET /api/charts',
        get: 'GET /api/charts/:chartNumber',
        modifications: 'POST /api/charts/:chartNumber/modifications',
        submit: 'POST /api/charts/:chartNumber/submit',
        updateStatus: 'PATCH /api/charts/:chartNumber/status',
        delete: 'DELETE /api/charts/:chartNumber',
        slaStats: 'GET /api/charts/stats/sla',
        dashboardAnalytics: 'GET /api/charts/analytics/dashboard',
        modificationAnalytics: 'GET /api/charts/analytics/modifications',
        facilities: 'GET /api/charts/filters/facilities',
        specialties: 'GET /api/charts/filters/specialties'
      }
    }
  });
});

export default router;
