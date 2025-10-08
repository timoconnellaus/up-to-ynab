# Up Bank API Reference

## Base URL
```
https://api.up.com.au/api/v1
```

## Authentication

All requests require Bearer token authentication using the `Authorization` header:

```bash
Authorization: Bearer YOUR_TOKEN_HERE
```

### Environment Setup
Store your API token in `.dev.vars`:
```
UP_BANK_API_KEY=up:yeah:YourActualToken
```

### Making Authenticated Requests
```bash
curl https://api.up.com.au/api/v1/util/ping \
  -H 'Authorization: Bearer YOUR_TOKEN_HERE'
```

## Core Endpoints

### Utility

#### Ping
Test API connectivity and authentication.

```
GET /util/ping
```

**Response (200)**
```json
{
  "meta": {
    "id": "849e23dd-f7aa-4421-a47a-f246dc6576fd",
    "statusEmoji": "⚡️"
  }
}
```

---

### Accounts

#### List Accounts
Retrieve paginated list of all accounts.

```
GET /accounts
```

**Query Parameters**
- `page[size]` (integer): Records per page (e.g., `30`)
- `filter[accountType]`: `SAVER`, `TRANSACTIONAL`, `HOME_LOAN`
- `filter[ownershipType]`: `INDIVIDUAL`, `JOINT`

**Response (200)**
```json
{
  "data": [{
    "type": "accounts",
    "id": "uuid",
    "attributes": {
      "displayName": "Spending",
      "accountType": "TRANSACTIONAL",
      "ownershipType": "INDIVIDUAL",
      "balance": {
        "currencyCode": "AUD",
        "value": "10.56",
        "valueInBaseUnits": 1056
      },
      "createdAt": "2020-01-01T01:02:03+10:00"
    },
    "relationships": {
      "transactions": {
        "links": {
          "related": "https://api.up.com.au/api/v1/accounts/{id}/transactions"
        }
      }
    },
    "links": {
      "self": "https://api.up.com.au/api/v1/accounts/{id}"
    }
  }],
  "links": {
    "prev": null,
    "next": "..."
  }
}
```

#### Get Account
```
GET /accounts/{id}
```

---

### Transactions

#### List All Transactions
Retrieve transactions across all accounts, ordered newest first.

```
GET /transactions
```

**Query Parameters**
- `page[size]` (integer): Records per page
- `filter[status]`: `HELD`, `SETTLED`
- `filter[since]` (RFC-3339): Start date-time (e.g., `2020-01-01T01:02:03+10:00`)
- `filter[until]` (RFC-3339): End date-time
- `filter[category]`: Category ID (e.g., `good-life`)
- `filter[tag]`: Tag name (e.g., `Holiday`)

**Response (200)**
```json
{
  "data": [{
    "type": "transactions",
    "id": "uuid",
    "attributes": {
      "status": "SETTLED",
      "rawText": "Merchant Name",
      "description": "Short description",
      "message": null,
      "isCategorizable": true,
      "holdInfo": null,
      "amount": {
        "currencyCode": "AUD",
        "value": "-11.95",
        "valueInBaseUnits": -1195
      },
      "foreignAmount": null,
      "cardPurchaseMethod": {
        "method": "CONTACTLESS",
        "cardNumberSuffix": "1234"
      },
      "settledAt": "2020-01-01T01:02:03+10:00",
      "createdAt": "2020-01-01T01:02:03+10:00",
      "transactionType": "Purchase",
      "deepLinkURL": "up://transaction/..."
    },
    "relationships": {
      "account": {
        "data": { "type": "accounts", "id": "..." }
      },
      "transferAccount": {
        "data": null
      },
      "category": {
        "data": { "type": "categories", "id": "tv-and-music" },
        "links": {
          "self": ".../relationships/category",
          "related": ".../categories/tv-and-music"
        }
      },
      "parentCategory": {
        "data": { "type": "categories", "id": "good-life" }
      },
      "tags": {
        "data": [],
        "links": { "self": ".../relationships/tags" }
      }
    }
  }]
}
```

#### List Transactions by Account
```
GET /accounts/{accountId}/transactions
```

**Example**
```bash
curl 'https://api.up.com.au/api/v1/accounts/{id}/transactions?page[size]=10&filter[status]=SETTLED' \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

#### Get Transaction
```
GET /transactions/{id}
```

---

### Categories

#### List Categories
Retrieve all pre-defined categories.

```
GET /categories
```

#### Get Category
```
GET /categories/{id}
```

#### Update Transaction Category
Set or remove a category from a transaction (only if `isCategorizable: true`).

```
PATCH /transactions/{transactionId}/relationships/category
```

**Request Body**
```json
{
  "data": {
    "type": "categories",
    "id": "restaurants-and-cafes"
  }
}
```

**De-categorize** (set to `null`)
```json
{
  "data": null
}
```

**Response**: 204 No Content

---

### Tags

#### List Tags
```
GET /tags
```

#### Add Tags to Transaction
Maximum 6 tags per transaction. Duplicates ignored.

```
POST /transactions/{transactionId}/relationships/tags
```

**Request Body**
```json
{
  "data": [
    { "type": "tags", "id": "Holiday" },
    { "type": "tags", "id": "Queensland" }
  ]
}
```

**Response**: 204 No Content

#### Remove Tags from Transaction
```
DELETE /transactions/{transactionId}/relationships/tags
```

**Request Body**: Same format as adding tags

**Response**: 204 No Content

---

### Webhooks

#### List Webhooks
```
GET /webhooks
```

**Query**: `page[size]`

#### Create Webhook
Maximum 10 webhooks. URL must respond with HTTP 200 within 30s.

```
POST /webhooks
```

**Request Body**
```json
{
  "data": {
    "attributes": {
      "url": "https://example.com/webhook",
      "description": "My webhook (optional, max 64 chars)"
    }
  }
}
```

**Response (201)**
```json
{
  "data": {
    "type": "webhooks",
    "id": "uuid",
    "attributes": {
      "url": "https://example.com/webhook",
      "description": "My webhook",
      "secretKey": "sec_abc123...",
      "createdAt": "2025-06-03T00:21:49+10:00"
    }
  }
}
```

**Important**: `secretKey` is returned only once at creation.

#### Get Webhook
```
GET /webhooks/{id}
```

#### Delete Webhook
```
DELETE /webhooks/{id}
```

**Response**: 204 No Content

#### Ping Webhook
Send test PING event for debugging.

```
POST /webhooks/{webhookId}/ping
```

**Response (201)**: Returns webhook event data sent

#### List Webhook Logs
Retrieve delivery logs for debugging. Logs may be auto-purged over time.

```
GET /webhooks/{webhookId}/logs
```

**Query**: `page[size]`

**Response (200)**
```json
{
  "data": [{
    "type": "webhook-delivery-logs",
    "id": "uuid",
    "attributes": {
      "request": {
        "body": "{...}"
      },
      "response": {
        "statusCode": 200,
        "body": "{...}"
      },
      "deliveryStatus": "DELIVERED",
      "createdAt": "2025-06-03T00:21:49+10:00"
    }
  }]
}
```

**Delivery Status**: `DELIVERED`, `UNDELIVERABLE`, `BAD_RESPONSE_CODE`

---

### Webhook Event Handling

#### Verify Webhook Signature
Webhooks include `X-Up-Authenticity-Signature` header (SHA-256 HMAC of raw body).

**Node.js Example**
```javascript
import crypto from 'crypto';

function verifyWebhook(req, secretKey) {
  const receivedSig = req.headers['x-up-authenticity-signature'];
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(req.rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(receivedSig)
  );
}
```

**Webhook Event Types**
- `TRANSACTION_CREATED`
- `TRANSACTION_SETTLED`
- `TRANSACTION_DELETED`
- `PING`

---

### Attachments

#### List Attachments
```
GET /attachments
```

#### Get Attachment
```
GET /attachments/{id}
```

---

## Data Models

### MoneyObject
```typescript
{
  currencyCode: string;      // "AUD"
  value: string;             // "10.56"
  valueInBaseUnits: number;  // 1056
}
```

### Account Types
- `SAVER`
- `TRANSACTIONAL`
- `HOME_LOAN`

### Ownership Types
- `INDIVIDUAL`
- `JOINT`

### Transaction Status
- `HELD`: Pending
- `SETTLED`: Completed

### Card Purchase Methods
`BAR_CODE`, `OCR`, `CARD_PIN`, `CARD_DETAILS`, `CARD_ON_FILE`, `ECOMMERCE`, `MAGNETIC_STRIPE`, `CONTACTLESS`

---

## Pagination

All list endpoints support pagination:
- Query: `?page[size]=30`
- Response includes `links.next` and `links.prev`
- Follow links to navigate pages

## Rate Limiting

Not explicitly documented. Implement exponential backoff for failed requests.

## Error Handling

Standard HTTP status codes:
- `200`: Success
- `201`: Created
- `204`: No Content
- `404`: Not Found
- `401`: Unauthorized
