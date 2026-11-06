import { readFileSync } from 'node:fs';
import { PRICES } from './billing.js';

const escape = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const price = plan => (PRICES[plan] / 100).toFixed(2);
export const PUBLIC_PAGES = Object.freeze({
  '/': { title: 'MyFinance | Household budgeting, bill calendar and 30-day cash flow',
    description: 'Track household spending, forecast 30 days of cash flow, and plan bills, savings and debt payoff with MyFinance Basic or Pro.' },
  '/features': { title: 'Household budget app with a bill calendar | MyFinance',
    description: 'Explore shared household transactions, a bill calendar, 30-day cash flow forecasts, optional Plaid bank sync and MyFinance Pro planning.' },
  '/pricing': { title: 'MyFinance pricing | Basic and Pro household plans',
    description: `Compare MyFinance Basic at $${price('basic')}/month and Pro at $${price('pro')}/month per household, with a 15-day Pro trial and payment details required.` },
  '/debt-payoff': { title: 'Debt payoff planner with bills and savings goals | MyFinance',
    description: 'Plan debt payoff alongside recurring bills and savings goals. Compare snowball and avalanche strategies with MyFinance Pro.' },
  '/about': { title: 'About MyFinance | Privacy, security and purpose',
    description: 'Learn about MyFinance, its purpose, and the safeguards protecting your financial workspace.' },
  '/contact': { title: 'Contact MyFinance | Support and questions',
    description: 'Contact MyFinance for product questions, customer support, privacy questions or security concerns.' },
  '/security': { title: 'Security Whitepaper | MyFinance',
    description: 'Understand MyFinance account protection, household isolation, data handling and the limits of its security safeguards.' }
});
const templates = Object.fromEntries(['index', 'about', 'contact', 'security'].map(name =>
  [name, readFileSync(new URL(`../../frontend/${name}.html`, import.meta.url), 'utf8')]));
const origin = () => process.env.APP_ORIGIN || 'https://myfinanceapp.us';
const navigation = path => `<nav aria-label="Main navigation">${[
  ['/features', 'Features'], ['/pricing', 'Pricing'], ['/debt-payoff', 'Debt payoff'],
  ['/about', 'About'], ['/security', 'Security'], ['/contact', 'Contact']
].map(([url, label]) => `<a href="${url}"${url === path ? ' aria-current="page"' : ''}>${label}</a>`).join('')}<a href="/#marketing-signin">Sign in</a></nav>`;
const content = {
  '/features': `<p class="eyebrow">HOUSEHOLD BUDGETING</p><h1>A household budget app with a bill calendar.</h1>
    <p class="intro">See your transactions, upcoming bills and expected cash flow in one shared workspace. Keep recorded spending separate from estimates about what comes next.</p>
    <section class="cards" aria-label="MyFinance features">
      <article><h2>30-day cash flow forecast</h2><p>View expected bills and regular income over the next 30 days. Recurring payments come from your recorded history, and forecasts change when new activity arrives. Pending bank payments do not automatically mark a bill paid.</p></article>
      <article><h2>Bill calendar and follow-up</h2><p>Mark recurring payments as fixed, choose auto-pay or manual payment, and see upcoming dates. Confirm one occurrence paid or ignore one estimate without changing every month.</p></article>
      <article><h2>Shared household transactions</h2><p>Household members share financial records. Search transactions, organize categories and review possible duplicates. Import CSV, OFX/QFX or supported PDF statements, or optionally connect eligible U.S. banks through Plaid.</p></article>
      <article><h2>Pro analytics and planning</h2><p>MyFinance Pro adds spending analysis and a debt-free plan that shares available surplus between debts and savings goals. Basic covers everyday transaction and bill tracking.</p></article>
    </section><section class="trust-note"><h2>You stay in control</h2><p>Bank connections are optional and data-only. MyFinance does not initiate payments or transfers. Forecasts depend on complete, correctly categorized history and are estimates, not financial advice.</p><p><a href="/security">Read about security and data handling</a> or <a href="/pricing">compare plans</a>.</p></section>`,
  '/pricing': `<p class="eyebrow">ONE SUBSCRIPTION PER HOUSEHOLD</p><h1>Simple monthly pricing for your household.</h1>
    <p class="intro">Choose Basic for day-to-day finances or Pro for deeper analysis and planning. Prices are in USD, billed monthly per household.</p>
    <section class="cards" aria-label="Monthly plans">
      <article><h2>MyFinance Basic</h2><p class="public-price">$${price('basic')} <span>/ month</span></p><p>Shared household transactions, categories, statement imports, optional bank connections, bill tracking and a 30-day cash flow forecast.</p><a class="public-cta" href="/#marketing-signin">Get started with Basic</a></article>
      <article><h2>MyFinance Pro</h2><p class="public-price">$${price('pro')} <span>/ month</span></p><p>Everything in Basic, plus advanced spending analytics, a debt-free plan and competing savings-goal allocations.</p><a class="public-cta" href="/#marketing-signin">Get started with Pro</a></article>
    </section><section class="trust-note"><h2>How the 15-day Pro trial works</h2><p>Select your ongoing Basic or Pro plan and provide payment details and consent in Stripe Checkout. The trial includes Pro features for 15 days. Your selected plan bills automatically after the trial unless you cancel before it ends. This is not a free plan or a trial without payment details.</p><p>Manage your subscription from household settings. Cancellation stops renewal; imported history is retained. See the checkout disclosures for your billing dates and applicable terms.</p></section>`,
  '/debt-payoff': `<p class="eyebrow">MYFINANCE PRO</p><h1>A debt payoff planner that accounts for bills.</h1>
    <p class="intro">A payoff plan needs more than a debt balance. MyFinance Pro combines your recorded income and spending with recurring bills and savings goals to estimate what is available for debt reduction.</p>
    <section class="cards" aria-label="Debt planning">
      <article><h2>Snowball or avalanche?</h2><p>Compare prioritizing smaller balances with prioritizing higher interest rates. A snowball can emphasize early payoff milestones; an avalanche targets interest cost. The right choice depends on your circumstances and ability to keep making payments.</p></article>
      <article><h2>Keep bills in the picture</h2><p>Recurring bills and recorded spending help estimate available surplus. Review missing transactions, incorrect categories and upcoming payments before relying on the plan.</p></article>
      <article><h2>Balance debt with savings goals</h2><p>Emergency, car, college and other savings goals compete for the same observed surplus. Set priorities and deadlines rather than allocating the same money twice.</p></article>
      <article><h2>Estimates, not payment instructions</h2><p>Payoff dates and interest estimates change with balances, rates, imported history and your allocations. MyFinance does not move money, open credit, or make payments for you.</p></article>
    </section><section class="trust-note"><h2>Start with accurate information</h2><p>Review debt balances, interest rates, minimum payments and household history. Planning is educational support, not individualized financial, tax or investment advice, and no payoff date is guaranteed.</p><p><a href="/pricing">See Pro pricing and trial details</a> or <a href="/features">explore the bill calendar</a>.</p></section>`
};

export function renderPublicPage(path) {
  const page = PUBLIC_PAGES[path];
  if (!page) throw new Error('Unknown public page');
  const url = `${origin()}${path}`;
  const schema = ['/', '/features', '/pricing', '/debt-payoff'].includes(path) ? {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'MyFinance',
    url: `${origin()}/`, applicationCategory: 'FinanceApplication', operatingSystem: 'Web browser',
    description: PUBLIC_PAGES['/'].description,
    offers: Object.entries(PRICES).map(([plan, cents]) => ({
      '@type': 'Offer', name: `MyFinance ${plan === 'basic' ? 'Basic' : 'Pro'} monthly household subscription`,
      price: (cents / 100).toFixed(2), priceCurrency: 'USD', url: `${origin()}/pricing`,
      priceSpecification: { '@type': 'UnitPriceSpecification', price: (cents / 100).toFixed(2),
        priceCurrency: 'USD', unitText: 'MONTH', referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitText: 'household' } }
    }))
  } : null;
  const metadata = `<title>${escape(page.title)}</title>
  <meta name="description" content="${escape(page.description)}">
  <link rel="canonical" href="${escape(url)}">
  <meta property="og:type" content="website"><meta property="og:site_name" content="MyFinance">
  <meta property="og:title" content="${escape(page.title)}"><meta property="og:description" content="${escape(page.description)}">
  <meta property="og:url" content="${escape(url)}">
  <meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escape(page.title)}">
  <meta name="twitter:description" content="${escape(page.description)}">
  ${schema ? `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>` : ''}`;
  let html = content[path] ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/public-pages.css?v=20261106-seo"></head><body>
    <a class="skip-link" href="#main">Skip to content</a><header class="site-header"><a class="site-brand" href="/">MyFinance</a>${navigation(path)}</header>
    <main id="main">${content[path]}</main><footer class="site-footer"><p>MyFinance does not move money. Planning results are estimates.</p>${navigation(path)}</footer></body></html>`
    : templates[path === '/' ? 'index' : path.slice(1)];
  html = html.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<meta name="description"[^>]*>/i, '');
  if (path === '/') {
    const split = html.indexOf('<div class="app-container"');
    if (split < 0) throw new Error('Homepage app container missing');
    html = html.slice(0, split) + html.slice(split).replace(/<h1\b/g, '<h2').replace(/<\/h1>/g, '</h2>');
  } else if (!content[path]) {
    html = html.replace(/<nav aria-label="Main navigation">[\s\S]*?<\/nav>/, navigation(path));
  }
  return html.replace('</head>', `${metadata}</head>`);
}

export function publicSitemap() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(PUBLIC_PAGES)
    .map(path => `<url><loc>${escape(origin() + path)}</loc></url>`).join('')}</urlset>`;
}

export function publicRobots() {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /app\nDisallow: /reset-password\nDisallow: /verify-email\n\nSitemap: ${origin()}/sitemap.xml\n`;
}
