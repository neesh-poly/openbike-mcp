# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately to `Kanishq0106@gmail.com`. Include the affected route or tool, a minimal reproduction, impact, and any suggested mitigation. Do not include secrets, precise user locations, or full upstream GBFS payloads.

Please do not open a public issue until the maintainer has acknowledged the report and coordinated disclosure. The target initial response time is five business days.

## Security boundary

Open Bikeshare MCP is read-only and accepts only normalized system and station identifiers plus bounded query inputs. Clients cannot supply upstream URLs. Outbound requests are limited to reviewed HTTPS GBFS hosts and use manual redirect handling, response-size limits, deadlines, and Cloudflare's strictly-public fetch mode.

The service never needs rider accounts, payment details, trip histories, or provider credentials for the public feeds in the production seed catalog. Logs must not contain prompts, authorization headers, exact coordinates, unbounded request bodies, or upstream payloads.
