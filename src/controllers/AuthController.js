import jwt from 'jsonwebtoken';
import { UserRepository, ROLES } from '../db/userRepository.js';

const JWT_SECRET = process.env.JWT_SECRET || 'medcode-ai-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

class AuthController {

  /**
   * Login user
   * POST /api/auth/login
   */
  async login(req, res) {
    try {
      const { userId, password } = req.body;

      if (!userId || !password) {
        return res.status(400).json({
          success: false,
          error: 'User ID and password are required'
        });
      }

      const { valid, user, reason } = await UserRepository.verifyPassword(userId, password);

      if (!valid) {
        return res.status(401).json({
          success: false,
          error: reason || 'Invalid credentials'
        });
      }

      // Generate JWT token
      const token = jwt.sign(
        {
          id: user.id,
          userId: user.user_id,
          name: user.name,
          role: user.role
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      console.log(`✅ User logged in: ${user.user_id} (${user.role})`);

      res.json({
        success: true,
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          userId: user.user_id,
          name: user.name,
          role: user.role,
          email: user.email
        }
      });

    } catch (error) {
      console.error('❌ Login error:', error);
      res.status(500).json({ success: false, error: 'Login failed' });
    }
  }

  /**
   * Get current user
   * GET /api/auth/me
   */
  async getCurrentUser(req, res) {
    try {
      const user = await UserRepository.findById(req.user.id);

      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          userId: user.user_id,
          name: user.name,
          role: user.role,
          email: user.email,
          lastLogin: user.last_login
        }
      });

    } catch (error) {
      console.error('❌ Get current user error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Register new user (admin only)
   * POST /api/auth/register
   */
  async register(req, res) {
    try {
      const { userId, password, name, role, email } = req.body;

      if (!userId || !password || !name) {
        return res.status(400).json({
          success: false,
          error: 'User ID, password, and name are required'
        });
      }

      // Validate role
      const validRoles = Object.values(ROLES);
      if (role && !validRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          error: `Invalid role. Must be one of: ${validRoles.join(', ')}`
        });
      }

      // Check if user exists
      const existingUser = await UserRepository.findByUserId(userId);
      if (existingUser) {
        return res.status(409).json({ success: false, error: 'User ID already exists' });
      }

      const user = await UserRepository.create({
        userId,
        password,
        name,
        role: role || 'coder',
        email
      });

      console.log(`✅ New user created: ${user.user_id} (${user.role}) by ${req.user?.userId || 'system'}`);

      res.status(201).json({
        success: true,
        message: 'User created successfully',
        user: {
          id: user.id,
          userId: user.user_id,
          name: user.name,
          role: user.role,
          email: user.email
        }
      });

    } catch (error) {
      console.error('❌ Register error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Change own password
   * POST /api/auth/change-password
   */
  async changePassword(req, res) {
    try {
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          error: 'Current password and new password are required'
        });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          error: 'New password must be at least 6 characters'
        });
      }

      const { valid } = await UserRepository.verifyPassword(req.user.userId, currentPassword);

      if (!valid) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect' });
      }

      await UserRepository.changePassword(req.user.userId, newPassword);

      console.log(`✅ Password changed for user: ${req.user.userId}`);

      res.json({ success: true, message: 'Password changed successfully' });

    } catch (error) {
      console.error('❌ Change password error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get all users (admin only)
   * GET /api/auth/users
   */
  async getUsers(req, res) {
    try {
      const { role, isActive, search, page, limit } = req.query;

      const result = await UserRepository.getAll({
        role,
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
        search,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20
      });

      res.json({
        success: true,
        users: result.users.map(u => ({
          id: u.id,
          userId: u.user_id,
          name: u.name,
          role: u.role,
          email: u.email,
          isActive: u.is_active,
          lastLogin: u.last_login,
          createdAt: u.created_at
        })),
        pagination: result.pagination
      });

    } catch (error) {
      console.error('❌ Get users error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Update user (admin only)
   * PATCH /api/auth/users/:userId
   */
  async updateUser(req, res) {
    try {
      const { userId } = req.params;
      const { name, email, role, isActive } = req.body;

      const validRoles = Object.values(ROLES);
      if (role && !validRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          error: `Invalid role. Must be one of: ${validRoles.join(', ')}`
        });
      }

      // Prevent self-demotion
      if (req.user.userId === userId && role && role !== 'admin' && req.user.role === 'admin') {
        return res.status(400).json({ success: false, error: 'Cannot change your own admin role' });
      }

      const user = await UserRepository.update(userId, { name, email, role, isActive });

      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      console.log(`✅ User updated: ${userId} by ${req.user.userId}`);

      res.json({
        success: true,
        message: 'User updated successfully',
        user: {
          id: user.id,
          userId: user.user_id,
          name: user.name,
          role: user.role,
          email: user.email,
          isActive: user.is_active
        }
      });

    } catch (error) {
      console.error('❌ Update user error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Reset user password (admin only)
   * POST /api/auth/users/:userId/reset-password
   */
  async resetPassword(req, res) {
    try {
      const { userId } = req.params;
      const { newPassword } = req.body;

      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          error: 'New password must be at least 6 characters'
        });
      }

      const user = await UserRepository.changePassword(userId, newPassword);

      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      console.log(`✅ Password reset for user: ${userId} by ${req.user.userId}`);

      res.json({ success: true, message: 'Password reset successfully' });

    } catch (error) {
      console.error('❌ Reset password error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Delete (deactivate) user (admin only)
   * DELETE /api/auth/users/:userId
   */
  async deleteUser(req, res) {
    try {
      const { userId } = req.params;

      if (req.user.userId === userId) {
        return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
      }

      const user = await UserRepository.deactivate(userId);

      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      console.log(`✅ User deactivated: ${userId} by ${req.user.userId}`);

      res.json({ success: true, message: 'User deactivated successfully' });

    } catch (error) {
      console.error('❌ Delete user error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get user stats (admin only)
   * GET /api/auth/stats
   */
  async getStats(req, res) {
    try {
      const stats = await UserRepository.getStats();

      res.json({
        success: true,
        stats: {
          total: parseInt(stats.total),
          admins: parseInt(stats.admins),
          coders: parseInt(stats.coders),
          qaUsers: parseInt(stats.qa_users),
          active: parseInt(stats.active),
          inactive: parseInt(stats.inactive)
        }
      });

    } catch (error) {
      console.error('❌ Get stats error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get coders list (for dropdowns)
   * GET /api/auth/coders
   */
  async getCoders(req, res) {
    try {
      const coders = await UserRepository.getCoders();
      res.json({
        success: true,
        coders: coders.map(c => ({
          id: c.id,
          userId: c.user_id,
          name: c.name,
          email: c.email
        }))
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get QA users list (for dropdowns)
   * GET /api/auth/qa-users
   */
  async getQAUsers(req, res) {
    try {
      const qaUsers = await UserRepository.getQAUsers();
      res.json({
        success: true,
        qaUsers: qaUsers.map(u => ({
          id: u.id,
          userId: u.user_id,
          name: u.name,
          email: u.email
        }))
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

export const authController = new AuthController();
