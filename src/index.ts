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

/**
 * Helper function to check API key authentication
 */
function checkAuth(request: Request, env: Env): string | null {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return 'Missing Authorization header';
	}

	const apiKey = authHeader.substring(7);
	if (apiKey !== env.API_KEY) {
		return 'Invalid API key';
	}

	return null;
}

/**
 * Helper function to create JSON error responses
 */
function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/**
 * Helper function to create JSON responses
 */
function jsonResponse(data: any, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
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
			console.error('❌ Cron sync error details:', {
				message: error instanceof Error ? error.message : 'Unknown error',
				stack: error instanceof Error ? error.stack : undefined,
				name: error instanceof Error ? error.name : undefined,
			});
		}
	},

	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// GET /up/accounts endpoint - List Up Bank accounts
		if (request.method === 'GET' && url.pathname === '/up/accounts') {
			const authError = checkAuth(request, env);
			if (authError) {
				return jsonError(authError, 401);
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

				return jsonResponse({ accounts });
			} catch (error) {
				console.error('Up Bank accounts error:', error);
				return jsonError(error instanceof Error ? error.message : 'Unknown error occurred', 500);
			}
		}

		// POST /webhook/create endpoint - Create Up Bank webhook
		if (request.method === 'POST' && url.pathname === '/webhook/create') {
			const authError = checkAuth(request, env);
			if (authError) {
				return jsonError(authError, 401);
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

				return jsonResponse({
					webhook_id: data.data.id,
					webhook_url: webhookUrl,
					secret_key: secretKey,
					message: 'Webhook created! IMPORTANT: Save the secret_key to your UP_WEBHOOK_SECRET environment variable. It will not be shown again.',
				}, 201);
			} catch (error) {
				console.error('Webhook creation error:', error);
				return jsonError(error instanceof Error ? error.message : 'Unknown error occurred', 500);
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
					return jsonError('Missing signature header', 401);
				}

				// Verify webhook signature
				if (env.UP_WEBHOOK_SECRET) {
					console.log('🔍 Verifying signature...');
					const isValid = await verifyWebhookSignature(body, signature, env.UP_WEBHOOK_SECRET);
					console.log('✅ Signature valid:', isValid);
					if (!isValid) {
						console.log('❌ Invalid signature');
						return jsonError('Invalid signature', 401);
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
						return jsonResponse({ message: 'Account not mapped, skipped' });
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

					return jsonResponse({
						message: 'Transaction processed',
						imported: result.imported,
						duplicate: result.duplicates > 0,
					});
				}

				// Handle TRANSACTION_DELETED events
				if (eventType === 'TRANSACTION_DELETED') {
					const transactionId = event.data.relationships.transaction.data.id;
					console.log('🗑️ Transaction deleted in Up Bank:', transactionId);

					// Parse account mapping from env
					const accountMapping: Record<string, string> = JSON.parse(env.ACCOUNT_MAPPING);

					// Find and delete the corresponding YNAB transaction
					const result = await deleteFromYNAB(
						env.YNAB_PERSONAL_ACCESS_TOKEN,
						env.YNAB_BUDGET_ID,
						accountMapping,
						transactionId
					);

					console.log('✅ Delete result:', JSON.stringify(result));

					return jsonResponse({
						message: 'Transaction deleted',
						deleted: result.deleted,
						notFound: result.notFound,
					});
				}

				// For other event types (PING), just acknowledge
				console.log('ℹ️ Event acknowledged');
				return jsonResponse({ message: 'Event received', type: eventType });
			} catch (error) {
				console.error('❌ Webhook processing error:', error);
				console.error('❌ Error details:', {
					message: error instanceof Error ? error.message : 'Unknown error',
					stack: error instanceof Error ? error.stack : undefined,
					name: error instanceof Error ? error.name : undefined,
				});
				return jsonError(error instanceof Error ? error.message : 'Unknown error occurred', 500);
			}
		}

		// GET /ynab/info endpoint - List budgets and accounts
		if (request.method === 'GET' && url.pathname === '/ynab/info') {
			const authError = checkAuth(request, env);
			if (authError) {
				return jsonError(authError, 401);
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

				return jsonResponse({
					budgets,
					configured_budget_id: env.YNAB_BUDGET_ID,
					accounts,
				});
			} catch (error) {
				console.error('YNAB info error:', error);
				return jsonError(error instanceof Error ? error.message : 'Unknown error occurred', 500);
			}
		}

		// POST /resync-all-dryrun endpoint - Preview what resync-all would do
		if (request.method === 'POST' && url.pathname === '/resync-all-dryrun') {
			const authError = checkAuth(request, env);
			if (authError) {
				return jsonError(authError, 401);
			}

			try {
				const result = await performResyncAll(env, true);
				return jsonResponse(result);
			} catch (error) {
				console.error('❌ Resync dryrun error:', error);
				return jsonError(error instanceof Error ? error.message : 'Unknown error occurred', 500);
			}
		}

		// POST /resync-all endpoint - Resync all transactions from earliest YNAB date
		if (request.method === 'POST' && url.pathname === '/resync-all') {
			const authError = checkAuth(request, env);
			if (authError) {
				return jsonError(authError, 401);
			}

			try {
				const result = await performResyncAll(env, false);
				return jsonResponse(result);
			} catch (error) {
				console.error('❌ Resync error:', error);
				return jsonError(error instanceof Error ? error.message : 'Unknown error occurred', 500);
			}
		}

		// POST /sync endpoint
		if (request.method === 'POST' && url.pathname === '/sync') {
			const authError = checkAuth(request, env);
			if (authError) {
				return jsonError(authError, 401);
			}

			// Parse and validate request body
			let body: SyncRequest;
			try {
				body = await request.json();
			} catch {
				return jsonError('Invalid JSON body', 400);
			}

			if (!body.startDate) {
				return jsonError('Missing required field: startDate', 400);
			}

			// Validate date format (YYYY-MM-DD)
			const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
			if (!dateRegex.test(body.startDate)) {
				return jsonError('startDate must be in YYYY-MM-DD format', 400);
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

				return jsonResponse({
					imported: totalImported,
					duplicates: totalDuplicates,
					total: totalTransactions,
					accounts: accountResults,
				});
			} catch (error) {
				console.error('❌ Sync error:', error);
				console.error('❌ Sync error details:', {
					message: error instanceof Error ? error.message : 'Unknown error',
					stack: error instanceof Error ? error.stack : undefined,
					name: error instanceof Error ? error.name : undefined,
				});
				return jsonError(error instanceof Error ? error.message : 'Unknown error occurred', 500);
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

	try {
		while (nextUrl) {
			const response = await fetch(nextUrl, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('❌ Up Bank API error:', {
					status: response.status,
					statusText: response.statusText,
					accountId,
					sinceDate,
					errorBody: errorText,
				});
				throw new Error(`Up Bank API error: ${response.status} ${response.statusText}`);
			}

			const data: TransactionsResponse = await response.json();
			transactions.push(...data.data);

			// Handle pagination
			nextUrl = data.links.next;
		}

		return transactions;
	} catch (error) {
		console.error('❌ Failed to fetch Up Bank transactions:', {
			accountId,
			sinceDate,
			error: error instanceof Error ? error.message : 'Unknown error',
		});
		throw error;
	}
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
		const upStatus = upTx.attributes?.status;
		const clearedStatus = upStatus === 'HELD'
			? YNAB.TransactionClearedStatus.Uncleared
			: upStatus === 'SETTLED'
			? YNAB.TransactionClearedStatus.Cleared
			: YNAB.TransactionClearedStatus.Uncleared; // Default to Uncleared for unknown statuses

		// Log transaction status mapping for diagnostics
		console.log(`📊 Transaction ${upTx.id.substring(0, 8)}... status mapping:`, {
			upStatus,
			clearedStatus,
			description: upTx.attributes?.description,
			amount: upTx.attributes?.amount?.value,
			settledAt: upTx.attributes?.settledAt,
			createdAt: upTx.attributes?.createdAt,
		});

		// Warn if status is unexpected
		if (upStatus !== 'HELD' && upStatus !== 'SETTLED') {
			console.warn(`⚠️ Unexpected Up Bank transaction status: "${upStatus}" for transaction ${upTx.id}`);
		}

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

	try {
		console.log(`💾 Sending ${ynabTransactions.length} transactions to YNAB...`);

		const result = await ynab.transactions.createTransactions(budgetId, {
			transactions: ynabTransactions,
		});

		const duplicateCount = result.data.duplicate_import_ids?.length || 0;
		const importedCount = ynabTransactions.length - duplicateCount;

		// Log detailed results
		console.log('📋 YNAB API Response:', {
			totalSent: ynabTransactions.length,
			imported: importedCount,
			duplicates: duplicateCount,
			duplicateIds: result.data.duplicate_import_ids,
		});

		// Log a sample of successfully created transactions
		if (result.data.transactions && result.data.transactions.length > 0) {
			console.log('✅ Sample of created transactions:');
			result.data.transactions.slice(0, 3).forEach(tx => {
				console.log(`  - ${tx.payee_name}: ${tx.amount / 1000} (cleared: ${tx.cleared})`);
			});
		}

		// Update cleared status for duplicate transactions
		let updatedCount = 0;
		if (duplicateCount > 0 && result.data.duplicate_import_ids) {
			console.log(`🔄 Updating cleared status for ${duplicateCount} duplicate transactions...`);

			try {
				// We need to fetch existing YNAB transactions to get their IDs
				// Create a map of import_id -> desired cleared status
				const duplicateImportIds = result.data.duplicate_import_ids;
				const desiredClearedStatus = new Map(
					ynabTransactions
						.filter(tx => duplicateImportIds.includes(tx.import_id!))
						.map(tx => [tx.import_id!, tx.cleared!])
				);

				console.log(`📥 Fetching existing YNAB transactions for account to find transaction IDs...`);

				// Fetch recent transactions from YNAB to get their IDs
				const existingTxResponse = await ynab.transactions.getTransactionsByAccount(budgetId, accountId);
				const existingTransactions = existingTxResponse.data.transactions;

				console.log(`📋 Found ${existingTransactions.length} existing transactions in YNAB`);

				// Match by import_id and prepare updates for transactions with different cleared status
				const transactionsToUpdate = existingTransactions
					.filter(tx => {
						const desiredStatus = desiredClearedStatus.get(tx.import_id || '');
						return desiredStatus && tx.cleared !== desiredStatus;
					})
					.map(tx => ({
						id: tx.id,
						cleared: desiredClearedStatus.get(tx.import_id || '')!,
					}));

				if (transactionsToUpdate.length > 0) {
					console.log(`📝 Updating ${transactionsToUpdate.length} transactions with changed cleared status...`);
					const updateResult = await ynab.transactions.updateTransactions(budgetId, {
						transactions: transactionsToUpdate,
					});

					updatedCount = updateResult.data.transactions?.length || 0;
					console.log(`✅ Successfully updated ${updatedCount} transaction(s)`);

					// Log sample of updated transactions
					if (updateResult.data.transactions && updateResult.data.transactions.length > 0) {
						console.log('📊 Sample of updated transactions:');
						updateResult.data.transactions.slice(0, 3).forEach(tx => {
							console.log(`  - ${tx.payee_name}: ${tx.amount / 1000} (cleared: ${tx.cleared})`);
						});
					}
				} else {
					console.log(`✓ All duplicate transactions already have correct cleared status`);
				}
			} catch (updateError) {
				console.error('⚠️ Error updating duplicate transactions:', updateError);
				console.error('⚠️ Update error details:', {
					message: updateError instanceof Error ? updateError.message : 'Unknown error',
					duplicates: duplicateCount,
				});
				// Don't throw - we still successfully created/detected transactions
			}
		}

		return {
			imported: importedCount,
			duplicates: duplicateCount,
			total: ynabTransactions.length,
		};
	} catch (error) {
		console.error('❌ YNAB API error:', error);
		console.error('❌ YNAB API error details:', {
			message: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			name: error instanceof Error ? error.name : undefined,
			budgetId,
			accountId,
			transactionCount: ynabTransactions.length,
		});
		throw error;
	}
}

/**
 * Delete a transaction from YNAB by Up Bank transaction ID
 */
async function deleteFromYNAB(
	ynabToken: string,
	budgetId: string,
	accountMapping: Record<string, string>,
	upTransactionId: string
): Promise<{ deleted: boolean; notFound: boolean }> {
	const ynab = new YNAB.API(ynabToken);
	const importId = `UPBANK:${upTransactionId}`.substring(0, 36);

	console.log(`🔍 Looking for YNAB transaction with import_id: ${importId}`);

	// Search through all mapped accounts to find the transaction
	for (const ynabAccountId of Object.values(accountMapping)) {
		try {
			const response = await ynab.transactions.getTransactionsByAccount(budgetId, ynabAccountId);
			const transaction = response.data.transactions.find((tx) => tx.import_id === importId);

			if (transaction) {
				console.log(`📍 Found transaction in YNAB account ${ynabAccountId}:`, {
					id: transaction.id,
					payee: transaction.payee_name,
					amount: transaction.amount / 1000,
				});

				// Delete the transaction
				await ynab.transactions.deleteTransaction(budgetId, transaction.id);
				console.log(`🗑️ Successfully deleted YNAB transaction: ${transaction.id}`);

				return { deleted: true, notFound: false };
			}
		} catch (error) {
			console.error(`⚠️ Error searching account ${ynabAccountId}:`, error);
			// Continue searching other accounts
		}
	}

	console.log(`⚠️ Transaction with import_id ${importId} not found in YNAB`);
	return { deleted: false, notFound: true };
}

interface OrphanedTransaction {
	ynabId: string;
	upId: string;
	payee: string;
	amount: number;
	date: string;
}

interface RestoredTransaction {
	upId: string;
	payee: string;
	amount: number;
	date: string;
}

interface ResyncAllResult {
	message: string;
	dryRun: boolean;
	earliestDate?: string;
	imported: number;
	duplicates: number;
	total: number;
	orphanedDeleted: number;
	orphanedTransactions: OrphanedTransaction[];
	restoredCount: number;
	restoredTransactions: RestoredTransaction[];
	accounts: Array<{
		upAccountId: string;
		ynabAccountId: string;
		imported: number;
		duplicates: number;
	}>;
}

/**
 * Perform full resync from earliest YNAB date, including orphan detection
 */
async function performResyncAll(env: Env, dryRun: boolean): Promise<ResyncAllResult> {
	const mode = dryRun ? '🔍 DRY RUN' : '🔄 LIVE';
	console.log(`${mode}: Starting full resync from earliest YNAB transaction date...`);

	const ynab = new YNAB.API(env.YNAB_PERSONAL_ACCESS_TOKEN);
	const accountMapping: Record<string, string> = JSON.parse(env.ACCOUNT_MAPPING);

	// Collect all YNAB transactions with Up Bank import_ids
	const ynabTransactionsByAccount: Map<string, Array<{ id: string; import_id: string; payee_name: string; amount: number; date: string }>> = new Map();
	let earliestDate: string | null = null;

	for (const ynabAccountId of Object.values(accountMapping)) {
		console.log(`📅 Fetching YNAB transactions for account: ${ynabAccountId}`);
		const response = await ynab.transactions.getTransactionsByAccount(env.YNAB_BUDGET_ID, ynabAccountId);

		const upBankTransactions = response.data.transactions
			.filter((tx) => tx.import_id?.startsWith('UPBANK:') && !tx.deleted)
			.map((tx) => ({
				id: tx.id,
				import_id: tx.import_id!,
				payee_name: tx.payee_name || 'Unknown',
				amount: tx.amount,
				date: tx.date,
			}));

		ynabTransactionsByAccount.set(ynabAccountId, upBankTransactions);

		for (const tx of response.data.transactions) {
			if (!tx.deleted && (!earliestDate || tx.date < earliestDate)) {
				earliestDate = tx.date;
			}
		}
	}

	if (!earliestDate) {
		console.log('⚠️ No existing transactions found in YNAB');
		return {
			message: 'No existing transactions found in YNAB, nothing to resync',
			dryRun,
			imported: 0,
			duplicates: 0,
			total: 0,
			orphanedDeleted: 0,
			orphanedTransactions: [],
			restoredCount: 0,
			restoredTransactions: [],
			accounts: [],
		};
	}

	console.log(`📅 Earliest transaction date found: ${earliestDate}`);

	// Fetch all transactions including deleted to find ones that need restoration
	console.log('🔍 Fetching deleted YNAB transactions to check for restorations...');
	const allTransactionsResponse = await ynab.transactions.getTransactions(
		env.YNAB_BUDGET_ID,
		undefined, // sinceDate
		undefined, // type
		0 // last_knowledge_of_server (0 = include deleted)
	);

	// Build sets of deleted and active import_ids
	const deletedUpbankImportIds = new Set<string>();
	const activeUpbankImportIds = new Set<string>();

	for (const tx of allTransactionsResponse.data.transactions) {
		if (tx.import_id?.startsWith('UPBANK:')) {
			if (tx.deleted) {
				deletedUpbankImportIds.add(tx.import_id);
			} else {
				activeUpbankImportIds.add(tx.import_id);
			}
		}
	}

	// Only restore transactions that are deleted AND not already active
	// (some may have been manually re-created or re-synced)
	const restorableImportIds = new Set(
		[...deletedUpbankImportIds].filter(id => !activeUpbankImportIds.has(id))
	);

	console.log(`🔍 Found ${deletedUpbankImportIds.size} deleted, ${activeUpbankImportIds.size} active UPBANK transactions`);
	console.log(`🔍 ${restorableImportIds.size} are restorable (deleted but not re-created)`);

	// Fetch all Up Bank transactions and build a set of existing IDs
	// Note: import_id is limited to 36 chars, so UPBANK:{uuid} gets truncated
	// We need to store truncated IDs for comparison (36 - 7 = 29 chars for UUID)
	const upBankIds = new Set<string>();

	// Also collect transactions that need to be restored (deleted in YNAB but still exist in Up Bank)
	const transactionsToRestore: Array<{
		upTx: TransactionResource;
		ynabAccountId: string;
	}> = [];

	for (const [upAccountId, ynabAccountId] of Object.entries(accountMapping)) {
		console.log(`📥 Fetching Up Bank transactions for account: ${upAccountId}`);
		const upTransactions = await fetchUpTransactionsByAccount(env.UP_BANK_API_KEY, upAccountId, earliestDate);
		console.log(`📥 Fetched ${upTransactions.length} transactions from Up Bank`);

		for (const tx of upTransactions) {
			// Truncate to match how we store in import_id (36 - 7 for "UPBANK:" = 29 chars)
			const truncatedId = tx.id.substring(0, 29);
			upBankIds.add(truncatedId);

			// Check if this transaction was deleted in YNAB and needs restoration
			// Only restore if deleted AND not already re-created as active
			const importId = `UPBANK:${tx.id}`.substring(0, 36);
			if (restorableImportIds.has(importId)) {
				transactionsToRestore.push({ upTx: tx, ynabAccountId });
			}
		}
	}

	console.log(`🔄 Found ${transactionsToRestore.length} deleted transactions to restore`);

	console.log(`📊 Total Up Bank transaction IDs: ${upBankIds.size}`);

	// Find orphaned transactions (in YNAB but not in Up Bank)
	const orphanedTransactions: OrphanedTransaction[] = [];

	for (const [, ynabTxs] of ynabTransactionsByAccount) {
		for (const tx of ynabTxs) {
			const upId = tx.import_id.replace('UPBANK:', '');
			if (!upBankIds.has(upId)) {
				orphanedTransactions.push({
					ynabId: tx.id,
					upId,
					payee: tx.payee_name,
					amount: tx.amount / 1000,
					date: tx.date,
				});
			}
		}
	}

	console.log(`🗑️ Found ${orphanedTransactions.length} orphaned transactions`);

	// Delete orphaned transactions (unless dry run)
	let orphanedDeleted = 0;
	if (!dryRun && orphanedTransactions.length > 0) {
		for (const orphan of orphanedTransactions) {
			try {
				console.log(`🗑️ Deleting orphaned transaction: ${orphan.payee} (${orphan.amount}) on ${orphan.date}`);
				await ynab.transactions.deleteTransaction(env.YNAB_BUDGET_ID, orphan.ynabId);
				orphanedDeleted++;
			} catch (error) {
				console.error(`⚠️ Failed to delete orphan ${orphan.ynabId}:`, error);
			}
		}
	}

	// Restore deleted transactions (re-create WITHOUT import_id so YNAB accepts them)
	const restoredTransactions: RestoredTransaction[] = [];
	let restoredCount = 0;

	if (!dryRun && transactionsToRestore.length > 0) {
		console.log(`🔄 Restoring ${transactionsToRestore.length} deleted transactions...`);

		// Group by account for batch creation
		const byAccount = new Map<string, TransactionResource[]>();
		for (const { upTx, ynabAccountId } of transactionsToRestore) {
			if (!byAccount.has(ynabAccountId)) byAccount.set(ynabAccountId, []);
			byAccount.get(ynabAccountId)!.push(upTx);
		}

		for (const [ynabAccountId, upTxs] of byAccount) {
			const restoredTxs = upTxs.map(upTx => ({
				account_id: ynabAccountId,
				date: (upTx.attributes?.settledAt || upTx.attributes?.createdAt || new Date().toISOString()).substring(0, 10),
				amount: Math.round(parseFloat(upTx.attributes?.amount?.value || '0') * 1000),
				payee_name: upTx.attributes?.description || 'Unknown',
				memo: upTx.attributes?.message || undefined,
				cleared: upTx.attributes?.status === 'HELD'
					? YNAB.TransactionClearedStatus.Uncleared
					: YNAB.TransactionClearedStatus.Cleared,
				approved: false,
				// NO import_id - this is key! YNAB rejects re-used import_ids
			}));

			try {
				await ynab.transactions.createTransactions(env.YNAB_BUDGET_ID, { transactions: restoredTxs });
				restoredCount += restoredTxs.length;

				// Track restored transactions for reporting
				for (const upTx of upTxs) {
					restoredTransactions.push({
						upId: upTx.id,
						payee: upTx.attributes?.description || 'Unknown',
						amount: parseFloat(upTx.attributes?.amount?.value || '0'),
						date: (upTx.attributes?.settledAt || upTx.attributes?.createdAt || '').substring(0, 10),
					});
				}
				console.log(`✅ Restored ${restoredTxs.length} transactions for account ${ynabAccountId}`);
			} catch (error) {
				console.error(`⚠️ Failed to restore transactions for account ${ynabAccountId}:`, error);
			}
		}
	} else if (transactionsToRestore.length > 0) {
		// Dry run - just track what would be restored
		for (const { upTx } of transactionsToRestore) {
			restoredTransactions.push({
				upId: upTx.id,
				payee: upTx.attributes?.description || 'Unknown',
				amount: parseFloat(upTx.attributes?.amount?.value || '0'),
				date: (upTx.attributes?.settledAt || upTx.attributes?.createdAt || '').substring(0, 10),
			});
		}
	}

	// Sync all mapped accounts from the earliest date
	const accountResults = [];
	let totalImported = 0;
	let totalDuplicates = 0;
	let totalTransactions = 0;

	if (!dryRun) {
		for (const [upAccountId, ynabAccountId] of Object.entries(accountMapping)) {
			console.log(`🔄 Processing account: ${upAccountId}`);

			const upTransactions = await fetchUpTransactionsByAccount(env.UP_BANK_API_KEY, upAccountId, earliestDate);

			const result = await syncToYNAB(
				env.YNAB_PERSONAL_ACCESS_TOKEN,
				env.YNAB_BUDGET_ID,
				ynabAccountId,
				upTransactions
			);

			console.log(`✅ Result for account:`, JSON.stringify(result));

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
	}

	const message = dryRun ? 'Dry run complete - no changes made' : 'Full resync complete';

	console.log(`📊 ${message}:`, JSON.stringify({
		earliestDate,
		totalImported,
		totalDuplicates,
		totalTransactions,
		orphanedDeleted,
		orphanedCount: orphanedTransactions.length,
		restoredCount,
		restoredTransactions: restoredTransactions.length,
	}));

	return {
		message,
		dryRun,
		earliestDate,
		imported: totalImported,
		duplicates: totalDuplicates,
		total: totalTransactions,
		orphanedDeleted,
		orphanedTransactions,
		restoredCount,
		restoredTransactions,
		accounts: accountResults,
	};
}
