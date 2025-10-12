/**
 * Up Bank to YNAB Sync Worker
 *
 * Syncs transactions from Up Bank to YNAB via API
 */

import * as YNAB from 'ynab';
import type { TransactionsResponse, TransactionResource } from './up_types';

interface SyncRequest {
	startDate: string;
}

interface SyncResponse {
	imported: number;
	duplicates: number;
	total: number;
	accounts: Array<{
		upAccountId: string;
		ynabAccountId: string;
		imported: number;
		duplicates: number;
	}>;
}

interface AccountSyncResult {
	imported: number;
	duplicates: number;
	total: number;
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log('⏰ Cron triggered - syncing last 30 days');

		// Parse account mapping from env
		const accountMapping: Record<string, string> = JSON.parse(env.ACCOUNT_MAPPING);

		// Calculate date 30 days ago, but never earlier than SYNC_START_DATE
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const minDate = new Date(env.SYNC_START_DATE);
		const startDate = (thirtyDaysAgo < minDate ? minDate : thirtyDaysAgo).toISOString().split('T')[0]; // YYYY-MM-DD

		console.log('📅 Syncing from:', startDate);

		try {
			// Sync all mapped accounts
			const accountResults = [];
			let totalImported = 0;
			let totalDuplicates = 0;
			let totalTransactions = 0;

			for (const [upAccountId, ynabAccountId] of Object.entries(accountMapping)) {
				// Fetch transactions for this Up account
				const upTransactions = await fetchUpTransactionsByAccount(env.UP_BANK_API_KEY, upAccountId, startDate);

				// Transform and create in YNAB
				const result = await syncToYNAB(
					env.YNAB_PERSONAL_ACCESS_TOKEN,
					env.YNAB_BUDGET_ID,
					ynabAccountId,
					upTransactions
				);

				accountResults.push({
					upAccountId,
					ynabAccountId,
					imported: result.imported,
					duplicates: result.duplicates,
				});

				totalImported += result.imported;
				totalDuplicates += result.duplicates;
				totalTransactions += result.total;
			}

			console.log('✅ Cron sync complete:', JSON.stringify({
				imported: totalImported,
				duplicates: totalDuplicates,
				total: totalTransactions,
			}));
		} catch (error) {
			console.error('❌ Cron sync error:', error);
		}
	},

	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// GET /up/accounts endpoint - List Up Bank accounts
		if (request.method === 'GET' && url.pathname === '/up/accounts') {
			// Check API key authentication
			const authHeader = request.headers.get('Authorization');
			if (!authHeader || !authHeader.startsWith('Bearer ')) {
				return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const apiKey = authHeader.substring(7);
			if (apiKey !== env.API_KEY) {
				return new Response(JSON.stringify({ error: 'Invalid API key' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			try {
				const response = await fetch('https://api.up.com.au/api/v1/accounts', {
					headers: {
						Authorization: `Bearer ${env.UP_BANK_API_KEY}`,
					},
				});

				if (!response.ok) {
					throw new Error(`Up Bank API error: ${response.status} ${response.statusText}`);
				}

				const data: any = await response.json();
				const accounts = data.data.map((account: any) => ({
					id: account.id,
					name: account.attributes.displayName,
					type: account.attributes.accountType,
					balance: account.attributes.balance.value,
				}));

				return new Response(JSON.stringify({ accounts }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				console.error('Up Bank accounts error:', error);
				return new Response(
					JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }),
					{
						status: 500,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}
		}

		// POST /webhook/create endpoint - Create Up Bank webhook
		if (request.method === 'POST' && url.pathname === '/webhook/create') {
			// Check API key authentication
			const authHeader = request.headers.get('Authorization');
			if (!authHeader || !authHeader.startsWith('Bearer ')) {
				return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const apiKey = authHeader.substring(7);
			if (apiKey !== env.API_KEY) {
				return new Response(JSON.stringify({ error: 'Invalid API key' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			try {
				const webhookUrl = `${env.BASE_URL}/webhook`;

				const response = await fetch('https://api.up.com.au/api/v1/webhooks', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${env.UP_BANK_API_KEY}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						data: {
							attributes: {
								url: webhookUrl,
								description: 'Up to YNAB sync',
							},
						},
					}),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Up Bank API error: ${response.status} ${errorText}`);
				}

				const data: any = await response.json();
				const secretKey = data.data.attributes.secretKey;

				return new Response(
					JSON.stringify({
						webhook_id: data.data.id,
						webhook_url: webhookUrl,
						secret_key: secretKey,
						message: 'Webhook created! IMPORTANT: Save the secret_key to your UP_WEBHOOK_SECRET environment variable. It will not be shown again.',
					}),
					{
						status: 201,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			} catch (error) {
				console.error('Webhook creation error:', error);
				return new Response(
					JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }),
					{
						status: 500,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}
		}

		// POST /webhook endpoint - Handle Up Bank webhook events
		if (request.method === 'POST' && url.pathname === '/webhook') {
			try {
				console.log('🔔 Webhook received');

				// Get the raw request body
				const body = await request.text();
				const signature = request.headers.get('x-up-authenticity-signature');

				console.log('📝 Body length:', body.length);
				console.log('🔐 Signature present:', !!signature);

				if (!signature) {
					console.log('❌ Missing signature header');
					return new Response(JSON.stringify({ error: 'Missing signature header' }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				// Verify webhook signature
				if (env.UP_WEBHOOK_SECRET) {
					console.log('🔍 Verifying signature...');
					const isValid = await verifyWebhookSignature(body, signature, env.UP_WEBHOOK_SECRET);
					console.log('✅ Signature valid:', isValid);
					if (!isValid) {
						console.log('❌ Invalid signature');
						return new Response(JSON.stringify({ error: 'Invalid signature' }), {
							status: 401,
							headers: { 'Content-Type': 'application/json' },
						});
					}
				} else {
					console.log('⚠️ No webhook secret configured, skipping verification');
				}

				// Parse the webhook event
				const event = JSON.parse(body);
				const eventType = event.data.attributes.eventType;
				console.log('📨 Event type:', eventType);

				// Process TRANSACTION_CREATED and TRANSACTION_SETTLED events
				if (eventType === 'TRANSACTION_CREATED' || eventType === 'TRANSACTION_SETTLED') {
					const transactionId = event.data.relationships.transaction.data.id;
					console.log('💳 Transaction ID:', transactionId);

					// Fetch the full transaction details
					console.log('🔄 Fetching transaction details from Up Bank...');
					const txResponse = await fetch(`https://api.up.com.au/api/v1/transactions/${transactionId}`, {
						headers: {
							Authorization: `Bearer ${env.UP_BANK_API_KEY}`,
						},
					});

					if (!txResponse.ok) {
						console.log('❌ Failed to fetch transaction:', txResponse.status);
						throw new Error(`Failed to fetch transaction: ${txResponse.status}`);
					}

					const txData: any = await txResponse.json();
					console.log('📦 Raw response data keys:', Object.keys(txData));

					if (!txData.data) {
						console.log('❌ No data field in response:', JSON.stringify(txData));
						throw new Error('Invalid transaction response: missing data field');
					}

					const transaction: TransactionResource = txData.data;
					console.log('📄 Transaction details:', JSON.stringify({
						description: transaction.attributes?.description ?? 'N/A',
						amount: transaction.attributes?.amount?.value ?? 'N/A',
						status: transaction.attributes?.status ?? 'N/A',
					}));

					// Parse account mapping from env
					const accountMapping: Record<string, string> = JSON.parse(env.ACCOUNT_MAPPING);

					// Get the account ID from the transaction
					const upAccountId = transaction.relationships.account.data.id;
					console.log('🏦 Up Account ID:', upAccountId);

					// Check if this account is mapped
					const ynabAccountId = accountMapping[upAccountId];
					console.log('🗺️ YNAB Account ID:', ynabAccountId || 'NOT MAPPED');

					if (!ynabAccountId) {
						console.log(`⚠️ Skipping transaction from unmapped account: ${upAccountId}`);
						return new Response(JSON.stringify({ message: 'Account not mapped, skipped' }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						});
					}

					// Sync this single transaction
					console.log('💾 Syncing to YNAB...');
					const result = await syncToYNAB(env.YNAB_PERSONAL_ACCESS_TOKEN, env.YNAB_BUDGET_ID, ynabAccountId, [
						transaction,
					]);

					console.log('✅ Sync complete:', JSON.stringify({
						imported: result.imported,
						duplicates: result.duplicates,
						total: result.total,
					}));

					return new Response(
						JSON.stringify({
							message: 'Transaction processed',
							imported: result.imported,
							duplicate: result.duplicates > 0,
						}),
						{
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						}
					);
				}

				// For other event types (PING, TRANSACTION_CREATED, TRANSACTION_DELETED), just acknowledge
				console.log('ℹ️ Event acknowledged (not TRANSACTION_SETTLED)');
				return new Response(JSON.stringify({ message: 'Event received', type: eventType }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				console.error('❌ Webhook processing error:', error);
				return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

		// GET /ynab/info endpoint - List budgets and accounts
		if (request.method === 'GET' && url.pathname === '/ynab/info') {
			// Check API key authentication
			const authHeader = request.headers.get('Authorization');
			if (!authHeader || !authHeader.startsWith('Bearer ')) {
				return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const apiKey = authHeader.substring(7);
			if (apiKey !== env.API_KEY) {
				return new Response(JSON.stringify({ error: 'Invalid API key' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			try {
				const ynab = new YNAB.API(env.YNAB_PERSONAL_ACCESS_TOKEN);

				// Get all budgets
				const budgetsResponse = await ynab.budgets.getBudgets();
				const budgets = budgetsResponse.data.budgets.map((budget) => ({
					id: budget.id,
					name: budget.name,
				}));

				// Get accounts for the configured budget
				const accountsResponse = await ynab.accounts.getAccounts(env.YNAB_BUDGET_ID);
				const accounts = accountsResponse.data.accounts.map((account) => ({
					id: account.id,
					name: account.name,
					type: account.type,
					on_budget: account.on_budget,
					closed: account.closed,
				}));

				return new Response(
					JSON.stringify({
						budgets,
						configured_budget_id: env.YNAB_BUDGET_ID,
						accounts,
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			} catch (error) {
				console.error('YNAB info error:', error);
				return new Response(
					JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }),
					{
						status: 500,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}
		}

		// POST /sync endpoint
		if (request.method === 'POST' && url.pathname === '/sync') {
			// Check API key authentication
			const authHeader = request.headers.get('Authorization');
			if (!authHeader || !authHeader.startsWith('Bearer ')) {
				return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const apiKey = authHeader.substring(7); // Remove 'Bearer '
			if (apiKey !== env.API_KEY) {
				return new Response(JSON.stringify({ error: 'Invalid API key' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Parse and validate request body
			let body: SyncRequest;
			try {
				body = await request.json();
			} catch {
				return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (!body.startDate) {
				return new Response(JSON.stringify({ error: 'Missing required field: startDate' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			// Validate date format (YYYY-MM-DD)
			const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
			if (!dateRegex.test(body.startDate)) {
				return new Response(JSON.stringify({ error: 'startDate must be in YYYY-MM-DD format' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			try {
				console.log('📋 Starting sync for date:', body.startDate);

				// Parse account mapping from env
				const accountMapping: Record<string, string> = JSON.parse(env.ACCOUNT_MAPPING);
				console.log('🗺️ Account mapping loaded:', Object.keys(accountMapping).length, 'accounts');

				// Sync all mapped accounts
				const accountResults = [];
				let totalImported = 0;
				let totalDuplicates = 0;
				let totalTransactions = 0;

				for (const [upAccountId, ynabAccountId] of Object.entries(accountMapping)) {
					console.log('🔄 Processing account:', upAccountId);

					// Fetch transactions for this Up account
					const upTransactions = await fetchUpTransactionsByAccount(env.UP_BANK_API_KEY, upAccountId, body.startDate);
					console.log('📥 Fetched transactions:', upTransactions.length);

					// Transform and create in YNAB
					const result = await syncToYNAB(
						env.YNAB_PERSONAL_ACCESS_TOKEN,
						env.YNAB_BUDGET_ID,
						ynabAccountId,
						upTransactions
					);

					console.log('✅ Result for account:', JSON.stringify(result));

					accountResults.push({
						upAccountId,
						ynabAccountId,
						imported: result?.imported ?? 0,
						duplicates: result?.duplicates ?? 0,
					});

					totalImported += result?.imported ?? 0;
					totalDuplicates += result?.duplicates ?? 0;
					totalTransactions += result?.total ?? 0;
				}

				console.log('📊 Final totals:', JSON.stringify({
					totalImported,
					totalDuplicates,
					totalTransactions,
				}));

				return new Response(
					JSON.stringify({
						imported: totalImported,
						duplicates: totalDuplicates,
						total: totalTransactions,
						accounts: accountResults,
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			} catch (error) {
				console.error('Sync error:', error);
				return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

		return new Response('Up Bank to YNAB Sync Worker', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Verify webhook signature using HMAC SHA-256
 */
async function verifyWebhookSignature(body: string, signature: string, secret: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
	const computedSignature = Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	return computedSignature === signature;
}

/**
 * Fetch transactions from Up Bank API for a specific account
 */
async function fetchUpTransactionsByAccount(
	apiKey: string,
	accountId: string,
	sinceDate: string
): Promise<TransactionResource[]> {
	const transactions: TransactionResource[] = [];
	// Format date in RFC-3339 with Australian Eastern timezone
	const formattedDate = `${sinceDate}T00:00:00+11:00`;
	let nextUrl:
		| string
		| null = `https://api.up.com.au/api/v1/accounts/${accountId}/transactions?filter[since]=${encodeURIComponent(formattedDate)}&page[size]=100`;

	while (nextUrl) {
		const response = await fetch(nextUrl, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			throw new Error(`Up Bank API error: ${response.status} ${response.statusText}`);
		}

		const data: TransactionsResponse = await response.json();
		transactions.push(...data.data);

		// Handle pagination
		nextUrl = data.links.next;
	}

	return transactions;
}

/**
 * Transform Up transactions and sync to YNAB
 */
async function syncToYNAB(
	ynabToken: string,
	budgetId: string,
	accountId: string,
	upTransactions: TransactionResource[]
): Promise<AccountSyncResult> {
	const ynab = new YNAB.API(ynabToken);

	// Transform Up transactions to YNAB format
	const ynabTransactions = upTransactions.map((upTx) => {
		// Convert amount: Up uses negative for expenses, YNAB uses milliunits
		const amountInMilliunits = Math.round(parseFloat(upTx.attributes?.amount?.value || '0') * 1000);

		// Use settled date, fallback to created date
		const date = upTx.attributes?.settledAt || upTx.attributes?.createdAt || new Date().toISOString();

		// Generate unique import_id using Up transaction ID (max 36 chars)
		const importId = `UPBANK:${upTx.id}`.substring(0, 36);

		// Map transaction status: HELD -> Uncleared, SETTLED -> Cleared
		const clearedStatus = upTx.attributes?.status === 'HELD'
			? YNAB.TransactionClearedStatus.Uncleared
			: YNAB.TransactionClearedStatus.Cleared;

		return {
			account_id: accountId,
			date: date.substring(0, 10), // Extract YYYY-MM-DD
			amount: amountInMilliunits,
			payee_name: upTx.attributes?.description || 'Unknown',
			memo: upTx.attributes?.message || undefined,
			cleared: clearedStatus,
			approved: false,
			import_id: importId,
		};
	});

	// Create transactions in YNAB (batch)
	if (ynabTransactions.length === 0) {
		return {
			imported: 0,
			duplicates: 0,
			total: 0,
		};
	}

	const result = await ynab.transactions.createTransactions(budgetId, {
		transactions: ynabTransactions,
	});

	const duplicateCount = result.data.duplicate_import_ids?.length || 0;
	const importedCount = ynabTransactions.length - duplicateCount;

	return {
		imported: importedCount,
		duplicates: duplicateCount,
		total: ynabTransactions.length,
	};
}
