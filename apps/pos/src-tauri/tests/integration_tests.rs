use malgudi_pos_native::db::DatabaseManager;
use malgudi_pos_native::transaction::{finalize_sale_atomic, FinalizeSalePayload, SaleItemInput, SalePaymentInput};
use malgudi_pos_native::backup::BackupManager;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

fn setup_test_db(path: &Path) -> Connection {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    let conn = DatabaseManager::open_writable(path).expect("Failed to open writable DB");
    // Seed invoice series
    conn.execute(
        "INSERT OR IGNORE INTO invoice_series (series_code, financial_year, current_seq) VALUES ('IB1', '2627', 100);",
        [],
    ).expect("Failed to seed invoice series");
    conn
}

fn sample_payload() -> FinalizeSalePayload {
    FinalizeSalePayload {
        sale_id: None,
        branch_id: "IB".into(),
        counter_id: "C1".into(),
        terminal_id: "T1".into(),
        session_id: "sess_01".into(),
        business_date: "2026-10-10".into(),
        series_code: "IB1".into(),
        financial_year: "2627".into(),
        tax_policy_version: "2026.1-TN".into(),
        subtotal_taxable_paise: 24286,
        total_cgst_paise: 607,
        total_sgst_paise: 607,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 25500,
        items: vec![
            SaleItemInput {
                product_id: "prod_mysore_pak".into(),
                quantity_input: 375000,
                pricing_unit: "PER_KG".into(),
                weight_input_source: "SCALE_AUTO".into(),
                unit_price_paise: 68000,
                taxable_paise: 24286,
                cgst_paise: 607,
                sgst_paise: 607,
                igst_paise: 0,
                total_tax_paise: 1214,
                gross_paise: 25500,
                stock_deduction_delta: -375000,
                stock_unit: "MG".into(),
            }
        ],
        payments: vec![
            SalePaymentInput {
                payment_method: "CASH".into(),
                allocated_amount_paise: 15500,
                tendered_paise: 20000,
                change_returned_paise: 4500,
                net_amount_paise: 15500,
                outcome: "SUCCESS".into(),
                reference_note: None,
                verified_by_user_id: None,
            },
            SalePaymentInput {
                payment_method: "UPI_MANUAL_RECORDED".into(),
                allocated_amount_paise: 10000,
                tendered_paise: 10000,
                change_returned_paise: 0,
                net_amount_paise: 10000,
                outcome: "SUCCESS".into(),
                reference_note: Some("Soundbox verified".into()),
                verified_by_user_id: Some("cashier_01".into()),
            }
        ],
        cashier_id: "cashier_01".into(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    }
}

#[test]
fn test_pre_commit_fault_injection_rolls_back_all_tables() {
    let db_path = Path::new("target/test_fault_rollback.db");
    let mut conn = setup_test_db(db_path);
    let payload = sample_payload();

    // Abort at Boundary 3 (after sales header, before items)
    let res = finalize_sale_atomic(&mut conn, &payload, Some(3));
    assert!(res.is_err(), "Expected transaction to fail at boundary 3");

    // Reopen DB to simulate process recovery
    drop(conn);
    let recovery_conn = DatabaseManager::open_writable(db_path).expect("Reopen failed");

    // Assert that ZERO partial rows are visible in ANY table
    let sales_count: i64 = recovery_conn.query_row("SELECT COUNT(*) FROM sales;", [], |r| r.get(0)).unwrap();
    let items_count: i64 = recovery_conn.query_row("SELECT COUNT(*) FROM sale_items;", [], |r| r.get(0)).unwrap();
    let payments_count: i64 = recovery_conn.query_row("SELECT COUNT(*) FROM sale_payments;", [], |r| r.get(0)).unwrap();
    let cash_count: i64 = recovery_conn.query_row("SELECT COUNT(*) FROM cash_movements;", [], |r| r.get(0)).unwrap();
    let stock_count: i64 = recovery_conn.query_row("SELECT COUNT(*) FROM stock_movements WHERE movement_type = 'SALE_DEDUCTION';", [], |r| r.get(0)).unwrap();
    let outbox_count: i64 = recovery_conn.query_row("SELECT COUNT(*) FROM sync_outbox;", [], |r| r.get(0)).unwrap();

    assert_eq!(sales_count, 0, "No partial sales row should exist");
    assert_eq!(items_count, 0, "No partial items row should exist");
    assert_eq!(payments_count, 0, "No partial payments row should exist");
    assert_eq!(cash_count, 0, "No partial cash movement should exist");
    assert_eq!(stock_count, 0, "No partial stock movement should exist");
    assert_eq!(outbox_count, 0, "No partial outbox event should exist");

    // Clean up
    let _ = fs::remove_file(db_path);
}

#[test]
fn test_successful_commit_persists_complete_aggregate_and_sync_pending() {
    let db_path = Path::new("target/test_commit_persist.db");
    let mut conn = setup_test_db(db_path);
    let payload = sample_payload();

    // Finalize without fault injection
    let res = finalize_sale_atomic(&mut conn, &payload, None).expect("Sale finalization failed");
    assert_eq!(res.invoice_number, "IB1/2627/000101");

    // Close and reopen to simulate restart
    drop(conn);
    let recovery_conn = DatabaseManager::open_writable(db_path).expect("Reopen failed");

    // Verify all 8 tables are consistently populated
    let sync_status: String = recovery_conn.query_row(
        "SELECT sync_status FROM sales WHERE id = ?1;",
        [&res.sale_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(sync_status, "SYNC_PENDING", "Must persist with sync_status = SYNC_PENDING");

    let cash_amount: i64 = recovery_conn.query_row(
        "SELECT amount_paise FROM cash_movements WHERE reference_id = ?1;",
        [&res.sale_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(cash_amount, 15500, "Cash drawer must increase by exactly net cash retained");

    let stock_delta: i64 = recovery_conn.query_row(
        "SELECT quantity_delta FROM stock_movements WHERE reference_id = ?1;",
        [&res.sale_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(stock_delta, -375000, "Stock must decrease by 375,000 mg");

    // Test hot snapshot and staged restoration
    let backup_dir = Path::new("target/backups");
    let backup_path = BackupManager::create_consistent_backup(&recovery_conn, backup_dir, "snapshot_test")
        .expect("Consistent backup generation failed");
    assert!(backup_path.exists());

    // Validate staged restore
    let report = BackupManager::validate_and_reconcile_staged_restore(&backup_path)
        .expect("Staged restore validation failed");
    assert_eq!(report.total_sales_count, 1);
    assert_eq!(report.total_outbox_count, 1);
    assert!(report.is_safe_to_restore);
    assert!(report.rejected_or_quarantined_records.is_empty());

    // Clean up
    let _ = fs::remove_file(db_path);
    let _ = fs::remove_dir_all(backup_dir);
}

#[test]
fn test_backup_destination_already_exists_preserves_original() {
    let db_path = Path::new("target/test_backup_no_clobber.db");
    let conn = setup_test_db(db_path);
    let backup_dir = Path::new("target/backups_no_clobber");

    // First backup succeeds
    let backup_path = BackupManager::create_consistent_backup(&conn, backup_dir, "safe_snapshot")
        .expect("Initial backup failed");
    assert!(backup_path.exists());

    // Second backup to same destination must fail and preserve existing file
    let second_res = BackupManager::create_consistent_backup(&conn, backup_dir, "safe_snapshot");
    assert!(second_res.is_err(), "Must reject overwriting existing backup file");

    // Clean up
    let _ = fs::remove_file(db_path);
    let _ = fs::remove_dir_all(backup_dir);
}

#[test]
fn test_staged_restore_quarantines_duplicate_invoice_and_fk_violation() {
    let corrupt_db_path = Path::new("target/test_corrupt_restore.db");
    if corrupt_db_path.exists() {
        let _ = fs::remove_file(corrupt_db_path);
    }
    let conn = DatabaseManager::open_writable(corrupt_db_path).unwrap();

    // Disable foreign keys and drop unique index to simulate damaged/collided database state
    conn.execute("PRAGMA foreign_keys = OFF;", []).unwrap();
    conn.execute("DROP INDEX IF EXISTS idx_sales_invoice_unique;", []).unwrap();
    
    // Inject two sales with the exact same invoice number
    conn.execute(
        "INSERT INTO sales (
            id, invoice_number, branch_id, counter_id, terminal_id, session_id,
            business_date, tax_policy_version, subtotal_taxable_paise, total_cgst_paise,
            total_sgst_paise, total_igst_paise, round_off_paise, net_payable_paise,
            sale_status, payment_status, sync_status, created_at
        ) VALUES 
        ('sale_01', 'IB1/2627/000999', 'IB', 'C1', 'T1', 's1', '2026-10-10', '2026.1-TN', 100, 5, 5, 0, 0, 110, 'FINALIZED', 'SETTLED', 'SYNC_PENDING', '2026-10-10T10:00:00Z'),
        ('sale_02', 'IB1/2627/000999', 'IB', 'C1', 'T1', 's1', '2026-10-10', '2026.1-TN', 100, 5, 5, 0, 0, 110, 'FINALIZED', 'SETTLED', 'SYNC_PENDING', '2026-10-10T10:05:00Z');",
        [],
    ).unwrap();

    let report = BackupManager::validate_and_reconcile_staged_restore(corrupt_db_path)
        .expect("Recovery inspection completed");
    
    // Must identify collision and flag as unsafe to restore
    assert!(!report.is_safe_to_restore, "Restore with duplicate invoices must be marked unsafe");
    assert_eq!(report.duplicate_invoices.len(), 1);
    assert_eq!(report.duplicate_invoices[0], "IB1/2627/000999");
    assert!(!report.rejected_or_quarantined_records.is_empty());

    // Clean up
    let _ = fs::remove_file(corrupt_db_path);
}

#[test]
fn test_restore_database_preserves_existing_file() {
    let original_db = Path::new("target/test_restore_orig.db");
    let conn = setup_test_db(original_db);
    let backup_dir = Path::new("target/test_restore_backups");
    let backup_path = BackupManager::create_consistent_backup(&conn, backup_dir, "valid_restore_src").unwrap();
    drop(conn);

    let target_db = Path::new("target/test_restore_dest.db");
    let dest_conn = setup_test_db(target_db);
    dest_conn.execute("INSERT INTO terminal_trust_state (key, value) VALUES ('preserve_me', 'true');", []).unwrap();
    drop(dest_conn);

    // Attempting restore with allow_destructive = false must fail
    let err_res = BackupManager::restore_database(&backup_path, target_db, false);
    assert!(err_res.is_err(), "Must require allow_destructive to overwrite existing DB");

    // With allow_destructive = true, it must succeed and preserve the existing DB copy
    let ok_res = BackupManager::restore_database(&backup_path, target_db, true);
    assert!(ok_res.is_ok(), "Restore with approval should succeed");

    // Clean up
    let _ = fs::remove_file(original_db);
    let _ = fs::remove_file(target_db);
    let _ = fs::remove_dir_all(backup_dir);
}

#[test]
fn test_fault_injection_at_all_boundaries_guarantees_invoice_seq_rollback_and_zero_rows() {
    // Tests atomicity across all 7 pre-commit boundaries
    for boundary in 1..=7 {
        let db_path_str = format!("target/test_boundary_{}.db", boundary);
        let db_path = Path::new(&db_path_str);
        let mut conn = setup_test_db(db_path);
        let payload = sample_payload();

        // Inject fault at this specific boundary
        let res = finalize_sale_atomic(&mut conn, &payload, Some(boundary));
        assert!(res.is_err(), "Expected boundary {} to abort", boundary);

        // Verify invoice sequence rolled back to initial value (100)
        let seq: i64 = conn.query_row(
            "SELECT current_seq FROM invoice_series WHERE series_code = 'IB1' AND financial_year = '2627';",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(seq, 100, "Boundary {} aborted but invoice sequence did not roll back!", boundary);

        // Verify zero partial rows in any table
        let sales_count: i64 = conn.query_row("SELECT COUNT(*) FROM sales;", [], |r| r.get(0)).unwrap();
        let items_count: i64 = conn.query_row("SELECT COUNT(*) FROM sale_items;", [], |r| r.get(0)).unwrap();
        let payments_count: i64 = conn.query_row("SELECT COUNT(*) FROM sale_payments;", [], |r| r.get(0)).unwrap();
        let cash_count: i64 = conn.query_row("SELECT COUNT(*) FROM cash_movements;", [], |r| r.get(0)).unwrap();
        let stock_count: i64 = conn.query_row("SELECT COUNT(*) FROM stock_movements WHERE movement_type = 'SALE_DEDUCTION';", [], |r| r.get(0)).unwrap();
        let outbox_count: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox;", [], |r| r.get(0)).unwrap();

        assert_eq!(sales_count, 0);
        assert_eq!(items_count, 0);
        assert_eq!(payments_count, 0);
        assert_eq!(cash_count, 0);
        assert_eq!(stock_count, 0);
        assert_eq!(outbox_count, 0);

        let _ = fs::remove_file(db_path);
    }
}

#[test]
fn test_duplicate_sale_id_finalization_fails_atomically() {
    let db_path = Path::new("target/test_duplicate_sale.db");
    let mut conn = setup_test_db(db_path);

    let mut payload = sample_payload();
    payload.sale_id = Some("fixed_test_sale_id_123".into());

    // First finalization succeeds
    let res1 = finalize_sale_atomic(&mut conn, &payload, None);
    assert!(res1.is_ok(), "Initial sale must succeed");

    // Second finalization with duplicate sale_id must fail on PRIMARY KEY constraint
    let res2 = finalize_sale_atomic(&mut conn, &payload, None);
    assert!(res2.is_err(), "Duplicate sale_id must be rejected by database");

    // Clean up
    let _ = fs::remove_file(db_path);
}

#[test]
fn test_read_only_pragma_and_write_rejection() {
    let db_path = Path::new("target/test_readonly_pragma.db");
    let write_conn = setup_test_db(db_path);
    drop(write_conn);

    let ro_conn = DatabaseManager::open_read_only(db_path).expect("Failed to open read-only DB");

    // Verify PRAGMA query_only is active
    let query_only: i64 = ro_conn.query_row("PRAGMA query_only;", [], |r| r.get(0)).unwrap();
    assert_eq!(query_only, 1, "PRAGMA query_only must be 1 on read-only connection");

    // Verify writes are strictly rejected
    let write_res = ro_conn.execute("INSERT INTO terminal_trust_state (key, value) VALUES ('k', 'v');", []);
    assert!(write_res.is_err(), "Write on read-only connection must be rejected");

    let _ = fs::remove_file(db_path);
}
