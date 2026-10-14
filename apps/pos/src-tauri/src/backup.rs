use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryReport {
    pub total_sales_count: i64,
    pub total_outbox_count: i64,
    pub total_cash_movements: i64,
    pub total_stock_movements: i64,
    pub duplicate_invoices: Vec<String>,
    pub foreign_key_violations: Vec<String>,
    pub rejected_or_quarantined_records: Vec<String>,
    pub is_safe_to_restore: bool,
}

fn backup_error(msg: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::Other,
        msg.into(),
    )))
}

pub struct BackupManager;

impl BackupManager {
    /// Performs an atomic, consistent hot-snapshot using SQLite VACUUM INTO.
    /// Invariants:
    /// 1. Destination check: Refuses to silently overwrite an existing valid backup file.
    /// 2. Staged atomic write: Writes to .tmp.db staging file first.
    /// 3. Integrity verification: Executes PRAGMA integrity_check on the snapshot before finalization.
    /// 4. Flush guarantees: Explicit file.sync_all() ensures physical media persistence before rename.
    /// 5. Fault cleanup: On any error (disk full, USB removal, flush error), staging file is purged,
    ///    strictly preserving the last known-good backup.
    pub fn create_consistent_backup<P: AsRef<Path>>(
        conn: &Connection,
        dest_dir: P,
        filename_stem: &str,
    ) -> Result<PathBuf> {
        let dest_dir = dest_dir.as_ref();
        if !dest_dir.exists() {
            fs::create_dir_all(dest_dir)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }

        let temp_filename = format!("{}.tmp.db", filename_stem);
        let final_filename = format!("{}.db", filename_stem);
        let temp_path = dest_dir.join(&temp_filename);
        let final_path = dest_dir.join(&final_filename);

        // Invariant: Never overwrite an existing completed snapshot silently
        if final_path.exists() {
            return Err(backup_error(
                format!("BACKUP_DESTINATION_EXISTS: '{}' already exists. Overwrite rejected to preserve known-good backup.", final_path.display())
            ));
        }

        if temp_path.exists() {
            let _ = fs::remove_file(&temp_path);
        }

        // SQLite 3.27+ parameterized VACUUM INTO creates a zero-lock, transactionally consistent snapshot
        let temp_path_str = temp_path
            .to_str()
            .ok_or_else(|| rusqlite::Error::InvalidPath(temp_path.clone()))?;

        // Helper closure to ensure temp_path is cleaned up on any failure
        let execute_snapshot = || -> Result<()> {
            conn.execute("VACUUM INTO ?1;", [&temp_path_str])?;

            // Durability flush to media (protects against USB removal / power loss mid-write)
            {
                let file = fs::OpenOptions::new()
                    .write(true)
                    .open(&temp_path)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                file.sync_all()
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            }

            // Integrity verification on the generated snapshot
            let snapshot_conn = Connection::open_with_flags(
                &temp_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let mut stmt = snapshot_conn.prepare("PRAGMA integrity_check;")?;
            let mut rows = stmt.query([])?;
            let is_ok = if let Some(row) = rows.next()? {
                let res: String = row.get(0)?;
                res == "ok"
            } else {
                false
            };

            if !is_ok {
                return Err(backup_error(
                    "SNAPSHOT_CORRUPTION_DETECTED: PRAGMA integrity_check failed on created snapshot",
                ));
            }

            Ok(())
        };

        if let Err(e) = execute_snapshot() {
            // Cleanup incomplete staging file on any failure (disk full, USB removal, etc.)
            let _ = fs::remove_file(&temp_path);
            return Err(e);
        }

        // Compute SHA-256 checksum and write companion .sha256 file
        let checksum = {
            let mut file = File::open(&temp_path)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 8192];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            format!("{:x}", hasher.finalize())
        };

        let checksum_path = dest_dir.join(format!("{}.sha256", filename_stem));
        let write_checksum = || -> Result<()> {
            let mut checksum_file = File::create(&checksum_path)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            checksum_file
                .write_all(checksum.as_bytes())
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            checksum_file
                .sync_all()
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            Ok(())
        };

        if let Err(e) = write_checksum() {
            let _ = fs::remove_file(&temp_path);
            let _ = fs::remove_file(&checksum_path);
            return Err(e);
        }

        // Atomic rename: replace staging with final .db
        if let Err(e) = fs::rename(&temp_path, &final_path) {
            let _ = fs::remove_file(&temp_path);
            let _ = fs::remove_file(&checksum_path);
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(e)));
        }

        Ok(final_path)
    }

    /// Verifies structural integrity, foreign keys, and multi-aggregate business invariants of a restored staged database.
    /// Invariant: Never certifies a restored database on checksum or PRAGMA integrity_check alone.
    /// Generates a granular RecoveryReport detailing all safe or quarantined records.
    pub fn validate_and_reconcile_staged_restore<P: AsRef<Path>>(
        staged_path: P,
    ) -> Result<RecoveryReport> {
        let conn =
            Connection::open_with_flags(staged_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;

        let mut foreign_key_violations = Vec::new();
        let mut duplicate_invoices = Vec::new();
        let mut rejected_or_quarantined_records = Vec::new();

        // 1. Structural integrity check
        let mut stmt = conn.prepare("PRAGMA integrity_check;")?;
        let mut rows = stmt.query([])?;
        let ok_str: String = rows
            .next()?
            .map(|r| r.get(0))
            .unwrap_or(Ok("failed".into()))?;
        if ok_str != "ok" {
            rejected_or_quarantined_records.push(format!(
                "Structural corruption: PRAGMA integrity_check returned '{}'",
                ok_str
            ));
        }

        // 2. Foreign Key constraints check
        let mut fk_stmt = conn.prepare("PRAGMA foreign_key_check;")?;
        let mut fk_rows = fk_stmt.query([])?;
        while let Some(row) = fk_rows.next()? {
            let table: String = row.get(0)?;
            let rowid: i64 = row.get(1)?;
            let parent_table: String = row.get(2)?;
            let msg = format!(
                "FK violation in '{}' (rowid: {}) referencing parent '{}'",
                table, rowid, parent_table
            );
            foreign_key_violations.push(msg.clone());
            rejected_or_quarantined_records.push(msg);
        }

        // 3. Invoice uniqueness verification
        let mut inv_stmt = conn.prepare(
            "SELECT invoice_number, COUNT(*) FROM sales GROUP BY invoice_number HAVING COUNT(*) > 1;"
        )?;
        let mut inv_rows = inv_stmt.query([])?;
        while let Some(row) = inv_rows.next()? {
            let inv_num: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            let msg = format!(
                "Duplicate invoice collision: '{}' appears {} times",
                inv_num, count
            );
            duplicate_invoices.push(inv_num);
            rejected_or_quarantined_records.push(msg);
        }

        // 4. Counts and completeness
        let total_sales_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM sales;", [], |r| r.get(0))?;
        let total_outbox_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM sync_outbox;", [], |r| r.get(0))?;
        let total_cash_movements: i64 =
            conn.query_row("SELECT COUNT(*) FROM cash_movements;", [], |r| r.get(0))?;
        let total_stock_movements: i64 =
            conn.query_row("SELECT COUNT(*) FROM stock_movements;", [], |r| r.get(0))?;

        // 5. Sync outbox consistency: Every sale must have an outbox event
        if total_outbox_count < total_sales_count {
            let msg = format!(
                "Outbox inconsistency: Outbox events ({}) fewer than finalized sales ({})",
                total_outbox_count, total_sales_count
            );
            rejected_or_quarantined_records.push(msg);
        }

        // 6. Aggregate completeness: physical line items must have corresponding stock movements
        let orphan_physical_items: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sale_items si
             WHERE si.stock_deduction_delta < 0
               AND NOT EXISTS (
                   SELECT 1 FROM stock_movements sm 
                   WHERE sm.reference_id = si.sale_id AND sm.product_id = si.product_id
               );",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if orphan_physical_items > 0 {
            let msg = format!(
                "Sale-aggregate incomplete: Found {} physical sale items without corresponding stock deduction movement",
                orphan_physical_items
            );
            rejected_or_quarantined_records.push(msg);
        }

        let is_safe_to_restore = rejected_or_quarantined_records.is_empty();

        Ok(RecoveryReport {
            total_sales_count,
            total_outbox_count,
            total_cash_movements,
            total_stock_movements,
            duplicate_invoices,
            foreign_key_violations,
            rejected_or_quarantined_records,
            is_safe_to_restore,
        })
    }

    /// Restores a validated backup into target path with pre-restore preservation.
    /// Invariants:
    /// 1. Pre-validation: Validates backup integrity and business invariants before touching target.
    /// 2. Protection: Refuses to overwrite existing DB unless allow_destructive is explicitly true.
    /// 3. Preservation: Creates a timestamped `.pre_restore_<timestamp>.bak` copy of existing DB before restore.
    /// 4. Staged write: Writes to temporary file, flushes with sync_all(), then atomically replaces target.
    pub fn restore_database<P: AsRef<Path>, Q: AsRef<Path>>(
        backup_file: P,
        target_path: Q,
        allow_destructive: bool,
    ) -> Result<RecoveryReport> {
        let backup_file = backup_file.as_ref();
        let target_path = target_path.as_ref();

        // 1. Validate the backup file first
        let report = Self::validate_and_reconcile_staged_restore(backup_file)?;
        if !report.is_safe_to_restore {
            return Err(backup_error(
                format!("RESTORE_REJECTED_UNSAFE: Backup contains {} quarantined violations. Refusing restore.",
                    report.rejected_or_quarantined_records.len()
                )
            ));
        }

        // 2. Protect existing target DB
        if target_path.exists() {
            if !allow_destructive {
                return Err(backup_error(
                    "TARGET_EXISTS_PROTECTION: Target database already exists. Explicit supervisor approval (allow_destructive=true) required."
                ));
            }
            // Preserve recoverable copy of the existing known-good database
            let now_millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let backup_copy = target_path.with_extension(format!("pre_restore_{}.bak", now_millis));
            fs::copy(target_path, &backup_copy)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }

        // 3. Staged atomic copy: copy to .tmp.restore first, flush, then rename
        let staging_path = target_path.with_extension("tmp.restore");
        if staging_path.exists() {
            let _ = fs::remove_file(&staging_path);
        }

        fs::copy(backup_file, &staging_path)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

        // Media flush
        {
            let file = fs::OpenOptions::new()
                .write(true)
                .open(&staging_path)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            file.sync_all()
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }

        // On Windows, remove existing target_path before rename if it exists
        if target_path.exists() {
            fs::remove_file(target_path)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }

        // Move to target
        fs::rename(&staging_path, target_path)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

        Ok(report)
    }

    /// Executes an automated consistent hot backup and enforces retention policy (pruning oldest).
    /// Logs audit events for both success and failure reporting.
    pub fn run_scheduled_backup_with_retention<P: AsRef<Path>>(
        conn: &Connection,
        backup_dir: P,
        max_retention_copies: usize,
    ) -> Result<ScheduledBackupResult, String> {
        let backup_dir = backup_dir.as_ref();
        if !backup_dir.exists() {
            fs::create_dir_all(backup_dir)
                .map_err(|e| format!("Failed to create backup dir: {}", e))?;
        }

        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let stem = format!("malgudi_auto_backup_{}", now_secs);

        let backup_path = match Self::create_consistent_backup(conn, backup_dir, &stem) {
            Ok(p) => p,
            Err(e) => {
                let _ = crate::auth::record_audit_event(
                    conn,
                    "SCHEDULED_BACKUP_FAILED",
                    "SYSTEM",
                    &format!("Error: {}", e),
                    "SYSTEM",
                );
                return Err(format!("Scheduled backup creation failed: {}", e));
            }
        };

        let bytes_written = fs::metadata(&backup_path).map(|m| m.len()).unwrap_or(0);

        // Retention policy: scan backup_dir for "malgudi_auto_backup_*.db" and prune excess
        let mut auto_backups: Vec<PathBuf> = Vec::new();
        if let Ok(entries) = fs::read_dir(backup_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                    if file_name.starts_with("malgudi_auto_backup_")
                        && file_name.ends_with(".db")
                        && !file_name.ends_with(".tmp.db")
                    {
                        auto_backups.push(path);
                    }
                }
            }
        }

        // Sort descending by filename (which includes timestamp)
        auto_backups.sort_by(|a, b| b.cmp(a));

        let mut pruned_count = 0;
        if auto_backups.len() > max_retention_copies {
            for excess in &auto_backups[max_retention_copies..] {
                if fs::remove_file(excess).is_ok() {
                    pruned_count += 1;
                }
            }
        }

        let total_retained = auto_backups.len().saturating_sub(pruned_count);

        let _ = crate::auth::record_audit_event(
            conn,
            "SCHEDULED_BACKUP_SUCCESS",
            "BACKUP",
            &backup_path.to_string_lossy(),
            "SYSTEM",
        );

        Ok(ScheduledBackupResult {
            backup_path: backup_path.to_string_lossy().to_string(),
            bytes_written,
            total_retained,
            pruned_count,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledBackupResult {
    pub backup_path: String,
    pub bytes_written: u64,
    pub total_retained: usize,
    pub pruned_count: usize,
}
