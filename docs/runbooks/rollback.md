# Deployment and catalog rollback

## Code rollback

Use Cloudflare version history to route traffic to the last verified deployment. The Durable Object schema is forward/backward compatible within V1, so a code rollback must not delete or rewrite stored snapshots. After rollback, run `/healthz`, `/readyz`, the five-tool smoke suite, and one live query for each seed provider.

## Catalog rollback

Catalog objects are immutable at `catalog/v1/<version>-<sha256>.json`. Roll back by validating the target object's schema and SHA-256 digest, then updating only the KV `catalog:current` pointer to that exact key and digest. Never overwrite or delete the failed catalog during incident response. Record the previous and replacement versions and enqueue probes for the restored systems.

## Custom-domain containment

If responses are unsafe and a verified version is unavailable, disable the production Custom Domain route. Keep the Worker deployment and persisted data intact for investigation. Restoring the route requires passing staging smoke checks and `/readyz` against the intended catalog version.
