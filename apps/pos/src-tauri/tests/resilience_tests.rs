use malgudi_pos_native::db::DatabaseManager;
use malgudi_pos_native::transaction::{finalize_sale_atomic, FinalizeSalePayload, SaleItemInput, SalePaymentInput};
use malgudi_pos_native::backup::BackupManager;
use rusqlite::Connection;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

fn setup_test_db(path: &Path) -> Connection {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    let conn = DatabaseManager::open_writable(path).expect("Failed to open writable DB");
    conn.execute(
        "INSERT OR IGNORE INTO invoice_series (series_code, financial_year, current_seq) VALUES ('IB1', '2627', 100);",
        [],
    ).expect("Failed to seed invoice series");
    conn
}

fn sample_sale(sale_id: &str, _invoice_num: &str) -> FinalizeSalePayload {
    FinalizeSalePayload {
        sale_id: Some(sale_id.to_string()),
        branch_id: "IB".into(),
        counter_id: "C1".into(),
        terminal_id: "T1".into(),
        session_id: "sess_test_resilience".into(),
        business_date: "2026-10-13".into(),
        series_code: "IB1".into(),
        financial_year: "2627".into(),
        tax_policy_version: "2026.1-TN".into(),
        subtotal_taxable_paise: 10000,
        total_cgst_paise: 250,
        total_sgst_paise: 250,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 10500,
        items: vec![
            SaleItemInput {
                product_id: "prod_mysore_pak".into(),
                quantity_input: 250000,
                pricing_unit: "PER_KG".into(),
                weight_input_source: "SCALE_AUTO".into(),
                unit_price_paise: 40000,
                taxable_paise: 10000,
                cgst_paise: 250,
                sgst_paise: 250,
                igst_paise: 0,
                total_tax_paise: 500,
                gross_paise: 10500,
                stock_deduction_delta: -250000,
                stock_unit: "MG".into(),
            }
        ],
        payments: vec![
            SalePaymentInput {
                payment_method: "CASH".into(),
                allocated_amount_paise: 10500,
                tendered_paise: 10500,
                change_returned_paise: 0,
                net_amount_paise: 10500,
                outcome: "SUCCESS".into(),
                reference_note: None,
                verified_by_user_id: None,
            }
        ],
        cashier_id: "usr_owner".into(),
        customer_name: None,
        customer_phone: None,
        customer_location: None,
    }
}

#[test]
fn test_automated_backup_schedule_and_retention() {
    let db_path = Path::new("target/test_auto_backup_src.db");
    let conn = setup_test_db(db_path);
    let backup_dir = Path::new("target/test_scheduled_backups");

    if backup_dir.exists() {
        let _ = fs::remove_dir_all(backup_dir);
    }
    fs::create_dir_all(backup_dir).unwrap();

    // Create 5 successive backups with retention limit of 3
    for _ in 1..=5 {
        std::thread::sleep(std::time::Duration::from_millis(1100)); // Ensure distinct seconds in timestamp
        let res = BackupManager::run_scheduled_backup_with_retention(&conn, backup_dir, 3)
            .expect("Scheduled backup should succeed");
        assert!(res.bytes_written > 0);
        assert!(!res.backup_path.is_empty());
    }

    // Verify exactly 3 backups remain in the directory
    let mut remaining = Vec::new();
    for entry in fs::read_dir(backup_dir).unwrap().flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("db") {
            remaining.push(p);
        }
    }
    assert_eq!(remaining.len(), 3, "Retention policy must prune backups exceeding max_retention=3");

    // Verify audit logs record SCHEDULED_BACKUP_SUCCESS
    let audit_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'SCHEDULED_BACKUP_SUCCESS';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(audit_count, 5);

    let _ = fs::remove_file(db_path);
    let _ = fs::remove_dir_all(backup_dir);
}

#[test]
fn test_backup_restore_into_clean_installation_preserves_consistency() {
    let src_path = Path::new("target/test_restore_src.db");
    let mut conn = setup_test_db(src_path);

    // Finalize 2 sales
    let sale1 = sample_sale("sale_rest_01", "IB1/2627/000101");
    let res1 = finalize_sale_atomic(&mut conn, &sale1, None).unwrap();
    let sale2 = sample_sale("sale_rest_02", "IB1/2627/000102");
    let res2 = finalize_sale_atomic(&mut conn, &sale2, None).unwrap();

    // Take backup
    let backup_dir = Path::new("target/test_restore_snapshots");
    let backup_path = BackupManager::create_consistent_backup(&conn, backup_dir, "clean_restore_snap").unwrap();

    // Target a fresh clean path
    let clean_install_path = Path::new("target/test_restore_dest.db");
    if clean_install_path.exists() {
        let _ = fs::remove_file(clean_install_path);
    }

    // Restore backup into clean install
    let report = BackupManager::restore_database(&backup_path, clean_install_path, true).unwrap();
    assert!(report.is_safe_to_restore);
    assert_eq!(report.total_sales_count, 2);
    assert_eq!(report.total_outbox_count, 2);

    // Open restored database
    let restored_conn = DatabaseManager::open_writable(clean_install_path).unwrap();

    // Verify sales count and invoice numbers
    let count: i64 = restored_conn.query_row("SELECT COUNT(*) FROM sales;", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 2);

    let (inv1, inv2): (String, String) = restored_conn.query_row(
        "SELECT MIN(invoice_number), MAX(invoice_number) FROM sales;",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_eq!(inv1, res1.invoice_number);
    assert_eq!(inv2, res2.invoice_number);

    // Verify invoice series sequence was preserved
    let current_seq: i64 = restored_conn.query_row(
        "SELECT current_seq FROM invoice_series WHERE series_code = 'IB1';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(current_seq, 102);

    // Cleanup
    let _ = fs::remove_file(src_path);
    let _ = fs::remove_file(clean_install_path);
    let _ = fs::remove_file(backup_path);
    let _ = fs::remove_dir_all(backup_dir);
}

#[test]
fn test_corrupted_database_integrity_failure_preserves_file() {
    let corrupt_path = Path::new("target/test_corrupt_quarantine.db");
    if corrupt_path.exists() {
        let _ = fs::remove_file(corrupt_path);
    }

    // Write corrupted non-SQLite garbage into file
    {
        let mut f = File::create(corrupt_path).unwrap();
        f.write_all(b"CORRUPTED_NON_SQLITE_GARBAGE_PAYLOAD_1234567890").unwrap();
    }

    // Attempting open_writable must detect corruption
    let open_res = DatabaseManager::open_writable(corrupt_path);
    assert!(open_res.is_err(), "Corrupted database MUST fail integrity check on startup");

    // Verify the file was NOT deleted or overwritten
    assert!(corrupt_path.exists(), "Original corrupted file must NOT be deleted or discarded");
    let content = fs::read(corrupt_path).unwrap();
    assert_eq!(content, b"CORRUPTED_NON_SQLITE_GARBAGE_PAYLOAD_1234567890");

    let _ = fs::remove_file(corrupt_path);
}
