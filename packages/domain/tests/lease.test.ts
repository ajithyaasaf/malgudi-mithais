import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { 
  validateTerminalLease, 
  signTerminalLeaseEd25519, 
  TerminalLease 
} from '../src/lease.js';

describe('Terminal Lease & Ed25519 Asymmetric Signature Validation', () => {
  // Generate mock CA Ed25519 keypair for test
  const { publicKey: caPublicKey, privateKey: caPrivateKey } = crypto.generateKeyPairSync('ed25519');
  
  // Second keypair to simulate old or unknown key
  const { privateKey: roguePrivateKey } = crypto.generateKeyPairSync('ed25519');

  const keyId = 'ca_master_key_2026_q4';
  const trustedPublicKeys = new Map<string, crypto.KeyObject>([
    [keyId, caPublicKey]
  ]);
  const revokedKeyIds = new Set<string>(['ca_compromised_key_2025']);

  const baseLeaseMetadata = {
    terminal_id: 'IB1',
    series_code: 'IB1',
    key_id: keyId,
    lease_start_epoch_ms: 1775800000000,
    lease_valid_until_epoch_ms: 1775900000000,
    max_offline_hours: 48,
  };

  const validLease = signTerminalLeaseEd25519(baseLeaseMetadata, caPrivateKey);

  it('Allows invoice issuance when Ed25519 signature is valid and within lease window', () => {
    const res = validateTerminalLease({
      lease: validLease,
      trustedPublicKeys,
      revokedKeyIds,
      lastKnownTrustedTimeEpochMs: 1775820000000,
      currentSystemTimeEpochMs: 1775830000000,
      isOnline: false,
    });

    expect(res.status).toBe('VALID');
    expect(res.capabilities.canIssueTaxInvoice).toBe(true);
    expect(res.capabilities.canIssueCustomerEstimate).toBe(true);
    expect(res.capabilities.canReconcileManualBill).toBe(true);
    expect(res.capabilities.canQueryReports).toBe(true);
    expect(res.capabilities.canSyncOutbox).toBe(true);
    expect(res.updatedTrustedTimeEpochMs).toBe(1775830000000);
  });

  it('Rejects lease with forged or invalid Ed25519 signature bytes', () => {
    const forgedLease: TerminalLease = {
      ...validLease,
      signature_hex: 'deadbeef'.repeat(16), // 64 bytes invalid hex
    };

    const res = validateTerminalLease({
      lease: forgedLease,
      trustedPublicKeys,
      revokedKeyIds,
      lastKnownTrustedTimeEpochMs: 1775820000000,
      currentSystemTimeEpochMs: 1775830000000,
      isOnline: false,
    });

    expect(res.status).toBe('INVALID_SIGNATURE');
    expect(res.capabilities.canIssueTaxInvoice).toBe(false);
    expect(res.capabilities.canIssueCustomerEstimate).toBe(true);
    expect(res.capabilities.canReconcileManualBill).toBe(true);
    expect(res.errorMessage).toContain('signature verification failed');
  });

  it('Rejects lease signed by rogue or unknown private key', () => {
    const rogueLease = signTerminalLeaseEd25519(baseLeaseMetadata, roguePrivateKey);

    const res = validateTerminalLease({
      lease: rogueLease,
      trustedPublicKeys,
      revokedKeyIds,
      lastKnownTrustedTimeEpochMs: 1775820000000,
      currentSystemTimeEpochMs: 1775830000000,
      isOnline: false,
    });

    expect(res.status).toBe('INVALID_SIGNATURE');
    expect(res.capabilities.canIssueTaxInvoice).toBe(false);
    expect(res.capabilities.canIssueCustomerEstimate).toBe(true);
  });

  it('Rejects lease when terminal_id or series_code is modified after signing', () => {
    const tamperedLease: TerminalLease = {
      ...validLease,
      terminal_id: 'IB2_UNAUTHORIZED', // Tampered terminal ID!
    };

    const res = validateTerminalLease({
      lease: tamperedLease,
      trustedPublicKeys,
      revokedKeyIds,
      lastKnownTrustedTimeEpochMs: 1775820000000,
      currentSystemTimeEpochMs: 1775830000000,
      isOnline: false,
    });

    expect(res.status).toBe('INVALID_SIGNATURE');
    expect(res.capabilities.canIssueTaxInvoice).toBe(false);
  });

  it('Rejects lease signed by revoked key', () => {
    const revokedKeyMetadata = {
      ...baseLeaseMetadata,
      key_id: 'ca_compromised_key_2025',
    };
    const revokedLease = signTerminalLeaseEd25519(revokedKeyMetadata, caPrivateKey);

    const res = validateTerminalLease({
      lease: revokedLease,
      trustedPublicKeys,
      revokedKeyIds,
      lastKnownTrustedTimeEpochMs: 1775820000000,
      currentSystemTimeEpochMs: 1775830000000,
      isOnline: false,
    });

    expect(res.status).toBe('REVOKED_SIGNING_KEY');
    expect(res.capabilities.canIssueTaxInvoice).toBe(false);
    expect(res.errorMessage).toContain('revoked');
  });

  it('Rejects lease signed by unrecognized key ID (Key Rotation required)', () => {
    const futureKeyMetadata = {
      ...baseLeaseMetadata,
      key_id: 'ca_key_future_2027',
    };
    const futureLease = signTerminalLeaseEd25519(futureKeyMetadata, caPrivateKey);

    const res = validateTerminalLease({
      lease: futureLease,
      trustedPublicKeys,
      revokedKeyIds,
      lastKnownTrustedTimeEpochMs: 1775820000000,
      currentSystemTimeEpochMs: 1775830000000,
      isOnline: false,
    });

    expect(res.status).toBe('UNKNOWN_KEY_ID');
    expect(res.capabilities.canIssueTaxInvoice).toBe(false);
    expect(res.errorMessage).toContain('not recognized');
  });

  it('Blocks tax and automated invoices when clock rollback is detected', () => {
    const res = validateTerminalLease({
      lease: validLease,
      trustedPublicKeys,
      revokedKeyIds,
      lastKnownTrustedTimeEpochMs: 1775850000000,
      currentSystemTimeEpochMs: 1775820000000, // Clock went backwards 30,000s!
      isOnline: false,
    });

    expect(res.status).toBe('CLOCK_ROLLBACK_DETECTED');
    expect(res.capabilities.canIssueTaxInvoice).toBe(false);
    expect(res.capabilities.canIssueCustomerEstimate).toBe(false);
    expect(res.capabilities.canReconcileManualBill).toBe(true); // Paper slip retroactive entry allowed
    expect(res.errorMessage).toContain('rollback detected');
  });

  it('Blocks offline tax invoice issuance when lease has expired and permits estimate/manual fallback', () => {
    const res = validateTerminalLease({
      lease: validLease,
      trustedPublicKeys,
      revokedKeyIds,
      lastKnownTrustedTimeEpochMs: 1775890000000,
      currentSystemTimeEpochMs: 1775910000000, // Beyond lease_valid_until
      isOnline: false,
    });

    expect(res.status).toBe('LEASE_EXPIRED');
    expect(res.capabilities.canIssueTaxInvoice).toBe(false);
    expect(res.capabilities.canIssueCustomerEstimate).toBe(true);
    expect(res.capabilities.canReconcileManualBill).toBe(true);
    expect(res.errorMessage).toContain('lease expired');
  });
});
