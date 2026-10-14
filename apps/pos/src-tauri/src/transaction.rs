use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn user_error(msg: &str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::Other,
        msg,
    )))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SaleItemInput {
    pub product_id: String,
    pub quantity_input: i64,
    pub pricing_unit: String,
    pub weight_input_source: String,
    pub unit_price_paise: i64,
    pub taxable_paise: i64,
    pub cgst_paise: i64,
    pub sgst_paise: i64,
    pub igst_paise: i64,
    pub total_tax_paise: i64,
    pub gross_paise: i64,
    pub stock_deduction_delta: i64,
    pub stock_unit: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SalePaymentInput {
    pub payment_method: String,
    pub allocated_amount_paise: i64,
    pub tendered_paise: i64,
    pub change_returned_paise: i64,
    pub net_amount_paise: i64,
    pub outcome: String,
    pub reference_note: Option<String>,
    pub verified_by_user_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct FinalizeSalePayload {
    pub sale_id: Option<String>,
    pub branch_id: String,
    pub counter_id: String,
    pub terminal_id: String,
    pub session_id: String,
    pub business_date: String,
    pub series_code: String,
    pub financial_year: String,
    pub tax_policy_version: String,
    pub subtotal_taxable_paise: i64,
    pub total_cgst_paise: i64,
    pub total_sgst_paise: i64,
    pub total_igst_paise: i64,
    pub round_off_paise: i64,
    pub net_payable_paise: i64,
    pub items: Vec<SaleItemInput>,
    pub payments: Vec<SalePaymentInput>,
    pub cashier_id: String,
    #[serde(default)]
    pub customer_name: Option<String>,
    #[serde(default)]
    pub customer_phone: Option<String>,
    #[serde(default)]
    pub customer_location: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FinalizeSaleResult {
    pub sale_id: String,
    pub invoice_number: String,
    pub event_id: String,
    pub payload_hash: String,
}

/// Derives the 4-digit Indian Financial Year code (e.g. "2627" for 2026-04-01 to 2027-03-31)
/// from a date string (YYYY-MM-DD or ISO-8601).
pub fn derive_indian_financial_year(date_str: &str) -> String {
    let date_part = date_str.split('T').next().unwrap_or(date_str);
    let parts: Vec<&str> = date_part.split('-').collect();
    if parts.len() >= 2 {
        if let (Ok(year), Ok(month)) = (parts[0].parse::<i32>(), parts[1].parse::<u32>()) {
            let start_year = if month >= 4 { year } else { year - 1 };
            let start_yy = (start_year % 100).abs();
            let end_yy = ((start_year + 1) % 100).abs();
            return format!("{:02}{:02}", start_yy, end_yy);
        }
    }
    "2627".to_string()
}

/// Executes the 8-boundary atomic sale finalization holding a single SQLite transaction.
pub fn finalize_sale_atomic(
    conn: &mut Connection,
    payload: &FinalizeSalePayload,
    fault_boundary_to_abort: Option<u8>,
) -> Result<FinalizeSaleResult> {
    let tx = conn.transaction()?;

    // Derive financial year dynamically if missing or default
    let fy = if payload.financial_year.is_empty() {
        derive_indian_financial_year(&payload.business_date)
    } else {
        payload.financial_year.clone()
    };

    // Boundary 1: Invoice sequence allocation & formatted invoice generation
    let next_seq: i64 = {
        tx.execute(
            "INSERT OR IGNORE INTO invoice_series (series_code, financial_year, current_seq) VALUES (?1, ?2, 0);",
            [&payload.series_code, &fy],
        )?;
        let mut seq_stmt = tx.prepare(
            "UPDATE invoice_series 
             SET current_seq = current_seq + 1 
             WHERE series_code = ?1 AND financial_year = ?2 
             RETURNING current_seq;",
        )?;
        seq_stmt.query_row([&payload.series_code, &fy], |r| r.get(0))?
    };
    let invoice_number = format!("{}/{}/{:06}", payload.series_code, fy, next_seq);

    if fault_boundary_to_abort == Some(1) {
        return Err(user_error("FAULT_INJECTION_BOUNDARY_1_ABORT"));
    }

    // Boundary 2: Insert parent `sales` record
    let sale_id = payload
        .sale_id
        .clone()
        .unwrap_or_else(|| Uuid::now_v7().to_string());
    let now_iso = chrono_lite_iso8601();
    tx.execute(
        "INSERT INTO sales (
            id, invoice_number, branch_id, counter_id, terminal_id, session_id,
            business_date, tax_policy_version, subtotal_taxable_paise, total_cgst_paise,
            total_sgst_paise, total_igst_paise, round_off_paise, net_payable_paise,
            sale_status, payment_status, sync_status, customer_name, customer_phone, customer_location, created_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'FINALIZED', 'SETTLED', 'SYNC_PENDING', ?15, ?16, ?17, ?18
        );",
        rusqlite::params![
            sale_id,
            invoice_number,
            payload.branch_id,
            payload.counter_id,
            payload.terminal_id,
            payload.session_id,
            payload.business_date,
            payload.tax_policy_version,
            payload.subtotal_taxable_paise,
            payload.total_cgst_paise,
            payload.total_sgst_paise,
            payload.total_igst_paise,
            payload.round_off_paise,
            payload.net_payable_paise,
            payload.customer_name,
            payload.customer_phone,
            payload.customer_location,
            now_iso
        ],
    )?;

    if fault_boundary_to_abort == Some(2) {
        return Err(user_error("FAULT_INJECTION_BOUNDARY_2_ABORT"));
    }

    // Boundary 3: Insert `sale_items` rows
    for item in &payload.items {
        let item_id = Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO sale_items (
                id, sale_id, product_id, quantity_input, pricing_unit, weight_input_source,
                unit_price_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise,
                total_tax_paise, gross_paise, stock_deduction_delta, stock_unit
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15);",
            rusqlite::params![
                item_id,
                sale_id,
                item.product_id,
                item.quantity_input,
                item.pricing_unit,
                item.weight_input_source,
                item.unit_price_paise,
                item.taxable_paise,
                item.cgst_paise,
                item.sgst_paise,
                item.igst_paise,
                item.total_tax_paise,
                item.gross_paise,
                item.stock_deduction_delta,
                item.stock_unit
            ],
        )?;
    }

    if fault_boundary_to_abort == Some(3) {
        return Err(user_error("FAULT_INJECTION_BOUNDARY_3_ABORT"));
    }

    // Boundary 4: Insert `sale_payments` rows
    let mut total_cash_net_paise: i64 = 0;
    for pay in &payload.payments {
        let payment_id = Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO sale_payments (
                id, sale_id, payment_method, allocated_amount_paise, tendered_paise,
                change_returned_paise, net_amount_paise, outcome, reference_note, verified_by_user_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
            rusqlite::params![
                payment_id,
                sale_id,
                pay.payment_method,
                pay.allocated_amount_paise,
                pay.tendered_paise,
                pay.change_returned_paise,
                pay.net_amount_paise,
                pay.outcome,
                pay.reference_note,
                pay.verified_by_user_id
            ],
        )?;
        if pay.payment_method == "CASH" {
            total_cash_net_paise += pay.net_amount_paise;
        }
    }

    if fault_boundary_to_abort == Some(4) {
        return Err(user_error("FAULT_INJECTION_BOUNDARY_4_ABORT"));
    }

    // Boundary 5: Insert `cash_movements` (strictly if cash allocated)
    if total_cash_net_paise > 0 {
        let cm_id = Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO cash_movements (
                id, session_id, branch_id, movement_type, amount_paise, direction, reference_id, created_at
            ) VALUES (?1, ?2, ?3, 'CASH_SALE', ?4, 'IN', ?5, ?6);",
            rusqlite::params![
                cm_id,
                payload.session_id,
                payload.branch_id,
                total_cash_net_paise,
                sale_id,
                now_iso
            ],
        )?;
    }

    if fault_boundary_to_abort == Some(5) {
        return Err(user_error("FAULT_INJECTION_BOUNDARY_5_ABORT"));
    }

    // Boundary 6: Insert `stock_movements` and update `stock_balances` (for physical inventory items)
    for item in &payload.items {
        if item.stock_deduction_delta != 0 {
            let sm_id = Uuid::now_v7().to_string();
            let deduction = -item.stock_deduction_delta.abs();
            tx.execute(
                "INSERT INTO stock_movements (
                    id, branch_id, product_id, movement_type, quantity_delta, unit, reference_id, created_at, reason, actor_id
                ) VALUES (?1, ?2, ?3, 'SALE_DEDUCTION', ?4, ?5, ?6, ?7, 'Billing Point-of-Sale deduction', ?8);",
                rusqlite::params![
                    sm_id,
                    payload.branch_id,
                    item.product_id,
                    deduction,
                    item.stock_unit,
                    sale_id,
                    now_iso,
                    payload.cashier_id
                ],
            )?;

            // Update instant live branch stock balance
            tx.execute(
                "INSERT INTO stock_balances (branch_id, product_id, current_quantity, unit, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(branch_id, product_id) DO UPDATE SET
                     current_quantity = current_quantity + excluded.current_quantity,
                     updated_at = excluded.updated_at;",
                rusqlite::params![
                    payload.branch_id,
                    item.product_id,
                    deduction,
                    item.stock_unit,
                    now_iso
                ],
            )?;
        }
    }

    if fault_boundary_to_abort == Some(6) {
        return Err(user_error("FAULT_INJECTION_BOUNDARY_6_ABORT"));
    }

    // Boundary 7: Outbox and Audit rows
    let event_id = Uuid::now_v7().to_string();
    let audit_id = Uuid::now_v7().to_string();
    let payload_json = serde_json::to_string(payload).unwrap_or_default();

    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    let payload_hash = format!("{:x}", hasher.finalize());

    tx.execute(
        "INSERT INTO sync_outbox (
            event_id, aggregate_type, aggregate_id, event_seq, payload_json, payload_hash, status, created_at
        ) VALUES (?1, 'SALE', ?2, 1, ?3, ?4, 'PENDING', ?5);",
        rusqlite::params![event_id, sale_id, payload_json, payload_hash, now_iso],
    )?;

    tx.execute(
        "INSERT INTO audit_events (
            id, action, entity_type, entity_id, actor_id, created_at
        ) VALUES (?1, 'SALE_FINALIZED', 'SALE', ?2, ?3, ?4);",
        rusqlite::params![audit_id, sale_id, payload.cashier_id, now_iso],
    )?;

    if fault_boundary_to_abort == Some(7) {
        return Err(user_error("FAULT_INJECTION_BOUNDARY_7_ABORT"));
    }

    // Boundary 8: Commit transaction with synchronous = FULL durability
    tx.commit()?;

    Ok(FinalizeSaleResult {
        sale_id,
        invoice_number,
        event_id,
        payload_hash,
    })
}

fn chrono_lite_iso8601() -> String {
    crate::inventory::get_iso_now()
}
