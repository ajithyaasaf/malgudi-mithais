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
// 6. CUSTOMER SALES & ORDER HISTORY REPORT MODELS
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomerSalesReport {
    pub total_customers_count: i64,
    pub repeat_customers_count: i64,
    pub total_customer_sales_paise: i64,
    pub total_walkin_sales_paise: i64,
    pub total_customer_orders_count: i64,
    pub total_walkin_orders_count: i64,
    pub average_spend_per_customer_paise: i64,
    pub customers: Vec<CustomerSummaryRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomerSummaryRow {
    pub customer_id: String,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub customer_location: Option<String>,
    pub total_orders: i64,
    pub active_orders: i64,
    pub voided_orders: i64,
    pub total_spent_paise: i64,
    pub average_bill_paise: i64,
    pub first_visit_date: String,
    pub last_visit_date: String,
    pub orders: Vec<CustomerOrderRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomerOrderItemRow {
    pub product_id: String,
    pub product_name: String,
    pub tamil_name: String,
    pub pricing_unit: String,
    pub quantity_formatted: String,
    pub unit_price_paise: i64,
    pub gross_paise: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomerOrderRow {
    pub sale_id: String,
    pub invoice_number: String,
    pub business_date: String,
    pub created_at: String,
    pub net_payable_paise: i64,
    pub sale_status: String,
    pub payment_status: String,
    pub payment_method: String,
    pub items_count: i64,
    pub items_summary: String,
    pub items: Vec<CustomerOrderItemRow>,
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
    pub customer_sales: CustomerSalesReport,
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
            let canon = if method == "CASH" {
                "CASH"
            } else if method == "UPI" || method.starts_with("UPI") {
                "UPI"
            } else {
                &method
            };

            if canon == "CASH" {
                total_cash_collected_paise += collected;
                total_cash_tendered_paise += tendered;
                total_change_returned_paise += change;
            } else if canon == "UPI" {
                total_upi_collected_paise += collected;
            }
            let entry = method_map.entry(canon.to_string()).or_insert((0, 0));
            entry.0 += bills;
            entry.1 += collected;
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
            HAVING COUNT(DISTINCT CASE WHEN sp.payment_method LIKE 'UPI%' THEN 'UPI' ELSE sp.payment_method END) > 1
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
            let canon = if method == "CASH" {
                "CASH"
            } else if method == "UPI" || method.starts_with("UPI") {
                "UPI"
            } else {
                &method
            };

            if canon == "CASH" {
                cash_refunds_paise += ref_amt;
            } else if canon == "UPI" {
                upi_refunds_paise += ref_amt;
            }
            let entry = refund_map.entry(canon.to_string()).or_insert(0);
            *entry += ref_amt;
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
            "cat_kaju_sweets" => "Kaju Sweets (முந்திரி இனிப்புகள்)",
            "cat_kaju_crunches" => "Kaju Crunches (காஜூ க்ரஞ்சஸ்)",
            "cat_ghee_sweets" => "Ghee Sweets (நெய் இனிப்புகள்)",
            "cat_regular_sweets" => "Regular Sweets (சாதாரண இனிப்புகள்)",
            "cat_bakery" => "Bakery (பேக்கரி)",
            "cat_murukku" => "Murukku Varieties (முறுக்கு வகைகள்)",
            "cat_savories" => "Savouries (கார வகைகள்)",
            "cat_chips" => "Chips Varieties (சிப்ஸ் வகைகள்)",
            "cat_snacks" => "Snacks & Puffs (தின்பண்டங்கள் / பஃப்ஸ்)",
            "cat_sweets" => "Sweets (இனிப்புகள்)",
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

/// 6. Generates Customer Sales and Order History Report
pub fn get_customer_sales_report(
    conn: &Connection,
    session_token: &str,
    filter: &ReportFilterPayload,
) -> Result<CustomerSalesReport, String> {
    let _session = validate_session_and_permission(conn, session_token, "admin:view_reports")?;

    let (filter_sql, params_vec) = build_filter_clauses(filter);

    let query = format!(
        "SELECT 
            s.id,
            s.invoice_number,
            s.business_date,
            s.created_at,
            s.net_payable_paise,
            s.sale_status,
            s.payment_status,
            s.customer_name,
            s.customer_phone,
            s.customer_location,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as items_count,
            COALESCE((
                SELECT GROUP_CONCAT(DISTINCT CASE WHEN sp.payment_method LIKE 'UPI%' THEN 'UPI' ELSE sp.payment_method END) 
                FROM sale_payments sp 
                WHERE sp.sale_id = s.id
            ), 'CASH') as payment_methods
         FROM sales s
         WHERE 1=1 {}
         ORDER BY s.created_at DESC;",
        filter_sql
    );

    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("Query error in customer sales report: {}", e))?;

    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec.clone()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, String>(11)?,
            ))
        })
        .map_err(|e| format!("Query map error: {}", e))?;

    let mut customer_map: std::collections::HashMap<String, CustomerSummaryRow> = std::collections::HashMap::new();
    let mut total_walkin_sales_paise: i64 = 0;
    let mut total_walkin_orders_count: i64 = 0;

    // Pre-query itemized lines for sales in this period
    let items_query = format!(
        "SELECT 
            si.sale_id,
            si.product_id,
            COALESCE(p.name, si.product_id),
            COALESCE(p.tamil_name, ''),
            si.pricing_unit,
            si.quantity_input,
            si.unit_price_paise,
            si.gross_paise
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
         WHERE 1=1 {}
         ORDER BY si.rowid ASC;",
        filter_sql
    );

    let mut sale_items_map: std::collections::HashMap<String, Vec<CustomerOrderItemRow>> = std::collections::HashMap::new();

    if let Ok(mut items_stmt) = conn.prepare(&items_query) {
        if let Ok(item_rows) = items_stmt.query_map(rusqlite::params_from_iter(params_vec.clone()), |r| {
            let sale_id: String = r.get(0)?;
            let product_id: String = r.get(1)?;
            let product_name: String = r.get(2)?;
            let tamil_name: String = r.get(3)?;
            let pricing_unit: String = r.get(4)?;
            let quantity_input: i64 = r.get(5)?;
            let unit_price_paise: i64 = r.get(6)?;
            let gross_paise: i64 = r.get(7)?;

            let qty_formatted = if pricing_unit == "PER_KG" {
                let grams = (quantity_input as f64) / 1000.0;
                if grams >= 1000.0 {
                    format!("{:.3} kg", grams / 1000.0)
                } else {
                    format!("{}g", grams.round() as i64)
                }
            } else {
                let unit_suffix = match pricing_unit.as_str() {
                    "PER_PIECE" => "pcs",
                    "PER_PACK" => "packs",
                    "PER_BOX" => "boxes",
                    _ => "units",
                };
                format!("{} {}", quantity_input, unit_suffix)
            };

            Ok((sale_id, CustomerOrderItemRow {
                product_id,
                product_name,
                tamil_name,
                pricing_unit,
                quantity_formatted: qty_formatted,
                unit_price_paise,
                gross_paise,
            }))
        }) {
            for row in item_rows.flatten() {
                sale_items_map.entry(row.0).or_default().push(row.1);
            }
        }
    }

    for row_res in rows {
        let (
            sale_id,
            invoice_number,
            business_date,
            created_at,
            net_payable_paise,
            sale_status,
            payment_status,
            raw_name,
            raw_phone,
            raw_location,
            items_count,
            payment_method,
        ) = row_res.map_err(|e| format!("Row read error: {}", e))?;

        let clean_name = raw_name.and_then(|n| {
            let t = n.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        });
        let clean_phone = raw_phone.and_then(|p| {
            let t = p.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        });
        let clean_location = raw_location.and_then(|l| {
            let t = l.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        });

        // Determine if customer is identified or anonymous walk-in
        let cust_key = match (&clean_phone, &clean_name) {
            (Some(phone), _) => Some(format!("phone:{}", phone)),
            (None, Some(name)) => Some(format!("name:{}", name.to_lowercase())),
            (None, None) => None,
        };

        if let Some(key) = cust_key {
            let items = sale_items_map.remove(&sale_id).unwrap_or_default();
            let items_summary = if items.is_empty() {
                "No items recorded".to_string()
            } else {
                let first_three: Vec<String> = items.iter().take(3).map(|it| {
                    format!("{} ({})", it.product_name, it.quantity_formatted)
                }).collect();
                let suffix = if items.len() > 3 {
                    format!(" +{} more", items.len() - 3)
                } else {
                    "".to_string()
                };
                format!("{}{}", first_three.join(", "), suffix)
            };

            let order = CustomerOrderRow {
                sale_id,
                invoice_number,
                business_date: business_date.clone(),
                created_at: created_at.clone(),
                net_payable_paise,
                sale_status: sale_status.clone(),
                payment_status,
                payment_method,
                items_count,
                items_summary,
                items,
            };

            let entry = customer_map.entry(key.clone()).or_insert_with(|| CustomerSummaryRow {
                customer_id: key,
                customer_name: clean_name.clone(),
                customer_phone: clean_phone.clone(),
                customer_location: clean_location.clone(),
                total_orders: 0,
                active_orders: 0,
                voided_orders: 0,
                total_spent_paise: 0,
                average_bill_paise: 0,
                first_visit_date: business_date.clone(),
                last_visit_date: business_date.clone(),
                orders: Vec::new(),
            });

            // Update latest known name and location if current record has them
            if entry.customer_name.is_none() && clean_name.is_some() {
                entry.customer_name = clean_name;
            }
            if entry.customer_location.is_none() && clean_location.is_some() {
                entry.customer_location = clean_location;
            }

            entry.total_orders += 1;
            if sale_status == "VOIDED" {
                entry.voided_orders += 1;
            } else {
                entry.active_orders += 1;
                entry.total_spent_paise += net_payable_paise;
            }

            // Track visit dates
            if business_date < entry.first_visit_date {
                entry.first_visit_date = business_date.clone();
            }
            if business_date > entry.last_visit_date {
                entry.last_visit_date = business_date.clone();
            }

            entry.orders.push(order);
        } else {
            // Anonymous Walk-In
            if sale_status != "VOIDED" {
                total_walkin_sales_paise += net_payable_paise;
                total_walkin_orders_count += 1;
            }
        }
    }

    // Convert map to vec and calculate averages
    let mut customers: Vec<CustomerSummaryRow> = customer_map
        .into_values()
        .map(|mut c| {
            c.average_bill_paise = if c.active_orders > 0 {
                c.total_spent_paise / c.active_orders
            } else {
                0
            };
            c
        })
        .collect();

    // Sort by total_spent_paise descending
    customers.sort_by(|a, b| b.total_spent_paise.cmp(&a.total_spent_paise));

    let total_customers_count = customers.len() as i64;
    let repeat_customers_count = customers.iter().filter(|c| c.active_orders > 1).count() as i64;
    let total_customer_sales_paise: i64 = customers.iter().map(|c| c.total_spent_paise).sum();
    let total_customer_orders_count: i64 = customers.iter().map(|c| c.active_orders).sum();
    let average_spend_per_customer_paise = if total_customers_count > 0 {
        total_customer_sales_paise / total_customers_count
    } else {
        0
    };

    Ok(CustomerSalesReport {
        total_customers_count,
        repeat_customers_count,
        total_customer_sales_paise,
        total_walkin_sales_paise,
        total_customer_orders_count,
        total_walkin_orders_count,
        average_spend_per_customer_paise,
        customers,
    })
}

/// 7. Generates All Financial Reports in a single batch
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
    let customer_sales = get_customer_sales_report(conn, session_token, filter)?;

    Ok(FinancialReportsAggregate {
        filter: filter.clone(),
        daily_sales,
        payment_summary,
        gst_report,
        product_sales,
        cash_drawer,
        customer_sales,
    })
}
