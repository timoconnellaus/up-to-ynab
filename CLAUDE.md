# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Cloudflare Worker that syncs transactions from Up Bank (Australian digital bank) to YNAB (You Need A Budget). The worker receives webhooks from Up Bank when transactions occur and creates corresponding transactions in YNAB.

## Development Commands

### Local Development

```bash
bun run dev          # Start local development server with Wrangler
bun start            # Alias for bun run dev
```

### Testing

```bash
bun run test             # Run Vitest tests with Cloudflare Workers pool
```

### Deployment

```bash
bun run deploy       # Deploy to Cloudflare Workers
```

### Type Generation

```bash
bun run cf-typegen   # Generate TypeScript types from wrangler.jsonc
```

## Architecture

### Project Structure

- `src/index.ts` - Main Worker entry point (fetch handler)
- `src/up_types.ts` - Complete TypeScript types for Up Bank API (accounts, transactions, webhooks, categories, tags)
- `worker-configuration.d.ts` - Auto-generated Cloudflare Worker types (large file, regenerate with `bun run cf-typegen`)
- `docs/UP_BANK_API.md` - Up Bank API reference documentation
- `test/` - Vitest test files using `@cloudflare/vitest-pool-workers`

### Key Dependencies

- `ynab` - YNAB API client library
- Cloudflare Workers runtime (no Node.js APIs available)
- Vitest with Cloudflare Workers pool for testing

### Environment Variables

Required secrets (set via Wrangler or Cloudflare dashboard):

- `YNAB_PERSONAL_ACCESS_TOKEN` - YNAB API token
- `UP_BANK_API_KEY` - Up Bank API token (format: `up:yeah:...`)
- `API_KEY` - The API key to access the API for the application we're building

Store in `.dev.vars` for local development:

```
YNAB_PERSONAL_ACCESS_TOKEN=your_ynab_token
UP_BANK_API_KEY=up:yeah:your_up_token
API_KEY=any_value_you_want
```

### Testing Approach

Tests use `@cloudflare/vitest-pool-workers` which provides:

- `env` - Access to environment bindings
- `createExecutionContext()` - Mock Worker execution context
- `SELF` - Integration-style testing with actual Worker runtime
- Workers runtime environment simulation

### Configuration Files

- `wrangler.jsonc` - Cloudflare Workers configuration (compatibility_date: 2025-10-08)
- `vitest.config.mts` - Vitest config pointing to wrangler.jsonc for worker context
- `tsconfig.json` - TypeScript config targeting ES2021 with strict mode

## Up Bank Integration

The Up Bank API types in `src/up_types.ts` provide comprehensive type safety for:

- **Accounts** - Account listing, balance, account types (SAVER, TRANSACTIONAL, HOME_LOAN)
- **Transactions** - Transaction listing with filtering by status, date, category, tag
- **Webhooks** - Webhook creation/management, event types (TRANSACTION_CREATED, TRANSACTION_SETTLED, TRANSACTION_DELETED, PING)
- **Categories** - Pre-defined Up Bank categories (hierarchical structure)
- **Tags** - Transaction tagging (max 6 tags per transaction)

All API responses follow JSON:API specification with `data`, `links`, and `relationships` structure.

### Webhook Event Handling

Up Bank webhooks send events to the Worker. Signatures must be verified using the `X-Up-Authenticity-Signature` header (SHA-256 HMAC). The secret key is returned only once when creating the webhook.

## YNAB Integration

The YNAB SDK provides the `YNAB.API` client. Initialize with the personal access token from environment bindings.
