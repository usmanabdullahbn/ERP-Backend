const mongoose = require('mongoose');

// Every query run inside withTransaction() joins its session automatically,
// so services (ledger, inventory, numbering) need no session plumbing.
mongoose.set('transactionAsyncLocalStorage', true);

/*
  Runs fn inside one MongoDB transaction: a document, its stock movements
  and its journal entry are saved together or not at all. Transient write
  conflicts are retried by the driver, so fn must not have outside side
  effects (e.g. sending messages). Queries inside must not run in parallel
  (no Promise.all) — a session can't serve concurrent operations.
*/
function withTransaction(fn) {
  return mongoose.connection.transaction(fn);
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { withTransaction, httpError };
