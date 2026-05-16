import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import routes from './routes/index.js';
import { pool } from './db/connection.js';
import { websocketService } from './services/websocketService.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.url.includes('/api/charts')) {
    console.log(`📨 ${req.method} ${req.url}`);
  }
  next();
});

// Routes
app.use('/api', routes);

app.get('/', (req, res) => {
  res.json({
    message: 'MedCode AI Backend',
    api: '/api'
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('❌ Error:', error.message);
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: 'File too large (max 25MB)' });
  }
  res.status(500).json({ success: false, error: error.message });
});

// Test database connection and start server
async function startServer() {
  try {
    // Test DB connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');

    // Idempotent migrations for additive schema changes
    await pool.query(`ALTER TABLE charts ADD COLUMN IF NOT EXISTS encounter_payload JSONB`);
    await pool.query(`ALTER TABLE charts ADD COLUMN IF NOT EXISTS client VARCHAR(255)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_charts_client ON charts(client)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reason_options (
        id SERIAL PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        action VARCHAR(20) NOT NULL,
        label VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reason_options_unique_active
      ON reason_options (category, action, lower(label))
      WHERE deleted_at IS NULL
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reason_options_lookup
      ON reason_options (category, action) WHERE deleted_at IS NULL
    `);

    // Start server and capture HTTP server instance for WebSocket
    const server = app.listen(config.port, async () => {
      console.log('\n' + '═'.repeat(50));
      console.log('🏥 MedCode AI Backend');
      console.log('═'.repeat(50));
      console.log(`🚀 Server: http://localhost:${config.port}`);
      console.log(`📡 API: http://localhost:${config.port}/api`);
      console.log(`🔗 OCR: ${config.ocr.serviceUrl}`);
      console.log(`🤖 ICD Predictor: ${config.icdPredictor.baseUrl}`);
      console.log(`📦 Database: Connected`);

      // Initialize WebSocket
      try {
        await websocketService.init(server);
        console.log(`🔌 WebSocket: ws://localhost:${config.port}/api/ws`);
      } catch (err) {
        console.error('❌ WebSocket init failed:', err.message);
      }

      console.log('═'.repeat(50) + '\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();

export default app;
