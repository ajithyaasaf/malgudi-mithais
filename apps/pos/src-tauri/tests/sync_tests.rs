use malgudi_pos_native::db::DatabaseManager;
use malgudi_pos_native::transaction::{finalize_sale_atomic, FinalizeSalePayload, SaleItemInput, SalePaymentInput};
use malgudi_pos_native::sync::{get_branch_config, save_branch_config, get_sync_status, sync_outbox_batch, BranchConfig};
use malgudi_pos_native::auth::{provision_first_owner, ProvisionOwnerPayload};
use rusqlite::Connection;
use std::fs;
use std::path::Path;

fn setup_test_db(path: &Path) -> Connection {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    let conn = DatabaseManager::open_writable(path).expect("Failed to open writable DB");
    // Seed invoice series for MN1
    conn.execute(
        "INSERT OR IGNORE INTO invoice_series (series_code, financial_year, current_seq) VALUES ('MN1', '2627', 100);",
        [],
    ).expect("Failed to seed invoice series");
    conn
}

fn sample_mn_payload() -> FinalizeSalePayload {
    FinalizeSalePayload {
        sale_id: None,
        branch_id: "MN".into(),
        counter_id: "C1".into(),
        terminal_id: "T2".into(),
        session_id: "sess_mn_01".into(),
        business_date: "2026-10-12".into(),
        series_code: "MN1".into(),
        financial_year: "2627".into(),
        tax_policy_version: "2026.1-TN".into(),
        subtotal_taxable_paise: 20000,
        total_cgst_paise: 500,
        total_sgst_paise: 500,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: 21000,
        items: vec![
            SaleItemInput {
                product_id: "prod_mysore_pak".into(),
                quantity_input: 500000,
                pricing_unit: "PER_KG".into(),
                weight_input_source: "SCALE_AUTO".into(),
                unit_price_paise: 40000,
                taxable_paise: 20000,
                cgst_paise: 500,
                sgst_paise: 500,
                igst_paise: 0,
                total_tax_paise: 1000,
                gross_paise: 21000,
                stock_deduction_delta: -500000,
                stock_unit: "MG".into(),
            }
        ],
        payments: vec![
            SalePaymentInput {
                payment_method: "CASH".into(),
                allocated_amount_paise: 21000,
                tendered_paise: 21000,
                change_returned_paise: 0,
                net_amount_paise: 21000,
                outcome: "SUCCESS".into(),
                reference_note: None,
                verified_by_user_id: None,
            }
        ],
        cashier_id: "cashier_01".into(),
    }
}

fn create_test_owner_session(conn: &Connection) -> String {
    let session = provision_first_owner(
        conn,
        &ProvisionOwnerPayload {
            username: "test_owner".to_string(),
            display_name: "Owner Ajith".to_string(),
            pin: "123456".to_string(),
            branch_id: Some("MN".to_string()),
            terminal_id: Some("T2".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_init".to_string()),
        },
    ).expect("Failed to provision owner");
    session.token
}

#[test]
fn test_branch_config_persistence_and_isolation() {
    let db_path = Path::new("target/test_branch_config.db");
    let conn = setup_test_db(db_path);

    // Initial default should be IB
    let default_cfg = get_branch_config(&conn).unwrap();
    assert_eq!(default_cfg.branch_id, "IB");

    // Configure as Branch MN (Mattuthavani)
    let token = create_test_owner_session(&conn);
    let mn_config = BranchConfig {
        branch_id: "MN".to_string(),
        branch_name: "Mattuthavani Bus Stand Branch (MN)".to_string(),
        terminal_id: "T2".to_string(),
        counter_id: "C1".to_string(),
        cloud_api_url: "http://127.0.0.1:3000".to_string(),
        cloud_api_key: "malgudi_sync_secret_token_2026".to_string(),
        auto_sync_enabled: true,
    };

    save_branch_config(&conn, &token, &mn_config).unwrap();

    // Verify persisted config
    let loaded_cfg = get_branch_config(&conn).unwrap();
    assert_eq!(loaded_cfg.branch_id, "MN");
    assert_eq!(loaded_cfg.branch_name, "Mattuthavani Bus Stand Branch (MN)");
    assert_eq!(loaded_cfg.terminal_id, "T2");

    // Drop connection and reopen (simulating app restart)
    drop(conn);
    let reopened_conn = DatabaseManager::open_writable(db_path).unwrap();
    let reloaded_cfg = get_branch_config(&reopened_conn).unwrap();
    assert_eq!(reloaded_cfg.branch_id, "MN");
    assert_eq!(reloaded_cfg.terminal_id, "T2");

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_sale_enqueues_outbox_durably() {
    let db_path = Path::new("target/test_sale_outbox.db");
    let mut conn = setup_test_db(db_path);

    let payload = sample_mn_payload();
    let result = finalize_sale_atomic(&mut conn, &payload, None).expect("Sale finalization failed");

    // Check sale was saved
    assert!(result.invoice_number.starts_with("MN1/2627/"));

    // Check outbox has 1 PENDING record
    let status = get_sync_status(&conn).unwrap();
    assert_eq!(status.pending_count, 1);
    assert_eq!(status.total_outbox_count, 1);

    // Verify outbox record content
    let (event_id, agg_type, agg_id, outbox_status): (String, String, String, String) = conn.query_row(
        "SELECT event_id, aggregate_type, aggregate_id, status FROM sync_outbox LIMIT 1;",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).unwrap();

    assert!(!event_id.is_empty());
    assert_eq!(agg_type, "SALE");
    assert_eq!(agg_id, result.sale_id);
    assert_eq!(outbox_status, "PENDING");

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_offline_network_preserves_outbox_durably() {
    let db_path = Path::new("target/test_offline_sync.db");
    let mut conn = setup_test_db(db_path);

    // Configure an unreachable port for offline simulation
    let token = create_test_owner_session(&conn);
    let offline_cfg = BranchConfig {
        branch_id: "MN".to_string(),
        branch_name: "Mattuthavani Bus Stand".to_string(),
        terminal_id: "T2".to_string(),
        counter_id: "C1".to_string(),
        cloud_api_url: "http://127.0.0.1:59999".to_string(), // Unreachable port
        cloud_api_key: "malgudi_sync_secret_token_2026".to_string(),
        auto_sync_enabled: true,
    };
    save_branch_config(&conn, &token, &offline_cfg).unwrap();

    // Finalize a sale while offline
    let payload = sample_mn_payload();
    let result = finalize_sale_atomic(&mut conn, &payload, None).expect("Local billing must NOT fail when offline");
    assert!(!result.sale_id.is_empty());

    // Attempt sync
    let sync_res = sync_outbox_batch(&mut conn, Some(&token)).unwrap();
    assert_eq!(sync_res.processed_count, 1);
    assert_eq!(sync_res.acknowledged_count, 0);
    assert_eq!(sync_res.failed_count, 1);

    // Crucial check: The event is STILL PENDING in outbox! Data is never lost!
    let status = get_sync_status(&conn).unwrap();
    assert_eq!(status.pending_count, 1);
    assert_eq!(status.synced_count, 0);
    assert_eq!(status.last_sync_status, "OFFLINE");
    assert!(status.last_sync_error.is_some());

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_simulated_acknowledgment_updates_outbox_and_sales() {
    let db_path = Path::new("target/test_ack_sync.db");
    let mut conn = setup_test_db(db_path);

    let payload = sample_mn_payload();
    let result = finalize_sale_atomic(&mut conn, &payload, None).unwrap();

    // Before ACK
    let status_before = get_sync_status(&conn).unwrap();
    assert_eq!(status_before.pending_count, 1);
    assert_eq!(status_before.synced_count, 0);

    // Simulate server ACK
    conn.execute(
        "UPDATE sync_outbox SET status = 'ACKNOWLEDGED' WHERE aggregate_id = ?1;",
        [&result.sale_id],
    ).unwrap();
    conn.execute(
        "UPDATE sales SET sync_status = 'SERVER_ACKNOWLEDGED' WHERE id = ?1;",
        [&result.sale_id],
    ).unwrap();

    // After ACK
    let status_after = get_sync_status(&conn).unwrap();
    assert_eq!(status_after.pending_count, 0);
    assert_eq!(status_after.synced_count, 1);

    let sale_sync_status: String = conn.query_row(
        "SELECT sync_status FROM sales WHERE id = ?1;",
        [&result.sale_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(sale_sync_status, "SERVER_ACKNOWLEDGED");

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_provision_first_owner_persists_branch_and_terminal_identity() {
    let db_path = Path::new("target/test_provision_identity.db");
    let conn = setup_test_db(db_path);

    let session = provision_first_owner(&conn, &ProvisionOwnerPayload {
        username: "owner_mn".to_string(),
        display_name: "Owner Mattuthavani".to_string(),
        pin: "123456".to_string(),
        branch_id: Some("MN".to_string()),
        terminal_id: Some("T2".to_string()),
        counter_id: Some("C1".to_string()),
        session_id: Some("sess_mn_initial".to_string()),
    }).expect("Owner provisioning failed");

    assert_eq!(session.branch_id, "MN");
    assert_eq!(session.terminal_id, "T2");

    // Verify persisted directly into terminal_trust_state
    let configured_branch: String = conn.query_row(
        "SELECT value FROM terminal_trust_state WHERE key = 'branch_id';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(configured_branch, "MN");

    let configured_terminal: String = conn.query_row(
        "SELECT value FROM terminal_trust_state WHERE key = 'terminal_id';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(configured_terminal, "T2");

    let _ = fs::remove_file(db_path);
}
