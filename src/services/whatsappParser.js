/*
  Deterministic keyword/regex command parser — no AI model involved.
  Understands English + Roman Urdu phrasings for creating a customer or
  supplier (optionally with a phone number), and for updating a single
  field on an existing record by its code. Returns
  { action, data } or null when the message doesn't match any known
  command.
*/

const CREATE_VERBS = ['create', 'new', 'make', 'add', 'naya', 'nayi', 'banao', 'bana', 'banana', 'karo'];
const PHONE_WORDS = new Set(['contact', 'number', 'phone', 'mobile', 'cell', 'whatsapp', 'no', 'num']);
const STRIP_WORDS = new Set([
  'create', 'new', 'make', 'add', 'naya', 'nayi', 'banao', 'bana', 'banana', 'karo', 'do',
  'customer', 'supplier', 'please', 'a', 'an', 'the', 'called', 'named', 'name', 'naam',
  'ke', 'ka', 'ki', 'se', 'k', 'and', 'will', 'be', 'is', ...PHONE_WORDS
]);

const PHONE_TOKEN = /^\+?\d[\d-]{3,}$/;

const UPDATE_FIELD_MAP = {
  email: 'email',
  phone: 'phone', number: 'phone', contact: 'phone', mobile: 'phone', whatsapp: 'phone',
  address: 'address',
  name: 'name',
  tax: 'taxNumber', taxnumber: 'taxNumber', taxno: 'taxNumber'
};

function toTitleCase(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
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

/* Matches "<CUST-0001|SUPP-0001> update <field> to <value>" (code can carry a
   trailing possessive like "it's"/"its", and word order around the code is
   flexible as long as "<field> to <value>" appears intact). */
function parseUpdateRecord(text) {
  if (!/\bupdate\b/i.test(text)) return null;

  const codeMatch = text.match(/\b(CUST|SUPP)-(\d+)\b/i);
  if (!codeMatch) return null;

  const fieldValueMatch = text.match(/([a-z]+)\s+to\s+(.+)$/i);
  if (!fieldValueMatch) return null;

  const field = UPDATE_FIELD_MAP[fieldValueMatch[1].toLowerCase()];
  if (!field) return null;

  const value = fieldValueMatch[2].trim();
  if (!value) return null;

  return {
    action: 'UPDATE_RECORD',
    data: {
      entityType: codeMatch[1].toUpperCase() === 'CUST' ? 'CUSTOMER' : 'SUPPLIER',
      code: `${codeMatch[1].toUpperCase()}-${codeMatch[2]}`,
      field,
      value
    }
  };
}

function parseCommand(text) {
  if (!text || !text.trim()) return null;

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower.includes('logout') || lower.includes('log out')) {
    return { action: 'LOGOUT', data: {} };
  }
  if (lower === 'help' || lower === 'menu') {
    return { action: 'HELP', data: {} };
  }

  const updateCommand = parseUpdateRecord(trimmed);
  if (updateCommand) return updateCommand;

  const customerCommand = parseCreateEntity(trimmed, 'customer', 'CREATE_CUSTOMER');
  if (customerCommand) return customerCommand;

  const supplierCommand = parseCreateEntity(trimmed, 'supplier', 'CREATE_SUPPLIER');
  if (supplierCommand) return supplierCommand;

  return null;
}

module.exports = { parseCommand };
