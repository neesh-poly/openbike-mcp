import { type VehicleType, type Warning } from "../contracts";
import { DomainError } from "../contracts/errors";
import { toDomainError as outboundToDomainError } from "../security/errors";
import { GbfsFeedError, withGbfsFeedError } from "./errors";
import { FeedTransport } from "./transport";
import {
  GbfsNormalizationError, normalizeDiscovery, normalizeStations,
  normalizeStationStatuses, normalizeSystemInformation, normalizeVehicleTypes,
} from "./normalize";
import type {
  GbfsClientOptions, GbfsDataFeedName, GbfsFetchState,
  GbfsNormalizationContext, GbfsStationBundle, GbfsSystemSource,
} from "./types";
import type { LoadedDocument } from "./transport";
export { GbfsFeedError, getGbfsFailureFeedName } from "./errors";

const requiredFeedUrl = (
  feeds: Partial<Record<GbfsDataFeedName, string>>,
  feedName: GbfsDataFeedName,
): string => {
  const url = feeds[feedName];
  if (url === undefined) {
    throw new GbfsNormalizationError(
      "MISSING_REQUIRED_FEED",
      `The GBFS discovery document did not advertise ${feedName}.`,
    );
  }
  return url;
};

const unavailableVehicleTypesWarning = (systemId: string): Warning => ({
  code: "PROVIDER_UNAVAILABLE",
  message:
    "Vehicle-type metadata was unavailable; aggregate station availability remains usable.",
  system_id: systemId,
  retryable: true,
});

export const toGbfsDomainError = (error: unknown): DomainError => {
  if (error instanceof GbfsFeedError) {
    return toGbfsDomainError(error.cause);
  }
  if (!(error instanceof GbfsNormalizationError)) {
    return outboundToDomainError(error);
  }
  return new DomainError(
    "UNSUPPORTED_FEED",
    error.message,
    error.retryable,
  );
};

export class GbfsClient {
  readonly source: GbfsSystemSource;
  private readonly transport: FeedTransport;

  constructor(source: GbfsSystemSource, options: GbfsClientOptions = {}) {
    this.transport = new FeedTransport(source, options);
    this.source = this.transport.source;
  }

  async fetchStationBundle(
    previousState: GbfsFetchState = {},
  ): Promise<GbfsStationBundle> {
    const discoveryDocument = await this.transport.loadDocument(
      "gbfs",
      this.source.discoveryUrl,
      previousState.gbfs,
    );
    const discoveryResult = await withGbfsFeedError("gbfs", () =>
      normalizeDiscovery(discoveryDocument.document, {
        systemId: this.source.systemId,
        ...(this.source.preferredLanguages === undefined
          ? {}
          : { preferredLanguages: this.source.preferredLanguages }),
      }),
    );
    const discovery = discoveryResult.value;

    const systemInformationUrl = await withGbfsFeedError(
      "system_information",
      () => requiredFeedUrl(discovery.feeds, "system_information"),
    );
    const stationInformationUrl = await withGbfsFeedError(
      "station_information",
      () => requiredFeedUrl(discovery.feeds, "station_information"),
    );
    const stationStatusUrl = await withGbfsFeedError("station_status", () =>
      requiredFeedUrl(discovery.feeds, "station_status"),
    );
    const vehicleTypesUrl = discovery.feeds.vehicle_types;

    const [systemDocument, stationDocument, statusDocument, vehicleDocumentResult] =
      await Promise.all([
        this.transport.loadDocument(
          "system_information",
          systemInformationUrl,
          previousState.system_information,
        ),
        this.transport.loadDocument(
          "station_information",
          stationInformationUrl,
          previousState.station_information,
        ),
        this.transport.loadDocument(
          "station_status",
          stationStatusUrl,
          previousState.station_status,
        ),
        vehicleTypesUrl === undefined
          ? Promise.resolve(undefined)
          : this.transport.loadDocument(
              "vehicle_types",
              vehicleTypesUrl,
              previousState.vehicle_types,
            ).catch(() => undefined),
      ]);

    const baseContext: GbfsNormalizationContext = {
      systemId: this.source.systemId,
      ...(this.source.name === undefined ? {} : { name: this.source.name }),
      discoveryUrl: this.source.discoveryUrl,
      detectedVersion: discovery.version,
      fetchedAt: statusDocument.observation.fetched_at,
      languages: discovery.languages,
      ...(this.source.preferredLanguages === undefined
        ? {}
        : { preferredLanguages: this.source.preferredLanguages }),
      ...(this.source.city === undefined ? {} : { city: this.source.city }),
      ...(this.source.region === undefined ? {} : { region: this.source.region }),
      ...(this.source.countryCode === undefined
        ? {}
        : { countryCode: this.source.countryCode }),
      ...(this.source.licenseOverride === undefined
        ? {}
        : { licenseOverride: this.source.licenseOverride }),
    };

    let vehicleTypes: VehicleType[] = [];
    const vehicleWarnings: Warning[] = [];
    let vehicleDocument: LoadedDocument | undefined;
    if (vehicleTypesUrl !== undefined) {
      if (vehicleDocumentResult === undefined) {
        vehicleWarnings.push(
          unavailableVehicleTypesWarning(this.source.systemId),
        );
      } else {
        try {
          const normalized = normalizeVehicleTypes(
            vehicleDocumentResult.document,
            baseContext,
          );
          vehicleTypes = normalized.value;
          vehicleWarnings.push(...normalized.warnings);
          vehicleDocument = vehicleDocumentResult;
        } catch {
          vehicleWarnings.push(
            unavailableVehicleTypesWarning(this.source.systemId),
          );
        }
      }
    }

    const statusResult = await withGbfsFeedError("station_status", () =>
      normalizeStationStatuses(statusDocument.document, { ...baseContext, vehicleTypes }),
    );
    const capabilities = {
      docked: discovery.feeds.station_information !== undefined,
      dockless:
        discovery.feeds.free_bike_status !== undefined ||
        discovery.feeds.vehicle_status !== undefined,
      ebike: vehicleTypes.some(
        (type) => type.category === "ebike" || type.category === "cargo_bike",
      ) || statusResult.value.some(status => status.availability.vehicle_type_counts.ebike !== undefined),
      station_status: discovery.feeds.station_status !== undefined,
    };
    const fullContext: GbfsNormalizationContext = {
      ...baseContext,
      capabilities,
      vehicleTypes,
    };
    const systemResult = await withGbfsFeedError("system_information", () =>
      normalizeSystemInformation(systemDocument.document, fullContext),
    );
    const stationResult = await withGbfsFeedError("station_information", () =>
      normalizeStations(stationDocument.document, fullContext),
    );

    const observations = [
      discoveryDocument.observation,
      systemDocument.observation,
      stationDocument.observation,
      statusDocument.observation,
      ...(vehicleDocument === undefined ? [] : [vehicleDocument.observation]),
    ];
    const state: GbfsFetchState = {
      gbfs: discoveryDocument.cached,
      system_information: systemDocument.cached,
      station_information: stationDocument.cached,
      station_status: statusDocument.cached,
      ...(vehicleDocument === undefined
        ? {}
        : { vehicle_types: vehicleDocument.cached }),
    };

    return {
      discovery,
      system: systemResult.value,
      stations: stationResult.value,
      statuses: statusResult.value,
      vehicleTypes,
      warnings: [
        ...discoveryResult.warnings,
        ...systemResult.warnings,
        ...stationResult.warnings,
        ...statusResult.warnings,
        ...vehicleWarnings,
      ],
      observations,
      state,
    };
  }
}

export const fetchGbfsStationBundle = (
  source: GbfsSystemSource,
  options: GbfsClientOptions = {},
  previousState: GbfsFetchState = {},
): Promise<GbfsStationBundle> =>
  new GbfsClient(source, options).fetchStationBundle(previousState);
