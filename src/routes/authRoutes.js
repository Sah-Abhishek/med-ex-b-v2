import { Router } from 'express';
import { authController } from '../controllers/AuthController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

// Public
router.post('/login', (req, res) => authController.login(req, res));

// Authenticated
router.get('/me', authenticate, (req, res) => authController.getCurrentUser(req, res));
router.post('/change-password', authenticate, (req, res) => authController.changePassword(req, res));

// Admin only
router.post('/register', authenticate, requireRole('admin'), (req, res) => authController.register(req, res));
router.get('/users', authenticate, requireRole('admin'), (req, res) => authController.getUsers(req, res));
router.get('/stats', authenticate, requireRole('admin'), (req, res) => authController.getStats(req, res));
router.get('/coders', authenticate, requireRole('admin'), (req, res) => authController.getCoders(req, res));
router.get('/qa-users', authenticate, requireRole('admin'), (req, res) => authController.getQAUsers(req, res));
router.patch('/users/:userId', authenticate, requireRole('admin'), (req, res) => authController.updateUser(req, res));
router.post('/users/:userId/reset-password', authenticate, requireRole('admin'), (req, res) => authController.resetPassword(req, res));
router.delete('/users/:userId', authenticate, requireRole('admin'), (req, res) => authController.deleteUser(req, res));

export default router;
