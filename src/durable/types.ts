import type {
  FeedObservation,
  Station,
  StationStatus,
  System,
  SystemCapabilities,
  VehicleType,
  Warning,
} from "../contracts";
import type { CatalogSystem } from "../catalog";
import type {
  GbfsFetchFeedName,
  NormalizedGbfsDiscovery,
} from "../gbfs/types";

export type CircuitState = "closed" | "open" | "half_open";
export type ProviderErrorClass =
  | "dns"
  | "connect_timeout"
  | "total_timeout"
  | "tls"
  | "http_4xx"
  | "http_429"
  | "http_5xx"
  | "invalid_content_type"
  | "invalid_json"
  | "schema_validation"
  | "unsupported_version"
  | "response_too_large"
  | "ssrf_blocked"
  | "unknown";

export interface SystemFeedFeedHealth {
  feed_name: FeedObservation["feed_name"];
  present: boolean;
  last_successful_fetch: string | null;
  provider_last_updated: string | null;
  ttl_seconds: number | null;
  validation_status: "valid" | "invalid" | "unsupported" | "unknown";
  last_error_class: ProviderErrorClass | "none";
}

export interface SystemFeedSourceObservation {
  fetched_at: string;
  provider_last_updated: string | null;
  /** Optional for snapshots written before per-feed TTL metadata was added. */
  ttl_seconds?: number | null;
}

export type SystemFeedSourceObservations = Partial<
  Record<GbfsFetchFeedName, SystemFeedSourceObservation>
>;

export interface SystemFeedSnapshot {
  discovery: NormalizedGbfsDiscovery;
  /**
   * Per-feed envelope timestamps used for freshness and attribution. Optional
   * so snapshots written before metadata schema v2 remain readable.
   */
  source_observations?: SystemFeedSourceObservations;
  system: System;
  stations: Station[];
  statuses: StationStatus[];
  vehicleTypes: VehicleType[];
  warnings: Warning[];
}

export interface AvailabilityQuery {
  catalogSystem?: CatalogSystem;
  forceRefresh?: boolean;
  staleWhileRevalidate?: boolean;
  maxStalenessSeconds?: number;
}

export interface SystemFeedAvailabilityResult extends SystemFeedSnapshot {
  fetched_at: string;
  expires_at: string;
  ttl_seconds: number;
  age_seconds: number;
  stale: boolean;
  cache_status: "fresh" | "stale";
  snapshot_slot: "current" | "last_good";
}

export interface SystemFeedStationResult {
  station: Station;
  status?: StationStatus;
  fetched_at: string;
  stale: boolean;
}

export interface SystemFeedHealth {
  system_id: string | null;
  discovery_url: string | null;
  detected_version: string | null;
  /** Current probe-derived flags; absent on health payloads from older Workers. */
  capabilities?: SystemCapabilities;
  ready: boolean;
  state: "uninitialized" | "healthy" | "degraded" | "unavailable";
  circuit_state: CircuitState;
  consecutive_failures: number;
  open_until: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_class: ProviderErrorClass | null;
  snapshot_fetched_at: string | null;
  snapshot_expires_at: string | null;
  /** Age of the station-status source observation, when a snapshot exists. */
  status_source_age_seconds?: number;
  observation_count: number;
  feeds: SystemFeedFeedHealth[];
  rolling_success_rate: number | null;
  rolling_window_seconds: number;
  successes: number;
  failures: number;
}

export interface ProbeOptions {
  idempotencyKey?: string;
}

export interface SystemFeedProbeResult {
  ok: boolean;
  retryable: boolean;
  duplicate: boolean;
  error_class: ProviderErrorClass | null;
  health: SystemFeedHealth;
  /**
   * Small, validated metadata copied from the persisted snapshot. Optional so
   * probe receipts written by earlier Worker versions remain readable.
   */
  discovery_metadata?: SystemFeedProbeDiscoveryMetadata | null;
}

export interface SystemFeedProbeDiscoveryMetadata {
  detected_version: string | null;
  capabilities: SystemCapabilities;
  last_successful_probe: string | null;
}

export interface PersistedSnapshotMetadata {
  schema_version: 1 | 2;
  discovery: NormalizedGbfsDiscovery;
  source_observations?: SystemFeedSourceObservations;
  system: System;
  warnings: Warning[];
}

export interface SnapshotRecord {
  slot: "current" | "last_good";
  snapshot: SystemFeedSnapshot;
  fetchedAtMs: number;
  expiresAtMs: number;
  contentHash: string;
}

export interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  openedUntilMs: number | null;
  lastErrorClass: ProviderErrorClass | null;
  lastErrorAtMs: number | null;
  lastSuccessAtMs: number | null;
  successes: number;
  failures: number;
}

export interface RefreshFailure {
  errorClass: ProviderErrorClass;
  retryable: boolean;
}
