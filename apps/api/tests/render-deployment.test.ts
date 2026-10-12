import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  DurableSyncServer,
  createSyncHttpServer,
  resolveDatabasePath,
  type BatchSyncRequest,
} from '../src/index.js';

describe('Render Deployment & Production Environment Validation', () => {
  const originalEnv = { ...process.env };
  const testDataDir = path.resolve('target/test_render_data');
  const strongApiKey = 'prod_secret_token_at_least_32_characters_long_malgudi_mithais_2026';

  beforeEach(() => {
    process.env = { ...originalEnv };
    if (fs.existsSync(testDataDir)) {
      try {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      } catch {}
    }
    fs.mkdirSync(testDataDir, { recursive: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (fs.existsSync(testDataDir)) {
      try {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('1. Production startup fails closed when MALGUDI_SYNC_API_KEY is missing, default, or too short', () => {
    process.env.NODE_ENV = 'production';
    const dbFile = path.join(testDataDir, 'test_key.db');
    const serverInstance = new DurableSyncServer(dbFile);

    // Missing key
    delete process.env.MALGUDI_SYNC_API_KEY;
    delete process.env.SYNC_API_KEY;
    expect(() => createSyncHttpServer(serverInstance)).toThrow(/SECURITY VIOLATION.*MALGUDI_SYNC_API_KEY/);

    // Default test key in production
    process.env.MALGUDI_SYNC_API_KEY = 'malgudi_sync_secret_token_2026';
    expect(() => createSyncHttpServer(serverInstance)).toThrow(/cannot use default secret in production mode/);

    // Key too short (< 32 chars)
    process.env.MALGUDI_SYNC_API_KEY = 'short_insecure_key_12345';
    expect(() => createSyncHttpServer(serverInstance)).toThrow(/must be at least 32 characters/);

    // Strong 64-character production key passes
    process.env.MALGUDI_SYNC_API_KEY = strongApiKey;
    const prodHttp = createSyncHttpServer(serverInstance);
    expect(prodHttp).toBeDefined();

    serverInstance.close();
  });

  it('2. Production startup fails closed if in-memory database is attempted in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.MALGUDI_SYNC_DB_PATH = ':memory:';

    expect(() => new DurableSyncServer()).toThrow(/FATAL CONFIGURATION ERROR.*cannot use in-memory storage in production mode/);
  });

  it('3. Configurable database directory via MALGUDI_DATA_DIR resolves and initializes on a clean directory', () => {
    process.env.MALGUDI_DATA_DIR = testDataDir;
    delete process.env.MALGUDI_SYNC_DB_PATH;

    const expectedDbPath = path.join(testDataDir, 'malgudi_central_sync.db');
    expect(resolveDatabasePath()).toBe(expectedDbPath);

    const server = new DurableSyncServer();
    expect(server.dbPath).toBe(expectedDbPath);
    expect(fs.existsSync(expectedDbPath)).toBe(true);

    // Verify initial seed products exist
    const products = server.getCatalogProducts();
    expect(products.length).toBeGreaterThan(0);

    server.close();
  });

  it('4. Persistent database data survives API restarts on persistent data directory', () => {
    process.env.MALGUDI_DATA_DIR = testDataDir;

    // Instance 1: write sales batch
    const instance1 = new DurableSyncServer();
    const batchReq: BatchSyncRequest = {
      branch_id: 'IB',
      terminal_id: 'T1',
      events: [
        {
          event_id: 'evt_persist_01',
          aggregate_type: 'SALE',
          aggregate_id: 'sale_persist_01',
          payload_json: JSON.stringify({
            sale_id: 'sale_persist_01',
            invoice_number: 'IB1/2627/000999',
            terminal_id: 'T1',
            counter_id: 'C1',
            session_id: 'sess_01',
            business_date: '2026-10-13',
            subtotal_taxable_paise: 50000,
            total_cgst_paise: 1250,
            total_sgst_paise: 1250,
            total_igst_paise: 0,
            round_off_paise: 0,
            net_payable_paise: 52500,
            sale_status: 'COMPLETED',
            payment_status: 'SETTLED',
            items: [
              {
                id: 'item_persist_01',
                product_id: 'prod_mysore_pak',
                quantity_input: 500,
                pricing_unit: 'PER_KG',
                taxable_paise: 50000,
                cgst_paise: 1250,
                sgst_paise: 1250,
                gross_paise: 52500,
                stock_deduction_delta: 500000,
                stock_unit: 'MG',
              },
            ],
            payments: [
              {
                id: 'pay_persist_01',
                payment_method: 'CASH',
                allocated_amount_paise: 52500,
                tendered_paise: 52500,
                change_returned_paise: 0,
                net_amount_paise: 52500,
                outcome: 'SUCCESS',
              },
            ],
          }),
          payload_hash: 'hash_persist_01',
          created_at: '2026-10-13T10:00:00Z',
        },
      ],
    };

    const result1 = instance1.ingestBatch(batchReq);
    expect(result1.results[0].status).toBe('COMMITTED_ACK');
    expect(result1.results[0].acknowledged).toBe(true);

    // Clean shutdown of Instance 1 (flushing WAL)
    instance1.close();

    // Instance 2: Start new process on the exact same data directory
    const instance2 = new DurableSyncServer();
    const report = instance2.getConsolidatedSalesReport('2026-10-13', '2026-10-13');
    expect(report.overall.total_bills).toBe(1);
    expect(report.overall.net_sales_paise).toBe(52500);

    instance2.close();
  });

  it('5. Health endpoints (/health, /api/v1/health, /api/v1/sync/health) return healthy without exposing secrets or paths', async () => {
    const serverInstance = new DurableSyncServer(':memory:');
    const httpServer = createSyncHttpServer(serverInstance, { apiKey: strongApiKey });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as any).port;

    const testEndpoint = async (urlPath: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('healthy');
      expect(json.service).toBe('malgudi-central-sync-api');
      expect(json.version).toBe('2.9.8');
      expect(json.timestamp).toBeDefined();
      // SECURITY INVARIANTS: no internal secrets or filesystem paths leaked
      expect((json as any).dbPath).toBeUndefined();
      expect((json as any).apiKey).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain(strongApiKey);
    };

    await testEndpoint('/health');
    await testEndpoint('/api/v1/health');
    await testEndpoint('/api/v1/sync/health');

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    serverInstance.close();
  });

  it('6. Branch authorization and mismatched branch rejection', async () => {
    const serverInstance = new DurableSyncServer(':memory:');
    const httpServer = createSyncHttpServer(serverInstance, { apiKey: strongApiKey });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (httpServer.address() as any).port;

    // Case A: Unauthorized branch header
    const resA = await fetch(`http://127.0.0.1:${port}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${strongApiKey}`,
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'INVALID_BRANCH_99',
      },
      body: JSON.stringify({ branch_id: 'INVALID_BRANCH_99', terminal_id: 'T1', events: [] }),
    });
    expect(resA.status).toBe(403);
    const jsonA = await resA.json();
    expect(jsonA.error).toBe('FORBIDDEN_BRANCH');

    // Case B: Header branch IB, but body claims branch MN
    const resB = await fetch(`http://127.0.0.1:${port}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${strongApiKey}`,
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'IB',
      },
      body: JSON.stringify({ branch_id: 'MN', terminal_id: 'T1', events: [] }),
    });
    expect(resB.status).toBe(403);
    const jsonB = await resB.json();
    expect(jsonB.error).toBe('BRANCH_IDENTITY_MISMATCH');

    // Case C: Valid matching branch IB
    const resC = await fetch(`http://127.0.0.1:${port}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${strongApiKey}`,
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'IB',
      },
      body: JSON.stringify({ branch_id: 'IB', terminal_id: 'T1', events: [] }),
    });
    expect(resC.status).toBe(200);

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    serverInstance.close();
  });

  it('7. Idempotent sync returns ALREADY_COMMITTED_IDEMPOTENT_ACK on identical retry', () => {
    const server = new DurableSyncServer(':memory:');
    const batchReq: BatchSyncRequest = {
      branch_id: 'MN',
      terminal_id: 'T1',
      events: [
        {
          event_id: 'evt_idempotent_test_01',
          aggregate_type: 'SALE',
          aggregate_id: 'sale_idempotent_01',
          payload_json: JSON.stringify({
            sale_id: 'sale_idempotent_01',
            invoice_number: 'MN1/2627/000001',
            terminal_id: 'T1',
            counter_id: 'C1',
            session_id: 'sess_mn_01',
            business_date: '2026-10-13',
            subtotal_taxable_paise: 20000,
            total_cgst_paise: 500,
            total_sgst_paise: 500,
            total_igst_paise: 0,
            round_off_paise: 0,
            net_payable_paise: 21000,
            sale_status: 'COMPLETED',
            payment_status: 'SETTLED',
            items: [
              {
                id: 'item_mn_1',
                product_id: 'prod_laddu',
                quantity_input: 500,
                pricing_unit: 'PER_KG',
                taxable_paise: 20000,
                cgst_paise: 500,
                sgst_paise: 500,
                gross_paise: 21000,
                stock_deduction_delta: 500000,
                stock_unit: 'MG',
              },
            ],
            payments: [
              {
                id: 'pay_mn_1',
                payment_method: 'UPI',
                allocated_amount_paise: 21000,
                tendered_paise: 21000,
                change_returned_paise: 0,
                net_amount_paise: 21000,
                outcome: 'SUCCESS',
              },
            ],
          }),
          payload_hash: 'hash_idempotent_01',
          created_at: '2026-10-13T11:00:00Z',
        },
      ],
    };

    // First ingestion -> COMMITTED_ACK
    const res1 = server.ingestBatch(batchReq);
    expect(res1.results[0].status).toBe('COMMITTED_ACK');
    expect(res1.results[0].acknowledged).toBe(true);

    // Identical retry -> ALREADY_COMMITTED_IDEMPOTENT_ACK
    const res2 = server.ingestBatch(batchReq);
    expect(res2.results[0].status).toBe('ALREADY_COMMITTED_IDEMPOTENT_ACK');
    expect(res2.results[0].acknowledged).toBe(true);

    // Aggregate query confirms no duplication
    const report = server.getConsolidatedSalesReport('2026-10-13', '2026-10-13');
    expect(report.overall.total_bills).toBe(1);
    expect(report.overall.net_sales_paise).toBe(21000);

    server.close();
  });
});
