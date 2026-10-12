import { CanonicalSaleAggregate } from '@malgudi/contracts';
import { computeAggregateSha256 } from './aggregate.js';

export interface ServerSyncEvent {
  event_id: string;
  aggregate_type: 'SALE' | 'RETURN';
  aggregate_id: string;
  parent_id?: string; // If dependent on prior sale
  payload_json: string;
  payload_hash: string;
  created_at: string;
}

export interface ServerDatabaseState {
  committedEvents: Map<string, ServerSyncEvent>;
  committedAggregates: Map<string, CanonicalSaleAggregate>;
  outOfOrderBuffer: Map<string, ServerSyncEvent[]>; // parent_id -> buffered child events
}

export type ServerIngestionStatus = 
  | 'COMMITTED_ACK'
  | 'ALREADY_COMMITTED_IDEMPOTENT_ACK'
  | 'BUFFERED_WAITING_PARENT'
  | 'REJECTED_PAYLOAD_MUTATION';

export interface IngestionResult {
  status: ServerIngestionStatus;
  acknowledged: boolean;
  eventId: string;
  aggregateId: string;
  message: string;
}

/**
 * Server-side durable synchronization ingestion engine.
 * Guarantees:
 * 1. Commits durable server state BEFORE acknowledging event.
 * 2. Idempotent acknowledgment for lost-ACK client retries.
 * 3. Rejects and isolates payload mutations (same ID, changed content).
 * 4. Buffers out-of-order child events until parent arrives.
 * 5. Sync acknowledgment NEVER marks an unsettled payment as settled.
 */
export function ingestSyncEvent(
  serverDb: ServerDatabaseState,
  event: ServerSyncEvent,
  aggregate: CanonicalSaleAggregate,
  simulateLostNetworkAck: boolean = false
): IngestionResult {
  // Step 1: Check for existing event or aggregate (Idempotency / Mutation check)
  if (serverDb.committedEvents.has(event.event_id) || serverDb.committedAggregates.has(event.aggregate_id)) {
    const existingEvent = serverDb.committedEvents.get(event.event_id) ?? 
      [...serverDb.committedEvents.values()].find(e => e.aggregate_id === event.aggregate_id);

    if (existingEvent) {
      if (existingEvent.payload_hash === event.payload_hash) {
        // Idempotent client retry (e.g. after lost network ACK or client restart)
        return {
          status: 'ALREADY_COMMITTED_IDEMPOTENT_ACK',
          acknowledged: true,
          eventId: event.event_id,
          aggregateId: event.aggregate_id,
          message: 'Event was already durably committed on server; returning idempotent acknowledgment.',
        };
      } else {
        // Payload mutation detected!
        return {
          status: 'REJECTED_PAYLOAD_MUTATION',
          acknowledged: false,
          eventId: event.event_id,
          aggregateId: event.aggregate_id,
          message: 'Conflict: An event with the same identifier already exists with a different payload hash.',
        };
      }
    }
  }

  // Step 2: Out-of-order dependency check
  if (event.parent_id && !serverDb.committedAggregates.has(event.parent_id)) {
    // Parent does not exist yet; buffer child event
    const buffered = serverDb.outOfOrderBuffer.get(event.parent_id) ?? [];
    buffered.push(event);
    serverDb.outOfOrderBuffer.set(event.parent_id, buffered);

    return {
      status: 'BUFFERED_WAITING_PARENT',
      acknowledged: false,
      eventId: event.event_id,
      aggregateId: event.aggregate_id,
      message: `Parent aggregate ${event.parent_id} has not arrived yet. Child event buffered in memory.`,
    };
  }

  // Step 3: Server commits durable state BEFORE returning acknowledgment
  serverDb.committedEvents.set(event.event_id, event);
  serverDb.committedAggregates.set(event.aggregate_id, aggregate);

  // Step 4: Check if any buffered child events were waiting for this aggregate
  if (serverDb.outOfOrderBuffer.has(event.aggregate_id)) {
    const waitingChildren = serverDb.outOfOrderBuffer.get(event.aggregate_id)!;
    for (const child of waitingChildren) {
      serverDb.committedEvents.set(child.event_id, child);
    }
    serverDb.outOfOrderBuffer.delete(event.aggregate_id);
  }

  // Step 5: Lost Network ACK simulation
  if (simulateLostNetworkAck) {
    // Server committed, but network dropped before client received HTTP 200
    return {
      status: 'COMMITTED_ACK',
      acknowledged: false, // Network failure from client's perspective
      eventId: event.event_id,
      aggregateId: event.aggregate_id,
      message: 'Network timeout: HTTP acknowledgment dropped between server and client.',
    };
  }

  return {
    status: 'COMMITTED_ACK',
    acknowledged: true,
    eventId: event.event_id,
    aggregateId: event.aggregate_id,
    message: 'Event durably committed on server.',
  };
}
