/*
  Deterministic keyword/regex command parser — no AI model involved.
  Understands English + Roman Urdu phrasings for creating a customer or
  supplier, optionally with a phone number. Returns
  { action, data: { name, phone } } or null when the message doesn't match
  any known command.
*/

const CREATE_VERBS = ['create', 'new', 'make', 'add', 'naya', 'nayi', 'banao', 'bana', 'banana', 'karo'];
const PHONE_WORDS = new Set(['contact', 'number', 'phone', 'mobile', 'cell', 'whatsapp', 'no', 'num']);
const STRIP_WORDS = new Set([
  'create', 'new', 'make', 'add', 'naya', 'nayi', 'banao', 'bana', 'banana', 'karo', 'do',
  'customer', 'supplier', 'please', 'a', 'an', 'the', 'called', 'named', 'name', 'naam',
  'ke', 'ka', 'ki', 'se', 'k', 'and', 'will', 'be', 'is', ...PHONE_WORDS
]);

const PHONE_TOKEN = /^\+?\d[\d-]{3,}$/;

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

function parseCommand(text) {
  if (!text || !text.trim()) return null;

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'logout' || lower === 'log out') {
    return { action: 'LOGOUT', data: {} };
  }
  if (lower === 'help' || lower === 'menu') {
    return { action: 'HELP', data: {} };
  }

  const customerCommand = parseCreateEntity(trimmed, 'customer', 'CREATE_CUSTOMER');
  if (customerCommand) return customerCommand;

  const supplierCommand = parseCreateEntity(trimmed, 'supplier', 'CREATE_SUPPLIER');
  if (supplierCommand) return supplierCommand;

  return null;
}

module.exports = { parseCommand };
