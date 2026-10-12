import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DurableSyncServer, createSyncHttpServer } from '../src/index';

const API_KEY = 'malgudi_sync_secret_token_2026';

describe('Central Product & Price Updates & Catalog Synchronization API', () => {
  let tmpDir: string;
  let dbPath: string;
  let syncServer: DurableSyncServer;
  let httpServer: http.Server;
  let baseUrl: string;
  let port: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'malgudi-catalog-test-'));
    dbPath = path.join(tmpDir, 'catalog_sync_test.db');
    syncServer = new DurableSyncServer(dbPath);
    httpServer = createSyncHttpServer(syncServer, { apiKey: API_KEY });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address() as any;
        port = address.port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    syncServer.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  async function request(
    method: string,
    route: string,
    body?: any,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const u = new URL(route, baseUrl);
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };

      const req = http.request(
        u,
        {
          method,
          headers: reqHeaders,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
            resolve({ status: res.statusCode || 500, body: parsed });
          });
        }
      );

      req.on('error', reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  it('1. Security Boundary: enforces Bearer auth and Branch Authorization', async () => {
    // Missing Bearer token
    const resNoAuth = await request('GET', '/api/v1/catalog/updates');
    expect(resNoAuth.status).toBe(401);
    expect(resNoAuth.body.error).toBe('UNAUTHORIZED_ACCESS');

    // Bearer token present, but missing terminal headers
    const resNoHeaders = await request('GET', '/api/v1/catalog/updates', undefined, {
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(resNoHeaders.status).toBe(401);
    expect(resNoHeaders.body.error).toBe('UNAUTHORIZED_TERMINAL_ACCESS');

    // Unauthorized / invalid branch ID
    const resInvalidBranch = await request('GET', '/api/v1/catalog/updates', undefined, {
      Authorization: `Bearer ${API_KEY}`,
      'X-Terminal-Id': 'T1',
      'X-Branch-Id': 'UNAUTHORIZED_BRANCH',
    });
    expect(resInvalidBranch.status).toBe(403);
    expect(resInvalidBranch.body.error).toBe('FORBIDDEN_BRANCH');

    // Authorized branch (IB)
    const resValid = await request('GET', '/api/v1/catalog/updates', undefined, {
      Authorization: `Bearer ${API_KEY}`,
      'X-Terminal-Id': 'T1',
      'X-Branch-Id': 'IB',
    });
    expect(resValid.status).toBe(200);
    expect(Array.isArray(resValid.body.products)).toBe(true);
    expect(resValid.body.products.length).toBeGreaterThan(0);

    // Sync batch with forbidden branch
    const resBatchForbidden = await request('POST', '/api/v1/sync/batch', { events: [] }, {
      Authorization: `Bearer ${API_KEY}`,
      'X-Terminal-Id': 'T1',
      'X-Branch-Id': 'UNKNOWN_BRANCH',
    });
    expect(resBatchForbidden.status).toBe(403);
    expect(resBatchForbidden.body.error).toBe('FORBIDDEN_BRANCH');

    // Sync batch with header/payload branch mismatch
    const resBatchMismatch = await request('POST', '/api/v1/sync/batch', { branch_id: 'MN', events: [] }, {
      Authorization: `Bearer ${API_KEY}`,
      'X-Terminal-Id': 'T1',
      'X-Branch-Id': 'IB',
    });
    expect(resBatchMismatch.status).toBe(403);
    expect(resBatchMismatch.body.error).toBe('BRANCH_IDENTITY_MISMATCH');
  });

  it('2. Central Product Publishing: creation, price change, GST change, deactivation', async () => {
    // 2a. Create new product
    const createPayload = {
      name: 'Pistachio Burfi Special',
      tamil_name: 'பிஸ்தா பர்ஃபி',
      sku: 'SW-PB-099',
      category_id: 'cat_sweets',
      pricing_unit: 'PER_KG',
      inventory_unit: 'MG',
      base_price_paise: 82000, // Rs. 820 / kg
      tax_rate_bps: 500,
      hsn_code: '21069099',
      is_active: true,
      target_branch_ids: '*',
    };

    const resCreate = await request('POST', '/api/v1/catalog/publish', createPayload, {
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(resCreate.status).toBe(200);
    expect(resCreate.body.success).toBe(true);
    expect(resCreate.body.action).toBe('CREATED');
    expect(resCreate.body.version).toBe(2);
    expect(resCreate.body.product.sku).toBe('SW-PB-099');

    // 2b. Price change & GST rate update
    const updatePayload = {
      sku: 'SW-PB-099',
      name: 'Pistachio Burfi Special Premium',
      base_price_paise: 85000, // Price revised to Rs. 850 / kg
      tax_rate_bps: 1200, // GST changed to 12%
      hsn_code: '21069099',
      target_branch_ids: '*',
    };

    const resUpdate = await request('POST', '/api/v1/catalog/publish', updatePayload, {
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(resUpdate.status).toBe(200);
    expect(resUpdate.body.success).toBe(true);
    expect(resUpdate.body.action).toBe('UPDATED');
    expect(resUpdate.body.version).toBe(3);
    expect(resUpdate.body.product.base_price_paise).toBe(85000);
    expect(resUpdate.body.product.tax_rate_bps).toBe(1200);

    // 2c. Deactivation
    const deactPayload = {
      sku: 'SW-PB-099',
      name: 'Pistachio Burfi Special Premium',
      base_price_paise: 85000,
      is_active: false,
    };
    const resDeact = await request('POST', '/api/v1/catalog/publish', deactPayload, {
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(resDeact.status).toBe(200);
    expect(resDeact.body.version).toBe(4);
    expect(resDeact.body.product.is_active).toBe(false);
  });

  it('3. Inbound Catalog Sync: since_version filtering and branch targeting', async () => {
    // Publish a product targeted only to branch 'IB'
    await request(
      'POST',
      '/api/v1/catalog/publish',
      {
        name: 'Town Hall Special Halwa',
        sku: 'TH-SPEC-001',
        base_price_paise: 50000,
        target_branch_ids: 'IB',
      },
      { Authorization: `Bearer ${API_KEY}` }
    );

    // Publish a product targeted only to branch 'MN'
    await request(
      'POST',
      '/api/v1/catalog/publish',
      {
        name: 'Mattuthavani Travellers Pack',
        sku: 'MN-PACK-002',
        base_price_paise: 30000,
        target_branch_ids: 'MN',
      },
      { Authorization: `Bearer ${API_KEY}` }
    );

    // Query updates for branch IB
    const resIB = await request('GET', '/api/v1/catalog/updates?since_version=1', undefined, {
      Authorization: `Bearer ${API_KEY}`,
      'X-Terminal-Id': 'T1',
      'X-Branch-Id': 'IB',
    });
    expect(resIB.status).toBe(200);
    const ibSkus = resIB.body.products.map((p: any) => p.sku);
    expect(ibSkus).toContain('TH-SPEC-001');
    expect(ibSkus).not.toContain('MN-PACK-002');

    // Query updates for branch MN
    const resMN = await request('GET', '/api/v1/catalog/updates?since_version=1', undefined, {
      Authorization: `Bearer ${API_KEY}`,
      'X-Terminal-Id': 'T1',
      'X-Branch-Id': 'MN',
    });
    expect(resMN.status).toBe(200);
    const mnSkus = resMN.body.products.map((p: any) => p.sku);
    expect(mnSkus).toContain('MN-PACK-002');
    expect(mnSkus).not.toContain('TH-SPEC-001');

    // Check incremental versioning: querying with high since_version returns empty list
    const resFuture = await request(
      `GET`,
      `/api/v1/catalog/updates?since_version=999999`,
      undefined,
      {
        Authorization: `Bearer ${API_KEY}`,
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'IB',
      }
    );
    expect(resFuture.status).toBe(200);
    expect(resFuture.body.products.length).toBe(0);
  });
});
