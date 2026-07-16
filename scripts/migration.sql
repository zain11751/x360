-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Table: businesses
CREATE TABLE IF NOT EXISTS businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_businesses_updated_at ON businesses;
CREATE TRIGGER update_businesses_updated_at
BEFORE UPDATE ON businesses
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Table: stores
CREATE TABLE IF NOT EXISTS stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ebay', 'other')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_stores_updated_at ON stores;
CREATE TRIGGER update_stores_updated_at
BEFORE UPDATE ON stores
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Table: users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    auth_user_id TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'bookkeeper', 'client')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    last_login_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Safeguard: enforce at least one active admin
CREATE OR REPLACE FUNCTION check_active_admin_exists()
RETURNS TRIGGER AS $$
DECLARE
    active_admin_count INTEGER;
BEGIN
    -- Count active admin users left in the table
    SELECT COUNT(*) INTO active_admin_count
    FROM users
    WHERE role = 'admin' AND status = 'active';

    -- Enforce on delete
    IF (TG_OP = 'DELETE' AND OLD.role = 'admin' AND OLD.status = 'active') THEN
        IF active_admin_count <= 1 THEN
            RAISE EXCEPTION 'At least one active admin user must exist at all times.';
        END IF;
    -- Enforce on update
    ELSIF (TG_OP = 'UPDATE' AND OLD.role = 'admin' AND OLD.status = 'active') THEN
        IF (NEW.status != 'active' OR NEW.role != 'admin') THEN
            IF active_admin_count <= 1 THEN
                RAISE EXCEPTION 'At least one active admin user must exist at all times.';
            END IF;
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_active_admin_on_delete_or_update ON users;
CREATE TRIGGER enforce_active_admin_on_delete_or_update
BEFORE DELETE OR UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION check_active_admin_exists();

-- Table: user_business_access
CREATE TABLE IF NOT EXISTS user_business_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    access_level TEXT NOT NULL CHECK (access_level IN ('read', 'write')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, business_id)
);

-- Table: user_store_access
CREATE TABLE IF NOT EXISTS user_store_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    access_level TEXT NOT NULL CHECK (access_level IN ('read', 'write')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, store_id)
);

-- Table: user_module_permissions
CREATE TABLE IF NOT EXISTS user_module_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module_name TEXT NOT NULL CHECK (module_name IN ('market_orders', 'supplier_orders', 'order_matching', 'transactions', 'expense', 'income', 'import_center', 'reporting', 'settings')),
    can_view BOOLEAN NOT NULL DEFAULT false,
    can_edit BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (user_id, module_name)
);

-- Table: custom_field_options
CREATE TABLE IF NOT EXISTS custom_field_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    field_key TEXT NOT NULL CHECK (field_key IN ('dispute_status', 'order_tracker', 'va_team', 'review_status', 'dispute_reason')),
    option_label TEXT NOT NULL,
    excludes_from_calculations BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (field_key, option_label)
);

DROP TRIGGER IF EXISTS update_custom_field_options_updated_at ON custom_field_options;
CREATE TRIGGER update_custom_field_options_updated_at
BEFORE UPDATE ON custom_field_options
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Seed initial custom_field_options data
INSERT INTO custom_field_options (field_key, option_label, excludes_from_calculations, is_active, sort_order) VALUES
-- dispute_status
('dispute_status', 'None', false, true, 1),
('dispute_status', 'Disputed', true, true, 2),
('dispute_status', 'Resolved', false, true, 3),
-- order_tracker
('order_tracker', 'New', false, true, 1),
('order_tracker', 'In Progress', false, true, 2),
('order_tracker', 'Completed', false, true, 3),
('order_tracker', 'On Hold', false, true, 4),
-- va_team
('va_team', 'Unassigned', false, true, 1),
-- review_status
('review_status', 'Pending Review', false, true, 1),
('review_status', 'Reviewed', false, true, 2),
('review_status', 'Flagged', false, true, 3),
-- dispute_reason
('dispute_reason', 'Item Not Received', false, true, 1),
('dispute_reason', 'Item Not As Described', false, true, 2),
('dispute_reason', 'Damaged', false, true, 3),
('dispute_reason', 'Wrong Item', false, true, 4),
('dispute_reason', 'Other', false, true, 5)
ON CONFLICT (field_key, option_label) DO NOTHING;


-- ==========================================
-- ROW-LEVEL SECURITY (RLS) POLICIES
-- ==========================================

-- Enable RLS on business-data tables
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_business_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_store_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_module_permissions ENABLE ROW LEVEL SECURITY;

-- Helper function to check if the current user is an admin
CREATE OR REPLACE FUNCTION is_admin(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM users
        WHERE id = user_id AND role = 'admin' AND status = 'active'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Policy for businesses
DROP POLICY IF EXISTS business_access_policy ON businesses;
CREATE POLICY business_access_policy ON businesses
FOR ALL
USING (
    -- Admins bypass
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR
    -- Non-admins must have business-level access
    id IN (
        SELECT business_id FROM user_business_access
        WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
    OR
    -- Or have explicit store access under this business
    id IN (
        SELECT s.business_id FROM stores s
        JOIN user_store_access usa ON s.id = usa.store_id
        WHERE usa.user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
);

-- Policy for stores
DROP POLICY IF EXISTS store_access_policy ON stores;
CREATE POLICY store_access_policy ON stores
FOR ALL
USING (
    -- Admins bypass
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR
    -- Non-admins must have store-level access
    id IN (
        SELECT store_id FROM user_store_access
        WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
    OR
    -- Or have business-level access
    business_id IN (
        SELECT business_id FROM user_business_access
        WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
);

-- Policy for user_business_access
DROP POLICY IF EXISTS user_business_access_policy ON user_business_access;
CREATE POLICY user_business_access_policy ON user_business_access
FOR ALL
USING (
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR
    user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
);

-- Policy for user_store_access
DROP POLICY IF EXISTS user_store_access_policy ON user_store_access;
CREATE POLICY user_store_access_policy ON user_store_access
FOR ALL
USING (
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR
    user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
);

-- Policy for user_module_permissions
DROP POLICY IF EXISTS user_module_permissions_policy ON user_module_permissions;
CREATE POLICY user_module_permissions_policy ON user_module_permissions
FOR ALL
USING (
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR
    user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
);

-- ============================================================
-- Module 2: Market Orders
-- ============================================================
CREATE TABLE IF NOT EXISTS market_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    market_order_id TEXT NOT NULL,
    order_date DATE NOT NULL,
    item_title TEXT,
    buyer_name TEXT,
    buyer_state TEXT,
    gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    platform_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    ads_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    shipping_fee_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_expense NUMERIC(12,2) NOT NULL DEFAULT 0,
    other_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    net_earnings NUMERIC(12,2) NOT NULL DEFAULT 0,
    item_note_raw TEXT,
    shipped_date DATE,
    order_status TEXT NOT NULL DEFAULT 'processing' CHECK (order_status IN ('processing','shipped','refunded_partial','refunded_full')),
    dispute_status TEXT,
    order_tracker TEXT,
    va_team TEXT,
    review_status TEXT,
    dispute_reason TEXT,
    comments TEXT,
    order_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (store_id, market_order_id)
);
DROP TRIGGER IF EXISTS update_market_orders_updated_at ON market_orders;
CREATE TRIGGER update_market_orders_updated_at BEFORE UPDATE ON market_orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Module 3: Supplier Orders
-- ============================================================
CREATE TABLE IF NOT EXISTS supplier_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    source_vendor TEXT NOT NULL,
    supplier_store_name TEXT,
    supplier_order_id TEXT NOT NULL,
    match_key TEXT,
    supplier_order_date DATE NOT NULL,
    supplier_order_status TEXT,
    item_title TEXT,
    order_qty INTEGER NOT NULL DEFAULT 1,
    unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    shipping_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    price_adjustment NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    other_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    supplier_order_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_method TEXT,
    tracking_number TEXT,
    tracking_carrier TEXT,
    buyer_name TEXT,
    ship_state TEXT,
    supplier_refund_status TEXT,
    refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    date_refunded DATE,
    supplier_notes TEXT,
    total_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    order_status TEXT NOT NULL DEFAULT 'Order Paid',
    dispute_status TEXT,
    order_tracker TEXT,
    va_team TEXT,
    review_status TEXT,
    dispute_reason TEXT,
    comments TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (store_id, source_vendor, supplier_order_id)
);
DROP TRIGGER IF EXISTS update_supplier_orders_updated_at ON supplier_orders;
CREATE TRIGGER update_supplier_orders_updated_at BEFORE UPDATE ON supplier_orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Module 4: Order Matching
-- ============================================================
CREATE TABLE IF NOT EXISTS order_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_order_id UUID REFERENCES market_orders(id) ON DELETE CASCADE,
    parsed_match_key TEXT,
    supplier_order_id UUID REFERENCES supplier_orders(id) ON DELETE CASCADE,
    supplier_match_key TEXT,
    match_status TEXT NOT NULL CHECK (match_status IN ('matched','unmatched_market','unmatched_supplier','error_parse')),
    source TEXT NOT NULL DEFAULT 'system' CHECK (source IN ('system','manual')),
    duplicate_claim BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS update_order_matches_updated_at ON order_matches;
CREATE TRIGGER update_order_matches_updated_at BEFORE UPDATE ON order_matches
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Module 5: Transactions
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    transaction_date DATE NOT NULL,
    transaction_type TEXT NOT NULL,
    market_order_id TEXT,
    net_amount NUMERIC(12,2),
    gross_transaction_amount NUMERIC(12,2),
    payout_batch_id TEXT,
    payout_date DATE,
    payout_status TEXT,
    item_title TEXT,
    description TEXT,
    row_hash TEXT NOT NULL,
    comments TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS update_transactions_updated_at ON transactions;
CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Module 6: Expense
-- ============================================================
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    invoice_id TEXT NOT NULL UNIQUE,
    vendor_name TEXT NOT NULL,
    invoice_url TEXT,
    expense_date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    description TEXT NOT NULL,
    linked_order_id UUID REFERENCES market_orders(id) ON DELETE SET NULL,
    linked_supplier_order_id UUID REFERENCES supplier_orders(id) ON DELETE SET NULL,
    va_team TEXT,
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS update_expenses_updated_at ON expenses;
CREATE TRIGGER update_expenses_updated_at BEFORE UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Module 7: Income
-- ============================================================
CREATE TABLE IF NOT EXISTS income (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    reference_id TEXT NOT NULL UNIQUE,
    source_name TEXT NOT NULL,
    invoice_url TEXT,
    income_date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    description TEXT NOT NULL,
    linked_order_id UUID REFERENCES market_orders(id) ON DELETE SET NULL,
    linked_supplier_order_id UUID REFERENCES supplier_orders(id) ON DELETE SET NULL,
    va_team TEXT,
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS update_income_updated_at ON income;
CREATE TRIGGER update_income_updated_at BEFORE UPDATE ON income
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Module 8: Import Center
-- ============================================================
CREATE TABLE IF NOT EXISTS import_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    import_type TEXT NOT NULL CHECK (import_type IN ('market_orders','supplier_orders','transactions')),
    market_order_source TEXT CHECK (market_order_source IN ('earnings','orders_report')),
    platform TEXT,
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    total_rows INTEGER NOT NULL DEFAULT 0,
    success_rows INTEGER NOT NULL DEFAULT 0,
    failed_rows INTEGER NOT NULL DEFAULT 0,
    skipped_rows INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('processing','completed','completed_with_errors','failed')),
    uploaded_by_user_id UUID NOT NULL REFERENCES users(id),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    UNIQUE (store_id, import_type, file_hash)
);

CREATE TABLE IF NOT EXISTS import_log_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_log_id UUID NOT NULL REFERENCES import_logs(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    row_status TEXT NOT NULL CHECK (row_status IN ('success','failed','skipped_duplicate')),
    raw_row_data JSONB NOT NULL,
    error_reason TEXT,
    created_record_id UUID,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS raw_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_log_id UUID NOT NULL REFERENCES import_logs(id) ON DELETE CASCADE,
    file_content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_log_id UUID NOT NULL REFERENCES import_logs(id) ON DELETE CASCADE,
    record_table TEXT NOT NULL CHECK (record_table IN ('market_orders','supplier_orders','transactions')),
    record_id UUID NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT NOT NULL,
    changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Row-Level Security for store-scoped tables (Modules 2,3,5,6,7)
-- ============================================================
ALTER TABLE market_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_orders_access_policy ON market_orders;
CREATE POLICY market_orders_access_policy ON market_orders
FOR ALL
USING (
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR store_id IN (
        SELECT id FROM stores WHERE business_id IN (
            SELECT business_id FROM user_business_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
    OR store_id IN (
        SELECT store_id FROM user_store_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
);

ALTER TABLE supplier_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_orders_access_policy ON supplier_orders;
CREATE POLICY supplier_orders_access_policy ON supplier_orders
FOR ALL
USING (
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR store_id IN (
        SELECT id FROM stores WHERE business_id IN (
            SELECT business_id FROM user_business_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
    OR store_id IN (
        SELECT store_id FROM user_store_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transactions_access_policy ON transactions;
CREATE POLICY transactions_access_policy ON transactions
FOR ALL
USING (
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR store_id IN (
        SELECT id FROM stores WHERE business_id IN (
            SELECT business_id FROM user_business_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
    OR store_id IN (
        SELECT store_id FROM user_store_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expenses_access_policy ON expenses;
CREATE POLICY expenses_access_policy ON expenses
FOR ALL
USING (
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR store_id IN (
        SELECT id FROM stores WHERE business_id IN (
            SELECT business_id FROM user_business_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
    OR store_id IN (
        SELECT store_id FROM user_store_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
);

ALTER TABLE income ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS income_access_policy ON income;
CREATE POLICY income_access_policy ON income
FOR ALL
USING (
    is_admin(NULLIF(current_setting('app.current_user_id', true), '')::UUID)
    OR store_id IN (
        SELECT id FROM stores WHERE business_id IN (
            SELECT business_id FROM user_business_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
    OR store_id IN (
        SELECT store_id FROM user_store_access WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
    )
);
