use malgudi_pos_native::auth::{self, CreateUserPayload, LoginPayload, ProvisionOwnerPayload};
use malgudi_pos_native::db::DatabaseManager;
use malgudi_pos_native::inventory::{self, VoidSalePayload};
use malgudi_pos_native::reports::{self, ReportFilterPayload};
use malgudi_pos_native::transaction::{finalize_sale_atomic, FinalizeSalePayload, SaleItemInput, SalePaymentInput};
use rusqlite::Connection;
use uuid::Uuid;

fn setup_test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("Failed to open in-memory database");
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;"
    ).expect("Failed to set pragmas");
    DatabaseManager::apply_migrations(&conn).expect("Failed to apply migrations");
    conn
}

fn create_owner_session(conn: &mut Connection) -> String {
    let payload = ProvisionOwnerPayload {
        username: "test_owner".to_string(),
        display_name: "Test Store Owner".to_string(),
        pin: "8888".to_string(),
        branch_id: Some("IB".to_string()),
        terminal_id: Some("T1".to_string()),
        counter_id: Some("C1".to_string()),
        session_id: Some("sess_reports_01".to_string()),
    };
    let session = auth::provision_first_owner(conn, &payload).expect("Failed to provision owner");
    session.token
}

fn create_cashier_session(conn: &mut Connection, admin_token: &str) -> String {
    let create_payload = CreateUserPayload {
        username: "test_cashier".to_string(),
        display_name: "Test Cashier 1".to_string(),
        role: "CASHIER".to_string(),
        pin: "1234".to_string(),
    };
    auth::create_user(conn, admin_token, &create_payload).expect("Failed to create cashier");

    let login_payload = LoginPayload {
        username: "test_cashier".to_string(),
        pin: "1234".to_string(),
        branch_id: Some("IB".to_string()),
        terminal_id: Some("T1".to_string()),
        counter_id: Some("C1".to_string()),
        session_id: Some("sess_reports_01".to_string()),
    };
    let session = auth::login(conn, &login_payload).expect("Failed to login as cashier");
    session.token
}

#[test]
fn test_daily_sales_report_accuracy_and_void_exclusion() {
    let mut conn = setup_test_db();
    let admin_token = create_owner_session(&mut conn);

    // 1. Sale 1: Cash sale of ₹340.00 (34,000 paise)
    let sale1 = FinalizeSalePayload {
        sale_id: Some(format!("sale_{}", Uuid::now_v7())),
        branch_id: "IB".to_string(),
        counter_id: "C1".to_string(),
        terminal_id: "T1".to_string(),
        session_id: "sess_reports_01".to_string(),
        business_date: "2026-10-12".to_string(),
        series_code: "IB1".to_string(),
        financial_year: "2627".to_string(),
        tax_policy_version: "2026.1-TN".to_string(),
        subtotal_taxable_paise: 32381,
        total_cgst_paise: 810,
        total_sgst_paise: 809,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 34000,
        items: vec![SaleItemInput {
            product_id: "prod_mysore_pak".to_string(),
            quantity_input: 500000, // 500g
            pricing_unit: "PER_KG".to_string(),
            weight_input_source: "MANUAL".to_string(),
            unit_price_paise: 68000,
            taxable_paise: 32381,
            cgst_paise: 810,
            sgst_paise: 809,
            igst_paise: 0,
            total_tax_paise: 1619,
            gross_paise: 34000,
            stock_deduction_delta: 500000,
            stock_unit: "MG".to_string(),
        }],
        payments: vec![SalePaymentInput {
            payment_method: "CASH".to_string(),
            allocated_amount_paise: 34000,
            tendered_paise: 50000,
            change_returned_paise: 16000,
            net_amount_paise: 34000,
            outcome: "SUCCESS".to_string(),
            reference_note: None,
            verified_by_user_id: None,
        }],
        cashier_id: "usr_owner".to_string(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    };
    finalize_sale_atomic(&mut conn, &sale1, None).expect("Sale 1 should succeed");

    // 2. Sale 2: UPI sale of ₹360.00 (36,000 paise)
    let sale2 = FinalizeSalePayload {
        sale_id: Some(format!("sale_{}", Uuid::now_v7())),
        branch_id: "IB".to_string(),
        counter_id: "C1".to_string(),
        terminal_id: "T1".to_string(),
        session_id: "sess_reports_01".to_string(),
        business_date: "2026-10-12".to_string(),
        series_code: "IB1".to_string(),
        financial_year: "2627".to_string(),
        tax_policy_version: "2026.1-TN".to_string(),
        subtotal_taxable_paise: 34286,
        total_cgst_paise: 857,
        total_sgst_paise: 857,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 36000,
        items: vec![SaleItemInput {
            product_id: "prod_kara_sev".to_string(),
            quantity_input: 1000000, // 1kg
            pricing_unit: "PER_KG".to_string(),
            weight_input_source: "MANUAL".to_string(),
            unit_price_paise: 36000,
            taxable_paise: 34286,
            cgst_paise: 857,
            sgst_paise: 857,
            igst_paise: 0,
            total_tax_paise: 1714,
            gross_paise: 36000,
            stock_deduction_delta: 1000000,
            stock_unit: "MG".to_string(),
        }],
        payments: vec![SalePaymentInput {
            payment_method: "UPI".to_string(),
            allocated_amount_paise: 36000,
            tendered_paise: 36000,
            change_returned_paise: 0,
            net_amount_paise: 36000,
            outcome: "SUCCESS".to_string(),
            reference_note: Some("UPI-TXN-123".to_string()),
            verified_by_user_id: None,
        }],
        cashier_id: "usr_owner".to_string(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    };
    finalize_sale_atomic(&mut conn, &sale2, None).expect("Sale 2 should succeed");

    // 3. Sale 3: Cash sale of ₹100.00 (10,000 paise) which will be VOIDED
    let sale3_id = format!("sale_{}", Uuid::now_v7());
    let sale3 = FinalizeSalePayload {
        sale_id: Some(sale3_id.clone()),
        branch_id: "IB".to_string(),
        counter_id: "C1".to_string(),
        terminal_id: "T1".to_string(),
        session_id: "sess_reports_01".to_string(),
        business_date: "2026-10-12".to_string(),
        series_code: "IB1".to_string(),
        financial_year: "2627".to_string(),
        tax_policy_version: "2026.1-TN".to_string(),
        subtotal_taxable_paise: 9524,
        total_cgst_paise: 238,
        total_sgst_paise: 238,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 10000,
        items: vec![SaleItemInput {
            product_id: "prod_sweet_bun".to_string(),
            quantity_input: 4,
            pricing_unit: "PER_PIECE".to_string(),
            weight_input_source: "COUNT".to_string(),
            unit_price_paise: 2500,
            taxable_paise: 9524,
            cgst_paise: 238,
            sgst_paise: 238,
            igst_paise: 0,
            total_tax_paise: 476,
            gross_paise: 10000,
            stock_deduction_delta: 4,
            stock_unit: "PIECE".to_string(),
        }],
        payments: vec![SalePaymentInput {
            payment_method: "CASH".to_string(),
            allocated_amount_paise: 10000,
            tendered_paise: 10000,
            change_returned_paise: 0,
            net_amount_paise: 10000,
            outcome: "SUCCESS".to_string(),
            reference_note: None,
            verified_by_user_id: None,
        }],
        cashier_id: "usr_owner".to_string(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    };
    finalize_sale_atomic(&mut conn, &sale3, None).expect("Sale 3 should succeed");

    // Void Sale 3
    let void_payload = VoidSalePayload {
        sale_id: sale3_id,
        reason: "Customer changed mind before counter exit".to_string(),
    };
    inventory::void_or_refund_sale(&mut conn, &admin_token, &void_payload).expect("Void sale 3 should succeed");

    // Run Daily Sales Report
    let filter = ReportFilterPayload {
        start_date: Some("2026-10-12".to_string()),
        end_date: Some("2026-10-12".to_string()),
        branch_id: Some("IB".to_string()),
    };

    let report = reports::get_daily_sales_report(&conn, &admin_token, &filter).expect("Report should generate");

    // Assertions
    assert_eq!(report.total_bills_recorded, 3, "Total recorded bills should be 3");
    assert_eq!(report.active_bills_count, 2, "Active bills count should be 2");
    assert_eq!(report.voided_bills_count, 1, "Voided bills count should be 1");
    assert_eq!(report.gross_sales_paise, 70000, "Active gross sales should be ₹700 (340 + 360)");
    assert_eq!(report.voided_amount_paise, 10000, "Voided amount should be ₹100");
    assert_eq!(report.net_sales_paise, 70000, "Net sales should equal active sales ₹700");
    assert_eq!(report.taxable_sales_paise, 32381 + 34286, "Taxable sales should sum active items");
    assert_eq!(report.daily_breakdown.len(), 1, "Daily breakdown should have 1 date entry");
    assert_eq!(report.daily_breakdown[0].active_bills, 2);
    assert_eq!(report.daily_breakdown[0].voided_bills, 1);
}

#[test]
fn test_payment_summary_and_split_reporting() {
    let mut conn = setup_test_db();
    let admin_token = create_owner_session(&mut conn);

    // Split payment sale: ₹500 total (₹300 Cash + ₹200 UPI)
    let split_sale = FinalizeSalePayload {
        sale_id: Some(format!("sale_{}", Uuid::now_v7())),
        branch_id: "IB".to_string(),
        counter_id: "C1".to_string(),
        terminal_id: "T1".to_string(),
        session_id: "sess_reports_01".to_string(),
        business_date: "2026-10-12".to_string(),
        series_code: "IB1".to_string(),
        financial_year: "2627".to_string(),
        tax_policy_version: "2026.1-TN".to_string(),
        subtotal_taxable_paise: 47619,
        total_cgst_paise: 1191,
        total_sgst_paise: 1190,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 50000,
        items: vec![SaleItemInput {
            product_id: "prod_mysore_pak".to_string(),
            quantity_input: 735294,
            pricing_unit: "PER_KG".to_string(),
            weight_input_source: "MANUAL".to_string(),
            unit_price_paise: 68000,
            taxable_paise: 47619,
            cgst_paise: 1191,
            sgst_paise: 1190,
            igst_paise: 0,
            total_tax_paise: 2381,
            gross_paise: 50000,
            stock_deduction_delta: 735294,
            stock_unit: "MG".to_string(),
        }],
        payments: vec![
            SalePaymentInput {
                payment_method: "CASH".to_string(),
                allocated_amount_paise: 30000,
                tendered_paise: 30000,
                change_returned_paise: 0,
                net_amount_paise: 30000,
                outcome: "SUCCESS".to_string(),
                reference_note: None,
                verified_by_user_id: None,
            },
            SalePaymentInput {
                payment_method: "UPI".to_string(),
                allocated_amount_paise: 20000,
                tendered_paise: 20000,
                change_returned_paise: 0,
                net_amount_paise: 20000,
                outcome: "SUCCESS".to_string(),
                reference_note: Some("UPI-SPLIT-99".to_string()),
                verified_by_user_id: None,
            },
        ],
        cashier_id: "usr_owner".to_string(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    };
    finalize_sale_atomic(&mut conn, &split_sale, None).expect("Split sale should succeed");

    let filter = ReportFilterPayload {
        start_date: Some("2026-10-12".to_string()),
        end_date: Some("2026-10-12".to_string()),
        branch_id: Some("IB".to_string()),
    };

    let report = reports::get_payment_summary_report(&conn, &admin_token, &filter).expect("Report should generate");

    assert_eq!(report.total_cash_collected_paise, 30000, "Cash collected should be ₹300");
    assert_eq!(report.total_upi_collected_paise, 20000, "UPI collected should be ₹200");
    assert_eq!(report.total_split_bills_count, 1, "Should count 1 split bill");
    assert_eq!(report.total_split_amount_paise, 50000, "Split bill total should be ₹500");
    assert_eq!(report.total_net_collected_paise, 50000, "Net collected should be ₹500");
}

#[test]
fn test_gst_report_slabs_and_invoice_details() {
    let mut conn = setup_test_db();
    let admin_token = create_owner_session(&mut conn);

    let sale = FinalizeSalePayload {
        sale_id: Some(format!("sale_{}", Uuid::now_v7())),
        branch_id: "IB".to_string(),
        counter_id: "C1".to_string(),
        terminal_id: "T1".to_string(),
        session_id: "sess_reports_01".to_string(),
        business_date: "2026-10-12".to_string(),
        series_code: "IB1".to_string(),
        financial_year: "2627".to_string(),
        tax_policy_version: "2026.1-TN".to_string(),
        subtotal_taxable_paise: 95238,
        total_cgst_paise: 2381,
        total_sgst_paise: 2381,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 100000,
        items: vec![SaleItemInput {
            product_id: "prod_mysore_pak".to_string(),
            quantity_input: 1470588,
            pricing_unit: "PER_KG".to_string(),
            weight_input_source: "MANUAL".to_string(),
            unit_price_paise: 68000,
            taxable_paise: 95238,
            cgst_paise: 2381,
            sgst_paise: 2381,
            igst_paise: 0,
            total_tax_paise: 4762,
            gross_paise: 100000,
            stock_deduction_delta: 1470588,
            stock_unit: "MG".to_string(),
        }],
        payments: vec![SalePaymentInput {
            payment_method: "CASH".to_string(),
            allocated_amount_paise: 100000,
            tendered_paise: 100000,
            change_returned_paise: 0,
            net_amount_paise: 100000,
            outcome: "SUCCESS".to_string(),
            reference_note: None,
            verified_by_user_id: None,
        }],
        cashier_id: "usr_owner".to_string(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    };
    finalize_sale_atomic(&mut conn, &sale, None).expect("Sale should succeed");

    let filter = ReportFilterPayload {
        start_date: Some("2026-10-12".to_string()),
        end_date: Some("2026-10-12".to_string()),
        branch_id: Some("IB".to_string()),
    };

    let report = reports::get_gst_report(&conn, &admin_token, &filter).expect("GST report should generate");

    assert_eq!(report.total_taxable_paise, 95238);
    assert_eq!(report.total_cgst_paise, 2381);
    assert_eq!(report.total_sgst_paise, 2381);
    assert_eq!(report.total_gst_paise, 4762);
    assert_eq!(report.total_invoice_value_paise, 100000);
    assert!(!report.slabs_breakdown.is_empty(), "Should have at least 1 slab");
    assert_eq!(report.slabs_breakdown[0].tax_rate_percent, 5.0, "Should be 5% GST slab");
    assert_eq!(report.invoice_details.len(), 1, "Should list 1 invoice");
    assert!(report.invoice_details[0].invoice_number.starts_with("IB1/2627/"));
}

#[test]
fn test_product_sales_ranking_and_category_breakdown() {
    let mut conn = setup_test_db();
    let admin_token = create_owner_session(&mut conn);

    let sale = FinalizeSalePayload {
        sale_id: Some(format!("sale_{}", Uuid::now_v7())),
        branch_id: "IB".to_string(),
        counter_id: "C1".to_string(),
        terminal_id: "T1".to_string(),
        session_id: "sess_reports_01".to_string(),
        business_date: "2026-10-12".to_string(),
        series_code: "IB1".to_string(),
        financial_year: "2627".to_string(),
        tax_policy_version: "2026.1-TN".to_string(),
        subtotal_taxable_paise: 68571,
        total_cgst_paise: 1715,
        total_sgst_paise: 1714,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 72000,
        items: vec![
            SaleItemInput {
                product_id: "prod_mysore_pak".to_string(),
                quantity_input: 500000, // 500g
                pricing_unit: "PER_KG".to_string(),
                weight_input_source: "MANUAL".to_string(),
                unit_price_paise: 68000,
                taxable_paise: 32381,
                cgst_paise: 810,
                sgst_paise: 809,
                igst_paise: 0,
                total_tax_paise: 1619,
                gross_paise: 34000,
                stock_deduction_delta: 500000,
                stock_unit: "MG".to_string(),
            },
            SaleItemInput {
                product_id: "prod_kara_sev".to_string(),
                quantity_input: 1055555,
                pricing_unit: "PER_KG".to_string(),
                weight_input_source: "MANUAL".to_string(),
                unit_price_paise: 36000,
                taxable_paise: 36190,
                cgst_paise: 905,
                sgst_paise: 905,
                igst_paise: 0,
                total_tax_paise: 1810,
                gross_paise: 38000,
                stock_deduction_delta: 1055555,
                stock_unit: "MG".to_string(),
            },
        ],
        payments: vec![SalePaymentInput {
            payment_method: "CASH".to_string(),
            allocated_amount_paise: 72000,
            tendered_paise: 72000,
            change_returned_paise: 0,
            net_amount_paise: 72000,
            outcome: "SUCCESS".to_string(),
            reference_note: None,
            verified_by_user_id: None,
        }],
        cashier_id: "usr_owner".to_string(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    };
    finalize_sale_atomic(&mut conn, &sale, None).expect("Sale should succeed");

    let filter = ReportFilterPayload {
        start_date: Some("2026-10-12".to_string()),
        end_date: Some("2026-10-12".to_string()),
        branch_id: Some("IB".to_string()),
    };

    let report = reports::get_product_sales_report(&conn, &admin_token, &filter).expect("Product report should generate");

    assert_eq!(report.total_revenue_paise, 72000);
    assert_eq!(report.products.len(), 2);
    // Highest revenue product should be first (Kara Sev @ ₹380 vs Mysore Pak @ ₹340)
    assert_eq!(report.products[0].product_id, "prod_kara_sev");
    assert_eq!(report.products[1].product_id, "prod_mysore_pak");
    assert_eq!(report.categories.len(), 2, "Should cover sweets and savouries");
}

#[test]
fn test_cash_drawer_report_movements_and_variance() {
    let mut conn = setup_test_db();
    let admin_token = create_owner_session(&mut conn);

    // Record an opening float
    conn.execute(
        "INSERT INTO cash_movements (id, session_id, branch_id, movement_type, amount_paise, direction, reference_id, created_at)
         VALUES ('cm_open_01', 'sess_reports_01', 'IB', 'OPENING_FLOAT', 200000, 'IN', 'FLOAT-INIT', '2026-10-12T08:00:00Z');",
        [],
    ).expect("Insert opening float should succeed");

    // Make a cash sale of ₹500
    let sale = FinalizeSalePayload {
        sale_id: Some("sale_cash_draw_01".to_string()),
        branch_id: "IB".to_string(),
        counter_id: "C1".to_string(),
        terminal_id: "T1".to_string(),
        session_id: "sess_reports_01".to_string(),
        business_date: "2026-10-12".to_string(),
        series_code: "IB1".to_string(),
        financial_year: "2627".to_string(),
        tax_policy_version: "2026.1-TN".to_string(),
        subtotal_taxable_paise: 47619,
        total_cgst_paise: 1191,
        total_sgst_paise: 1190,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 50000,
        items: vec![SaleItemInput {
            product_id: "prod_mysore_pak".to_string(),
            quantity_input: 735294,
            pricing_unit: "PER_KG".to_string(),
            weight_input_source: "MANUAL".to_string(),
            unit_price_paise: 68000,
            taxable_paise: 47619,
            cgst_paise: 1191,
            sgst_paise: 1190,
            igst_paise: 0,
            total_tax_paise: 2381,
            gross_paise: 50000,
            stock_deduction_delta: 735294,
            stock_unit: "MG".to_string(),
        }],
        payments: vec![SalePaymentInput {
            payment_method: "CASH".to_string(),
            allocated_amount_paise: 50000,
            tendered_paise: 50000,
            change_returned_paise: 0,
            net_amount_paise: 50000,
            outcome: "SUCCESS".to_string(),
            reference_note: None,
            verified_by_user_id: None,
        }],
        cashier_id: "usr_owner".to_string(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    };
    finalize_sale_atomic(&mut conn, &sale, None).expect("Sale should succeed");

    let filter = ReportFilterPayload {
        start_date: Some("2026-10-12".to_string()),
        end_date: Some("2026-10-12".to_string()),
        branch_id: Some("IB".to_string()),
    };

    let report = reports::get_cash_drawer_report(&conn, &admin_token, &filter).expect("Cash drawer report should generate");

    assert_eq!(report.opening_float_paise, 200000, "Opening float should be ₹2,000 (200,000 paise)");
    assert_eq!(report.cash_sales_inflow_paise, 50000, "Cash sale should be ₹500 (50,000 paise)");
    assert_eq!(report.cash_refunds_outflow_paise, 0);
    assert_eq!(report.expected_closing_cash_paise, 250000, "Expected closing cash should be ₹2,500");
}

#[test]
fn test_reports_authorization_security_blocks_cashier() {
    let mut conn = setup_test_db();
    let admin_token = create_owner_session(&mut conn);
    let cashier_token = create_cashier_session(&mut conn, &admin_token);

    let filter = ReportFilterPayload {
        start_date: Some("2026-10-12".to_string()),
        end_date: Some("2026-10-12".to_string()),
        branch_id: Some("IB".to_string()),
    };

    // 1. Admin must succeed
    let admin_res = reports::get_financial_reports_aggregate(&conn, &admin_token, &filter);
    assert!(admin_res.is_ok(), "Admin must be authorized to view reports");

    // 2. Cashier must fail with Unauthorized
    let cashier_res = reports::get_financial_reports_aggregate(&conn, &cashier_token, &filter);
    assert!(cashier_res.is_err(), "Cashier must be blocked from reports");
    let err_msg = cashier_res.err().unwrap();
    assert!(err_msg.contains("lacks required permission") || err_msg.contains("Permission denied") || err_msg.contains("Unauthorized"), "Must state permission denied: {}", err_msg);
}
