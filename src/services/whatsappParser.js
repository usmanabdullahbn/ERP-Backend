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

  const convertCommand = parseConvertOrder(trimmed);
  if (convertCommand) return convertCommand;

  const updateCommand = parseUpdateRecord(trimmed);
  if (updateCommand) return updateCommand;

  const deleteCommand = parseDeleteRecord(trimmed);
  if (deleteCommand) return deleteCommand;

  const orderCommand = parseCreateOrder(trimmed);
  if (orderCommand) return orderCommand;

  const productCommand = parseCreateProduct(trimmed);
  if (productCommand) return productCommand;

  const customerCommand = parseCreateEntity(trimmed, 'customer', 'CREATE_CUSTOMER');
  if (customerCommand) return customerCommand;

  const supplierCommand = parseCreateEntity(trimmed, 'supplier', 'CREATE_SUPPLIER');
  if (supplierCommand) return supplierCommand;

  return null;
}

module.exports = { parseCommand };
