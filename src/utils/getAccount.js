const Account = require('../models/Account');

async function getAccountByCode(code) {
  const account = await Account.findOne({ code });
  if (!account) {
    const err = new Error(`Required system account (code ${code}) is missing. Run the seed script.`);
    err.statusCode = 500;
    throw err;
  }
  return account;
}

/*
  For system accounts added after a company's DB was seeded: creates the
  account on first use. If the code is already taken by an unrelated account
  (namePattern doesn't match), refuses rather than posting to the wrong place.
*/
async function getOrCreateSystemAccount(code, { name, namePattern, ...fields }) {
  const existing = await Account.findOne({ code });
  if (existing) {
    if (namePattern && !namePattern.test(existing.name)) {
      const err = new Error(`Account code ${code} is already used by "${existing.name}". Rename or recode that account so ${code} can be "${name}".`);
      err.statusCode = 500;
      throw err;
    }
    return existing;
  }
  return Account.create({ code, name, isSystem: true, ...fields });
}

module.exports = { getAccountByCode, getOrCreateSystemAccount };
