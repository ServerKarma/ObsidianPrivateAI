# Incident Postmortem - Checkout Outage

On 2024-07-19 checkout was down for 47 minutes.

## Root cause

An expired TLS certificate on the payment gateway load balancer.

## Action items

- Automate certificate renewal.
- Alert 30 days before any certificate expires.
