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

module.exports = { getAccountByCode };
