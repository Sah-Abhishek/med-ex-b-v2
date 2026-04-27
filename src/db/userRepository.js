import bcrypt from 'bcrypt';
import { query } from './connection.js';

export const ROLES = {
  ADMIN: 'admin',
  CODER: 'coder',
  QA: 'qa',
};

export const UserRepository = {
  async findById(id) {
    const result = await query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async findByUserId(userId) {
    const result = await query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return result.rows[0] || null;
  },

  async verifyPassword(userId, password) {
    const user = await UserRepository.findByUserId(userId);

    if (!user) {
      return { valid: false, reason: 'User not found' };
    }

    if (!user.is_active) {
      return { valid: false, reason: 'Account is deactivated' };
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return { valid: false, reason: 'Invalid password' };
    }

    // Update last login
    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    return { valid: true, user };
  },

  async create({ userId, password, name, role, email }) {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO users (user_id, password_hash, name, role, email)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, passwordHash, name, role || 'coder', email]
    );
    return result.rows[0];
  },

  async update(userId, { name, email, role, isActive }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email); }
    if (role !== undefined) { fields.push(`role = $${idx++}`); values.push(role); }
    if (isActive !== undefined) { fields.push(`is_active = $${idx++}`); values.push(isActive); }

    if (fields.length === 0) return UserRepository.findByUserId(userId);

    fields.push(`updated_at = NOW()`);
    values.push(userId);

    const result = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  },

  async changePassword(userId, newPassword) {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2 RETURNING *',
      [passwordHash, userId]
    );
    return result.rows[0] || null;
  },

  async deactivate(userId) {
    const result = await query(
      'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE user_id = $1 RETURNING *',
      [userId]
    );
    return result.rows[0] || null;
  },

  async getAll({ role, isActive, search, page = 1, limit = 20 } = {}) {
    const conditions = [];
    const values = [];
    let idx = 1;

    if (role) { conditions.push(`role = $${idx++}`); values.push(role); }
    if (isActive !== undefined) { conditions.push(`is_active = $${idx++}`); values.push(isActive); }
    if (search) {
      conditions.push(`(user_id ILIKE $${idx} OR name ILIKE $${idx} OR email ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const countResult = await query(`SELECT COUNT(*) FROM users ${where}`, values);
    const total = parseInt(countResult.rows[0].count);

    const result = await query(
      `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset]
    );

    return {
      users: result.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  async getStats() {
    const result = await query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE role = 'admin') as admins,
        COUNT(*) FILTER (WHERE role = 'coder') as coders,
        COUNT(*) FILTER (WHERE role = 'qa') as qa_users,
        COUNT(*) FILTER (WHERE is_active = true) as active,
        COUNT(*) FILTER (WHERE is_active = false) as inactive
      FROM users
    `);
    return result.rows[0];
  },

  async getCoders() {
    const result = await query(
      "SELECT * FROM users WHERE role = 'coder' AND is_active = true ORDER BY name"
    );
    return result.rows;
  },

  async getQAUsers() {
    const result = await query(
      "SELECT * FROM users WHERE role = 'qa' AND is_active = true ORDER BY name"
    );
    return result.rows;
  },
};
