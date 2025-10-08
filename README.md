# Up Bank to YNAB Sync

Automatically sync transactions from Up Bank (Australian digital bank) to YNAB (You Need A Budget) using Cloudflare Workers.

## Features

- 🔄 **Real-time Sync**: Webhooks automatically sync transactions as they're created and settled
- 🔒 **Secure**: API key authentication and webhook signature verification
- 🚫 **Duplicate Prevention**: Smart import_id handling ensures transactions aren't duplicated
- ⏰ **Scheduled Sync**: Hourly cron job syncs the last 30 days to catch any updates
- 🗺️ **Account Mapping**: Map multiple Up Bank accounts to YNAB accounts
- 📅 **Date Control**: Configure the earliest date to sync from

## Prerequisites

- An [Up Bank](https://up.com.au/) account (Australian bank)
- A [YNAB](https://www.youneedabudget.com/) account
- A [Cloudflare](https://www.cloudflare.com/) account (free tier works)
- [Bun](https://bun.sh/) installed locally

## Setup Instructions

### 1. Get Your API Keys

#### Up Bank API Key

1. Visit https://api.up.com.au/getting_started
2. Create a personal access token
3. Copy the token (format: `up:yeah:...`)

#### YNAB Personal Access Token

1. Visit https://app.ynab.com/settings/developer
2. Click "New Token"
3. Enter a token name (e.g., "Up Bank Sync")
4. Copy the generated token

### 2. Clone and Install

```bash
git clone https://github.com/timoconnellaus/up-to-ynab
cd up-to-ynab
bun install
```

### 3. Configure Environment Variables

Copy the example environment file:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and add your API keys:

```bash
UP_BANK_API_KEY=up:yeah:your_up_bank_api_token_here
YNAB_PERSONAL_ACCESS_TOKEN=your_ynab_personal_access_token_here
API_KEY=your_random_api_key_here  # Generate any random string (mash the keyboard for 20-40 chars will do)
```

### 4. Start Local Development Server

```bash
bun run dev
```

The worker will be available at `http://localhost:8787`

### 5. Get Your Account IDs

#### Find Up Bank Account IDs

```bash
curl -X GET http://localhost:8787/up/accounts \
  -H "Authorization: Bearer YOUR_API_KEY"
```

This returns a list of your Up Bank accounts with their IDs.

#### Find YNAB Budget and Account IDs

```bash
curl -X GET http://localhost:8787/ynab/info \
  -H "Authorization: Bearer YOUR_API_KEY"
```

This returns your YNAB budgets and accounts with their IDs.

### 6. Configure Account Mapping

Update the `ACCOUNT_MAPPING` in `.dev.vars` to map your Up Bank accounts to YNAB accounts:

```bash
ACCOUNT_MAPPING={"up-account-id-1":"ynab-account-id-1","up-account-id-2":"ynab-account-id-2"}
```

Example:

```bash
ACCOUNT_MAPPING={"da764e70-593f-420a-82c9-430d24f653e6":"bb784a57-ae94-442c-b405-162b46bb844b"}
```

Also update `YNAB_BUDGET_ID` with your budget ID from step 5.

### 7. Set Sync Start Date

Set the earliest date you want to sync transactions from:

```bash
SYNC_START_DATE=2025-10-01
```

Transactions before this date will never be synced, even if you run manual syncs.

### 8. Deploy to Cloudflare Workers

```bash
bunx wrangler deploy
```

After deployment, note your worker URL (e.g., `https://up-to-ynab.your-subdomain.workers.dev`)

### 9. Update BASE_URL

Update `.dev.vars` with your deployed worker URL:

```bash
BASE_URL=https://up-to-ynab.your-subdomain.workers.dev
```

### 10. Set Up Production Secrets

Set your secrets in Cloudflare Workers:

```bash
bunx wrangler secret put UP_BANK_API_KEY
bunx wrangler secret put YNAB_PERSONAL_ACCESS_TOKEN
bunx wrangler secret put API_KEY
bunx wrangler secret put YNAB_BUDGET_ID
bunx wrangler secret put BASE_URL
bunx wrangler secret put SYNC_START_DATE
bunx wrangler secret put ACCOUNT_MAPPING
```

### 11. Create Up Bank Webhook

```bash
curl -X POST https://up-to-ynab.your-subdomain.workers.dev/webhook/create \
  -H "Authorization: Bearer YOUR_API_KEY"
```

This will return a webhook secret. **Save it immediately** - it won't be shown again!

### 12. Add Webhook Secret

Set the webhook secret in Cloudflare:

```bash
bunx wrangler secret put UP_WEBHOOK_SECRET
# Paste the secret when prompted
```

Also update your local `.dev.vars`:

```bash
UP_WEBHOOK_SECRET=your_webhook_secret_here
```

### 13. Initial Sync

Sync your existing transactions:

```bash
curl -X POST https://up-to-ynab.your-subdomain.workers.dev/sync \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"startDate": "2025-10-01"}'
```

## How It Works

### Automatic Sync (Webhooks)

- When a transaction is created in Up Bank, a webhook triggers and syncs it to YNAB
- When the transaction settles, it updates the existing YNAB transaction to "cleared" status
- Duplicate detection ensures the same transaction isn't created twice

### Scheduled Sync (Cron)

- Every hour, the worker syncs the last 30 days of transactions
- This catches any manual updates you make in Up Bank (like editing descriptions)
- Duplicates are automatically skipped

### Manual Sync

Use the `/sync` endpoint to manually sync transactions from a specific date:

```bash
curl -X POST https://up-to-ynab.your-subdomain.workers.dev/sync \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"startDate": "2025-10-01"}'
```

## API Endpoints

### GET /up/accounts

List all Up Bank accounts with IDs

**Auth**: Required (Bearer token)

### GET /ynab/info

List YNAB budgets and accounts with IDs

**Auth**: Required (Bearer token)

### POST /webhook/create

Create an Up Bank webhook pointing to this worker

**Auth**: Required (Bearer token)

### POST /webhook

Receive webhook events from Up Bank (called by Up Bank, not you)

**Auth**: Webhook signature verification

### POST /sync

Manually sync transactions from a specific date

**Auth**: Required (Bearer token)

**Body**:

```json
{
	"startDate": "2025-10-01"
}
```

## Troubleshooting

### View Logs

Watch real-time logs from your deployed worker:

```bash
bunx wrangler tail
```

### Webhook Not Working

1. Check webhook signature is set correctly
2. View webhook delivery logs in Up Bank API
3. Check worker logs for errors

### Transactions Not Syncing

1. Verify account mapping is correct
2. Check that transactions are after `SYNC_START_DATE`
3. Ensure Up Bank accounts are mapped in `ACCOUNT_MAPPING`

## Development

### Local Development

```bash
bun run dev
```

### Type Generation

After modifying `wrangler.jsonc`:

```bash
bun run cf-typegen
```

### Testing

```bash
bun run test
```

### Deployment

```bash
bun run deploy
```

## License

MIT

## Contributing

Pull requests welcome!
