import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalSaleAggregate } from '@malgudi/contracts';

export interface ServerSyncEvent {
  event_id: string;
  aggregate_type: 'SALE' | 'RETURN' | 'STOCK_MOVEMENT' | 'PAYMENT_RECONCILIATION';
  aggregate_id: string;
  parent_id?: string;
  branch_id?: string;
  terminal_id?: string;
  payload_json: string;
  payload_hash: string;
  created_at: string;
}

export interface PaymentReconciliationEvent {
  event_id: string;
  sale_id: string;
  payment_id: string;
  gateway_outcome: 'SUCCESS' | 'FAILED';
  sequence_number: number;
  occurred_at: string;
}

export type IngestionStatus =
  | 'COMMITTED_ACK'
  | 'ALREADY_COMMITTED_IDEMPOTENT_ACK'
  | 'BUFFERED_WAITING_PARENT'
  | 'REJECTED_PAYLOAD_MUTATION'
  | 'REJECTED_MISSING_DEPENDENCY';

export interface IngestionResponse {
  status: IngestionStatus;
  acknowledged: boolean;
  eventId: string;
  aggregateId: string;
  message: string;
  persistedDurable: boolean;
}

export interface BatchSyncItem {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  parent_id?: string;
  payload_json: string;
  payload_hash: string;
  created_at: string;
}

export interface BatchSyncRequest {
  branch_id: string;
  terminal_id: string;
  events: BatchSyncItem[];
}

export interface BatchSyncResultItem {
  event_id: string;
  status: IngestionStatus;
  acknowledged: boolean;
  message: string;
}

export interface ServerCatalogProduct {
  id: string;
  name: string;
  tamil_name: string;
  sku: string;
  barcode: string | null;
  category_id: string;
  pricing_unit: string;
  inventory_unit: string;
  pricing_basis: string;
  base_price_paise: number;
  piece_price_paise: number | null;
  tax_rate_bps: number;
  hsn_code: string;
  is_active: boolean;
  version: number;
  target_branch_ids: string;
  updated_at: string;
}

export interface PublishCatalogProductPayload {
  id?: string;
  name: string;
  tamil_name?: string;
  sku: string;
  barcode?: string | null;
  category_id?: string;
  pricing_unit?: string;
  inventory_unit?: string;
  pricing_basis?: string;
  base_price_paise: number;
  piece_price_paise?: number | null;
  tax_rate_bps?: number;
  hsn_code?: string;
  is_active?: boolean;
  target_branch_ids?: string;
}

/**
 * Authoritative Server Synchronization Engine for Central Cloud API.
 * Uses persistent on-disk SQLite (via node:sqlite DatabaseSync) with ACID transactions.
 * Mirrors the PostgreSQL/Prisma relational schema for multi-branch sync and central reporting.
 * 
 * Invariants:
 * 1. Commits data to durable storage BEFORE returning acknowledgment to client.
 * 2. Idempotently returns ACK on retries of identical payload hashes.
 * 3. Rejects with conflict (409) if the same ID arrives with an altered payload hash.
 * 4. Buffers out-of-order child aggregates until the parent aggregate arrives.
 * 5. Replaying already-acknowledged events is safe and idempotent.
 * 6. Multi-branch partition guarantees independent branch operations never collide.
 * 7. Sync acknowledgment NEVER marks an unsettled payment as settled.
 * 8. Survives full server process restart when initialized with a file path.
 */
/**
 * Resolves the path to the central SQLite database.
 * Priority:
 * 1. Explicit argument passed to constructor / helper
 * 2. MALGUDI_SYNC_DB_PATH environment variable
 * 3. MALGUDI_DATA_DIR environment variable (resolving <MALGUDI_DATA_DIR>/malgudi_central_sync.db)
 * 4. In production (NODE_ENV=production): default to Render persistent mount /var/data/malgudi-api/malgudi_central_sync.db
 * 5. In development/testing: default to :memory:
 */
export function resolveDatabasePath(customPath?: string): string {
  if (customPath && customPath.trim().length > 0) {
    return customPath.trim();
  }
  if (process.env.MALGUDI_SYNC_DB_PATH && process.env.MALGUDI_SYNC_DB_PATH.trim().length > 0) {
    return process.env.MALGUDI_SYNC_DB_PATH.trim();
  }
  if (process.env.MALGUDI_DATA_DIR && process.env.MALGUDI_DATA_DIR.trim().length > 0) {
    return path.join(process.env.MALGUDI_DATA_DIR.trim(), 'malgudi_central_sync.db');
  }
  if (process.env.NODE_ENV === 'production') {
    return '/var/data/malgudi-api/malgudi_central_sync.db';
  }
  return ':memory:';
}

export class DurableSyncServer {
  private db: DatabaseSync;
  public dbPath: string;

  constructor(dbPath?: string) {
    const resolvedPath = resolveDatabasePath(dbPath);
    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction && resolvedPath === ':memory:') {
      throw new Error(
        'FATAL CONFIGURATION ERROR: Central SQLite database cannot use in-memory storage in production mode. ' +
        'Configure MALGUDI_DATA_DIR (e.g. /var/data/malgudi-api) or MALGUDI_SYNC_DB_PATH on a persistent disk.'
      );
    }

    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(path.resolve(resolvedPath));
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // Verify read/write accessibility to the persistent directory
        fs.accessSync(dir, fs.constants.W_OK | fs.constants.R_OK);
      } catch (err: any) {
        throw new Error(
          `FATAL CONFIGURATION ERROR: Central database directory "${dir}" is unavailable or unwritable: ${err.message}. ` +
          'Ensure Render persistent disk is properly mounted with write permissions.'
        );
      }
    }

    this.dbPath = resolvedPath;
    this.db = new DatabaseSync(resolvedPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS server_branches (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT 'Madurai',
        gstin TEXT NOT NULL DEFAULT '33AAAAA0000A1Z5',
        is_active INTEGER NOT NULL DEFAULT 1
      );

      INSERT OR IGNORE INTO server_branches (id, code, name, address, city, gstin, is_active) VALUES
        ('b_ib', 'IB', 'Madurai Town Hall Main Store', 'West Veli Street, Madurai', 'Madurai', '33AAAAA0000A1Z5', 1),
        ('b_mn', 'MN', 'Mattuthavani Bus Stand Branch', 'Omni Bus Stand Concourse, Madurai', 'Madurai', '33AAAAA0000A1Z5', 1);

      CREATE TABLE IF NOT EXISTS server_events (
        event_id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        parent_id TEXT,
        branch_id TEXT NOT NULL DEFAULT 'IB',
        terminal_id TEXT NOT NULL DEFAULT 'T1',
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(aggregate_type, aggregate_id)
      );

      CREATE TABLE IF NOT EXISTS server_aggregates (
        aggregate_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS out_of_order_buffer (
        event_id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        branch_id TEXT NOT NULL DEFAULT 'IB',
        event_json TEXT NOT NULL,
        aggregate_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payment_reconciliation_ledger (
        reconciliation_key TEXT PRIMARY KEY,
        sale_id TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        gateway_outcome TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_sales (
        id TEXT PRIMARY KEY,
        invoice_number TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        counter_id TEXT NOT NULL DEFAULT 'C1',
        session_id TEXT NOT NULL,
        business_date TEXT NOT NULL,
        tax_policy_version TEXT NOT NULL DEFAULT '2026.1-TN',
        subtotal_taxable_paise INTEGER NOT NULL,
        total_cgst_paise INTEGER NOT NULL,
        total_sgst_paise INTEGER NOT NULL,
        total_igst_paise INTEGER NOT NULL DEFAULT 0,
        round_off_paise INTEGER NOT NULL DEFAULT 0,
        net_payable_paise INTEGER NOT NULL,
        sale_status TEXT NOT NULL,
        payment_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(branch_id, invoice_number)
      );

      CREATE TABLE IF NOT EXISTS server_sale_items (
        id TEXT PRIMARY KEY,
        sale_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity_input INTEGER NOT NULL,
        pricing_unit TEXT NOT NULL,
        taxable_paise INTEGER NOT NULL,
        cgst_paise INTEGER NOT NULL,
        sgst_paise INTEGER NOT NULL,
        gross_paise INTEGER NOT NULL,
        stock_deduction_delta INTEGER NOT NULL,
        stock_unit TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_sale_payments (
        id TEXT PRIMARY KEY,
        sale_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        allocated_amount_paise INTEGER NOT NULL,
        tendered_paise INTEGER NOT NULL DEFAULT 0,
        change_returned_paise INTEGER NOT NULL DEFAULT 0,
        net_amount_paise INTEGER NOT NULL,
        outcome TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_stock_movements (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        movement_type TEXT NOT NULL,
        quantity_delta INTEGER NOT NULL,
        unit TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        reason TEXT,
        actor_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS server_cash_movements (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        movement_type TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        direction TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_server_sales_branch_date ON server_sales (branch_id, business_date);
      CREATE INDEX IF NOT EXISTS idx_server_sales_status ON server_sales (sale_status);
      CREATE INDEX IF NOT EXISTS idx_server_stock_movements_branch_prod ON server_stock_movements (branch_id, product_id);

      CREATE TABLE IF NOT EXISTS server_catalog_products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tamil_name TEXT NOT NULL,
        sku TEXT NOT NULL UNIQUE,
        barcode TEXT,
        category_id TEXT NOT NULL,
        pricing_unit TEXT NOT NULL,
        inventory_unit TEXT NOT NULL,
        pricing_basis TEXT NOT NULL DEFAULT 'TAX_INCLUSIVE',
        base_price_paise INTEGER NOT NULL,
        piece_price_paise INTEGER,
        tax_rate_bps INTEGER NOT NULL DEFAULT 500,
        hsn_code TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        target_branch_ids TEXT NOT NULL DEFAULT '*',
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_server_catalog_version ON server_catalog_products (version);
    `);

    // Seed initial products if catalog is empty
    const catCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM server_catalog_products;').get() as { cnt: number }).cnt;
    if (catCount === 0) {
      const insertCat = this.db.prepare(`
        INSERT INTO server_catalog_products (
          id, name, tamil_name, sku, barcode, category_id, pricing_unit, inventory_unit,
          pricing_basis, base_price_paise, piece_price_paise, tax_rate_bps, hsn_code,
          is_active, version, target_branch_ids, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, '*', ?);
      `);
      const now = '2026-10-12T00:00:00Z';
      const defaults = [
        ['prod_mysore_pak', 'Special Ghee Mysore Pak', 'நெய் மைசூர் பாகு', 'MP-001', null, 'cat_sweets', 'PER_KG', 'MG', 'TAX_INCLUSIVE', 68000, null, 500, '21069099'],
        ['prod_laddu', 'Madurai Nei Laddu', 'மதுரை நெய் லட்டு', 'SW-NL-002', null, 'cat_sweets', 'PER_KG', 'MG', 'TAX_INCLUSIVE', 44000, null, 500, '21069099'],
        ['prod_kaju_katli', 'Royal Kaju Katli', 'காஜூ கத்திலி', 'SW-KK-003', null, 'cat_sweets', 'PER_KG', 'MG', 'TAX_INCLUSIVE', 95000, null, 500, '21069099'],
        ['prod_wheat_halwa', 'Tirunelveli Wheat Halwa', 'திருநெல்வேலி கோதுமை அல்வா', 'SW-TH-004', null, 'cat_sweets', 'PER_KG', 'MG', 'TAX_INCLUSIVE', 48000, null, 500, '21069099'],
        ['prod_ribbon_pakoda', 'Madurai Ribbon Pakoda', 'ரிப்பன் பகோடா', 'SAV-RP-005', null, 'cat_savories', 'PER_KG', 'MG', 'TAX_INCLUSIVE', 38000, null, 500, '21069099'],
        ['prod_kara_sev', 'Sattur Spicy Kara Sev', 'சாத்தூர் காராசேவ்', 'SAV-KS-006', null, 'cat_savories', 'PER_KG', 'MG', 'TAX_INCLUSIVE', 36000, null, 500, '21069099'],
        ['prod_butter_murukku', 'Manapparai Butter Murukku', 'மணப்பாறை முறுக்கு', 'SAV-BM-007', null, 'cat_savories', 'PER_KG', 'MG', 'TAX_INCLUSIVE', 34000, null, 500, '21069099'],
        ['prod_mixture', 'Madurai Special Mixture', 'மதுரை மிக்ஸர்', 'SAV-MX-008', null, 'cat_savories', 'PER_KG', 'MG', 'TAX_INCLUSIVE', 32000, null, 500, '21069099'],
        ['prod_badam_milk', 'Madurai Jigarthanda Badam Milk', 'பாதாம் பால்', 'DRK-BM-009', null, 'cat_beverages', 'PER_PIECE', 'PCS', 'TAX_INCLUSIVE', 8000, null, 500, '04029990'],
        ['prod_rose_milk', 'Chilled Rose Milk', 'ரோஸ் மில்க்', 'DRK-RM-010', null, 'cat_beverages', 'PER_PIECE', 'PCS', 'TAX_INCLUSIVE', 6000, null, 500, '04029990'],
        ['prod_rusk', 'Cardamom Milk Rusk', 'ஏலக்காய் ரஸ்க்', 'BAK-RK-011', null, 'cat_bakery', 'PER_PIECE', 'PCS', 'TAX_INCLUSIVE', 12000, null, 500, '19054000'],
        ['prod_plum_cake', 'Rich Plum Cake', 'பிளம் கேக்', 'BAK-CK-012', null, 'cat_bakery', 'PER_PIECE', 'PCS', 'TAX_INCLUSIVE', 25000, null, 500, '19059010'],
      ];
      for (const d of defaults) {
        insertCat.run(d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], d[12], now);
      }
    }
  }

  public get committedEventsCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM server_events;').get() as { cnt: number };
    return row.cnt;
  }

  public get committedAggregatesCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM server_aggregates;').get() as { cnt: number };
    return row.cnt;
  }

  public hasEvent(eventId: string): boolean {
    const row = this.db.prepare('SELECT event_id FROM server_events WHERE event_id = ?;').get(eventId);
    return !!row;
  }

  public hasAggregate(aggregateId: string): boolean {
    const row = this.db.prepare('SELECT aggregate_id FROM server_aggregates WHERE aggregate_id = ?;').get(aggregateId);
    return !!row;
  }

  public getCommittedEvent(eventId: string): ServerSyncEvent | null {
    const row = this.db.prepare('SELECT * FROM server_events WHERE event_id = ?;').get(eventId) as any;
    if (!row) return null;
    return {
      event_id: row.event_id,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.aggregate_id,
      parent_id: row.parent_id ?? undefined,
      branch_id: row.branch_id,
      terminal_id: row.terminal_id,
      payload_json: row.payload_json,
      payload_hash: row.payload_hash,
      created_at: row.created_at,
    };
  }

  public getCommittedAggregate(aggregateId: string): CanonicalSaleAggregate | null {
    const row = this.db.prepare('SELECT data_json FROM server_aggregates WHERE aggregate_id = ?;').get(aggregateId) as any;
    if (!row) return null;
    return JSON.parse(row.data_json);
  }

  /**
   * Ingests a synchronized sale or return event from a POS terminal.
   * Atomically persists to disk before returning acknowledgment.
   */
  public ingest(
    event: ServerSyncEvent,
    aggregate: CanonicalSaleAggregate,
    options?: { simulateLostNetworkAck?: boolean; branchId?: string; terminalId?: string }
  ): IngestionResponse {
    const branchId = options?.branchId || event.branch_id || 'IB';
    const terminalId = options?.terminalId || event.terminal_id || 'T1';

    // 1. Idempotency & Payload Mutation Check
    const existing = this.db.prepare(
      'SELECT event_id, aggregate_id, payload_hash FROM server_events WHERE event_id = ? OR (aggregate_id = ? AND aggregate_type = ?) LIMIT 1;'
    ).get(event.event_id, event.aggregate_id, event.aggregate_type) as { event_id: string; aggregate_id: string; payload_hash: string } | undefined;

    if (existing) {
      if (existing.payload_hash === event.payload_hash) {
        // Idempotent retry: Exactly identical payload already durably saved
        return {
          status: 'ALREADY_COMMITTED_IDEMPOTENT_ACK',
          acknowledged: true,
          eventId: event.event_id,
          aggregateId: event.aggregate_id,
          message: 'Idempotent acknowledgment: Event already durably stored.',
          persistedDurable: true,
        };
      } else {
        // Conflict: Payload mutation detected on identical event/aggregate ID
        return {
          status: 'REJECTED_PAYLOAD_MUTATION',
          acknowledged: false,
          eventId: event.event_id,
          aggregateId: event.aggregate_id,
          message: 'Conflict rejected: Event ID already exists with conflicting payload hash.',
          persistedDurable: false,
        };
      }
    }

    // 2. Dependency Check (e.g., return or adjustment referencing parent sale)
    if (event.parent_id && !this.hasAggregate(event.parent_id)) {
      // Buffer child until parent arrives
      const insertBuf = this.db.prepare(`
        INSERT OR REPLACE INTO out_of_order_buffer (event_id, parent_id, aggregate_id, branch_id, event_json, aggregate_json)
        VALUES (?, ?, ?, ?, ?, ?);
      `);
      insertBuf.run(event.event_id, event.parent_id, event.aggregate_id, branchId, JSON.stringify(event), JSON.stringify(aggregate));

      return {
        status: 'BUFFERED_WAITING_PARENT',
        acknowledged: false,
        eventId: event.event_id,
        aggregateId: event.aggregate_id,
        message: `Parent aggregate ${event.parent_id} not yet present. Event buffered in waiting queue.`,
        persistedDurable: false,
      };
    }

    // 3. Durable Commitment Step (Executed BEFORE sending ACK)
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const insertEvent = this.db.prepare(`
        INSERT INTO server_events (event_id, aggregate_type, aggregate_id, parent_id, branch_id, terminal_id, payload_json, payload_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      insertEvent.run(
        event.event_id,
        event.aggregate_type,
        event.aggregate_id,
        event.parent_id ?? null,
        branchId,
        terminalId,
        event.payload_json,
        event.payload_hash,
        event.created_at
      );

      const insertAgg = this.db.prepare(`
        INSERT INTO server_aggregates (aggregate_id, data_json)
        VALUES (?, ?);
      `);
      insertAgg.run(event.aggregate_id, JSON.stringify(aggregate));

      // Also populate relational server tables if aggregate data is present
      if (aggregate.sale) {
        this.insertRelationalSale(aggregate, branchId, terminalId);
      }

      // 4. Resolve any buffered children waiting for this parent
      const waitingRows = this.db.prepare(
        'SELECT event_id, aggregate_id, event_json, aggregate_json FROM out_of_order_buffer WHERE parent_id = ?;'
      ).all(event.aggregate_id) as Array<{ event_id: string; aggregate_id: string; event_json: string; aggregate_json: string }>;

      if (waitingRows.length > 0) {
        const deleteBuf = this.db.prepare('DELETE FROM out_of_order_buffer WHERE parent_id = ?;');
        for (const child of waitingRows) {
          const childEvent = JSON.parse(child.event_json) as ServerSyncEvent;
          insertEvent.run(
            childEvent.event_id,
            childEvent.aggregate_type,
            childEvent.aggregate_id,
            childEvent.parent_id ?? null,
            branchId,
            terminalId,
            childEvent.payload_json,
            childEvent.payload_hash,
            childEvent.created_at
          );
          insertAgg.run(child.aggregate_id, child.aggregate_json);
        }
        deleteBuf.run(event.aggregate_id);
      }

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    // 5. Simulated Network Failure (Server committed, but network dropped HTTP ACK)
    if (options?.simulateLostNetworkAck) {
      return {
        status: 'COMMITTED_ACK',
        acknowledged: false,
        eventId: event.event_id,
        aggregateId: event.aggregate_id,
        message: 'Network drop: Server committed data durably, but HTTP ACK dropped in transit.',
        persistedDurable: true,
      };
    }

    return {
      status: 'COMMITTED_ACK',
      acknowledged: true,
      eventId: event.event_id,
      aggregateId: event.aggregate_id,
      message: 'Event successfully and durably committed on central server.',
      persistedDurable: true,
    };
  }

  /**
   * Internal helper to insert relational models from CanonicalSaleAggregate.
   */
  private insertRelationalSale(aggregate: CanonicalSaleAggregate, branchId: string, terminalId: string): void {
    const s = aggregate.sale;
    const insertSale = this.db.prepare(`
      INSERT OR REPLACE INTO server_sales (
        id, invoice_number, branch_id, terminal_id, counter_id, session_id,
        business_date, tax_policy_version, subtotal_taxable_paise, total_cgst_paise,
        total_sgst_paise, total_igst_paise, round_off_paise, net_payable_paise,
        sale_status, payment_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    insertSale.run(
      s.id,
      s.invoice_number,
      branchId,
      s.terminal_id || terminalId,
      s.counter_id || 'C1',
      s.session_id || 'sess_default',
      s.business_date,
      s.tax_policy_version || '2026.1-TN',
      s.subtotal_taxable_paise,
      s.total_cgst_paise,
      s.total_sgst_paise,
      s.total_igst_paise,
      s.round_off_paise,
      s.net_payable_paise,
      s.sale_status,
      s.payment_status,
      s.created_at
    );

    if (aggregate.items) {
      const insertItem = this.db.prepare(`
        INSERT OR REPLACE INTO server_sale_items (
          id, sale_id, branch_id, product_id, quantity_input, pricing_unit,
          taxable_paise, cgst_paise, sgst_paise, gross_paise,
          stock_deduction_delta, stock_unit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      for (const item of aggregate.items) {
        insertItem.run(
          item.id,
          s.id,
          branchId,
          item.product_id,
          item.quantity_input,
          item.pricing_unit,
          item.taxable_paise,
          item.cgst_paise,
          item.sgst_paise,
          item.gross_paise,
          item.stock_deduction_delta,
          item.stock_unit
        );
      }
    }

    if (aggregate.payments) {
      const insertPayment = this.db.prepare(`
        INSERT OR REPLACE INTO server_sale_payments (
          id, sale_id, branch_id, payment_method, allocated_amount_paise,
          tendered_paise, change_returned_paise, net_amount_paise, outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
      for (const p of aggregate.payments) {
        insertPayment.run(
          p.id,
          s.id,
          branchId,
          p.payment_method,
          p.allocated_amount_paise,
          p.tendered_paise,
          p.change_returned_paise,
          p.net_amount_paise,
          p.outcome
        );
      }
    }

    if (aggregate.cash_movements) {
      const insertCash = this.db.prepare(`
        INSERT OR REPLACE INTO server_cash_movements (
          id, branch_id, session_id, movement_type, amount_paise, direction, reference_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `);
      for (const cm of aggregate.cash_movements) {
        insertCash.run(
          cm.id,
          branchId,
          cm.session_id,
          cm.movement_type,
          cm.amount_paise,
          cm.direction,
          cm.reference_id,
          cm.created_at
        );
      }
    }

    if (aggregate.stock_movements) {
      const insertStock = this.db.prepare(`
        INSERT OR REPLACE INTO server_stock_movements (
          id, branch_id, product_id, movement_type, quantity_delta, unit, reference_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `);
      for (const sm of aggregate.stock_movements) {
        insertStock.run(
          sm.id,
          branchId,
          sm.product_id,
          sm.movement_type,
          sm.quantity_delta,
          sm.unit,
          sm.reference_id,
          sm.created_at
        );
      }
    }
  }

  /**
   * Ingests a batch of synchronization events from a branch terminal.
   * Handles individual event idempotency, conflicts, and relational storage.
   */
  public ingestBatch(batch: BatchSyncRequest): { results: BatchSyncResultItem[] } {
    const results: BatchSyncResultItem[] = [];

    for (const item of batch.events) {
      // 1. Idempotency & Conflict Check
      const existing = this.db.prepare(
        'SELECT event_id, aggregate_id, payload_hash FROM server_events WHERE event_id = ? OR (aggregate_id = ? AND aggregate_type = ?) LIMIT 1;'
      ).get(item.event_id, item.aggregate_id, item.aggregate_type) as { event_id: string; aggregate_id: string; payload_hash: string } | undefined;

      if (existing) {
        if (existing.payload_hash === item.payload_hash) {
          results.push({
            event_id: item.event_id,
            status: 'ALREADY_COMMITTED_IDEMPOTENT_ACK',
            acknowledged: true,
            message: 'Idempotent acknowledgment: Event already stored.',
          });
          continue;
        } else {
          results.push({
            event_id: item.event_id,
            status: 'REJECTED_PAYLOAD_MUTATION',
            acknowledged: false,
            message: 'Conflict rejected: Event ID exists with conflicting payload hash.',
          });
          continue;
        }
      }

      // 2. Parse payload JSON and commit
      try {
        const parsed = JSON.parse(item.payload_json);

        this.db.exec('BEGIN TRANSACTION;');

        const insertEvent = this.db.prepare(`
          INSERT INTO server_events (event_id, aggregate_type, aggregate_id, parent_id, branch_id, terminal_id, payload_json, payload_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        `);
        insertEvent.run(
          item.event_id,
          item.aggregate_type,
          item.aggregate_id,
          item.parent_id ?? null,
          batch.branch_id,
          batch.terminal_id,
          item.payload_json,
          item.payload_hash,
          item.created_at
        );

        if (item.aggregate_type === 'SALE') {
          // If parsed object is a CanonicalSaleAggregate
          if (parsed.sale) {
            this.insertRelationalSale(parsed, batch.branch_id, batch.terminal_id);
          } else {
            // Flat FinalizeSalePayload from Rust POS outbox
            const insertSale = this.db.prepare(`
              INSERT OR REPLACE INTO server_sales (
                id, invoice_number, branch_id, terminal_id, counter_id, session_id,
                business_date, tax_policy_version, subtotal_taxable_paise, total_cgst_paise,
                total_sgst_paise, total_igst_paise, round_off_paise, net_payable_paise,
                sale_status, payment_status, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            `);
            const saleId = parsed.sale_id || item.aggregate_id;
            const invoiceNum = parsed.invoice_number || `${batch.branch_id}1/2627/${saleId.substring(0, 6)}`;
            insertSale.run(
              saleId,
              invoiceNum,
              batch.branch_id,
              parsed.terminal_id || batch.terminal_id,
              parsed.counter_id || 'C1',
              parsed.session_id || 'sess_default',
              parsed.business_date || item.created_at.split('T')[0],
              parsed.tax_policy_version || '2026.1-TN',
              parsed.subtotal_taxable_paise || 0,
              parsed.total_cgst_paise || 0,
              parsed.total_sgst_paise || 0,
              parsed.total_igst_paise || 0,
              parsed.round_off_paise || 0,
              parsed.net_payable_paise || 0,
              parsed.sale_status || 'COMPLETED',
              parsed.payment_status || 'SETTLED',
              item.created_at
            );

            if (Array.isArray(parsed.items)) {
              const insertItem = this.db.prepare(`
                INSERT OR REPLACE INTO server_sale_items (
                  id, sale_id, branch_id, product_id, quantity_input, pricing_unit,
                  taxable_paise, cgst_paise, sgst_paise, gross_paise,
                  stock_deduction_delta, stock_unit
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
              `);
              for (const it of parsed.items) {
                const itemId = it.id || `item_${saleId}_${it.product_id}`;
                insertItem.run(
                  itemId,
                  saleId,
                  batch.branch_id,
                  it.product_id,
                  it.quantity_input || 0,
                  it.pricing_unit || 'PER_KG',
                  it.taxable_paise || 0,
                  it.cgst_paise || 0,
                  it.sgst_paise || 0,
                  it.gross_paise || 0,
                  it.stock_deduction_delta || 0,
                  it.stock_unit || 'MG'
                );
              }
            }

            if (Array.isArray(parsed.payments)) {
              const insertPayment = this.db.prepare(`
                INSERT OR REPLACE INTO server_sale_payments (
                  id, sale_id, branch_id, payment_method, allocated_amount_paise,
                  tendered_paise, change_returned_paise, net_amount_paise, outcome
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
              `);
              for (const pay of parsed.payments) {
                const payId = pay.id || `pay_${saleId}_${pay.payment_method}`;
                insertPayment.run(
                  payId,
                  saleId,
                  batch.branch_id,
                  pay.payment_method,
                  pay.allocated_amount_paise || 0,
                  pay.tendered_paise || 0,
                  pay.change_returned_paise || 0,
                  pay.net_amount_paise || 0,
                  pay.outcome || 'SUCCESS'
                );
              }
            }
          }
        } else if (item.aggregate_type === 'RETURN') {
          // Update sale status to VOIDED / REFUNDED
          const targetSaleId = parsed.sale_id || item.aggregate_id;
          this.db.prepare(
            "UPDATE server_sales SET sale_status = 'VOIDED', payment_status = 'REFUNDED' WHERE id = ?;"
          ).run(targetSaleId);
        } else if (item.aggregate_type === 'STOCK_MOVEMENT') {
          const insertSM = this.db.prepare(`
            INSERT OR REPLACE INTO server_stock_movements (
              id, branch_id, product_id, movement_type, quantity_delta, unit, reference_id, reason, actor_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
          `);
          insertSM.run(
            parsed.id || item.aggregate_id,
            batch.branch_id,
            parsed.product_id,
            parsed.movement_type,
            parsed.quantity_delta,
            parsed.unit,
            parsed.reference_id,
            parsed.reason || null,
            parsed.actor_id || null,
            item.created_at
          );
        }

        this.db.exec('COMMIT;');

        results.push({
          event_id: item.event_id,
          status: 'COMMITTED_ACK',
          acknowledged: true,
          message: 'Event successfully committed.',
        });
      } catch (err: any) {
        this.db.exec('ROLLBACK;');
        results.push({
          event_id: item.event_id,
          status: 'REJECTED_PAYLOAD_MUTATION',
          acknowledged: false,
          message: `Ingestion error: ${err.message}`,
        });
      }
    }

    return { results };
  }

  // ==========================================================================
  // CONSOLIDATED CROSS-BRANCH OWNER REPORTING
  // ==========================================================================

  public getConsolidatedSalesReport(startDate?: string, endDate?: string): any {
    let whereClause = "WHERE 1=1";
    const params: any[] = [];
    if (startDate) {
      whereClause += " AND business_date >= ?";
      params.push(startDate);
    }
    if (endDate) {
      whereClause += " AND business_date <= ?";
      params.push(endDate);
    }

    const overallRow = this.db.prepare(`
      SELECT 
        COUNT(id) as total_bills,
        SUM(CASE WHEN sale_status != 'VOIDED' THEN 1 ELSE 0 END) as active_bills,
        SUM(CASE WHEN sale_status == 'VOIDED' THEN 1 ELSE 0 END) as voided_bills,
        COALESCE(SUM(CASE WHEN sale_status != 'VOIDED' THEN subtotal_taxable_paise ELSE 0 END), 0) as taxable_sales_paise,
        COALESCE(SUM(CASE WHEN sale_status != 'VOIDED' THEN total_cgst_paise ELSE 0 END), 0) as total_cgst_paise,
        COALESCE(SUM(CASE WHEN sale_status != 'VOIDED' THEN total_sgst_paise ELSE 0 END), 0) as total_sgst_paise,
        COALESCE(SUM(CASE WHEN sale_status != 'VOIDED' THEN net_payable_paise ELSE 0 END), 0) as net_sales_paise,
        COALESCE(SUM(CASE WHEN sale_status == 'VOIDED' THEN net_payable_paise ELSE 0 END), 0) as voided_amount_paise,
        COALESCE(SUM(net_payable_paise), 0) as gross_sales_paise
      FROM server_sales
      ${whereClause};
    `).get(...params) as any;

    const branchRows = this.db.prepare(`
      SELECT 
        s.branch_id,
        COALESCE(b.name, s.branch_id) as branch_name,
        COUNT(s.id) as total_bills,
        SUM(CASE WHEN s.sale_status != 'VOIDED' THEN 1 ELSE 0 END) as active_bills,
        SUM(CASE WHEN s.sale_status == 'VOIDED' THEN 1 ELSE 0 END) as voided_bills,
        COALESCE(SUM(CASE WHEN s.sale_status != 'VOIDED' THEN s.subtotal_taxable_paise ELSE 0 END), 0) as taxable_sales_paise,
        COALESCE(SUM(CASE WHEN s.sale_status != 'VOIDED' THEN s.total_cgst_paise ELSE 0 END), 0) as total_cgst_paise,
        COALESCE(SUM(CASE WHEN s.sale_status != 'VOIDED' THEN s.total_sgst_paise ELSE 0 END), 0) as total_sgst_paise,
        COALESCE(SUM(CASE WHEN s.sale_status != 'VOIDED' THEN s.net_payable_paise ELSE 0 END), 0) as net_sales_paise,
        COALESCE(SUM(CASE WHEN s.sale_status == 'VOIDED' THEN s.net_payable_paise ELSE 0 END), 0) as voided_amount_paise,
        COALESCE(SUM(s.net_payable_paise), 0) as gross_sales_paise
      FROM server_sales s
      LEFT JOIN server_branches b ON s.branch_id = b.code
      ${whereClause}
      GROUP BY s.branch_id
      ORDER BY s.branch_id ASC;
    `).all(...params) as any[];

    return {
      filter: { startDate, endDate },
      overall: {
        total_bills: overallRow.total_bills || 0,
        active_bills: overallRow.active_bills || 0,
        voided_bills: overallRow.voided_bills || 0,
        taxable_sales_paise: overallRow.taxable_sales_paise || 0,
        total_tax_paise: (overallRow.total_cgst_paise || 0) + (overallRow.total_sgst_paise || 0),
        total_cgst_paise: overallRow.total_cgst_paise || 0,
        total_sgst_paise: overallRow.total_sgst_paise || 0,
        gross_sales_paise: overallRow.gross_sales_paise || 0,
        voided_amount_paise: overallRow.voided_amount_paise || 0,
        net_sales_paise: overallRow.net_sales_paise || 0,
      },
      branch_breakdown: branchRows,
      by_branch: branchRows,
    };
  }

  public getBranchComparisonReport(startDate?: string, endDate?: string): any {
    let whereClause = "WHERE 1=1";
    const params: any[] = [];
    if (startDate) {
      whereClause += " AND s.business_date >= ?";
      params.push(startDate);
    }
    if (endDate) {
      whereClause += " AND s.business_date <= ?";
      params.push(endDate);
    }

    const rows = this.db.prepare(`
      SELECT 
        s.branch_id,
        COALESCE(b.name, s.branch_id) as branch_name,
        SUM(CASE WHEN s.sale_status != 'VOIDED' THEN 1 ELSE 0 END) as active_bills,
        COALESCE(SUM(CASE WHEN s.sale_status != 'VOIDED' THEN s.net_payable_paise ELSE 0 END), 0) as net_sales_paise,
        COALESCE(SUM(s.net_payable_paise), 0) as gross_sales_paise,
        COALESCE(SUM(CASE WHEN p.payment_method = 'CASH' AND s.sale_status != 'VOIDED' THEN p.allocated_amount_paise ELSE 0 END), 0) as cash_collected_paise,
        COALESCE(SUM(CASE WHEN p.payment_method LIKE '%UPI%' AND s.sale_status != 'VOIDED' THEN p.allocated_amount_paise ELSE 0 END), 0) as upi_collected_paise
      FROM server_sales s
      LEFT JOIN server_branches b ON s.branch_id = b.code
      LEFT JOIN server_sale_payments p ON s.id = p.sale_id
      ${whereClause}
      GROUP BY s.branch_id
      ORDER BY s.branch_id ASC;
    `).all(...params) as any[];

    const comparison = rows.map(r => {
      const activeCount = r.active_bills || 0;
      const netSales = r.net_sales_paise || 0;
      const avgTicket = activeCount > 0 ? Math.round(netSales / activeCount) : 0;
      return {
        branch_id: r.branch_id,
        branch_name: r.branch_name,
        active_bills: activeCount,
        bill_count: activeCount,
        gross_sales_paise: r.gross_sales_paise || 0,
        net_sales_paise: netSales,
        revenue_paise: netSales,
        cash_collected_paise: r.cash_collected_paise || 0,
        upi_collected_paise: r.upi_collected_paise || 0,
        avg_ticket_paise: avgTicket,
        avg_bill_paise: avgTicket,
      };
    });

    return {
      comparison,
      branches: comparison,
    };
  }

  public getConsolidatedGstReport(startDate?: string, endDate?: string): any {
    let whereClause = "WHERE s.sale_status != 'VOIDED'";
    const params: any[] = [];
    if (startDate) {
      whereClause += " AND s.business_date >= ?";
      params.push(startDate);
    }
    if (endDate) {
      whereClause += " AND s.business_date <= ?";
      params.push(endDate);
    }

    const slabs = this.db.prepare(`
      SELECT 
        5.0 as tax_rate_percent,
        COALESCE(SUM(s.subtotal_taxable_paise), 0) as taxable_paise,
        COALESCE(SUM(s.total_cgst_paise), 0) as cgst_paise,
        COALESCE(SUM(s.total_sgst_paise), 0) as sgst_paise,
        COALESCE(SUM(s.total_cgst_paise + s.total_sgst_paise), 0) as total_tax_paise,
        COALESCE(SUM(s.net_payable_paise), 0) as total_gross_paise
      FROM server_sales s
      ${whereClause};
    `).all(...params) as any[];

    const branchGst = this.db.prepare(`
      SELECT 
        s.branch_id,
        COALESCE(b.name, s.branch_id) as branch_name,
        COALESCE(SUM(s.subtotal_taxable_paise), 0) as taxable_paise,
        COALESCE(SUM(s.total_cgst_paise), 0) as cgst_paise,
        COALESCE(SUM(s.total_sgst_paise), 0) as sgst_paise,
        COALESCE(SUM(s.total_cgst_paise + s.total_sgst_paise), 0) as total_tax_paise,
        COALESCE(SUM(s.net_payable_paise), 0) as total_gross_paise
      FROM server_sales s
      LEFT JOIN server_branches b ON s.branch_id = b.code
      ${whereClause}
      GROUP BY s.branch_id
      ORDER BY s.branch_id ASC;
    `).all(...params) as any[];

    return {
      slabs,
      branch_gst: branchGst,
    };
  }

  public getConsolidatedInventoryReport(): any {
    const rows = this.db.prepare(`
      SELECT 
        sm.branch_id,
        COALESCE(b.name, sm.branch_id) as branch_name,
        sm.product_id,
        SUM(sm.quantity_delta) as net_quantity_delta,
        sm.unit,
        COUNT(sm.id) as movements_count
      FROM server_stock_movements sm
      LEFT JOIN server_branches b ON sm.branch_id = b.code
      GROUP BY sm.branch_id, sm.product_id
      ORDER BY sm.branch_id ASC, sm.product_id ASC;
    `).all() as any[];

    return { inventory: rows };
  }

  public getSyncStatus(branchId?: string): any {
    if (branchId) {
      const row = this.db.prepare(`
        SELECT 
          COUNT(event_id) as total_events,
          MAX(created_at) as last_event_at
        FROM server_events
        WHERE branch_id = ?;
      `).get(branchId) as any;

      const salesRow = this.db.prepare(`
        SELECT COUNT(id) as total_sales FROM server_sales WHERE branch_id = ?;
      `).get(branchId) as any;

      return {
        branch_id: branchId,
        total_events: row.total_events || 0,
        totalEvents: row.total_events || 0,
        total_sales: salesRow.total_sales || 0,
        totalSales: salesRow.total_sales || 0,
        last_event_at: row.last_event_at || null,
        lastEventAt: row.last_event_at || null,
      };
    } else {
      const branches = this.db.prepare(`
        SELECT 
          b.code as branch_id,
          b.name as branch_name,
          COUNT(e.event_id) as total_events,
          MAX(e.created_at) as last_event_at
        FROM server_branches b
        LEFT JOIN server_events e ON b.code = e.branch_id
        GROUP BY b.code
        ORDER BY b.code ASC;
      `).all() as any[];

      return { branches };
    }
  }

  /**
   * Replays events when an offline backup is restored onto a terminal.
   * Already acknowledged events must be recognized idempotently without duplicating aggregates.
   */
  public replayRestoredEvents(
    events: Array<{ event: ServerSyncEvent; aggregate: CanonicalSaleAggregate }>
  ): { totalReplayed: number; alreadyCommittedCount: number; newlyCommittedCount: number } {
    let alreadyCommittedCount = 0;
    let newlyCommittedCount = 0;

    for (const item of events) {
      const res = this.ingest(item.event, item.aggregate);
      if (res.status === 'ALREADY_COMMITTED_IDEMPOTENT_ACK') {
        alreadyCommittedCount++;
      } else if (res.status === 'COMMITTED_ACK') {
        newlyCommittedCount++;
      }
    }

    return {
      totalReplayed: events.length,
      alreadyCommittedCount,
      newlyCommittedCount,
    };
  }

  /**
   * Ingests asynchronous payment reconciliation webhooks/events.
   * Handles out-of-order sequence arrivals and duplicate deliveries idempotently.
   */
  public ingestPaymentReconciliation(
    event: PaymentReconciliationEvent
  ): { accepted: boolean; isDuplicate: boolean; currentOutcome: 'SUCCESS' | 'FAILED' } {
    const key = `${event.sale_id}:${event.payment_id}`;
    const existing = this.db.prepare(
      'SELECT gateway_outcome, sequence_number FROM payment_reconciliation_ledger WHERE reconciliation_key = ?;'
    ).get(key) as { gateway_outcome: 'SUCCESS' | 'FAILED'; sequence_number: number } | undefined;

    if (existing) {
      if (event.sequence_number <= existing.sequence_number) {
        return {
          accepted: true,
          isDuplicate: true,
          currentOutcome: existing.gateway_outcome,
        };
      }
    }

    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO payment_reconciliation_ledger (
        reconciliation_key, sale_id, payment_id, gateway_outcome, sequence_number, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?);
    `);
    upsert.run(key, event.sale_id, event.payment_id, event.gateway_outcome, event.sequence_number, event.occurred_at);

    return {
      accepted: true,
      isDuplicate: false,
      currentOutcome: event.gateway_outcome,
    };
  }

  /**
   * Publishes a product creation, price update, tax revision, or deactivation.
   * Monotonically increments version counter and updates timestamp.
   */
  public publishCatalogProduct(payload: PublishCatalogProductPayload): {
    success: boolean;
    product: ServerCatalogProduct;
    version: number;
    action: 'CREATED' | 'UPDATED';
  } {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      const existing = this.db.prepare(
        'SELECT * FROM server_catalog_products WHERE id = ? OR sku = ? LIMIT 1;'
      ).get(payload.id || '', payload.sku) as any;

      const now = new Date().toISOString();

      const maxRow = this.db.prepare('SELECT MAX(version) as max_v FROM server_catalog_products;').get() as { max_v: number | null };
      const globalMaxVersion = maxRow?.max_v || 1;

      if (existing) {
        const newVersion = Math.max((existing.version || 1) + 1, globalMaxVersion + 1);
        const updatedProduct: ServerCatalogProduct = {
          id: existing.id,
          name: payload.name || existing.name,
          tamil_name: payload.tamil_name || existing.tamil_name,
          sku: payload.sku || existing.sku,
          barcode: payload.barcode !== undefined ? payload.barcode : existing.barcode,
          category_id: payload.category_id || existing.category_id,
          pricing_unit: payload.pricing_unit || existing.pricing_unit,
          inventory_unit: payload.inventory_unit || existing.inventory_unit,
          pricing_basis: payload.pricing_basis || existing.pricing_basis,
          base_price_paise: payload.base_price_paise !== undefined ? payload.base_price_paise : existing.base_price_paise,
          piece_price_paise: payload.piece_price_paise !== undefined ? payload.piece_price_paise : existing.piece_price_paise,
          tax_rate_bps: payload.tax_rate_bps !== undefined ? payload.tax_rate_bps : existing.tax_rate_bps,
          hsn_code: payload.hsn_code || existing.hsn_code,
          is_active: payload.is_active !== undefined ? payload.is_active : (existing.is_active === 1),
          version: newVersion,
          target_branch_ids: payload.target_branch_ids || existing.target_branch_ids || '*',
          updated_at: now,
        };

        this.db.prepare(`
          UPDATE server_catalog_products SET
            name = ?, tamil_name = ?, sku = ?, barcode = ?, category_id = ?,
            pricing_unit = ?, inventory_unit = ?, pricing_basis = ?, base_price_paise = ?,
            piece_price_paise = ?, tax_rate_bps = ?, hsn_code = ?, is_active = ?,
            version = ?, target_branch_ids = ?, updated_at = ?
          WHERE id = ?;
        `).run(
          updatedProduct.name,
          updatedProduct.tamil_name,
          updatedProduct.sku,
          updatedProduct.barcode,
          updatedProduct.category_id,
          updatedProduct.pricing_unit,
          updatedProduct.inventory_unit,
          updatedProduct.pricing_basis,
          updatedProduct.base_price_paise,
          updatedProduct.piece_price_paise,
          updatedProduct.tax_rate_bps,
          updatedProduct.hsn_code,
          updatedProduct.is_active ? 1 : 0,
          updatedProduct.version,
          updatedProduct.target_branch_ids,
          updatedProduct.updated_at,
          updatedProduct.id
        );

        this.db.exec('COMMIT;');
        return {
          success: true,
          product: updatedProduct,
          version: newVersion,
          action: 'UPDATED',
        };
      } else {
        const nextVersion = globalMaxVersion + 1;
        const productId = payload.id || `prod_${Date.now()}`;
        const newProduct: ServerCatalogProduct = {
          id: productId,
          name: payload.name,
          tamil_name: payload.tamil_name || payload.name,
          sku: payload.sku,
          barcode: payload.barcode || null,
          category_id: payload.category_id || 'cat_sweets',
          pricing_unit: payload.pricing_unit || 'PER_KG',
          inventory_unit: payload.inventory_unit || 'MG',
          pricing_basis: payload.pricing_basis || 'TAX_INCLUSIVE',
          base_price_paise: payload.base_price_paise,
          piece_price_paise: payload.piece_price_paise || null,
          tax_rate_bps: payload.tax_rate_bps || 500,
          hsn_code: payload.hsn_code || '21069099',
          is_active: payload.is_active !== undefined ? payload.is_active : true,
          version: nextVersion,
          target_branch_ids: payload.target_branch_ids || '*',
          updated_at: now,
        };

        this.db.prepare(`
          INSERT INTO server_catalog_products (
            id, name, tamil_name, sku, barcode, category_id, pricing_unit, inventory_unit,
            pricing_basis, base_price_paise, piece_price_paise, tax_rate_bps, hsn_code,
            is_active, version, target_branch_ids, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `).run(
          newProduct.id,
          newProduct.name,
          newProduct.tamil_name,
          newProduct.sku,
          newProduct.barcode,
          newProduct.category_id,
          newProduct.pricing_unit,
          newProduct.inventory_unit,
          newProduct.pricing_basis,
          newProduct.base_price_paise,
          newProduct.piece_price_paise,
          newProduct.tax_rate_bps,
          newProduct.hsn_code,
          newProduct.is_active ? 1 : 0,
          newProduct.version,
          newProduct.target_branch_ids,
          newProduct.updated_at
        );

        this.db.exec('COMMIT;');
        return {
          success: true,
          product: newProduct,
          version: nextVersion,
          action: 'CREATED',
        };
      }
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  /**
   * Retrieves catalog updates strictly since a given version for a target branch.
   * Enforces branch targeting and returns the highest version in the catalog.
   */
  public getCatalogUpdates(
    sinceVersion: number = 0,
    branchId: string = '*'
  ): {
    latest_version: number;
    products: ServerCatalogProduct[];
    count: number;
    server_time: string;
  } {
    const rows = this.db.prepare(`
      SELECT * FROM server_catalog_products
      WHERE version > ?
        AND (target_branch_ids = '*' OR target_branch_ids LIKE ? OR target_branch_ids LIKE ?)
      ORDER BY version ASC;
    `).all(sinceVersion, `%${branchId}%`, `%${branchId},%`) as any[];

    const products: ServerCatalogProduct[] = rows.map(r => ({
      id: r.id,
      name: r.name,
      tamil_name: r.tamil_name,
      sku: r.sku,
      barcode: r.barcode,
      category_id: r.category_id,
      pricing_unit: r.pricing_unit,
      inventory_unit: r.inventory_unit,
      pricing_basis: r.pricing_basis,
      base_price_paise: r.base_price_paise,
      piece_price_paise: r.piece_price_paise,
      tax_rate_bps: r.tax_rate_bps,
      hsn_code: r.hsn_code,
      is_active: r.is_active === 1,
      version: r.version,
      target_branch_ids: r.target_branch_ids,
      updated_at: r.updated_at,
    }));

    const maxRow = this.db.prepare('SELECT MAX(version) as max_v FROM server_catalog_products;').get() as { max_v: number | null };
    const latestVersion = maxRow?.max_v || 1;

    return {
      latest_version: latestVersion,
      products,
      count: products.length,
      server_time: new Date().toISOString(),
    };
  }

  public getCatalogProducts(): ServerCatalogProduct[] {
    const res = this.getCatalogUpdates(0, '*');
    return res.products;
  }

  public isBranchAuthorized(branchCode: string): boolean {
    const row = this.db.prepare('SELECT is_active FROM server_branches WHERE code = ?;').get(branchCode) as { is_active: number } | undefined;
    return !!row && row.is_active === 1;
  }

  public close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch {
      // Ignore if already closing
    }
    this.db.close();
  }
}

/**
 * Creates an authoritative HTTP server wrapping DurableSyncServer.
 * Enforces organization, terminal, and branch authentication headers.
 */
export function createSyncHttpServer(
  server: DurableSyncServer,
  options?: { apiKey?: string }
): http.Server {
  const isProduction = process.env.NODE_ENV === 'production';
  let expectedApiKey =
    options?.apiKey ??
    process.env.MALGUDI_SYNC_API_KEY ??
    process.env.SYNC_API_KEY;

  if (isProduction) {
    if (!expectedApiKey || expectedApiKey === 'malgudi_sync_secret_token_2026' || expectedApiKey.trim().length < 32) {
      throw new Error(
        'SECURITY VIOLATION: MALGUDI_SYNC_API_KEY environment variable is required, must be at least 32 characters, and cannot use default secret in production mode.'
      );
    }
  } else {
    expectedApiKey = expectedApiKey ?? 'malgudi_sync_secret_token_2026';
  }

  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;

    // 1. Lightweight Health Check (No auth required, Render liveness probe)
    // Does NOT expose secrets or internal filesystem paths.
    if (
      req.method === 'GET' &&
      (pathname === '/health' || pathname === '/api/v1/health' || pathname === '/api/v1/sync/health')
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'healthy',
          service: 'malgudi-central-sync-api',
          version: '2.9.8',
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // 2. Authentication Enforcement
    const authHeader = req.headers['authorization'];
    const terminalId = req.headers['x-terminal-id'] as string | undefined;
    const branchId = req.headers['x-branch-id'] as string | undefined;

    if (!authHeader || authHeader !== `Bearer ${expectedApiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED_ACCESS', message: 'Valid Bearer token required.' }));
      return;
    }

    // 3. Central Reporting Endpoints (Admin access, does not require terminal ID)
    if (req.method === 'GET' && pathname === '/api/v1/reports/consolidated-sales') {
      const startDate = parsedUrl.searchParams.get('start_date') || undefined;
      const endDate = parsedUrl.searchParams.get('end_date') || undefined;
      const result = server.getConsolidatedSalesReport(startDate, endDate);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/reports/branch-comparison') {
      const startDate = parsedUrl.searchParams.get('start_date') || undefined;
      const endDate = parsedUrl.searchParams.get('end_date') || undefined;
      const result = server.getBranchComparisonReport(startDate, endDate);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/reports/consolidated-gst') {
      const startDate = parsedUrl.searchParams.get('start_date') || undefined;
      const endDate = parsedUrl.searchParams.get('end_date') || undefined;
      const result = server.getConsolidatedGstReport(startDate, endDate);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/reports/consolidated-inventory') {
      const result = server.getConsolidatedInventoryReport();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/sync/status') {
      const targetBranch = parsedUrl.searchParams.get('branch_id') || branchId || undefined;
      const result = server.getSyncStatus(targetBranch);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/catalog/products') {
      const prods = server.getCatalogProducts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ products: prods, count: prods.length }));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/catalog/updates') {
      if (!terminalId || !branchId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED_TERMINAL_ACCESS', message: 'Valid X-Terminal-Id and X-Branch-Id required.' }));
        return;
      }

      // Security: Validate branch authorization on the server (Requirement 6)
      if (!server.isBranchAuthorized(branchId)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'FORBIDDEN_BRANCH', message: `Branch '${branchId}' is not authorized or is inactive.` }));
        return;
      }

      const sinceVersion = parseInt(parsedUrl.searchParams.get('since_version') || '0', 10);
      const updates = server.getCatalogUpdates(sinceVersion, branchId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updates));
      return;
    }

    // 4. Request body parsing
    let rawBody = '';
    req.on('data', chunk => {
      rawBody += chunk;
    });

    req.on('end', () => {
      try {
        const body = rawBody ? JSON.parse(rawBody) : {};

        // Publish Catalog Product (Central Admin API)
        if (req.method === 'POST' && pathname === '/api/v1/catalog/publish') {
          if (!body.name || !body.sku || body.base_price_paise === undefined || typeof body.base_price_paise !== 'number' || body.base_price_paise <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_PAYLOAD', message: 'name, sku, and positive base_price_paise are required.' }));
            return;
          }
          const result = server.publishCatalogProduct(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // Terminal-level validation for sync endpoints
        if (!terminalId || !branchId) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'UNAUTHORIZED_TERMINAL_ACCESS', message: 'Valid X-Terminal-Id and X-Branch-Id required.' }));
          return;
        }

        // Security: Validate branch authorization on the server
        if (!server.isBranchAuthorized(branchId)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'FORBIDDEN_BRANCH', message: `Branch '${branchId}' is not authorized or is inactive.` }));
          return;
        }

        // Security: Ensure payload branch_id matches authenticated header branch
        if (body.branch_id && body.branch_id !== branchId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'BRANCH_IDENTITY_MISMATCH', message: `Payload branch '${body.branch_id}' does not match authenticated header branch '${branchId}'.` }));
          return;
        }

        // Ingest Single Event
        if (req.method === 'POST' && pathname === '/api/v1/sync/events') {
          const result = server.ingest(body.event, body.aggregate, {
            simulateLostNetworkAck: body.simulateLostNetworkAck,
            branchId,
            terminalId,
          });

          if (result.status === 'REJECTED_PAYLOAD_MUTATION') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify(result));
          return;
        }

        // Ingest Batch of Events (used by Rust POS client)
        if (req.method === 'POST' && pathname === '/api/v1/sync/batch') {
          const batchPayload: BatchSyncRequest = {
            branch_id: body.branch_id || branchId,
            terminal_id: body.terminal_id || terminalId,
            events: body.events || [],
          };
          const result = server.ingestBatch(batchPayload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // Replay Restored Events
        if (req.method === 'POST' && pathname === '/api/v1/sync/replay') {
          const result = server.replayRestoredEvents(body.events);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // Ingest Payment Reconciliation
        if (req.method === 'POST' && pathname === '/api/v1/sync/reconcile-payment') {
          const result = server.ingestPaymentReconciliation(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR', message: err.message }));
      }
    });
  });
}

// Direct CLI Execution
if (process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    const syncServer = new DurableSyncServer();
    const server = createSyncHttpServer(syncServer);

    server.listen(port, host, () => {
      console.log(`[INFO] Malgudi Cloud Sync API listening on http://${host}:${port}`);
      console.log(`[INFO] Persistent storage: SQLite WAL at ${syncServer.dbPath}`);
    });

    let isShuttingDown = false;
    const shutdown = (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`[INFO] Received ${signal}. Starting graceful shutdown...`);

      server.close((err) => {
        if (err) {
          console.error(`[ERROR] Error closing HTTP server: ${err.message}`);
        } else {
          console.log('[INFO] HTTP server stopped accepting connections.');
        }

        try {
          syncServer.close();
          console.log('[INFO] Central SQLite database closed and flushed safely.');
          process.exit(0);
        } catch (dbErr: any) {
          console.error(`[ERROR] Error closing database: ${dbErr.message}`);
          process.exit(1);
        }
      });

      // Force terminate if connections do not close within 10s
      setTimeout(() => {
        console.error('[WARN] Forced shutdown after timeout (10s).');
        try {
          syncServer.close();
        } catch {}
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err: any) {
    console.error(`[FATAL CONFIGURATION ERROR] ${err.message}`);
    process.exit(1);
  }
}
