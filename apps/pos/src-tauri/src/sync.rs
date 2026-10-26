use crate::auth::validate_session_and_permission;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

static BACKGROUND_WORKER_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BranchConfig {
    pub branch_id: String,
    pub branch_name: String,
    pub terminal_id: String,
    pub counter_id: String,
    pub cloud_api_url: String,
    pub cloud_api_key: String,
    pub auto_sync_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncStatusInfo {
    pub branch_id: String,
    pub branch_name: String,
    pub terminal_id: String,
    pub cloud_api_url: String,
    pub pending_count: i64,
    pub synced_count: i64,
    pub conflict_count: i64,
    pub total_outbox_count: i64,
    pub last_sync_timestamp: Option<String>,
    pub last_sync_status: String, // "ONLINE" | "OFFLINE" | "ERROR" | "IDLE"
    pub last_sync_error: Option<String>,
    pub is_online: bool,
    // Inbound Catalog Sync Tracking (Requirement 7)
    pub last_inbound_sync_timestamp: Option<String>,
    pub last_inbound_sync_status: String,
    pub last_inbound_sync_error: Option<String>,
    pub last_inbound_catalog_version: i64,
    pub auto_sync_worker_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OutboxEventRecord {
    pub event_id: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub event_seq: i64,
    pub payload_json: String,
    pub payload_hash: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncBatchResult {
    pub processed_count: usize,
    pub acknowledged_count: usize,
    pub conflict_count: usize,
    pub failed_count: usize,
    pub message: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InboundCatalogProduct {
    pub id: String,
    pub name: String,
    pub tamil_name: String,
    pub sku: String,
    pub barcode: Option<String>,
    pub category_id: String,
    pub pricing_unit: String,
    pub inventory_unit: String,
    pub pricing_basis: String,
    pub base_price_paise: i64,
    pub piece_price_paise: Option<i64>,
    pub tax_rate_bps: i64,
    pub hsn_code: String,
    pub is_active: bool,
    pub version: i64,
    pub target_branch_ids: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InboundCatalogUpdatesResponse {
    pub latest_version: i64,
    pub products: Vec<InboundCatalogProduct>,
    pub count: usize,
    pub server_time: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InboundCatalogSyncResult {
    pub fetched_count: usize,
    pub applied_count: usize,
    pub skipped_stale_count: usize,
    pub latest_version: i64,
    pub message: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BidirectionalSyncResult {
    pub outbound: SyncBatchResult,
    pub inbound: InboundCatalogSyncResult,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct BatchSyncRequestItem {
    event_id: String,
    aggregate_type: String,
    aggregate_id: String,
    payload_json: String,
    payload_hash: String,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct BatchSyncRequestPayload {
    branch_id: String,
    terminal_id: String,
    events: Vec<BatchSyncRequestItem>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BatchSyncResponseItem {
    event_id: String,
    status: String,
    acknowledged: bool,
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct BatchSyncResponsePayload {
    results: Vec<BatchSyncResponseItem>,
}

// ============================================================================
// 1. BRANCH CONFIGURATION STORAGE
// ============================================================================

/// Reads persistent branch configuration from SQLite `terminal_trust_state`.
/// Respects environment variables if set (`MALGUDI_BRANCH_ID`, `MALGUDI_TERMINAL_ID`, etc.).
pub fn get_branch_config(conn: &Connection) -> Result<BranchConfig, String> {
    let get_val = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM terminal_trust_state WHERE key = ?1;",
            [key],
            |r| r.get(0),
        )
        .ok()
    };

    let env_branch = std::env::var("MALGUDI_BRANCH_ID").ok();
    let env_terminal = std::env::var("MALGUDI_TERMINAL_ID").ok();
    let env_url = std::env::var("MALGUDI_SYNC_URL").ok();
    let env_key = std::env::var("MALGUDI_SYNC_KEY").ok();

    let branch_id = env_branch
        .or_else(|| get_val("branch_id"))
        .unwrap_or_else(|| "IB".to_string());

    let raw_name = get_val("branch_name");
    let branch_name = match raw_name {
        Some(ref name)
            if !name.contains("Town Hall")
                && !name.contains("West Veli")
                && !name.trim().is_empty() =>
        {
            name.clone()
        }
        _ => {
            let correct = if branch_id == "IB" {
                "Iyer Bungalow Branch (IB)".to_string()
            } else if branch_id == "UK" || branch_id == "MN" {
                "Umachikulam Branch (UK)".to_string()
            } else {
                format!("Branch {}", branch_id)
            };
            // Persist the corrected name so future lookups are clean
            let _ = conn.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('branch_name', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [&correct],
            );
            correct
        }
    };

    let terminal_id = env_terminal
        .or_else(|| get_val("terminal_id"))
        .unwrap_or_else(|| "T1".to_string());

    let counter_id = get_val("counter_id").unwrap_or_else(|| "C1".to_string());

    let cloud_api_url = env_url
        .or_else(|| get_val("cloud_api_url"))
        .unwrap_or_else(|| "http://127.0.0.1:3000".to_string());

    let cloud_api_key = env_key
        .or_else(|| get_val("cloud_api_key"))
        .unwrap_or_else(|| "malgudi_sync_secret_token_2026".to_string());

    let auto_sync_enabled = get_val("auto_sync_enabled")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(true);

    Ok(BranchConfig {
        branch_id,
        branch_name,
        terminal_id,
        counter_id,
        cloud_api_url,
        cloud_api_key,
        auto_sync_enabled,
    })
}

/// Saves branch configuration into `terminal_trust_state` with admin authorization.
pub fn save_branch_config(
    conn: &Connection,
    session_token: &str,
    config: &BranchConfig,
) -> Result<(), String> {
    let _session = validate_session_and_permission(conn, session_token, "admin:manage_users")?;

    let set_val = |key: &str, val: &str| -> Result<(), rusqlite::Error> {
        conn.execute(
            "INSERT INTO terminal_trust_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![key, val],
        )?;
        Ok(())
    };

    set_val("branch_id", config.branch_id.trim())
        .map_err(|e| format!("Failed to save branch_id: {}", e))?;
    set_val("branch_name", config.branch_name.trim())
        .map_err(|e| format!("Failed to save branch_name: {}", e))?;
    set_val("terminal_id", config.terminal_id.trim())
        .map_err(|e| format!("Failed to save terminal_id: {}", e))?;
    set_val("counter_id", config.counter_id.trim())
        .map_err(|e| format!("Failed to save counter_id: {}", e))?;
    set_val("cloud_api_url", config.cloud_api_url.trim())
        .map_err(|e| format!("Failed to save cloud_api_url: {}", e))?;

    // Invariant: Do not overwrite valid key with bullet mask or empty input
    let key_to_save = config.cloud_api_key.trim();
    if !key_to_save.is_empty() && key_to_save != "••••••••" {
        set_val("cloud_api_key", key_to_save)
            .map_err(|e| format!("Failed to save cloud_api_key: {}", e))?;
    }

    set_val(
        "auto_sync_enabled",
        if config.auto_sync_enabled {
            "true"
        } else {
            "false"
        },
    )
    .map_err(|e| format!("Failed to save auto_sync_enabled: {}", e))?;

    // Synchronize active session in user_sessions table so that in-flight billing immediately inherits new branch/terminal
    let _ = conn.execute(
        "UPDATE user_sessions SET branch_id = ?1, terminal_id = ?2, counter_id = ?3 WHERE token = ?4;",
        params![config.branch_id.trim(), config.terminal_id.trim(), config.counter_id.trim(), session_token],
    );

    // If branch is being configured as Umachikulam (UK/MN), harmonize any unassigned default 'IB' sales on this local terminal
    let target_branch = config.branch_id.trim();
    if target_branch == "UK" || target_branch == "MN" {
        let _ = conn.execute(
            "UPDATE sales SET branch_id = ?1 WHERE branch_id = 'IB';",
            params![target_branch],
        );
        let _ = conn.execute(
            "UPDATE cash_movements SET branch_id = ?1 WHERE branch_id = 'IB' AND movement_type != 'OPENING_FLOAT';",
            params![target_branch],
        );
        let _ = conn.execute(
            "UPDATE cash_movements SET branch_id = ?1 
             WHERE branch_id = 'IB' AND movement_type = 'OPENING_FLOAT'
               AND SUBSTR(created_at, 1, 10) NOT IN (
                 SELECT SUBSTR(created_at, 1, 10) FROM cash_movements WHERE branch_id = ?1 AND movement_type = 'OPENING_FLOAT'
               );",
            params![target_branch],
        );
        let _ = conn.execute(
            "UPDATE stock_movements SET branch_id = ?1 WHERE branch_id = 'IB';",
            params![target_branch],
        );
    }

    crate::auth::record_audit_event(
        conn,
        "BRANCH_CONFIG_UPDATED",
        "SYSTEM",
        &config.branch_id,
        &_session.user_id,
    )?;

    Ok(())
}

// ============================================================================
// 2. SYNCHRONIZATION STATUS QUERIES
// ============================================================================

pub fn get_sync_status(conn: &Connection) -> Result<SyncStatusInfo, String> {
    let config = get_branch_config(conn)?;

    let pending_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_outbox WHERE status = 'PENDING';",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let synced_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_outbox WHERE status = 'ACKNOWLEDGED';",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let conflict_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_outbox WHERE status = 'CONFLICT';",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let total_outbox_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_outbox;", [], |r| r.get(0))
        .unwrap_or(0);

    let get_val = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM terminal_trust_state WHERE key = ?1;",
            [key],
            |r| r.get(0),
        )
        .ok()
    };

    let last_sync_timestamp = get_val("last_sync_timestamp");
    let last_sync_status = get_val("last_sync_status").unwrap_or_else(|| "IDLE".to_string());
    let last_sync_error = get_val("last_sync_error");

    let last_inbound_sync_timestamp = get_val("last_inbound_sync_timestamp");
    let last_inbound_sync_status =
        get_val("last_inbound_sync_status").unwrap_or_else(|| "IDLE".to_string());
    let last_inbound_sync_error = get_val("last_inbound_sync_error");
    let last_inbound_catalog_version: i64 = get_val("last_inbound_catalog_version")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let is_online = last_sync_status == "ONLINE" || last_inbound_sync_status == "ONLINE";
    let auto_sync_worker_active = is_background_sync_worker_running();

    Ok(SyncStatusInfo {
        branch_id: config.branch_id,
        branch_name: config.branch_name,
        terminal_id: config.terminal_id,
        cloud_api_url: config.cloud_api_url,
        pending_count,
        synced_count,
        conflict_count,
        total_outbox_count,
        last_sync_timestamp,
        last_sync_status,
        last_sync_error,
        is_online,
        last_inbound_sync_timestamp,
        last_inbound_sync_status,
        last_inbound_sync_error,
        last_inbound_catalog_version,
        auto_sync_worker_active,
    })
}

// ============================================================================
// 3. OUTBOX UPLOAD & SYNCHRONIZATION ENGINE
// ============================================================================

/// Synchronizes pending outbox events to the Central Cloud API.
/// Preserves ACID durability: events remain 'PENDING' if network or server fails.
pub fn sync_outbox_batch(
    conn: &mut Connection,
    session_token: Option<&str>,
) -> Result<SyncBatchResult, String> {
    if let Some(token) = session_token {
        let _ = validate_session_and_permission(conn, token, "admin:view_reports")?;
    }

    let config = get_branch_config(conn)?;

    // 1. Fetch pending outbox rows in chronological order
    let pending_records: Vec<OutboxEventRecord> = {
        let mut stmt = conn
            .prepare(
                "SELECT event_id, aggregate_type, aggregate_id, event_seq, payload_json, payload_hash, status, created_at
                 FROM sync_outbox
                 WHERE status = 'PENDING'
                 ORDER BY created_at ASC
                 LIMIT 50;",
            )
            .map_err(|e| format!("Query prepare error: {}", e))?;

        let rows = stmt
            .query_map([], |r| {
                Ok(OutboxEventRecord {
                    event_id: r.get(0)?,
                    aggregate_type: r.get(1)?,
                    aggregate_id: r.get(2)?,
                    event_seq: r.get(3)?,
                    payload_json: r.get(4)?,
                    payload_hash: r.get(5)?,
                    status: r.get(6)?,
                    created_at: r.get(7)?,
                })
            })
            .map_err(|e| format!("Query execution error: {}", e))?;

        let mut list = Vec::new();
        for r in rows {
            if let Ok(rec) = r {
                list.push(rec);
            }
        }
        list
    };

    if pending_records.is_empty() {
        return Ok(SyncBatchResult {
            processed_count: 0,
            acknowledged_count: 0,
            conflict_count: 0,
            failed_count: 0,
            message: "Sync outbox is clear. Zero pending records.".to_string(),
            last_error: None,
        });
    }

    // 2. Prepare payload
    let req_items: Vec<BatchSyncRequestItem> = pending_records
        .iter()
        .map(|r| BatchSyncRequestItem {
            event_id: r.event_id.clone(),
            aggregate_type: r.aggregate_type.clone(),
            aggregate_id: r.aggregate_id.clone(),
            payload_json: r.payload_json.clone(),
            payload_hash: r.payload_hash.clone(),
            created_at: r.created_at.clone(),
        })
        .collect();

    let batch_payload = BatchSyncRequestPayload {
        branch_id: config.branch_id.clone(),
        terminal_id: config.terminal_id.clone(),
        events: req_items,
    };

    let target_url = format!(
        "{}/api/v1/sync/batch",
        config.cloud_api_url.trim_end_matches('/')
    );

    if config.cloud_api_key.trim().is_empty() {
        return Ok(SyncBatchResult {
            processed_count: 0,
            acknowledged_count: 0,
            conflict_count: 0,
            failed_count: pending_records.len(),
            message: "Sync aborted: Cloud sync API key is not configured.".to_string(),
            last_error: Some("UNCONFIGURED_CLOUD_API_KEY".to_string()),
        });
    }

    // 3. Transmit via ureq with timeout
    let response = ureq::post(&target_url)
        .timeout(Duration::from_secs(5))
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", config.cloud_api_key))
        .set("X-Terminal-Id", &config.terminal_id)
        .set("X-Branch-Id", &config.branch_id)
        .send_json(&batch_payload);

    let now_iso = crate::inventory::get_iso_now();

    match response {
        Ok(res) => {
            let res_body: BatchSyncResponsePayload = res
                .into_json()
                .map_err(|e| format!("Failed to parse server batch response: {}", e))?;

            let mut ack_count = 0;
            let mut conf_count = 0;
            let mut fail_count = 0;

            let tx = conn.transaction().map_err(|e| e.to_string())?;

            for item in res_body.results {
                if item.acknowledged {
                    ack_count += 1;
                    tx.execute(
                        "UPDATE sync_outbox SET status = 'ACKNOWLEDGED' WHERE event_id = ?1;",
                        [&item.event_id],
                    )
                    .map_err(|e| e.to_string())?;

                    // Update corresponding sale sync status if event is a sale
                    tx.execute(
                        "UPDATE sales SET sync_status = 'SERVER_ACKNOWLEDGED' 
                         WHERE id = (SELECT aggregate_id FROM sync_outbox WHERE event_id = ?1 AND aggregate_type = 'SALE');",
                        [&item.event_id],
                    )
                    .map_err(|e| e.to_string())?;
                } else if item.status == "REJECTED_PAYLOAD_MUTATION" {
                    conf_count += 1;
                    tx.execute(
                        "UPDATE sync_outbox SET status = 'CONFLICT' WHERE event_id = ?1;",
                        [&item.event_id],
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    fail_count += 1;
                }
            }

            // Save sync status in trust state
            tx.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_sync_timestamp', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [&now_iso],
            )
            .map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_sync_status', 'ONLINE')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [],
            )
            .map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_sync_error', '')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [],
            )
            .map_err(|e| e.to_string())?;

            tx.commit().map_err(|e| e.to_string())?;

            Ok(SyncBatchResult {
                processed_count: pending_records.len(),
                acknowledged_count: ack_count,
                conflict_count: conf_count,
                failed_count: fail_count,
                message: format!(
                    "Batch processed: {} acknowledged, {} conflicts, {} buffered/failed.",
                    ack_count, conf_count, fail_count
                ),
                last_error: None,
            })
        }
        Err(err) => {
            let err_msg = format!("Sync network failure: {}. Billing continues offline.", err);

            // Record offline state
            let _ = conn.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_sync_status', 'OFFLINE')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [],
            );
            let _ = conn.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_sync_error', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [&err_msg],
            );

            Ok(SyncBatchResult {
                processed_count: pending_records.len(),
                acknowledged_count: 0,
                conflict_count: 0,
                failed_count: pending_records.len(),
                message: err_msg.clone(),
                last_error: Some(err_msg),
            })
        }
    }
}

// ============================================================================
// 4. INBOUND CATALOG SYNCHRONIZATION (Requirement 2, 3, 4, 6)
// ============================================================================

/// Fetches incremental product and catalog updates from the Central Cloud API.
/// Applies updates to local `products` table atomically.
/// Safe Inventory Handling: NEVER overwrites or mutates branch `stock_balances` or sales records!
/// Conflict Rules: Strictly rejects stale updates if `incoming.version <= local.version`.
pub fn sync_inbound_catalog(
    conn: &mut Connection,
    session_token: Option<&str>,
) -> Result<InboundCatalogSyncResult, String> {
    if let Some(token) = session_token {
        let _ = validate_session_and_permission(conn, token, "admin:view_reports")?;
    }

    let config = get_branch_config(conn)?;

    let last_version: i64 = conn
        .query_row(
            "SELECT value FROM terminal_trust_state WHERE key = 'last_inbound_catalog_version';",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let target_url = format!(
        "{}/api/v1/catalog/updates?since_version={}",
        config.cloud_api_url.trim_end_matches('/'),
        last_version
    );

    if config.cloud_api_key.trim().is_empty() {
        return Ok(InboundCatalogSyncResult {
            fetched_count: 0,
            applied_count: 0,
            skipped_stale_count: 0,
            latest_version: last_version,
            message: "Inbound sync aborted: Cloud sync API key is not configured.".to_string(),
            last_error: Some("UNCONFIGURED_CLOUD_API_KEY".to_string()),
        });
    }

    let response = ureq::get(&target_url)
        .timeout(Duration::from_secs(5))
        .set("Authorization", &format!("Bearer {}", config.cloud_api_key))
        .set("X-Terminal-Id", &config.terminal_id)
        .set("X-Branch-Id", &config.branch_id)
        .call();

    let now_iso = crate::inventory::get_iso_now();

    match response {
        Ok(res) => {
            let updates: InboundCatalogUpdatesResponse = res
                .into_json()
                .map_err(|e| format!("Failed to parse catalog updates response: {}", e))?;

            let mut applied_count = 0;
            let mut skipped_stale_count = 0;
            let fetched_count = updates.products.len();

            let tx = conn.transaction().map_err(|e| e.to_string())?;

            for p in &updates.products {
                // Check existing product in local database by ID or SKU
                let existing_info: Option<(String, i64)> = tx
                    .query_row(
                        "SELECT id, COALESCE(version, 1) FROM products WHERE id = ?1 OR sku = ?2 LIMIT 1;",
                        params![p.id, p.sku],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .ok();

                if let Some((existing_id, local_version)) = existing_info {
                    // Conflict Rule: Reject stale updates where incoming version <= local version
                    if p.version <= local_version {
                        skipped_stale_count += 1;
                        continue;
                    }

                    // Newer version: apply product definition updates
                    // Safe Inventory Handling: We NEVER touch or overwrite stock_balances or sales records!
                    let is_active_int = if p.is_active { 1 } else { 0 };
                    tx.execute(
                        "UPDATE products SET
                            name = ?1,
                            tamil_name = ?2,
                            sku = ?3,
                            barcode = ?4,
                            category_id = ?5,
                            pricing_unit = ?6,
                            inventory_unit = ?7,
                            pricing_basis = ?8,
                            base_price_paise = ?9,
                            piece_price_paise = ?10,
                            tax_rate_bps = ?11,
                            hsn_code = ?12,
                            is_active = ?13,
                            version = ?14,
                            updated_at = ?15
                         WHERE id = ?16;",
                        params![
                            p.name,
                            p.tamil_name,
                            p.sku,
                            p.barcode.as_deref().map(|s| s.trim()),
                            p.category_id,
                            p.pricing_unit,
                            p.inventory_unit,
                            p.pricing_basis,
                            p.base_price_paise,
                            p.piece_price_paise,
                            p.tax_rate_bps,
                            p.hsn_code,
                            is_active_int,
                            p.version,
                            p.updated_at,
                            existing_id,
                        ],
                    )
                    .map_err(|e| format!("Failed to update local product {}: {}", p.sku, e))?;

                    applied_count += 1;
                } else {
                    // New product creation
                    let is_active_int = if p.is_active { 1 } else { 0 };
                    tx.execute(
                        "INSERT INTO products (
                            id, name, tamil_name, sku, barcode, category_id,
                            pricing_unit, inventory_unit, pricing_basis, base_price_paise,
                            piece_price_paise, tax_rate_bps, hsn_code, is_active, version,
                            created_at, updated_at
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16);",
                        params![
                            p.id,
                            p.name,
                            p.tamil_name,
                            p.sku,
                            p.barcode.as_deref().map(|s| s.trim()),
                            p.category_id,
                            p.pricing_unit,
                            p.inventory_unit,
                            p.pricing_basis,
                            p.base_price_paise,
                            p.piece_price_paise,
                            p.tax_rate_bps,
                            p.hsn_code,
                            is_active_int,
                            p.version,
                            p.updated_at,
                        ],
                    )
                    .map_err(|e| format!("Failed to insert new product {}: {}", p.sku, e))?;

                    // Safe Inventory Handling: Initialize branch stock balance to 0 IF not present
                    let has_balance: bool = tx
                        .query_row(
                            "SELECT 1 FROM stock_balances WHERE branch_id = ?1 AND product_id = ?2;",
                            params![config.branch_id, p.id],
                            |_| Ok(true),
                        )
                        .unwrap_or(false);

                    if !has_balance {
                        tx.execute(
                            "INSERT INTO stock_balances (branch_id, product_id, current_quantity, unit, updated_at)
                             VALUES (?1, ?2, 0, ?3, ?4);",
                            params![config.branch_id, p.id, p.inventory_unit, now_iso],
                        )
                        .map_err(|e| format!("Failed to initialize zero balance for product {}: {}", p.sku, e))?;
                    }

                    applied_count += 1;
                }
            }

            let new_catalog_version = std::cmp::max(last_version, updates.latest_version);

            // Persist inbound sync state
            tx.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_inbound_catalog_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [&new_catalog_version.to_string()],
            )
            .map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_inbound_sync_timestamp', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [&now_iso],
            )
            .map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_inbound_sync_status', 'ONLINE')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [],
            )
            .map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_inbound_sync_error', '')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [],
            )
            .map_err(|e| e.to_string())?;

            tx.commit().map_err(|e| e.to_string())?;

            Ok(InboundCatalogSyncResult {
                fetched_count,
                applied_count,
                skipped_stale_count,
                latest_version: new_catalog_version,
                message: format!(
                    "Inbound sync complete: {} applied, {} skipped stale, version at {}.",
                    applied_count, skipped_stale_count, new_catalog_version
                ),
                last_error: None,
            })
        }
        Err(err) => {
            let err_msg = match &err {
                ureq::Error::Status(403, _) => "Branch authorization rejected by central server (403 Forbidden). Terminal not permitted for branch.".to_string(),
                ureq::Error::Status(401, _) => "Central server rejected terminal credentials (401 Unauthorized). Check API key.".to_string(),
                ureq::Error::Status(code, _) => format!("Central catalog server HTTP error {}", code),
                ureq::Error::Transport(t) => format!("Network offline or server unreachable: {}", t),
            };

            let _ = conn.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_inbound_sync_status', 'OFFLINE')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [],
            );
            let _ = conn.execute(
                "INSERT INTO terminal_trust_state (key, value) VALUES ('last_inbound_sync_error', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [&err_msg],
            );

            Ok(InboundCatalogSyncResult {
                fetched_count: 0,
                applied_count: 0,
                skipped_stale_count: 0,
                latest_version: last_version,
                message: format!(
                    "Inbound sync offline: {}. Billing continues uninterrupted.",
                    err_msg
                ),
                last_error: Some(err_msg),
            })
        }
    }
}

// ============================================================================
// 5. BIDIRECTIONAL SYNCHRONIZATION
// ============================================================================

/// Performs full bidirectional sync: pushes outbound event batch then pulls inbound catalog updates.
pub fn sync_bidirectional(
    conn: &mut Connection,
    session_token: Option<&str>,
) -> Result<BidirectionalSyncResult, String> {
    let outbound = sync_outbox_batch(conn, session_token)?;
    let inbound = sync_inbound_catalog(conn, session_token)?;

    let status = if outbound.last_error.is_none() && inbound.last_error.is_none() {
        "ONLINE".to_string()
    } else if outbound.last_error.is_some() && inbound.last_error.is_some() {
        "OFFLINE".to_string()
    } else {
        "PARTIAL".to_string()
    };

    let message = format!(
        "Bidirectional Sync: {} outbound acked, {} inbound applied.",
        outbound.acknowledged_count, inbound.applied_count
    );

    Ok(BidirectionalSyncResult {
        outbound,
        inbound,
        status,
        message,
    })
}

// ============================================================================
// 6. MANAGED BACKGROUND WORKER (Requirement 5)
// ============================================================================

pub fn is_background_sync_worker_running() -> bool {
    BACKGROUND_WORKER_ACTIVE.load(Ordering::SeqCst)
}

pub fn stop_background_sync_worker() {
    BACKGROUND_WORKER_ACTIVE.store(false, Ordering::SeqCst);
}

/// Spawns an autonomous background daemon thread that periodically synchronizes
/// pending outbox records and checks for inbound catalog updates.
/// Gracefully recovers when connectivity returns without interrupting active billing.
pub fn start_background_sync_worker(db_path: PathBuf, interval_secs: u64) {
    if BACKGROUND_WORKER_ACTIVE.swap(true, Ordering::SeqCst) {
        return; // Worker already running
    }

    thread::spawn(move || {
        let mut loop_count: u64 = 0;
        let mut backup_timer: u64 = 0;

        while BACKGROUND_WORKER_ACTIVE.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_secs(1));
            loop_count += 1;
            backup_timer += 1;

            if loop_count >= interval_secs {
                loop_count = 0;

                if let Ok(mut conn) = crate::db::DatabaseManager::open_writable(&db_path) {
                    if let Ok(config) = get_branch_config(&conn) {
                        if config.auto_sync_enabled {
                            let _ = sync_bidirectional(&mut conn, None);
                        }
                    }

                    // Scheduled automatic backup every 1800 seconds (30 mins) with rolling 7-snapshot retention
                    if backup_timer >= 1800 {
                        backup_timer = 0;
                        let backup_dir = db_path.parent().unwrap_or(Path::new(".")).join("backups");
                        let _ = crate::backup::BackupManager::run_scheduled_backup_with_retention(
                            &conn,
                            &backup_dir,
                            7,
                        );
                    }
                }
            }
        }
    });
}
