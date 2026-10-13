#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use malgudi_pos_native::auth::{
    self, AuditEventRecord, AuthStatusResponse, CreateUserPayload, LoginPayload,
    ProvisionOwnerPayload, SessionInfo, SwitchCashierPayload, UserRecord,
};
use malgudi_pos_native::db::DatabaseManager;
use malgudi_pos_native::inventory::{
    self, AdjustStockPayload, CreateProductPayload, ProductRecord,
    StockMovementRecord, UpdateProductPayload, VoidSalePayload,
};
use malgudi_pos_native::reports::{
    self, CashDrawerReport, DailySalesSummary, FinancialReportsAggregate, GstReport,
    PaymentSummaryReport, ProductSalesReport, ReportFilterPayload,
};
use malgudi_pos_native::sync;
use malgudi_pos_native::transaction::{
    self, finalize_sale_atomic, FinalizeSalePayload, FinalizeSaleResult,
};
use rusqlite::Connection;

pub struct AppState {
    pub db: Mutex<Connection>,
}

#[derive(Debug, serde::Serialize)]
pub struct PersistedSaleSummary {
    pub id: String,
    pub invoice_number: String,
    pub business_date: String,
    pub net_payable_paise: i64,
    pub sale_status: String,
    pub payment_status: String,
    pub sync_status: String,
    pub created_at: String,
}

#[derive(Debug, serde::Serialize)]
pub struct DatabaseInfo {
    pub db_path: String,
    pub is_wal_active: bool,
    pub total_sales: i64,
    pub pending_sync_count: i64,
}

#[tauri::command]
fn auth_get_status(
    state: tauri::State<AppState>,
    session_token: Option<String>,
) -> Result<AuthStatusResponse, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let is_prov = auth::is_provisioned(&conn)?;
    let active_session = if let Some(token) = session_token {
        auth::validate_session_and_permission(&conn, &token, "").ok()
    } else {
        None
    };

    Ok(AuthStatusResponse {
        is_provisioned: is_prov,
        active_session,
    })
}

#[tauri::command]
fn auth_provision_owner(
    state: tauri::State<AppState>,
    payload: ProvisionOwnerPayload,
) -> Result<SessionInfo, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::provision_first_owner(&conn, &payload)
}

#[tauri::command]
fn auth_login(
    state: tauri::State<AppState>,
    payload: LoginPayload,
) -> Result<SessionInfo, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::login(&conn, &payload)
}

#[tauri::command]
fn auth_switch_cashier(
    state: tauri::State<AppState>,
    payload: SwitchCashierPayload,
) -> Result<SessionInfo, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::switch_cashier(&conn, &payload)
}

#[tauri::command]
fn auth_logout(
    state: tauri::State<AppState>,
    session_token: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::logout(&conn, &session_token)
}

#[tauri::command]
fn auth_create_user(
    state: tauri::State<AppState>,
    session_token: String,
    payload: CreateUserPayload,
) -> Result<UserRecord, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::create_user(&conn, &session_token, &payload)
}

#[tauri::command]
fn auth_update_user_status(
    state: tauri::State<AppState>,
    session_token: String,
    user_id: String,
    status: String,
) -> Result<UserRecord, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::update_user_status(&conn, &session_token, &user_id, &status)
}

#[tauri::command]
fn auth_reset_user_pin(
    state: tauri::State<AppState>,
    session_token: String,
    user_id: String,
    new_pin: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::reset_user_pin(&conn, &session_token, &user_id, &new_pin)
}

#[tauri::command]
fn auth_list_users(
    state: tauri::State<AppState>,
    session_token: String,
) -> Result<Vec<UserRecord>, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::list_users(&conn, &session_token)
}

#[tauri::command]
fn auth_get_security_logs(
    state: tauri::State<AppState>,
    session_token: String,
) -> Result<Vec<AuditEventRecord>, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::get_security_logs(&conn, &session_token)
}

#[tauri::command]
fn finalize_sale(
    state: tauri::State<AppState>,
    session_token: String,
    mut payload: FinalizeSalePayload,
) -> Result<FinalizeSaleResult, String> {
    let mut conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    
    // Strict backend session & permission verification
    let session = auth::validate_session_and_permission(&conn, &session_token, "billing:finalize_sale")
        .map_err(|e| format!("Unauthorized: {}", e))?;

    // Enforce authentic actor identity & terminal context from validated session
    payload.cashier_id = session.user_id;
    payload.branch_id = session.branch_id.clone();
    payload.terminal_id = session.terminal_id.clone();
    payload.counter_id = session.counter_id.clone();
    payload.session_id = session.session_id.clone();

    // Dynamically assign series code matching the branch if default is used
    if payload.series_code.is_empty() || payload.series_code == "IB1" {
        payload.series_code = format!("{}1", session.branch_id);
    }

    // Dynamically assign financial year matching the business date
    if payload.financial_year.is_empty() || payload.financial_year == "2627" {
        payload.financial_year = transaction::derive_indian_financial_year(&payload.business_date);
    }

    finalize_sale_atomic(&mut conn, &payload, None)
        .map_err(|e| format!("Sale finalization failed: {}", e))
}

#[tauri::command]
fn sync_get_branch_config(
    state: tauri::State<AppState>,
    _session_token: Option<String>,
) -> Result<sync::BranchConfig, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let mut config = sync::get_branch_config(&conn)?;

    // Strict security guarantee: Never expose plaintext cloud API secrets over Tauri IPC to the webview
    config.cloud_api_key = if config.cloud_api_key.is_empty() {
        String::new()
    } else {
        "••••••••".to_string()
    };

    Ok(config)
}

#[tauri::command]
fn sync_set_branch_config(
    state: tauri::State<AppState>,
    session_token: String,
    config: sync::BranchConfig,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::save_branch_config(&conn, &session_token, &config)
}

#[tauri::command]
fn sync_get_status(state: tauri::State<AppState>) -> Result<sync::SyncStatusInfo, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::get_sync_status(&conn)
}

#[tauri::command]
fn sync_trigger_batch(
    state: tauri::State<AppState>,
    session_token: Option<String>,
) -> Result<sync::SyncBatchResult, String> {
    let mut conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::sync_outbox_batch(&mut conn, session_token.as_deref())
}

#[tauri::command]
fn sync_inbound_catalog(
    state: tauri::State<AppState>,
    session_token: Option<String>,
) -> Result<sync::InboundCatalogSyncResult, String> {
    let mut conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::sync_inbound_catalog(&mut conn, session_token.as_deref())
}

#[tauri::command]
fn sync_trigger_bidirectional(
    state: tauri::State<AppState>,
    session_token: Option<String>,
) -> Result<sync::BidirectionalSyncResult, String> {
    let mut conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::sync_bidirectional(&mut conn, session_token.as_deref())
}

#[tauri::command]
fn get_recent_sales(
    state: tauri::State<AppState>,
    session_token: String,
) -> Result<Vec<PersistedSaleSummary>, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let _session = auth::validate_session_and_permission(&conn, &session_token, "billing:reprint_receipt")
        .map_err(|e| format!("Unauthorized: {}", e))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, invoice_number, business_date, net_payable_paise, sale_status, payment_status, sync_status, created_at 
             FROM sales ORDER BY rowid DESC LIMIT 20;"
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(PersistedSaleSummary {
                id: row.get(0)?,
                invoice_number: row.get(1)?,
                business_date: row.get(2)?,
                net_payable_paise: row.get(3)?,
                sale_status: row.get(4)?,
                payment_status: row.get(5)?,
                sync_status: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for r in rows {
        if let Ok(sale) = r {
            result.push(sale);
        }
    }
    Ok(result)
}

#[tauri::command]
fn get_database_info(state: tauri::State<AppState>) -> Result<DatabaseInfo, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let journal_mode: String = conn.query_row("PRAGMA journal_mode;", [], |r| r.get(0)).unwrap_or_default();
    let total_sales: i64 = conn.query_row("SELECT COUNT(*) FROM sales;", [], |r| r.get(0)).unwrap_or(0);
    let pending_sync_count: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox WHERE status = 'PENDING';", [], |r| r.get(0)).unwrap_or(0);
    let db_path = get_database_path().to_string_lossy().to_string();
    Ok(DatabaseInfo {
        db_path,
        is_wal_active: journal_mode.to_lowercase() == "wal",
        total_sales,
        pending_sync_count,
    })
}

#[tauri::command]
fn create_backup(
    state: tauri::State<AppState>,
    session_token: String,
    dest_dir: Option<String>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let _session = auth::validate_session_and_permission(&conn, &session_token, "admin:create_backup")
        .map_err(|e| format!("Unauthorized: {}", e))?;

    let target_dir = dest_dir.unwrap_or_else(|| {
        let base_dir = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        base_dir.join("MalgudiMithaisPOS").join("backups").to_string_lossy().to_string()
    });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let filename_stem = format!("malgudi_backup_{}", now);
    let backup_path = malgudi_pos_native::backup::BackupManager::create_consistent_backup(
        &conn,
        &target_dir,
        &filename_stem,
    ).map_err(|e| format!("Backup creation failed: {}", e))?;

    Ok(backup_path.to_string_lossy().to_string())
}

#[tauri::command]
fn backup_run_scheduled(
    state: tauri::State<AppState>,
    session_token: String,
    dest_dir: Option<String>,
    max_retain: Option<usize>,
) -> Result<malgudi_pos_native::backup::ScheduledBackupResult, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let _session = auth::validate_session_and_permission(&conn, &session_token, "admin:create_backup")
        .map_err(|e| format!("Unauthorized: {}", e))?;

    let target_dir = dest_dir.unwrap_or_else(|| {
        let base_dir = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        base_dir.join("MalgudiMithaisPOS").join("backups").to_string_lossy().to_string()
    });

    malgudi_pos_native::backup::BackupManager::run_scheduled_backup_with_retention(
        &conn,
        &target_dir,
        max_retain.unwrap_or(7),
    )
}

#[tauri::command]
fn inventory_list_products(
    state: tauri::State<AppState>,
    branch_id: Option<String>,
    include_inactive: Option<bool>,
) -> Result<Vec<ProductRecord>, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let branch = branch_id.unwrap_or_else(|| {
        conn.query_row(
            "SELECT value FROM terminal_trust_state WHERE key = 'branch_id';",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "IB".to_string())
    });
    inventory::list_products(&conn, &branch, include_inactive.unwrap_or(false))
}

#[tauri::command]
fn inventory_create_product(
    state: tauri::State<AppState>,
    session_token: String,
    payload: CreateProductPayload,
) -> Result<ProductRecord, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::create_product(&conn, &session_token, &payload)
}

#[tauri::command]
fn inventory_update_product(
    state: tauri::State<AppState>,
    session_token: String,
    payload: UpdateProductPayload,
) -> Result<ProductRecord, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::update_product(&conn, &session_token, &payload)
}

#[tauri::command]
fn inventory_toggle_product_status(
    state: tauri::State<AppState>,
    session_token: String,
    product_id: String,
    is_active: bool,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::toggle_product_status(&conn, &session_token, &product_id, is_active)
}

#[tauri::command]
fn inventory_adjust_stock(
    state: tauri::State<AppState>,
    session_token: String,
    payload: AdjustStockPayload,
) -> Result<StockMovementRecord, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::adjust_stock(&conn, &session_token, &payload)
}

#[tauri::command]
fn inventory_list_movements(
    state: tauri::State<AppState>,
    session_token: String,
    product_id: Option<String>,
    branch_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<StockMovementRecord>, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::list_stock_movements(&conn, &session_token, product_id, branch_id, limit.unwrap_or(100))
}

#[tauri::command]
fn inventory_void_sale(
    state: tauri::State<AppState>,
    session_token: String,
    payload: VoidSalePayload,
) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::void_or_refund_sale(&mut conn, &session_token, &payload)
}

#[tauri::command]
fn reports_get_financial_reports(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<FinancialReportsAggregate, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_financial_reports_aggregate(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_daily_sales(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<DailySalesSummary, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_daily_sales_report(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_payment_summary(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<PaymentSummaryReport, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_payment_summary_report(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_gst_report(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<GstReport, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_gst_report(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_product_sales(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<ProductSalesReport, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_product_sales_report(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_cash_drawer(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<CashDrawerReport, String> {
    let conn = state.db.lock().map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_cash_drawer_report(&conn, &session_token, &filter)
}

pub fn get_database_path() -> std::path::PathBuf {
    #[cfg(debug_assertions)]
    {
        if let Ok(custom_path) = std::env::var("MALGUDI_DB_PATH") {
            let p = std::path::PathBuf::from(custom_path);
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            return p;
        }
        let base_dir = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        let dev_data_dir = base_dir.join("MalgudiMithaisPOS-Dev").join("data");
        let _ = std::fs::create_dir_all(&dev_data_dir);
        dev_data_dir.join("malgudi_pos_dev.db")
    }

    #[cfg(not(debug_assertions))]
    {
        let base_dir = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        let data_dir = base_dir.join("MalgudiMithaisPOS").join("data");
        let _ = std::fs::create_dir_all(&data_dir);
        data_dir.join("malgudi_pos.db")
    }
}

fn main() {
    let db_path = get_database_path();
    let conn = match DatabaseManager::open_writable(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[FATAL] Database initialization / integrity check failed: {}", e);
            // Non-destructive corruption handling:
            // Quarantine corrupted database with timestamp: .corrupted.<timestamp>.bak
            // Never automatically delete or overwrite the original database!
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);

            if db_path.exists() {
                let quarantine_path = db_path.with_extension(format!("corrupted.{}.bak", now_secs));
                eprintln!("[QUARANTINE] Preserving corrupted database to: {}", quarantine_path.display());
                let _ = std::fs::copy(&db_path, &quarantine_path);

                let wal_path = std::path::PathBuf::from(format!("{}-wal", db_path.display()));
                if wal_path.exists() {
                    let _ = std::fs::copy(&wal_path, db_path.with_extension(format!("corrupted.{}.wal.bak", now_secs)));
                }
            }

            panic!(
                "DATABASE INTEGRITY CHECK FAILURE: Corrupted database preserved non-destructively. Manual supervisor inspection required: {}",
                e
            );
        }
    };

    // Ensure default owner and staff accounts are seeded and ready
    let _ = DatabaseManager::seed_default_users(&conn);

    // Launch autonomous background sync worker (runs periodically every 20 seconds)
    sync::start_background_sync_worker(db_path, 20);

    tauri::Builder::default()
        .manage(AppState {
            db: Mutex::new(conn),
        })
        .invoke_handler(tauri::generate_handler![
            auth_get_status,
            auth_provision_owner,
            auth_login,
            auth_switch_cashier,
            auth_logout,
            auth_create_user,
            auth_update_user_status,
            auth_reset_user_pin,
            auth_list_users,
            auth_get_security_logs,
            finalize_sale,
            get_recent_sales,
            get_database_info,
            create_backup,
            backup_run_scheduled,
            inventory_list_products,
            inventory_create_product,
            inventory_update_product,
            inventory_toggle_product_status,
            inventory_adjust_stock,
            inventory_list_movements,
            inventory_void_sale,
            reports_get_financial_reports,
            reports_get_daily_sales,
            reports_get_payment_summary,
            reports_get_gst_report,
            reports_get_product_sales,
            reports_get_cash_drawer,
            sync_get_branch_config,
            sync_set_branch_config,
            sync_get_status,
            sync_trigger_batch,
            sync_inbound_catalog,
            sync_trigger_bidirectional
        ])
        .build(tauri::generate_context!())
        .expect("error while building Malgudi Mithais POS application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                sync::stop_background_sync_worker();
            }
        });
}

