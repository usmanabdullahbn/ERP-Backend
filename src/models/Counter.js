const mongoose = require('mongoose');

/*
  Simple atomic counter collection used to generate sequential, human-readable
  document numbers like INV-000001, BILL-000001, JE-000001, etc.
*/
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

module.exports = mongoose.model('Counter', counterSchema);
