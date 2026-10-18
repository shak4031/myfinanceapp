// Hand-maintained OpenAPI description used by the admin console's API explorer.
const op = (tag, summary, extra = {}) => ({ tags: [tag], summary, ...extra });
const body = example => ({ requestBody: { content: { 'application/json': { example } } } });
const pathId = { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] };
const query = (...names) => ({ parameters: names.map(name => ({ name, in: 'query', required: false, schema: { type: 'string' } })) });

export function openApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'MyFinanceApp API',
      version: '2.0.0',
      description: 'All endpoints use the signed-in session cookie. Customer data endpoints only ever return the signed-in account\'s data (PostgreSQL row-level security). Admin endpoints never return financial data. Every error includes a requestId you can search in the audit log.'
    },
    paths: {
      '/api/health': { get: op('System', 'Liveness check') },
      '/api/auth/status': { get: op('Auth', 'Setup and registration status') },
      '/api/auth/me': { get: op('Auth', 'Current user and active support session, if any') },
      '/api/auth/login': { post: op('Auth', 'Sign in', body({ email: 'you@example.com', password: '************' })) },
      '/api/auth/logout': { post: op('Auth', 'Sign out and end any support session') },
      '/api/auth/register': { post: op('Auth', 'Create an account (only when ALLOW_REGISTRATION=true)', body({ name: 'Name', email: 'you@example.com', password: '************' })) },
      '/api/auth/password-reset/request': { post: op('Auth', 'Email a single-use password reset link', body({ email: 'you@example.com' })) },
      '/api/auth/password-reset/confirm': { post: op('Auth', 'Set a new password with a reset token; signs out all sessions', body({ token: '<from email link>', password: '************' })) },
      '/api/auth/end-support': { post: op('Support', 'End the current support session') },
      '/api/support-access': {
        get: op('Support', 'Customer: list my support grants and support activity on my account'),
        post: op('Support', 'Customer: grant support access', body({ accessLevel: 'read', hours: 24, reason: 'Upcoming payments look wrong' }))
      },
      '/api/support-access/{id}': { delete: op('Support', 'Customer: revoke a support grant immediately', pathId) },
      '/api/admin/overview': { get: op('Admin', 'Health, configuration and 24-hour security/error counts') },
      '/api/admin/users': { get: op('Admin', 'Search accounts (no financial data)', query('q')) },
      '/api/admin/audit': { get: op('Admin', 'Search the audit and error log', query('eventType', 'outcome', 'userId', 'requestId', 'email', 'beforeId', 'limit')) },
      '/api/admin/logs': { get: op('Admin', 'Redacted application logs with grouped problems (level: error|warn|info; since: 15m, 24h, 7d or ISO time)', query('level', 'since', 'q', 'requestId', 'limit')) },
      '/api/admin/users/{id}/password-reset': { post: op('Admin', 'Email the user a password reset link (admin never sees it)', pathId) },
      '/api/admin/users/{id}/revoke-sessions': { post: op('Admin', 'Sign the user out everywhere', pathId) },
      '/api/admin/users/{id}/unlock': { post: op('Admin', 'Clear failed-attempt lockouts for the user', pathId) },
      '/api/admin/users/{id}/license': { post: op('Admin', 'Grant Pro or Pro Plus, change plan, or revoke paid access (plan: pro or pro_plus; default pro)', pathId, body({ action: 'grant', plan: 'pro_plus' })) },
      '/api/admin/support-grants': { get: op('Admin', 'Active support grants customers have given') },
      '/api/admin/support-sessions': { post: op('Admin', 'Start a consented support session (view as customer)', body({ grantId: 1 })) },
      '/api/dashboard/summary': { post: op('Finance', 'Income, spending and balance summary', body({ dateFilter: 'current' })) },
      '/api/dashboard/upcoming-payments': { post: op('Finance', 'Fixed payments: paid and still due this month', body({})) },
      '/api/dashboard/monthly-cashflow': { get: op('Finance', 'Monthly income and spending') },
      '/api/dashboard/category-spending': { post: op('Finance', 'Spending by category', body({ dateFilter: 'current' })) },
      '/api/transactions': { post: op('Finance', 'List transactions', body({ dateFilter: 'current' })) },
      '/api/transactions/categorization-rules': { get: op('Finance', 'List categorization rules') },
      '/api/transactions/categorization-preview': { post: op('Finance', 'Preview category suggestions', body({ scope: 'uncategorized' })) },
      '/api/transactions/update-pay-mode': { post: op('Finance', "Mark outgoing payments as auto-pay or manual (pay_mode 'auto', 'manual' or null)", body({ ids: [1], pay_mode: 'auto' })) },
      '/api/transactions/income-sources': { get: op('Finance', 'Deposits grouped by sender with whether each counts as income and why') },
      '/api/transactions/update-income-role': { post: op('Finance', "Override income detection for deposits (income_role 'income', 'other' or null to auto-detect)", body({ ids: [1], income_role: 'other' })) },
      '/api/debts': { get: op('Pro Plus', 'List debts; all debt operations require Pro Plus (402 PRO_PLUS_REQUIRED otherwise)') },
      '/api/goals': { get: op('Pro Plus', 'List savings goals; all goal operations require Pro Plus') },
      '/api/goals/funding-analysis': { get: op('Pro Plus', 'Goal funding plan and coaching') },
      '/api/plan': { get: op('Pro Plus', 'Debt and savings plan; all plan operations require Pro Plus') },
      '/api/categories': { get: op('Finance', 'List categories') },
      '/api/license': { get: op('Pro', 'Current plan, trial status, active (Pro), plusActive (Pro Plus), any pending plan request, pricing and feature lists') },
      '/api/license/trial': { post: op('Pro', 'Start the one-time 7-day MyFinance Pro Plus trial; no automatic charge', body({})) },
      '/api/license/request': {
        post: op('Pro', 'Choose a paid plan (pro or pro_plus). Saves a pending request for an administrator to approve; nothing is charged', body({ plan: 'pro_plus' })),
        delete: op('Pro', 'Cancel the pending plan request')
      },
      '/api/budgets': { get: op('Pro', 'Monthly category budgets'), put: op('Pro', 'Replace monthly category budgets', body({ budgets: [{ category: 'Groceries', amount: 600 }] })) },
      '/api/analytics': { get: op('Pro', 'Category signals, KPIs, forecast, cash flow, anomalies, subscriptions and merchants') },
      '/api/analytics/export.csv': { get: op('Pro', 'CSV export of transactions or category analytics', query('type', 'from', 'to')) }
    }
  };
}
