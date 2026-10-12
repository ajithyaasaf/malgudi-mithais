import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DurableSyncServer,
  createSyncHttpServer,
  BatchSyncRequest,
} from '../src/index.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

describe('Multi-Branch Synchronization & Consolidated Central Reporting', () => {
  let serverInstance: DurableSyncServer;
  let httpServer: http.Server;
  let baseUrl: string;
  const testDbFile = path.join(process.cwd(), 'test_multi_branch_sync.db');

  const startHttpServer = async (server: DurableSyncServer): Promise<void> => {
    return new Promise((resolve) => {
      httpServer = createSyncHttpServer(server);
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  };

  const stopHttpServer = async (): Promise<void> => {
    return new Promise((resolve) => {
      if (httpServer) {
        httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  };

  beforeEach(async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(testDbFile + suffix)) {
        try { fs.unlinkSync(testDbFile + suffix); } catch {}
      }
    }
    serverInstance = new DurableSyncServer(testDbFile);
    await startHttpServer(serverInstance);
  });

  afterEach(async () => {
    await stopHttpServer();
    serverInstance.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(testDbFile + suffix)) {
        try { fs.unlinkSync(testDbFile + suffix); } catch {}
      }
    }
  });

  it('1. Independent batch ingestion from Branch IB and Branch MN', async () => {
    // Branch IB batch
    const branchIbBatch: BatchSyncRequest = {
      branch_id: 'IB',
      terminal_id: 'T1',
      events: [
        {
          event_id: 'evt_ib_sale_1',
          aggregate_type: 'SALE',
          aggregate_id: 'sale_ib_1',
          payload_json: JSON.stringify({
            sale_id: 'sale_ib_1',
            invoice_number: 'IB1/2627/000001',
            terminal_id: 'T1',
            counter_id: 'C1',
            session_id: 'sess_ib_1',
            business_date: '2026-10-12',
            subtotal_taxable_paise: 10000,
            total_cgst_paise: 250,
            total_sgst_paise: 250,
            total_igst_paise: 0,
            round_off_paise: 0,
            net_payable_paise: 10500,
            items: [
              {
                id: 'item_ib_1',
                product_id: 'prod_laddu',
                quantity_input: 500,
                pricing_unit: 'PER_KG',
                taxable_paise: 10000,
                cgst_paise: 250,
                sgst_paise: 250,
                gross_paise: 10500,
                stock_deduction_delta: 500000,
                stock_unit: 'MG',
              },
            ],
            payments: [
              {
                id: 'pay_ib_1',
                payment_method: 'CASH',
                allocated_amount_paise: 10500,
                tendered_paise: 11000,
                change_returned_paise: 500,
                net_amount_paise: 10500,
                outcome: 'SUCCESS',
              },
            ],
          }),
          payload_hash: 'hash_ib_sale_1',
          created_at: '2026-10-12T10:00:00Z',
        },
      ],
    };

    // Branch MN batch
    const branchMnBatch: BatchSyncRequest = {
      branch_id: 'MN',
      terminal_id: 'T2',
      events: [
        {
          event_id: 'evt_mn_sale_1',
          aggregate_type: 'SALE',
          aggregate_id: 'sale_mn_1',
          payload_json: JSON.stringify({
            sale_id: 'sale_mn_1',
            invoice_number: 'MN1/2627/000001',
            terminal_id: 'T2',
            counter_id: 'C1',
            session_id: 'sess_mn_1',
            business_date: '2026-10-12',
            subtotal_taxable_paise: 20000,
            total_cgst_paise: 500,
            total_sgst_paise: 500,
            total_igst_paise: 0,
            round_off_paise: 0,
            net_payable_paise: 21000,
            items: [
              {
                id: 'item_mn_1',
                product_id: 'prod_halwa',
                quantity_input: 1000,
                pricing_unit: 'PER_KG',
                taxable_paise: 20000,
                cgst_paise: 500,
                sgst_paise: 500,
                gross_paise: 21000,
                stock_deduction_delta: 1000000,
                stock_unit: 'MG',
              },
            ],
            payments: [
              {
                id: 'pay_mn_1',
                payment_method: 'UPI',
                allocated_amount_paise: 21000,
                net_amount_paise: 21000,
                outcome: 'SUCCESS',
              },
            ],
          }),
          payload_hash: 'hash_mn_sale_1',
          created_at: '2026-10-12T11:00:00Z',
        },
      ],
    };

    // Sync IB
    const resIb = await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'IB',
      },
      body: JSON.stringify(branchIbBatch),
    });
    expect(resIb.status).toBe(200);
    const dataIb = await resIb.json() as any;
    expect(dataIb.results[0].status).toBe('COMMITTED_ACK');
    expect(dataIb.results[0].acknowledged).toBe(true);

    // Sync MN
    const resMn = await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
        'X-Terminal-Id': 'T2',
        'X-Branch-Id': 'MN',
      },
      body: JSON.stringify(branchMnBatch),
    });
    expect(resMn.status).toBe(200);
    const dataMn = await resMn.json() as any;
    expect(dataMn.results[0].status).toBe('COMMITTED_ACK');
    expect(dataMn.results[0].acknowledged).toBe(true);

    // Check branch-filtered sync status
    const statusIbRes = await fetch(`${baseUrl}/api/v1/sync/status?branch_id=IB`, {
      headers: {
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'IB',
      },
    });
    const statusIb = await statusIbRes.json() as any;
    expect(statusIb.totalEvents).toBe(1);
    expect(statusIb.totalSales).toBe(1);

    const statusMnRes = await fetch(`${baseUrl}/api/v1/sync/status?branch_id=MN`, {
      headers: {
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
        'X-Terminal-Id': 'T2',
        'X-Branch-Id': 'MN',
      },
    });
    const statusMn = await statusMnRes.json() as any;
    expect(statusMn.totalEvents).toBe(1);
    expect(statusMn.totalSales).toBe(1);
  });

  it('2. Idempotent re-submission of batches returns ALREADY_COMMITTED_IDEMPOTENT_ACK without duplicates', async () => {
    const batch: BatchSyncRequest = {
      branch_id: 'IB',
      terminal_id: 'T1',
      events: [
        {
          event_id: 'evt_ib_sale_repeat',
          aggregate_type: 'SALE',
          aggregate_id: 'sale_ib_repeat',
          payload_json: JSON.stringify({
            sale_id: 'sale_ib_repeat',
            invoice_number: 'IB1/2627/000002',
            subtotal_taxable_paise: 5000,
            net_payable_paise: 5250,
          }),
          payload_hash: 'hash_repeat_123',
          created_at: '2026-10-12T12:00:00Z',
        },
      ],
    };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer malgudi_sync_secret_token_2026',
      'X-Terminal-Id': 'T1',
      'X-Branch-Id': 'IB',
    };

    // First attempt -> COMMITTED_ACK
    const res1 = await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
    });
    const data1 = await res1.json() as any;
    expect(data1.results[0].status).toBe('COMMITTED_ACK');

    // Second attempt -> ALREADY_COMMITTED_IDEMPOTENT_ACK
    const res2 = await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
    });
    const data2 = await res2.json() as any;
    expect(data2.results[0].status).toBe('ALREADY_COMMITTED_IDEMPOTENT_ACK');
    expect(data2.results[0].acknowledged).toBe(true);

    // Verify database only has 1 record
    const statusRes = await fetch(`${baseUrl}/api/v1/sync/status?branch_id=IB`, { headers });
    const status = await statusRes.json() as any;
    expect(status.totalEvents).toBe(1);
    expect(status.totalSales).toBe(1);
  });

  it('3. Conflict rejection when event ID is submitted with modified payload hash', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer malgudi_sync_secret_token_2026',
      'X-Terminal-Id': 'T1',
      'X-Branch-Id': 'IB',
    };

    // First submission
    await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        branch_id: 'IB',
        terminal_id: 'T1',
        events: [
          {
            event_id: 'evt_conflict_test',
            aggregate_type: 'SALE',
            aggregate_id: 'sale_conflict_test',
            payload_json: JSON.stringify({ sale_id: 'sale_conflict_test', net_payable_paise: 1000 }),
            payload_hash: 'hash_original_abc',
            created_at: '2026-10-12T12:00:00Z',
          },
        ],
      }),
    });

    // Conflicting submission with different hash
    const resConflict = await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        branch_id: 'IB',
        terminal_id: 'T1',
        events: [
          {
            event_id: 'evt_conflict_test',
            aggregate_type: 'SALE',
            aggregate_id: 'sale_conflict_test',
            payload_json: JSON.stringify({ sale_id: 'sale_conflict_test', net_payable_paise: 9999 }),
            payload_hash: 'hash_modified_tampered',
            created_at: '2026-10-12T12:00:00Z',
          },
        ],
      }),
    });
    const dataConflict = await resConflict.json() as any;
    expect(dataConflict.results[0].status).toBe('REJECTED_PAYLOAD_MUTATION');
    expect(dataConflict.results[0].acknowledged).toBe(false);
  });

  it('4. Consolidated sales and branch comparison reports combine both branches accurately', async () => {
    // Ingest 2 sales from IB (total: 10500 + 5250 = 15750)
    await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'IB',
      },
      body: JSON.stringify({
        branch_id: 'IB',
        terminal_id: 'T1',
        events: [
          {
            event_id: 'evt_ib_1',
            aggregate_type: 'SALE',
            aggregate_id: 'sale_ib_1',
            payload_json: JSON.stringify({
              sale_id: 'sale_ib_1',
              invoice_number: 'IB1/2627/000010',
              business_date: '2026-10-12',
              subtotal_taxable_paise: 10000,
              total_cgst_paise: 250,
              total_sgst_paise: 250,
              net_payable_paise: 10500,
            }),
            payload_hash: 'hash_ib_1',
            created_at: '2026-10-12T10:00:00Z',
          },
          {
            event_id: 'evt_ib_2',
            aggregate_type: 'SALE',
            aggregate_id: 'sale_ib_2',
            payload_json: JSON.stringify({
              sale_id: 'sale_ib_2',
              invoice_number: 'IB1/2627/000011',
              business_date: '2026-10-12',
              subtotal_taxable_paise: 5000,
              total_cgst_paise: 125,
              total_sgst_paise: 125,
              net_payable_paise: 5250,
            }),
            payload_hash: 'hash_ib_2',
            created_at: '2026-10-12T10:30:00Z',
          },
        ],
      }),
    });

    // Ingest 1 sale from MN (total: 21000)
    await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
        'X-Terminal-Id': 'T2',
        'X-Branch-Id': 'MN',
      },
      body: JSON.stringify({
        branch_id: 'MN',
        terminal_id: 'T2',
        events: [
          {
            event_id: 'evt_mn_1',
            aggregate_type: 'SALE',
            aggregate_id: 'sale_mn_1',
            payload_json: JSON.stringify({
              sale_id: 'sale_mn_1',
              invoice_number: 'MN1/2627/000010',
              business_date: '2026-10-12',
              subtotal_taxable_paise: 20000,
              total_cgst_paise: 500,
              total_sgst_paise: 500,
              net_payable_paise: 21000,
            }),
            payload_hash: 'hash_mn_1',
            created_at: '2026-10-12T11:00:00Z',
          },
        ],
      }),
    });

    // Query Consolidated Sales Report
    const salesReportRes = await fetch(`${baseUrl}/api/v1/reports/consolidated-sales`, {
      headers: {
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
      },
    });
    expect(salesReportRes.status).toBe(200);
    const salesReport = await salesReportRes.json() as any;

    expect(salesReport.overall.total_bills).toBe(3);
    expect(salesReport.overall.taxable_sales_paise).toBe(35000);
    expect(salesReport.overall.total_cgst_paise).toBe(875);
    expect(salesReport.overall.total_sgst_paise).toBe(875);
    expect(salesReport.overall.net_sales_paise).toBe(36750);

    // Verify per-branch breakdown in consolidated report
    expect(salesReport.by_branch).toHaveLength(2);
    const ibSummary = salesReport.by_branch.find((b: any) => b.branch_id === 'IB');
    const mnSummary = salesReport.by_branch.find((b: any) => b.branch_id === 'MN');

    expect(ibSummary.total_bills).toBe(2);
    expect(ibSummary.net_sales_paise).toBe(15750);

    expect(mnSummary.total_bills).toBe(1);
    expect(mnSummary.net_sales_paise).toBe(21000);

    // Query Branch Comparison Report
    const compReportRes = await fetch(`${baseUrl}/api/v1/reports/branch-comparison`, {
      headers: {
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
      },
    });
    expect(compReportRes.status).toBe(200);
    const compReport = await compReportRes.json() as any;

    expect(compReport.branches).toHaveLength(2);
    const ibComp = compReport.branches.find((b: any) => b.branch_id === 'IB');
    const mnComp = compReport.branches.find((b: any) => b.branch_id === 'MN');

    expect(ibComp.bill_count).toBe(2);
    expect(ibComp.revenue_paise).toBe(15750);
    expect(ibComp.avg_bill_paise).toBe(7875); // 15750 / 2

    expect(mnComp.bill_count).toBe(1);
    expect(mnComp.revenue_paise).toBe(21000);
    expect(mnComp.avg_bill_paise).toBe(21000);
  });

  it('5. Stock movement and Return/Void sync across branches', async () => {
    // 1. Ingest initial sale at IB
    await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'IB',
      },
      body: JSON.stringify({
        branch_id: 'IB',
        terminal_id: 'T1',
        events: [
          {
            event_id: 'evt_sale_void_test',
            aggregate_type: 'SALE',
            aggregate_id: 'sale_void_test',
            payload_json: JSON.stringify({
              sale_id: 'sale_void_test',
              invoice_number: 'IB1/2627/000099',
              business_date: '2026-10-12',
              net_payable_paise: 10000,
            }),
            payload_hash: 'hash_sale_99',
            created_at: '2026-10-12T10:00:00Z',
          },
          {
            event_id: 'evt_stock_adj_ib',
            aggregate_type: 'STOCK_MOVEMENT',
            aggregate_id: 'sm_ib_001',
            payload_json: JSON.stringify({
              id: 'sm_ib_001',
              product_id: 'prod_mysore_pak',
              movement_type: 'OPENING',
              quantity_delta: 5000000,
              unit: 'MG',
              reference_id: 'ref_init_stock',
              reason: 'Opening stock count',
            }),
            payload_hash: 'hash_sm_001',
            created_at: '2026-10-12T09:00:00Z',
          },
        ],
      }),
    });

    // Check consolidated inventory has Mysore Pak
    const invRes1 = await fetch(`${baseUrl}/api/v1/reports/consolidated-inventory`, {
      headers: { 'Authorization': 'Bearer malgudi_sync_secret_token_2026' },
    });
    const inv1 = await invRes1.json() as any;
    expect(inv1.inventory.length).toBeGreaterThan(0);
    const pakStock = inv1.inventory.find((i: any) => i.product_id === 'prod_mysore_pak');
    expect(pakStock.net_quantity_delta).toBe(5000000);

    // 2. Ingest RETURN event to void the sale
    const returnBatchRes = await fetch(`${baseUrl}/api/v1/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer malgudi_sync_secret_token_2026',
        'X-Terminal-Id': 'T1',
        'X-Branch-Id': 'IB',
      },
      body: JSON.stringify({
        branch_id: 'IB',
        terminal_id: 'T1',
        events: [
          {
            event_id: 'evt_return_99',
            aggregate_type: 'RETURN',
            aggregate_id: 'sale_void_test',
            payload_json: JSON.stringify({
              sale_id: 'sale_void_test',
              reason: 'Customer cancelled transaction',
            }),
            payload_hash: 'hash_return_99',
            created_at: '2026-10-12T10:05:00Z',
          },
        ],
      }),
    });
    const returnBatchData = await returnBatchRes.json() as any;
    expect(returnBatchData.results[0].status).toBe('COMMITTED_ACK');

    // 3. Check that consolidated sales report now reflects voided bill
    const salesReportRes = await fetch(`${baseUrl}/api/v1/reports/consolidated-sales`, {
      headers: { 'Authorization': 'Bearer malgudi_sync_secret_token_2026' },
    });
    const salesReport = await salesReportRes.json() as any;
    expect(salesReport.overall.total_bills).toBe(1);
    expect(salesReport.overall.active_bills).toBe(0);
    expect(salesReport.overall.voided_bills).toBe(1);
    expect(salesReport.overall.net_sales_paise).toBe(0);
    expect(salesReport.overall.voided_amount_paise).toBe(10000);
  });
});
