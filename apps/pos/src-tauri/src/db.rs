use rusqlite::{Connection, Result};
use std::path::Path;

pub struct DatabaseManager;

impl DatabaseManager {
    /// Opens a writable connection with Write-Ahead Logging (WAL) and synchronous = FULL.
    pub fn open_writable<P: AsRef<Path>>(path: P) -> Result<Connection> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA wal_autocheckpoint = 1000;",
        )?;
        if !Self::verify_integrity(&conn)? {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Database integrity check failed: PRAGMA integrity_check != ok",
                ),
            )));
        }
        Self::apply_migrations(&conn)?;
        Ok(conn)
    }

    /// Opens a strictly read-only connection.
    /// Invariant: NEVER executes `PRAGMA journal_mode = WAL;` on read-only connections.
    pub fn open_read_only<P: AsRef<Path>>(path: P) -> Result<Connection> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch(
            "PRAGMA query_only = ON;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        Ok(conn)
    }

    /// Verifies B-tree structural integrity.
    pub fn verify_integrity(conn: &Connection) -> Result<bool> {
        let mut stmt = conn.prepare("PRAGMA integrity_check;")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            let res: String = row.get(0)?;
            Ok(res == "ok")
        } else {
            Ok(false)
        }
    }

    /// Returns the active schema version.
    pub fn get_schema_version(conn: &Connection) -> Result<i64> {
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations;",
            [],
            |r| r.get(0),
        )
    }

    /// Applies schema migrations idempotently.
    pub fn apply_migrations(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, '2026-10-10T00:00:00Z');


            CREATE TABLE IF NOT EXISTS invoice_series (
                series_code TEXT NOT NULL,
                financial_year TEXT NOT NULL,
                current_seq INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (series_code, financial_year)
            );

            CREATE TABLE IF NOT EXISTS sales (
                id TEXT PRIMARY KEY,
                invoice_number TEXT NOT NULL,
                branch_id TEXT NOT NULL,
                counter_id TEXT NOT NULL,
                terminal_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                business_date TEXT NOT NULL,
                tax_policy_version TEXT NOT NULL,
                subtotal_taxable_paise INTEGER NOT NULL,
                total_cgst_paise INTEGER NOT NULL,
                total_sgst_paise INTEGER NOT NULL,
                total_igst_paise INTEGER NOT NULL,
                round_off_paise INTEGER NOT NULL,
                net_payable_paise INTEGER NOT NULL,
                sale_status TEXT NOT NULL,
                payment_status TEXT NOT NULL,
                sync_status TEXT NOT NULL,
                customer_name TEXT,
                customer_phone TEXT,
                customer_location TEXT,
                created_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoice_unique 
            ON sales (invoice_number);

            CREATE TABLE IF NOT EXISTS sale_items (
                id TEXT PRIMARY KEY,
                sale_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                quantity_input INTEGER NOT NULL,
                pricing_unit TEXT NOT NULL,
                weight_input_source TEXT NOT NULL,
                unit_price_paise INTEGER NOT NULL,
                taxable_paise INTEGER NOT NULL,
                cgst_paise INTEGER NOT NULL,
                sgst_paise INTEGER NOT NULL,
                igst_paise INTEGER NOT NULL,
                total_tax_paise INTEGER NOT NULL,
                gross_paise INTEGER NOT NULL,
                stock_deduction_delta INTEGER NOT NULL,
                stock_unit TEXT NOT NULL,
                FOREIGN KEY (sale_id) REFERENCES sales(id)
            );

            CREATE TABLE IF NOT EXISTS sale_payments (
                id TEXT PRIMARY KEY,
                sale_id TEXT NOT NULL,
                payment_method TEXT NOT NULL,
                allocated_amount_paise INTEGER NOT NULL,
                tendered_paise INTEGER NOT NULL,
                change_returned_paise INTEGER NOT NULL,
                net_amount_paise INTEGER NOT NULL,
                outcome TEXT NOT NULL,
                reference_note TEXT,
                verified_by_user_id TEXT,
                FOREIGN KEY (sale_id) REFERENCES sales(id)
            );

            CREATE TABLE IF NOT EXISTS cash_movements (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                branch_id TEXT NOT NULL,
                movement_type TEXT NOT NULL,
                amount_paise INTEGER NOT NULL,
                direction TEXT NOT NULL,
                reference_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            -- Canonical partial index: Physically prevents multiple OPENING_FLOAT rows per branch per business date
            CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_movements_branch_date_opening 
            ON cash_movements (branch_id, SUBSTR(created_at, 1, 10)) 
            WHERE movement_type = 'OPENING_FLOAT';

            CREATE TABLE IF NOT EXISTS stock_movements (
                id TEXT PRIMARY KEY,
                branch_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                movement_type TEXT NOT NULL,
                quantity_delta INTEGER NOT NULL,
                unit TEXT NOT NULL,
                reference_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_outbox (
                event_id TEXT PRIMARY KEY,
                aggregate_type TEXT NOT NULL,
                aggregate_id TEXT NOT NULL,
                event_seq INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_events (
                id TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS terminal_trust_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stock_reservations (
                id TEXT PRIMARY KEY,
                cart_or_sale_id TEXT NOT NULL,
                branch_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                reserved_quantity INTEGER NOT NULL,
                unit TEXT NOT NULL,
                status TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS manual_bill_ledger (
                manual_series TEXT NOT NULL,
                serial_number INTEGER NOT NULL,
                pos_sale_id TEXT NOT NULL,
                recorded_at TEXT NOT NULL,
                reconciled_by TEXT NOT NULL,
                PRIMARY KEY (manual_series, serial_number)
            );

            -- Migration v2: Authentication, Sessions, and Role-Based Access Control
            INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, '2026-10-11T00:00:00Z');

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL,
                pin_hash TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                username TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL,
                branch_id TEXT NOT NULL,
                terminal_id TEXT NOT NULL,
                counter_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS auth_attempts (
                username TEXT PRIMARY KEY,
                failed_count INTEGER NOT NULL DEFAULT 0,
                locked_until TEXT
            );

            CREATE TABLE IF NOT EXISTS user_permissions (
                role TEXT NOT NULL,
                permission TEXT NOT NULL,
                PRIMARY KEY (role, permission)
            );

            INSERT OR IGNORE INTO user_permissions (role, permission) VALUES
                ('ADMIN', 'billing:finalize_sale'),
                ('ADMIN', 'billing:reprint_receipt'),
                ('ADMIN', 'admin:manage_users'),
                ('ADMIN', 'admin:view_audit_logs'),
                ('ADMIN', 'admin:create_backup'),
                ('ADMIN', 'admin:manage_inventory'),
                ('ADMIN', 'admin:view_reports'),
                ('CASHIER', 'billing:finalize_sale'),
                ('CASHIER', 'billing:reprint_receipt');

            -- Migration v3: Authoritative Persistent Products & Multi-Branch Stock Balances
            INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, '2026-10-12T00:00:00Z');

            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                tamil_name TEXT NOT NULL,
                sku TEXT NOT NULL UNIQUE,
                barcode TEXT,
                category_id TEXT NOT NULL,
                pricing_unit TEXT NOT NULL,
                inventory_unit TEXT NOT NULL,
                pricing_basis TEXT NOT NULL DEFAULT 'TAX_INCLUSIVE',
                base_price_paise INTEGER NOT NULL,
                piece_price_paise INTEGER,
                tax_rate_bps INTEGER NOT NULL DEFAULT 500,
                hsn_code TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stock_balances (
                branch_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                current_quantity INTEGER NOT NULL DEFAULT 0,
                unit TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (branch_id, product_id)
            );

            CREATE INDEX IF NOT EXISTS idx_stock_movements_branch_prod 
            ON stock_movements (branch_id, product_id);

            CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at 
            ON stock_movements (created_at);"
        )?;

        // Ensure reason and actor_id columns exist on stock_movements
        {
            let mut stmt = conn.prepare("PRAGMA table_info(stock_movements);")?;
            let cols: Vec<String> = stmt
                .query_map([], |r| r.get(1))?
                .filter_map(|r| r.ok())
                .collect();
            if !cols.contains(&"reason".to_string()) {
                conn.execute("ALTER TABLE stock_movements ADD COLUMN reason TEXT;", [])?;
            }
            if !cols.contains(&"actor_id".to_string()) {
                conn.execute("ALTER TABLE stock_movements ADD COLUMN actor_id TEXT;", [])?;
            }
        }

        // Ensure version column exists on products
        {
            let mut stmt = conn.prepare("PRAGMA table_info(products);")?;
            let cols: Vec<String> = stmt
                .query_map([], |r| r.get(1))?
                .filter_map(|r| r.ok())
                .collect();
            if !cols.contains(&"version".to_string()) {
                conn.execute(
                    "ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;",
                    [],
                )?;
            }
        }

        // Ensure customer fields exist on sales table
        {
            let mut stmt = conn.prepare("PRAGMA table_info(sales);")?;
            let cols: Vec<String> = stmt
                .query_map([], |r| r.get(1))?
                .filter_map(|r| r.ok())
                .collect();
            if !cols.contains(&"customer_name".to_string()) {
                conn.execute("ALTER TABLE sales ADD COLUMN customer_name TEXT;", [])?;
            }
            if !cols.contains(&"customer_phone".to_string()) {
                conn.execute("ALTER TABLE sales ADD COLUMN customer_phone TEXT;", [])?;
            }
            if !cols.contains(&"customer_location".to_string()) {
                conn.execute("ALTER TABLE sales ADD COLUMN customer_location TEXT;", [])?;
            }
        }
 
        // Migration v4: Cash drawer opening float unique per branch and calendar business date
        conn.execute_batch(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, '2026-10-15T00:00:00Z');
             DROP INDEX IF EXISTS idx_cash_movements_session_opening;
             CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_movements_branch_date_opening 
             ON cash_movements (branch_id, SUBSTR(created_at, 1, 10)) 
             WHERE movement_type = 'OPENING_FLOAT';"
        )?;

        // Seed initial products if products table is empty
        Self::seed_initial_products_if_empty(conn)?;

        // Ensure baseline stock is safely initialized for both branches (IB & MN)
        Self::initialize_branch_stock_if_missing(conn, "IB")?;
        Self::initialize_branch_stock_if_missing(conn, "MN")?;

        Ok(())
    }

    fn seed_initial_products_if_empty(conn: &Connection) -> Result<()> {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM products;", [], |r| r.get(0))
            .unwrap_or(0);
        if count > 0 {
            return Ok(());
        }

        let now = "2026-10-12T00:00:00Z";

        let default_items = [
            (
                "prod_mysore_pak",
                "Special Ghee Mysore Pak",
                "நெய் மைசூர் பாகு",
                "MP-001",
                "cat_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_laddu",
                "Madurai Nei Laddu",
                "மதுரை நெய் லட்டு",
                "SW-NL-002",
                "cat_sweets",
                "PER_KG",
                "MG",
                44000,
                500,
                "21069099",
            ),
            (
                "prod_kaju_katli",
                "Royal Kaju Katli",
                "காஜூ கத்திலி",
                "SW-KK-003",
                "cat_sweets",
                "PER_KG",
                "MG",
                95000,
                500,
                "21069099",
            ),
            (
                "prod_wheat_halwa",
                "Tirunelveli Wheat Halwa",
                "திருநெல்வேலி கோதுமை அல்வா",
                "SW-TH-004",
                "cat_sweets",
                "PER_KG",
                "MG",
                48000,
                500,
                "21069099",
            ),
            (
                "prod_ribbon_pakoda",
                "Madurai Ribbon Pakoda",
                "ரிப்பன் பகோடா",
                "SAV-RP-005",
                "cat_savories",
                "PER_KG",
                "MG",
                38000,
                500,
                "21069099",
            ),
            (
                "prod_kara_sev",
                "Sattur Spicy Kara Sev",
                "சாத்தூர் காராசேவ்",
                "SAV-KS-006",
                "cat_savories",
                "PER_KG",
                "MG",
                36000,
                500,
                "21069099",
            ),
            (
                "prod_butter_murukku",
                "Traditional Butter Murukku",
                "வெண்ணெய் முறுக்கு",
                "SAV-BM-007",
                "cat_savories",
                "PER_KG",
                "MG",
                42000,
                500,
                "21069099",
            ),
            (
                "prod_honey_bun",
                "Coconut Honey Sweet Bun",
                "தேங்காய் பன்",
                "BAK-HB-008",
                "cat_bakery",
                "PER_PIECE",
                "PIECE",
                2500,
                500,
                "19059010",
            ),
            (
                "prod_butter_rusk",
                "Malgudi Crunchy Butter Rusk",
                "மால்குடி ரஸ்க் பாக்கெட்",
                "BAK-BR-009",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                4500,
                500,
                "19059010",
            ),
            (
                "prod_badam_milk",
                "Kesar Badam Milk (Cold Bottle)",
                "குங்குமப்பூ பாதாம் பால்",
                "BEV-BM-010",
                "cat_beverages",
                "PER_PIECE",
                "PIECE",
                6000,
                500,
                "22029990",
            ),
            (
                "prod_jigarthanda",
                "Famous Madurai Special Jigarthanda",
                "மதுரை ஸ்பெஷல் ஜிகர்தண்டா",
                "BEV-JT-011",
                "cat_beverages",
                "PER_PIECE",
                "PIECE",
                8000,
                500,
                "22029990",
            ),
            (
                "prod_filter_coffee",
                "Madurai Degree Filter Coffee",
                "மதுரை டிகிரி பில்டர் காபி",
                "BEV-FC-012",
                "cat_beverages",
                "PER_PIECE",
                "PIECE",
                3500,
                500,
                "09012100",
            ),
        ];

        for item in &default_items {
            conn.execute(
                "INSERT OR IGNORE INTO products (
                    id, name, tamil_name, sku, category_id, pricing_unit, inventory_unit,
                    pricing_basis, base_price_paise, tax_rate_bps, hsn_code, is_active, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'TAX_INCLUSIVE', ?8, ?9, ?10, 1, ?11, ?11);",
                rusqlite::params![
                    item.0, item.1, item.2, item.3, item.4, item.5, item.6, item.7, item.8, item.9, now
                ],
            )?;
        }

        Ok(())
    }

    /// Initializes baseline stock for a specific branch idempotently.
    /// - IB (Town Hall): Seeded with verified initial pilot inventory.
    /// - MN (Mattuthavani): Initialized with 0 stock baseline without inventing fictitious inventory.
    /// - Safe to run repeatedly: never overwrites existing non-zero or updated inventory balances.
    pub fn initialize_branch_stock_if_missing(conn: &Connection, branch_id: &str) -> Result<()> {
        let now = "2026-10-12T00:00:00Z";

        let mut stmt =
            conn.prepare("SELECT id, inventory_unit FROM products WHERE is_active = 1;")?;
        let products: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(|r| r.ok())
            .collect();

        let ib_quantities: std::collections::HashMap<&str, i64> = [
            ("prod_mysore_pak", 25_000_000i64),
            ("prod_laddu", 30_000_000i64),
            ("prod_kaju_katli", 15_000_000i64),
            ("prod_wheat_halwa", 20_000_000i64),
            ("prod_ribbon_pakoda", 25_000_000i64),
            ("prod_kara_sev", 25_000_000i64),
            ("prod_butter_murukku", 20_000_000i64),
            ("prod_honey_bun", 50i64),
            ("prod_butter_rusk", 40i64),
            ("prod_badam_milk", 60i64),
            ("prod_jigarthanda", 50i64),
            ("prod_filter_coffee", 100i64),
        ]
        .into_iter()
        .collect();

        for (prod_id, unit) in &products {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM stock_balances WHERE branch_id = ?1 AND product_id = ?2);",
                [branch_id, prod_id],
                |r| r.get(0),
            ).unwrap_or(false);

            if !exists {
                let initial_qty = if branch_id == "IB" {
                    *ib_quantities.get(prod_id.as_str()).unwrap_or(&0i64)
                } else {
                    0i64
                };

                conn.execute(
                    "INSERT INTO stock_balances (branch_id, product_id, current_quantity, unit, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (branch_id, product_id) DO NOTHING;",
                    rusqlite::params![branch_id, prod_id, initial_qty, unit, now],
                )?;

                if initial_qty > 0 {
                    let sm_id = format!("sm_opening_{}_{}", branch_id, prod_id);
                    conn.execute(
                        "INSERT OR IGNORE INTO stock_movements (
                            id, branch_id, product_id, movement_type, quantity_delta, unit, reference_id, created_at, reason, actor_id
                        ) VALUES (?1, ?2, ?3, 'OPENING_STOCK', ?4, ?5, 'INITIAL_SEED', ?6, 'Initial System Stock Provisioning', 'system');",
                        rusqlite::params![sm_id, branch_id, prod_id, initial_qty, unit, now],
                    )?;
                }
            }
        }

        Ok(())
    }

    /// Seeds or updates the default `owner` (ADMIN) and `staff` (CASHIER) accounts with PIN `123456`.
    pub fn seed_default_users(conn: &Connection) -> Result<()> {
        let now = "2026-10-13T00:00:00Z";
        let pin_hash = match crate::auth::hash_pin("123456") {
            Ok(h) => h,
            Err(_) => return Ok(()),
        };

        // Ensure default owner account (Role: ADMIN, PIN: 123456)
        let _ = conn.execute(
            "INSERT INTO users (id, username, display_name, role, pin_hash, status, created_at, updated_at)
             VALUES ('usr_owner_default', 'owner', 'Store Owner', 'ADMIN', ?1, 'ACTIVE', ?2, ?2)
             ON CONFLICT(username) DO UPDATE SET pin_hash = excluded.pin_hash, status = 'ACTIVE';",
            rusqlite::params![&pin_hash, now],
        );

        // Ensure default staff account (Role: CASHIER, PIN: 123456)
        let _ = conn.execute(
            "INSERT INTO users (id, username, display_name, role, pin_hash, status, created_at, updated_at)
             VALUES ('usr_staff_default', 'staff', 'Billing Staff', 'CASHIER', ?1, 'ACTIVE', ?2, ?2)
             ON CONFLICT(username) DO UPDATE SET pin_hash = excluded.pin_hash, status = 'ACTIVE';",
            rusqlite::params![&pin_hash, now],
        );

        // Clear any prior lockouts for owner and staff
        let _ = conn.execute(
            "DELETE FROM auth_attempts WHERE username IN ('owner', 'staff');",
            [],
        );

        Ok(())
    }
}
