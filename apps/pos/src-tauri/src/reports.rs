use crate::auth::validate_session_and_permission;
use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReportFilterPayload {
    pub start_date: Option<String>, // "YYYY-MM-DD"
    pub end_date: Option<String>,   // "YYYY-MM-DD"
    pub branch_id: Option<String>,  // e.g. "IB"
}

// ============================================================================
// 1. DAILY SALES REPORT MODELS
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DailySalesSummary {
    pub total_bills_recorded: i64,
    pub active_bills_count: i64,
    pub voided_bills_count: i64,
    pub gross_sales_paise: i64,
    pub taxable_sales_paise: i64,
    pub total_cgst_paise: i64,
    pub total_sgst_paise: i64,
    pub total_igst_paise: i64,
    pub total_tax_paise: i64,
    pub round_off_paise: i64,
    pub voided_amount_paise: i64,
    pub net_sales_paise: i64,
    pub daily_breakdown: Vec<DailySalesRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DailySalesRow {
    pub business_date: String,
    pub total_bills: i64,
    pub active_bills: i64,
    pub voided_bills: i64,
    pub taxable_sales_paise: i64,
    pub total_tax_paise: i64,
    pub gross_sales_paise: i64,
    pub voided_amount_paise: i64,
    pub net_sales_paise: i64,
}

// ============================================================================
// 2. PAYMENT SUMMARY REPORT MODELS
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaymentSummaryReport {
    pub total_cash_collected_paise: i64,
    pub total_cash_tendered_paise: i64,
    pub total_change_returned_paise: i64,
    pub total_upi_collected_paise: i64,
    pub total_split_bills_count: i64,
    pub total_split_amount_paise: i64,
    pub cash_refunds_paise: i64,
    pub upi_refunds_paise: i64,
    pub net_cash_paise: i64,
    pub net_upi_paise: i64,
    pub total_net_collected_paise: i64,
    pub methods_breakdown: Vec<PaymentMethodRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaymentMethodRow {
    pub payment_method: String,
    pub bills_count: i64,
    pub total_collected_paise: i64,
    pub refunds_paise: i64,
    pub net_amount_paise: i64,
}

// ============================================================================
// 3. GST REPORT MODELS
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GstReport {
    pub total_taxable_paise: i64,
    pub total_cgst_paise: i64,
    pub total_sgst_paise: i64,
    pub total_igst_paise: i64,
    pub total_gst_paise: i64,
    pub total_invoice_value_paise: i64,
    pub slabs_breakdown: Vec<GstSlabRow>,
    pub invoice_details: Vec<GstInvoiceRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GstSlabRow {
    pub tax_rate_percent: f64,
    pub taxable_paise: i64,
    pub cgst_paise: i64,
    pub sgst_paise: i64,
    pub igst_paise: i64,
    pub total_tax_paise: i64,
    pub total_gross_paise: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GstInvoiceRow {
    pub invoice_number: String,
    pub business_date: String,
    pub created_at: String,
    pub sale_status: String,
    pub taxable_paise: i64,
    pub cgst_paise: i64,
    pub sgst_paise: i64,
    pub igst_paise: i64,
    pub total_tax_paise: i64,
    pub round_off_paise: i64,
    pub net_payable_paise: i64,
    pub hsn_summary: String,
}

// ============================================================================
// 4. PRODUCT SALES REPORT MODELS
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProductSalesReport {
    pub total_items_sold_count: i64,
    pub total_revenue_paise: i64,
    pub products: Vec<ProductSalesRow>,
    pub categories: Vec<CategorySalesRow>,
    pub top_selling: Vec<ProductSalesRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProductSalesRow {
    pub product_id: String,
    pub product_name: String,
    pub tamil_name: String,
    pub sku: String,
    pub category_id: String,
    pub pricing_unit: String,
    pub total_quantity_canonical: i64,
    pub quantity_formatted: String,
    pub bills_count: i64,
    pub taxable_paise: i64,
    pub tax_paise: i64,
    pub gross_paise: i64,
    pub revenue_share_percent: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CategorySalesRow {
    pub category_id: String,
    pub category_name: String,
    pub items_count: i64,
    pub taxable_paise: i64,
    pub tax_paise: i64,
    pub gross_paise: i64,
    pub revenue_share_percent: f64,
}

// ============================================================================
// 5. CASH DRAWER REPORT MODELS
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CashDrawerReport {
    pub session_id: Option<String>,
    pub opening_float_paise: i64,
    pub cash_sales_inflow_paise: i64,
    pub cash_refunds_outflow_paise: i64,
    pub manual_inflows_paise: i64,
    pub manual_outflows_paise: i64,
    pub net_cash_change_paise: i64,
    pub expected_closing_cash_paise: i64,
    pub recorded_closing_cash_paise: Option<i64>,
    pub variance_paise: Option<i64>,
    pub movements: Vec<CashMovementRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CashMovementRow {
    pub id: String,
    pub created_at: String,
    pub movement_type: String,
    pub direction: String,
    pub amount_paise: i64,
    pub reference_id: String,
    pub session_id: String,
}

// ============================================================================
// UNIFIED FINANCIAL REPORTS AGGREGATE
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FinancialReportsAggregate {
    pub filter: ReportFilterPayload,
    pub daily_sales: DailySalesSummary,
    pub payment_summary: PaymentSummaryReport,
    pub gst_report: GstReport,
    pub product_sales: ProductSalesReport,
    pub cash_drawer: CashDrawerReport,
}

// Helper: build SQL date and branch filtering
fn build_filter_clauses(filter: &ReportFilterPayload) -> (String, Vec<rusqlite::types::Value>) {
    let mut clauses = Vec::new();
    let mut params = Vec::new();

    if let Some(start) = &filter.start_date {
        let trimmed = start.trim();
        if !trimmed.is_empty() {
            clauses.push("business_date >= ?");
            params.push(rusqlite::types::Value::Text(trimmed.to_string()));
        }
    }

    if let Some(end) = &filter.end_date {
        let trimmed = end.trim();
        if !trimmed.is_empty() {
            clauses.push("business_date <= ?");
            params.push(rusqlite::types::Value::Text(trimmed.to_string()));
        }
    }

    if let Some(branch) = &filter.branch_id {
        let trimmed = branch.trim();
        if !trimmed.is_empty() {
            clauses.push("branch_id = ?");
            params.push(rusqlite::types::Value::Text(trimmed.to_string()));
        }
    }

    let sql = if clauses.is_empty() {
        "".to_string()
    } else {
        format!(" AND {}", clauses.join(" AND "))
    };

    (sql, params)
}

// ============================================================================
// REPORT IMPLEMENTATIONS
// ============================================================================

/// 1. Generates Daily Sales Report
pub fn get_daily_sales_report(
    conn: &Connection,
    session_token: &str,
    filter: &ReportFilterPayload,
) -> Result<DailySalesSummary, String> {
    let _session = validate_session_and_permission(conn, session_token, "admin:view_reports")?;

    let (filter_sql, params_vec) = build_filter_clauses(filter);

    // Active bills summary
    let active_query = format!(
        "SELECT 
            COUNT(id),
            COALESCE(SUM(subtotal_taxable_paise), 0),
            COALESCE(SUM(total_cgst_paise), 0),
            COALESCE(SUM(total_sgst_paise), 0),
            COALESCE(SUM(total_igst_paise), 0),
            COALESCE(SUM(round_off_paise), 0),
            COALESCE(SUM(net_payable_paise), 0)
         FROM sales 
         WHERE sale_status != 'VOIDED' {}",
        filter_sql
    );

    let mut active_stmt = conn
        .prepare(&active_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let active_row: (i64, i64, i64, i64, i64, i64, i64) = active_stmt
        .query_row(rusqlite::params_from_iter(params_vec.clone()), |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .unwrap_or((0, 0, 0, 0, 0, 0, 0));

    // Voided bills summary
    let voided_query = format!(
        "SELECT COUNT(id), COALESCE(SUM(net_payable_paise), 0)
         FROM sales 
         WHERE sale_status = 'VOIDED' {}",
        filter_sql
    );
    let mut voided_stmt = conn
        .prepare(&voided_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let (voided_count, voided_amount): (i64, i64) = voided_stmt
        .query_row(rusqlite::params_from_iter(params_vec.clone()), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap_or((0, 0));

    let active_bills_count = active_row.0;
    let taxable_sales_paise = active_row.1;
    let total_cgst_paise = active_row.2;
    let total_sgst_paise = active_row.3;
    let total_igst_paise = active_row.4;
    let total_tax_paise = total_cgst_paise + total_sgst_paise + total_igst_paise;
    let round_off_paise = active_row.5;
    let gross_sales_paise = active_row.6;
    let net_sales_paise = gross_sales_paise; // Active gross sales represents actual retained revenue

    // Daily breakdown
    let daily_query = format!(
        "SELECT 
            business_date,
            COUNT(id) AS total_bills,
            SUM(CASE WHEN sale_status != 'VOIDED' THEN 1 ELSE 0 END) AS active_bills,
            SUM(CASE WHEN sale_status = 'VOIDED' THEN 1 ELSE 0 END) AS voided_bills,
            COALESCE(SUM(CASE WHEN sale_status != 'VOIDED' THEN subtotal_taxable_paise ELSE 0 END), 0) AS taxable_sales,
            COALESCE(SUM(CASE WHEN sale_status != 'VOIDED' THEN total_cgst_paise + total_sgst_paise + total_igst_paise ELSE 0 END), 0) AS total_tax,
            COALESCE(SUM(CASE WHEN sale_status != 'VOIDED' THEN net_payable_paise ELSE 0 END), 0) AS gross_sales,
            COALESCE(SUM(CASE WHEN sale_status = 'VOIDED' THEN net_payable_paise ELSE 0 END), 0) AS voided_amount
         FROM sales
         WHERE 1=1 {}
         GROUP BY business_date
         ORDER BY business_date DESC;",
        filter_sql
    );

    let mut daily_stmt = conn
        .prepare(&daily_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let daily_rows = daily_stmt
        .query_map(rusqlite::params_from_iter(params_vec), |r| {
            let gross: i64 = r.get(6)?;
            Ok(DailySalesRow {
                business_date: r.get(0)?,
                total_bills: r.get(1)?,
                active_bills: r.get(2)?,
                voided_bills: r.get(3)?,
                taxable_sales_paise: r.get(4)?,
                total_tax_paise: r.get(5)?,
                gross_sales_paise: gross,
                voided_amount_paise: r.get(7)?,
                net_sales_paise: gross,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut daily_breakdown = Vec::new();
    for r in daily_rows {
        if let Ok(row) = r {
            daily_breakdown.push(row);
        }
    }

    Ok(DailySalesSummary {
        total_bills_recorded: active_bills_count + voided_count,
        active_bills_count,
        voided_bills_count: voided_count,
        gross_sales_paise,
        taxable_sales_paise,
        total_cgst_paise,
        total_sgst_paise,
        total_igst_paise,
        total_tax_paise,
        round_off_paise,
        voided_amount_paise: voided_amount,
        net_sales_paise,
        daily_breakdown,
    })
}

/// 2. Generates Payment Summary Report
pub fn get_payment_summary_report(
    conn: &Connection,
    session_token: &str,
    filter: &ReportFilterPayload,
) -> Result<PaymentSummaryReport, String> {
    let _session = validate_session_and_permission(conn, session_token, "admin:view_reports")?;

    let (filter_sql, params_vec) = build_filter_clauses(filter);

    // Active sales payment breakdown
    let active_pay_query = format!(
        "SELECT 
            sp.payment_method,
            COUNT(DISTINCT s.id) as bills_count,
            COALESCE(SUM(sp.net_amount_paise), 0) as total_collected,
            COALESCE(SUM(sp.tendered_paise), 0) as total_tendered,
            COALESCE(SUM(sp.change_returned_paise), 0) as total_change
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE s.sale_status != 'VOIDED' {}
         GROUP BY sp.payment_method;",
        filter_sql
            .replace("business_date", "s.business_date")
            .replace("branch_id", "s.branch_id")
    );

    let mut pay_stmt = conn
        .prepare(&active_pay_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let rows = pay_stmt
        .query_map(rusqlite::params_from_iter(params_vec.clone()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut total_cash_collected_paise = 0;
    let mut total_cash_tendered_paise = 0;
    let mut total_change_returned_paise = 0;
    let mut total_upi_collected_paise = 0;
    let mut method_map: std::collections::HashMap<String, (i64, i64)> =
        std::collections::HashMap::new();

    for r in rows {
        if let Ok((method, bills, collected, tendered, change)) = r {
            if method == "CASH" {
                total_cash_collected_paise += collected;
                total_cash_tendered_paise += tendered;
                total_change_returned_paise += change;
            } else if method == "UPI" {
                total_upi_collected_paise += collected;
            }
            method_map.insert(method, (bills, collected));
        }
    }

    // Split bills count (sales with more than 1 payment method)
    let split_query = format!(
        "SELECT COUNT(*), COALESCE(SUM(total_val), 0) FROM (
            SELECT s.id, SUM(sp.net_amount_paise) as total_val
            FROM sale_payments sp
            JOIN sales s ON s.id = sp.sale_id
            WHERE s.sale_status != 'VOIDED' {}
            GROUP BY s.id
            HAVING COUNT(DISTINCT sp.payment_method) > 1
        );",
        filter_sql
            .replace("business_date", "s.business_date")
            .replace("branch_id", "s.branch_id")
    );

    let mut split_stmt = conn
        .prepare(&split_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let (total_split_bills_count, total_split_amount_paise): (i64, i64) = split_stmt
        .query_row(rusqlite::params_from_iter(params_vec.clone()), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap_or((0, 0));

    // Refunds by payment method (from voided sales)
    let refund_query = format!(
        "SELECT 
            sp.payment_method,
            COALESCE(SUM(sp.net_amount_paise), 0)
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE s.sale_status = 'VOIDED' {}
         GROUP BY sp.payment_method;",
        filter_sql
            .replace("business_date", "s.business_date")
            .replace("branch_id", "s.branch_id")
    );

    let mut refund_stmt = conn
        .prepare(&refund_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let refund_rows = refund_stmt
        .query_map(rusqlite::params_from_iter(params_vec), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut cash_refunds_paise = 0;
    let mut upi_refunds_paise = 0;
    let mut refund_map: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

    for r in refund_rows {
        if let Ok((method, ref_amt)) = r {
            if method == "CASH" {
                cash_refunds_paise += ref_amt;
            } else if method == "UPI" {
                upi_refunds_paise += ref_amt;
            }
            refund_map.insert(method, ref_amt);
        }
    }

    let net_cash_paise = total_cash_collected_paise - cash_refunds_paise;
    let net_upi_paise = total_upi_collected_paise - upi_refunds_paise;
    let total_net_collected_paise = net_cash_paise + net_upi_paise;

    let mut methods_breakdown = Vec::new();
    let all_methods = vec!["CASH".to_string(), "UPI".to_string()];
    for m in all_methods {
        let (bills, collected) = method_map.get(&m).cloned().unwrap_or((0, 0));
        let refunds = refund_map.get(&m).cloned().unwrap_or(0);
        methods_breakdown.push(PaymentMethodRow {
            payment_method: m,
            bills_count: bills,
            total_collected_paise: collected,
            refunds_paise: refunds,
            net_amount_paise: collected - refunds,
        });
    }

    Ok(PaymentSummaryReport {
        total_cash_collected_paise,
        total_cash_tendered_paise,
        total_change_returned_paise,
        total_upi_collected_paise,
        total_split_bills_count,
        total_split_amount_paise,
        cash_refunds_paise,
        upi_refunds_paise,
        net_cash_paise,
        net_upi_paise,
        total_net_collected_paise,
        methods_breakdown,
    })
}

/// 3. Generates GST Tax Report
pub fn get_gst_report(
    conn: &Connection,
    session_token: &str,
    filter: &ReportFilterPayload,
) -> Result<GstReport, String> {
    let _session = validate_session_and_permission(conn, session_token, "admin:view_reports")?;

    let (filter_sql, params_vec) = build_filter_clauses(filter);

    // GST Slabs breakdown from active sales
    let slabs_query = format!(
        "SELECT 
            ROUND(p.tax_rate_bps / 100.0, 1) as tax_rate,
            COALESCE(SUM(si.taxable_paise), 0),
            COALESCE(SUM(si.cgst_paise), 0),
            COALESCE(SUM(si.sgst_paise), 0),
            COALESCE(SUM(si.igst_paise), 0),
            COALESCE(SUM(si.total_tax_paise), 0),
            COALESCE(SUM(si.gross_paise), 0)
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
         WHERE s.sale_status != 'VOIDED' {}
         GROUP BY tax_rate
         ORDER BY tax_rate ASC;",
        filter_sql
            .replace("business_date", "s.business_date")
            .replace("branch_id", "s.branch_id")
    );

    let mut slabs_stmt = conn
        .prepare(&slabs_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let slab_rows = slabs_stmt
        .query_map(rusqlite::params_from_iter(params_vec.clone()), |r| {
            Ok(GstSlabRow {
                tax_rate_percent: r.get(0).unwrap_or(0.0),
                taxable_paise: r.get(1)?,
                cgst_paise: r.get(2)?,
                sgst_paise: r.get(3)?,
                igst_paise: r.get(4)?,
                total_tax_paise: r.get(5)?,
                total_gross_paise: r.get(6)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut slabs_breakdown = Vec::new();
    let mut total_taxable_paise = 0;
    let mut total_cgst_paise = 0;
    let mut total_sgst_paise = 0;
    let mut total_igst_paise = 0;
    let mut total_gst_paise = 0;
    let mut total_invoice_value_paise = 0;

    for r in slab_rows {
        if let Ok(row) = r {
            total_taxable_paise += row.taxable_paise;
            total_cgst_paise += row.cgst_paise;
            total_sgst_paise += row.sgst_paise;
            total_igst_paise += row.igst_paise;
            total_gst_paise += row.total_tax_paise;
            total_invoice_value_paise += row.total_gross_paise;
            slabs_breakdown.push(row);
        }
    }

    // Invoice details table
    let invoices_query = format!(
        "SELECT 
            s.invoice_number,
            s.business_date,
            s.created_at,
            s.sale_status,
            s.subtotal_taxable_paise,
            s.total_cgst_paise,
            s.total_sgst_paise,
            s.total_igst_paise,
            (s.total_cgst_paise + s.total_sgst_paise + s.total_igst_paise) as total_tax,
            s.round_off_paise,
            s.net_payable_paise,
            COALESCE((
                SELECT GROUP_CONCAT(DISTINCT p.hsn_code) 
                FROM sale_items si 
                LEFT JOIN products p ON p.id = si.product_id 
                WHERE si.sale_id = s.id
            ), '21069099') as hsn_summary
         FROM sales s
         WHERE 1=1 {}
         ORDER BY s.created_at DESC LIMIT 500;",
        filter_sql
            .replace("business_date", "s.business_date")
            .replace("branch_id", "s.branch_id")
    );

    let mut inv_stmt = conn
        .prepare(&invoices_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let inv_rows = inv_stmt
        .query_map(rusqlite::params_from_iter(params_vec), |r| {
            Ok(GstInvoiceRow {
                invoice_number: r.get(0)?,
                business_date: r.get(1)?,
                created_at: r.get(2)?,
                sale_status: r.get(3)?,
                taxable_paise: r.get(4)?,
                cgst_paise: r.get(5)?,
                sgst_paise: r.get(6)?,
                igst_paise: r.get(7)?,
                total_tax_paise: r.get(8)?,
                round_off_paise: r.get(9)?,
                net_payable_paise: r.get(10)?,
                hsn_summary: r.get(11)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut invoice_details = Vec::new();
    for r in inv_rows {
        if let Ok(row) = r {
            invoice_details.push(row);
        }
    }

    Ok(GstReport {
        total_taxable_paise,
        total_cgst_paise,
        total_sgst_paise,
        total_igst_paise,
        total_gst_paise,
        total_invoice_value_paise,
        slabs_breakdown,
        invoice_details,
    })
}

/// 4. Generates Product & Category Sales Report
pub fn get_product_sales_report(
    conn: &Connection,
    session_token: &str,
    filter: &ReportFilterPayload,
) -> Result<ProductSalesReport, String> {
    let _session = validate_session_and_permission(conn, session_token, "admin:view_reports")?;

    let (filter_sql, params_vec) = build_filter_clauses(filter);

    let prod_query = format!(
        "SELECT 
            si.product_id,
            COALESCE(p.name, si.product_id) as prod_name,
            COALESCE(p.tamil_name, '') as tamil_name,
            COALESCE(p.sku, '') as sku,
            COALESCE(p.category_id, 'cat_sweets') as category_id,
            si.pricing_unit,
            SUM(si.quantity_input) as total_qty_canonical,
            COUNT(DISTINCT s.id) as bills_count,
            SUM(si.taxable_paise) as taxable_paise,
            SUM(si.total_tax_paise) as tax_paise,
            SUM(si.gross_paise) as gross_paise
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
         WHERE s.sale_status != 'VOIDED' {}
         GROUP BY si.product_id, si.pricing_unit
         ORDER BY gross_paise DESC;",
        filter_sql
            .replace("business_date", "s.business_date")
            .replace("branch_id", "s.branch_id")
    );

    let mut prod_stmt = conn
        .prepare(&prod_query)
        .map_err(|e| format!("Query error: {}", e))?;
    let rows = prod_stmt
        .query_map(rusqlite::params_from_iter(params_vec), |r| {
            let pid: String = r.get(0)?;
            let name: String = r.get(1)?;
            let tamil: String = r.get(2)?;
            let sku: String = r.get(3)?;
            let cat: String = r.get(4)?;
            let pricing_unit: String = r.get(5)?;
            let canonical_qty: i64 = r.get(6)?;
            let bills: i64 = r.get(7)?;
            let taxable: i64 = r.get(8)?;
            let tax: i64 = r.get(9)?;
            let gross: i64 = r.get(10)?;

            let qty_str = if pricing_unit == "PER_KG" {
                format!("{:.3} kg", canonical_qty as f64 / 1_000_000.0)
            } else {
                let unit_suffix = match pricing_unit.as_str() {
                    "PER_PIECE" => "pcs",
                    "PER_PACK" => "packs",
                    "PER_BOX" => "boxes",
                    _ => "units",
                };
                format!("{} {}", canonical_qty, unit_suffix)
            };

            Ok(ProductSalesRow {
                product_id: pid,
                product_name: name,
                tamil_name: tamil,
                sku,
                category_id: cat,
                pricing_unit,
                total_quantity_canonical: canonical_qty,
                quantity_formatted: qty_str,
                bills_count: bills,
                taxable_paise: taxable,
                tax_paise: tax,
                gross_paise: gross,
                revenue_share_percent: 0.0, // calculated below
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut products = Vec::new();
    let mut total_revenue_paise: i64 = 0;
    let mut total_items_sold_count: i64 = 0;
    let mut cat_map: std::collections::HashMap<String, (i64, i64, i64)> =
        std::collections::HashMap::new();

    for r in rows {
        if let Ok(item) = r {
            total_revenue_paise += item.gross_paise;
            total_items_sold_count += 1;

            let entry = cat_map.entry(item.category_id.clone()).or_insert((0, 0, 0));
            entry.0 += item.taxable_paise;
            entry.1 += item.tax_paise;
            entry.2 += item.gross_paise;

            products.push(item);
        }
    }

    // Compute revenue share percentage
    for p in &mut products {
        if total_revenue_paise > 0 {
            p.revenue_share_percent =
                ((p.gross_paise as f64 / total_revenue_paise as f64) * 1000.0).round() / 10.0;
        }
    }

    let top_selling = products.iter().take(5).cloned().collect();

    // Category breakdown
    let mut categories = Vec::new();
    for (cat_id, (taxable, tax, gross)) in cat_map {
        let cat_name = match cat_id.as_str() {
            "cat_sweets" => "Sweets (இனிப்புகள்)",
            "cat_savories" => "Savouries (கார வகைகள்)",
            "cat_bakery" => "Bakery (பேக்கரி)",
            "cat_beverages" => "Drinks & Dairy (பானங்கள்)",
            _ => "General Merchandise",
        };
        let share = if total_revenue_paise > 0 {
            ((gross as f64 / total_revenue_paise as f64) * 1000.0).round() / 10.0
        } else {
            0.0
        };
        let items_in_cat = products.iter().filter(|p| p.category_id == cat_id).count() as i64;
        categories.push(CategorySalesRow {
            category_id: cat_id,
            category_name: cat_name.to_string(),
            items_count: items_in_cat,
            taxable_paise: taxable,
            tax_paise: tax,
            gross_paise: gross,
            revenue_share_percent: share,
        });
    }
    categories.sort_by(|a, b| b.gross_paise.cmp(&a.gross_paise));

    Ok(ProductSalesReport {
        total_items_sold_count,
        total_revenue_paise,
        products,
        categories,
        top_selling,
    })
}

/// 5. Generates Cash Drawer & Cash Movement Report
pub fn get_cash_drawer_report(
    conn: &Connection,
    session_token: &str,
    filter: &ReportFilterPayload,
) -> Result<CashDrawerReport, String> {
    let _session = validate_session_and_permission(conn, session_token, "admin:view_reports")?;

    let mut query = "SELECT id, session_id, branch_id, movement_type, amount_paise, direction, reference_id, created_at FROM cash_movements WHERE 1=1".to_string();
    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(start) = &filter.start_date {
        let trimmed = start.trim();
        if !trimmed.is_empty() {
            query.push_str(" AND (SUBSTR(created_at, 1, 10) >= ? OR reference_id IN (SELECT id FROM sales WHERE business_date >= ?))");
            params_vec.push(rusqlite::types::Value::Text(trimmed.to_string()));
            params_vec.push(rusqlite::types::Value::Text(trimmed.to_string()));
        }
    }

    if let Some(end) = &filter.end_date {
        let trimmed = end.trim();
        if !trimmed.is_empty() {
            query.push_str(" AND (SUBSTR(created_at, 1, 10) <= ? OR reference_id IN (SELECT id FROM sales WHERE business_date <= ?))");
            params_vec.push(rusqlite::types::Value::Text(trimmed.to_string()));
            params_vec.push(rusqlite::types::Value::Text(trimmed.to_string()));
        }
    }

    if let Some(branch) = &filter.branch_id {
        let trimmed = branch.trim();
        if !trimmed.is_empty() {
            query.push_str(" AND branch_id = ?");
            params_vec.push(rusqlite::types::Value::Text(trimmed.to_string()));
        }
    }

    query.push_str(" ORDER BY created_at DESC;");

    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("Query error: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec), |r| {
            Ok(CashMovementRow {
                id: r.get(0)?,
                session_id: r.get(1)?,
                movement_type: r.get(3)?,
                amount_paise: r.get(4)?,
                direction: r.get(5)?,
                reference_id: r.get(6)?,
                created_at: r.get(7)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut opening_float_paise: i64 = 0;
    let mut cash_sales_inflow_paise: i64 = 0;
    let mut cash_refunds_outflow_paise: i64 = 0;
    let mut manual_inflows_paise: i64 = 0;
    let mut manual_outflows_paise: i64 = 0;
    let mut recorded_closing_cash_paise: Option<i64> = None;
    let mut movements = Vec::new();

    for r in rows {
        if let Ok(mov) = r {
            match mov.movement_type.as_str() {
                "OPENING_FLOAT" => {
                    opening_float_paise += mov.amount_paise;
                }
                "CASH_SALE" => {
                    if mov.direction == "IN" {
                        cash_sales_inflow_paise += mov.amount_paise;
                    }
                }
                "CASH_REFUND" => {
                    if mov.direction == "OUT" {
                        cash_refunds_outflow_paise += mov.amount_paise;
                    }
                }
                "DRAWER_COUNT" | "CLOSING_COUNT" => {
                    if recorded_closing_cash_paise.is_none() {
                        recorded_closing_cash_paise = Some(mov.amount_paise);
                    }
                }
                _ => {
                    if mov.direction == "IN" {
                        manual_inflows_paise += mov.amount_paise;
                    } else if mov.direction == "OUT" {
                        manual_outflows_paise += mov.amount_paise;
                    }
                }
            }
            movements.push(mov);
        }
    }

    let net_cash_change_paise = cash_sales_inflow_paise + manual_inflows_paise
        - cash_refunds_outflow_paise
        - manual_outflows_paise;
    let expected_closing_cash_paise = opening_float_paise + net_cash_change_paise;
    let variance_paise = recorded_closing_cash_paise.map(|rec| rec - expected_closing_cash_paise);

    Ok(CashDrawerReport {
        session_id: movements.first().map(|m| m.session_id.clone()),
        opening_float_paise,
        cash_sales_inflow_paise,
        cash_refunds_outflow_paise,
        manual_inflows_paise,
        manual_outflows_paise,
        net_cash_change_paise,
        expected_closing_cash_paise,
        recorded_closing_cash_paise,
        variance_paise,
        movements,
    })
}

/// 6. Generates All Financial Reports in a single batch
pub fn get_financial_reports_aggregate(
    conn: &Connection,
    session_token: &str,
    filter: &ReportFilterPayload,
) -> Result<FinancialReportsAggregate, String> {
    let daily_sales = get_daily_sales_report(conn, session_token, filter)?;
    let payment_summary = get_payment_summary_report(conn, session_token, filter)?;
    let gst_report = get_gst_report(conn, session_token, filter)?;
    let product_sales = get_product_sales_report(conn, session_token, filter)?;
    let cash_drawer = get_cash_drawer_report(conn, session_token, filter)?;

    Ok(FinancialReportsAggregate {
        filter: filter.clone(),
        daily_sales,
        payment_summary,
        gst_report,
        product_sales,
        cash_drawer,
    })
}
