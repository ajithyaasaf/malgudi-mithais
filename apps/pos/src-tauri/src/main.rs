#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use malgudi_pos_native::auth::{
    self, AuditEventRecord, AuthStatusResponse, CreateUserPayload, LoginPayload,
    ProvisionOwnerPayload, SessionInfo, SwitchCashierPayload, UserRecord,
};
use malgudi_pos_native::db::DatabaseManager;
use malgudi_pos_native::inventory::{
    self, AdjustStockPayload, CreateProductPayload, ProductRecord, StockMovementRecord,
    UpdateProductPayload, VoidSalePayload,
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
use std::sync::Mutex;

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

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct DetailedReceiptItem {
    pub product_id: String,
    pub product_name: String,
    pub tamil_name: String,
    pub pricing_unit: String,
    pub quantity_input: i64,
    pub quantity_formatted: String,
    pub unit_price_paise: i64,
    pub taxable_paise: i64,
    pub cgst_paise: i64,
    pub sgst_paise: i64,
    pub total_tax_paise: i64,
    pub gross_paise: i64,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct DetailedReceiptPayment {
    pub payment_method: String,
    pub allocated_amount_paise: i64,
    pub tendered_paise: i64,
    pub change_returned_paise: i64,
    pub net_amount_paise: i64,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct DetailedSaleReceipt {
    pub sale_id: String,
    pub invoice_number: String,
    pub business_date: String,
    pub created_at: String,
    pub cashier_name: String,
    pub terminal_id: String,
    pub branch_id: String,
    pub branch_name: String,
    pub subtotal_taxable_paise: i64,
    pub total_cgst_paise: i64,
    pub total_sgst_paise: i64,
    pub round_off_paise: i64,
    pub net_payable_paise: i64,
    pub sale_status: String,
    pub payment_status: String,
    pub items: Vec<DetailedReceiptItem>,
    pub payments: Vec<DetailedReceiptPayment>,
    #[serde(default)]
    pub customer_name: Option<String>,
    #[serde(default)]
    pub customer_phone: Option<String>,
    #[serde(default)]
    pub customer_location: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct OpeningFloatStatus {
    pub has_opening_float: bool,
    pub opening_float_paise: i64,
    pub session_id: String,
    pub business_date: String,
    pub recorded_at: Option<String>,
    pub is_day_closed: bool,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct DayEndSummary {
    pub business_date: String,
    pub branch_name: String,
    pub terminal_id: String,
    pub session_id: String,
    pub closed_by_user: String,
    pub closed_at: String,
    pub opening_float_paise: i64,
    pub cash_sales_paise: i64,
    pub cash_refunds_paise: i64,
    pub expected_closing_cash_paise: i64,
    pub counted_closing_cash_paise: i64,
    pub variance_paise: i64,
    pub variance_notes: Option<String>,
    pub total_bills_recorded: i64,
    pub active_bills_count: i64,
    pub voided_bills_count: i64,
    pub gross_sales_paise: i64,
    pub net_sales_paise: i64,
    pub cash_realized_paise: i64,
    pub upi_realized_paise: i64,
    pub total_taxable_paise: i64,
    pub total_cgst_paise: i64,
    pub total_sgst_paise: i64,
    pub total_tax_paise: i64,
    pub pending_sync_count: i64,
}

#[tauri::command]
fn auth_get_status(
    state: tauri::State<AppState>,
    session_token: Option<String>,
) -> Result<AuthStatusResponse, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
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
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::provision_first_owner(&conn, &payload)
}

#[tauri::command]
fn auth_login(state: tauri::State<AppState>, payload: LoginPayload) -> Result<SessionInfo, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::login(&conn, &payload)
}

#[tauri::command]
fn auth_switch_cashier(
    state: tauri::State<AppState>,
    payload: SwitchCashierPayload,
) -> Result<SessionInfo, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::switch_cashier(&conn, &payload)
}

#[tauri::command]
fn auth_logout(state: tauri::State<AppState>, session_token: String) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::logout(&conn, &session_token)
}

#[tauri::command]
fn auth_create_user(
    state: tauri::State<AppState>,
    session_token: String,
    payload: CreateUserPayload,
) -> Result<UserRecord, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::create_user(&conn, &session_token, &payload)
}

#[tauri::command]
fn auth_update_user_status(
    state: tauri::State<AppState>,
    session_token: String,
    user_id: String,
    status: String,
) -> Result<UserRecord, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::update_user_status(&conn, &session_token, &user_id, &status)
}

#[tauri::command]
fn auth_reset_user_pin(
    state: tauri::State<AppState>,
    session_token: String,
    user_id: String,
    new_pin: String,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::reset_user_pin(&conn, &session_token, &user_id, &new_pin)
}

#[tauri::command]
fn auth_list_users(
    state: tauri::State<AppState>,
    session_token: String,
) -> Result<Vec<UserRecord>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::list_users(&conn, &session_token)
}

#[tauri::command]
fn auth_get_security_logs(
    state: tauri::State<AppState>,
    session_token: String,
) -> Result<Vec<AuditEventRecord>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    auth::get_security_logs(&conn, &session_token)
}

#[tauri::command]
fn finalize_sale(
    state: tauri::State<AppState>,
    session_token: String,
    mut payload: FinalizeSalePayload,
) -> Result<FinalizeSaleResult, String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;

    // Strict backend session & permission verification
    let session =
        auth::validate_session_and_permission(&conn, &session_token, "billing:finalize_sale")
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
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
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
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::save_branch_config(&conn, &session_token, &config)
}

#[tauri::command]
fn sync_get_status(state: tauri::State<AppState>) -> Result<sync::SyncStatusInfo, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::get_sync_status(&conn)
}

#[tauri::command]
fn sync_trigger_batch(
    state: tauri::State<AppState>,
    session_token: Option<String>,
) -> Result<sync::SyncBatchResult, String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::sync_outbox_batch(&mut conn, session_token.as_deref())
}

#[tauri::command]
fn sync_inbound_catalog(
    state: tauri::State<AppState>,
    session_token: Option<String>,
) -> Result<sync::InboundCatalogSyncResult, String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::sync_inbound_catalog(&mut conn, session_token.as_deref())
}

#[tauri::command]
fn sync_trigger_bidirectional(
    state: tauri::State<AppState>,
    session_token: Option<String>,
) -> Result<sync::BidirectionalSyncResult, String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    sync::sync_bidirectional(&mut conn, session_token.as_deref())
}

#[tauri::command]
fn get_recent_sales(
    state: tauri::State<AppState>,
    session_token: String,
) -> Result<Vec<PersistedSaleSummary>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let _session =
        auth::validate_session_and_permission(&conn, &session_token, "billing:reprint_receipt")
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
fn get_sale_details(
    state: tauri::State<AppState>,
    session_token: String,
    invoice_or_sale_id: String,
) -> Result<DetailedSaleReceipt, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let _session =
        auth::validate_session_and_permission(&conn, &session_token, "billing:reprint_receipt")
            .map_err(|e| format!("Unauthorized: {}", e))?;

    let sale_row = conn.query_row(
        "SELECT s.id, s.invoice_number, s.business_date, s.created_at, s.cashier_id, s.terminal_id, s.branch_id,
                s.subtotal_taxable_paise, s.total_cgst_paise, s.total_sgst_paise, s.round_off_paise, s.net_payable_paise,
                s.sale_status, s.payment_status, COALESCE(u.display_name, s.cashier_id) as cashier_name,
                s.customer_name, s.customer_phone, s.customer_location
         FROM sales s
         LEFT JOIN users u ON u.id = s.cashier_id
         WHERE s.id = ?1 OR s.invoice_number = ?1;",
        [&invoice_or_sale_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, i64>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, i64>(11)?,
                r.get::<_, String>(12)?,
                r.get::<_, String>(13)?,
                r.get::<_, String>(14)?,
                r.get::<_, Option<String>>(15)?,
                r.get::<_, Option<String>>(16)?,
                r.get::<_, Option<String>>(17)?,
            ))
        },
    ).map_err(|e| format!("Sale not found: {}", e))?;

    let sale_id = sale_row.0;
    let branch_cfg = sync::get_branch_config(&conn).unwrap_or(sync::BranchConfig {
        branch_id: sale_row.6.clone(),
        branch_name: "Iyer Bungalow Branch (IB)".to_string(),
        terminal_id: sale_row.5.clone(),
        counter_id: "C1".to_string(),
        cloud_api_url: String::new(),
        cloud_api_key: String::new(),
        auto_sync_enabled: true,
    });

    let mut items_stmt = conn
        .prepare(
            "SELECT si.product_id, COALESCE(p.name, si.product_id), COALESCE(p.tamil_name, ''),
                si.pricing_unit, si.quantity_input, si.unit_price_paise, si.taxable_paise,
                si.cgst_paise, si.sgst_paise, si.total_tax_paise, si.gross_paise
         FROM sale_items si
         LEFT JOIN products p ON p.id = si.product_id
         WHERE si.sale_id = ?1;",
        )
        .map_err(|e| e.to_string())?;

    let item_rows = items_stmt
        .query_map([&sale_id], |r| {
            let pricing_unit: String = r.get(3)?;
            let qty_input: i64 = r.get(4)?;
            let qty_formatted = if pricing_unit == "PER_KG" {
                if qty_input >= 1000 {
                    format!("{:.3} kg", (qty_input as f64) / 1000.0)
                } else {
                    format!("{}g", qty_input)
                }
            } else {
                format!("{} pcs", qty_input)
            };

            Ok(DetailedReceiptItem {
                product_id: r.get(0)?,
                product_name: r.get(1)?,
                tamil_name: r.get(2)?,
                pricing_unit,
                quantity_input: qty_input,
                quantity_formatted: qty_formatted,
                unit_price_paise: r.get(5)?,
                taxable_paise: r.get(6)?,
                cgst_paise: r.get(7)?,
                sgst_paise: r.get(8)?,
                total_tax_paise: r.get(9)?,
                gross_paise: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for it in item_rows {
        if let Ok(item) = it {
            items.push(item);
        }
    }

    let mut pay_stmt = conn.prepare(
        "SELECT payment_method, allocated_amount_paise, tendered_paise, change_returned_paise, net_amount_paise
         FROM sale_payments
         WHERE sale_id = ?1;"
    ).map_err(|e| e.to_string())?;

    let pay_rows = pay_stmt
        .query_map([&sale_id], |r| {
            Ok(DetailedReceiptPayment {
                payment_method: r.get(0)?,
                allocated_amount_paise: r.get(1)?,
                tendered_paise: r.get(2)?,
                change_returned_paise: r.get(3)?,
                net_amount_paise: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut payments = Vec::new();
    for p in pay_rows {
        if let Ok(pay) = p {
            payments.push(pay);
        }
    }

    Ok(DetailedSaleReceipt {
        sale_id,
        invoice_number: sale_row.1,
        business_date: sale_row.2,
        created_at: sale_row.3,
        cashier_name: sale_row.14,
        terminal_id: sale_row.5,
        branch_id: sale_row.6,
        branch_name: branch_cfg.branch_name,
        subtotal_taxable_paise: sale_row.7,
        total_cgst_paise: sale_row.8,
        total_sgst_paise: sale_row.9,
        round_off_paise: sale_row.10,
        net_payable_paise: sale_row.11,
        sale_status: sale_row.12,
        payment_status: sale_row.13,
        items,
        payments,
        customer_name: sale_row.15,
        customer_phone: sale_row.16,
        customer_location: sale_row.17,
    })
}

#[tauri::command]
fn cash_check_opening_float(
    state: tauri::State<AppState>,
    session_token: String,
) -> Result<OpeningFloatStatus, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let session = auth::validate_session_and_permission(&conn, &session_token, "")
        .map_err(|e| format!("Unauthorized: {}", e))?;

    let now_iso = inventory::get_iso_now();
    let today = if now_iso.len() >= 10 {
        now_iso[0..10].to_string()
    } else {
        "2026-10-14".to_string()
    };

    let opening_float: Result<(i64, String), _> = conn.query_row(
        "SELECT amount_paise, created_at FROM cash_movements WHERE movement_type = 'OPENING_FLOAT' AND (session_id = ?1 OR SUBSTR(created_at, 1, 10) = ?2);",
        [&session.session_id, &today],
        |r| Ok((r.get(0)?, r.get(1)?)),
    );

    let has_closed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cash_movements WHERE movement_type = 'CLOSING_COUNT' AND (session_id = ?1 OR SUBSTR(created_at, 1, 10) = ?2);",
        [&session.session_id, &today],
        |r| r.get(0),
    ).unwrap_or(0);

    match opening_float {
        Ok((amt, dt)) => Ok(OpeningFloatStatus {
            has_opening_float: true,
            opening_float_paise: amt,
            session_id: session.session_id,
            business_date: today,
            recorded_at: Some(dt),
            is_day_closed: has_closed > 0,
        }),
        Err(_) => Ok(OpeningFloatStatus {
            has_opening_float: false,
            opening_float_paise: 0,
            session_id: session.session_id,
            business_date: today,
            recorded_at: None,
            is_day_closed: false,
        }),
    }
}

#[tauri::command]
fn cash_record_opening_float(
    state: tauri::State<AppState>,
    session_token: String,
    amount_paise: i64,
    notes: Option<String>,
) -> Result<OpeningFloatStatus, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let session =
        auth::validate_session_and_permission(&conn, &session_token, "billing:finalize_sale")
            .map_err(|e| format!("Unauthorized: {}", e))?;

    if amount_paise < 0 {
        return Err("Starting cash float cannot be negative.".to_string());
    }

    let now_iso = inventory::get_iso_now();
    let today = if now_iso.len() >= 10 {
        now_iso[0..10].to_string()
    } else {
        "2026-10-14".to_string()
    };

    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cash_movements WHERE movement_type = 'OPENING_FLOAT' AND (session_id = ?1 OR SUBSTR(created_at, 1, 10) = ?2);",
        [&session.session_id, &today],
        |r| r.get(0),
    ).unwrap_or(0);

    if existing > 0 {
        return Err("Opening float has already been recorded for today.".to_string());
    }

    let id = format!(
        "mov_flt_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let branch_id = session.branch_id.clone();
    let ref_note = notes.unwrap_or_else(|| "Morning Opening Cash Float".to_string());

    conn.execute(
        "INSERT INTO cash_movements (id, session_id, branch_id, movement_type, amount_paise, direction, reference_id, created_at)
         VALUES (?1, ?2, ?3, 'OPENING_FLOAT', ?4, 'IN', ?5, ?6);",
        rusqlite::params![id, session.session_id, branch_id, amount_paise, ref_note, now_iso],
    ).map_err(|e| format!("Failed to record opening float: {}", e))?;

    Ok(OpeningFloatStatus {
        has_opening_float: true,
        opening_float_paise: amount_paise,
        session_id: session.session_id,
        business_date: today,
        recorded_at: Some(now_iso),
        is_day_closed: false,
    })
}

#[tauri::command]
fn cash_record_day_close(
    state: tauri::State<AppState>,
    session_token: String,
    counted_cash_paise: i64,
    notes: Option<String>,
) -> Result<DayEndSummary, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let session = auth::validate_session_and_permission(&conn, &session_token, "")
        .map_err(|e| format!("Unauthorized: {}", e))?;

    let now_iso = inventory::get_iso_now();
    let today = if now_iso.len() >= 10 {
        now_iso[0..10].to_string()
    } else {
        "2026-10-14".to_string()
    };
    let branch_cfg = sync::get_branch_config(&conn).unwrap_or(sync::BranchConfig {
        branch_id: "IB".to_string(),
        branch_name: "Iyer Bungalow Branch (IB)".to_string(),
        terminal_id: "T1".to_string(),
        counter_id: "C1".to_string(),
        cloud_api_url: String::new(),
        cloud_api_key: String::new(),
        auto_sync_enabled: true,
    });
    let branch_id = branch_cfg.branch_id.clone();

    let id = format!(
        "mov_cls_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let ref_note = notes
        .clone()
        .unwrap_or_else(|| "Day-End Cash Drawer Closure".to_string());

    conn.execute(
        "INSERT INTO cash_movements (id, session_id, branch_id, movement_type, amount_paise, direction, reference_id, created_at)
         VALUES (?1, ?2, ?3, 'CLOSING_COUNT', ?4, 'IN', ?5, ?6);",
        rusqlite::params![id, session.session_id, branch_id, counted_cash_paise, ref_note, now_iso],
    ).map_err(|e| format!("Failed to record closing count: {}", e))?;

    let filter = reports::ReportFilterPayload {
        start_date: Some(today.clone()),
        end_date: Some(today.clone()),
        branch_id: Some(branch_id),
    };

    let reports_agg = reports::get_financial_reports_aggregate(&conn, &session_token, &filter)?;
    let drawer = reports_agg.cash_drawer;
    let daily = reports_agg.daily_sales;
    let pm = reports_agg.payment_summary;
    let gst = reports_agg.gst_report;

    let pending_sync_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_outbox WHERE status = 'PENDING';",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let variance = counted_cash_paise - drawer.expected_closing_cash_paise;

    Ok(DayEndSummary {
        business_date: today,
        branch_name: branch_cfg.branch_name,
        terminal_id: branch_cfg.terminal_id,
        session_id: session.session_id,
        closed_by_user: session.username,
        closed_at: now_iso,
        opening_float_paise: drawer.opening_float_paise,
        cash_sales_paise: drawer.cash_sales_inflow_paise,
        cash_refunds_paise: drawer.cash_refunds_outflow_paise,
        expected_closing_cash_paise: drawer.expected_closing_cash_paise,
        counted_closing_cash_paise: counted_cash_paise,
        variance_paise: variance,
        variance_notes: notes,
        total_bills_recorded: daily.total_bills_recorded,
        active_bills_count: daily.active_bills_count,
        voided_bills_count: daily.voided_bills_count,
        gross_sales_paise: daily.gross_sales_paise,
        net_sales_paise: daily.net_sales_paise,
        cash_realized_paise: pm.net_cash_paise,
        upi_realized_paise: pm.net_upi_paise,
        total_taxable_paise: gst.total_taxable_paise,
        total_cgst_paise: gst.total_cgst_paise,
        total_sgst_paise: gst.total_sgst_paise,
        total_tax_paise: gst.total_gst_paise,
        pending_sync_count,
    })
}

#[tauri::command]
fn get_day_end_report(
    state: tauri::State<AppState>,
    session_token: String,
    target_date: String,
) -> Result<DayEndSummary, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let session = auth::validate_session_and_permission(&conn, &session_token, "")
        .map_err(|e| format!("Unauthorized: {}", e))?;

    let branch_cfg = sync::get_branch_config(&conn).unwrap_or(sync::BranchConfig {
        branch_id: "IB".to_string(),
        branch_name: "Iyer Bungalow Branch (IB)".to_string(),
        terminal_id: "T1".to_string(),
        counter_id: "C1".to_string(),
        cloud_api_url: String::new(),
        cloud_api_key: String::new(),
        auto_sync_enabled: true,
    });
    let branch_id = branch_cfg.branch_id.clone();

    let filter = reports::ReportFilterPayload {
        start_date: Some(target_date.clone()),
        end_date: Some(target_date.clone()),
        branch_id: Some(branch_id),
    };

    let reports_agg = reports::get_financial_reports_aggregate(&conn, &session_token, &filter)?;
    let drawer = reports_agg.cash_drawer;
    let daily = reports_agg.daily_sales;
    let pm = reports_agg.payment_summary;
    let gst = reports_agg.gst_report;

    let pending_sync_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_outbox WHERE status = 'PENDING';",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let counted = drawer
        .recorded_closing_cash_paise
        .unwrap_or(drawer.expected_closing_cash_paise);
    let variance = drawer.variance_paise.unwrap_or(0);

    Ok(DayEndSummary {
        business_date: target_date,
        branch_name: branch_cfg.branch_name,
        terminal_id: branch_cfg.terminal_id,
        session_id: drawer.session_id.unwrap_or_else(|| session.session_id),
        closed_by_user: session.username,
        closed_at: inventory::get_iso_now(),
        opening_float_paise: drawer.opening_float_paise,
        cash_sales_paise: drawer.cash_sales_inflow_paise,
        cash_refunds_paise: drawer.cash_refunds_outflow_paise,
        expected_closing_cash_paise: drawer.expected_closing_cash_paise,
        counted_closing_cash_paise: counted,
        variance_paise: variance,
        variance_notes: None,
        total_bills_recorded: daily.total_bills_recorded,
        active_bills_count: daily.active_bills_count,
        voided_bills_count: daily.voided_bills_count,
        gross_sales_paise: daily.gross_sales_paise,
        net_sales_paise: daily.net_sales_paise,
        cash_realized_paise: pm.net_cash_paise,
        upi_realized_paise: pm.net_upi_paise,
        total_taxable_paise: gst.total_taxable_paise,
        total_cgst_paise: gst.total_cgst_paise,
        total_sgst_paise: gst.total_sgst_paise,
        total_tax_paise: gst.total_gst_paise,
        pending_sync_count,
    })
}

#[tauri::command]
fn get_database_info(state: tauri::State<AppState>) -> Result<DatabaseInfo, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
        .unwrap_or_default();
    let total_sales: i64 = conn
        .query_row("SELECT COUNT(*) FROM sales;", [], |r| r.get(0))
        .unwrap_or(0);
    let pending_sync_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_outbox WHERE status = 'PENDING';",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
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
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let _session =
        auth::validate_session_and_permission(&conn, &session_token, "admin:create_backup")
            .map_err(|e| format!("Unauthorized: {}", e))?;

    let target_dir = dest_dir.unwrap_or_else(|| {
        let base_dir = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        base_dir
            .join("MalgudiMithaisPOS")
            .join("backups")
            .to_string_lossy()
            .to_string()
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
    )
    .map_err(|e| format!("Backup creation failed: {}", e))?;

    Ok(backup_path.to_string_lossy().to_string())
}

#[tauri::command]
fn backup_run_scheduled(
    state: tauri::State<AppState>,
    session_token: String,
    dest_dir: Option<String>,
    max_retain: Option<usize>,
) -> Result<malgudi_pos_native::backup::ScheduledBackupResult, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    let _session =
        auth::validate_session_and_permission(&conn, &session_token, "admin:create_backup")
            .map_err(|e| format!("Unauthorized: {}", e))?;

    let target_dir = dest_dir.unwrap_or_else(|| {
        let base_dir = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        base_dir
            .join("MalgudiMithaisPOS")
            .join("backups")
            .to_string_lossy()
            .to_string()
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
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
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
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::create_product(&conn, &session_token, &payload)
}

#[tauri::command]
fn inventory_update_product(
    state: tauri::State<AppState>,
    session_token: String,
    payload: UpdateProductPayload,
) -> Result<ProductRecord, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::update_product(&conn, &session_token, &payload)
}

#[tauri::command]
fn inventory_toggle_product_status(
    state: tauri::State<AppState>,
    session_token: String,
    product_id: String,
    is_active: bool,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::toggle_product_status(&conn, &session_token, &product_id, is_active)
}

#[tauri::command]
fn inventory_adjust_stock(
    state: tauri::State<AppState>,
    session_token: String,
    payload: AdjustStockPayload,
) -> Result<StockMovementRecord, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
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
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::list_stock_movements(
        &conn,
        &session_token,
        product_id,
        branch_id,
        limit.unwrap_or(100),
    )
}

#[tauri::command]
fn inventory_void_sale(
    state: tauri::State<AppState>,
    session_token: String,
    payload: VoidSalePayload,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    inventory::void_or_refund_sale(&mut conn, &session_token, &payload)
}

#[tauri::command]
fn reports_get_financial_reports(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<FinancialReportsAggregate, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_financial_reports_aggregate(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_daily_sales(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<DailySalesSummary, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_daily_sales_report(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_payment_summary(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<PaymentSummaryReport, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_payment_summary_report(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_gst_report(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<GstReport, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_gst_report(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_product_sales(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<ProductSalesReport, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
    reports::get_product_sales_report(&conn, &session_token, &filter)
}

#[tauri::command]
fn reports_get_cash_drawer(
    state: tauri::State<AppState>,
    session_token: String,
    filter: ReportFilterPayload,
) -> Result<CashDrawerReport, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("Mutex lock poisoned: {}", e))?;
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
            eprintln!(
                "[FATAL] Database initialization / integrity check failed: {}",
                e
            );
            // Non-destructive corruption handling:
            // Quarantine corrupted database with timestamp: .corrupted.<timestamp>.bak
            // Never automatically delete or overwrite the original database!
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);

            if db_path.exists() {
                let quarantine_path = db_path.with_extension(format!("corrupted.{}.bak", now_secs));
                eprintln!(
                    "[QUARANTINE] Preserving corrupted database to: {}",
                    quarantine_path.display()
                );
                let _ = std::fs::copy(&db_path, &quarantine_path);

                let wal_path = std::path::PathBuf::from(format!("{}-wal", db_path.display()));
                if wal_path.exists() {
                    let _ = std::fs::copy(
                        &wal_path,
                        db_path.with_extension(format!("corrupted.{}.wal.bak", now_secs)),
                    );
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            get_sale_details,
            cash_check_opening_float,
            cash_record_opening_float,
            cash_record_day_close,
            get_day_end_report,
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
