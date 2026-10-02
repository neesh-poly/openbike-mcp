import { FeedObservationSchema, SystemIdSchema, type FeedObservation } from "../contracts";
import { fetchBoundedJson, type FetchBoundedJsonOptions, type ResponseMetadata } from "../security/fetch-json";
import { createReviewedHostPolicy } from "../security/url-policy";
import { GbfsNormalizationError, readGbfsEnvelopeMetadata } from "./normalize";
import { withGbfsFeedError } from "./errors";
import type { CachedGbfsDocument, GbfsClientOptions, GbfsFetchFeedName, GbfsSystemSource } from "./types";

export interface LoadedDocument {
  document: unknown;
  observation: FeedObservation;
  cached: CachedGbfsDocument;
}

const mergedMetadata = (
  previous: ResponseMetadata,
  current: ResponseMetadata,
): ResponseMetadata => ({
  ...(previous.etag === undefined ? {} : { etag: previous.etag }),
  ...(previous.lastModified === undefined
    ? {}
    : { lastModified: previous.lastModified }),
  ...(previous.contentHash === undefined
    ? {}
    : { contentHash: previous.contentHash }),
  ...current,
});

export class FeedTransport {
  readonly source: GbfsSystemSource;

  private readonly options: GbfsClientOptions;
  private readonly policy: ReturnType<typeof createReviewedHostPolicy>;

  constructor(source: GbfsSystemSource, options: GbfsClientOptions = {}) {
    const systemId = SystemIdSchema.parse(source.systemId);
    this.source = { ...source, systemId };
    this.options = options;
    this.policy = createReviewedHostPolicy(
      source.reviewedHosts.map((rule) => {
        const headers = {
          ...(source.requestHeaders ?? {}),
          ...(rule.headers ?? {}),
        };
        return {
          ...rule,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
        };
      }),
    );
  }

  async loadDocument(
    feedName: GbfsFetchFeedName,
    url: string,
    previous: CachedGbfsDocument | undefined,
  ): Promise<LoadedDocument> {
    return withGbfsFeedError(feedName, async () => {
      const mayReusePrevious = previous?.url === undefined || previous.url === url;
      const conditional = mayReusePrevious ? previous?.metadata : undefined;
      const fetchOptions: FetchBoundedJsonOptions = {
        policy: this.policy,
        ...(this.options.fetcher === undefined
          ? {}
          : { fetcher: this.options.fetcher }),
        ...(this.options.maxBytes === undefined
          ? {}
          : { maxBytes: this.options.maxBytes }),
        ...(this.options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.timeoutMs }),
        ...(this.options.maxRedirects === undefined
          ? {}
          : { maxRedirects: this.options.maxRedirects }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
        ...(conditional === undefined ? {} : { conditional }),
      };
      const result = await fetchBoundedJson(url, fetchOptions);

      let document: unknown;
      let metadata: ResponseMetadata;
      if (result.kind === "not_modified") {
        if (previous === undefined || !mayReusePrevious) {
          throw new GbfsNormalizationError(
            "INVALID_DOCUMENT",
            "The upstream feed returned not-modified without a reusable document.",
            true,
          );
        }
        document = previous.document;
        metadata = mergedMetadata(previous.metadata, result.metadata);
      } else {
        document = result.document;
        metadata = result.metadata;
      }

      const adaptedDocument = this.options.adaptDocument?.(feedName, document) ?? document;
      const envelope = readGbfsEnvelopeMetadata(adaptedDocument);
      const observation = FeedObservationSchema.parse({
        system_id: this.source.systemId,
        feed_name: feedName,
        fetched_at: result.fetchedAt,
        http_status: result.status,
        etag: metadata.etag ?? null,
        last_modified: metadata.lastModified ?? null,
        provider_last_updated: envelope.providerLastUpdated,
        ttl_seconds: envelope.ttlSeconds,
        validation_status: "valid",
        content_hash: metadata.contentHash ?? null,
      });
      return {
        document: adaptedDocument,
        observation,
        cached: { document, metadata, url },
      };
    });
  }

}
