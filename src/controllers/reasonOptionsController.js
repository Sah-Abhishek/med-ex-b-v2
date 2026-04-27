import { query } from '../db/connection.js';

export const REASON_CATEGORIES = [
  'admit_code',
  'primary_diagnosis',
  'secondary_diagnosis',
  'cpt',
  'em_level',
  'modifier',
];

export const REASON_ACTIONS = ['add', 'edit', 'reject'];

class ReasonOptionsController {
  async list(req, res) {
    try {
      const result = await query(
        `SELECT id, category, action, label, created_at
         FROM reason_options
         WHERE deleted_at IS NULL
         ORDER BY category, action, label`
      );
      res.json({ success: true, options: result.rows });
    } catch (error) {
      console.error('[ReasonOptions] list failed:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async create(req, res) {
    try {
      const { category, action, label } = req.body;

      if (!REASON_CATEGORIES.includes(category)) {
        return res.status(400).json({ success: false, error: `Invalid category. Must be one of: ${REASON_CATEGORIES.join(', ')}` });
      }
      if (!REASON_ACTIONS.includes(action)) {
        return res.status(400).json({ success: false, error: `Invalid action. Must be one of: ${REASON_ACTIONS.join(', ')}` });
      }
      const trimmed = (label || '').trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: 'Label is required' });
      }
      if (trimmed.length > 255) {
        return res.status(400).json({ success: false, error: 'Label too long (max 255 chars)' });
      }

      try {
        const result = await query(
          `INSERT INTO reason_options (category, action, label)
           VALUES ($1, $2, $3)
           RETURNING id, category, action, label, created_at`,
          [category, action, trimmed]
        );
        res.status(201).json({ success: true, option: result.rows[0] });
      } catch (e) {
        if (e.code === '23505') {
          return res.status(409).json({ success: false, error: 'Option already exists for this category and action' });
        }
        throw e;
      }
    } catch (error) {
      console.error('[ReasonOptions] create failed:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async remove(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ success: false, error: 'Invalid id' });
      }
      const result = await query(
        `UPDATE reason_options
         SET deleted_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [id]
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'Option not found' });
      }
      res.json({ success: true, id });
    } catch (error) {
      console.error('[ReasonOptions] delete failed:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

export const reasonOptionsController = new ReasonOptionsController();
