use malgudi_pos_native::auth::{
    self, CreateUserPayload, LoginPayload, ProvisionOwnerPayload, SwitchCashierPayload,
};
use malgudi_pos_native::db::DatabaseManager;
use rusqlite::Connection;
use std::fs;
use std::path::Path;

fn setup_auth_test_db(path: &Path) -> Connection {
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    DatabaseManager::open_writable(path).expect("Failed to open writable DB")
}

#[test]
fn test_owner_provisioning_and_duplicate_rejection() {
    let db_path = Path::new("target/test_owner_prov.db");
    let conn = setup_auth_test_db(db_path);

    // Initial state: not provisioned
    assert!(!auth::is_provisioned(&conn).unwrap());

    // 1. Provision first owner
    let payload = ProvisionOwnerPayload {
        username: "owner_boss".to_string(),
        display_name: "Thiru Murugan (Owner)".to_string(),
        pin: "889900".to_string(),
        branch_id: Some("IB".to_string()),
        terminal_id: Some("T1".to_string()),
        counter_id: Some("C1".to_string()),
        session_id: Some("sess_01".to_string()),
    };

    let session = auth::provision_first_owner(&conn, &payload).expect("Owner provisioning failed");
    assert_eq!(session.username, "owner_boss");
    assert_eq!(session.role, "ADMIN");
    assert!(auth::is_provisioned(&conn).unwrap());

    // Verify Argon2id hash is stored, NOT plaintext PIN
    let pin_hash: String = conn
        .query_row(
            "SELECT pin_hash FROM users WHERE username = 'owner_boss';",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(pin_hash.starts_with("$argon2id$"));
    assert!(!pin_hash.contains("889900"));

    // 2. Attempt duplicate owner provisioning -> MUST FAIL with explicit error
    let dup_payload = ProvisionOwnerPayload {
        username: "hacker".to_string(),
        display_name: "Attacker".to_string(),
        pin: "123456".to_string(),
        branch_id: None,
        terminal_id: None,
        counter_id: None,
        session_id: None,
    };
    let dup_err = auth::provision_first_owner(&conn, &dup_payload);
    assert!(dup_err.is_err());
    assert!(dup_err.unwrap_err().contains("OWNER_ALREADY_EXISTS"));

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_login_success_and_invalid_pin() {
    let db_path = Path::new("target/test_login_flow.db");
    let conn = setup_auth_test_db(db_path);

    let prov = ProvisionOwnerPayload {
        username: "owner".to_string(),
        display_name: "Owner".to_string(),
        pin: "554433".to_string(),
        branch_id: None,
        terminal_id: None,
        counter_id: None,
        session_id: None,
    };
    let _ = auth::provision_first_owner(&conn, &prov).unwrap();

    // 1. Successful login
    let login_payload = LoginPayload {
        username: "owner".to_string(),
        pin: "554433".to_string(),
        branch_id: Some("IB".to_string()),
        terminal_id: Some("T1".to_string()),
        counter_id: Some("C1".to_string()),
        session_id: Some("sess_login_test".to_string()),
    };
    let login_session = auth::login(&conn, &login_payload).expect("Valid login failed");
    assert_eq!(login_session.username, "owner");
    assert_eq!(login_session.session_id, "sess_login_test");

    // 2. Failed login with wrong PIN
    let bad_pin_payload = LoginPayload {
        username: "owner".to_string(),
        pin: "000000".to_string(),
        branch_id: None,
        terminal_id: None,
        counter_id: None,
        session_id: None,
    };
    let bad_res = auth::login(&conn, &bad_pin_payload);
    assert!(bad_res.is_err());
    assert!(bad_res.unwrap_err().contains("INVALID_CREDENTIALS"));

    // 3. Failed login with non-existent user
    let unknown_user_payload = LoginPayload {
        username: "nonexistent".to_string(),
        pin: "111111".to_string(),
        branch_id: None,
        terminal_id: None,
        counter_id: None,
        session_id: None,
    };
    let unk_res = auth::login(&conn, &unknown_user_payload);
    assert!(unk_res.is_err());
    assert!(unk_res.unwrap_err().contains("INVALID_CREDENTIALS"));

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_lockout_after_five_failed_attempts() {
    let db_path = Path::new("target/test_lockout.db");
    let conn = setup_auth_test_db(db_path);

    let prov = ProvisionOwnerPayload {
        username: "cashier_ram".to_string(),
        display_name: "Ram Kumar".to_string(),
        pin: "123456".to_string(),
        branch_id: None,
        terminal_id: None,
        counter_id: None,
        session_id: None,
    };
    let _ = auth::provision_first_owner(&conn, &prov).unwrap();

    let wrong_payload = LoginPayload {
        username: "cashier_ram".to_string(),
        pin: "wrong_pin".to_string(),
        branch_id: None,
        terminal_id: None,
        counter_id: None,
        session_id: None,
    };

    // First 4 failed attempts produce INVALID_CREDENTIALS
    for _ in 0..4 {
        let res = auth::login(&conn, &wrong_payload);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("INVALID_CREDENTIALS"));
    }

    // 5th failed attempt triggers ACCOUNT_LOCKED
    let fifth_res = auth::login(&conn, &wrong_payload);
    assert!(fifth_res.is_err());
    assert!(fifth_res.unwrap_err().contains("ACCOUNT_LOCKED"));

    // Even with the correct PIN, the account remains locked!
    let correct_payload = LoginPayload {
        username: "cashier_ram".to_string(),
        pin: "123456".to_string(),
        branch_id: None,
        terminal_id: None,
        counter_id: None,
        session_id: None,
    };
    let locked_res = auth::login(&conn, &correct_payload);
    assert!(locked_res.is_err());
    assert!(locked_res.unwrap_err().contains("ACCOUNT_LOCKED"));

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_cashier_handover_preserves_cash_session_and_drawer() {
    let db_path = Path::new("target/test_handover.db");
    let conn = setup_auth_test_db(db_path);

    // 1. Provision Admin
    let admin_session = auth::provision_first_owner(
        &conn,
        &ProvisionOwnerPayload {
            username: "owner".to_string(),
            display_name: "Owner".to_string(),
            pin: "998877".to_string(),
            branch_id: Some("IB".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_shift_morning_01".to_string()),
        },
    )
    .unwrap();

    // 2. Admin creates Cashier 1 (Anand) and Cashier 2 (Kavitha)
    let cashier1 = auth::create_user(
        &conn,
        &admin_session.token,
        &CreateUserPayload {
            username: "anand".to_string(),
            display_name: "Anand M".to_string(),
            role: "CASHIER".to_string(),
            pin: "112233".to_string(),
        },
    )
    .unwrap();

    let cashier2 = auth::create_user(
        &conn,
        &admin_session.token,
        &CreateUserPayload {
            username: "kavitha".to_string(),
            display_name: "Kavitha S".to_string(),
            role: "CASHIER".to_string(),
            pin: "445566".to_string(),
        },
    )
    .unwrap();

    // 3. Cashier 1 logs in at Counter C1, Cash Session sess_shift_morning_01
    let session_anand = auth::login(
        &conn,
        &LoginPayload {
            username: "anand".to_string(),
            pin: "112233".to_string(),
            branch_id: Some("IB".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_shift_morning_01".to_string()),
        },
    )
    .unwrap();
    assert_eq!(session_anand.user_id, cashier1.id);
    assert_eq!(session_anand.session_id, "sess_shift_morning_01");

    // 4. Perform Cashier Handover to Kavitha
    let handover_payload = SwitchCashierPayload {
        active_token: session_anand.token.clone(),
        incoming_username: "kavitha".to_string(),
        incoming_pin: "445566".to_string(),
    };
    let session_kavitha =
        auth::switch_cashier(&conn, &handover_payload).expect("Cashier handover failed");

    // Invariants:
    // a. Incoming cashier is now Kavitha
    assert_eq!(session_kavitha.user_id, cashier2.id);
    assert_eq!(session_kavitha.username, "kavitha");
    // b. Physical Counter and Cash Session are PRESERVED!
    assert_eq!(session_kavitha.counter_id, "C1");
    assert_eq!(session_kavitha.session_id, "sess_shift_morning_01");
    // c. Previous token is invalidated
    let old_token_check = auth::validate_session_and_permission(&conn, &session_anand.token, "");
    assert!(
        old_token_check.is_err(),
        "Previous cashier's session must be invalidated"
    );

    // d. Check audit trail recorded handover
    let handover_audit_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM audit_events WHERE action = 'CASHIER_HANDOVER';",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(handover_audit_count, 1);

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_rbac_permissions_cashier_denied_admin_operations() {
    let db_path = Path::new("target/test_rbac.db");
    let conn = setup_auth_test_db(db_path);

    let admin_session = auth::provision_first_owner(
        &conn,
        &ProvisionOwnerPayload {
            username: "admin_user".to_string(),
            display_name: "Admin User".to_string(),
            pin: "654321".to_string(),
            branch_id: None,
            terminal_id: None,
            counter_id: None,
            session_id: None,
        },
    )
    .unwrap();

    let _ = auth::create_user(
        &conn,
        &admin_session.token,
        &CreateUserPayload {
            username: "cashier_staff".to_string(),
            display_name: "Staff".to_string(),
            role: "CASHIER".to_string(),
            pin: "778899".to_string(),
        },
    )
    .unwrap();

    let cashier_session = auth::login(
        &conn,
        &LoginPayload {
            username: "cashier_staff".to_string(),
            pin: "778899".to_string(),
            branch_id: None,
            terminal_id: None,
            counter_id: None,
            session_id: None,
        },
    )
    .unwrap();

    // 1. Cashier is permitted to perform billing
    let billing_check = auth::validate_session_and_permission(
        &conn,
        &cashier_session.token,
        "billing:finalize_sale",
    );
    assert!(
        billing_check.is_ok(),
        "Cashier must have billing:finalize_sale permission"
    );

    // 2. Cashier is DENIED admin operations
    let user_mgmt_check =
        auth::validate_session_and_permission(&conn, &cashier_session.token, "admin:manage_users");
    assert!(
        user_mgmt_check.is_err(),
        "Cashier must be blocked from admin:manage_users"
    );
    assert!(user_mgmt_check.unwrap_err().contains("FORBIDDEN"));

    let backup_check =
        auth::validate_session_and_permission(&conn, &cashier_session.token, "admin:create_backup");
    assert!(
        backup_check.is_err(),
        "Cashier must be blocked from admin:create_backup"
    );
    assert!(backup_check.unwrap_err().contains("FORBIDDEN"));

    // 3. Cashier attempting to create user directly via Rust function is rejected
    let attempt_create = auth::create_user(
        &conn,
        &cashier_session.token,
        &CreateUserPayload {
            username: "rogue".to_string(),
            display_name: "Rogue".to_string(),
            role: "ADMIN".to_string(),
            pin: "123456".to_string(),
        },
    );
    assert!(attempt_create.is_err());
    assert!(attempt_create.unwrap_err().contains("FORBIDDEN"));

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_last_owner_protection() {
    let db_path = Path::new("target/test_last_owner.db");
    let conn = setup_auth_test_db(db_path);

    let admin_session = auth::provision_first_owner(
        &conn,
        &ProvisionOwnerPayload {
            username: "sole_owner".to_string(),
            display_name: "Sole Owner".to_string(),
            pin: "123456".to_string(),
            branch_id: None,
            terminal_id: None,
            counter_id: None,
            session_id: None,
        },
    )
    .unwrap();

    // Attempting to disable the only administrator must be strictly blocked
    let disable_err = auth::update_user_status(
        &conn,
        &admin_session.token,
        &admin_session.user_id,
        "DISABLED",
    );
    assert!(disable_err.is_err());
    assert!(disable_err
        .unwrap_err()
        .contains("CANNOT_DISABLE_LAST_OWNER"));

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_pin_reset_invalidates_active_sessions() {
    let db_path = Path::new("target/test_pin_reset.db");
    let conn = setup_auth_test_db(db_path);

    let admin_session = auth::provision_first_owner(
        &conn,
        &ProvisionOwnerPayload {
            username: "admin".to_string(),
            display_name: "Admin".to_string(),
            pin: "111111".to_string(),
            branch_id: None,
            terminal_id: None,
            counter_id: None,
            session_id: None,
        },
    )
    .unwrap();

    let cashier = auth::create_user(
        &conn,
        &admin_session.token,
        &CreateUserPayload {
            username: "suresh".to_string(),
            display_name: "Suresh".to_string(),
            role: "CASHIER".to_string(),
            pin: "222222".to_string(),
        },
    )
    .unwrap();

    // Cashier logs in
    let cashier_session = auth::login(
        &conn,
        &LoginPayload {
            username: "suresh".to_string(),
            pin: "222222".to_string(),
            branch_id: None,
            terminal_id: None,
            counter_id: None,
            session_id: None,
        },
    )
    .unwrap();

    // Admin resets cashier PIN to 333333
    auth::reset_user_pin(&conn, &admin_session.token, &cashier.id, "333333").unwrap();

    // Old session token is now invalid!
    let session_check = auth::validate_session_and_permission(&conn, &cashier_session.token, "");
    assert!(
        session_check.is_err(),
        "Session must be terminated upon PIN reset"
    );

    // Old PIN fails
    let old_pin_login = auth::login(
        &conn,
        &LoginPayload {
            username: "suresh".to_string(),
            pin: "222222".to_string(),
            branch_id: None,
            terminal_id: None,
            counter_id: None,
            session_id: None,
        },
    );
    assert!(old_pin_login.is_err());

    // New PIN succeeds
    let new_pin_login = auth::login(
        &conn,
        &LoginPayload {
            username: "suresh".to_string(),
            pin: "333333".to_string(),
            branch_id: None,
            terminal_id: None,
            counter_id: None,
            session_id: None,
        },
    );
    assert!(new_pin_login.is_ok());

    let _ = fs::remove_file(db_path);
}

#[test]
fn test_offline_authentication_works_without_network() {
    let db_path = Path::new("target/test_offline_auth.db");
    let conn = setup_auth_test_db(db_path);

    // Provision local user while offline
    let admin_session = auth::provision_first_owner(
        &conn,
        &ProvisionOwnerPayload {
            username: "offline_owner".to_string(),
            display_name: "Offline Owner".to_string(),
            pin: "777777".to_string(),
            branch_id: Some("IB".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_offline_01".to_string()),
        },
    )
    .unwrap();

    // Create cashier offline
    let _ = auth::create_user(
        &conn,
        &admin_session.token,
        &CreateUserPayload {
            username: "offline_cashier".to_string(),
            display_name: "Offline Cashier".to_string(),
            role: "CASHIER".to_string(),
            pin: "888888".to_string(),
        },
    )
    .unwrap();

    // Reopen DB to simulate full app restart in an air-gapped environment
    drop(conn);
    let offline_conn = DatabaseManager::open_writable(db_path).unwrap();

    // Login succeeds locally without any network access
    let login = auth::login(
        &offline_conn,
        &LoginPayload {
            username: "offline_cashier".to_string(),
            pin: "888888".to_string(),
            branch_id: Some("IB".to_string()),
            terminal_id: Some("T1".to_string()),
            counter_id: Some("C1".to_string()),
            session_id: Some("sess_offline_01".to_string()),
        },
    )
    .expect("Offline local authentication must succeed");

    assert_eq!(login.username, "offline_cashier");
    assert_eq!(login.role, "CASHIER");

    let _ = fs::remove_file(db_path);
}
