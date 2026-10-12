use malgudi_pos_native::db::DatabaseManager;
use malgudi_pos_native::sync::{
    save_branch_config, get_sync_status,
    sync_inbound_catalog, start_background_sync_worker,
    stop_background_sync_worker, is_background_sync_worker_running, BranchConfig,
};
use malgudi_pos_native::auth::{provision_first_owner, ProvisionOwnerPayload};
use rusqlite::Connection;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

fn setup_test_db(path: &Path) -> Connection {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    DatabaseManager::open_writable(path).expect("Failed to open writable DB")
}

fn create_test_owner_session(conn: &Connection) -> String {
    let session = provision_first_owner(
        conn,
        &ProvisionOwnerPayload {
            username: "admin_tester".to_string(),
            display_name: "Admin Tester".to_string(),
            pin: "654321".to_string(),
            branch_id: Some("MN".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_admin_01".to_string()),
        },
    ).expect("Failed to provision owner");
    session.token
}

/// A lightweight, single-port HTTP test server that serves predetermined HTTP responses.
struct TestHttpServer {
    port: u16,
    shutdown: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestHttpServer {
    fn start(response_json: String, status_code: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind test TCP port");
        let port = listener.local_addr().unwrap().port();
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = shutdown.clone();

        let handle = thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            while !shutdown_clone.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut buffer = [0u8; 2048];
                        let _ = stream.read(&mut buffer);

                        let status_line = match status_code {
                            200 => "HTTP/1.1 200 OK",
                            403 => "HTTP/1.1 403 Forbidden",
                            401 => "HTTP/1.1 401 Unauthorized",
                            _ => "HTTP/1.1 500 Internal Server Error",
                        };

                        let response = format!(
                            "{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            status_line,
                            response_json.len(),
                            response_json
                        );
                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });

        Self {
            port,
            shutdown,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for TestHttpServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[test]
fn test_inbound_catalog_updates_applied_and_persisted() {
    let db_path = Path::new("target/test_inbound_apply.db");
    let mut conn = setup_test_db(db_path);
    let token = create_test_owner_session(&conn);

    // Initial check: Mysore Pak base price is 68000 paise (seeded in migration)
    let initial_price: i64 = conn.query_row(
        "SELECT base_price_paise FROM products WHERE sku = 'MP-001';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(initial_price, 68000);

    // Prepare mock catalog updates:
    // 1) Price hike and GST update for existing product (MP-001) at version 2
    // 2) Newly introduced product (DF-LADDU-099) at version 2
    let updates_payload = serde_json::json!({
        "latest_version": 2,
        "count": 2,
        "server_time": "2026-10-12T12:00:00Z",
        "products": [
            {
                "id": "prod_mysore_pak",
                "name": "Special Ghee Mysore Pak (Revised)",
                "tamil_name": "நெய் மைசூர் பாகு",
                "sku": "MP-001",
                "barcode": null,
                "category_id": "cat_sweets",
                "pricing_unit": "PER_KG",
                "inventory_unit": "MG",
                "pricing_basis": "TAX_INCLUSIVE",
                "base_price_paise": 74000,
                "piece_price_paise": null,
                "tax_rate_bps": 1200,
                "hsn_code": "21069099",
                "is_active": true,
                "version": 2,
                "target_branch_ids": "*",
                "updated_at": "2026-10-12T12:00:00Z"
            },
            {
                "id": "prod_df_laddu",
                "name": "Royal Dry Fruit Laddu",
                "tamil_name": "டிரை ஃப்ரூட் லட்டு",
                "sku": "DF-LADDU-099",
                "barcode": "8901234567890",
                "category_id": "cat_sweets",
                "pricing_unit": "PER_KG",
                "inventory_unit": "MG",
                "pricing_basis": "TAX_INCLUSIVE",
                "base_price_paise": 110000,
                "piece_price_paise": null,
                "tax_rate_bps": 500,
                "hsn_code": "21069099",
                "is_active": true,
                "version": 2,
                "target_branch_ids": "*",
                "updated_at": "2026-10-12T12:00:00Z"
            }
        ]
    }).to_string();

    let server = TestHttpServer::start(updates_payload, 200);

    let config = BranchConfig {
        branch_id: "MN".to_string(),
        branch_name: "Mattuthavani Branch".to_string(),
        terminal_id: "T1".to_string(),
        counter_id: "C1".to_string(),
        cloud_api_url: server.url(),
        cloud_api_key: "malgudi_sync_secret_token_2026".to_string(),
        auto_sync_enabled: true,
    };
    save_branch_config(&conn, &token, &config).unwrap();

    // Trigger Inbound Sync
    let sync_res = sync_inbound_catalog(&mut conn, Some(&token)).expect("Inbound sync must succeed");
    assert_eq!(sync_res.fetched_count, 2);
    assert_eq!(sync_res.applied_count, 2);
    assert_eq!(sync_res.skipped_stale_count, 0);
    assert_eq!(sync_res.latest_version, 2);

    // Verify product price updated
    let updated_price: i64 = conn.query_row(
        "SELECT base_price_paise FROM products WHERE sku = 'MP-001';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(updated_price, 74000);

    let updated_tax: i64 = conn.query_row(
        "SELECT tax_rate_bps FROM products WHERE sku = 'MP-001';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(updated_tax, 1200);

    // Verify new product exists
    let new_prod_exists: bool = conn.query_row(
        "SELECT 1 FROM products WHERE sku = 'DF-LADDU-099';",
        [],
        |_| Ok(true),
    ).unwrap_or(false);
    assert!(new_prod_exists);

    // Verify sync tracking in trust state
    let status = get_sync_status(&conn).unwrap();
    assert_eq!(status.last_inbound_catalog_version, 2);
    assert_eq!(status.last_inbound_sync_status, "ONLINE");
    assert!(status.last_inbound_sync_timestamp.is_some());

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_safe_inventory_separation_catalog_updates_never_overwrite_local_stock() {
    let db_path = Path::new("target/test_inventory_separation.db");
    let mut conn = setup_test_db(db_path);
    let token = create_test_owner_session(&conn);

    // Initial stock for Mysore Pak in branch MN: explicitly provision 15_000_000 mg
    conn.execute(
        "INSERT INTO stock_balances (branch_id, product_id, current_quantity, unit, updated_at)
         VALUES ('MN', 'prod_mysore_pak', 15000000, 'MG', '2026-10-12T00:00:00Z')
         ON CONFLICT(branch_id, product_id) DO UPDATE SET current_quantity = 15000000;",
        [],
    ).unwrap();

    let stock_before: i64 = conn.query_row(
        "SELECT current_quantity FROM stock_balances WHERE branch_id = 'MN' AND product_id = 'prod_mysore_pak';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(stock_before, 15000000);

    // Catalog update with price change to Rs. 800
    let updates_payload = serde_json::json!({
        "latest_version": 5,
        "count": 1,
        "server_time": "2026-10-12T12:00:00Z",
        "products": [
            {
                "id": "prod_mysore_pak",
                "name": "Super Ghee Mysore Pak",
                "tamil_name": "நெய் மைசூர் பாகு",
                "sku": "MP-001",
                "barcode": null,
                "category_id": "cat_sweets",
                "pricing_unit": "PER_KG",
                "inventory_unit": "MG",
                "pricing_basis": "TAX_INCLUSIVE",
                "base_price_paise": 80000,
                "piece_price_paise": null,
                "tax_rate_bps": 500,
                "hsn_code": "21069099",
                "is_active": true,
                "version": 5,
                "target_branch_ids": "*",
                "updated_at": "2026-10-12T12:00:00Z"
            }
        ]
    }).to_string();

    let server = TestHttpServer::start(updates_payload, 200);

    let config = BranchConfig {
        branch_id: "MN".to_string(),
        branch_name: "Mattuthavani Branch".to_string(),
        terminal_id: "T1".to_string(),
        counter_id: "C1".to_string(),
        cloud_api_url: server.url(),
        cloud_api_key: "malgudi_sync_secret_token_2026".to_string(),
        auto_sync_enabled: true,
    };
    save_branch_config(&conn, &token, &config).unwrap();

    sync_inbound_catalog(&mut conn, Some(&token)).unwrap();

    // CRITICAL INVARIANT: The local branch stock balance MUST REMAIN EXACTLY 15,000,000 mg!
    let stock_after: i64 = conn.query_row(
        "SELECT current_quantity FROM stock_balances WHERE branch_id = 'MN' AND product_id = 'prod_mysore_pak';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(stock_after, 15000000, "Catalog sync must NEVER overwrite branch stock balance!");

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_conflict_rules_stale_update_rejected() {
    let db_path = Path::new("target/test_conflict_rule.db");
    let mut conn = setup_test_db(db_path);
    let token = create_test_owner_session(&conn);

    // Set product version to 3 locally with price 72000
    conn.execute(
        "UPDATE products SET version = 3, base_price_paise = 72000 WHERE sku = 'MP-001';",
        [],
    ).unwrap();

    // Server sends a STALE update at version 2 with price 65000
    let stale_payload = serde_json::json!({
        "latest_version": 3,
        "count": 1,
        "server_time": "2026-10-12T12:00:00Z",
        "products": [
            {
                "id": "prod_mysore_pak",
                "name": "Old Version Mysore Pak",
                "tamil_name": "பழைய மைசூர் பாகு",
                "sku": "MP-001",
                "barcode": null,
                "category_id": "cat_sweets",
                "pricing_unit": "PER_KG",
                "inventory_unit": "MG",
                "pricing_basis": "TAX_INCLUSIVE",
                "base_price_paise": 65000,
                "piece_price_paise": null,
                "tax_rate_bps": 500,
                "hsn_code": "21069099",
                "is_active": true,
                "version": 2, // STALE! (2 <= local 3)
                "target_branch_ids": "*",
                "updated_at": "2026-10-11T12:00:00Z"
            }
        ]
    }).to_string();

    let server = TestHttpServer::start(stale_payload, 200);

    let config = BranchConfig {
        branch_id: "MN".to_string(),
        branch_name: "Mattuthavani Branch".to_string(),
        terminal_id: "T1".to_string(),
        counter_id: "C1".to_string(),
        cloud_api_url: server.url(),
        cloud_api_key: "malgudi_sync_secret_token_2026".to_string(),
        auto_sync_enabled: true,
    };
    save_branch_config(&conn, &token, &config).unwrap();

    let sync_res = sync_inbound_catalog(&mut conn, Some(&token)).unwrap();
    // Verify stale update was skipped
    assert_eq!(sync_res.applied_count, 0);
    assert_eq!(sync_res.skipped_stale_count, 1);

    // Local price remains at 72000 (NOT overwritten by 65000)
    let current_price: i64 = conn.query_row(
        "SELECT base_price_paise FROM products WHERE sku = 'MP-001';",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(current_price, 72000);

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_security_unauthorized_branch_forbidden() {
    let db_path = Path::new("target/test_forbidden_branch.db");
    let mut conn = setup_test_db(db_path);
    let token = create_test_owner_session(&conn);

    let forbidden_payload = serde_json::json!({
        "error": "FORBIDDEN_BRANCH",
        "message": "Branch 'UNKNOWN' is not authorized or is inactive."
    }).to_string();

    let server = TestHttpServer::start(forbidden_payload, 403);

    let config = BranchConfig {
        branch_id: "UNKNOWN".to_string(),
        branch_name: "Unauthorized Branch".to_string(),
        terminal_id: "T1".to_string(),
        counter_id: "C1".to_string(),
        cloud_api_url: server.url(),
        cloud_api_key: "malgudi_sync_secret_token_2026".to_string(),
        auto_sync_enabled: true,
    };
    save_branch_config(&conn, &token, &config).unwrap();

    let sync_res = sync_inbound_catalog(&mut conn, Some(&token)).unwrap();
    assert_eq!(sync_res.applied_count, 0);
    assert!(sync_res.last_error.is_some());
    assert!(sync_res.last_error.unwrap().contains("Branch authorization rejected"));

    let status = get_sync_status(&conn).unwrap();
    assert_eq!(status.last_inbound_sync_status, "OFFLINE");
    assert!(status.last_inbound_sync_error.is_some());

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_background_worker_lifecycle() {
    assert!(!is_background_sync_worker_running());
    let db_path = std::path::PathBuf::from("target/test_worker.db");
    start_background_sync_worker(db_path, 60);
    assert!(is_background_sync_worker_running());
    stop_background_sync_worker();
    thread::sleep(std::time::Duration::from_millis(50));
    assert!(!is_background_sync_worker_running());
}
