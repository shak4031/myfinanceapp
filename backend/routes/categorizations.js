const router = require('express').Router();

// Placeholder for database access, assuming db.js or similar module exists
// async function getRecentTransactions(limit = 500) { ... } // Assume this is defined and fetches data

// --- Mock Data & Helper Functions ---
const MOCK_TRANSACTIONS = [
    { id: 1, date: '2024-06-01', description: 'STARBUCKS COFFEE', amount: -5.50, currentCategory: 'Dining', previousCategory: null },
    { id: 2, date: '2024-06-01', description: 'AMAZON.COM* AB123', amount: -25.99, currentCategory: 'Shopping', previousCategory: null },
    { id: 3, date: '2024-06-01', description: 'NETFLIX.COM 8889', amount: -15.99, currentCategory: 'Entertainment', previousCategory: null }, // Potential Subscription
    { id: 4, date: '2024-06-02', description: 'STRIPE* WHOLE FOODS', amount: -55.20, currentCategory: 'Groceries', previousCategory: null },
    { id: 5, date: '2024-06-02', description: 'KLARNA* ORDER XYZ', amount: -30.00, currentCategory: 'Shopping', previousCategory: null }, // BNPL
    { id: 6, date: '2024-06-03', description: 'T-MOBILE 555-1234', amount: -70.00, currentCategory: 'Utilities', previousCategory: null }, // Potential Subscription
    { id: 7, date: '2024-06-03', description: 'ONLINE TRANSFER FROM CHASE', amount: 500.00, currentCategory: 'Transfer', previousCategory: null }, // Internal Transfer
    { id: 8, date: '2024-06-04', description: 'AMAZON.COM* CD456', amount: -12.50, currentCategory: 'Shopping', previousCategory: null },
    { id: 9, date: '2024-06-04', description: 'STARBUCKS COFFEE', amount: -4.80, currentCategory: 'Groceries', previousCategory: null }, // Inconsistent category for Starbucks
    { id: 10, date: '2024-06-04', description: 'KLARNA* PURCHASE UVW', amount: -45.00, currentCategory: 'Shopping', previousCategory: null }, // BNPL
    { id: 11, date: '2024-06-05', description: 'T-MOBILE 555-1234', amount: -70.00, currentCategory: 'Subscriptions', previousCategory: null }, // Consistent but recurring
    { id: 12, date: '2024-06-05', description: 'XFER TO SAVINGS', amount: -200.00, currentCategory: 'Transfer', previousCategory: null }, // Internal Transfer
    { id: 13, date: '2024-06-05', description: 'SPOTIFY USA GHIJK', amount: -9.99, currentCategory: 'Entertainment', previousCategory: null }, // Potential Subscription
    { id: 14, date: '2024-06-05', description: 'PAYPAL *KLARNA XYZ', amount: -60.00, currentCategory: 'Shopping', previousCategory: null }, // BNPL
    { id: 15, date: '2024-06-06', description: 'AMAZON DIGITAL SERVICES', amount: -1.99, currentCategory: 'Entertainment', previousCategory: null }, // Potential Subscription
    { id: 16, date: '2024-06-06', description: 'KLARNA* ITEM DEF', amount: -15.00, currentCategory: 'Shopping', previousCategory: null }, // BNPL
    { id: 17, date: '2024-06-06', description: 'STARBUCKS LOCATION 2', amount: -5.00, currentCategory: 'Dining', previousCategory: null },
    { id: 18, date: '2024-06-06', description: 'TRANSFER TO savings', amount: -100.00, currentCategory: 'Transfer', previousCategory: null }, // Transfer
    { id: 19, date: '2024-06-07', description: 'AMAZON.COM* GH789', amount: -8.99, currentCategory: 'Shopping', previousCategory: null },
    { id: 20, date: '2024-06-07', description: 'NETFLIX.COM 9999', amount: -15.99, currentCategory: 'Subscriptions', previousCategory: null }, // Consistent Subscription
];

// Fetches recent transactions (replace with actual DB call if not using mock)
async function getRecentTransactions(limit = 500) {
    console.log(`[Categorizations] Simulating fetching ${limit} recent transactions.`);
    // In a real app: return await db.query('SELECT * FROM transactions ORDER BY date DESC LIMIT ?', [limit]);
    return MOCK_TRANSACTIONS.slice(-limit); // Return the most recent 'limit' transactions
}

// --- Suggestion Logic ---
function generateSuggestions() {
    const transactions = getRecentTransactions();
    const suggestions = [];
    
    const keywordCategoryMap = {}; 
    const descriptionRecurrenceMap = {}; 
    const recurringPaymentThreshold = 2; 

    const bnplKeywords = ['KLARNA', 'AFTERPAY', 'AFFIRM', 'PAYPAL *KLARNA'];
    const transferKeywords = ['TRANSFER', 'XFER', 'PAYMENT FROM', 'PAYMENT TO', 'ONLINE TRANSFER'];

    // --- Analysis Pass ---
    transactions.forEach(tx => {
        const description = tx.description.toUpperCase();
        const category = tx.currentCategory;
        
        // --- 1. Categorization Inconsistency / Keyword Analysis ---
        const commonWords = new Set(['THE', 'AND', 'OF', 'IN', 'FOR', 'ON', 'WITH', 'A', 'AN', 'TO', 'FROM', 'BY', 'IS', 'IT', 'AM', 'ARE', 'WAS', 'WERE', 'BE', 'BEEN', 'THIS', 'THAT', 'YOU', 'YOUR', 'HAS', 'HAVE', 'DO', 'USE', 'USED', 'AT', 'ALSO', 'MORE', 'THAN', 'LIKE', 'NEW']);
        const descriptiveWords = description.split(/[\s*.-]+/);
        
        descriptiveWords.forEach(word => {
            if (word.length > 3 && isNaN(word) && !commonWords.has(word) && !transferKeywords.some(tk => description.includes(tk)) && !bnplKeywords.some(bk => description.includes(bk))) {
                if (!keywordCategoryMap[word]) {
                    keywordCategoryMap[word] = new Set();
                }
                if (category && category !== 'Transfer' && category !== 'Uncategorized') { 
                    keywordCategoryMap[word].add(category);
                }
            }
        });

        // --- 2. Recurrence / Subscription Identification ---
        let normalizedDescription = description;
        if (normalizedDescription.startsWith('STRIPE* ') || normalizedDescription.startsWith('PAYPAL* ') || normalizedDescription.startsWith('AMAZON.COM* ')) {
             normalizedDescription = normalizedDescription.substring(normalizedDescription.indexOf('*') + 1).trim();
        }
        if (normalizedDescription.endsWith(' USA')) {
            normalizedDescription = normalizedDescription.slice(0, -4).trim();
        }
        normalizedDescription = normalizedDescription.replace(/\d{5,}-?\d{3,}-?\d{3,}/g, '###NUMBER###'); 
        normalizedDescription = normalizedDescription.replace(/[0-9a-fA-F]{5,}/g, '###CODE###'); 

        if (!descriptionRecurrenceMap[normalizedDescription]) {
            descriptionRecurrenceMap[normalizedDescription] = { count: 0, firstTxn: null, sampleCategories: new Set() };
        }
        descriptionRecurrenceMap[normalizedDescription].count++;
        if (!descriptionRecurrenceMap[normalizedDescription].firstTxn) {
            descriptionRecurrenceMap[normalizedDescription].firstTxn = tx;
        }
        if (category && category !== 'Transfer' && category !== 'Uncategorized') {
            descriptionRecurrenceMap[normalizedDescription].sampleCategories.add(category);
        }
    });

    // --- Suggestion Generation ---

    // Suggestion Type A: Categorization Inconsistency
    const inconsistencyThreshold = 2; 
    for (const word in keywordCategoryMap) {
        if (keywordCategoryMap[word].size > inconsistencyThreshold) {
            suggestions.push({
                type: 'categorization_inconsistency',
                keyword: word,
                detail: `The keyword "${word}" appears in multiple categories: ${Array.from(keywordCategoryMap[word]).join(', ')}. Consider standardizing to one primary category for better tracking.`,
                detail_short: `"${word}" is in ${Array.from(keywordCategoryMap[word]).length} categories. Standardize?`,
                action: 'Standardize Category',
                categories: Array.from(keywordCategoryMap[word])
            });
        }
    }

    // Suggestion Type B: Potential Subscriptions / Recurring Payments
    for (const description in descriptionRecurrenceMap) {
        const data = descriptionRecurrenceMap[description];
        const isAlreadyFlaggedAsTransferOrBNPL = transferKeywords.some(tk => description.toUpperCase().includes(tk)) || bnplKeywords.some(bk => description.toUpperCase().includes(bk));

        if (data.count >= recurringPaymentThreshold && !isAlreadyFlaggedAsTransferOrBNPL) {
            const categoriesString = Array.from(data.sampleCategories).join(', ') || 'Uncategorized';
            
            let suggestedCategory = 'Review';
            if (data.sampleCategories.size === 1) {
                suggestedCategory = Array.from(data.sampleCategories)[0];
            }

            suggestions.push({
                type: 'potential_subscription',
                keyword: description, 
                detail: `Recurring transaction "${description}" detected ${data.count} times. It's currently categorized as: ${categoriesString}. Review to ensure it's still needed.`,
                detail_short: `"${description}" recurs ${data.count} times. Currently: ${categoriesString}. Review?`,
                action: 'Review Recurrence',
                suggestedCategory: suggestedCategory,
                recurrenceCount: data.count
            });
        }
    }

    // Suggestion Type C: BNPL Alerts
    transactions.forEach(tx => {
        const descriptionUpper = tx.description.toUpperCase();
        bnplKeywords.forEach(bnplKeyword => {
            if (descriptionUpper.includes(bnplKeyword)) {
                suggestions.push({
                    type: 'bnpl_alert',
                    keyword: bnplKeyword, 
                    detail: `BNPL payment detected for transaction: "${tx.description}". Ensure this installment fits your upcoming budget.`,
                    detail_short: `BNPL payment (${bnplKeyword}). Check budget.`,
                    transactionId: tx.id, 
                    action: 'Check Budget'
                });
            }
        });
    });

    // Suggestion Type D: Transfer Awareness
    const transferTxsFound = transactions.filter(tx =>
        transferKeywords.some(tk => tx.description.toUpperCase().includes(tk))
    );
    if (transferTxsFound.length > 0) {
        suggestions.push({
            type: 'transfer_awareness',
            keyword: 'Internal Transfers',
            detail: `Found ${transferTxsFound.length} transactions that appear to be internal transfers. Ensure these align with your savings goals and overall cash flow plan.`,
            detail_short: `${transferTxsFound.length} transfers found. Align with goals?`,
            action: 'Review Transfers'
        });
    }

    // --- Deduplicate & Refine ---
    const uniqueSuggestions = [];
    const seen = new Set();
    suggestions.forEach(s => {
        const key = `${s.type}_${s.keyword}`;
        if (s.type === 'bnpl_alert') {
            uniqueSuggestions.push(s); 
        } else if (!seen.has(key)) {
            uniqueSuggestions.push(s);
            seen.add(key);
        }
    });

    uniqueSuggestions.sort((a, b) => {
        const priority = { 'bnpl_alert': 1, 'transfer_awareness': 2, 'potential_subscription': 3, 'categorization_inconsistency': 4 };
        return (priority[a.type] || 99) - (priority[b.type] || 99);
    });

    return uniqueSuggestions;
}


// --- API Endpoint ---
router.get('/suggestions', async (req, res) => {
    try {
        const suggestions = generateSuggestions();
        res.json(suggestions);
    } catch (error) {
        console.error("[Categorizations API] Error generating suggestions:", error);
        res.status(500).json({ message: "Failed to generate suggestions", error: error.message });
    }
});

// --- Existing Routes (Example placeholders) ---
// Add your other routes here. Example:
// router.post('/list', async (req, res) => { ... });
// router.post('/update-batch', async (req, res) => { ... });
// router.post('/patterns', async (req, res) => { ... });
// router.post('/learn-pattern', async (req, res) => { ... });
// router.post('/category-summary', async (req, res) => { ... });
// router.post('/by-category', async (req, res) => { ... });

module.exports = router;
