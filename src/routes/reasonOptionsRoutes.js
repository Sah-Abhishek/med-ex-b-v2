import { Router } from 'express';
import { reasonOptionsController } from '../controllers/reasonOptionsController.js';

const router = Router();

// Tokens are issued by the Valerion gateway (not med-ex-b), so we cannot
// cryptographically verify them here. We decode the payload without verification
// to read the role claim — matching the trust model of other med-ex-b routes
// (review, charts) which are fully open. RoleId 2 = teamlead, 3 = coder.
function decodeRole(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    const roleId = payload?.tokenPayload?.RoleId ?? payload?.RoleId;
    return roleId ?? null;
  } catch {
    return null;
  }
}

function requireTeamLead(req, res, next) {
  const roleId = decodeRole(req);
  if (roleId !== 2) {
    return res.status(403).json({ success: false, error: 'Team lead access required' });
  }
  next();
}

router.get('/', (req, res) => reasonOptionsController.list(req, res));
router.post('/', requireTeamLead, (req, res) => reasonOptionsController.create(req, res));
router.delete('/:id', requireTeamLead, (req, res) => reasonOptionsController.remove(req, res));

export default router;
