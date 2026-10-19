use malgudi_pos_native::auth::{self, CreateUserPayload, ProvisionOwnerPayload};
use malgudi_pos_native::db::DatabaseManager;
use malgudi_pos_native::inventory::{
    self, AdjustStockPayload, CreateProductPayload, UpdateProductPayload, VoidSalePayload,
};
use malgudi_pos_native::transaction::{
    derive_indian_financial_year, finalize_sale_atomic, FinalizeSalePayload, SaleItemInput,
    SalePaymentInput,
};
use rusqlite::Connection;
use std::fs;
use std::path::Path;

fn setup_inventory_test_db(path: &Path) -> Connection {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    DatabaseManager::open_writable(path).expect("Failed to open test database")
}

#[test]
fn test_product_seeding_and_retrieval() {
    let db_path = Path::new("target/test_inv_seeding.db");
    let conn = setup_inventory_test_db(db_path);

    // Initial products should have been seeded
    let products = inventory::list_products(&conn, "IB", false).expect("Failed to list products");
    assert_eq!(products.len(), 97, "Expected exactly 97 official catalog products");

    let mysore_pak = products
        .iter()
        .find(|p| p.sku == "GHE-005")
        .expect("Mysore pak not found");
    assert_eq!(mysore_pak.name, "Ghee Mysorepok");
    assert_eq!(mysore_pak.tamil_name, "நெய் மைசூர்பாக்");
    assert_eq!(mysore_pak.pricing_unit, "PER_KG");
    assert_eq!(mysore_pak.inventory_unit, "MG");
    assert_eq!(mysore_pak.base_price_paise, 68000);
    assert_eq!(mysore_pak.current_stock, 25_000_000); // 25 kg
}

#[test]
fn test_product_management_authorization() {
    let db_path = Path::new("target/test_inv_auth.db");
    let conn = setup_inventory_test_db(db_path);

    // 1. Provision owner/admin
    let admin_session = auth::provision_first_owner(
        &conn,
        &ProvisionOwnerPayload {
            username: "admin_owner".to_string(),
            display_name: "Boss Owner".to_string(),
            pin: "889900".to_string(),
            branch_id: Some("IB".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_01".to_string()),
        },
    )
    .expect("Admin provisioning failed");

    // 2. Create cashier
    let _cashier_rec = auth::create_user(
        &conn,
        &admin_session.token,
        &CreateUserPayload {
            username: "cashier_kavitha".to_string(),
            display_name: "Kavitha".to_string(),
            role: "CASHIER".to_string(),
            pin: "123456".to_string(),
        },
    )
    .expect("Cashier creation failed");

    let cashier_session = auth::login(
        &conn,
        &malgudi_pos_native::auth::LoginPayload {
            username: "cashier_kavitha".to_string(),
            pin: "123456".to_string(),
            branch_id: Some("IB".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_01".to_string()),
        },
    )
    .expect("Cashier login failed");

    // 3. Cashier attempts to create a product -> MUST FAIL
    let new_prod_payload = CreateProductPayload {
        name: "Jangri".to_string(),
        tamil_name: "ஜாங்கிரி".to_string(),
        sku: "SWT-JG-099".to_string(),
        barcode: Some("8901234567890".to_string()),
        category_id: "cat_sweets".to_string(),
        pricing_unit: "PER_KG".to_string(),
        inventory_unit: "MG".to_string(),
        base_price_paise: 52000,
        piece_price_paise: None,
        tax_rate_bps: Some(500),
        hsn_code: "21069099".to_string(),
        initial_stock: Some(10_000_000), // 10 kg
        branch_id: Some("IB".to_string()),
    };

    let cashier_res = inventory::create_product(&conn, &cashier_session.token, &new_prod_payload);
    assert!(
        cashier_res.is_err(),
        "Cashier should not be allowed to create products"
    );
    assert!(cashier_res.unwrap_err().contains("FORBIDDEN"));

    // 4. Admin creates the product -> MUST SUCCEED
    let created_prod = inventory::create_product(&conn, &admin_session.token, &new_prod_payload)
        .expect("Admin product creation failed");
    assert_eq!(created_prod.name, "Jangri");
    assert_eq!(created_prod.sku, "SWT-JG-099");
    assert_eq!(created_prod.current_stock, 10_000_000);

    // 5. Cashier attempts to update product -> MUST FAIL
    let update_payload = UpdateProductPayload {
        id: created_prod.id.clone(),
        name: "Special Jangri".to_string(),
        tamil_name: "ஸ்பெஷல் ஜாங்கிரி".to_string(),
        sku: "SWT-JG-099".to_string(),
        barcode: Some("8901234567890".to_string()),
        category_id: "cat_sweets".to_string(),
        pricing_unit: "PER_KG".to_string(),
        inventory_unit: "MG".to_string(),
        base_price_paise: 54000,
        piece_price_paise: None,
        tax_rate_bps: 500,
        hsn_code: "21069099".to_string(),
        is_active: true,
    };
    let cashier_update_res =
        inventory::update_product(&conn, &cashier_session.token, &update_payload);
    assert!(cashier_update_res.is_err());
    assert!(cashier_update_res.unwrap_err().contains("FORBIDDEN"));

    // 6. Admin updates product -> MUST SUCCEED
    let updated_prod = inventory::update_product(&conn, &admin_session.token, &update_payload)
        .expect("Admin product update failed");
    assert_eq!(updated_prod.name, "Special Jangri");
    assert_eq!(updated_prod.base_price_paise, 54000);

    // 7. Admin deactivates product
    inventory::toggle_product_status(&conn, &admin_session.token, &created_prod.id, false)
        .expect("Deactivation failed");

    // Cashier listing active products will not see deactivated product
    let active_products = inventory::list_products(&conn, "IB", false).unwrap();
    assert!(!active_products.iter().any(|p| p.id == created_prod.id));

    // Admin listing with include_inactive sees it
    let all_products = inventory::list_products(&conn, "IB", true).unwrap();
    let found = all_products
        .iter()
        .find(|p| p.id == created_prod.id)
        .unwrap();
    assert!(!found.is_active);
}

#[test]
fn test_stock_adjustments_mandatory_reason_and_audit() {
    let db_path = Path::new("target/test_inv_adjust.db");
    let conn = setup_inventory_test_db(db_path);

    let admin_session = auth::provision_first_owner(
        &conn,
        &ProvisionOwnerPayload {
            username: "admin_owner".to_string(),
            display_name: "Boss Owner".to_string(),
            pin: "889900".to_string(),
            branch_id: Some("IB".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_01".to_string()),
        },
    )
    .expect("Admin provisioning failed");

    // 1. Adjustment without reason -> MUST FAIL with MANDATORY_FIELD
    let empty_reason_payload = AdjustStockPayload {
        branch_id: "IB".to_string(),
        product_id: "prod_mysore_pak".to_string(),
        movement_type: "RECEIPT_PRODUCTION".to_string(),
        quantity_delta: 5_000_000, // 5 kg
        unit: "MG".to_string(),
        reason: "".to_string(), // Empty reason
        reference_id: None,
    };
    let res = inventory::adjust_stock(&conn, &admin_session.token, &empty_reason_payload);
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("MANDATORY_FIELD"));

    // 2. Receipt from production with valid reason -> MUST SUCCEED
    let prod_receipt = AdjustStockPayload {
        branch_id: "IB".to_string(),
        product_id: "prod_mysore_pak".to_string(),
        movement_type: "RECEIPT_PRODUCTION".to_string(),
        quantity_delta: 5_000_000, // +5 kg
        unit: "MG".to_string(),
        reason: "Fresh morning batch from central kitchen".to_string(),
        reference_id: Some("BATCH-20261012-01".to_string()),
    };
    let sm = inventory::adjust_stock(&conn, &admin_session.token, &prod_receipt)
        .expect("Stock receipt failed");
    assert_eq!(sm.quantity_delta, 5_000_000);

    // Initial was 25kg, now should be 30kg
    let prods = inventory::list_products(&conn, "IB", false).unwrap();
    let mp = prods.iter().find(|p| p.id == "prod_mysore_pak").unwrap();
    assert_eq!(mp.current_stock, 30_000_000);

    // 3. Wastage / Damage with valid reason -> Must decrease stock
    let wastage = AdjustStockPayload {
        branch_id: "IB".to_string(),
        product_id: "prod_mysore_pak".to_string(),
        movement_type: "WASTAGE_DAMAGE".to_string(),
        quantity_delta: 1_000_000, // 1 kg damaged
        unit: "MG".to_string(),
        reason: "Tray dropped on kitchen floor during restocking".to_string(),
        reference_id: None,
    };
    let sm_waste = inventory::adjust_stock(&conn, &admin_session.token, &wastage)
        .expect("Wastage adjustment failed");
    assert_eq!(sm_waste.quantity_delta, -1_000_000);

    // Now balance should be 29kg
    let prods2 = inventory::list_products(&conn, "IB", false).unwrap();
    let mp2 = prods2.iter().find(|p| p.id == "prod_mysore_pak").unwrap();
    assert_eq!(mp2.current_stock, 29_000_000);

    // 4. Check audit movement list
    let movements = inventory::list_stock_movements(
        &conn,
        &admin_session.token,
        Some("prod_mysore_pak".to_string()),
        Some("IB".to_string()),
        50,
    )
    .expect("Failed to list movements");

    assert!(movements.iter().any(|m| m.movement_type == "WASTAGE_DAMAGE"
        && m.reason.as_deref().unwrap().contains("Tray dropped")));
}

#[test]
fn test_billing_stock_deduction_and_void_reversal() {
    let db_path = Path::new("target/test_inv_billing.db");
    let mut conn = setup_inventory_test_db(db_path);

    let admin_session = auth::provision_first_owner(
        &conn,
        &ProvisionOwnerPayload {
            username: "admin_owner".to_string(),
            display_name: "Boss Owner".to_string(),
            pin: "889900".to_string(),
            branch_id: Some("IB".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_01".to_string()),
        },
    )
    .expect("Admin provisioning failed");

    // Initial stock for Mysore Pak is 25,000,000 mg (25 kg)
    let p_before = inventory::list_products(&conn, "IB", false).unwrap();
    let mp_before = p_before.iter().find(|p| p.id == "prod_mysore_pak").unwrap();
    assert_eq!(mp_before.current_stock, 25_000_000);

    // Finalize sale selling 500g (500,000 mg) of Mysore Pak
    let sale_payload = FinalizeSalePayload {
        sale_id: None,
        branch_id: "IB".to_string(),
        counter_id: "C1".to_string(),
        terminal_id: "T1".to_string(),
        session_id: "sess_01".to_string(),
        business_date: "2026-10-12".to_string(),
        series_code: "IB-A".to_string(),
        financial_year: "2026-27".to_string(),
        tax_policy_version: "2.9".to_string(),
        subtotal_taxable_paise: 32381,
        total_cgst_paise: 810,
        total_sgst_paise: 809,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 34000,
        items: vec![SaleItemInput {
            product_id: "prod_mysore_pak".to_string(),
            quantity_input: 500000,
            pricing_unit: "PER_KG".to_string(),
            weight_input_source: "SCALE_AUTO".to_string(),
            unit_price_paise: 68000,
            taxable_paise: 32381,
            cgst_paise: 810,
            sgst_paise: 809,
            igst_paise: 0,
            total_tax_paise: 1619,
            gross_paise: 34000,
            stock_deduction_delta: -500000,
            stock_unit: "MG".to_string(),
        }],
        payments: vec![SalePaymentInput {
            payment_method: "CASH".to_string(),
            allocated_amount_paise: 34000,
            tendered_paise: 34000,
            change_returned_paise: 0,
            net_amount_paise: 34000,
            outcome: "SUCCESS".to_string(),
            reference_note: None,
            verified_by_user_id: Some("admin_owner".to_string()),
        }],
        cashier_id: "admin_owner".to_string(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    };

    let sale_res =
        finalize_sale_atomic(&mut conn, &sale_payload, None).expect("Sale finalization failed");

    // Verify stock balance decremented by 500,000 mg -> 24,500,000 mg
    let p_after = inventory::list_products(&conn, "IB", false).unwrap();
    let mp_after = p_after.iter().find(|p| p.id == "prod_mysore_pak").unwrap();
    assert_eq!(mp_after.current_stock, 24_500_000);

    // Verify stock_movement row exists with SALE_DEDUCTION
    let sm_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM stock_movements WHERE reference_id = ?1 AND movement_type = 'SALE_DEDUCTION';",
        [&sale_res.sale_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(sm_count, 1);

    // Now Void the sale with a mandatory reason
    let void_payload = VoidSalePayload {
        sale_id: sale_res.sale_id.clone(),
        reason: "Customer ordered wrong sweet and requested immediate cancellation".to_string(),
    };

    inventory::void_or_refund_sale(&mut conn, &admin_session.token, &void_payload)
        .expect("Void sale failed");

    // Stock must be restored back to 25,000,000 mg!
    let p_restored = inventory::list_products(&conn, "IB", false).unwrap();
    let mp_restored = p_restored
        .iter()
        .find(|p| p.id == "prod_mysore_pak")
        .unwrap();
    assert_eq!(mp_restored.current_stock, 25_000_000);

    // Sale status in DB must be VOIDED and REFUNDED
    let (sale_status, payment_status): (String, String) = conn
        .query_row(
            "SELECT sale_status, payment_status FROM sales WHERE id = ?1;",
            [&sale_res.sale_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(sale_status, "VOIDED");
    assert_eq!(payment_status, "REFUNDED");

    // Cash movement must have recorded CASH_REFUND
    let refund_cm_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cash_movements WHERE reference_id = ?1 AND movement_type = 'CASH_REFUND';",
        [&sale_res.sale_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(refund_cm_count, 1);

    // Attempting to void the same sale again -> MUST BE REJECTED (Duplicate reversal rejected)
    let dup_void_res =
        inventory::void_or_refund_sale(&mut conn, &admin_session.token, &void_payload);
    assert!(dup_void_res.is_err());
    assert!(dup_void_res.unwrap_err().contains("already voided"));
}

#[test]
fn test_multi_branch_stock_initialization_and_isolation() {
    let db_path = Path::new("target/test_multi_branch_stock.db");
    let conn = setup_inventory_test_db(db_path);

    // 1. IB products should have initialized pilot quantities
    let ib_products =
        inventory::list_products(&conn, "IB", false).expect("Failed to list IB products");
    assert_eq!(ib_products.len(), 97);
    let ib_mp = ib_products.iter().find(|p| p.sku == "GHE-005").unwrap();
    assert_eq!(ib_mp.current_stock, 25_000_000); // 25 kg

    // 2. MN products must have baseline 0 quantity without fictitious inventory
    let mn_products =
        inventory::list_products(&conn, "MN", false).expect("Failed to list MN products");
    assert_eq!(mn_products.len(), 97);
    let mn_mp = mn_products.iter().find(|p| p.sku == "GHE-005").unwrap();
    assert_eq!(mn_mp.current_stock, 0); // 0 stock baseline

    // 3. Verify stock balances exist in table for both branches
    let ib_balance_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM stock_balances WHERE branch_id = 'IB';",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ib_balance_count, 97);

    let mn_balance_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM stock_balances WHERE branch_id = 'MN';",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mn_balance_count, 97);

    // 4. Stock isolation: Adjusting IB does not alter MN
    conn.execute(
        "UPDATE stock_balances SET current_quantity = 18000000 WHERE branch_id = 'IB' AND product_id = 'prod_mysore_pak';",
        [],
    ).unwrap();

    let mn_mp_after: i64 = conn.query_row(
        "SELECT current_quantity FROM stock_balances WHERE branch_id = 'MN' AND product_id = 'prod_mysore_pak';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(mn_mp_after, 0);
}

#[test]
fn test_repeated_initialization_idempotence() {
    let db_path = Path::new("target/test_repeated_init.db");
    let conn = setup_inventory_test_db(db_path);

    // Modify IB stock to simulate active sales / inventory movement
    conn.execute(
        "UPDATE stock_balances SET current_quantity = 15000000 WHERE branch_id = 'IB' AND product_id = 'prod_mysore_pak';",
        [],
    ).unwrap();

    // Re-run initialization for both branches 5 times
    for _ in 0..5 {
        DatabaseManager::initialize_branch_stock_if_missing(&conn, "IB")
            .expect("Re-init IB failed");
        DatabaseManager::initialize_branch_stock_if_missing(&conn, "MN")
            .expect("Re-init MN failed");
    }

    // Existing modified stock must NOT be overwritten!
    let ib_qty: i64 = conn.query_row(
        "SELECT current_quantity FROM stock_balances WHERE branch_id = 'IB' AND product_id = 'prod_mysore_pak';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(
        ib_qty, 15_000_000,
        "Existing stock was unexpectedly overwritten on re-initialization"
    );
}

#[test]
fn test_indian_financial_year_derivation_boundaries() {
    // 2026-2027 fiscal year boundaries
    assert_eq!(derive_indian_financial_year("2026-04-01"), "2627");
    assert_eq!(derive_indian_financial_year("2026-10-13"), "2627");
    assert_eq!(derive_indian_financial_year("2027-03-31"), "2627");

    // March 31 vs April 1 boundary transitions
    assert_eq!(derive_indian_financial_year("2026-03-31"), "2526");
    assert_eq!(derive_indian_financial_year("2027-04-01"), "2728");
    assert_eq!(derive_indian_financial_year("2028-03-31"), "2728");
    assert_eq!(derive_indian_financial_year("2028-04-01"), "2829");

    // ISO timestamp parsing
    assert_eq!(
        derive_indian_financial_year("2026-04-01T10:30:00.000Z"),
        "2627"
    );
    assert_eq!(
        derive_indian_financial_year("2027-03-31T23:59:59.999Z"),
        "2627"
    );
}
