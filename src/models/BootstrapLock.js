const mongoose = require('mongoose');

/*
  A single-document collection used purely as an atomic claim: MongoDB's
  unique index on _id means only one concurrent insert of { _id: 'bootstrap' }
  can ever succeed, so authController.register() can use it to close the race
  between checking "no users exist yet" and creating the first admin.
*/
const bootstrapLockSchema = new mongoose.Schema({
  _id: { type: String, default: 'bootstrap' }
});

module.exports = mongoose.model('BootstrapLock', bootstrapLockSchema);
