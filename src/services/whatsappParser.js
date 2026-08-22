/*
  Deterministic keyword/regex command parser — no AI model involved.
  Understands English + Roman Urdu phrasings for creating a customer or
  supplier (optionally with a phone number), a single structured template
  for creating a sales order, updating a single field on an existing
  record by its code, deleting a record by code, and converting an order
  to an invoice. Returns { action, data } or null when the message
  doesn't match any known command.
*/

const CREATE_VERBS = ['create', 'new', 'make', 'add', 'naya', 'nayi', 'banao', 'bana', 'banana', 'karo'];
const PHONE_WORDS = new Set(['contact', 'number', 'phone', 'mobile', 'cell', 'whatsapp', 'no', 'num']);
const STRIP_WORDS = new Set([
  'create', 'new', 'make', 'add', 'naya', 'nayi', 'banao', 'bana', 'banana', 'karo', 'do',
  'customer', 'supplier', 'please', 'a', 'an', 'the', 'called', 'named', 'name', 'naam',
  'ke', 'ka', 'ki', 'se', 'k', 'and', 'will', 'be', 'is', ...PHONE_WORDS
]);

const PHONE_TOKEN = /^\+?\d[\d-]{3,}$/;

// Code prefix -> entity type, and which fields "<code> update <field> to <value>" allows per entity.
const CODE_PREFIX_TO_ENTITY = { CUST: 'CUSTOMER', SUPP: 'SUPPLIER', SO: 'ORDER' };
const UPDATE_FIELD_MAP = {
  CUSTOMER: {
    email: 'email',
    phone: 'phone', number: 'phone', contact: 'phone', mobile: 'phone', whatsapp: 'phone',
    address: 'address',
    name: 'name',
    tax: 'taxNumber', taxnumber: 'taxNumber', taxno: 'taxNumber'
  },
  SUPPLIER: {
    email: 'email',
    phone: 'phone', number: 'phone', contact: 'phone', mobile: 'phone', whatsapp: 'phone',
    address: 'address',
    name: 'name',
    tax: 'taxNumber', taxnumber: 'taxNumber', taxno: 'taxNumber'
  },
  ORDER: {
    notes: 'notes', note: 'notes',
    duedate: 'dueDate', due: 'dueDate'
  }
};

/* Matches "create product <name> [@ <price>]". Reuses the same trailing
   "@ <price>" convention as create order, so the two stay consistent. */
function parseCreateProduct(text) {
  const words = text.toLowerCase().trim().split(/\s+/);
  if (!words.includes('product')) return null;
  if (!CREATE_VERBS.some((verb) => words.includes(verb))) return null;

  const priceMatch = text.match(/@\s*(\d+(?:\.\d+)?)\s*$/);
  const price = priceMatch ? Number(priceMatch[1]) : null;
  const withoutPrice = priceMatch ? text.slice(0, priceMatch.index) : text;

  const nameWords = withoutPrice
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w !== 'product' && !STRIP_WORDS.has(w));
  const name = toTitleCase(nameWords.join(' ')).trim();
  if (!name) return null;

  return { action: 'CREATE_PRODUCT', data: { name, price } };
}

function toTitleCase(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function matchCode(text) {
  const match = text.match(/\b(CUST|SUPP|SO)-(\d+)\b/i);
  if (!match) return null;
  const prefix = match[1].toUpperCase();
  return { entityType: CODE_PREFIX_TO_ENTITY[prefix], code: `${prefix}-${match[2]}` };
}

function parseCreateEntity(text, entityWord, action) {
  const words = text.toLowerCase().trim().split(/\s+/);
  if (!words.includes(entityWord)) return null;
  if (!CREATE_VERBS.some((verb) => words.includes(verb))) return null;

  const phoneToken = words.find((w) => PHONE_TOKEN.test(w));
  const phone = phoneToken ? phoneToken.replace(/-/g, '') : '';

  const nameWords = words.filter((w) => w !== phoneToken && !STRIP_WORDS.has(w));
  const name = toTitleCase(nameWords.join(' ')).trim();

  return { action, data: { name, phone } };
}

/* Matches "create order for <customer>: <qty> x <product> [@ <price>]".
   Orders have too many independent fields (customer, product, quantity,
   price) to reliably free-text parse without an AI model, so this uses a
   fixed template instead of the looser style used for customer/supplier. */
function parseCreateOrder(text) {
  const match = text.match(/create order for\s+([^:]+):\s*(\d+(?:\.\d+)?)\s*x\s*([^@]+?)(?:\s*@\s*(\d+(?:\.\d+)?))?\s*$/i);
  if (!match) return null;

  const customerName = match[1].trim();
  const productName = match[3].trim();
  if (!customerName || !productName) return null;

  return {
    action: 'CREATE_ORDER',
    data: {
      customerName,
      quantity: Number(match[2]),
      productName,
      price: match[4] ? Number(match[4]) : null
    }
  };
}

/*
  Fallback for an order message that mentions both a CUST- and SKU- code but
  doesn't fit the strict "for X: Y x Z" template — e.g. the pieces given on
  separate lines, or in a different order. This is safe specifically because
  codes are unambiguous identifiers, unlike a free-text name/product: there's
  nothing to guess, only to locate. Quantity is read from "qty <n>" /
  "quantity <n>" if present, otherwise the first standalone number left after
  removing both codes.
*/
function parseCreateOrderLoose(text) {
  if (!/\border\b/i.test(text)) return null;

  const custMatch = text.match(/\bCUST-(\d+)\b/i);
  const skuMatch = text.match(/\bSKU-(\d+)\b/i);
  if (!custMatch || !skuMatch) return null;

  let quantity = null;
  const qtyMatch = text.match(/\b(?:qty|quantity)\b\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (qtyMatch) {
    quantity = Number(qtyMatch[1]);
  } else {
    const withoutCodes = text.replace(/\bCUST-\d+\b/gi, ' ').replace(/\bSKU-\d+\b/gi, ' ');
    const bareNum = withoutCodes.match(/\b(\d+(?:\.\d+)?)\b/);
    if (bareNum) quantity = Number(bareNum[1]);
  }
  if (!quantity || quantity <= 0) return null;

  const priceMatch = text.match(/@\s*(\d+(?:\.\d+)?)/);

  return {
    action: 'CREATE_ORDER',
    data: {
      customerName: `CUST-${custMatch[1]}`,
      productName: `SKU-${skuMatch[1]}`,
      quantity,
      price: priceMatch ? Number(priceMatch[1]) : null
    }
  };
}

/* Matches "create invoice for <customer>: <qty> x <product> [@ <price>]" —
   a standalone draft invoice, independent of the order flow. Distinct from
   "<SO-code> create invoice" (parseConvertOrder below), which always
   requires an SO- code and never matches this "for <name>:" template. */
function parseCreateInvoice(text) {
  const match = text.match(/create invoice for\s+([^:]+):\s*(\d+(?:\.\d+)?)\s*x\s*([^@]+?)(?:\s*@\s*(\d+(?:\.\d+)?))?\s*$/i);
  if (!match) return null;

  const customerName = match[1].trim();
  const productName = match[3].trim();
  if (!customerName || !productName) return null;

  return {
    action: 'CREATE_INVOICE',
    data: {
      customerName,
      quantity: Number(match[2]),
      productName,
      price: match[4] ? Number(match[4]) : null
    }
  };
}

/* Matches "create bill from <supplier>: <qty> x <product> [@ <price>]" —
   mirrors parseCreateInvoice/parseCreateOrder's template exactly, just with
   "from <supplier>" instead of "for <customer>". */
function parseCreateBill(text) {
  const match = text.match(/create bill from\s+([^:]+):\s*(\d+(?:\.\d+)?)\s*x\s*([^@]+?)(?:\s*@\s*(\d+(?:\.\d+)?))?\s*$/i);
  if (!match) return null;

  const supplierName = match[1].trim();
  const productName = match[3].trim();
  if (!supplierName || !productName) return null;

  return {
    action: 'CREATE_BILL',
    data: {
      supplierName,
      quantity: Number(match[2]),
      productName,
      price: match[4] ? Number(match[4]) : null
    }
  };
}

/* Matches "create warehouse <name>" — same minimal shape as create
   customer/supplier, but built like parseCreateProduct (explicit word
   filter) since STRIP_WORDS/phone handling don't apply to a warehouse. */
function parseCreateWarehouse(text) {
  const words = text.toLowerCase().trim().split(/\s+/);
  if (!words.includes('warehouse')) return null;
  if (!CREATE_VERBS.some((verb) => words.includes(verb))) return null;

  const nameWords = text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w !== 'warehouse' && !STRIP_WORDS.has(w));
  const name = toTitleCase(nameWords.join(' ')).trim();
  if (!name) return null;

  return { action: 'CREATE_WAREHOUSE', data: { name } };
}

/* Matches "journal debit <account> credit <account> <amount> [narration]" —
   a fixed two-line template. A manual journal entry can in principle have
   many lines, but that's unreasonable to free-text over chat; this covers
   the overwhelmingly common single debit/single credit adjustment. Account
   can be given by code (e.g. "5010") or by name. */
function parseCreateJournal(text) {
  const match = text.match(/^journal\s+debit\s+(.+?)\s+credit\s+(.+?)\s+(\d+(?:\.\d+)?)(?:\s+(.+))?$/i);
  if (!match) return null;

  return {
    action: 'CREATE_JOURNAL',
    data: {
      debitTerm: match[1].trim(),
      creditTerm: match[2].trim(),
      amount: Number(match[3]),
      narration: match[4] ? match[4].trim() : ''
    }
  };
}

/* Matches "increase|decrease stock <product> by <qty> in <warehouse>
   [, <reason>]" — mirrors the web app's Stock Adjustment form (product,
   warehouse, direction, quantity, reason). */
function parseStockAdjustment(text) {
  const match = text.match(/^(increase|decrease)\s+stock\s+(.+?)\s+by\s+(\d+(?:\.\d+)?)\s+in\s+([^,:]+?)(?:\s*[,:]\s*(.+))?$/i);
  if (!match) return null;

  return {
    action: 'STOCK_ADJUSTMENT',
    data: {
      direction: match[1].toLowerCase() === 'increase' ? 'IN' : 'OUT',
      productTerm: match[2].trim(),
      quantity: Number(match[3]),
      warehouseTerm: match[4].trim(),
      note: match[5] ? match[5].trim() : ''
    }
  };
}

/* Matches "produce <qty> x <product> in <warehouse> [, <note>]" — a
   production/assembly run against the product's existing Bill of Materials
   (defined separately in the ERP; this command can't create one). */
function parseCreateAssembly(text) {
  const match = text.match(/^produce\s+(\d+(?:\.\d+)?)\s*x\s*([^,:]+?)\s+in\s+([^,:]+?)(?:\s*[,:]\s*(.+))?$/i);
  if (!match) return null;

  return {
    action: 'CREATE_ASSEMBLY',
    data: {
      quantity: Number(match[1]),
      productTerm: match[2].trim(),
      warehouseTerm: match[3].trim(),
      note: match[4] ? match[4].trim() : ''
    }
  };
}

/* Matches "create account <code> <name> as <type>" — a new Chart of
   Accounts entry. normalBalance is derived from type, not asked for, since
   it's a bookkeeping technicality most users won't know off-hand. */
function parseCreateAccount(text) {
  const match = text.match(/^create account\s+(\S+)\s+(.+?)\s+as\s+(asset|liability|equity|income|expense)\s*$/i);
  if (!match) return null;

  return {
    action: 'CREATE_ACCOUNT',
    data: { code: match[1].trim(), name: match[2].trim(), type: match[3].toUpperCase() }
  };
}

/* Matches "create bank account <name> [<account number>] [opening <amount>]"
   or "create cash account ..." for a CASH-type entry. Reuses the same
   digit-token detection as customer/supplier phone numbers, just applied to
   an account number instead. */
function parseCreateBankAccount(text) {
  const lower = text.toLowerCase().trim();
  const isCash = lower.startsWith('create cash account');
  const isBank = lower.startsWith('create bank account');
  if (!isCash && !isBank) return null;

  let rest = text.trim().slice((isCash ? 'create cash account' : 'create bank account').length).trim();

  let openingBalance = null;
  const openingMatch = rest.match(/\bopening\s+(\d+(?:\.\d+)?)\s*$/i);
  if (openingMatch) {
    openingBalance = Number(openingMatch[1]);
    rest = rest.slice(0, openingMatch.index).trim();
  }

  const words = rest.split(/\s+/).filter(Boolean);
  const acctToken = words.find((w) => PHONE_TOKEN.test(w));
  const accountNumber = acctToken ? acctToken.replace(/-/g, '') : '';
  const name = words.filter((w) => w !== acctToken).join(' ').trim();
  if (!name) return null;

  return {
    action: 'CREATE_BANK_ACCOUNT',
    data: { name, accountNumber, type: isCash ? 'CASH' : 'BANK', openingBalance }
  };
}

/* Matches "deposit <amount> into <bank> from <contra account> [, <note>]" —
   money coming into a bank/cash account from a GL account (e.g. income). */
function parseBankDeposit(text) {
  const match = text.match(/^deposit\s+(\d+(?:\.\d+)?)\s+into\s+([^,:]+?)\s+from\s+([^,:]+?)(?:\s*[,:]\s*(.+))?$/i);
  if (!match) return null;
  return {
    action: 'CREATE_BANK_DEPOSIT',
    data: { amount: Number(match[1]), bankTerm: match[2].trim(), contraTerm: match[3].trim(), note: match[4] ? match[4].trim() : '' }
  };
}

/* Matches "withdraw <amount> from <bank> for <contra account> [, <note>]" —
   money leaving a bank/cash account against a GL account (e.g. an expense). */
function parseBankWithdrawal(text) {
  const match = text.match(/^withdraw\s+(\d+(?:\.\d+)?)\s+from\s+([^,:]+?)\s+for\s+([^,:]+?)(?:\s*[,:]\s*(.+))?$/i);
  if (!match) return null;
  return {
    action: 'CREATE_BANK_WITHDRAWAL',
    data: { amount: Number(match[1]), bankTerm: match[2].trim(), contraTerm: match[3].trim(), note: match[4] ? match[4].trim() : '' }
  };
}

/* Matches "transfer <amount> from <bank> to <bank> [, <note>]" — between
   two of the ERP's own bank/cash accounts. */
function parseBankTransfer(text) {
  const match = text.match(/^transfer\s+(\d+(?:\.\d+)?)\s+from\s+([^,:]+?)\s+to\s+([^,:]+?)(?:\s*[,:]\s*(.+))?$/i);
  if (!match) return null;
  return {
    action: 'CREATE_BANK_TRANSFER',
    data: { amount: Number(match[1]), fromBankTerm: match[2].trim(), toBankTerm: match[3].trim(), note: match[4] ? match[4].trim() : '' }
  };
}

/* Matches "<SO-0001> create/convert ... invoice" — turns an existing order
   into a draft invoice, mirroring the "Convert to invoice" button. */
function parseConvertOrder(text) {
  if (!/\binvoice\b/i.test(text)) return null;
  if (!/\b(create|convert|generate|make|to)\b/i.test(text)) return null;

  const match = text.match(/\bSO-(\d+)\b/i);
  if (!match) return null;

  return { action: 'CONVERT_ORDER', data: { code: `SO-${match[1]}` } };
}

/* Matches "<CUST-0001|SUPP-0001|SO-0001> update <field> to <value>" (code can
   carry a trailing possessive like "it's"/"its", and word order around the
   code is flexible as long as "<field> to <value>" appears intact). */
function parseUpdateRecord(text) {
  if (!/\bupdate\b/i.test(text)) return null;

  const codeMatch = matchCode(text);
  if (!codeMatch) return null;

  const fieldValueMatch = text.match(/([a-z]+)\s+to\s+(.+)$/i);
  if (!fieldValueMatch) return null;

  const field = UPDATE_FIELD_MAP[codeMatch.entityType]?.[fieldValueMatch[1].toLowerCase()];
  if (!field) return null;

  const value = fieldValueMatch[2].trim();
  if (!value) return null;

  return {
    action: 'UPDATE_RECORD',
    data: { entityType: codeMatch.entityType, code: codeMatch.code, field, value }
  };
}

/* Matches "<code> delete" or "delete <code>", with filler words (please,
   etc.) allowed anywhere. Deletion itself always requires a separate
   YES/NO confirmation — this only detects the intent. */
function parseDeleteRecord(text) {
  if (!/\bdelete\b/i.test(text)) return null;

  const codeMatch = matchCode(text);
  if (!codeMatch) return null;

  return { action: 'DELETE_RECORD', data: codeMatch };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* "today" / "this year" / default-to-this-month period for report commands
   that take a range (P&L, Trial Balance). */
function resolvePeriod(topic) {
  const today = new Date();
  if (/\btoday\b/.test(topic)) {
    return { from: toISODate(today), to: toISODate(today), label: 'today' };
  }
  if (/\byear\b/.test(topic)) {
    return { from: `${today.getFullYear()}-01-01`, to: toISODate(today), label: 'this year' };
  }
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  return { from: toISODate(firstOfMonth), to: toISODate(today), label: 'this month' };
}

/* Matches "report <topic>", e.g. "report p&l this month", "report low stock",
   "report aged receivables". Topic keywords are deliberately generous
   (p&l/pl/profit, receivables/aged receivables, etc.) since this is meant
   to be a quick on-the-go check, not a precise query language. */
function parseReport(text) {
  const match = text.match(/^report\s+(.+)$/i);
  if (!match) return null;
  const topic = match[1].toLowerCase().trim();

  if (/^(p&l|pl\b|profit)/.test(topic)) {
    return { action: 'REPORT_PL', data: resolvePeriod(topic) };
  }
  if (/^balance\s*sheet/.test(topic)) {
    return { action: 'REPORT_BALANCE_SHEET', data: {} };
  }
  if (/^trial\s*balance/.test(topic)) {
    return { action: 'REPORT_TRIAL_BALANCE', data: resolvePeriod(topic) };
  }
  if (/^low\s*stock/.test(topic)) {
    return { action: 'REPORT_STOCK', data: { lowOnly: true } };
  }
  if (/^(stock|inventory)/.test(topic)) {
    return { action: 'REPORT_STOCK', data: { lowOnly: false } };
  }
  if (/^(aged\s*)?receivables?/.test(topic)) {
    return { action: 'REPORT_AGED_RECEIVABLES', data: {} };
  }
  if (/^(aged\s*)?payables?/.test(topic)) {
    return { action: 'REPORT_AGED_PAYABLES', data: {} };
  }
  if (/^(pending\s*)?orders?/.test(topic)) {
    return { action: 'REPORT_PENDING_ORDERS', data: {} };
  }

  return null;
}

/* Matches "<CUST-0001|SUPP-0001> balance" — a quick balance lookup, distinct
   from the fuller "report" commands since it's anchored by an unambiguous
   code rather than a topic keyword. */
function parseBalanceLookup(text) {
  if (!/\bbalance\b/i.test(text)) return null;
  const codeMatch = matchCode(text);
  if (!codeMatch || codeMatch.entityType === 'ORDER') return null;
  return { action: 'REPORT_BALANCE', data: codeMatch };
}

function parseCommand(text) {
  if (!text || !text.trim()) return null;

  // Collapse newlines/repeated whitespace to single spaces — WhatsApp's
  // mobile keyboard readily sends multi-line messages, and every regex
  // below is single-line by design.
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const lower = trimmed.toLowerCase();

  if (lower.includes('logout') || lower.includes('log out')) {
    return { action: 'LOGOUT', data: {} };
  }
  if (lower === 'help' || lower === 'menu') {
    return { action: 'HELP', data: {} };
  }

  const reportCommand = parseReport(trimmed);
  if (reportCommand) return reportCommand;

  const balanceCommand = parseBalanceLookup(trimmed);
  if (balanceCommand) return balanceCommand;

  const journalCommand = parseCreateJournal(trimmed);
  if (journalCommand) return journalCommand;

  const stockAdjustmentCommand = parseStockAdjustment(trimmed);
  if (stockAdjustmentCommand) return stockAdjustmentCommand;

  const assemblyCommand = parseCreateAssembly(trimmed);
  if (assemblyCommand) return assemblyCommand;

  const accountCommand = parseCreateAccount(trimmed);
  if (accountCommand) return accountCommand;

  const bankAccountCommand = parseCreateBankAccount(trimmed);
  if (bankAccountCommand) return bankAccountCommand;

  const bankDepositCommand = parseBankDeposit(trimmed);
  if (bankDepositCommand) return bankDepositCommand;

  const bankWithdrawalCommand = parseBankWithdrawal(trimmed);
  if (bankWithdrawalCommand) return bankWithdrawalCommand;

  const bankTransferCommand = parseBankTransfer(trimmed);
  if (bankTransferCommand) return bankTransferCommand;

  const convertCommand = parseConvertOrder(trimmed);
  if (convertCommand) return convertCommand;

  const updateCommand = parseUpdateRecord(trimmed);
  if (updateCommand) return updateCommand;

  const deleteCommand = parseDeleteRecord(trimmed);
  if (deleteCommand) return deleteCommand;

  const orderCommand = parseCreateOrder(trimmed);
  if (orderCommand) return orderCommand;

  const looseOrderCommand = parseCreateOrderLoose(trimmed);
  if (looseOrderCommand) return looseOrderCommand;

  const invoiceCommand = parseCreateInvoice(trimmed);
  if (invoiceCommand) return invoiceCommand;

  const billCommand = parseCreateBill(trimmed);
  if (billCommand) return billCommand;

  const productCommand = parseCreateProduct(trimmed);
  if (productCommand) return productCommand;

  const warehouseCommand = parseCreateWarehouse(trimmed);
  if (warehouseCommand) return warehouseCommand;

  const customerCommand = parseCreateEntity(trimmed, 'customer', 'CREATE_CUSTOMER');
  if (customerCommand) return customerCommand;

  const supplierCommand = parseCreateEntity(trimmed, 'supplier', 'CREATE_SUPPLIER');
  if (supplierCommand) return supplierCommand;

  return null;
}

module.exports = { parseCommand };
