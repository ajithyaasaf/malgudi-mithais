use crate::auth::{record_audit_event, validate_session_and_permission};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProductRecord {
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
    pub current_stock: i64,
    pub stock_unit: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateProductPayload {
    pub name: String,
    pub tamil_name: String,
    pub sku: String,
    pub barcode: Option<String>,
    pub category_id: String,
    pub pricing_unit: String,
    pub inventory_unit: String,
    pub base_price_paise: i64,
    pub piece_price_paise: Option<i64>,
    pub tax_rate_bps: Option<i64>,
    pub hsn_code: String,
    pub initial_stock: Option<i64>,
    pub branch_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateProductPayload {
    pub id: String,
    pub name: String,
    pub tamil_name: String,
    pub sku: String,
    pub barcode: Option<String>,
    pub category_id: String,
    pub pricing_unit: String,
    pub inventory_unit: String,
    pub base_price_paise: i64,
    pub piece_price_paise: Option<i64>,
    pub tax_rate_bps: i64,
    pub hsn_code: String,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StockMovementRecord {
    pub id: String,
    pub branch_id: String,
    pub product_id: String,
    pub movement_type: String,
    pub quantity_delta: i64,
    pub unit: String,
    pub reference_id: String,
    pub reason: Option<String>,
    pub actor_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AdjustStockPayload {
    pub branch_id: String,
    pub product_id: String,
    pub movement_type: String,
    pub quantity_delta: i64,
    pub unit: String,
    pub reason: String,
    pub reference_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VoidSalePayload {
    pub sale_id: String,
    pub reason: String,
}

pub fn get_iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let s = now % 60;
    let m = (now / 60) % 60;
    let h = (now / 3600) % 24;
    let days = now / 86400;
    let mut d = days as i64;
    let mut y = 1970;
    loop {
        let leap = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            1
        } else {
            0
        };
        let days_in_y = 365 + leap;
        if d < days_in_y {
            break;
        }
        d -= days_in_y;
        y += 1;
    }
    let leap = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
        1
    } else {
        0
    };
    let month_days = [31, 28 + leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mon = 1;
    for &md in &month_days {
        if d < md {
            break;
        }
        d -= md;
        mon += 1;
    }
    let day = d + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mon, day, h, m, s)
}

/// Retrieves list of products with their live branch stock balances.
/// Accessible to authenticated cashiers and admins for catalog viewing.
pub fn list_products(
    conn: &Connection,
    branch_id: &str,
    include_inactive: bool,
) -> Result<Vec<ProductRecord>, String> {
    let query = if include_inactive {
        "SELECT 
            p.id, p.name, p.tamil_name, p.sku, p.barcode, p.category_id,
            p.pricing_unit, p.inventory_unit, p.pricing_basis, p.base_price_paise,
            p.piece_price_paise, p.tax_rate_bps, p.hsn_code, p.is_active,
            COALESCE(sb.current_quantity, 0) as current_stock,
            COALESCE(sb.unit, p.inventory_unit) as stock_unit,
            p.created_at, p.updated_at,
            COALESCE(p.version, 1) as version
         FROM products p
         LEFT JOIN stock_balances sb ON p.id = sb.product_id AND sb.branch_id = ?1
         ORDER BY p.category_id, p.name;"
    } else {
        "SELECT 
            p.id, p.name, p.tamil_name, p.sku, p.barcode, p.category_id,
            p.pricing_unit, p.inventory_unit, p.pricing_basis, p.base_price_paise,
            p.piece_price_paise, p.tax_rate_bps, p.hsn_code, p.is_active,
            COALESCE(sb.current_quantity, 0) as current_stock,
            COALESCE(sb.unit, p.inventory_unit) as stock_unit,
            p.created_at, p.updated_at,
            COALESCE(p.version, 1) as version
         FROM products p
         LEFT JOIN stock_balances sb ON p.id = sb.product_id AND sb.branch_id = ?1
         WHERE p.is_active = 1
         ORDER BY p.category_id, p.name;"
    };

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| format!("Query prepare failed: {}", e))?;
    let rows = stmt
        .query_map([branch_id], |r| {
            let is_active_int: i64 = r.get(13)?;
            Ok(ProductRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                tamil_name: r.get(2)?,
                sku: r.get(3)?,
                barcode: r.get(4)?,
                category_id: r.get(5)?,
                pricing_unit: r.get(6)?,
                inventory_unit: r.get(7)?,
                pricing_basis: r.get(8)?,
                base_price_paise: r.get(9)?,
                piece_price_paise: r.get(10)?,
                tax_rate_bps: r.get(11)?,
                hsn_code: r.get(12)?,
                is_active: is_active_int == 1,
                version: r.get(18)?,
                current_stock: r.get(14)?,
                stock_unit: r.get(15)?,
                created_at: r.get(16)?,
                updated_at: r.get(17)?,
            })
        })
        .map_err(|e| format!("Product query map error: {}", e))?;

    let mut result = Vec::new();
    for row in rows {
        if let Ok(rec) = row {
            result.push(rec);
        }
    }
    Ok(result)
}

/// Creates a new product and optionally provisions initial stock.
/// Strictly enforced: Admin permission `admin:manage_inventory` required.
pub fn create_product(
    conn: &Connection,
    session_token: &str,
    payload: &CreateProductPayload,
) -> Result<ProductRecord, String> {
    let session = validate_session_and_permission(conn, session_token, "admin:manage_inventory")?;

    let name = payload.name.trim();
    if name.is_empty() {
        return Err("Product name cannot be empty".to_string());
    }
    let tamil_name = payload.tamil_name.trim();
    let sku = payload.sku.trim();
    if sku.is_empty() {
        return Err("SKU cannot be empty".to_string());
    }
    if payload.base_price_paise <= 0 {
        return Err("Base price must be greater than zero".to_string());
    }
    let hsn = payload.hsn_code.trim();
    if hsn.is_empty() {
        return Err("HSN code cannot be empty".to_string());
    }

    // Check SKU uniqueness
    let exists: bool = conn
        .query_row("SELECT 1 FROM products WHERE sku = ?1;", [sku], |_| {
            Ok(true)
        })
        .unwrap_or(false);
    if exists {
        return Err(format!("A product with SKU '{}' already exists", sku));
    }

    let product_id = format!("prod_{}", Uuid::now_v7());
    let now = get_iso_now();
    let tax_rate = payload.tax_rate_bps.unwrap_or(500);
    let branch = payload.branch_id.as_deref().unwrap_or(&session.branch_id);

    conn.execute(
        "INSERT INTO products (
            id, name, tamil_name, sku, barcode, category_id,
            pricing_unit, inventory_unit, pricing_basis, base_price_paise,
            piece_price_paise, tax_rate_bps, hsn_code, is_active, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'TAX_INCLUSIVE', ?9, ?10, ?11, ?12, 1, ?13, ?13);",
        params![
            product_id,
            name,
            tamil_name,
            sku,
            payload.barcode.as_deref().map(|s| s.trim()),
            payload.category_id,
            payload.pricing_unit,
            payload.inventory_unit,
            payload.base_price_paise,
            payload.piece_price_paise,
            tax_rate,
            hsn,
            now,
        ],
    ).map_err(|e| format!("Failed to create product: {}", e))?;

    let initial_qty = payload.initial_stock.unwrap_or(0);
    if initial_qty > 0 {
        let sm_id = format!("sm_{}", Uuid::now_v7());
        conn.execute(
            "INSERT INTO stock_movements (
                id, branch_id, product_id, movement_type, quantity_delta, unit, reference_id, created_at, reason, actor_id
            ) VALUES (?1, ?2, ?3, 'OPENING_STOCK', ?4, ?5, 'INITIAL_PROVISION', ?6, 'Initial opening stock on product creation', ?7);",
            params![
                sm_id,
                branch,
                product_id,
                initial_qty,
                payload.inventory_unit,
                now,
                session.user_id
            ],
        ).map_err(|e| format!("Failed to record initial stock movement: {}", e))?;

        conn.execute(
            "INSERT INTO stock_balances (branch_id, product_id, current_quantity, unit, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(branch_id, product_id) DO UPDATE SET
                 current_quantity = excluded.current_quantity,
                 updated_at = excluded.updated_at;",
            params![branch, product_id, initial_qty, payload.inventory_unit, now],
        )
        .map_err(|e| format!("Failed to initialize stock balance: {}", e))?;
    }

    record_audit_event(
        conn,
        "PRODUCT_CREATED",
        "PRODUCT",
        &product_id,
        &session.user_id,
    )?;

    Ok(ProductRecord {
        id: product_id,
        name: name.to_string(),
        tamil_name: tamil_name.to_string(),
        sku: sku.to_string(),
        barcode: payload.barcode.as_deref().map(|s| s.trim().to_string()),
        category_id: payload.category_id.clone(),
        pricing_unit: payload.pricing_unit.clone(),
        inventory_unit: payload.inventory_unit.clone(),
        pricing_basis: "TAX_INCLUSIVE".to_string(),
        base_price_paise: payload.base_price_paise,
        piece_price_paise: payload.piece_price_paise,
        tax_rate_bps: tax_rate,
        hsn_code: hsn.to_string(),
        is_active: true,
        version: 1,
        current_stock: initial_qty,
        stock_unit: payload.inventory_unit.clone(),
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Updates an existing product's details and pricing.
/// Strictly enforced: Admin permission `admin:manage_inventory` required.
pub fn update_product(
    conn: &Connection,
    session_token: &str,
    payload: &UpdateProductPayload,
) -> Result<ProductRecord, String> {
    let session = validate_session_and_permission(conn, session_token, "admin:manage_inventory")?;

    let name = payload.name.trim();
    if name.is_empty() {
        return Err("Product name cannot be empty".to_string());
    }
    let tamil_name = payload.tamil_name.trim();
    let sku = payload.sku.trim();
    if sku.is_empty() {
        return Err("SKU cannot be empty".to_string());
    }
    if payload.base_price_paise <= 0 {
        return Err("Base price must be greater than zero".to_string());
    }
    let hsn = payload.hsn_code.trim();
    if hsn.is_empty() {
        return Err("HSN code cannot be empty".to_string());
    }

    // Check SKU uniqueness against other products
    let sku_conflict: bool = conn
        .query_row(
            "SELECT 1 FROM products WHERE sku = ?1 AND id != ?2;",
            params![sku, payload.id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if sku_conflict {
        return Err(format!("Another product already has the SKU '{}'", sku));
    }

    let now = get_iso_now();
    let is_active_int = if payload.is_active { 1 } else { 0 };

    conn.execute(
        "UPDATE products SET
            name = ?1,
            tamil_name = ?2,
            sku = ?3,
            barcode = ?4,
            category_id = ?5,
            pricing_unit = ?6,
            inventory_unit = ?7,
            base_price_paise = ?8,
            piece_price_paise = ?9,
            tax_rate_bps = ?10,
            hsn_code = ?11,
            is_active = ?12,
            updated_at = ?13
         WHERE id = ?14;",
        params![
            name,
            tamil_name,
            sku,
            payload.barcode.as_deref().map(|s| s.trim()),
            payload.category_id,
            payload.pricing_unit,
            payload.inventory_unit,
            payload.base_price_paise,
            payload.piece_price_paise,
            payload.tax_rate_bps,
            hsn,
            is_active_int,
            now,
            payload.id,
        ],
    )
    .map_err(|e| format!("Failed to update product: {}", e))?;

    record_audit_event(
        conn,
        "PRODUCT_UPDATED",
        "PRODUCT",
        &payload.id,
        &session.user_id,
    )?;

    // Fetch updated record with branch balance
    let current_stock: i64 = conn
        .query_row(
            "SELECT current_quantity FROM stock_balances WHERE product_id = ?1 AND branch_id = ?2;",
            params![payload.id, session.branch_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let created_at: String = conn
        .query_row(
            "SELECT created_at FROM products WHERE id = ?1;",
            [&payload.id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| now.clone());

    Ok(ProductRecord {
        id: payload.id.clone(),
        name: name.to_string(),
        tamil_name: tamil_name.to_string(),
        sku: sku.to_string(),
        barcode: payload.barcode.as_deref().map(|s| s.trim().to_string()),
        category_id: payload.category_id.clone(),
        pricing_unit: payload.pricing_unit.clone(),
        inventory_unit: payload.inventory_unit.clone(),
        pricing_basis: "TAX_INCLUSIVE".to_string(),
        base_price_paise: payload.base_price_paise,
        piece_price_paise: payload.piece_price_paise,
        tax_rate_bps: payload.tax_rate_bps,
        hsn_code: hsn.to_string(),
        is_active: payload.is_active,
        version: conn
            .query_row(
                "SELECT COALESCE(version, 1) FROM products WHERE id = ?1;",
                [&payload.id],
                |r| r.get(0),
            )
            .unwrap_or(1),
        current_stock,
        stock_unit: payload.inventory_unit.clone(),
        created_at,
        updated_at: now,
    })
}

/// Activates or deactivates a product.
/// Strictly enforced: Admin permission `admin:manage_inventory` required.
pub fn toggle_product_status(
    conn: &Connection,
    session_token: &str,
    product_id: &str,
    is_active: bool,
) -> Result<(), String> {
    let session = validate_session_and_permission(conn, session_token, "admin:manage_inventory")?;
    let now = get_iso_now();
    let is_active_int = if is_active { 1 } else { 0 };

    conn.execute(
        "UPDATE products SET is_active = ?1, updated_at = ?2 WHERE id = ?3;",
        params![is_active_int, now, product_id],
    )
    .map_err(|e| format!("Failed to toggle product status: {}", e))?;

    let action = if is_active {
        "PRODUCT_ACTIVATED"
    } else {
        "PRODUCT_DEACTIVATED"
    };
    record_audit_event(conn, action, "PRODUCT", product_id, &session.user_id)?;

    Ok(())
}

/// Adjusts stock for a product with mandatory reason and audit recording.
/// Strictly enforced: Admin permission `admin:manage_inventory` required.
pub fn adjust_stock(
    conn: &Connection,
    session_token: &str,
    payload: &AdjustStockPayload,
) -> Result<StockMovementRecord, String> {
    let session = validate_session_and_permission(conn, session_token, "admin:manage_inventory")?;

    let reason = payload.reason.trim();
    if reason.is_empty() {
        return Err(
            "MANDATORY_FIELD: A valid reason is required for stock adjustments.".to_string(),
        );
    }

    let allowed_types = [
        "OPENING_STOCK",
        "RECEIPT_PRODUCTION",
        "RECEIPT_SUPPLIER",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "WASTAGE_DAMAGE",
        "WASTAGE_EXPIRED",
        "RECONCILIATION_ADJUSTMENT",
    ];
    if !allowed_types.contains(&payload.movement_type.as_str()) {
        return Err(format!(
            "Invalid movement type: '{}'",
            payload.movement_type
        ));
    }

    // Enforce correct sign for specific movement types
    let delta = match payload.movement_type.as_str() {
        "WASTAGE_DAMAGE" | "WASTAGE_EXPIRED" | "TRANSFER_OUT" => -payload.quantity_delta.abs(),
        "RECEIPT_PRODUCTION" | "RECEIPT_SUPPLIER" | "OPENING_STOCK" | "TRANSFER_IN" => {
            payload.quantity_delta.abs()
        }
        _ => payload.quantity_delta, // RECONCILIATION_ADJUSTMENT can be positive or negative
    };

    if delta == 0 {
        return Err("Quantity delta cannot be zero".to_string());
    }

    // Verify product exists and matches unit
    let product_exists: bool = conn
        .query_row(
            "SELECT 1 FROM products WHERE id = ?1;",
            [&payload.product_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !product_exists {
        return Err(format!("Product '{}' not found", payload.product_id));
    }

    let sm_id = format!("sm_{}", Uuid::now_v7());
    let now = get_iso_now();
    let ref_id = payload.reference_id.clone().unwrap_or_else(|| {
        format!(
            "ADJ-{}",
            Uuid::now_v7()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        )
    });

    conn.execute(
        "INSERT INTO stock_movements (
            id, branch_id, product_id, movement_type, quantity_delta, unit, reference_id, created_at, reason, actor_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
        params![
            sm_id,
            payload.branch_id,
            payload.product_id,
            payload.movement_type,
            delta,
            payload.unit,
            ref_id,
            now,
            reason,
            session.user_id,
        ],
    ).map_err(|e| format!("Failed to record stock movement: {}", e))?;

    conn.execute(
        "INSERT INTO stock_balances (branch_id, product_id, current_quantity, unit, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(branch_id, product_id) DO UPDATE SET
             current_quantity = current_quantity + excluded.current_quantity,
             updated_at = excluded.updated_at;",
        params![
            payload.branch_id,
            payload.product_id,
            delta,
            payload.unit,
            now
        ],
    )
    .map_err(|e| format!("Failed to update stock balance: {}", e))?;

    // Outbox event for cloud synchronization
    let event_id = format!("sync_sm_{}", Uuid::now_v7());
    let payload_json = serde_json::to_string(&serde_json::json!({
        "id": sm_id,
        "branch_id": payload.branch_id,
        "product_id": payload.product_id,
        "movement_type": payload.movement_type,
        "quantity_delta": delta,
        "unit": payload.unit,
        "reference_id": ref_id,
        "reason": reason,
        "actor_id": session.user_id,
        "created_at": now
    }))
    .unwrap_or_default();

    let mut hasher = Sha256::new();
    hasher.update(payload_json.as_bytes());
    let payload_hash = format!("{:x}", hasher.finalize());

    let _ = conn.execute(
        "INSERT INTO sync_outbox (event_id, aggregate_type, aggregate_id, event_seq, payload_json, payload_hash, status, created_at)
         VALUES (?1, 'STOCK_MOVEMENT', ?2, 1, ?3, ?4, 'PENDING', ?5);",
        params![event_id, sm_id, payload_json, payload_hash, now],
    );

    record_audit_event(
        conn,
        "STOCK_ADJUSTED",
        "PRODUCT",
        &payload.product_id,
        &format!(
            "{}: delta={} unit={} reason={}",
            session.user_id, delta, payload.unit, reason
        ),
    )?;

    Ok(StockMovementRecord {
        id: sm_id,
        branch_id: payload.branch_id.clone(),
        product_id: payload.product_id.clone(),
        movement_type: payload.movement_type.clone(),
        quantity_delta: delta,
        unit: payload.unit.clone(),
        reference_id: ref_id,
        reason: Some(reason.to_string()),
        actor_id: Some(session.user_id),
        created_at: now,
    })
}

/// Retrieves stock movement audit trail for a product and/or branch.
pub fn list_stock_movements(
    conn: &Connection,
    session_token: &str,
    product_id: Option<String>,
    branch_id: Option<String>,
    limit: u32,
) -> Result<Vec<StockMovementRecord>, String> {
    let _session = validate_session_and_permission(conn, session_token, "admin:manage_inventory")?;

    let effective_limit = if limit == 0 || limit > 200 {
        100
    } else {
        limit
    };

    let mut query = "SELECT id, branch_id, product_id, movement_type, quantity_delta, unit, reference_id, reason, actor_id, created_at FROM stock_movements WHERE 1=1".to_string();
    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(pid) = &product_id {
        if !pid.trim().is_empty() {
            query.push_str(" AND product_id = ?");
            params_vec.push(rusqlite::types::Value::Text(pid.trim().to_string()));
        }
    }

    if let Some(bid) = &branch_id {
        if !bid.trim().is_empty() {
            query.push_str(" AND branch_id = ?");
            params_vec.push(rusqlite::types::Value::Text(bid.trim().to_string()));
        }
    }

    query.push_str(" ORDER BY created_at DESC LIMIT ?;");
    params_vec.push(rusqlite::types::Value::Integer(effective_limit as i64));

    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec), |r| {
            Ok(StockMovementRecord {
                id: r.get(0)?,
                branch_id: r.get(1)?,
                product_id: r.get(2)?,
                movement_type: r.get(3)?,
                quantity_delta: r.get(4)?,
                unit: r.get(5)?,
                reference_id: r.get(6)?,
                reason: r.get(7)?,
                actor_id: r.get(8)?,
                created_at: r.get(9)?,
            })
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let mut list = Vec::new();
    for row in rows {
        if let Ok(rec) = row {
            list.push(rec);
        }
    }
    Ok(list)
}

/// Voids an existing sale, safely restoring stock inventory and reversing cash movement.
/// Strictly enforced: Admin permission `admin:manage_inventory` required.
pub fn void_or_refund_sale(
    conn: &mut Connection,
    session_token: &str,
    payload: &VoidSalePayload,
) -> Result<(), String> {
    let session = validate_session_and_permission(conn, session_token, "admin:manage_inventory")?;

    let reason = payload.reason.trim();
    if reason.is_empty() {
        return Err(
            "MANDATORY_FIELD: A valid reason is required to void or refund a sale.".to_string(),
        );
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("Transaction error: {}", e))?;

    // 1. Verify sale exists and is not already VOIDED
    let sale_info: Option<(String, String, String, i64, String)> = tx
        .query_row(
            "SELECT branch_id, session_id, sale_status, net_payable_paise, payment_status FROM sales WHERE id = ?1;",
            [&payload.sale_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();

    let (branch_id, session_id, current_sale_status, _net_payable, _payment_status) =
        match sale_info {
            Some(info) => info,
            None => return Err(format!("Sale '{}' not found", payload.sale_id)),
        };

    if current_sale_status == "VOIDED" {
        return Err(format!(
            "Sale '{}' is already voided. Duplicate reversal rejected.",
            payload.sale_id
        ));
    }

    let now = get_iso_now();

    // 2. Fetch original deducted items for this sale from stock_movements
    let original_movements: Vec<(String, i64, String)> = {
        let mut sm_stmt = tx.prepare(
            "SELECT product_id, quantity_delta, unit FROM stock_movements WHERE reference_id = ?1 AND quantity_delta < 0;"
        ).map_err(|e| format!("Prepare stock reversal query failed: {}", e))?;

        let rows = sm_stmt
            .query_map([&payload.sale_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(|e| format!("Query map error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    // 3. Insert reversal stock movements & update stock balances
    for (product_id, qty_delta, unit) in original_movements {
        let reversal_qty = qty_delta.abs();
        let reversal_sm_id = format!("sm_void_{}", Uuid::now_v7());

        tx.execute(
            "INSERT INTO stock_movements (
                id, branch_id, product_id, movement_type, quantity_delta, unit, reference_id, created_at, reason, actor_id
            ) VALUES (?1, ?2, ?3, 'VOID_STOCK_REVERSAL', ?4, ?5, ?6, ?7, ?8, ?9);",
            params![
                reversal_sm_id,
                branch_id,
                product_id,
                reversal_qty,
                unit,
                payload.sale_id,
                now,
                format!("Void sale reversal: {}", reason),
                session.user_id,
            ],
        ).map_err(|e| format!("Failed to record stock reversal: {}", e))?;

        tx.execute(
            "INSERT INTO stock_balances (branch_id, product_id, current_quantity, unit, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(branch_id, product_id) DO UPDATE SET
                 current_quantity = current_quantity + excluded.current_quantity,
                 updated_at = excluded.updated_at;",
            params![branch_id, product_id, reversal_qty, unit, now],
        )
        .map_err(|e| format!("Failed to increment stock balance on void: {}", e))?;
    }

    // 4. Reverse cash movements if cash was received for this sale
    let cash_in_amount: i64 = tx
        .query_row(
            "SELECT COALESCE(SUM(amount_paise), 0) FROM cash_movements WHERE reference_id = ?1 AND direction = 'IN';",
            [&payload.sale_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if cash_in_amount > 0 {
        let refund_cm_id = format!("cm_refund_{}", Uuid::now_v7());
        tx.execute(
            "INSERT INTO cash_movements (
                id, session_id, branch_id, movement_type, amount_paise, direction, reference_id, created_at
            ) VALUES (?1, ?2, ?3, 'CASH_REFUND', ?4, 'OUT', ?5, ?6);",
            params![
                refund_cm_id,
                session_id,
                branch_id,
                cash_in_amount,
                payload.sale_id,
                now,
            ],
        ).map_err(|e| format!("Failed to record cash refund movement: {}", e))?;
    }

    // 5. Update sales record status to VOIDED
    tx.execute(
        "UPDATE sales SET sale_status = 'VOIDED', payment_status = 'REFUNDED' WHERE id = ?1;",
        [&payload.sale_id],
    )
    .map_err(|e| format!("Failed to update sale status: {}", e))?;

    // 6. Record audit event
    tx.execute(
        "INSERT INTO audit_events (id, action, entity_type, entity_id, actor_id, created_at)
         VALUES (?1, 'SALE_VOIDED_STOCK_RESTORED', 'SALE', ?2, ?3, ?4);",
        params![
            Uuid::now_v7().to_string(),
            payload.sale_id,
            session.user_id,
            now,
        ],
    )
    .map_err(|e| format!("Failed to record audit event: {}", e))?;

    // 7. Enqueue durable RETURN event in sync_outbox for central cloud sync
    let return_event_id = format!("sync_ret_{}", Uuid::now_v7());
    let return_payload = serde_json::to_string(&serde_json::json!({
        "sale_id": payload.sale_id,
        "branch_id": branch_id,
        "reason": reason,
        "voided_by": session.user_id,
        "voided_at": now
    }))
    .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(return_payload.as_bytes());
    let payload_hash = format!("{:x}", hasher.finalize());

    tx.execute(
        "INSERT INTO sync_outbox (event_id, aggregate_type, aggregate_id, event_seq, payload_json, payload_hash, status, created_at)
         VALUES (?1, 'RETURN', ?2, 2, ?3, ?4, 'PENDING', ?5);",
        params![return_event_id, payload.sale_id, return_payload, payload_hash, now],
    ).map_err(|e| format!("Failed to record void outbox event: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Commit void failed: {}", e))?;

    Ok(())
}
