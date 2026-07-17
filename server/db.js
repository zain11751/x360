import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool, types } = pg;

// node-postgres parses DATE/TIMESTAMP columns into JS Date objects by default. This app works with
// them as plain 'YYYY-MM-DD' strings everywhere (parsing, comparisons, month-grouping via .slice(0,7),
// etc.) — left as Date objects, String(dateObj).slice(0,7) silently produces garbage like "Wed Jul"
// instead of "2026-07", which then breaks any query built from it ("invalid input syntax for type date").
// Returning the raw text disables that implicit conversion so every date stays a plain string.
types.setTypeParser(1082, val => val); // DATE
types.setTypeParser(1114, val => val); // TIMESTAMP WITHOUT TIME ZONE
types.setTypeParser(1184, val => val); // TIMESTAMP WITH TIME ZONE

const isProduction = process.env.NODE_ENV === 'production' || process.env.DATABASE_URL;

let pool = null;
let sqliteDb = null;

// Determine if we are using Postgres or SQLite
const usePostgres = !!process.env.DATABASE_URL;

if (usePostgres) {
  console.log('Using PostgreSQL database connection.');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  // Only load sqlite3 (native module) when we actually need it locally.
  // Importing it unconditionally breaks deploys on hosts without a matching glibc.
  console.log('Using SQLite database connection for local testing.');
  const { default: sqlite3 } = await import('sqlite3');
  const dbPath = path.join(process.cwd(), 'x360_finance.db');
  sqliteDb = new sqlite3.Database(dbPath);
}

// Unified query function
export async function query(text, params = []) {
  if (usePostgres) {
    const res = await pool.query(text, params);
    return { rows: res.rows, rowCount: res.rowCount };
  } else {
    return new Promise((resolve, reject) => {
      // Convert standard PostgreSQL parameters ($1, $2, etc.) to SQLite parameters (?, ?, etc.)
      const sqliteText = text.replace(/\$(\d+)/g, '?');

      const isSelect = sqliteText.trim().toLowerCase().startsWith('select') ||
                       sqliteText.trim().toLowerCase().startsWith('with');

      if (isSelect) {
        sqliteDb.all(sqliteText, params, (err, rows) => {
          if (err) {
            console.error('SQLite SELECT Error:', err, 'Query:', sqliteText, 'Params:', params);
            reject(err);
          } else {
            resolve({ rows: rows || [], rowCount: (rows || []).length });
          }
        });
      } else {
        sqliteDb.run(sqliteText, params, function (err) {
          if (err) {
            console.error('SQLite RUN Error:', err, 'Query:', sqliteText, 'Params:', params);
            reject(err);
          } else {
            resolve({ rows: [], rowCount: this.changes });
          }
        });
      }
    });
  }
}

// Query wrapper that sets the app.current_user_id for Row-Level Security on PostgreSQL
export async function queryWithUser(userId, text, params = []) {
  if (usePostgres) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (userId) {
        // Set setting scoped to the transaction
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId.toString()]);
      }
      const res = await client.query(text, params);
      await client.query('COMMIT');
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Fallback to SQLite for local development
    return query(text, params);
  }
}

// Initialize database schema
export async function initDatabase() {
  if (usePostgres) {
    console.log('Running PostgreSQL migration...');
    const migrationPath = path.join(process.cwd(), 'scripts', 'migration.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await pool.query(sql);
    console.log('PostgreSQL migration completed successfully.');
  } else {
    console.log('Running SQLite migration...');
    const sql = `
      CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('ebay', 'other')),
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        auth_user_id TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'bookkeeper', 'client')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        last_login_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_business_access (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        access_level TEXT NOT NULL CHECK (access_level IN ('read', 'write')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, business_id)
      );

      CREATE TABLE IF NOT EXISTS user_store_access (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        access_level TEXT NOT NULL CHECK (access_level IN ('read', 'write')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, store_id)
      );

      CREATE TABLE IF NOT EXISTS user_module_permissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        module_name TEXT NOT NULL CHECK (module_name IN ('market_orders', 'supplier_orders', 'order_matching', 'transactions', 'expense', 'income', 'import_center', 'reporting', 'settings')),
        can_view INTEGER NOT NULL DEFAULT 0,
        can_edit INTEGER NOT NULL DEFAULT 0,
        UNIQUE (user_id, module_name)
      );

      CREATE TABLE IF NOT EXISTS custom_field_options (
        id TEXT PRIMARY KEY,
        field_key TEXT NOT NULL CHECK (field_key IN ('dispute_status', 'order_tracker', 'va_team', 'review_status', 'dispute_reason')),
        option_label TEXT NOT NULL,
        excludes_from_calculations INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (field_key, option_label)
      );

      CREATE TABLE IF NOT EXISTS market_orders (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        market_order_id TEXT NOT NULL,
        order_date TEXT NOT NULL,
        item_title TEXT,
        buyer_name TEXT,
        buyer_state TEXT,
        gross_amount REAL NOT NULL DEFAULT 0,
        platform_fee REAL NOT NULL DEFAULT 0,
        ads_fee REAL NOT NULL DEFAULT 0,
        shipping_fee_cost REAL NOT NULL DEFAULT 0,
        total_expense REAL NOT NULL DEFAULT 0,
        other_fee REAL NOT NULL DEFAULT 0,
        refund_amount REAL NOT NULL DEFAULT 0,
        net_earnings REAL NOT NULL DEFAULT 0,
        item_note_raw TEXT,
        shipped_date TEXT,
        order_status TEXT NOT NULL DEFAULT 'processing',
        dispute_status TEXT,
        order_tracker TEXT,
        va_team TEXT,
        review_status TEXT,
        dispute_reason TEXT,
        comments TEXT,
        order_notes TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (store_id, market_order_id)
      );

      CREATE TABLE IF NOT EXISTS supplier_orders (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        source_vendor TEXT NOT NULL,
        supplier_store_name TEXT,
        supplier_order_id TEXT NOT NULL,
        match_key TEXT,
        supplier_order_date TEXT NOT NULL,
        supplier_order_status TEXT,
        item_title TEXT,
        order_qty INTEGER NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL DEFAULT 0,
        shipping_cost REAL NOT NULL DEFAULT 0,
        price_adjustment REAL NOT NULL DEFAULT 0,
        discount_total REAL NOT NULL DEFAULT 0,
        other_total REAL NOT NULL DEFAULT 0,
        tax_total REAL NOT NULL DEFAULT 0,
        supplier_order_total REAL NOT NULL DEFAULT 0,
        payment_method TEXT,
        tracking_number TEXT,
        tracking_carrier TEXT,
        buyer_name TEXT,
        ship_state TEXT,
        supplier_refund_status TEXT,
        refunded_amount REAL NOT NULL DEFAULT 0,
        date_refunded TEXT,
        supplier_notes TEXT,
        total_cost REAL NOT NULL DEFAULT 0,
        order_status TEXT NOT NULL DEFAULT 'Order Paid',
        dispute_status TEXT,
        order_tracker TEXT,
        va_team TEXT,
        review_status TEXT,
        dispute_reason TEXT,
        comments TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (store_id, source_vendor, supplier_order_id)
      );

      CREATE TABLE IF NOT EXISTS order_matches (
        id TEXT PRIMARY KEY,
        market_order_id TEXT REFERENCES market_orders(id) ON DELETE CASCADE,
        parsed_match_key TEXT,
        supplier_order_id TEXT REFERENCES supplier_orders(id) ON DELETE CASCADE,
        supplier_match_key TEXT,
        match_status TEXT NOT NULL CHECK (match_status IN ('matched','unmatched_market','unmatched_supplier','error_parse')),
        source TEXT NOT NULL DEFAULT 'system' CHECK (source IN ('system','manual')),
        duplicate_claim INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        transaction_date TEXT NOT NULL,
        transaction_type TEXT NOT NULL,
        market_order_id TEXT,
        net_amount REAL,
        gross_transaction_amount REAL,
        payout_batch_id TEXT,
        payout_date TEXT,
        payout_status TEXT,
        item_title TEXT,
        description TEXT,
        row_hash TEXT NOT NULL,
        comments TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        invoice_id TEXT NOT NULL UNIQUE,
        vendor_name TEXT NOT NULL,
        invoice_url TEXT,
        expense_date TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        description TEXT NOT NULL,
        linked_order_id TEXT REFERENCES market_orders(id) ON DELETE SET NULL,
        linked_supplier_order_id TEXT REFERENCES supplier_orders(id) ON DELETE SET NULL,
        va_team TEXT,
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS income (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        reference_id TEXT NOT NULL UNIQUE,
        source_name TEXT NOT NULL,
        invoice_url TEXT,
        income_date TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        description TEXT NOT NULL,
        linked_order_id TEXT REFERENCES market_orders(id) ON DELETE SET NULL,
        linked_supplier_order_id TEXT REFERENCES supplier_orders(id) ON DELETE SET NULL,
        va_team TEXT,
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS import_logs (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        import_type TEXT NOT NULL CHECK (import_type IN ('market_orders','supplier_orders','transactions')),
        market_order_source TEXT,
        platform TEXT,
        file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        total_rows INTEGER NOT NULL DEFAULT 0,
        success_rows INTEGER NOT NULL DEFAULT 0,
        failed_rows INTEGER NOT NULL DEFAULT 0,
        skipped_rows INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        UNIQUE (store_id, import_type, file_hash)
      );

      CREATE TABLE IF NOT EXISTS import_log_rows (
        id TEXT PRIMARY KEY,
        import_log_id TEXT NOT NULL REFERENCES import_logs(id) ON DELETE CASCADE,
        row_number INTEGER NOT NULL,
        row_status TEXT NOT NULL CHECK (row_status IN ('success','failed','skipped_duplicate')),
        raw_row_data TEXT NOT NULL,
        error_reason TEXT,
        created_record_id TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS raw_imports (
        id TEXT PRIMARY KEY,
        import_log_id TEXT NOT NULL REFERENCES import_logs(id) ON DELETE CASCADE,
        file_content TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sync_audit_log (
        id TEXT PRIMARY KEY,
        import_log_id TEXT NOT NULL REFERENCES import_logs(id) ON DELETE CASCADE,
        record_table TEXT NOT NULL CHECK (record_table IN ('market_orders','supplier_orders','transactions')),
        record_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT NOT NULL,
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;

    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await new Promise((resolve, reject) => {
        sqliteDb.run(stmt, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    const seedOptions = [
      ['dispute_status', 'None', 0, 1, 1],
      ['dispute_status', 'Disputed', 1, 1, 2],
      ['dispute_status', 'Resolved', 0, 1, 3],
      ['order_tracker', 'New', 0, 1, 1],
      ['order_tracker', 'In Progress', 0, 1, 2],
      ['order_tracker', 'Completed', 0, 1, 3],
      ['order_tracker', 'On Hold', 0, 1, 4],
      ['va_team', 'Unassigned', 0, 1, 1],
      ['review_status', 'Pending Review', 0, 1, 1],
      ['review_status', 'Reviewed', 0, 1, 2],
      ['review_status', 'Flagged', 0, 1, 3],
      ['dispute_reason', 'Item Not Received', 0, 1, 1],
      ['dispute_reason', 'Item Not As Described', 0, 1, 2],
      ['dispute_reason', 'Damaged', 0, 1, 3],
      ['dispute_reason', 'Wrong Item', 0, 1, 4],
      ['dispute_reason', 'Other', 0, 1, 5]
    ];

    for (const opt of seedOptions) {
      await new Promise((resolve, reject) => {
        sqliteDb.run(
          `INSERT OR IGNORE INTO custom_field_options (id, field_key, option_label, excludes_from_calculations, is_active, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(), ...opt],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    console.log('SQLite migration and seeding completed successfully.');
  }
}
