import crypto from 'node:crypto';
import { TerminalLease } from '@malgudi/contracts';

export interface TerminalCapabilities {
  canIssueTaxInvoice: boolean;
  canIssueCustomerEstimate: boolean;
  canReconcileManualBill: boolean;
  canQueryReports: boolean;
  canSyncOutbox: boolean;
}

export interface LeaseValidationContext {
  lease: TerminalLease;
  trustedPublicKeys: Map<string, crypto.KeyObject | string>; // key_id -> Ed25519 public key
  revokedKeyIds?: Set<string>;
  lastKnownTrustedTimeEpochMs: number;
  currentSystemTimeEpochMs: number;
  isOnline: boolean;
}

export type LeaseValidationStatus = 
  | 'VALID'
  | 'CLOCK_ROLLBACK_DETECTED'
  | 'LEASE_EXPIRED'
  | 'LEASE_NOT_YET_VALID'
  | 'INVALID_SIGNATURE'
  | 'REVOKED_SIGNING_KEY'
  | 'UNKNOWN_KEY_ID'
  | 'INVALID_VERSION';

export interface LeaseValidationResult {
  status: LeaseValidationStatus;
  capabilities: TerminalCapabilities;
  errorMessage?: string;
  updatedTrustedTimeEpochMs: number;
}

/**
 * Produces the canonical UTF-8 payload string to be signed or verified with Ed25519.
 */
export function canonicalLeasePayload(lease: Omit<TerminalLease, 'signature_hex'>): string {
  return `v2.9:${lease.terminal_id}:${lease.series_code}:${lease.key_id}:${lease.lease_start_epoch_ms}:${lease.lease_valid_until_epoch_ms}:${lease.max_offline_hours}`;
}

/**
 * Server-only signing utility (Private key stays exclusively on the secure central server).
 */
export function signTerminalLeaseEd25519(
  leaseMetadata: Omit<TerminalLease, 'signature_hex' | 'lease_version'>,
  privateKey: crypto.KeyObject | string
): TerminalLease {
  const lease: Omit<TerminalLease, 'signature_hex'> = {
    lease_version: '2.9',
    ...leaseMetadata,
  };

  const payload = Buffer.from(canonicalLeasePayload(lease), 'utf8');
  const signature = crypto.sign(null, payload, privateKey);

  return {
    ...lease,
    signature_hex: signature.toString('hex'),
  };
}

/**
 * Desktop/Native verification routine (Uses exclusively embedded Ed25519 public keys).
 * Evaluates explicit capabilities rather than blanket lockouts.
 */
export function validateTerminalLease(context: LeaseValidationContext): LeaseValidationResult {
  const { 
    lease, 
    trustedPublicKeys, 
    revokedKeyIds, 
    lastKnownTrustedTimeEpochMs, 
    currentSystemTimeEpochMs, 
    isOnline 
  } = context;

  // Base fallback capabilities: read-only reports, outbox sync, and manual bill reconciliation
  const fallbackCapabilities: TerminalCapabilities = {
    canIssueTaxInvoice: false,
    canIssueCustomerEstimate: true,
    canReconcileManualBill: true,
    canQueryReports: true,
    canSyncOutbox: true,
  };

  // 1. Version Check
  if (lease.lease_version !== '2.9') {
    return {
      status: 'INVALID_VERSION',
      capabilities: fallbackCapabilities,
      errorMessage: `Unsupported lease version '${lease.lease_version}'. Expected '2.9'.`,
      updatedTrustedTimeEpochMs: lastKnownTrustedTimeEpochMs,
    };
  }

  // 2. Revoked Key Check
  if (revokedKeyIds && revokedKeyIds.has(lease.key_id)) {
    return {
      status: 'REVOKED_SIGNING_KEY',
      capabilities: fallbackCapabilities,
      errorMessage: `Signing key '${lease.key_id}' has been revoked by central authority. Lease invalid.`,
      updatedTrustedTimeEpochMs: lastKnownTrustedTimeEpochMs,
    };
  }

  // 3. Trusted Public Key Lookup
  const publicKey = trustedPublicKeys.get(lease.key_id);
  if (!publicKey) {
    return {
      status: 'UNKNOWN_KEY_ID',
      capabilities: fallbackCapabilities,
      errorMessage: `Signing key ID '${lease.key_id}' is not recognized in local trust store. Key rotation required.`,
      updatedTrustedTimeEpochMs: lastKnownTrustedTimeEpochMs,
    };
  }

  // 4. Ed25519 Asymmetric Cryptographic Signature Verification
  try {
    const payload = Buffer.from(canonicalLeasePayload(lease), 'utf8');
    const signature = Buffer.from(lease.signature_hex, 'hex');
    const isValidSig = crypto.verify(null, payload, publicKey, signature);

    if (!isValidSig) {
      return {
        status: 'INVALID_SIGNATURE',
        capabilities: fallbackCapabilities,
        errorMessage: 'Ed25519 signature verification failed. Lease payload was modified or forged.',
        updatedTrustedTimeEpochMs: lastKnownTrustedTimeEpochMs,
      };
    }
  } catch (err: any) {
    return {
      status: 'INVALID_SIGNATURE',
      capabilities: fallbackCapabilities,
      errorMessage: `Cryptographic verification error: ${err.message}`,
      updatedTrustedTimeEpochMs: lastKnownTrustedTimeEpochMs,
    };
  }

  // 5. Monotonic Trusted-Time Rollback Detection
  if (currentSystemTimeEpochMs < lastKnownTrustedTimeEpochMs) {
    return {
      status: 'CLOCK_ROLLBACK_DETECTED',
      capabilities: {
        canIssueTaxInvoice: false,
        canIssueCustomerEstimate: false, // Clock rollback locks automated issuance
        canReconcileManualBill: true,    // Physical paper slips can be entered
        canQueryReports: true,
        canSyncOutbox: true,
      },
      errorMessage: `System clock rollback detected (Current: ${new Date(currentSystemTimeEpochMs).toISOString()}, Last Trusted: ${new Date(lastKnownTrustedTimeEpochMs).toISOString()}). Invoicing locked.`,
      updatedTrustedTimeEpochMs: lastKnownTrustedTimeEpochMs,
    };
  }

  // 6. Premature Lease Start Check
  if (currentSystemTimeEpochMs < lease.lease_start_epoch_ms) {
    return {
      status: 'LEASE_NOT_YET_VALID',
      capabilities: fallbackCapabilities,
      errorMessage: `Lease start time (${new Date(lease.lease_start_epoch_ms).toISOString()}) is in the future.`,
      updatedTrustedTimeEpochMs: currentSystemTimeEpochMs,
    };
  }

  // 7. Lease Expiration Check
  if (currentSystemTimeEpochMs > lease.lease_valid_until_epoch_ms) {
    if (!isOnline) {
      return {
        status: 'LEASE_EXPIRED',
        capabilities: fallbackCapabilities,
        errorMessage: `Terminal lease expired on ${new Date(lease.lease_valid_until_epoch_ms).toISOString()}. Offline GST invoice issuance blocked.`,
        updatedTrustedTimeEpochMs: currentSystemTimeEpochMs,
      };
    }
  }

  // 8. Fully Valid
  return {
    status: 'VALID',
    capabilities: {
      canIssueTaxInvoice: true,
      canIssueCustomerEstimate: true,
      canReconcileManualBill: true,
      canQueryReports: true,
      canSyncOutbox: true,
    },
    updatedTrustedTimeEpochMs: currentSystemTimeEpochMs,
  };
}
