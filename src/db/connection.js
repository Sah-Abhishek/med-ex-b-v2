import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// Disable TLS certificate validation for Neon
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Create connection pool
export const pool = new Pool({
  connectionString: config.database.url,
  ssl: false
});

// Test connection
pool.on('connect', () => {
  console.log('📦 Database connected');
});

pool.on('error', (err) => {
  console.error('❌ Database error:', err.message);
});

// Helper function for queries
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.log(`⚠️ Slow query (${duration}ms):`, text.substring(0, 50));
    }
    return result;
  } catch (error) {
    console.error('❌ Query error:', error.message);
    throw error;
  }
};

export default { pool, query };
