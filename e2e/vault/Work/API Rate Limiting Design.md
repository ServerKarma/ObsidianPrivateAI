# API Rate Limiting Design

Proposal: a token bucket per API key.

- Limit: 100 requests per minute
- Counters stored in Redis
- Return HTTP 429 with a Retry-After header
- Internal services are exempt.
