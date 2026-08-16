/*
  Deterministic keyword/regex command parser — no AI model involved.
  Understands English + Roman Urdu phrasings for creating a customer.
  Returns { action: 'CREATE_CUSTOMER', data: { name } } or null when the
  message doesn't match any known command.
*/

const CREATE_VERBS = ['create', 'new', 'make', 'add', 'naya', 'nayi', 'banao', 'bana', 'banana', 'karo'];
const STRIP_WORDS = new Set([
  'create', 'new', 'make', 'add', 'naya', 'nayi', 'banao', 'bana', 'banana', 'karo', 'do',
  'customer', 'please', 'a', 'an', 'the', 'called', 'named', 'name', 'naam', 'ke', 'ka', 'ki', 'se', 'k'
]);

function toTitleCase(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function parseCreateCustomer(text) {
  const words = text.toLowerCase().trim().split(/\s+/);
  if (!words.includes('customer')) return null;
  if (!CREATE_VERBS.some((verb) => words.includes(verb))) return null;

  const nameWords = words.filter((w) => !STRIP_WORDS.has(w));
  const name = toTitleCase(nameWords.join(' ')).trim();

  return { action: 'CREATE_CUSTOMER', data: { name } };
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

  const customerCommand = parseCreateCustomer(trimmed);
  if (customerCommand) return customerCommand;

  return null;
}

module.exports = { parseCommand };
