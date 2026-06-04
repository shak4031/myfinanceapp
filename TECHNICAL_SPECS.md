# MyFinanceApp Dashboard - Technical Specifications

## Architecture Overview

### Data Flow

```
User selects date filter
         ↓
Frontend calls /api/dashboard/summary
         ↓
Backend calculates 3-month historical average (ignores date filter)
         ↓
Returns: { income, expenses, balance, historicalMonths }
         ↓
Frontend displays metrics with labels indicating "3-month average" vs "Latest"
```

### Components

#### 1. Dashboard Page
- **Metrics Section**: Shows 4 key metrics
  - Avg Monthly Income (3-month)
  - Avg Monthly Expenses (3-month)
  - Avg Net Cashflow (3-month)
  - Current Balance (latest)
  
- **Recurring Payments Section**: Shows detected subscriptions/bills
  - Grouped by category type (Streaming, Utilities, etc.)
  - Shows monthly total per type
  - Lists each recurring item with details
  
- **Spending by Category Section**: Respects date filter
  - Shows top 8 categories for period
  - Shows amount and transaction count
  - Clickable to see detail view
  
- **Recent Transactions Section**: List view
  - Shows 15 most recent transactions
  - Respects date filter
  - Date, description, amount, debit/credit indicator

#### 2. Categories Page
- **Overview**: All categories with totals
  - Calculated from trends (month-over-month aggregation)
  - Sorted by spending
  - Clickable for detail view
  
- **Category Detail**: Specific category analysis
  - Stats: Total, Count, Average, Highest
  - Monthly Breakdown: Shows each month's spending
  - Transactions: Full list of category transactions

## Database Schema

### Transactions Table
```sql
CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  date TEXT,              -- ISO format "YYYY-MM-DD"
  description TEXT,       -- Merchant name, important for recurring detection
  category TEXT,          -- Category assigned to transaction
  amount REAL,            -- Transaction amount (always positive)
  direction TEXT,         -- "debit" or "credit"
  balance REAL,           -- Running balance after transaction
  source TEXT,            -- Bank/card source
  user_id INTEGER         -- User ID (currently fixed to 1)
)
```

**Critical Fields**:
- `date`: Must be valid ISO date for DATE_TRUNC
- `description`: Used to detect recurring payments via regex
- `direction`: "debit" for expenses, "credit" for income
- `amount`: Always positive, direction indicates +/-

## Key Algorithms

### Historical Averages Algorithm
```
1. Get current date
2. Calculate 3-month lookback (first day of month 2 months ago)
3. Query all transactions in that period
4. GROUP BY month, calculate SUM(income) and SUM(expenses)
5. Calculate average: sum / number_of_months
6. Return averages with monthly breakdown
```

**Why this works**:
- Removes date filter noise
- Gives realistic monthly expectations
- Shows consistent trends
- Ignores incomplete current month

### Recurring Payment Detection Algorithm
```
1. Query all expense transactions
2. GROUP BY description, amount, day_of_month
3. Filter for COUNT(*) >= 2 (appears 2+ times)
4. Filter for keyword match (netflix, mortgage, insurance, etc.)
5. Categorize based on description keywords
6. Return sorted by frequency and last date
```

**Why this works**:
- Finds actual patterns in history
- Combines frequency + keyword matching
- Catches subscriptions even if not regular
- Self-updates as new transactions added

### Subscription Categorization Algorithm
```
1. Convert description to lowercase
2. Test against regex patterns in order:
   - Netflix → "streaming"
   - Spotify → "streaming"
   - Mortgage → "housing"
   - Gym → "wellness"
   - etc.
3. Return type and friendly name
4. Default to "subscription" if no match
```

**Why this works**:
- Fast O(1) regex matching
- Prioritizes specific services first
- Fallback for unknown subscriptions
- Easily extensible with new patterns

### Category Spending by Date Algorithm
```
1. Parse date filter to startDate/endDate
2. Query transactions in date range
3. GROUP BY category AND DATE_TRUNC('month', date)
4. Aggregate into structure:
   {
     "categoryName": {
       "totalSpending": sum_across_months,
       "transactionCount": total_txns,
       "monthlyBreakdown": [
         { "month": "2026-06-01", "spending": 400 },
         { "month": "2026-05-01", "spending": 450 }
       ]
     }
   }
5. Sort by totalSpending DESC
```

**Why this works**:
- Respects date filter properly
- Provides both aggregate and detail
- Sorted by relevance (top spenders first)
- Month-by-month detail available if needed

## API Specifications

### POST /api/dashboard/summary

**Request**:
```json
{
  "dateFilter": "current"  // or "last", "ytd", "all"
}
```

**Response**:
```json
{
  "income": 6200.50,
  "expenses": 7500.25,
  "netCashflow": -1299.75,
  "balance": 6120.65,
  "period": {
    "startDate": "2026-06-01",
    "endDate": "2026-06-30"
  },
  "historicalMonths": [
    {
      "month": "2026-06-01",
      "income": 12400,
      "expenses": 7500
    },
    {
      "month": "2026-05-01",
      "income": 12400,
      "expenses": 7300
    }
  ]
}
```

**Notes**:
- `income/expenses/netCashflow` = 3-month averages (ignores dateFilter)
- `balance` = latest balance (ignores dateFilter)
- `period` = date range based on dateFilter (for informational purposes)
- `historicalMonths` = breakdown of the 3 months used for averaging

### POST /api/dashboard/recurring-payments

**Request**: `{}`

**Response**:
```json
[
  {
    "description": "Netflix Monthly",
    "amount": 15.99,
    "dayOfMonth": 5,
    "lastDate": "2026-06-05",
    "frequency": 3,
    "category": {
      "type": "streaming",
      "name": "Netflix"
    }
  }
]
```

**Notes**:
- Not affected by date filter
- Shows all detected recurring items
- Sorted by frequency DESC, then lastDate DESC
- Amount is always positive (direction is "debit" in DB)

### POST /api/dashboard/category-spending

**Request**:
```json
{
  "dateFilter": "current"
}
```

**Response**:
```json
[
  {
    "name": "Groceries",
    "totalSpending": 1250.75,
    "transactionCount": 12,
    "monthlyBreakdown": [
      {
        "month": "2026-06-01",
        "spending": 400,
        "transactions": 4
      }
    ]
  }
]
```

**Notes**:
- Respects dateFilter
- Only includes "debit" transactions
- Sorted by totalSpending DESC
- monthlyBreakdown shows each month in range

### POST /api/dashboard/category-trends

**Request**: `{}`

**Response**:
```json
{
  "2026-06-01": [
    {
      "category": "Groceries",
      "spending": 400,
      "transactions": 4
    },
    {
      "category": "Dining",
      "spending": 250,
      "transactions": 8
    }
  ],
  "2026-05-01": [
    {
      "category": "Groceries",
      "spending": 450,
      "transactions": 4
    }
  ]
}
```

**Notes**:
- Returns ALL months (no date filter)
- Object with months as keys
- Months in descending order
- Useful for month-over-month comparison

## Error Handling

### Database Connection Errors
```javascript
try {
  const result = await db.all(sql, params);
} catch (error) {
  log('DASHBOARD', `Error: ${error.message}`);
  return { error: error.message };
}
```

### Empty Results
- Metrics: Return 0 for averages if no transactions
- Recurring: Return empty array if no recurring found
- Category: Return empty array if no spending in period
- Trends: Return empty object if no transactions

### Validation
- All parameters parsed and validated
- Date ranges validated (start <= end)
- User ID hardcoded to 1 (future: add auth)
- Category field nullable (default "Other")

## Performance Characteristics

### Query Performance

| Query | Complexity | Notes |
|-------|-----------|-------|
| Historical Averages | O(n) GROUP BY month | Fast, few results |
| Recurring Detection | O(n) GROUP BY desc/amt/day | Medium, may need index |
| Category Spending | O(n) GROUP BY cat/month | Fast with dateFilter |
| Category Trends | O(n) GROUP BY cat/month | Slow, full table scan |

### Optimization Opportunities

1. **Index on (user_id, date)**: Speeds date-filtered queries
2. **Index on (user_id, direction, date)**: Speeds income/expense grouping
3. **Materialized View**: Cache recurring payments (updates daily)
4. **Caching Layer**: Cache historical averages (updates daily)

## Security Considerations

### Current Implementation
- User ID hardcoded to 1
- No authentication/authorization checks
- Direct SQL parameters (PostgreSQL prepared statements)

### For Production
1. Add user authentication
2. Validate user_id from JWT token
3. Add rate limiting on dashboard endpoints
4. Sanitize dateFilter parameter
5. Log all data access

## Testing Strategy

### Unit Tests
```javascript
// Test date range calculation
const range = getDateRange('current');
expect(range.startDate).toBe('2026-06-01');
expect(range.endDate).toBe('2026-06-30');

// Test historical averages
const avg = await getHistoricalAverages();
expect(avg.avgIncome).toBeGreaterThan(0);
expect(avg.months.length).toBeLessThanOrEqual(3);
```

### Integration Tests
```javascript
// Test full dashboard endpoint
const res = await fetch('/api/dashboard/summary', {...});
const data = await res.json();
expect(data.balance).toBeDefined();
expect(data.income).toBeGreaterThanOrEqual(0);
```

### Manual Testing
- [ ] Test with various date filters
- [ ] Test with empty database
- [ ] Test with single transaction
- [ ] Test with mixed income/expense transactions
- [ ] Test subscription detection with different description formats

## Future Enhancements

### Short Term
1. Add month picker dropdown (replace fixed filters)
2. Add budget vs. actual comparison
3. Add spending trend visualization (chart)
4. Add export to CSV

### Medium Term
1. Add year-over-year comparison
2. Add spending predictions using ML
3. Add anomaly detection (unusual transactions)
4. Add goal tracking

### Long Term
1. Multi-user support (per-user historical data)
2. Multiple currency support
3. Investment portfolio tracking
4. Financial advice recommendations

## Migration Guide

### From Old Dashboard (if different DB structure)
1. Ensure `date` field is ISO format "YYYY-MM-DD"
2. Ensure `direction` is "debit" or "credit"
3. Ensure `category` is populated (or "Other" default)
4. Ensure `balance` has latest running balance
5. Run test queries to verify data quality

### Database Migrations
```sql
-- Ensure transactions table has all required fields
ALTER TABLE transactions
  ADD COLUMN category TEXT DEFAULT 'Other',
  ADD COLUMN direction TEXT DEFAULT 'debit',
  ADD COLUMN balance REAL;

-- Create helpful indexes
CREATE INDEX idx_transactions_user_date 
  ON transactions(user_id, date);
CREATE INDEX idx_transactions_user_direction 
  ON transactions(user_id, direction);
```

## Debugging Guide

### Check Historical Averages Calculation
```javascript
// Query directly in dashboard.js
const result = await db.all(`
  SELECT 
    DATE_TRUNC('month', date::date)::date as month,
    SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) as income,
    SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END) as expenses
  FROM transactions
  WHERE user_id = 1 AND date >= '2026-04-01'
  GROUP BY DATE_TRUNC('month', date::date)
`);
console.log(result); // Should show 3 months of data
```

### Check Recurring Detection
```javascript
const result = await db.all(`
  SELECT 
    description, amount, COUNT(*) as freq,
    EXTRACT(DAY FROM date::date) as day
  FROM transactions
  WHERE user_id = 1 AND direction = 'debit'
  GROUP BY description, amount, day
  ORDER BY freq DESC
`);
console.log(result); // Find patterns
```

### Check Category Distribution
```javascript
const result = await db.all(`
  SELECT category, COUNT(*) as cnt
  FROM transactions
  WHERE user_id = 1
  GROUP BY category
  ORDER BY cnt DESC
`);
console.log(result); // See category coverage
```
