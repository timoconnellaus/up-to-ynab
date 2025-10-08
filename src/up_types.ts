/**
 * Up Bank API TypeScript Types
 * Based on Up API v1 specification
 */

// ============================================================================
// Common Types
// ============================================================================

export interface MoneyObject {
  /** ISO 4217 currency code (e.g., "AUD") */
  currencyCode: string;
  /** Amount formatted as string (e.g., "10.56") */
  value: string;
  /** Amount in smallest denomination (e.g., 1056 for $10.56) */
  valueInBaseUnits: number;
}

export interface Links {
  /** Canonical link to this resource */
  self?: string;
  /** Link to related resource */
  related?: string;
  /** Link to previous page */
  prev?: string | null;
  /** Link to next page */
  next?: string | null;
}

export interface PaginationLinks {
  prev: string | null;
  next: string | null;
}

// ============================================================================
// Enums
// ============================================================================

export enum AccountType {
  SAVER = "SAVER",
  TRANSACTIONAL = "TRANSACTIONAL",
  HOME_LOAN = "HOME_LOAN",
}

export enum OwnershipType {
  INDIVIDUAL = "INDIVIDUAL",
  JOINT = "JOINT",
}

export enum TransactionStatus {
  HELD = "HELD",
  SETTLED = "SETTLED",
}

export enum CardPurchaseMethod {
  BAR_CODE = "BAR_CODE",
  OCR = "OCR",
  CARD_PIN = "CARD_PIN",
  CARD_DETAILS = "CARD_DETAILS",
  CARD_ON_FILE = "CARD_ON_FILE",
  ECOMMERCE = "ECOMMERCE",
  MAGNETIC_STRIPE = "MAGNETIC_STRIPE",
  CONTACTLESS = "CONTACTLESS",
}

export enum WebhookEventType {
  TRANSACTION_CREATED = "TRANSACTION_CREATED",
  TRANSACTION_SETTLED = "TRANSACTION_SETTLED",
  TRANSACTION_DELETED = "TRANSACTION_DELETED",
  PING = "PING",
}

export enum WebhookDeliveryStatus {
  DELIVERED = "DELIVERED",
  UNDELIVERABLE = "UNDELIVERABLE",
  BAD_RESPONSE_CODE = "BAD_RESPONSE_CODE",
}

// ============================================================================
// Account Types
// ============================================================================

export interface AccountResource {
  type: "accounts";
  id: string;
  attributes: {
    /** Account name in Up application */
    displayName: string;
    /** Bank account type */
    accountType: AccountType;
    /** Ownership structure */
    ownershipType: OwnershipType;
    /** Available balance (excluding held amounts) */
    balance: MoneyObject;
    /** Date-time account was first opened */
    createdAt: string;
  };
  relationships: {
    transactions: {
      links?: {
        related: string;
      };
    };
  };
  links?: Links;
}

export interface AccountsResponse {
  data: AccountResource[];
  links: PaginationLinks;
}

export interface AccountResponse {
  data: AccountResource;
}

// ============================================================================
// Transaction Types
// ============================================================================

export interface HoldInfoObject {
  /** Amount while in HELD status */
  amount: MoneyObject;
  /** Foreign amount while in HELD status */
  foreignAmount: MoneyObject | null;
}

export interface CardPurchaseMethodObject {
  /** Type of card purchase */
  method: CardPurchaseMethod;
  /** Last four digits of card */
  cardNumberSuffix: string | null;
}

export interface NoteObject {
  /** Customer-provided note (Up High subscribers only) */
  text: string;
}

export interface CustomerObject {
  /** Upname or preferred name */
  displayName: string;
}

export interface TransactionResource {
  type: "transactions";
  id: string;
  attributes: {
    /** Processing status */
    status: TransactionStatus;
    /** Original, unprocessed transaction text */
    rawText: string | null;
    /** Short description (usually merchant name) */
    description: string;
    /** Attached message */
    message: string | null;
    /** Whether transaction supports categorization */
    isCategorizable: boolean;
    /** Hold information for HELD/previously HELD transactions */
    holdInfo: HoldInfoObject | null;
    /** Transaction amount in AUD */
    amount: MoneyObject;
    /** Foreign currency amount (null for domestic) */
    foreignAmount: MoneyObject | null;
    /** Card purchase information */
    cardPurchaseMethod: CardPurchaseMethodObject | null;
    /** Settlement date-time (null if HELD) */
    settledAt: string | null;
    /** Date-time first encountered */
    createdAt: string;
    /** Transaction method description (e.g., "Purchase") */
    transactionType: string | null;
    /** Customer note about transaction */
    note: NoteObject | null;
    /** Customer who initiated transaction */
    performingCustomer: CustomerObject | null;
    /** Deep link to receipt in app */
    deepLinkURL: string;
  };
  relationships: {
    account: {
      data: {
        type: "accounts";
        id: string;
      };
      links?: {
        related: string;
      };
    };
    transferAccount: {
      data: {
        type: "accounts";
        id: string;
      } | null;
      links?: {
        related: string;
      };
    };
    category: {
      data: {
        type: "categories";
        id: string;
      } | null;
      links?: {
        self: string;
        related?: string;
      };
    };
    parentCategory: {
      data: {
        type: "categories";
        id: string;
      } | null;
      links?: {
        related: string;
      };
    };
    tags: {
      data: Array<{
        type: "tags";
        id: string;
      }>;
      links?: {
        self: string;
      };
    };
    attachment: {
      data: {
        type: "attachments";
        id: string;
      } | null;
      links?: {
        related: string;
      };
    };
  };
  links?: Links;
}

export interface TransactionsResponse {
  data: TransactionResource[];
  links: PaginationLinks;
}

export interface TransactionResponse {
  data: TransactionResource;
}

// ============================================================================
// Category Types
// ============================================================================

export interface CategoryResource {
  type: "categories";
  id: string;
  attributes: {
    /** Category name */
    name: string;
  };
  relationships: {
    parent: {
      data: {
        type: "categories";
        id: string;
      } | null;
      links?: {
        related: string;
      };
    };
    children: {
      data: Array<{
        type: "categories";
        id: string;
      }>;
      links?: {
        related: string;
      };
    };
  };
  links?: Links;
}

export interface CategoriesResponse {
  data: CategoryResource[];
  links?: PaginationLinks;
}

export interface CategoryResponse {
  data: CategoryResource;
}

// ============================================================================
// Tag Types
// ============================================================================

export interface TagResource {
  type: "tags";
  id: string;
  relationships: {
    transactions: {
      links?: {
        related: string;
      };
    };
  };
}

export interface TagsResponse {
  data: TagResource[];
  links: PaginationLinks;
}

// ============================================================================
// Webhook Types
// ============================================================================

export interface WebhookResource {
  type: "webhooks";
  id: string;
  attributes: {
    /** URL to POST events to */
    url: string;
    /** Optional description */
    description: string | null;
    /** Secret key for signing (only returned on creation) */
    secretKey?: string;
    /** Creation date-time */
    createdAt: string;
  };
  relationships: {
    logs: {
      links?: {
        related: string;
      };
    };
  };
  links?: Links;
}

export interface WebhooksResponse {
  data: WebhookResource[];
  links: PaginationLinks;
}

export interface WebhookResponse {
  data: WebhookResource;
}

export interface WebhookInputResource {
  data: {
    attributes: {
      /** Webhook URL (max 300 chars) */
      url: string;
      /** Optional description (max 64 chars) */
      description?: string | null;
    };
  };
}

// ============================================================================
// Webhook Event Types
// ============================================================================

export interface WebhookEventResource {
  type: "webhook-events";
  id: string;
  attributes: {
    /** Type of webhook event */
    eventType: WebhookEventType;
    /** Event generation date-time */
    createdAt: string;
  };
  relationships: {
    webhook: {
      data: {
        type: "webhooks";
        id: string;
      };
      links?: {
        related: string;
      };
    };
    transaction?: {
      data: {
        type: "transactions";
        id: string;
      };
      links?: {
        related: string;
      };
    };
  };
}

export interface WebhookEventResponse {
  data: WebhookEventResource;
}

// ============================================================================
// Webhook Delivery Log Types
// ============================================================================

export interface WebhookDeliveryLogResource {
  type: "webhook-delivery-logs";
  id: string;
  attributes: {
    request: {
      /** Payload sent in request body */
      body: string;
    };
    response: {
      /** HTTP status code received */
      statusCode: number;
      /** Payload received in response body */
      body: string;
    } | null;
    /** Delivery status */
    deliveryStatus: WebhookDeliveryStatus;
    /** Log creation date-time */
    createdAt: string;
  };
  relationships: {
    webhookEvent: {
      data: {
        type: "webhook-events";
        id: string;
      };
      links?: {
        related: string;
      };
    };
  };
  links?: Links;
}

export interface WebhookDeliveryLogsResponse {
  data: WebhookDeliveryLogResource[];
  links: PaginationLinks;
}

// ============================================================================
// Attachment Types
// ============================================================================

export interface AttachmentResource {
  type: "attachments";
  id: string;
  attributes: {
    /** File name */
    fileName: string;
    /** MIME type */
    contentType: string;
    /** File size in bytes */
    sizeInBytes: number;
  };
  links?: Links;
}

export interface AttachmentsResponse {
  data: AttachmentResource[];
  links: PaginationLinks;
}

export interface AttachmentResponse {
  data: AttachmentResource;
}

// ============================================================================
// Utility Types
// ============================================================================

export interface PingResponse {
  meta: {
    /** Unique request ID */
    id: string;
    /** Status emoji */
    statusEmoji: string;
  };
}

// ============================================================================
// Input Types for Mutations
// ============================================================================

export interface CategoryInputResourceIdentifier {
  type: "categories";
  id: string;
}

export interface TagInputResourceIdentifier {
  type: "tags";
  /** Tag label (also acts as unique identifier) */
  id: string;
}

export interface UpdateCategoryInput {
  data: CategoryInputResourceIdentifier | null;
}

export interface UpdateTagsInput {
  data: TagInputResourceIdentifier[];
}
