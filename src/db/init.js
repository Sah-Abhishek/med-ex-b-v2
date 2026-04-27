import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';

dotenv.config();

// Disable SSL certificate verification for Neon/cloud DBs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function initDatabase() {
  const client = await pool.connect();

  try {
    console.log('🚀 Starting database initialization...\n');

    // ═══════════════════════════════════════════════════════════════
    // DROP EXISTING TABLES (clean start)
    // ═══════════════════════════════════════════════════════════════
    console.log('🗑️  Dropping existing tables (if any)...');
    await client.query(`DROP TABLE IF EXISTS processing_queue CASCADE`);
    await client.query(`DROP TABLE IF EXISTS documents CASCADE`);
    await client.query(`DROP TABLE IF EXISTS charts CASCADE`);
    await client.query(`DROP TABLE IF EXISTS users CASCADE`);
    await client.query(`DROP TABLE IF EXISTS reason_options CASCADE`);
    console.log('   ✅ Old tables dropped\n');

    // ═══════════════════════════════════════════════════════════════
    // CHARTS TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('📋 Creating charts table...');
    await client.query(`
      CREATE TABLE charts (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) UNIQUE NOT NULL,
        chart_number VARCHAR(100),
        encounter_id VARCHAR(255),
        report_ids JSONB,
        mrn VARCHAR(100),
        facility VARCHAR(255),
        specialty VARCHAR(255),
        date_of_service DATE,
        provider VARCHAR(255),
        document_count INTEGER DEFAULT 0,
        
        -- AI Processing Status
        ai_status VARCHAR(50) DEFAULT 'queued',
        review_status VARCHAR(50) DEFAULT 'pending',
        
        -- AI Results (JSON fields)
        ai_summary JSONB,
        diagnosis_codes JSONB,
        procedures JSONB,
        medications JSONB,
        vitals_summary JSONB,
        lab_results_summary JSONB,
        coding_notes JSONB,
        sla_data JSONB,
        encounter_payload JSONB,
        
        -- Original AI codes for comparison
        original_ai_codes JSONB,
        
        -- User modifications
        user_modifications JSONB,
        
        -- Final submitted codes
        final_codes JSONB,
        submitted_at TIMESTAMP,
        submitted_by VARCHAR(100),
        
        -- Error tracking
        last_error TEXT,
        last_error_at TIMESTAMP,
        retry_count INTEGER DEFAULT 0,
        
        -- Processing timestamps
        processing_started_at TIMESTAMP,
        processing_completed_at TIMESTAMP,
        
        -- Record timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('   ✅ charts table created\n');

    // ═══════════════════════════════════════════════════════════════
    // DOCUMENTS TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('📄 Creating documents table...');
    await client.query(`
      CREATE TABLE documents (
        id SERIAL PRIMARY KEY,
        chart_id INTEGER REFERENCES charts(id) ON DELETE CASCADE,
        document_type VARCHAR(100),
        filename VARCHAR(255),
        original_name VARCHAR(255),
        file_size INTEGER,
        mime_type VARCHAR(100),
        
        -- S3 Storage
        s3_key VARCHAR(500),
        s3_url TEXT,
        s3_bucket VARCHAR(255),
        
        -- OCR Processing
        ocr_status VARCHAR(50) DEFAULT 'pending',
        ocr_text TEXT,
        ocr_processing_time INTEGER,
        ocr_completed_at TIMESTAMP,
        
        -- AI Document Summary
        ai_document_summary JSONB,
        
        -- Transaction tracking
        transaction_id VARCHAR(100),
        transaction_label VARCHAR(255),
        is_group_member BOOLEAN DEFAULT FALSE,
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('   ✅ documents table created\n');

    // ═══════════════════════════════════════════════════════════════
    // PROCESSING QUEUE TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('⏳ Creating processing_queue table...');
    await client.query(`
      CREATE TABLE processing_queue (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(100) UNIQUE NOT NULL,
        chart_id INTEGER REFERENCES charts(id) ON DELETE CASCADE,
        chart_number VARCHAR(100),
        
        -- Job status
        status VARCHAR(50) DEFAULT 'pending',
        current_phase VARCHAR(50) DEFAULT 'pending',
        job_data JSONB,
        
        -- Worker tracking
        worker_id VARCHAR(100),
        locked_at TIMESTAMP,
        
        -- Timing
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        
        -- Retry logic
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        error_message TEXT,
        retry_after TIMESTAMP,
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('   ✅ processing_queue table created\n');

    // ═══════════════════════════════════════════════════════════════
    // USERS TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('👤 Creating users table...');
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'coder',
        email VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('   ✅ users table created\n');

    // ═══════════════════════════════════════════════════════════════
    // REASON OPTIONS TABLE
    // ═══════════════════════════════════════════════════════════════
    console.log('📝 Creating reason_options table...');
    await client.query(`
      CREATE TABLE reason_options (
        id SERIAL PRIMARY KEY,
        category VARCHAR(50) NOT NULL,
        action VARCHAR(20) NOT NULL,
        label VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX idx_reason_options_unique_active
      ON reason_options (category, action, lower(label))
      WHERE deleted_at IS NULL
    `);
    console.log('   ✅ reason_options table created\n');

    // ═══════════════════════════════════════════════════════════════
    // INDEXES
    // ═══════════════════════════════════════════════════════════════
    console.log('🔍 Creating indexes...');

    // Charts indexes
    await client.query(`CREATE INDEX idx_charts_session_id ON charts(session_id)`);
    await client.query(`CREATE INDEX idx_charts_ai_status ON charts(ai_status)`);
    await client.query(`CREATE INDEX idx_charts_review_status ON charts(review_status)`);
    await client.query(`CREATE INDEX idx_charts_facility ON charts(facility)`);
    await client.query(`CREATE INDEX idx_charts_specialty ON charts(specialty)`);
    await client.query(`CREATE INDEX idx_charts_mrn ON charts(mrn)`);
    await client.query(`CREATE INDEX idx_charts_created_at ON charts(created_at DESC)`);
    await client.query(`CREATE INDEX idx_charts_date_of_service ON charts(date_of_service)`);

    // Documents indexes
    await client.query(`CREATE INDEX idx_documents_chart_id ON documents(chart_id)`);
    await client.query(`CREATE INDEX idx_documents_transaction_id ON documents(transaction_id)`);
    await client.query(`CREATE INDEX idx_documents_ocr_status ON documents(ocr_status)`);

    // Processing queue indexes
    await client.query(`CREATE INDEX idx_queue_status ON processing_queue(status)`);
    await client.query(`CREATE INDEX idx_queue_chart_number ON processing_queue(chart_number)`);
    await client.query(`CREATE INDEX idx_queue_created_at ON processing_queue(created_at)`);
    await client.query(`CREATE INDEX idx_queue_retry_after ON processing_queue(retry_after)`);

    // Users indexes
    await client.query(`CREATE INDEX idx_users_role ON users(role)`);
    await client.query(`CREATE INDEX idx_users_is_active ON users(is_active)`);

    // Reason options indexes
    await client.query(`CREATE INDEX idx_reason_options_lookup ON reason_options(category, action) WHERE deleted_at IS NULL`);

    console.log('   ✅ All indexes created\n');

    // ═══════════════════════════════════════════════════════════════
    // DEFAULT ADMIN USER
    // ═══════════════════════════════════════════════════════════════
    console.log('👤 Creating default admin user...');

    const defaultPassword = 'admin123';
    const passwordHash = await bcrypt.hash(defaultPassword, 10);

    await client.query(
      `INSERT INTO users (user_id, password_hash, name, role, email)
       VALUES ('admin', $1, 'System Administrator', 'admin', 'admin@medcode.ai')`,
      [passwordHash]
    );
    console.log('   ✅ Default admin user created');
    console.log('   📝 Username: admin');
    console.log('   📝 Password: admin123');
    console.log('   ⚠️  Please change the password after first login!\n');

    // ═══════════════════════════════════════════════════════════════
    // VERIFY TABLES
    // ═══════════════════════════════════════════════════════════════
    console.log('🔍 Verifying tables...');

    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    console.log('   Tables in database:');
    tables.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });

    console.log('\n' + '═'.repeat(50));
    console.log('✅ Database initialization completed successfully!');
    console.log('═'.repeat(50) + '\n');

  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run initialization
initDatabase();
