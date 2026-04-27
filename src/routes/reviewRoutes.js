import { Router } from 'express';
import { reviewController } from '../controllers/reviewController.js';

const router = Router();

// Rules (must be before parameterized routes to avoid /:identifier matching "rules")
router.get('/rules', reviewController.listRules.bind(reviewController));
router.post('/rules', reviewController.createRule.bind(reviewController));
router.patch('/rules/:ruleId/deactivate', reviewController.deactivateRule.bind(reviewController));

// Gold dataset proxy (must be before /:identifier/submit to avoid matching "gold-dataset" as identifier)
router.post('/gold-dataset/submit', reviewController.submitGoldDataset.bind(reviewController));

// Review (parameterized — must be after /rules and /gold-dataset)
router.get('/:identifier/codes', reviewController.getReviewCodes.bind(reviewController));
router.post('/:identifier/submit', reviewController.submitReview.bind(reviewController));

export default router;
