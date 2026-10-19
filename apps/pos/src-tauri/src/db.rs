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
                is_deleted INTEGER NOT NULL DEFAULT 0,
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
            if !cols.contains(&"is_deleted".to_string()) {
                conn.execute(
                    "ALTER TABLE products ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;",
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

        // Migration v5: Official Malgudi Mithais 97-product catalog
        let has_v5: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 5);",
                [],
                |r| r.get(0),
            )
            .unwrap_or(false);

        if !has_v5 {
            // 1. Purge legacy pilot mock items that have no sales history
            let _ = conn.execute(
                "DELETE FROM stock_balances WHERE product_id IN (
                    'prod_laddu', 'prod_kaju_katli', 'prod_wheat_halwa',
                    'prod_ribbon_pakoda', 'prod_kara_sev', 'prod_butter_murukku',
                    'prod_honey_bun', 'prod_butter_rusk', 'prod_badam_milk',
                    'prod_jigarthanda', 'prod_filter_coffee'
                ) AND product_id NOT IN (SELECT DISTINCT product_id FROM sale_items);",
                [],
            );
            let _ = conn.execute(
                "DELETE FROM products WHERE id IN (
                    'prod_laddu', 'prod_kaju_katli', 'prod_wheat_halwa',
                    'prod_ribbon_pakoda', 'prod_kara_sev', 'prod_butter_murukku',
                    'prod_honey_bun', 'prod_butter_rusk', 'prod_badam_milk',
                    'prod_jigarthanda', 'prod_filter_coffee'
                ) AND id NOT IN (SELECT DISTINCT product_id FROM sale_items);",
                [],
            );
            // 2. Deactivate any remaining legacy items in case they are referenced by historical sales
            let _ = conn.execute(
                "UPDATE products SET is_active = 0 WHERE id IN (
                    'prod_laddu', 'prod_kaju_katli', 'prod_wheat_halwa',
                    'prod_ribbon_pakoda', 'prod_kara_sev', 'prod_butter_murukku',
                    'prod_honey_bun', 'prod_butter_rusk', 'prod_badam_milk',
                    'prod_jigarthanda', 'prod_filter_coffee'
                );",
                [],
            );

            // 3. Seed/update the 97 official products
            Self::seed_official_97_catalog(conn)?;

            let _ = conn.execute(
                "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, '2026-10-19T00:00:00Z');",
                [],
            );
        }

        // Ensure baseline stock is safely initialized for both branches (IB & MN)
        Self::initialize_branch_stock_if_missing(conn, "IB")?;
        Self::initialize_branch_stock_if_missing(conn, "MN")?;

        Ok(())
    }

    fn seed_initial_products_if_empty(conn: &Connection) -> Result<()> {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM products WHERE is_active = 1;", [], |r| r.get(0))
            .unwrap_or(0);
        if count > 0 {
            return Ok(());
        }

        Self::seed_official_97_catalog(conn)
    }

    /// Seeds the official 97-product catalog for Malgudi Mithais.
    pub fn seed_official_97_catalog(conn: &Connection) -> Result<()> {
        let now = "2026-10-19T00:00:00Z";
        let official_items: &[(&str, &str, &str, &str, &str, &str, &str, i64, i64, &str)] = &[
            (
                "prod_kaju_kathli",
                "Kaju Kathli",
                "காஜூ கத்திலி",
                "KJU-001",
                "cat_kaju_sweets",
                "PER_KG",
                "MG",
                120000,
                500,
                "21069099",
            ),
            (
                "prod_kaju_roll",
                "Kaju Roll",
                "காஜூ ரோல்",
                "KJU-002",
                "cat_kaju_sweets",
                "PER_KG",
                "MG",
                120000,
                500,
                "21069099",
            ),
            (
                "prod_kaju_pista_cake",
                "Kaju Pista Cake",
                "காஜூ பிஸ்தா கேக்",
                "KJU-003",
                "cat_kaju_sweets",
                "PER_KG",
                "MG",
                120000,
                500,
                "21069099",
            ),
            (
                "prod_kaju_assorted",
                "Kaju Assorted",
                "காஜூ மிக்ஸ்ட்",
                "KJU-004",
                "cat_kaju_sweets",
                "PER_KG",
                "MG",
                120000,
                500,
                "21069099",
            ),
            (
                "prod_kaju_rose_bites",
                "Kaju Rose Bites",
                "காஜூ ரோஸ் பைட்ஸ்",
                "KJC-001",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                2500,
                500,
                "21069099",
            ),
            (
                "prod_kaju_chocolate_bites",
                "Kaju Chocolate Bites",
                "காஜூ சாக்லேட் பைட்ஸ்",
                "KJC-002",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                2500,
                500,
                "21069099",
            ),
            (
                "prod_kaju_strawberry_bites",
                "Kaju Strawberry Bites",
                "காஜூ ஸ்ட்ராபெரி பைட்ஸ்",
                "KJC-003",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                2500,
                500,
                "21069099",
            ),
            (
                "prod_kaju_cashew_bites",
                "Kaju Cashew Bites",
                "காஜூ முந்திரி பைட்ஸ்",
                "KJC-004",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                2500,
                500,
                "21069099",
            ),
            (
                "prod_kaju_mango_bites",
                "Kaju Mango Bites",
                "காஜூ மாம்பழ பைட்ஸ்",
                "KJC-005",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                2500,
                500,
                "21069099",
            ),
            (
                "prod_kaju_orange_bites",
                "Kaju Orange Bites",
                "காஜூ ஆரஞ்சு பைட்ஸ்",
                "KJC-006",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                2500,
                500,
                "21069099",
            ),
            (
                "prod_swiss_crunch",
                "Swiss Crunch",
                "சுவிஸ் க்ரஞ்ச்",
                "KJC-007",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                3000,
                500,
                "21069099",
            ),
            (
                "prod_oreo_crunch",
                "Oreo Crunch",
                "ஓரியோ க்ரஞ்ச்",
                "KJC-008",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                3000,
                500,
                "21069099",
            ),
            (
                "prod_kaju_chocolate_delight",
                "Kaju Chocolate Delight",
                "காஜூ சாக்லேட் டிலைட்",
                "KJC-009",
                "cat_kaju_crunches",
                "PER_PIECE",
                "PIECE",
                3000,
                500,
                "21069099",
            ),
            (
                "prod_mothi_laddu",
                "Mothi Laddu",
                "மோதி லட்டு",
                "GHE-001",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_malgudi_special_mothipok",
                "Malgudi Special Mothipok",
                "மால்குடி மோதி பாக்",
                "GHE-002",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_kashmir_kalakand",
                "Kashmir Kalakand",
                "காஷ்மீர் காலகண்ட்",
                "GHE-003",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_horlicks_mysorepok",
                "Horlicks Mysorepok",
                "ஹார்லிக்ஸ் மைசூர்பாக்",
                "GHE-004",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_mysore_pak",
                "Ghee Mysorepok",
                "நெய் மைசூர்பாக்",
                "GHE-005",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_bombay_alva",
                "Bombay Alva",
                "பம்பாய் அல்வா",
                "GHE-006",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_fruit_alva",
                "Fruit Alva",
                "ஃப்ரூட் அல்வா",
                "GHE-007",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_pal_gova_ghee",
                "Pal Gova (Ghee)",
                "பால்கோவா நெய்",
                "GHE-008",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_pal_alva",
                "Pal Alva",
                "பால் அல்வா",
                "GHE-009",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_kothumai_alva",
                "Kothumai Alva",
                "கோதுமை அல்வா",
                "GHE-010",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_white_soan_papdi",
                "White Soan Papdi",
                "வெள்ளை சோன்பப்டி",
                "GHE-011",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_milk_beda",
                "Milk Beda",
                "மில்க் பேடா",
                "GHE-012",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_jim_jam_beda",
                "Jim Jam beda",
                "ஜிம் ஜாம் பேடா",
                "GHE-013",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_badam_burfi",
                "Badam Burfi",
                "பாதாம் பர்ஃபி",
                "GHE-014",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_thapsa_beda",
                "Thapsa beda",
                "தப்ஸா பேடா",
                "GHE-015",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_dry_jamun",
                "Dry Jamun",
                "டிரை ஜாமூன்",
                "GHE-016",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_spl_white_beda",
                "Spl White beda",
                "ஸ்பெஷல் வெள்ளை பேடா",
                "GHE-017",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_rasaberi",
                "Rasaberi",
                "ரசபரி",
                "GHE-018",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_bengali_toast",
                "Bengali Toast",
                "பெங்காலி டோஸ்ட்",
                "GHE-019",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_rasamalai",
                "Rasamalai",
                "ரசமலாய் பாக்ஸ்",
                "GHE-020",
                "cat_ghee_sweets",
                "PER_BOX",
                "BOX",
                5000,
                500,
                "21069099",
            ),
            (
                "prod_globe_jamun",
                "Globe Jamun",
                "குலோப் ஜாமூன்",
                "GHE-021",
                "cat_ghee_sweets",
                "PER_PIECE",
                "PIECE",
                2000,
                500,
                "21069099",
            ),
            (
                "prod_rasagulla",
                "Rasagulla",
                "ரசகுல்லா",
                "GHE-022",
                "cat_ghee_sweets",
                "PER_PIECE",
                "PIECE",
                2000,
                500,
                "21069099",
            ),
            (
                "prod_sugar_free_laddu",
                "Sugar Free Laddu",
                "சுகர் ப்ரீ லட்டு",
                "GHE-023",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                68000,
                500,
                "21069099",
            ),
            (
                "prod_energy_plus_laddu",
                "Energy Plus Laddu",
                "எனர்ஜி பிளஸ் லட்டு",
                "GHE-024",
                "cat_ghee_sweets",
                "PER_KG",
                "MG",
                60000,
                500,
                "21069099",
            ),
            (
                "prod_regular_laddu",
                "Regular Laddu",
                "சாதாரண லட்டு",
                "REG-001",
                "cat_regular_sweets",
                "PER_KG",
                "MG",
                44000,
                500,
                "21069099",
            ),
            (
                "prod_mini_badusa",
                "Mini Badusa",
                "மினி பாதுஷா",
                "REG-002",
                "cat_regular_sweets",
                "PER_KG",
                "MG",
                44000,
                500,
                "21069099",
            ),
            (
                "prod_mini_jangri",
                "Mini Jangri",
                "மினி ஜாங்கிரி",
                "REG-003",
                "cat_regular_sweets",
                "PER_KG",
                "MG",
                44000,
                500,
                "21069099",
            ),
            (
                "prod_chandrakala",
                "Chandrakala",
                "சந்திரகலா",
                "REG-004",
                "cat_regular_sweets",
                "PER_KG",
                "MG",
                44000,
                500,
                "21069099",
            ),
            (
                "prod_regular_mysorepok",
                "Regular Mysorepok",
                "சாதாரண மைசூர்பாக்",
                "REG-005",
                "cat_regular_sweets",
                "PER_KG",
                "MG",
                44000,
                500,
                "21069099",
            ),
            (
                "prod_pal_gova_regular",
                "Pal Gova (Regular)",
                "பால்கோவா ரெகுலர்",
                "REG-006",
                "cat_regular_sweets",
                "PER_KG",
                "MG",
                44000,
                500,
                "21069099",
            ),
            (
                "prod_sweet_poonthi",
                "Sweet Poonthi",
                "இனிப்பு பூந்தி",
                "REG-007",
                "cat_regular_sweets",
                "PER_KG",
                "MG",
                44000,
                500,
                "21069099",
            ),
            (
                "prod_milk_bread",
                "Milk Bread",
                "பால் பிரட்",
                "BAK-001",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                3500,
                500,
                "19059010",
            ),
            (
                "prod_mini_bun",
                "Mini bun",
                "மினி பன் பாக்கெட்",
                "BAK-002",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                3500,
                500,
                "19059010",
            ),
            (
                "prod_sponze_cake_2pcs",
                "Sponze Cake (2pcs)",
                "ஸ்பாஞ்ச் கேக் (2 பீஸ்)",
                "BAK-003",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                5000,
                500,
                "19059010",
            ),
            (
                "prod_ghee_cake_2_pcs",
                "Ghee Cake (2 pcs)",
                "நெய் கேக் (2 பீஸ்)",
                "BAK-004",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                4000,
                500,
                "19059010",
            ),
            (
                "prod_plum_cake_2_pcs",
                "Plum Cake (2 Pcs)",
                "பிளம் கேக்",
                "BAK-005",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                5000,
                500,
                "19059010",
            ),
            (
                "prod_pudding_cake_2_pcs",
                "Pudding Cake (2 pcs)",
                "புட்டிங் கேக்",
                "BAK-006",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                5000,
                500,
                "19059010",
            ),
            (
                "prod_rusk_150g",
                "Rusk 150g",
                "ரஸ்க் 150g",
                "BAK-007",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                5400,
                500,
                "19059010",
            ),
            (
                "prod_coconut_bun",
                "Coconut Bun",
                "தேங்காய் பன்",
                "BAK-008",
                "cat_bakery",
                "PER_PIECE",
                "PIECE",
                2000,
                500,
                "19059010",
            ),
            (
                "prod_roll_cake",
                "Roll Cake",
                "ரோல் கேக்",
                "BAK-009",
                "cat_bakery",
                "PER_PIECE",
                "PIECE",
                2000,
                500,
                "19059010",
            ),
            (
                "prod_macroon",
                "Macroon",
                "மக்ரூன் பாக்கெட்",
                "BAK-010",
                "cat_bakery",
                "PER_PACK",
                "PACK",
                10000,
                500,
                "19059010",
            ),
            (
                "prod_malgudi_special_veetu_murukku",
                "Malgudi Special Veetu Murukku",
                "வீட்டு முறுக்கு (250g)",
                "MUR-001",
                "cat_murukku",
                "PER_PACK",
                "PACK",
                10000,
                500,
                "21069099",
            ),
            (
                "prod_idiyappa_murukku_100g",
                "Idiyappa Murukku 100g",
                "இடியாப்ப முறுக்கு 100g",
                "MUR-002",
                "cat_murukku",
                "PER_PACK",
                "PACK",
                3200,
                500,
                "21069099",
            ),
            (
                "prod_manapparai_murukku",
                "Manapparai Murukku",
                "மணப்பாறை முறுக்கு",
                "MUR-003",
                "cat_murukku",
                "PER_PACK",
                "PACK",
                3000,
                500,
                "21069099",
            ),
            (
                "prod_achu_muruku",
                "Achu Muruku",
                "அச்சு முறுக்கு",
                "MUR-004",
                "cat_murukku",
                "PER_PACK",
                "PACK",
                5000,
                500,
                "21069099",
            ),
            (
                "prod_andhra_muruku_250g",
                "Andhra Muruku 250g",
                "ஆந்திரா முறுக்கு 250g",
                "MUR-005",
                "cat_murukku",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_sovi_muruku_250g",
                "Sovi Muruku 250g",
                "சோவி முறுக்கு 250g",
                "MUR-006",
                "cat_murukku",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_spl_poondu_murukku",
                "Spl Poondu Murukku",
                "ஸ்பெஷல் பூண்டு முறுக்கு",
                "MUR-007",
                "cat_murukku",
                "PER_PACK",
                "PACK",
                6000,
                500,
                "21069099",
            ),
            (
                "prod_onion_murukku",
                "Onion Murukku",
                "வெங்காய முறுக்கு",
                "MUR-008",
                "cat_murukku",
                "PER_PACK",
                "PACK",
                3500,
                500,
                "21069099",
            ),
            (
                "prod_malgudi_mixer",
                "Malgudi Mixer",
                "மால்குடி மிக்சர்",
                "SAV-001",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_malgudi_specia_ellu_sevu",
                "Malgudi Specia Ellu Sevu",
                "எள்ளு சேவு",
                "SAV-002",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_sattur_sevu",
                "Sattur Sevu",
                "சாத்தூர் சேவு",
                "SAV-003",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_bombay_mixer",
                "Bombay Mixer",
                "பம்பாய் மிக்சர்",
                "SAV-004",
                "cat_savories",
                "PER_KG",
                "MG",
                48000,
                500,
                "21069099",
            ),
            (
                "prod_motta_mixer",
                "Motta Mixer",
                "மொட்டை மிக்சர்",
                "SAV-005",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_corn_mixer",
                "Corn Mixer",
                "கார்ன் மிக்சர்",
                "SAV-006",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_masala_seeval",
                "Masala Seeval",
                "மசாலா சீவல்",
                "SAV-007",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_milagu_sevu",
                "Milagu Sevu",
                "மிளகு சேவு",
                "SAV-008",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_masal_kadalai",
                "Masal Kadalai",
                "மசாலா கடலை",
                "SAV-009",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_thattai",
                "Thattai",
                "தட்டை",
                "SAV-010",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_navathanyam",
                "Navathanyam",
                "நவதானியம் மிக்ஸ்",
                "SAV-011",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_karapoonthi",
                "Karapoonthi",
                "கார பூந்தி",
                "SAV-012",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_pepper_cashewnut",
                "Pepper Cashewnut",
                "மிளகு முந்திரி",
                "SAV-013",
                "cat_savories",
                "PER_KG",
                "MG",
                160000,
                500,
                "21069099",
            ),
            (
                "prod_podi_cake",
                "Podi Cake",
                "பொடி கேக்",
                "SAV-014",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_chinna_sevu",
                "Chinna Sevu",
                "சின்ன சேவு",
                "SAV-015",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_omapodi",
                "Omapodi",
                "ஓமப்பொடி",
                "SAV-016",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_mavu_pakoda",
                "Mavu Pakoda",
                "மாவு பகோடா",
                "SAV-017",
                "cat_savories",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_potatto_finger_chips",
                "Potatto Finger Chips",
                "உருளை பிங்கர் சிப்ஸ்",
                "CHP-001",
                "cat_chips",
                "PER_KG",
                "MG",
                50000,
                500,
                "21069099",
            ),
            (
                "prod_pottato_chips",
                "Pottato Chips",
                "உருளை சிப்ஸ்",
                "CHP-002",
                "cat_chips",
                "PER_KG",
                "MG",
                50000,
                500,
                "21069099",
            ),
            (
                "prod_kappa_kilangu_chips",
                "Kappa kilangu Chips",
                "மரவள்ளிக்கிழங்கு சிப்ஸ்",
                "CHP-003",
                "cat_chips",
                "PER_KG",
                "MG",
                40000,
                500,
                "21069099",
            ),
            (
                "prod_nendram_chips",
                "Nendram Chips",
                "நேந்திரம் வாழைக்காய் சிப்ஸ்",
                "CHP-004",
                "cat_chips",
                "PER_KG",
                "MG",
                50000,
                500,
                "21069099",
            ),
            (
                "prod_maavu_laddu",
                "Maavu Laddu",
                "மாவு லட்டு பாக்ஸ்",
                "SNK-001",
                "cat_snacks",
                "PER_BOX",
                "BOX",
                10000,
                500,
                "21069099",
            ),
            (
                "prod_soan_papdi",
                "Soan Papdi",
                "சோன்பப்டி பாக்ஸ்",
                "SNK-002",
                "cat_snacks",
                "PER_BOX",
                "BOX",
                4500,
                500,
                "21069099",
            ),
            (
                "prod_hydrabad_cookies",
                "Hydrabad cookies",
                "ஹைதராபாத் குக்கீஸ்",
                "SNK-003",
                "cat_snacks",
                "PER_BOX",
                "BOX",
                7500,
                500,
                "19053100",
            ),
            (
                "prod_athirasam",
                "Athirasam",
                "அதிரசம்",
                "SNK-004",
                "cat_snacks",
                "PER_PIECE",
                "PIECE",
                1200,
                500,
                "21069099",
            ),
            (
                "prod_vennila_cookies",
                "Vennila Cookies",
                "வெண்ணிலா குக்கீஸ்",
                "SNK-005",
                "cat_snacks",
                "PER_PACK",
                "PACK",
                7500,
                500,
                "19053100",
            ),
            (
                "prod_boost_cookies",
                "Boost Cookies",
                "பூஸ்ட் குக்கீஸ்",
                "SNK-006",
                "cat_snacks",
                "PER_PACK",
                "PACK",
                7500,
                500,
                "19053100",
            ),
            (
                "prod_multi_movements_cookies",
                "Multi Movements Cookies",
                "மல்டிகிரைன் குக்கீஸ்",
                "SNK-007",
                "cat_snacks",
                "PER_PACK",
                "PACK",
                7500,
                500,
                "19053100",
            ),
            (
                "prod_cashew_cookies",
                "Cashew Cookies",
                "முந்திரி குக்கீஸ்",
                "SNK-008",
                "cat_snacks",
                "PER_PACK",
                "PACK",
                7500,
                500,
                "19053100",
            ),
            (
                "prod_veg_puffs",
                "Veg Puffs",
                "வெஜ் பஃப்ஸ்",
                "SNK-009",
                "cat_snacks",
                "PER_PIECE",
                "PIECE",
                1500,
                500,
                "19059010",
            ),
            (
                "prod_egg_puffs",
                "Egg Puffs",
                "எக் பஃப்ஸ்",
                "SNK-010",
                "cat_snacks",
                "PER_PIECE",
                "PIECE",
                2000,
                500,
                "19059010",
            ),
            (
                "prod_samosa",
                "Samosa",
                "சமோசா",
                "SNK-011",
                "cat_snacks",
                "PER_PIECE",
                "PIECE",
                1500,
                500,
                "21069099",
            ),
            (
                "prod_coconut_boli",
                "Coconut Boli",
                "தேங்காய் போளி",
                "SNK-012",
                "cat_snacks",
                "PER_PIECE",
                "PIECE",
                2700,
                500,
                "21069099",
            ),
            (
                "prod_dhall_boli",
                "Dhall Boli",
                "பருப்பு போளி",
                "SNK-013",
                "cat_snacks",
                "PER_PIECE",
                "PIECE",
                2700,
                500,
                "21069099",
            ),
            (
                "prod_onion_samosa",
                "Onion Samosa",
                "வெங்காய சமோசா",
                "SNK-014",
                "cat_snacks",
                "PER_PIECE",
                "PIECE",
                800,
                500,
                "21069099",
            ),
        ];

        for item in official_items {
            // Disambiguate any existing product with the same SKU to prevent UNIQUE constraint failure
            conn.execute(
                "UPDATE products SET sku = 'OLD-' || sku || '-' || SUBSTR(id, -6) WHERE sku = ?1 AND id != ?2;",
                rusqlite::params![item.3, item.0],
            )?;

            conn.execute(
                "INSERT INTO products (
                    id, name, tamil_name, sku, category_id, pricing_unit, inventory_unit,
                    pricing_basis, base_price_paise, tax_rate_bps, hsn_code, is_active, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'TAX_INCLUSIVE', ?8, ?9, ?10, 1, ?11, ?11)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    tamil_name = excluded.tamil_name,
                    sku = excluded.sku,
                    category_id = excluded.category_id,
                    pricing_unit = excluded.pricing_unit,
                    inventory_unit = excluded.inventory_unit,
                    base_price_paise = excluded.base_price_paise,
                    tax_rate_bps = excluded.tax_rate_bps,
                    hsn_code = excluded.hsn_code,
                    is_active = 1,
                    updated_at = excluded.updated_at;",
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

        // Clean up deprecated test accounts if present
        let _ = conn.execute(
            "DELETE FROM users WHERE username IN ('owner_anand', 'kavitha_01', 'kavitha');",
            [],
        );

        // Clear any prior lockouts for owner and staff
        let _ = conn.execute(
            "DELETE FROM auth_attempts WHERE username IN ('owner', 'staff', 'owner_anand', 'kavitha_01', 'kavitha');",
            [],
        );

        Ok(())
    }
}
