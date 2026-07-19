import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import 'dotenv/config';
import * as db from './db.js';

const app = express();
const port = process.env.PORT || 3001;

// Middlewares
app.use(cors());
// Express's json() body-parser defaults to a 100kb limit — far below the 10MB CSV files this app
// accepts via Import Center (the file content is sent as a JSON string field). Without raising this,
// any real-world import over ~100KB is silently rejected before it ever reaches our route handlers.
app.use(express.json({ limit: '15mb' }));

// Bootstrapping: Ensure at least one active Admin user exists
async function bootstrapAdmin() {
  try {
    const { rows } = await db.query("SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active'");
    const adminCount = parseInt(rows[0].count || rows[0]['COUNT(*)'] || '0');
    if (adminCount === 0) {
      console.log('No active admin found. Creating default admin user...');
      const adminId = crypto.randomUUID();
      await db.query(
        `INSERT INTO users (id, email, auth_user_id, full_name, role, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [adminId, 'admin@x360.com', 'admin-auth-id', 'Default Admin', 'admin', 'active']
      );
      console.log('Default admin seeded successfully: admin@x360.com / auth_id: admin-auth-id');
    }
  } catch (err) {
    console.error('Error bootstrapping admin:', err);
  }
}

// Security Middlewares

// Env var resolution: Supabase renamed its API keys (anon -> publishable, service_role -> secret) and
// newer projects sign tokens asymmetrically (verified via a JWKS endpoint) instead of a shared HS256 secret.
// Accept either naming so this app works with old and new Supabase projects.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET;
const SUPABASE_JWKS_URL = process.env.SUPABASE_JWKS_URL;

const jwks = SUPABASE_JWKS_URL ? jwksClient({ jwksUri: SUPABASE_JWKS_URL, cache: true, cacheMaxAge: 3600000 }) : null;

function getJwksSigningKey(kid) {
  return new Promise((resolve, reject) => {
    jwks.getSigningKey(kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

// Verifies a Supabase-issued access token, whichever signing method the project uses.
async function verifySupabaseToken(token) {
  if (SUPABASE_JWT_SECRET) {
    return jwt.verify(token, SUPABASE_JWT_SECRET);
  }
  if (jwks) {
    const decodedHeader = jwt.decode(token, { complete: true });
    if (!decodedHeader || !decodedHeader.header || !decodedHeader.header.kid) {
      throw new Error('Token is missing a key ID (kid) header');
    }
    const publicKey = await getJwksSigningKey(decodedHeader.header.kid);
    return jwt.verify(token, publicKey, { algorithms: ['RS256', 'ES256'] });
  }
  throw new Error('No managed authentication verification method is configured (set SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL)');
}

// 1. Require Authenticated User (supports simulated tokens and real JWT token verification)
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['x-auth-user-id'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let authUserId = null;

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    if (!SUPABASE_JWT_SECRET && !jwks) {
      return res.status(500).json({ error: 'Managed authentication is not configured. Set SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL.' });
    }

    try {
      const decoded = await verifySupabaseToken(token);
      authUserId = decoded.sub || decoded.auth_user_id;
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired managed authentication token' });
    }
  } else {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!authUserId) {
    return res.status(401).json({ error: 'Invalid authentication claims' });
  }

  try {
    // Run auth check query
    const { rows } = await db.query('SELECT * FROM users WHERE auth_user_id = $1', [authUserId]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = rows[0];
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'User account is disabled' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth check error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// 2. Fetch User Access Helper
async function getUserAccess(userId) {
  const businessAccessQuery = 'SELECT business_id, access_level FROM user_business_access WHERE user_id = $1';
  const storeAccessQuery = 'SELECT store_id, access_level FROM user_store_access WHERE user_id = $1';

  const bRes = await db.query(businessAccessQuery, [userId]);
  const sRes = await db.query(storeAccessQuery, [userId]);

  return {
    businesses: bRes.rows, // Array of { business_id, access_level }
    stores: sRes.rows      // Array of { store_id, access_level }
  };
}

// 3. Compile list of accessible Store & Business IDs
async function getAccessibleResources(user) {
  if (user.role === 'admin') {
    // Admin has full access
    const bRes = await db.query('SELECT id FROM businesses');
    const sRes = await db.query('SELECT id FROM stores');
    return {
      businessIds: bRes.rows.map(r => r.id),
      storeIds: sRes.rows.map(r => r.id)
    };
  }

  const access = await getUserAccess(user.id);
  const businessIds = access.businesses.map(b => b.business_id);
  const directStoreIds = access.stores.map(s => s.store_id);

  // If user has business-level access, expand it to all stores under those businesses
  let storeIds = [...directStoreIds];
  if (businessIds.length > 0) {
    const placeholders = businessIds.map((_, i) => `$${i + 1}`).join(',');
    const storesInBusinesses = await db.query(
      `SELECT id FROM stores WHERE business_id IN (${placeholders})`,
      businessIds
    );
    const expandedStoreIds = storesInBusinesses.rows.map(r => r.id);
    storeIds = Array.from(new Set([...storeIds, ...expandedStoreIds]));
  }

  return {
    businessIds,
    storeIds
  };
}

// 4. Enforce Module Permission Middleware (Section 4.1 Roles & User Modules)
function enforcePermission(moduleName, requiredAction = 'view') {
  return async (req, res, next) => {
    const user = req.user;

    // Admin has override access to everything
    if (user.role === 'admin') {
      return next();
    }

    // Role hard ceilings (Section 4.1)
    if (user.role === 'client') {
      // Client role only has read access to Reporting. No access to other modules.
      if (moduleName !== 'reporting' || requiredAction !== 'view') {
        return res.status(403).json({ error: 'Client role is limited to read-only Reporting only.' });
      }
    }

    if (user.role === 'bookkeeper') {
      // Bookkeeper cannot access Settings or User management (admin screens)
      if (moduleName === 'settings' || moduleName === 'users') {
        return res.status(403).json({ error: 'Bookkeeper cannot access settings or user management.' });
      }
    }

    // Query specific user module permissions
    try {
      const { rows } = await db.query(
        'SELECT can_view, can_edit FROM user_module_permissions WHERE user_id = $1 AND module_name = $2',
        [user.id, moduleName]
      );

      const perm = rows[0] || { can_view: false, can_edit: false };

      if (requiredAction === 'view' && !perm.can_view) {
        return res.status(403).json({ error: `You do not have permission to view ${moduleName}.` });
      }

      if (requiredAction === 'edit' && !perm.can_edit) {
        return res.status(403).json({ error: `You do not have permission to edit ${moduleName}.` });
      }

      next();
    } catch (err) {
      console.error('Error checking permissions:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// --- API ENDPOINTS ---

// Auth Endpoints (Simulator / Identity mapping)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Managed authentication is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY).' });
  }

  try {
    // Delegate credential verification entirely to Supabase Auth (managed authentication) —
    // this app never stores or checks a password itself.
    const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password })
    });
    const authData = await authRes.json();

    if (!authRes.ok || !authData.access_token || !authData.user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const authUserId = authData.user.id;
    const { rows } = await db.query('SELECT * FROM users WHERE auth_user_id = $1', [authUserId]);
    if (rows.length === 0) {
      return res.status(403).json({ error: 'No x360 account is linked to this login. Contact an admin.' });
    }

    const user = rows[0];
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    await db.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    // Return the Supabase-issued access token as-is. requireAuth verifies its signature against
    // SUPABASE_JWT_SECRET on every subsequent request — no session state is held by this app.
    res.json({
      token: authData.access_token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        auth_user_id: user.auth_user_id
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Self Profile Information
app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

// Business Endpoints (Uses db.queryWithUser to enforce PostgreSQL RLS)
app.get('/api/businesses', requireAuth, async (req, res) => {
  try {
    const { businessIds } = await getAccessibleResources(req.user);
    if (businessIds.length === 0) {
      return res.json([]);
    }

    const placeholders = businessIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await db.queryWithUser(
      req.user.id,
      `SELECT * FROM businesses WHERE id IN (${placeholders}) AND is_active = true ORDER BY name ASC`,
      businessIds
    );
    res.json(rows);
  } catch (err) {
    console.error('GET businesses error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/businesses', requireAuth, enforcePermission('settings', 'edit'), async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Business name is required' });
  }

  try {
    const id = crypto.randomUUID();
    await db.queryWithUser(req.user.id, 'INSERT INTO businesses (id, name) VALUES ($1, $2)', [id, name]);
    res.status(201).json({ id, name });
  } catch (err) {
    console.error('POST businesses error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Store Endpoints (Uses db.queryWithUser to enforce PostgreSQL RLS)
app.get('/api/stores', requireAuth, async (req, res) => {
  const { business_id } = req.query;
  try {
    const { storeIds, businessIds } = await getAccessibleResources(req.user);
    if (storeIds.length === 0) {
      return res.json([]);
    }

    let queryText = 'SELECT * FROM stores WHERE id IN (' + storeIds.map((_, i) => `$${i + 1}`).join(',') + ') AND is_active = true';
    let params = [...storeIds];

    if (business_id) {
      if (!businessIds.includes(business_id)) {
        return res.status(403).json({ error: 'Access denied to this business' });
      }
      queryText += ` AND business_id = $${params.length + 1}`;
      params.push(business_id);
    }

    queryText += ' ORDER BY name ASC';
    const { rows } = await db.queryWithUser(req.user.id, queryText, params);
    res.json(rows);
  } catch (err) {
    console.error('GET stores error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/stores', requireAuth, enforcePermission('settings', 'edit'), async (req, res) => {
  const { name, business_id, platform } = req.body;
  if (!name || !business_id || !platform) {
    return res.status(400).json({ error: 'All fields (name, business_id, platform) are required' });
  }

  if (platform !== 'ebay' && platform !== 'other') {
    return res.status(400).json({ error: "Platform must be 'ebay' or 'other'" });
  }

  try {
    const id = crypto.randomUUID();
    await db.queryWithUser(
      req.user.id,
      'INSERT INTO stores (id, name, business_id, platform) VALUES ($1, $2, $3, $4)',
      [id, name, business_id, platform]
    );
    res.status(201).json({ id, name, business_id, platform });
  } catch (err) {
    console.error('POST stores error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Route: User Management list
app.get('/api/admin/users', requireAuth, enforcePermission('settings', 'view'), async (req, res) => {
  try {
    const { rows: users } = await db.query('SELECT id, email, auth_user_id, full_name, role, status, last_login_at FROM users ORDER BY full_name ASC');

    // For each user, attach their access lists and module permissions
    const detailedUsers = [];
    for (const u of users) {
      const access = await getUserAccess(u.id);
      const { rows: modulePerms } = await db.query('SELECT module_name, can_view, can_edit FROM user_module_permissions WHERE user_id = $1', [u.id]);
      detailedUsers.push({
        ...u,
        access,
        permissions: modulePerms
      });
    }

    res.json(detailedUsers);
  } catch (err) {
    console.error('GET admin users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Route: Create User
app.post('/api/admin/users', requireAuth, enforcePermission('settings', 'edit'), async (req, res) => {
  const { email, auth_user_id, password, full_name, role, status, access, permissions } = req.body;
  if (!email || !full_name || !role) {
    return res.status(400).json({ error: 'Missing required user fields' });
  }
  if (!auth_user_id && !password) {
    return res.status(400).json({ error: 'Provide a password (to create a new managed login) or an existing Auth User Identity ID' });
  }

  try {
    let resolvedAuthUserId = auth_user_id;

    // If no existing managed-auth identity was supplied, create one now via Supabase's Admin API.
    // The password is sent straight through to Supabase and is never stored by this app.
    if (!resolvedAuthUserId && password) {
      const supabaseUrl = process.env.SUPABASE_URL;
      if (!supabaseUrl || !SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'Managed authentication is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY).' });
      }

      const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
        body: JSON.stringify({ email, password, email_confirm: true })
      });
      const createData = await createRes.json();
      if (!createRes.ok || !createData.id) {
        return res.status(400).json({ error: createData.msg || createData.error_description || 'Failed to create the managed authentication account' });
      }
      resolvedAuthUserId = createData.id;
    }

    const userId = crypto.randomUUID();

    // Create user record
    await db.query(
      'INSERT INTO users (id, email, auth_user_id, full_name, role, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, email, resolvedAuthUserId, full_name, role, status || 'active']
    );

    // If access lists are provided
    if (access) {
      if (access.businesses) {
        for (const b of access.businesses) {
          await db.query(
            'INSERT INTO user_business_access (id, user_id, business_id, access_level) VALUES ($1, $2, $3, $4)',
            [crypto.randomUUID(), userId, b.business_id, b.access_level]
          );
        }
      }
      if (access.stores) {
        for (const s of access.stores) {
          await db.query(
            'INSERT INTO user_store_access (id, user_id, store_id, access_level) VALUES ($1, $2, $3, $4)',
            [crypto.randomUUID(), userId, s.store_id, s.access_level]
          );
        }
      }
    }

    // Seed default module permissions
    const modules = ['market_orders', 'supplier_orders', 'order_matching', 'transactions', 'expense', 'income', 'import_center', 'reporting', 'settings'];
    for (const m of modules) {
      const p = permissions ? permissions.find(x => x.module_name === m) : null;
      const canView = p ? !!p.can_view : (role === 'admin' || role === 'bookkeeper' || (role === 'client' && m === 'reporting'));
      const canEdit = p ? !!p.can_edit : (role === 'admin' || (role === 'bookkeeper' && m !== 'settings'));

      await db.query(
        'INSERT INTO user_module_permissions (id, user_id, module_name, can_view, can_edit) VALUES ($1, $2, $3, $4, $5)',
        [crypto.randomUUID(), userId, m, canView, canEdit]
      );
    }

    res.status(201).json({ id: userId, email, full_name, role, status });
  } catch (err) {
    console.error('POST admin users error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Admin Route: Edit User Details and permissions
app.put('/api/admin/users/:id', requireAuth, enforcePermission('settings', 'edit'), async (req, res) => {
  const { id } = req.params;
  const { full_name, role, status, access, permissions } = req.body;

  try {
    // 1. Update basic fields
    await db.query(
      'UPDATE users SET full_name = $1, role = $2, status = $3 WHERE id = $4',
      [full_name, role, status, id]
    );

    // 2. Refresh business and store access levels
    if (access) {
      await db.query('DELETE FROM user_business_access WHERE user_id = $1', [id]);
      await db.query('DELETE FROM user_store_access WHERE user_id = $1', [id]);

      if (access.businesses) {
        for (const b of access.businesses) {
          await db.query(
            'INSERT INTO user_business_access (id, user_id, business_id, access_level) VALUES ($1, $2, $3, $4)',
            [crypto.randomUUID(), id, b.business_id, b.access_level]
          );
        }
      }

      if (access.stores) {
        for (const s of access.stores) {
          await db.query(
            'INSERT INTO user_store_access (id, user_id, store_id, access_level) VALUES ($1, $2, $3, $4)',
            [crypto.randomUUID(), id, s.store_id, s.access_level]
          );
        }
      }
    }

    // 3. Update module permissions
    if (permissions) {
      for (const p of permissions) {
        await db.query(
          `INSERT INTO user_module_permissions (id, user_id, module_name, can_view, can_edit)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, module_name) DO UPDATE
           SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit`,
          [crypto.randomUUID(), id, p.module_name, !!p.can_view, !!p.can_edit]
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('PUT admin users error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Admin Route: Delete User
app.delete('/api/admin/users/:id', requireAuth, enforcePermission('settings', 'edit'), async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE admin user error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Custom Field Options Endpoints
app.get('/api/custom-field-options', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM custom_field_options ORDER BY field_key ASC, sort_order ASC, option_label ASC');
    res.json(rows);
  } catch (err) {
    console.error('GET custom field options error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/custom-field-options', requireAuth, enforcePermission('settings', 'edit'), async (req, res) => {
  const { field_key, option_label, excludes_from_calculations, is_active, sort_order } = req.body;
  if (!field_key || !option_label) {
    return res.status(400).json({ error: 'field_key and option_label are required' });
  }

  try {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO custom_field_options (id, field_key, option_label, excludes_from_calculations, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, field_key, option_label, !!excludes_from_calculations, is_active !== false, sort_order || 0]
    );
    res.status(201).json({ id, field_key, option_label, excludes_from_calculations, is_active, sort_order });
  } catch (err) {
    console.error('POST custom field options error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.put('/api/custom-field-options/:id', requireAuth, enforcePermission('settings', 'edit'), async (req, res) => {
  const { id } = req.params;
  const { option_label, excludes_from_calculations, is_active, sort_order } = req.body;

  try {
    await db.query(
      `UPDATE custom_field_options
       SET option_label = $1, excludes_from_calculations = $2, is_active = $3, sort_order = $4
       WHERE id = $5`,
      [option_label, !!excludes_from_calculations, is_active !== false, sort_order || 0, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('PUT custom field options error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.delete('/api/custom-field-options/:id', requireAuth, enforcePermission('settings', 'edit'), async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM custom_field_options WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE custom field option error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// Shared helpers for Modules 2-9
// ============================================================

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  let str = String(v).trim();
  // Accounting-style negatives: "(42.38)" means -42.38
  let negative = false;
  if (/^\(.*\)$/.test(str)) {
    negative = true;
    str = str.slice(1, -1);
  }
  // Strip everything except digits, a decimal point, and a minus sign — handles currency symbols,
  // currency codes ("US $42.38", "42.38 USD"), and thousand separators ("1,234.56") in one pass.
  const cleaned = str.replace(/[^0-9.\-]/g, '');
  let n = parseFloat(cleaned);
  if (isNaN(n)) return 0;
  if (negative) n = -Math.abs(n);
  return n;
}

function nextMonthStart(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

function computeMarketOrderDerived(row) {
  const total_expense = toNum(row.total_expense);
  const shipping_fee_cost = toNum(row.shipping_fee_cost);
  const ads_fee = toNum(row.ads_fee);
  const platform_fee = toNum(row.platform_fee);
  const other_fee = total_expense - shipping_fee_cost - ads_fee - platform_fee;

  const gross_amount = toNum(row.gross_amount);
  const refund_amount = toNum(row.refund_amount);
  let order_status = 'processing';
  if (refund_amount >= gross_amount && gross_amount > 0) order_status = 'refunded_full';
  else if (refund_amount > 0) order_status = 'refunded_partial';
  else if (row.shipped_date) order_status = 'shipped';

  return { other_fee, order_status };
}

function computeSupplierOrderDerived(row) {
  const supplier_order_total = toNum(row.supplier_order_total);
  const refunded_amount = toNum(row.refunded_amount);
  const total_cost = supplier_order_total - refunded_amount;

  let order_status = 'Order Paid';
  if (refunded_amount >= supplier_order_total && supplier_order_total > 0) order_status = 'Refunded (Full)';
  else if (refunded_amount > 0) order_status = 'Refunded (Partial)';
  else if (row.supplier_order_status) order_status = row.supplier_order_status;

  return { total_cost, order_status };
}

function parseFlexibleDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const monthNames = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  let m = str.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})$/);
  if (m) {
    const mon = monthNames[m[2].toLowerCase()];
    if (mon !== undefined) {
      let year = parseInt(m[3]);
      if (year < 100) year += 2000;
      const d = new Date(Date.UTC(year, mon, parseInt(m[1])));
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = parseInt(m[3]);
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, parseInt(m[1]) - 1, parseInt(m[2])));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function looksLikeValidId(token) {
  return /^[A-Za-z0-9_-]{3,}$/.test(token);
}

function parseItemNoteTokens(raw) {
  if (!raw) return [];
  return raw.split(/[,;]/).map(t => t.trim()).filter(t => t.length > 0);
}

// ============================================================
// Order Matching engine (Module 4)
// ============================================================

async function rebuildMatchesForMarketOrder(marketOrderId) {
  await db.query(`DELETE FROM order_matches WHERE market_order_id = $1 AND source = 'system'`, [marketOrderId]);

  const { rows: moRows } = await db.query('SELECT * FROM market_orders WHERE id = $1', [marketOrderId]);
  if (moRows.length === 0) return;
  const marketOrder = moRows[0];

  const tokens = parseItemNoteTokens(marketOrder.item_note_raw);

  for (const token of tokens) {
    if (!looksLikeValidId(token)) {
      await db.query(
        `INSERT INTO order_matches (id, market_order_id, parsed_match_key, match_status, source)
         VALUES ($1, $2, $3, 'error_parse', 'system')`,
        [crypto.randomUUID(), marketOrderId, token]
      );
      continue;
    }

    const { rows: soRows } = await db.query('SELECT * FROM supplier_orders WHERE match_key = $1 AND store_id = $2', [token, marketOrder.store_id]);
    if (soRows.length > 0) {
      const supplierOrder = soRows[0];
      const { rows: existingClaim } = await db.query(
        `SELECT * FROM order_matches WHERE supplier_order_id = $1 AND match_status = 'matched' AND market_order_id != $2`,
        [supplierOrder.id, marketOrderId]
      );
      if (existingClaim.length > 0) {
        await db.query(
          `INSERT INTO order_matches (id, market_order_id, parsed_match_key, supplier_order_id, supplier_match_key, match_status, source, duplicate_claim)
           VALUES ($1, $2, $3, $4, $5, 'unmatched_market', 'system', true)`,
          [crypto.randomUUID(), marketOrderId, token, supplierOrder.id, supplierOrder.match_key]
        );
      } else {
        await db.query(
          `INSERT INTO order_matches (id, market_order_id, parsed_match_key, supplier_order_id, supplier_match_key, match_status, source)
           VALUES ($1, $2, $3, $4, $5, 'matched', 'system')`,
          [crypto.randomUUID(), marketOrderId, token, supplierOrder.id, supplierOrder.match_key]
        );
      }
    } else {
      await db.query(
        `INSERT INTO order_matches (id, market_order_id, parsed_match_key, match_status, source)
         VALUES ($1, $2, $3, 'unmatched_market', 'system')`,
        [crypto.randomUUID(), marketOrderId, token]
      );
    }
  }
}

async function rebuildMatchesForSupplierOrder(supplierOrderId) {
  await db.query(`DELETE FROM order_matches WHERE supplier_order_id = $1 AND source = 'system'`, [supplierOrderId]);

  // If this supplier order already has a manual-sourced match, the spec's global rule says triggers
  // never touch manual rows — leave it alone rather than creating a duplicate system row for it.
  const { rows: manualExisting } = await db.query(
    `SELECT id FROM order_matches WHERE supplier_order_id = $1 AND source = 'manual'`,
    [supplierOrderId]
  );
  if (manualExisting.length > 0) return;

  const { rows: soRows } = await db.query('SELECT * FROM supplier_orders WHERE id = $1', [supplierOrderId]);
  if (soRows.length === 0) return;
  const supplierOrder = soRows[0];

  if (!supplierOrder.match_key) return;

  const { rows: claimRows } = await db.query(
    `SELECT om.* FROM order_matches om
     JOIN market_orders mo ON om.market_order_id = mo.id
     WHERE om.parsed_match_key = $1 AND om.match_status IN ('unmatched_market', 'matched') AND mo.store_id = $2
     ORDER BY om.created_at ASC`,
    [supplierOrder.match_key, supplierOrder.store_id]
  );

  // Only take a row that's genuinely unclaimed (unmatched_market) or already points at this same
  // supplier order — never silently steal a 'matched' row that's satisfied by a different supplier order.
  const claim = claimRows.find(c => c.match_status === 'unmatched_market' || c.supplier_order_id === supplierOrderId);

  if (claim) {
    await db.query(
      `UPDATE order_matches SET supplier_order_id = $1, supplier_match_key = $2, match_status = 'matched', source = 'system' WHERE id = $3`,
      [supplierOrderId, supplierOrder.match_key, claim.id]
    );
  } else {
    await db.query(
      `INSERT INTO order_matches (id, supplier_order_id, supplier_match_key, match_status, source)
       VALUES ($1, $2, $3, 'unmatched_supplier', 'system')`,
      [crypto.randomUUID(), supplierOrderId, supplierOrder.match_key]
    );
  }
}

// ============================================================
// Module 2: Market Orders
// ============================================================

app.get('/api/market-orders', requireAuth, enforcePermission('market_orders', 'view'), async (req, res) => {
  try {
    const { store_id, date_from, date_to, order_status, dispute_status, order_tracker, va_team, review_status } = req.query;
    const access = await getAccessibleResources(req.user);
    let conditions = [];
    let params = [];
    let i = 1;

    if (store_id) {
      conditions.push(`mo.store_id = $${i++}`);
      params.push(store_id);
    } else if (req.user.role !== 'admin') {
      if (access.storeIds.length === 0) return res.json([]);
      conditions.push(`mo.store_id IN (${access.storeIds.map(() => `$${i++}`).join(',')})`);
      params.push(...access.storeIds);
    }
    if (date_from) { conditions.push(`mo.order_date >= $${i++}`); params.push(date_from); }
    if (date_to) { conditions.push(`mo.order_date <= $${i++}`); params.push(date_to); }
    if (order_status) { conditions.push(`mo.order_status = $${i++}`); params.push(order_status); }
    if (dispute_status) { conditions.push(`mo.dispute_status = $${i++}`); params.push(dispute_status); }
    if (order_tracker) { conditions.push(`mo.order_tracker = $${i++}`); params.push(order_tracker); }
    if (va_team) { conditions.push(`mo.va_team = $${i++}`); params.push(va_team); }
    if (review_status) { conditions.push(`mo.review_status = $${i++}`); params.push(review_status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT mo.*,
        EXISTS(SELECT 1 FROM order_matches om WHERE om.market_order_id = mo.id AND om.match_status = 'matched') as has_cogs
       FROM market_orders mo ${where}
       ORDER BY mo.order_date DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET market-orders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/market-orders/:id', requireAuth, enforcePermission('market_orders', 'view'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM market_orders WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/market-orders', requireAuth, enforcePermission('market_orders', 'edit'), async (req, res) => {
  const b = req.body;
  if (!b.store_id || !b.market_order_id || !b.order_date) {
    return res.status(400).json({ error: 'store_id, market_order_id, and order_date are required' });
  }
  try {
    const derived = computeMarketOrderDerived(b);
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO market_orders (id, store_id, market_order_id, order_date, item_title, buyer_name, buyer_state,
        gross_amount, platform_fee, ads_fee, shipping_fee_cost, total_expense, other_fee, refund_amount, net_earnings,
        item_note_raw, shipped_date, order_status, dispute_status, order_tracker, va_team, review_status, dispute_reason,
        comments, order_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [id, b.store_id, b.market_order_id, b.order_date, b.item_title || null, b.buyer_name || null, b.buyer_state || null,
       toNum(b.gross_amount), toNum(b.platform_fee), toNum(b.ads_fee), toNum(b.shipping_fee_cost), toNum(b.total_expense),
       derived.other_fee, toNum(b.refund_amount), toNum(b.net_earnings), b.item_note_raw || null, b.shipped_date || null,
       derived.order_status, b.dispute_status || null, b.order_tracker || null, b.va_team || null, b.review_status || null,
       b.dispute_reason || null, b.comments || null, b.order_notes || null]
    );
    await rebuildMatchesForMarketOrder(id);
    res.status(201).json({ id });
  } catch (err) {
    console.error('POST market-orders error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.put('/api/market-orders/:id', requireAuth, enforcePermission('market_orders', 'edit'), async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  try {
    const { rows: existingRows } = await db.query('SELECT * FROM market_orders WHERE id = $1', [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const existing = existingRows[0];

    const merged = { ...existing, ...b };
    const derived = computeMarketOrderDerived(merged);

    await db.query(
      `UPDATE market_orders SET
        item_title = $1, buyer_name = $2, buyer_state = $3, gross_amount = $4, platform_fee = $5, ads_fee = $6,
        shipping_fee_cost = $7, total_expense = $8, other_fee = $9, refund_amount = $10, net_earnings = $11,
        item_note_raw = $12, shipped_date = $13, order_status = $14, dispute_status = $15, order_tracker = $16,
        va_team = $17, review_status = $18, dispute_reason = $19, comments = $20, order_notes = $21
       WHERE id = $22`,
      [merged.item_title || null, merged.buyer_name || null, merged.buyer_state || null, toNum(merged.gross_amount),
       toNum(merged.platform_fee), toNum(merged.ads_fee), toNum(merged.shipping_fee_cost), toNum(merged.total_expense),
       derived.other_fee, toNum(merged.refund_amount), toNum(merged.net_earnings), merged.item_note_raw || null,
       merged.shipped_date || null, derived.order_status, merged.dispute_status || null, merged.order_tracker || null,
       merged.va_team || null, merged.review_status || null, merged.dispute_reason || null, merged.comments || null,
       merged.order_notes || null, id]
    );

    if (merged.item_note_raw !== existing.item_note_raw) {
      await rebuildMatchesForMarketOrder(id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('PUT market-orders error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ============================================================
// Module 3: Supplier Orders
// ============================================================

app.get('/api/supplier-orders', requireAuth, enforcePermission('supplier_orders', 'view'), async (req, res) => {
  try {
    const { store_id, source_vendor, date_from, date_to, dispute_status, order_tracker, va_team, review_status, order_status } = req.query;
    const access = await getAccessibleResources(req.user);
    let conditions = [];
    let params = [];
    let i = 1;

    if (store_id) { conditions.push(`store_id = $${i++}`); params.push(store_id); }
    else if (req.user.role !== 'admin') {
      if (access.storeIds.length === 0) return res.json([]);
      conditions.push(`store_id IN (${access.storeIds.map(() => `$${i++}`).join(',')})`);
      params.push(...access.storeIds);
    }
    if (source_vendor) { conditions.push(`source_vendor = $${i++}`); params.push(source_vendor); }
    if (date_from) { conditions.push(`supplier_order_date >= $${i++}`); params.push(date_from); }
    if (date_to) { conditions.push(`supplier_order_date <= $${i++}`); params.push(date_to); }
    if (dispute_status) { conditions.push(`dispute_status = $${i++}`); params.push(dispute_status); }
    if (order_tracker) { conditions.push(`order_tracker = $${i++}`); params.push(order_tracker); }
    if (va_team) { conditions.push(`va_team = $${i++}`); params.push(va_team); }
    if (review_status) { conditions.push(`review_status = $${i++}`); params.push(review_status); }
    if (order_status) { conditions.push(`order_status = $${i++}`); params.push(order_status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(`SELECT * FROM supplier_orders ${where} ORDER BY supplier_order_date DESC`, params);
    res.json(rows);
  } catch (err) {
    console.error('GET supplier-orders error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/supplier-orders/:id', requireAuth, enforcePermission('supplier_orders', 'view'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM supplier_orders WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/supplier-orders', requireAuth, enforcePermission('supplier_orders', 'edit'), async (req, res) => {
  const b = req.body;
  if (!b.store_id || !b.source_vendor || !b.supplier_order_id || !b.supplier_order_date) {
    return res.status(400).json({ error: 'store_id, source_vendor, supplier_order_id, and supplier_order_date are required' });
  }
  try {
    const derived = computeSupplierOrderDerived(b);
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO supplier_orders (id, store_id, source_vendor, supplier_store_name, supplier_order_id, match_key,
        supplier_order_date, supplier_order_status, item_title, order_qty, unit_price, shipping_cost, price_adjustment,
        discount_total, other_total, tax_total, supplier_order_total, payment_method, tracking_number, tracking_carrier,
        buyer_name, ship_state, supplier_refund_status, refunded_amount, date_refunded, supplier_notes, total_cost,
        order_status, dispute_status, order_tracker, va_team, review_status, dispute_reason, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)`,
      [id, b.store_id, b.source_vendor, b.supplier_store_name || null, b.supplier_order_id, b.match_key || null,
       b.supplier_order_date, b.supplier_order_status || null, b.item_title || null, parseInt(b.order_qty) || 1,
       toNum(b.unit_price), toNum(b.shipping_cost), toNum(b.price_adjustment), toNum(b.discount_total), toNum(b.other_total),
       toNum(b.tax_total), toNum(b.supplier_order_total), b.payment_method || null, b.tracking_number || null,
       b.tracking_carrier || null, b.buyer_name || null, b.ship_state || null, b.supplier_refund_status || null,
       toNum(b.refunded_amount), b.date_refunded || null, b.supplier_notes || null, derived.total_cost, derived.order_status,
       b.dispute_status || null, b.order_tracker || null, b.va_team || null, b.review_status || null, b.dispute_reason || null,
       b.comments || null]
    );
    await rebuildMatchesForSupplierOrder(id);
    res.status(201).json({ id });
  } catch (err) {
    console.error('POST supplier-orders error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.put('/api/supplier-orders/:id', requireAuth, enforcePermission('supplier_orders', 'edit'), async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  try {
    const { rows: existingRows } = await db.query('SELECT * FROM supplier_orders WHERE id = $1', [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const existing = existingRows[0];
    const merged = { ...existing, ...b };
    const derived = computeSupplierOrderDerived(merged);

    await db.query(
      `UPDATE supplier_orders SET
        supplier_store_name = $1, match_key = $2, supplier_order_status = $3, item_title = $4, order_qty = $5,
        unit_price = $6, shipping_cost = $7, price_adjustment = $8, discount_total = $9, other_total = $10,
        tax_total = $11, supplier_order_total = $12, payment_method = $13, tracking_number = $14, tracking_carrier = $15,
        buyer_name = $16, ship_state = $17, supplier_refund_status = $18, refunded_amount = $19, date_refunded = $20,
        supplier_notes = $21, total_cost = $22, order_status = $23, dispute_status = $24, order_tracker = $25,
        va_team = $26, review_status = $27, dispute_reason = $28, comments = $29
       WHERE id = $30`,
      [merged.supplier_store_name || null, merged.match_key || null, merged.supplier_order_status || null,
       merged.item_title || null, parseInt(merged.order_qty) || 1, toNum(merged.unit_price), toNum(merged.shipping_cost),
       toNum(merged.price_adjustment), toNum(merged.discount_total), toNum(merged.other_total), toNum(merged.tax_total),
       toNum(merged.supplier_order_total), merged.payment_method || null, merged.tracking_number || null,
       merged.tracking_carrier || null, merged.buyer_name || null, merged.ship_state || null,
       merged.supplier_refund_status || null, toNum(merged.refunded_amount), merged.date_refunded || null,
       merged.supplier_notes || null, derived.total_cost, derived.order_status, merged.dispute_status || null,
       merged.order_tracker || null, merged.va_team || null, merged.review_status || null, merged.dispute_reason || null,
       merged.comments || null, id]
    );

    if (merged.match_key !== existing.match_key) {
      await rebuildMatchesForSupplierOrder(id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('PUT supplier-orders error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ============================================================
// Module 4: Order Matching
// ============================================================

app.get('/api/order-matches', requireAuth, enforcePermission('order_matching', 'view'), async (req, res) => {
  try {
    const { match_status, store_id } = req.query;
    let conditions = [];
    let params = [];
    let i = 1;
    if (match_status) { conditions.push(`om.match_status = $${i++}`); params.push(match_status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT om.*,
        mo.market_order_id as mo_market_order_id, mo.buyer_name as mo_buyer_name, mo.buyer_state as mo_buyer_state,
        mo.item_title as mo_item_title, mo.order_date as mo_order_date, mo.store_id as mo_store_id,
        so.supplier_order_id as so_supplier_order_id, so.buyer_name as so_buyer_name, so.ship_state as so_ship_state,
        so.item_title as so_item_title, so.supplier_order_date as so_order_date, so.store_id as so_store_id
       FROM order_matches om
       LEFT JOIN market_orders mo ON om.market_order_id = mo.id
       LEFT JOIN supplier_orders so ON om.supplier_order_id = so.id
       ${where}
       ORDER BY om.created_at DESC`,
      params
    );

    let filtered = rows;
    if (store_id) {
      filtered = rows.filter(r => r.mo_store_id === store_id || r.so_store_id === store_id);
    }

    filtered = filtered.map(r => {
      let soft_mismatch = false;
      if (r.mo_buyer_name && r.so_buyer_name && r.mo_buyer_state && r.so_ship_state) {
        const nameMismatch = r.mo_buyer_name.trim().toLowerCase() !== r.so_buyer_name.trim().toLowerCase();
        const stateMismatch = r.mo_buyer_state.trim().toLowerCase() !== r.so_ship_state.trim().toLowerCase();
        soft_mismatch = nameMismatch || stateMismatch;
      }
      return { ...r, soft_mismatch };
    });

    res.json(filtered);
  } catch (err) {
    console.error('GET order-matches error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/order-matches/:id/parsed-key', requireAuth, enforcePermission('order_matching', 'edit'), async (req, res) => {
  const { id } = req.params;
  const { parsed_match_key } = req.body;
  try {
    const { rows: matchRows } = await db.query(
      `SELECT om.*, mo.store_id as mo_store_id FROM order_matches om LEFT JOIN market_orders mo ON om.market_order_id = mo.id WHERE om.id = $1`,
      [id]
    );
    if (matchRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const storeId = matchRows[0].mo_store_id;

    const { rows: soRows } = storeId
      ? await db.query('SELECT * FROM supplier_orders WHERE match_key = $1 AND store_id = $2', [parsed_match_key, storeId])
      : { rows: [] };
    if (soRows.length > 0) {
      await db.query(
        `UPDATE order_matches SET parsed_match_key = $1, supplier_order_id = $2, supplier_match_key = $3, match_status = 'matched', source = 'manual' WHERE id = $4`,
        [parsed_match_key, soRows[0].id, soRows[0].match_key, id]
      );
    } else {
      await db.query(
        `UPDATE order_matches SET parsed_match_key = $1, match_status = 'unmatched_market', source = 'manual' WHERE id = $2`,
        [parsed_match_key, id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/order-matches/:id/link', requireAuth, enforcePermission('order_matching', 'edit'), async (req, res) => {
  const { id } = req.params;
  const { market_order_id, supplier_order_id } = req.body;
  try {
    let supplier_match_key = null;
    if (supplier_order_id) {
      const { rows } = await db.query('SELECT match_key FROM supplier_orders WHERE id = $1', [supplier_order_id]);
      supplier_match_key = rows[0] ? rows[0].match_key : null;
    }
    await db.query(
      `UPDATE order_matches SET
        market_order_id = COALESCE($1, market_order_id),
        supplier_order_id = COALESCE($2, supplier_order_id),
        supplier_match_key = COALESCE($3, supplier_match_key),
        match_status = 'matched', source = 'manual'
       WHERE id = $4`,
      [market_order_id || null, supplier_order_id || null, supplier_match_key, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/order-matches/:id/remove-link', requireAuth, enforcePermission('order_matching', 'edit'), async (req, res) => {
  try {
    await db.query('DELETE FROM order_matches WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/order-matches/:id/reset-to-system', requireAuth, enforcePermission('order_matching', 'edit'), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query('SELECT * FROM order_matches WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const match = rows[0];
    await db.query(`UPDATE order_matches SET source = 'system' WHERE id = $1`, [id]);
    if (match.market_order_id) await rebuildMatchesForMarketOrder(match.market_order_id);
    if (match.supplier_order_id) await rebuildMatchesForSupplierOrder(match.supplier_order_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/order-matches/remap/:marketOrSupplierId', requireAuth, enforcePermission('order_matching', 'edit'), async (req, res) => {
  const { marketOrSupplierId } = req.params;
  const { type } = req.body;
  try {
    if (type === 'market') await rebuildMatchesForMarketOrder(marketOrSupplierId);
    else await rebuildMatchesForSupplierOrder(marketOrSupplierId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/order-matches/remap-all', requireAuth, enforcePermission('order_matching', 'edit'), async (req, res) => {
  try {
    const { rows: allMarket } = await db.query('SELECT id FROM market_orders');
    for (const m of allMarket) await rebuildMatchesForMarketOrder(m.id);
    const { rows: allSupplier } = await db.query('SELECT id FROM supplier_orders');
    for (const s of allSupplier) await rebuildMatchesForSupplierOrder(s.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ============================================================
// Module 5: Transactions
// ============================================================

app.get('/api/transactions', requireAuth, enforcePermission('transactions', 'view'), async (req, res) => {
  try {
    const { store_id, date_from, date_to, transaction_type, payout_batch_id, market_order_id } = req.query;
    const access = await getAccessibleResources(req.user);
    let conditions = [];
    let params = [];
    let i = 1;

    if (store_id) { conditions.push(`store_id = $${i++}`); params.push(store_id); }
    else if (req.user.role !== 'admin') {
      if (access.storeIds.length === 0) return res.json([]);
      conditions.push(`store_id IN (${access.storeIds.map(() => `$${i++}`).join(',')})`);
      params.push(...access.storeIds);
    }
    if (date_from) { conditions.push(`transaction_date >= $${i++}`); params.push(date_from); }
    if (date_to) { conditions.push(`transaction_date <= $${i++}`); params.push(date_to); }
    if (transaction_type) { conditions.push(`transaction_type = $${i++}`); params.push(transaction_type); }
    if (payout_batch_id) { conditions.push(`payout_batch_id = $${i++}`); params.push(payout_batch_id); }
    if (market_order_id) { conditions.push(`market_order_id = $${i++}`); params.push(market_order_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(`SELECT * FROM transactions ${where} ORDER BY transaction_date DESC`, params);
    res.json(rows);
  } catch (err) {
    console.error('GET transactions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/transactions/payouts', requireAuth, enforcePermission('transactions', 'view'), async (req, res) => {
  try {
    const { store_id } = req.query;
    const params = store_id ? [store_id] : [];
    const where = store_id ? 'WHERE store_id = $1' : '';
    const { rows } = await db.query(
      `SELECT * FROM transactions ${where} ORDER BY payout_batch_id, transaction_date`, params
    );
    const grouped = {};
    for (const r of rows) {
      const key = r.payout_batch_id || '(no batch)';
      if (!grouped[key]) grouped[key] = { payout_batch_id: r.payout_batch_id, payout_date: r.payout_date, payout_status: r.payout_status, transactions: [] };
      grouped[key].transactions.push(r);
    }
    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// Module 6: Expense
// ============================================================

app.get('/api/expenses', requireAuth, enforcePermission('expense', 'view'), async (req, res) => {
  try {
    const { store_id, date_from, date_to, va_team, linked } = req.query;
    const access = await getAccessibleResources(req.user);
    let conditions = [];
    let params = [];
    let i = 1;

    if (store_id) { conditions.push(`store_id = $${i++}`); params.push(store_id); }
    else if (req.user.role !== 'admin') {
      if (access.storeIds.length === 0) return res.json([]);
      conditions.push(`store_id IN (${access.storeIds.map(() => `$${i++}`).join(',')})`);
      params.push(...access.storeIds);
    }
    if (date_from) { conditions.push(`expense_date >= $${i++}`); params.push(date_from); }
    if (date_to) { conditions.push(`expense_date <= $${i++}`); params.push(date_to); }
    if (va_team) { conditions.push(`va_team = $${i++}`); params.push(va_team); }
    if (linked === 'true') conditions.push(`(linked_order_id IS NOT NULL OR linked_supplier_order_id IS NOT NULL)`);
    if (linked === 'false') conditions.push(`(linked_order_id IS NULL AND linked_supplier_order_id IS NULL)`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(`SELECT * FROM expenses ${where} ORDER BY expense_date DESC`, params);
    res.json(rows);
  } catch (err) {
    console.error('GET expenses error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/expenses', requireAuth, enforcePermission('expense', 'edit'), async (req, res) => {
  const b = req.body;
  if (!b.invoice_id || !b.vendor_name || !b.expense_date || b.amount === undefined || !b.description) {
    return res.status(400).json({ error: 'invoice_id, vendor_name, expense_date, amount, and description are required' });
  }
  try {
    let store_id = b.store_id;
    if (b.linked_order_id) {
      const { rows } = await db.query('SELECT store_id FROM market_orders WHERE id = $1', [b.linked_order_id]);
      if (rows.length) store_id = rows[0].store_id;
    } else if (b.linked_supplier_order_id) {
      const { rows } = await db.query('SELECT store_id FROM supplier_orders WHERE id = $1', [b.linked_supplier_order_id]);
      if (rows.length) store_id = rows[0].store_id;
    }
    if (!store_id) return res.status(400).json({ error: 'store_id is required when no order is linked' });

    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO expenses (id, store_id, invoice_id, vendor_name, invoice_url, expense_date, amount, description,
        linked_order_id, linked_supplier_order_id, va_team, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, store_id, b.invoice_id, b.vendor_name, b.invoice_url || null, b.expense_date, toNum(b.amount), b.description,
       b.linked_order_id || null, b.linked_supplier_order_id || null, b.va_team || null, req.user.id]
    );
    res.status(201).json({ id });
  } catch (err) {
    console.error('POST expenses error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.put('/api/expenses/:id', requireAuth, enforcePermission('expense', 'edit'), async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  try {
    const { rows: existingRows } = await db.query('SELECT * FROM expenses WHERE id = $1', [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const existing = existingRows[0];
    const merged = { ...existing, ...b };

    let store_id = merged.store_id;
    if (merged.linked_order_id) {
      const { rows } = await db.query('SELECT store_id FROM market_orders WHERE id = $1', [merged.linked_order_id]);
      if (rows.length) store_id = rows[0].store_id;
    } else if (merged.linked_supplier_order_id) {
      const { rows } = await db.query('SELECT store_id FROM supplier_orders WHERE id = $1', [merged.linked_supplier_order_id]);
      if (rows.length) store_id = rows[0].store_id;
    }

    await db.query(
      `UPDATE expenses SET store_id = $1, vendor_name = $2, invoice_url = $3, expense_date = $4, amount = $5,
        description = $6, linked_order_id = $7, linked_supplier_order_id = $8, va_team = $9 WHERE id = $10`,
      [store_id, merged.vendor_name, merged.invoice_url || null, merged.expense_date, toNum(merged.amount),
       merged.description, merged.linked_order_id || null, merged.linked_supplier_order_id || null, merged.va_team || null, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ============================================================
// Module 7: Income
// ============================================================

app.get('/api/income', requireAuth, enforcePermission('income', 'view'), async (req, res) => {
  try {
    const { store_id, date_from, date_to, va_team, linked } = req.query;
    const access = await getAccessibleResources(req.user);
    let conditions = [];
    let params = [];
    let i = 1;

    if (store_id) { conditions.push(`store_id = $${i++}`); params.push(store_id); }
    else if (req.user.role !== 'admin') {
      if (access.storeIds.length === 0) return res.json([]);
      conditions.push(`store_id IN (${access.storeIds.map(() => `$${i++}`).join(',')})`);
      params.push(...access.storeIds);
    }
    if (date_from) { conditions.push(`income_date >= $${i++}`); params.push(date_from); }
    if (date_to) { conditions.push(`income_date <= $${i++}`); params.push(date_to); }
    if (va_team) { conditions.push(`va_team = $${i++}`); params.push(va_team); }
    if (linked === 'true') conditions.push(`(linked_order_id IS NOT NULL OR linked_supplier_order_id IS NOT NULL)`);
    if (linked === 'false') conditions.push(`(linked_order_id IS NULL AND linked_supplier_order_id IS NULL)`);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(`SELECT * FROM income ${where} ORDER BY income_date DESC`, params);
    res.json(rows);
  } catch (err) {
    console.error('GET income error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/income', requireAuth, enforcePermission('income', 'edit'), async (req, res) => {
  const b = req.body;
  if (!b.reference_id || !b.source_name || !b.income_date || b.amount === undefined || !b.description) {
    return res.status(400).json({ error: 'reference_id, source_name, income_date, amount, and description are required' });
  }
  try {
    let store_id = b.store_id;
    if (b.linked_order_id) {
      const { rows } = await db.query('SELECT store_id FROM market_orders WHERE id = $1', [b.linked_order_id]);
      if (rows.length) store_id = rows[0].store_id;
    } else if (b.linked_supplier_order_id) {
      const { rows } = await db.query('SELECT store_id FROM supplier_orders WHERE id = $1', [b.linked_supplier_order_id]);
      if (rows.length) store_id = rows[0].store_id;
    }
    if (!store_id) return res.status(400).json({ error: 'store_id is required when no order is linked' });

    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO income (id, store_id, reference_id, source_name, invoice_url, income_date, amount, description,
        linked_order_id, linked_supplier_order_id, va_team, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, store_id, b.reference_id, b.source_name, b.invoice_url || null, b.income_date, toNum(b.amount), b.description,
       b.linked_order_id || null, b.linked_supplier_order_id || null, b.va_team || null, req.user.id]
    );
    res.status(201).json({ id });
  } catch (err) {
    console.error('POST income error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.put('/api/income/:id', requireAuth, enforcePermission('income', 'edit'), async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  try {
    const { rows: existingRows } = await db.query('SELECT * FROM income WHERE id = $1', [id]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const existing = existingRows[0];
    const merged = { ...existing, ...b };

    let store_id = merged.store_id;
    if (merged.linked_order_id) {
      const { rows } = await db.query('SELECT store_id FROM market_orders WHERE id = $1', [merged.linked_order_id]);
      if (rows.length) store_id = rows[0].store_id;
    } else if (merged.linked_supplier_order_id) {
      const { rows } = await db.query('SELECT store_id FROM supplier_orders WHERE id = $1', [merged.linked_supplier_order_id]);
      if (rows.length) store_id = rows[0].store_id;
    }

    await db.query(
      `UPDATE income SET store_id = $1, source_name = $2, invoice_url = $3, income_date = $4, amount = $5,
        description = $6, linked_order_id = $7, linked_supplier_order_id = $8, va_team = $9 WHERE id = $10`,
      [store_id, merged.source_name, merged.invoice_url || null, merged.income_date, toNum(merged.amount),
       merged.description, merged.linked_order_id || null, merged.linked_supplier_order_id || null, merged.va_team || null, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// ============================================================
// Module 8: Import Center
// ============================================================

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

function findHeaderRowIndex(rows) {
  // Scan the first N rows and pick the one with the most non-blank cells — this is far more
  // reliable than "first row with >1 non-blank cell", since many real export files (eBay, etc.)
  // have leading notes/junk rows that use placeholder characters like "--" instead of truly blank cells.
  const scanLimit = Math.min(rows.length, 50);
  let bestIdx = 0;
  let bestCount = -1;
  for (let i = 0; i < scanLimit; i++) {
    const nonBlank = rows[i].filter(c => c && c.trim() !== '' && c.trim() !== '--').length;
    if (nonBlank > bestCount) {
      bestCount = nonBlank;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function csvToObjects(text) {
  const rawRows = parseCSV(text);
  if (rawRows.length === 0) return { headers: [], objects: [] };
  const headerIdx = findHeaderRowIndex(rawRows);
  const headers = rawRows[headerIdx].map(h => h.trim());

  // Some exports (eBay, etc.) append trailing footer/summary lines after the real data, e.g.
  // "427,record(s) downloaded," or "Seller ID : gtx_360" — these have only 1-2 non-blank cells,
  // far below any real data row (even a sparse one, like a secondary line-item row in a multi-item
  // order). A flat minimum catches the junk without risking real-but-sparse rows.
  const minColsForDataRow = Math.min(5, headers.length);
  const dataRows = rawRows.slice(headerIdx + 1).filter(r => {
    const nonBlank = r.filter(c => c && c.trim() !== '').length;
    return nonBlank >= minColsForDataRow;
  });

  const objects = dataRows.map(r => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx].trim() : ''; });
    return obj;
  });
  return { headers, objects };
}

function computeRowHash(fields) {
  const str = JSON.stringify(fields);
  return crypto.createHash('sha256').update(str).digest('hex');
}

function escapeCsvCell(value) {
  const str = String(value === null || value === undefined ? '' : value);
  const escaped = /^[=+\-@]/.test(str) ? `'${str}` : str;
  if (escaped.includes(',') || escaped.includes('"') || escaped.includes('\n')) {
    return `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
}

app.post('/api/import-center/preview', requireAuth, enforcePermission('import_center', 'edit'), async (req, res) => {
  try {
    const { file_content } = req.body;
    if (!file_content) return res.status(400).json({ error: 'file_content is required' });
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file_content.length > MAX_SIZE) {
      return res.status(400).json({ error: 'File exceeds the maximum allowed size (10MB).' });
    }
    const { headers, objects } = csvToObjects(file_content);
    const MAX_ROWS = 50000;
    if (objects.length > MAX_ROWS) {
      return res.status(400).json({ error: `File exceeds the maximum allowed row count (${MAX_ROWS}).` });
    }
    res.json({ headers, preview: objects.slice(0, 10), total_rows: objects.length });
  } catch (err) {
    console.error('Import preview error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

function applyMapping(sourceRow, mapping, targetField) {
  const mapped = mapping[targetField];
  if (!mapped) return '';
  if (Array.isArray(mapped)) {
    return mapped.reduce((sum, col) => sum + toNum(sourceRow[col]), 0);
  }
  return sourceRow[mapped] !== undefined ? sourceRow[mapped] : '';
}

app.post('/api/import-center/commit', requireAuth, enforcePermission('import_center', 'edit'), async (req, res) => {
  const { store_id, import_type, market_order_source, file_name, file_content, column_mapping } = req.body;
  if (!store_id || !import_type || !file_name || !file_content) {
    return res.status(400).json({ error: 'store_id, import_type, file_name, and file_content are required' });
  }
  if (import_type === 'market_orders' && !market_order_source) {
    return res.status(400).json({ error: 'market_order_source is required for market_orders imports' });
  }

  try {
    const file_hash = crypto.createHash('sha256').update(file_content).digest('hex');

    const { rows: dupCheck } = await db.query(
      'SELECT id FROM import_logs WHERE store_id = $1 AND import_type = $2 AND file_hash = $3',
      [store_id, import_type, file_hash]
    );
    if (dupCheck.length > 0) {
      return res.status(409).json({ error: 'This exact file has already been imported for this store and import type.', existing_import_log_id: dupCheck[0].id });
    }

    const { rows: storeRows } = await db.query('SELECT * FROM stores WHERE id = $1', [store_id]);
    if (storeRows.length === 0) return res.status(404).json({ error: 'Store not found' });
    const store = storeRows[0];

    const { objects } = csvToObjects(file_content);

    const importLogId = crypto.randomUUID();
    await db.query(
      `INSERT INTO import_logs (id, store_id, import_type, market_order_source, platform, file_name, file_hash,
        total_rows, status, uploaded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9)`,
      [importLogId, store_id, import_type, market_order_source || null,
       (import_type === 'market_orders' || import_type === 'transactions') ? store.platform : null,
       file_name, file_hash, objects.length, req.user.id]
    );
    await db.query('INSERT INTO raw_imports (id, import_log_id, file_content) VALUES ($1, $2, $3)', [crypto.randomUUID(), importLogId, file_content]);

    let successCount = 0, failedCount = 0, skippedCount = 0;
    const mapping = column_mapping || {};

    for (let idx = 0; idx < objects.length; idx++) {
      const rawRow = objects[idx];
      const rowNumber = idx + 1;
      try {
        if (import_type === 'market_orders' && market_order_source === 'earnings') {
          const market_order_id = String(applyMapping(rawRow, mapping, 'market_order_id') || '').trim();
          const order_date_raw = applyMapping(rawRow, mapping, 'order_date');
          const order_date = parseFlexibleDate(order_date_raw);
          if (!market_order_id) throw new Error('market_order_id (mapped from Order number) is missing or blank');
          if (!order_date) throw new Error(`order_date could not be parsed from value "${order_date_raw}"`);

          const fields = {
            item_title: applyMapping(rawRow, mapping, 'item_title') || null,
            buyer_name: applyMapping(rawRow, mapping, 'buyer_name') || null,
            buyer_state: applyMapping(rawRow, mapping, 'buyer_state') || null,
            gross_amount: toNum(applyMapping(rawRow, mapping, 'gross_amount')),
            platform_fee: toNum(applyMapping(rawRow, mapping, 'platform_fee')),
            ads_fee: toNum(applyMapping(rawRow, mapping, 'ads_fee')),
            shipping_fee_cost: toNum(applyMapping(rawRow, mapping, 'shipping_fee_cost')),
            total_expense: toNum(applyMapping(rawRow, mapping, 'total_expense')),
            refund_amount: toNum(applyMapping(rawRow, mapping, 'refund_amount')),
            net_earnings: toNum(applyMapping(rawRow, mapping, 'net_earnings'))
          };
          const derived = computeMarketOrderDerived(fields);

          const { rows: existRows } = await db.query('SELECT * FROM market_orders WHERE store_id = $1 AND market_order_id = $2', [store_id, market_order_id]);
          let recordId;
          if (existRows.length > 0) {
            recordId = existRows[0].id;
            for (const [fname, fval] of Object.entries(fields)) {
              if (String(existRows[0][fname] ?? '') !== String(fval ?? '')) {
                await db.query(
                  `INSERT INTO sync_audit_log (id, import_log_id, record_table, record_id, field_name, old_value, new_value) VALUES ($1,$2,'market_orders',$3,$4,$5,$6)`,
                  [crypto.randomUUID(), importLogId, recordId, fname, String(existRows[0][fname] ?? ''), String(fval ?? '')]
                );
              }
            }
            await db.query(
              `UPDATE market_orders SET order_date=$1, item_title=$2, buyer_name=$3, buyer_state=$4, gross_amount=$5,
                platform_fee=$6, ads_fee=$7, shipping_fee_cost=$8, total_expense=$9, other_fee=$10, refund_amount=$11,
                net_earnings=$12, order_status=$13 WHERE id=$14`,
              [order_date, fields.item_title, fields.buyer_name, fields.buyer_state, fields.gross_amount,
               fields.platform_fee, fields.ads_fee, fields.shipping_fee_cost, fields.total_expense, derived.other_fee,
               fields.refund_amount, fields.net_earnings, derived.order_status, recordId]
            );
          } else {
            recordId = crypto.randomUUID();
            await db.query(
              `INSERT INTO market_orders (id, store_id, market_order_id, order_date, item_title, buyer_name, buyer_state,
                gross_amount, platform_fee, ads_fee, shipping_fee_cost, total_expense, other_fee, refund_amount, net_earnings, order_status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
              [recordId, store_id, market_order_id, order_date, fields.item_title, fields.buyer_name, fields.buyer_state,
               fields.gross_amount, fields.platform_fee, fields.ads_fee, fields.shipping_fee_cost, fields.total_expense,
               derived.other_fee, fields.refund_amount, fields.net_earnings, derived.order_status]
            );
          }
          await rebuildMatchesForMarketOrder(recordId);
          await db.query(
            `INSERT INTO import_log_rows (id, import_log_id, row_number, row_status, raw_row_data, created_record_id) VALUES ($1,$2,$3,'success',$4,$5)`,
            [crypto.randomUUID(), importLogId, rowNumber, JSON.stringify(rawRow), recordId]
          );
          successCount++;

        } else if (import_type === 'market_orders' && market_order_source === 'orders_report') {
          const orderNumber = String(applyMapping(rawRow, mapping, 'market_order_id') || rawRow['Order Number'] || '').trim();
          if (!orderNumber) throw new Error('Order Number is missing or blank');

          const { rows: existRows } = await db.query('SELECT * FROM market_orders WHERE store_id = $1 AND market_order_id = $2', [store_id, orderNumber]);
          if (existRows.length === 0) {
            throw new Error(`No matching market order exists for Order Number "${orderNumber}" — import Order Earnings first`);
          }
          const existing = existRows[0];
          const noteVal = (rawRow['My Item Note'] || applyMapping(rawRow, mapping, 'item_note_raw') || '').trim();
          const shippedVal = rawRow['Shipped On Date'] || applyMapping(rawRow, mapping, 'shipped_date') || '';

          let newNote = existing.item_note_raw || '';
          if (noteVal) {
            const existingTokens = newNote ? newNote.split(',').map(t => t.trim()).filter(Boolean) : [];
            if (!existingTokens.includes(noteVal)) existingTokens.push(noteVal);
            newNote = existingTokens.join(', ');
          }
          const newShipped = shippedVal ? parseFlexibleDate(shippedVal) : existing.shipped_date;

          if (newNote !== existing.item_note_raw) {
            await db.query(
              `INSERT INTO sync_audit_log (id, import_log_id, record_table, record_id, field_name, old_value, new_value) VALUES ($1,$2,'market_orders',$3,'item_note_raw',$4,$5)`,
              [crypto.randomUUID(), importLogId, existing.id, existing.item_note_raw || '', newNote]
            );
          }
          await db.query('UPDATE market_orders SET item_note_raw = $1, shipped_date = $2 WHERE id = $3', [newNote, newShipped, existing.id]);
          await rebuildMatchesForMarketOrder(existing.id);

          await db.query(
            `INSERT INTO import_log_rows (id, import_log_id, row_number, row_status, raw_row_data, created_record_id) VALUES ($1,$2,$3,'success',$4,$5)`,
            [crypto.randomUUID(), importLogId, rowNumber, JSON.stringify(rawRow), existing.id]
          );
          successCount++;

        } else if (import_type === 'supplier_orders') {
          const supplier_order_id = String(applyMapping(rawRow, mapping, 'supplier_order_id') || '').trim();
          const source_vendor = String(applyMapping(rawRow, mapping, 'source_vendor') || '').trim();
          const order_date_raw = applyMapping(rawRow, mapping, 'supplier_order_date');
          const supplier_order_date = parseFlexibleDate(order_date_raw);
          const supplier_order_total_raw = applyMapping(rawRow, mapping, 'supplier_order_total');

          if (!supplier_order_id) throw new Error('supplier_order_id is missing or blank');
          if (!source_vendor) throw new Error('source_vendor is missing or blank');
          if (!supplier_order_date) throw new Error(`supplier_order_date could not be parsed from value "${order_date_raw}"`);
          if (supplier_order_total_raw === '' || supplier_order_total_raw === undefined) throw new Error('supplier_order_total is missing or blank');

          const fields = {
            supplier_store_name: applyMapping(rawRow, mapping, 'supplier_store_name') || null,
            match_key: applyMapping(rawRow, mapping, 'match_key') || null,
            supplier_order_status: applyMapping(rawRow, mapping, 'supplier_order_status') || null,
            item_title: applyMapping(rawRow, mapping, 'item_title') || null,
            order_qty: parseInt(applyMapping(rawRow, mapping, 'order_qty')) || 1,
            unit_price: toNum(applyMapping(rawRow, mapping, 'unit_price')),
            shipping_cost: toNum(applyMapping(rawRow, mapping, 'shipping_cost')),
            price_adjustment: toNum(applyMapping(rawRow, mapping, 'price_adjustment')),
            discount_total: toNum(applyMapping(rawRow, mapping, 'discount_total')),
            other_total: toNum(applyMapping(rawRow, mapping, 'other_total')),
            tax_total: toNum(applyMapping(rawRow, mapping, 'tax_total')),
            supplier_order_total: toNum(supplier_order_total_raw),
            payment_method: applyMapping(rawRow, mapping, 'payment_method') || null,
            tracking_number: applyMapping(rawRow, mapping, 'tracking_number') || null,
            tracking_carrier: applyMapping(rawRow, mapping, 'tracking_carrier') || null,
            buyer_name: applyMapping(rawRow, mapping, 'buyer_name') || null,
            ship_state: applyMapping(rawRow, mapping, 'ship_state') || null,
            supplier_refund_status: applyMapping(rawRow, mapping, 'supplier_refund_status') || null,
            refunded_amount: toNum(applyMapping(rawRow, mapping, 'refunded_amount')),
            date_refunded: parseFlexibleDate(applyMapping(rawRow, mapping, 'date_refunded')),
            supplier_notes: applyMapping(rawRow, mapping, 'supplier_notes') || null
          };
          const derived = computeSupplierOrderDerived(fields);

          const { rows: existRows } = await db.query(
            'SELECT * FROM supplier_orders WHERE store_id = $1 AND source_vendor = $2 AND supplier_order_id = $3',
            [store_id, source_vendor, supplier_order_id]
          );
          let recordId;
          if (existRows.length > 0) {
            recordId = existRows[0].id;
            for (const [fname, fval] of Object.entries(fields)) {
              if (String(existRows[0][fname] ?? '') !== String(fval ?? '')) {
                await db.query(
                  `INSERT INTO sync_audit_log (id, import_log_id, record_table, record_id, field_name, old_value, new_value) VALUES ($1,$2,'supplier_orders',$3,$4,$5,$6)`,
                  [crypto.randomUUID(), importLogId, recordId, fname, String(existRows[0][fname] ?? ''), String(fval ?? '')]
                );
              }
            }
            await db.query(
              `UPDATE supplier_orders SET supplier_store_name=$1, match_key=$2, supplier_order_date=$3, supplier_order_status=$4,
                item_title=$5, order_qty=$6, unit_price=$7, shipping_cost=$8, price_adjustment=$9, discount_total=$10,
                other_total=$11, tax_total=$12, supplier_order_total=$13, payment_method=$14, tracking_number=$15,
                tracking_carrier=$16, buyer_name=$17, ship_state=$18, supplier_refund_status=$19, refunded_amount=$20,
                date_refunded=$21, supplier_notes=$22, total_cost=$23, order_status=$24 WHERE id=$25`,
              [fields.supplier_store_name, fields.match_key, supplier_order_date, fields.supplier_order_status,
               fields.item_title, fields.order_qty, fields.unit_price, fields.shipping_cost, fields.price_adjustment,
               fields.discount_total, fields.other_total, fields.tax_total, fields.supplier_order_total,
               fields.payment_method, fields.tracking_number, fields.tracking_carrier, fields.buyer_name,
               fields.ship_state, fields.supplier_refund_status, fields.refunded_amount, fields.date_refunded,
               fields.supplier_notes, derived.total_cost, derived.order_status, recordId]
            );
          } else {
            recordId = crypto.randomUUID();
            await db.query(
              `INSERT INTO supplier_orders (id, store_id, source_vendor, supplier_store_name, supplier_order_id, match_key,
                supplier_order_date, supplier_order_status, item_title, order_qty, unit_price, shipping_cost, price_adjustment,
                discount_total, other_total, tax_total, supplier_order_total, payment_method, tracking_number, tracking_carrier,
                buyer_name, ship_state, supplier_refund_status, refunded_amount, date_refunded, supplier_notes, total_cost, order_status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
              [recordId, store_id, source_vendor, fields.supplier_store_name, supplier_order_id, fields.match_key,
               supplier_order_date, fields.supplier_order_status, fields.item_title, fields.order_qty, fields.unit_price,
               fields.shipping_cost, fields.price_adjustment, fields.discount_total, fields.other_total, fields.tax_total,
               fields.supplier_order_total, fields.payment_method, fields.tracking_number, fields.tracking_carrier,
               fields.buyer_name, fields.ship_state, fields.supplier_refund_status, fields.refunded_amount,
               fields.date_refunded, fields.supplier_notes, derived.total_cost, derived.order_status]
            );
          }
          await rebuildMatchesForSupplierOrder(recordId);
          await db.query(
            `INSERT INTO import_log_rows (id, import_log_id, row_number, row_status, raw_row_data, created_record_id) VALUES ($1,$2,$3,'success',$4,$5)`,
            [crypto.randomUUID(), importLogId, rowNumber, JSON.stringify(rawRow), recordId]
          );
          successCount++;

        } else if (import_type === 'transactions') {
          const transaction_date = parseFlexibleDate(applyMapping(rawRow, mapping, 'transaction_date'));
          const transaction_type = String(applyMapping(rawRow, mapping, 'transaction_type') || '').trim();
          if (!transaction_date) throw new Error('transaction_date is missing or could not be parsed');
          if (!transaction_type) throw new Error('transaction_type is missing or blank');

          const fields = {
            market_order_id: applyMapping(rawRow, mapping, 'market_order_id') || null,
            net_amount: applyMapping(rawRow, mapping, 'net_amount') !== '' ? toNum(applyMapping(rawRow, mapping, 'net_amount')) : null,
            gross_transaction_amount: applyMapping(rawRow, mapping, 'gross_transaction_amount') !== '' ? toNum(applyMapping(rawRow, mapping, 'gross_transaction_amount')) : null,
            payout_batch_id: applyMapping(rawRow, mapping, 'payout_batch_id') || null,
            payout_date: parseFlexibleDate(applyMapping(rawRow, mapping, 'payout_date')),
            payout_status: applyMapping(rawRow, mapping, 'payout_status') || null,
            item_title: applyMapping(rawRow, mapping, 'item_title') || null,
            description: applyMapping(rawRow, mapping, 'description') || null
          };
          const row_hash = computeRowHash({ store_id, transaction_date, transaction_type, ...fields });

          const { rows: dupRows } = await db.query('SELECT id FROM transactions WHERE store_id = $1 AND row_hash = $2', [store_id, row_hash]);
          if (dupRows.length > 0) {
            await db.query(
              `INSERT INTO import_log_rows (id, import_log_id, row_number, row_status, raw_row_data) VALUES ($1,$2,$3,'skipped_duplicate',$4)`,
              [crypto.randomUUID(), importLogId, rowNumber, JSON.stringify(rawRow)]
            );
            skippedCount++;
          } else {
            const recordId = crypto.randomUUID();
            await db.query(
              `INSERT INTO transactions (id, store_id, transaction_date, transaction_type, market_order_id, net_amount,
                gross_transaction_amount, payout_batch_id, payout_date, payout_status, item_title, description, row_hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [recordId, store_id, transaction_date, transaction_type, fields.market_order_id, fields.net_amount,
               fields.gross_transaction_amount, fields.payout_batch_id, fields.payout_date, fields.payout_status,
               fields.item_title, fields.description, row_hash]
            );
            await db.query(
              `INSERT INTO import_log_rows (id, import_log_id, row_number, row_status, raw_row_data, created_record_id) VALUES ($1,$2,$3,'success',$4,$5)`,
              [crypto.randomUUID(), importLogId, rowNumber, JSON.stringify(rawRow), recordId]
            );
            successCount++;
          }
        }
      } catch (rowErr) {
        failedCount++;
        await db.query(
          `INSERT INTO import_log_rows (id, import_log_id, row_number, row_status, raw_row_data, error_reason) VALUES ($1,$2,$3,'failed',$4,$5)`,
          [crypto.randomUUID(), importLogId, rowNumber, JSON.stringify(rawRow), rowErr.message]
        );
      }
    }

    const finalStatus = failedCount === 0 ? 'completed' : (successCount > 0 || skippedCount > 0 ? 'completed_with_errors' : 'failed');
    await db.query(
      `UPDATE import_logs SET success_rows=$1, failed_rows=$2, skipped_rows=$3, status=$4, completed_at=CURRENT_TIMESTAMP WHERE id=$5`,
      [successCount, failedCount, skippedCount, finalStatus, importLogId]
    );

    res.status(201).json({ import_log_id: importLogId, total_rows: objects.length, success_rows: successCount, failed_rows: failedCount, skipped_rows: skippedCount, status: finalStatus });
  } catch (err) {
    console.error('Import commit error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/import-center/logs', requireAuth, enforcePermission('import_center', 'view'), async (req, res) => {
  try {
    const { store_id } = req.query;
    const params = store_id ? [store_id] : [];
    const where = store_id ? 'WHERE store_id = $1' : '';
    const { rows } = await db.query(`SELECT * FROM import_logs ${where} ORDER BY started_at DESC`, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/import-center/logs/:id', requireAuth, enforcePermission('import_center', 'view'), async (req, res) => {
  try {
    const { rows: logRows } = await db.query('SELECT * FROM import_logs WHERE id = $1', [req.params.id]);
    if (logRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const { rows: rowRows } = await db.query('SELECT * FROM import_log_rows WHERE import_log_id = $1 ORDER BY row_number', [req.params.id]);
    res.json({ log: logRows[0], rows: rowRows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/import-center/logs/:logId/rows/:rowId/retry', requireAuth, enforcePermission('import_center', 'edit'), async (req, res) => {
  const { logId, rowId } = req.params;
  const { corrected_data } = req.body;
  try {
    const { rows: logRows } = await db.query('SELECT * FROM import_logs WHERE id = $1', [logId]);
    if (logRows.length === 0) return res.status(404).json({ error: 'Import log not found' });
    const log = logRows[0];
    const { rows: importRowRows } = await db.query('SELECT * FROM import_log_rows WHERE id = $1', [rowId]);
    if (importRowRows.length === 0) return res.status(404).json({ error: 'Import row not found' });

    let recordId;
    if (log.import_type === 'market_orders' && log.market_order_source === 'earnings') {
      if (!corrected_data.market_order_id || !corrected_data.order_date) {
        throw new Error('market_order_id and order_date are required');
      }
      const order_date = parseFlexibleDate(corrected_data.order_date);
      if (!order_date) throw new Error('order_date could not be parsed');
      const derived = computeMarketOrderDerived(corrected_data);
      const { rows: existRows } = await db.query('SELECT * FROM market_orders WHERE store_id = $1 AND market_order_id = $2', [log.store_id, corrected_data.market_order_id]);
      if (existRows.length > 0) {
        recordId = existRows[0].id;
        await db.query(
          `UPDATE market_orders SET order_date=$1, item_title=$2, buyer_name=$3, buyer_state=$4, gross_amount=$5,
            platform_fee=$6, ads_fee=$7, shipping_fee_cost=$8, total_expense=$9, other_fee=$10, refund_amount=$11,
            net_earnings=$12, order_status=$13 WHERE id=$14`,
          [order_date, corrected_data.item_title || null, corrected_data.buyer_name || null, corrected_data.buyer_state || null,
           toNum(corrected_data.gross_amount), toNum(corrected_data.platform_fee), toNum(corrected_data.ads_fee),
           toNum(corrected_data.shipping_fee_cost), toNum(corrected_data.total_expense), derived.other_fee,
           toNum(corrected_data.refund_amount), toNum(corrected_data.net_earnings), derived.order_status, recordId]
        );
      } else {
        recordId = crypto.randomUUID();
        await db.query(
          `INSERT INTO market_orders (id, store_id, market_order_id, order_date, item_title, buyer_name, buyer_state,
            gross_amount, platform_fee, ads_fee, shipping_fee_cost, total_expense, other_fee, refund_amount, net_earnings, order_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [recordId, log.store_id, corrected_data.market_order_id, order_date, corrected_data.item_title || null,
           corrected_data.buyer_name || null, corrected_data.buyer_state || null, toNum(corrected_data.gross_amount),
           toNum(corrected_data.platform_fee), toNum(corrected_data.ads_fee), toNum(corrected_data.shipping_fee_cost),
           toNum(corrected_data.total_expense), derived.other_fee, toNum(corrected_data.refund_amount),
           toNum(corrected_data.net_earnings), derived.order_status]
        );
      }
      await rebuildMatchesForMarketOrder(recordId);
    } else if (log.import_type === 'supplier_orders') {
      if (!corrected_data.supplier_order_id || !corrected_data.source_vendor || !corrected_data.supplier_order_date || corrected_data.supplier_order_total === undefined) {
        throw new Error('supplier_order_id, source_vendor, supplier_order_date, and supplier_order_total are required');
      }
      const supplier_order_date = parseFlexibleDate(corrected_data.supplier_order_date);
      if (!supplier_order_date) throw new Error('supplier_order_date could not be parsed');
      const derived = computeSupplierOrderDerived(corrected_data);
      const { rows: existRows } = await db.query(
        'SELECT * FROM supplier_orders WHERE store_id = $1 AND source_vendor = $2 AND supplier_order_id = $3',
        [log.store_id, corrected_data.source_vendor, corrected_data.supplier_order_id]
      );
      if (existRows.length > 0) {
        recordId = existRows[0].id;
        await db.query('UPDATE supplier_orders SET supplier_order_date=$1, supplier_order_total=$2, total_cost=$3, order_status=$4 WHERE id=$5',
          [supplier_order_date, toNum(corrected_data.supplier_order_total), derived.total_cost, derived.order_status, recordId]);
      } else {
        recordId = crypto.randomUUID();
        await db.query(
          `INSERT INTO supplier_orders (id, store_id, source_vendor, supplier_order_id, supplier_order_date, supplier_order_total, total_cost, order_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [recordId, log.store_id, corrected_data.source_vendor, corrected_data.supplier_order_id, supplier_order_date,
           toNum(corrected_data.supplier_order_total), derived.total_cost, derived.order_status]
        );
      }
      await rebuildMatchesForSupplierOrder(recordId);
    } else if (log.import_type === 'transactions') {
      const transaction_date = parseFlexibleDate(corrected_data.transaction_date);
      if (!transaction_date || !corrected_data.transaction_type) throw new Error('transaction_date and transaction_type are required');
      recordId = crypto.randomUUID();
      const row_hash = computeRowHash({ store_id: log.store_id, transaction_date, transaction_type: corrected_data.transaction_type });
      await db.query(
        `INSERT INTO transactions (id, store_id, transaction_date, transaction_type, row_hash) VALUES ($1,$2,$3,$4,$5)`,
        [recordId, log.store_id, transaction_date, corrected_data.transaction_type, row_hash]
      );
    }

    await db.query(`UPDATE import_log_rows SET row_status = 'success', error_reason = NULL, created_record_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [recordId, rowId]);
    const { rows: countRows } = await db.query(`SELECT row_status, COUNT(*) as c FROM import_log_rows WHERE import_log_id = $1 GROUP BY row_status`, [logId]);
    let success_rows = 0, failed_rows = 0, skipped_rows = 0;
    for (const c of countRows) {
      if (c.row_status === 'success') success_rows = parseInt(c.c);
      if (c.row_status === 'failed') failed_rows = parseInt(c.c);
      if (c.row_status === 'skipped_duplicate') skipped_rows = parseInt(c.c);
    }
    await db.query(`UPDATE import_logs SET success_rows=$1, failed_rows=$2, skipped_rows=$3, status=$4 WHERE id=$5`,
      [success_rows, failed_rows, skipped_rows, failed_rows === 0 ? 'completed' : 'completed_with_errors', logId]);

    res.json({ success: true, record_id: recordId });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Retry failed' });
  }
});

app.get('/api/import-center/logs/:id/export-failed', requireAuth, enforcePermission('import_center', 'view'), async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM import_log_rows WHERE import_log_id = $1 AND row_status = 'failed' ORDER BY row_number`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'No failed rows for this import' });

    const parsed = rows.map(r => typeof r.raw_row_data === 'string' ? JSON.parse(r.raw_row_data) : r.raw_row_data);
    const headers = Object.keys(parsed[0] || {});
    let csv = headers.map(escapeCsvCell).join(',') + '\n';
    for (const p of parsed) {
      csv += headers.map(h => escapeCsvCell(p[h])).join(',') + '\n';
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="failed_rows_${req.params.id}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// Module 9: Reporting
// ============================================================

async function getExcludedDisputeLabels() {
  const { rows } = await db.query(`SELECT option_label FROM custom_field_options WHERE field_key = 'dispute_status' AND excludes_from_calculations = true`);
  return rows.map(r => r.option_label);
}

async function getMatchedSupplierOrderIds(marketOrderIds) {
  if (marketOrderIds.length === 0) return [];
  const placeholders = marketOrderIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT DISTINCT supplier_order_id FROM order_matches WHERE match_status = 'matched' AND supplier_order_id IS NOT NULL AND market_order_id IN (${placeholders})`,
    marketOrderIds
  );
  return rows.map(r => r.supplier_order_id);
}

app.get('/api/reporting/monthly-pnl', requireAuth, enforcePermission('reporting', 'view'), async (req, res) => {
  try {
    const { store_id, year, include_disputed, exclude_missing_cogs } = req.query;
    const access = await getAccessibleResources(req.user);
    const includeDisputed = include_disputed === 'true';
    const excludeMissingCogs = exclude_missing_cogs === 'true';

    let storeIds;
    if (store_id) storeIds = [store_id];
    else if (req.user.role === 'admin') { const { rows } = await db.query('SELECT id FROM stores'); storeIds = rows.map(r => r.id); }
    else storeIds = access.storeIds;

    if (storeIds.length === 0) return res.json({ months: [], excluded_count: 0, missing_cogs_count: 0 });

    const excludedLabels = await getExcludedDisputeLabels();
    const yr = year || new Date().getFullYear();
    const placeholders = storeIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: marketOrders } = await db.query(
      `SELECT * FROM market_orders WHERE store_id IN (${placeholders}) AND order_date >= $${storeIds.length + 1} AND order_date < $${storeIds.length + 2}`,
      [...storeIds, `${yr}-01-01`, `${parseInt(yr) + 1}-01-01`]
    );
    const moById = {};
    for (const mo of marketOrders) moById[mo.id] = mo;

    const months = {};
    let excludedCount = 0;
    let missingCogsCount = 0;

    for (const mo of marketOrders) {
      const monthKey = String(mo.order_date).slice(0, 7);
      if (!months[monthKey]) {
        months[monthKey] = { month: monthKey, gross_revenue: 0, platform_fees: 0, ads_fees: 0, shipping_cost: 0,
          other_fees: 0, refunds: 0, platform_net_earnings: 0, cogs: 0, other_income: 0, other_expenses: 0,
          included_order_ids: [] };
      }

      const isDisputed = mo.dispute_status && excludedLabels.includes(mo.dispute_status);
      if (isDisputed && !includeDisputed) { excludedCount++; continue; }

      const m = months[monthKey];
      m.gross_revenue += toNum(mo.gross_amount);
      m.platform_fees += toNum(mo.platform_fee);
      m.ads_fees += toNum(mo.ads_fee);
      m.shipping_cost += toNum(mo.shipping_fee_cost);
      m.other_fees += toNum(mo.other_fee);
      m.refunds += toNum(mo.refund_amount);
      m.platform_net_earnings += toNum(mo.net_earnings);
      m.included_order_ids.push(mo.id);
    }

    for (const monthKey of Object.keys(months)) {
      const m = months[monthKey];
      const supplierIds = await getMatchedSupplierOrderIds(m.included_order_ids);
      if (supplierIds.length > 0) {
        const sPlaceholders = supplierIds.map((_, i) => `$${i + 1}`).join(',');
        const { rows: supplierRows } = await db.query(`SELECT id, total_cost, dispute_status FROM supplier_orders WHERE id IN (${sPlaceholders})`, supplierIds);
        for (const so of supplierRows) {
          const soDisputed = so.dispute_status && excludedLabels.includes(so.dispute_status);
          if (soDisputed && !includeDisputed) continue;
          m.cogs += toNum(so.total_cost);
        }
      }

      // Which of this month's orders have NO matched supplier order at all (COGS missing)?
      if (m.included_order_ids.length > 0) {
        const idPlaceholders = m.included_order_ids.map((_, i) => `$${i + 1}`).join(',');
        const { rows: matchedOrderIdRows } = await db.query(
          `SELECT DISTINCT market_order_id FROM order_matches WHERE match_status = 'matched' AND market_order_id IN (${idPlaceholders})`,
          m.included_order_ids
        );
        const matchedOrderIdSet = new Set(matchedOrderIdRows.map(r => r.market_order_id));
        const missingCogsIds = m.included_order_ids.filter(id => !matchedOrderIdSet.has(id));
        missingCogsCount += missingCogsIds.length;

        if (excludeMissingCogs) {
          for (const missingId of missingCogsIds) {
            const missingMo = moById[missingId];
            if (!missingMo) continue;
            m.gross_revenue -= toNum(missingMo.gross_amount);
            m.platform_fees -= toNum(missingMo.platform_fee);
            m.ads_fees -= toNum(missingMo.ads_fee);
            m.shipping_cost -= toNum(missingMo.shipping_fee_cost);
            m.other_fees -= toNum(missingMo.other_fee);
            m.refunds -= toNum(missingMo.refund_amount);
            m.platform_net_earnings -= toNum(missingMo.net_earnings);
          }
        }
      }

      const { rows: expenseRows } = await db.query(
        `SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE store_id IN (${placeholders}) AND expense_date >= $${storeIds.length + 1} AND expense_date < $${storeIds.length + 2}`,
        [...storeIds, `${monthKey}-01`, monthKey === `${yr}-12` ? `${parseInt(yr) + 1}-01-01` : `${monthKey.slice(0,4)}-${String(parseInt(monthKey.slice(5,7))+1).padStart(2,'0')}-01`]
      );
      const { rows: incomeRows } = await db.query(
        `SELECT COALESCE(SUM(amount),0) as total FROM income WHERE store_id IN (${placeholders}) AND income_date >= $${storeIds.length + 1} AND income_date < $${storeIds.length + 2}`,
        [...storeIds, `${monthKey}-01`, monthKey === `${yr}-12` ? `${parseInt(yr) + 1}-01-01` : `${monthKey.slice(0,4)}-${String(parseInt(monthKey.slice(5,7))+1).padStart(2,'0')}-01`]
      );
      m.other_expenses = toNum(expenseRows[0].total);
      m.other_income = toNum(incomeRows[0].total);
      m.net_profit = m.platform_net_earnings - m.cogs;
      m.adjusted_net_profit = m.net_profit + m.other_income - m.other_expenses;
      delete m.included_order_ids;
    }

    res.json({
      months: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)),
      excluded_count: excludedCount,
      include_disputed: includeDisputed,
      missing_cogs_count: missingCogsCount,
      exclude_missing_cogs: excludeMissingCogs
    });
  } catch (err) {
    console.error('Reporting P&L error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/reporting/monthly-store-statement', requireAuth, enforcePermission('reporting', 'view'), async (req, res) => {
  try {
    const { store_id, month, include_disputed, exclude_missing_cogs } = req.query;
    if (!store_id || !month) return res.status(400).json({ error: 'store_id and month are required' });
    const includeDisputed = include_disputed === 'true';
    const excludeMissingCogs = exclude_missing_cogs === 'true';
    const excludedLabels = await getExcludedDisputeLabels();

    const { rows: marketOrders } = await db.query(
      `SELECT * FROM market_orders WHERE store_id = $1 AND order_date >= $2 AND order_date < $3 ORDER BY order_date`,
      [store_id, `${month}-01`, `${month.slice(0,4)}-${String(parseInt(month.slice(5,7))+1).padStart(2,'0')}-01`]
    );

    const result = [];
    let totals = { total_orders: 0, total_price: 0, total_earnings: 0, total_cogs: 0, total_net_profit: 0 };
    let missingCogsCount = 0;

    for (const mo of marketOrders) {
      const moDisputed = mo.dispute_status && excludedLabels.includes(mo.dispute_status);

      const { rows: matches } = await db.query(
        `SELECT DISTINCT so.id, so.total_cost, so.dispute_status FROM order_matches om
         JOIN supplier_orders so ON om.supplier_order_id = so.id
         WHERE om.market_order_id = $1 AND om.match_status = 'matched'`,
        [mo.id]
      );

      const cogsMissing = matches.length === 0;
      if (cogsMissing) missingCogsCount++;
      if (cogsMissing && excludeMissingCogs) continue;

      let cogs = 0;
      let anyDisputed = moDisputed;
      for (const so of matches) {
        const soDisputed = so.dispute_status && excludedLabels.includes(so.dispute_status);
        if (soDisputed) anyDisputed = true;
        cogs += toNum(so.total_cost);
      }

      if (anyDisputed && !includeDisputed) continue;

      const netProfit = toNum(mo.net_earnings) - cogs;
      result.push({
        id: mo.id, order_date: mo.order_date, market_order_id: mo.market_order_id, item_title: mo.item_title,
        total_price: toNum(mo.gross_amount), order_earnings: toNum(mo.net_earnings), cogs,
        order_status: mo.order_status, dispute_status: mo.dispute_status, net_profit: netProfit, comments: mo.comments,
        cogs_missing: cogsMissing
      });

      totals.total_orders++;
      totals.total_price += toNum(mo.gross_amount);
      totals.total_earnings += toNum(mo.net_earnings);
      totals.total_cogs += cogs;
      totals.total_net_profit += netProfit;
    }

    totals.gross_margin = totals.total_price > 0 ? (totals.total_net_profit / totals.total_price) * 100 : 0;
    totals.net_margin = totals.total_earnings > 0 ? (totals.total_net_profit / totals.total_earnings) * 100 : 0;

    res.json({ rows: result, totals, include_disputed: includeDisputed, missing_cogs_count: missingCogsCount, exclude_missing_cogs: excludeMissingCogs });
  } catch (err) {
    console.error('Reporting store statement error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Dashboard — creative-latitude summary view (Section 12.3): reads existing tables live, stores nothing.
app.get('/api/reporting/dashboard', requireAuth, enforcePermission('reporting', 'view'), async (req, res) => {
  try {
    const { store_id, business_id } = req.query;
    const access = await getAccessibleResources(req.user);

    let storeIds;
    if (store_id) {
      storeIds = [store_id];
    } else if (business_id) {
      // Scope to just the stores under this business that the user is actually allowed to see —
      // never trust business_id alone, still intersect with their accessible store list.
      const { rows } = await db.query('SELECT id FROM stores WHERE business_id = $1', [business_id]);
      const businessStoreIds = rows.map(r => r.id);
      storeIds = req.user.role === 'admin' ? businessStoreIds : businessStoreIds.filter(id => access.storeIds.includes(id));
    } else if (req.user.role === 'admin') {
      const { rows } = await db.query('SELECT id FROM stores'); storeIds = rows.map(r => r.id);
    } else {
      storeIds = access.storeIds;
    }

    if (storeIds.length === 0) {
      return res.json({
        year_totals: { gross_revenue: 0, adjusted_net_profit: 0, other_expenses: 0, total_orders: 0 },
        trend: [], stores: [], top_items: [], recent_imports: [], unmatched_count: 0,
        hold_amount: 0, hold_order_count: 0
      });
    }

    const excludedLabels = await getExcludedDisputeLabels();
    const placeholders = storeIds.map((_, i) => `$${i + 1}`).join(',');

    const now = new Date();
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const trendStartStr = trendStart.toISOString().slice(0, 10);
    const currentYearStart = `${now.getFullYear()}-01-01`;

    const { rows: marketOrders } = await db.query(
      `SELECT * FROM market_orders WHERE store_id IN (${placeholders}) AND order_date >= $${storeIds.length + 1}`,
      [...storeIds, trendStartStr]
    );

    // Trailing 12 month buckets (for the trend chart)
    const monthBuckets = {};
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      const key = d.toISOString().slice(0, 7);
      monthBuckets[key] = { month: key, gross_revenue: 0, cogs: 0, platform_net_earnings: 0, other_expenses: 0, other_income: 0, order_count: 0, included_order_ids: [] };
    }

    // Per-store buckets (current calendar year, for the store breakdown cards)
    const storeBuckets = {};
    for (const sid of storeIds) storeBuckets[sid] = { store_id: sid, gross_revenue: 0, cogs: 0, platform_net_earnings: 0, other_expenses: 0, other_income: 0, order_count: 0, included_order_ids: [] };

    const itemCounts = {};
    let holdAmount = 0;
    let holdOrderCount = 0;

    for (const mo of marketOrders) {
      const isDisputed = mo.dispute_status && excludedLabels.includes(mo.dispute_status);
      if (isDisputed) {
        holdAmount += toNum(mo.net_earnings);
        holdOrderCount++;
        continue;
      }

      const monthKey = String(mo.order_date).slice(0, 7);
      if (monthBuckets[monthKey]) {
        const b = monthBuckets[monthKey];
        b.gross_revenue += toNum(mo.gross_amount);
        b.platform_net_earnings += toNum(mo.net_earnings);
        b.order_count++;
        b.included_order_ids.push(mo.id);
      }

      if (String(mo.order_date) >= currentYearStart && storeBuckets[mo.store_id]) {
        const sb = storeBuckets[mo.store_id];
        sb.gross_revenue += toNum(mo.gross_amount);
        sb.platform_net_earnings += toNum(mo.net_earnings);
        sb.order_count++;
        sb.included_order_ids.push(mo.id);

        if (mo.item_title) {
          if (!itemCounts[mo.item_title]) itemCounts[mo.item_title] = { item_title: mo.item_title, order_count: 0, total_gross: 0 };
          itemCounts[mo.item_title].order_count++;
          itemCounts[mo.item_title].total_gross += toNum(mo.gross_amount);
        }
      }
    }

    // Fill in COGS + expenses/income for each trend month bucket
    for (const key of Object.keys(monthBuckets)) {
      const b = monthBuckets[key];
      const supplierIds = await getMatchedSupplierOrderIds(b.included_order_ids);
      if (supplierIds.length > 0) {
        const sp = supplierIds.map((_, i) => `$${i + 1}`).join(',');
        const { rows: supplierRows } = await db.query(`SELECT total_cost, dispute_status FROM supplier_orders WHERE id IN (${sp})`, supplierIds);
        for (const so of supplierRows) {
          if (so.dispute_status && excludedLabels.includes(so.dispute_status)) continue;
          b.cogs += toNum(so.total_cost);
        }
      }
      const { rows: expenseRows } = await db.query(
        `SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE store_id IN (${placeholders}) AND expense_date >= $${storeIds.length + 1} AND expense_date < $${storeIds.length + 2}`,
        [...storeIds, `${key}-01`, nextMonthStart(key)]
      );
      const { rows: incomeRows } = await db.query(
        `SELECT COALESCE(SUM(amount),0) as total FROM income WHERE store_id IN (${placeholders}) AND income_date >= $${storeIds.length + 1} AND income_date < $${storeIds.length + 2}`,
        [...storeIds, `${key}-01`, nextMonthStart(key)]
      );
      b.other_expenses = toNum(expenseRows[0].total);
      b.other_income = toNum(incomeRows[0].total);
      b.net_profit = b.platform_net_earnings - b.cogs;
      b.adjusted_net_profit = b.net_profit + b.other_income - b.other_expenses;
      delete b.included_order_ids;
    }

    // Fill in COGS + expenses/income for each store bucket (current year)
    const { rows: storeRows } = await db.query(`SELECT id, name FROM stores WHERE id IN (${placeholders})`, storeIds);
    const storeNames = {};
    for (const s of storeRows) storeNames[s.id] = s.name;

    for (const sid of Object.keys(storeBuckets)) {
      const sb = storeBuckets[sid];
      const supplierIds = await getMatchedSupplierOrderIds(sb.included_order_ids);
      if (supplierIds.length > 0) {
        const sp = supplierIds.map((_, i) => `$${i + 1}`).join(',');
        const { rows: supplierRows } = await db.query(`SELECT total_cost, dispute_status FROM supplier_orders WHERE id IN (${sp})`, supplierIds);
        for (const so of supplierRows) {
          if (so.dispute_status && excludedLabels.includes(so.dispute_status)) continue;
          sb.cogs += toNum(so.total_cost);
        }
      }
      const { rows: expenseRows } = await db.query(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE store_id = $1 AND expense_date >= $2`, [sid, currentYearStart]);
      const { rows: incomeRows } = await db.query(`SELECT COALESCE(SUM(amount),0) as total FROM income WHERE store_id = $1 AND income_date >= $2`, [sid, currentYearStart]);
      sb.other_expenses = toNum(expenseRows[0].total);
      sb.other_income = toNum(incomeRows[0].total);
      sb.net_profit = sb.platform_net_earnings - sb.cogs;
      sb.adjusted_net_profit = sb.net_profit + sb.other_income - sb.other_expenses;
      sb.store_name = storeNames[sid] || 'Unknown';
      delete sb.included_order_ids;
    }

    // ---- Per-store, per-month breakdown (trailing 12 months) ----
    // Powers: the hover tooltip and click-to-drill-down on the trend chart, and a small
    // per-store sparkline on each store's breakdown card. Reuses the same market order rows
    // already fetched above; only expenses/income need a fresh (batched, not per-month) fetch.
    const storeMonthBuckets = {};
    for (const sid of storeIds) {
      storeMonthBuckets[sid] = {};
      for (let i = 0; i < 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
        const key = d.toISOString().slice(0, 7);
        storeMonthBuckets[sid][key] = { month: key, gross_revenue: 0, cogs: 0, platform_net_earnings: 0, other_expenses: 0, other_income: 0, order_count: 0, included_order_ids: [] };
      }
    }

    for (const mo of marketOrders) {
      const isDisputed = mo.dispute_status && excludedLabels.includes(mo.dispute_status);
      if (isDisputed) continue;
      const monthKey = String(mo.order_date).slice(0, 7);
      const smb = storeMonthBuckets[mo.store_id];
      if (smb && smb[monthKey]) {
        const b = smb[monthKey];
        b.gross_revenue += toNum(mo.gross_amount);
        b.platform_net_earnings += toNum(mo.net_earnings);
        b.order_count++;
        b.included_order_ids.push(mo.id);
      }
    }

    const { rows: allExpensesTrend } = await db.query(
      `SELECT store_id, expense_date, amount FROM expenses WHERE store_id IN (${placeholders}) AND expense_date >= $${storeIds.length + 1}`,
      [...storeIds, trendStartStr]
    );
    const { rows: allIncomeTrend } = await db.query(
      `SELECT store_id, income_date, amount FROM income WHERE store_id IN (${placeholders}) AND income_date >= $${storeIds.length + 1}`,
      [...storeIds, trendStartStr]
    );
    for (const e of allExpensesTrend) {
      const key = String(e.expense_date).slice(0, 7);
      const smb = storeMonthBuckets[e.store_id];
      if (smb && smb[key]) smb[key].other_expenses += toNum(e.amount);
    }
    for (const inc of allIncomeTrend) {
      const key = String(inc.income_date).slice(0, 7);
      const smb = storeMonthBuckets[inc.store_id];
      if (smb && smb[key]) smb[key].other_income += toNum(inc.amount);
    }

    for (const sid of Object.keys(storeMonthBuckets)) {
      for (const key of Object.keys(storeMonthBuckets[sid])) {
        const b = storeMonthBuckets[sid][key];
        const supplierIds = await getMatchedSupplierOrderIds(b.included_order_ids);
        if (supplierIds.length > 0) {
          const sp = supplierIds.map((_, i) => `$${i + 1}`).join(',');
          const { rows: supplierRows } = await db.query(`SELECT total_cost, dispute_status FROM supplier_orders WHERE id IN (${sp})`, supplierIds);
          for (const so of supplierRows) {
            if (so.dispute_status && excludedLabels.includes(so.dispute_status)) continue;
            b.cogs += toNum(so.total_cost);
          }
        }
        b.net_profit = b.platform_net_earnings - b.cogs;
        b.adjusted_net_profit = b.net_profit + b.other_income - b.other_expenses;
        delete b.included_order_ids;
      }
    }

    const yearTotals = { gross_revenue: 0, adjusted_net_profit: 0, other_expenses: 0, total_orders: 0 };
    for (const sid of Object.keys(storeBuckets)) {
      const sb = storeBuckets[sid];
      yearTotals.gross_revenue += sb.gross_revenue;
      yearTotals.adjusted_net_profit += sb.adjusted_net_profit;
      yearTotals.other_expenses += sb.other_expenses;
      yearTotals.total_orders += sb.order_count;
    }

    const topItems = Object.values(itemCounts).sort((a, b) => b.order_count - a.order_count).slice(0, 5);

    const { rows: recentImports } = await db.query(
      `SELECT id, file_name, import_type, status, success_rows, failed_rows, total_rows, started_at FROM import_logs WHERE store_id IN (${placeholders}) ORDER BY started_at DESC LIMIT 5`,
      storeIds
    );

    const p1 = storeIds.map((_, i) => `$${i + 1}`).join(',');
    const p2 = storeIds.map((_, i) => `$${storeIds.length + i + 1}`).join(',');
    const { rows: unmatchedRows } = await db.query(
      `SELECT COUNT(*)::int as count FROM order_matches om
       LEFT JOIN market_orders mo ON om.market_order_id = mo.id
       LEFT JOIN supplier_orders so ON om.supplier_order_id = so.id
       WHERE om.match_status != 'matched' AND (mo.store_id IN (${p1}) OR so.store_id IN (${p2}))`,
      [...storeIds, ...storeIds]
    );

    // Attach a 12-month sparkline trend onto each store card
    const storesWithTrend = Object.values(storeBuckets)
      .sort((a, b) => b.gross_revenue - a.gross_revenue)
      .map(sb => ({
        ...sb,
        trend: Object.values(storeMonthBuckets[sb.store_id] || {}).sort((a, b) => a.month.localeCompare(b.month))
      }));

    // Attach a per-store breakdown onto each point of the global trend line (for click-to-drill-down)
    const trendWithByStore = Object.values(monthBuckets)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(m => ({
        ...m,
        by_store: storeIds.map(sid => {
          const b = (storeMonthBuckets[sid] || {})[m.month] || {};
          return {
            store_id: sid,
            store_name: storeNames[sid] || 'Unknown',
            gross_revenue: b.gross_revenue || 0,
            adjusted_net_profit: b.adjusted_net_profit || 0
          };
        })
      }));

    res.json({
      year_totals: yearTotals,
      trend: trendWithByStore,
      stores: storesWithTrend,
      top_items: topItems,
      recent_imports: recentImports,
      unmatched_count: unmatchedRows[0].count,
      hold_amount: holdAmount,
      hold_order_count: holdOrderCount
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Fallback to React Frontend in Production
const distPath = path.join(process.cwd(), 'dist');
app.use(express.static(distPath));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API route not found' });
  }

  const indexHtmlPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    res.sendFile(indexHtmlPath);
  } else {
    res.send('x360 Ecom Finance App backend is running. Build the frontend to view the UI.');
  }
});

// Start Server
db.initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`x360 Ecom Finance App server running on port ${port}`);
      bootstrapAdmin();
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
