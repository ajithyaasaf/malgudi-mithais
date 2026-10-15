use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_FAILED_ATTEMPTS: i64 = 5;
const LOCKOUT_SECONDS: u64 = 30;
const SESSION_EXPIRY_HOURS: i64 = 8;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserRecord {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    pub token: String,
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub branch_id: String,
    pub terminal_id: String,
    pub counter_id: String,
    pub session_id: String,
    pub permissions: Vec<String>,
    pub expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthStatusResponse {
    pub is_provisioned: bool,
    pub active_session: Option<SessionInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProvisionOwnerPayload {
    pub username: String,
    pub display_name: String,
    pub pin: String,
    pub branch_id: Option<String>,
    pub terminal_id: Option<String>,
    pub counter_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginPayload {
    pub username: String,
    pub pin: String,
    pub branch_id: Option<String>,
    pub terminal_id: Option<String>,
    pub counter_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SwitchCashierPayload {
    pub active_token: String,
    pub incoming_username: String,
    pub incoming_pin: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateUserPayload {
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub pin: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuditEventRecord {
    pub id: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub actor_id: String,
    pub created_at: String,
}

fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Standard UTC epoch string representation
    format!("{}", now)
}

fn iso_future_hours(hours: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", now + (hours as u64 * 3600))
}

fn iso_future_seconds(secs: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", now + secs)
}

fn current_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Cryptographically secure Argon2id PIN/password hashing with unique random salt.
pub fn hash_pin(pin: &str) -> Result<String, String> {
    if pin.trim().len() < 4 {
        return Err("PIN/password must be at least 4 characters".to_string());
    }
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let password_hash = argon2
        .hash_password(pin.as_bytes(), &salt)
        .map_err(|e| format!("Argon2id hashing error: {}", e))?;
    Ok(password_hash.to_string())
}

/// Verifies a PIN against an Argon2id PHC string.
pub fn verify_pin(pin: &str, hash_str: &str) -> bool {
    let parsed_hash = match PasswordHash::new(hash_str) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(pin.as_bytes(), &parsed_hash)
        .is_ok()
}

/// Checks whether any user has been provisioned.
pub fn is_provisioned(conn: &Connection) -> Result<bool, String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM users;", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

/// Records security audit event in `audit_events`.
pub fn record_audit_event(
    conn: &Connection,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    actor_id: &str,
) -> Result<(), String> {
    let id = Uuid::now_v7().to_string();
    let now = iso_now();
    conn.execute(
        "INSERT INTO audit_events (id, action, entity_type, entity_id, actor_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
        params![id, action, entity_type, entity_id, actor_id, now],
    )
    .map_err(|e| format!("Failed to record audit event: {}", e))?;
    Ok(())
}

fn get_permissions_for_role(conn: &Connection, role: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT permission FROM user_permissions WHERE role = ?1 ORDER BY permission ASC;")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([role], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut perms = Vec::new();
    for p in rows {
        if let Ok(perm) = p {
            perms.push(perm);
        }
    }
    Ok(perms)
}

/// First-run owner setup. Permitted ONLY when zero users exist in the database.
pub fn provision_first_owner(
    conn: &Connection,
    payload: &ProvisionOwnerPayload,
) -> Result<SessionInfo, String> {
    let already_provisioned = is_provisioned(conn)?;
    if already_provisioned {
        return Err("OWNER_ALREADY_EXISTS: System has already been provisioned. Use owner credentials to log in.".to_string());
    }

    let username = payload.username.trim().to_lowercase();
    if username.is_empty() {
        return Err("Username cannot be empty".to_string());
    }
    let display_name = payload.display_name.trim().to_string();
    if display_name.is_empty() {
        return Err("Display name cannot be empty".to_string());
    }

    let pin_hash = hash_pin(&payload.pin)?;
    let user_id = Uuid::now_v7().to_string();
    let now = iso_now();

    conn.execute(
        "INSERT INTO users (id, username, display_name, role, pin_hash, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'ADMIN', ?4, 'ACTIVE', ?5, ?5);",
        params![user_id, username, display_name, pin_hash, now],
    )
    .map_err(|e| format!("Failed to provision owner user: {}", e))?;

    record_audit_event(conn, "OWNER_PROVISIONED", "USER", &user_id, &user_id)?;

    // Create initial authenticated session
    let token = Uuid::now_v7().to_string();
    let branch_id = payload
        .branch_id
        .clone()
        .unwrap_or_else(|| "IB".to_string());
    let terminal_id = payload
        .terminal_id
        .clone()
        .unwrap_or_else(|| "T1".to_string());
    let counter_id = payload
        .counter_id
        .clone()
        .unwrap_or_else(|| "C1".to_string());
    let date_str = if now.len() >= 10 { now[0..10].replace('-', "") } else { "20261015".to_string() };
    let session_id = payload
        .session_id
        .clone()
        .filter(|s| !s.trim().is_empty() && s != "sess_madurai_01")
        .unwrap_or_else(|| {
            let short_tok = if token.len() >= 8 { &token[..8] } else { "01" };
            format!("sess_{}_{}_{}", branch_id, date_str, short_tok)
        });
    let expires_at = iso_future_hours(SESSION_EXPIRY_HOURS);

    conn.execute(
        "INSERT INTO user_sessions (token, user_id, username, display_name, role, branch_id, terminal_id, counter_id, session_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, 'ADMIN', ?5, ?6, ?7, ?8, ?9, ?10);",
        params![token, user_id, username, display_name, branch_id, terminal_id, counter_id, session_id, now, expires_at],
    )
    .map_err(|e| format!("Failed to create initial session: {}", e))?;

    // Persist configured branch, terminal, and counter identities to terminal_trust_state
    let _ = conn.execute(
        "INSERT INTO terminal_trust_state (key, value) VALUES ('branch_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        params![&branch_id],
    );
    let _ = conn.execute(
        "INSERT INTO terminal_trust_state (key, value) VALUES ('terminal_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        params![&terminal_id],
    );
    let _ = conn.execute(
        "INSERT INTO terminal_trust_state (key, value) VALUES ('counter_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        params![&counter_id],
    );

    let permissions = get_permissions_for_role(conn, "ADMIN")?;

    Ok(SessionInfo {
        token,
        user_id,
        username,
        display_name,
        role: "ADMIN".to_string(),
        branch_id,
        terminal_id,
        counter_id,
        session_id,
        permissions,
        expires_at,
    })
}

/// Authenticates username and PIN. Enforces failed attempt throttling and lockout.
pub fn login(conn: &Connection, payload: &LoginPayload) -> Result<SessionInfo, String> {
    let username = payload.username.trim().to_lowercase();
    let now_epoch = current_epoch();

    // Check failed attempt lockout
    let lockout_info: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT failed_count, locked_until FROM auth_attempts WHERE username = ?1;",
            [&username],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();

    if let Some((_count, Some(locked_until_str))) = &lockout_info {
        if let Ok(locked_epoch) = locked_until_str.parse::<u64>() {
            if now_epoch < locked_epoch {
                let remaining_secs = locked_epoch - now_epoch;
                record_audit_event(
                    conn,
                    "LOGIN_BLOCKED_ACCOUNT_LOCKED",
                    "AUTH",
                    &username,
                    &username,
                )?;
                return Err(format!(
                    "ACCOUNT_LOCKED: Too many failed login attempts. Try again in {} seconds.",
                    remaining_secs
                ));
            }
        }
    }

    // Lookup user
    let user_row: Option<(String, String, String, String, String)> = conn
        .query_row(
            "SELECT id, display_name, role, pin_hash, status FROM users WHERE username = ?1;",
            [&username],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();

    let (user_id, display_name, role, pin_hash, status) = match user_row {
        Some(row) => row,
        None => {
            record_failed_attempt(conn, &username)?;
            record_audit_event(
                conn,
                "LOGIN_FAILED_UNKNOWN_USER",
                "AUTH",
                &username,
                "UNKNOWN",
            )?;
            return Err("INVALID_CREDENTIALS: Invalid username or PIN.".to_string());
        }
    };

    if status != "ACTIVE" {
        record_audit_event(
            conn,
            "LOGIN_REJECTED_DISABLED_ACCOUNT",
            "USER",
            &user_id,
            &username,
        )?;
        return Err(
            "ACCOUNT_DISABLED: This account has been disabled. Contact store owner.".to_string(),
        );
    }

    if !verify_pin(&payload.pin, &pin_hash) {
        let attempts = record_failed_attempt(conn, &username)?;
        record_audit_event(
            conn,
            "LOGIN_FAILED_INCORRECT_PIN",
            "USER",
            &user_id,
            &username,
        )?;
        if attempts >= MAX_FAILED_ATTEMPTS {
            return Err(format!(
                "ACCOUNT_LOCKED: 5 consecutive failed attempts. Account locked for {} seconds.",
                LOCKOUT_SECONDS
            ));
        }
        return Err("INVALID_CREDENTIALS: Invalid username or PIN.".to_string());
    }

    // Reset failed attempts upon successful login
    let _ = conn.execute(
        "DELETE FROM auth_attempts WHERE username = ?1;",
        [&username],
    );

    // Fall back to configured terminal identities in terminal_trust_state
    let configured_branch: Option<String> = conn
        .query_row(
            "SELECT value FROM terminal_trust_state WHERE key = 'branch_id';",
            [],
            |r| r.get(0),
        )
        .ok();
    let configured_terminal: Option<String> = conn
        .query_row(
            "SELECT value FROM terminal_trust_state WHERE key = 'terminal_id';",
            [],
            |r| r.get(0),
        )
        .ok();
    let configured_counter: Option<String> = conn
        .query_row(
            "SELECT value FROM terminal_trust_state WHERE key = 'counter_id';",
            [],
            |r| r.get(0),
        )
        .ok();

    // Create session
    let token = Uuid::now_v7().to_string();
    let branch_id = payload
        .branch_id
        .clone()
        .or(configured_branch)
        .unwrap_or_else(|| "IB".to_string());
    let terminal_id = payload
        .terminal_id
        .clone()
        .or(configured_terminal)
        .unwrap_or_else(|| "T1".to_string());
    let counter_id = payload
        .counter_id
        .clone()
        .or(configured_counter)
        .unwrap_or_else(|| "C1".to_string());
    let now = iso_now();
    let date_str = if now.len() >= 10 { now[0..10].replace('-', "") } else { "20261015".to_string() };
    let session_id = payload
        .session_id
        .clone()
        .filter(|s| !s.trim().is_empty() && s != "sess_madurai_01")
        .unwrap_or_else(|| {
            let short_tok = if token.len() >= 8 { &token[..8] } else { "01" };
            format!("sess_{}_{}_{}", branch_id, date_str, short_tok)
        });
    let expires_at = iso_future_hours(SESSION_EXPIRY_HOURS);

    conn.execute(
        "INSERT INTO user_sessions (token, user_id, username, display_name, role, branch_id, terminal_id, counter_id, session_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
        params![token, user_id, username, display_name, role, branch_id, terminal_id, counter_id, session_id, now, expires_at],
    )
    .map_err(|e| format!("Failed to create user session: {}", e))?;

    record_audit_event(conn, "USER_LOGIN_SUCCESS", "SESSION", &token, &user_id)?;

    let permissions = get_permissions_for_role(conn, &role)?;

    Ok(SessionInfo {
        token,
        user_id,
        username,
        display_name,
        role,
        branch_id,
        terminal_id,
        counter_id,
        session_id,
        permissions,
        expires_at,
    })
}

fn record_failed_attempt(conn: &Connection, username: &str) -> Result<i64, String> {
    let mut current_attempts: i64 = conn
        .query_row(
            "SELECT failed_count FROM auth_attempts WHERE username = ?1;",
            [username],
            |r| r.get(0),
        )
        .unwrap_or(0);

    current_attempts += 1;
    let locked_until = if current_attempts >= MAX_FAILED_ATTEMPTS {
        Some(iso_future_seconds(LOCKOUT_SECONDS))
    } else {
        None
    };

    conn.execute(
        "INSERT INTO auth_attempts (username, failed_count, locked_until)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(username) DO UPDATE SET
            failed_count = ?2,
            locked_until = ?3;",
        params![username, current_attempts, locked_until],
    )
    .map_err(|e| e.to_string())?;

    Ok(current_attempts)
}

/// Cashier handover: switches cashier while preserving active cash session, counter, and drawer balances!
pub fn switch_cashier(
    conn: &Connection,
    payload: &SwitchCashierPayload,
) -> Result<SessionInfo, String> {
    // 1. Verify previous session
    let prev_session =
        validate_session_and_permission(conn, &payload.active_token, "billing:finalize_sale")
            .map_err(|e| format!("Current session invalid: {}", e))?;

    // 2. Authenticate incoming cashier
    let incoming_username = payload.incoming_username.trim().to_lowercase();
    let incoming_user: Option<(String, String, String, String, String)> = conn
        .query_row(
            "SELECT id, display_name, role, pin_hash, status FROM users WHERE username = ?1;",
            [&incoming_username],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();

    let (incoming_id, incoming_display, incoming_role, pin_hash, status) = match incoming_user {
        Some(row) => row,
        None => {
            record_audit_event(
                conn,
                "HANDOVER_REJECTED_UNKNOWN_USER",
                "AUTH",
                &incoming_username,
                &prev_session.user_id,
            )?;
            return Err("INVALID_CREDENTIALS: Unknown incoming cashier username.".to_string());
        }
    };

    if status != "ACTIVE" {
        return Err("ACCOUNT_DISABLED: Incoming cashier account is disabled.".to_string());
    }

    if !verify_pin(&payload.incoming_pin, &pin_hash) {
        record_audit_event(
            conn,
            "HANDOVER_FAILED_PIN_MISMATCH",
            "USER",
            &incoming_id,
            &prev_session.user_id,
        )?;
        return Err("INVALID_CREDENTIALS: Incorrect PIN for incoming cashier.".to_string());
    }

    // 3. Create session for incoming cashier with exact preserved cash session
    let token = Uuid::now_v7().to_string();
    let now = iso_now();
    let expires_at = iso_future_hours(SESSION_EXPIRY_HOURS);

    conn.execute(
        "INSERT INTO user_sessions (token, user_id, username, display_name, role, branch_id, terminal_id, counter_id, session_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
        params![
            token,
            incoming_id,
            incoming_username,
            incoming_display,
            incoming_role,
            prev_session.branch_id,
            prev_session.terminal_id,
            prev_session.counter_id,
            prev_session.session_id, // PRESERVES physical drawer cash session!
            now,
            expires_at
        ],
    )
    .map_err(|e| format!("Failed to create handover session: {}", e))?;

    // Invalidate previous session
    let _ = conn.execute(
        "DELETE FROM user_sessions WHERE token = ?1;",
        [&payload.active_token],
    );

    // Record auditable handover
    record_audit_event(
        conn,
        "CASHIER_HANDOVER",
        "COUNTER",
        &prev_session.counter_id,
        &format!("FROM:{}->TO:{}", prev_session.user_id, incoming_id),
    )?;

    let permissions = get_permissions_for_role(conn, &incoming_role)?;

    Ok(SessionInfo {
        token,
        user_id: incoming_id,
        username: incoming_username,
        display_name: incoming_display,
        role: incoming_role,
        branch_id: prev_session.branch_id,
        terminal_id: prev_session.terminal_id,
        counter_id: prev_session.counter_id,
        session_id: prev_session.session_id,
        permissions,
        expires_at,
    })
}

/// Logs out active session.
pub fn logout(conn: &Connection, token: &str) -> Result<(), String> {
    let user_id: Option<String> = conn
        .query_row(
            "SELECT user_id FROM user_sessions WHERE token = ?1;",
            [token],
            |r| r.get(0),
        )
        .ok();
    conn.execute("DELETE FROM user_sessions WHERE token = ?1;", [token])
        .map_err(|e| e.to_string())?;

    if let Some(uid) = user_id {
        let _ = record_audit_event(conn, "USER_LOGOUT", "SESSION", token, &uid);
    }
    Ok(())
}

/// Authoritative session and permission validator enforced by Rust.
pub fn validate_session_and_permission(
    conn: &Connection,
    token: &str,
    required_permission: &str,
) -> Result<SessionInfo, String> {
    if token.trim().is_empty() {
        return Err("UNAUTHENTICATED: Session token missing.".to_string());
    }

    let session_row: Option<(String, String, String, String, String, String, String, String, String)> = conn
        .query_row(
            "SELECT user_id, username, display_name, role, branch_id, terminal_id, counter_id, session_id, expires_at
             FROM user_sessions WHERE token = ?1;",
            [token],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        )
        .ok();

    let (
        user_id,
        username,
        display_name,
        role,
        branch_id,
        terminal_id,
        counter_id,
        session_id,
        expires_at,
    ) = match session_row {
        Some(row) => row,
        None => return Err("UNAUTHENTICATED: Active session not found. Please log in.".to_string()),
    };

    // Check expiration
    if let Ok(exp_epoch) = expires_at.parse::<u64>() {
        if current_epoch() > exp_epoch {
            let _ = conn.execute("DELETE FROM user_sessions WHERE token = ?1;", [token]);
            record_audit_event(conn, "SESSION_EXPIRED", "SESSION", token, &user_id)?;
            return Err("UNAUTHENTICATED: Session expired. Please log in again.".to_string());
        }
    }

    // Verify user is still ACTIVE
    let status: String = conn
        .query_row("SELECT status FROM users WHERE id = ?1;", [&user_id], |r| {
            r.get(0)
        })
        .unwrap_or_else(|_| "DISABLED".to_string());

    if status != "ACTIVE" {
        let _ = conn.execute("DELETE FROM user_sessions WHERE token = ?1;", [token]);
        record_audit_event(
            conn,
            "SESSION_TERMINATED_DISABLED_USER",
            "USER",
            &user_id,
            &user_id,
        )?;
        return Err("UNAUTHORIZED: Account has been disabled.".to_string());
    }

    // Check permission
    if !required_permission.is_empty() {
        let has_perm: bool = conn
            .query_row(
                "SELECT 1 FROM user_permissions WHERE role = ?1 AND permission = ?2;",
                params![role, required_permission],
                |_| Ok(true),
            )
            .unwrap_or(false);

        if !has_perm {
            record_audit_event(
                conn,
                "UNAUTHORIZED_ACCESS_BLOCKED",
                "PERMISSION",
                required_permission,
                &user_id,
            )?;
            return Err(format!(
                "FORBIDDEN: User role '{}' lacks required permission '{}'.",
                role, required_permission
            ));
        }
    }

    let permissions = get_permissions_for_role(conn, &role)?;

    Ok(SessionInfo {
        token: token.to_string(),
        user_id,
        username,
        display_name,
        role,
        branch_id,
        terminal_id,
        counter_id,
        session_id,
        permissions,
        expires_at,
    })
}

/// Creates a new cashier or admin account. (Owner only)
pub fn create_user(
    conn: &Connection,
    admin_token: &str,
    payload: &CreateUserPayload,
) -> Result<UserRecord, String> {
    let admin = validate_session_and_permission(conn, admin_token, "admin:manage_users")?;

    let username = payload.username.trim().to_lowercase();
    if username.is_empty() {
        return Err("Username cannot be empty".to_string());
    }
    let display_name = payload.display_name.trim().to_string();
    if display_name.is_empty() {
        return Err("Display name cannot be empty".to_string());
    }

    let role = payload.role.to_uppercase();
    if role != "ADMIN" && role != "CASHIER" {
        return Err("Role must be either 'ADMIN' or 'CASHIER'".to_string());
    }

    // Check unique username
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM users WHERE username = ?1;",
            [&username],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if exists {
        return Err(format!("Username '{}' is already taken.", username));
    }

    let pin_hash = hash_pin(&payload.pin)?;
    let user_id = Uuid::now_v7().to_string();
    let now = iso_now();

    conn.execute(
        "INSERT INTO users (id, username, display_name, role, pin_hash, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'ACTIVE', ?6, ?6);",
        params![user_id, username, display_name, role, pin_hash, now],
    )
    .map_err(|e| format!("Failed to create user: {}", e))?;

    record_audit_event(conn, "USER_CREATED", "USER", &user_id, &admin.user_id)?;

    Ok(UserRecord {
        id: user_id,
        username,
        display_name,
        role,
        status: "ACTIVE".to_string(),
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Updates user status ('ACTIVE' or 'DISABLED'). Protects the last usable owner account!
pub fn update_user_status(
    conn: &Connection,
    admin_token: &str,
    target_user_id: &str,
    new_status: &str,
) -> Result<UserRecord, String> {
    let admin = validate_session_and_permission(conn, admin_token, "admin:manage_users")?;

    let status = new_status.to_uppercase();
    if status != "ACTIVE" && status != "DISABLED" {
        return Err("Status must be 'ACTIVE' or 'DISABLED'".to_string());
    }

    // Protect the last active ADMIN/Owner account
    if status == "DISABLED" {
        let target_role: String = conn
            .query_row(
                "SELECT role FROM users WHERE id = ?1;",
                [target_user_id],
                |r| r.get(0),
            )
            .map_err(|_| "Target user not found".to_string())?;

        if target_role == "ADMIN" {
            let active_admins_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE';",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;

            if active_admins_count <= 1 {
                return Err("CANNOT_DISABLE_LAST_OWNER: Cannot disable the only remaining active Administrator/Owner account.".to_string());
            }
        }
    }

    let now = iso_now();
    conn.execute(
        "UPDATE users SET status = ?1, updated_at = ?2 WHERE id = ?3;",
        params![status, now, target_user_id],
    )
    .map_err(|e| format!("Failed to update user status: {}", e))?;

    // If disabled, revoke any active sessions for that user
    if status == "DISABLED" {
        let _ = conn.execute(
            "DELETE FROM user_sessions WHERE user_id = ?1;",
            [target_user_id],
        );
    }

    record_audit_event(
        conn,
        &format!("USER_STATUS_{}", status),
        "USER",
        target_user_id,
        &admin.user_id,
    )?;

    get_user_by_id(conn, target_user_id)
}

/// Resets user PIN/password. (Owner only)
pub fn reset_user_pin(
    conn: &Connection,
    admin_token: &str,
    target_user_id: &str,
    new_pin: &str,
) -> Result<(), String> {
    let admin = validate_session_and_permission(conn, admin_token, "admin:manage_users")?;

    let pin_hash = hash_pin(new_pin)?;
    let now = iso_now();

    conn.execute(
        "UPDATE users SET pin_hash = ?1, updated_at = ?2 WHERE id = ?3;",
        params![pin_hash, now, target_user_id],
    )
    .map_err(|e| format!("Failed to reset PIN: {}", e))?;

    // Invalidate active sessions to force re-login with the new PIN
    let _ = conn.execute(
        "DELETE FROM user_sessions WHERE user_id = ?1;",
        [target_user_id],
    );

    record_audit_event(
        conn,
        "USER_PIN_RESET",
        "USER",
        target_user_id,
        &admin.user_id,
    )?;
    Ok(())
}

/// Deletes a user account. Protects against deleting the last active ADMIN/Owner account.
pub fn delete_user(
    conn: &Connection,
    admin_token: &str,
    target_user_id: &str,
) -> Result<(), String> {
    let admin = validate_session_and_permission(conn, admin_token, "admin:manage_users")?;

    let (target_role, target_status, target_username): (String, String, String) = conn
        .query_row(
            "SELECT role, status, username FROM users WHERE id = ?1;",
            [target_user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| "Target user not found".to_string())?;

    // Protect the last active ADMIN/Owner account
    if target_role == "ADMIN" && target_status == "ACTIVE" {
        let active_admins_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE';",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        if active_admins_count <= 1 {
            return Err("CANNOT_DELETE_LAST_OWNER: Cannot delete the only remaining active Administrator/Owner account.".to_string());
        }
    }

    // Clean up dependent user sessions and attempts
    let _ = conn.execute("DELETE FROM user_sessions WHERE user_id = ?1;", [target_user_id]);
    let _ = conn.execute("DELETE FROM auth_attempts WHERE username = ?1;", [&target_username]);
    let _ = conn.execute("DELETE FROM user_permissions WHERE user_id = ?1;", [target_user_id]);

    conn.execute("DELETE FROM users WHERE id = ?1;", [target_user_id])
        .map_err(|e| format!("Failed to delete user: {}", e))?;

    record_audit_event(
        conn,
        "USER_DELETED",
        "USER",
        target_user_id,
        &admin.user_id,
    )?;

    Ok(())
}

/// Lists all users (excluding pin_hash!).
pub fn list_users(conn: &Connection, admin_token: &str) -> Result<Vec<UserRecord>, String> {
    let _admin = validate_session_and_permission(conn, admin_token, "admin:manage_users")?;

    let mut stmt = conn
        .prepare("SELECT id, username, display_name, role, status, created_at, updated_at FROM users ORDER BY created_at ASC;")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |r| {
            Ok(UserRecord {
                id: r.get(0)?,
                username: r.get(1)?,
                display_name: r.get(2)?,
                role: r.get(3)?,
                status: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut users = Vec::new();
    for u in rows {
        if let Ok(user) = u {
            users.push(user);
        }
    }
    Ok(users)
}

/// Retrieves recent audit trail logs. (Admin only)
pub fn get_security_logs(
    conn: &Connection,
    admin_token: &str,
) -> Result<Vec<AuditEventRecord>, String> {
    let _admin = validate_session_and_permission(conn, admin_token, "admin:view_audit_logs")?;

    let mut stmt = conn
        .prepare(
            "SELECT id, action, entity_type, entity_id, actor_id, created_at
             FROM audit_events ORDER BY rowid DESC LIMIT 50;",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |r| {
            Ok(AuditEventRecord {
                id: r.get(0)?,
                action: r.get(1)?,
                entity_type: r.get(2)?,
                entity_id: r.get(3)?,
                actor_id: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut logs = Vec::new();
    for l in rows {
        if let Ok(log) = l {
            logs.push(log);
        }
    }
    Ok(logs)
}

fn get_user_by_id(conn: &Connection, user_id: &str) -> Result<UserRecord, String> {
    conn.query_row(
        "SELECT id, username, display_name, role, status, created_at, updated_at FROM users WHERE id = ?1;",
        [user_id],
        |r| {
            Ok(UserRecord {
                id: r.get(0)?,
                username: r.get(1)?,
                display_name: r.get(2)?,
                role: r.get(3)?,
                status: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}
