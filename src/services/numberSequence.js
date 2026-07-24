const mongoose = require('mongoose');

/*
  Simple atomic counter collection used to generate sequential, human-readable
  document numbers like INV-000001, BILL-000001, JE-000001, etc.
*/
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});
const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

async function nextNumber(key, prefix, padLength = 6) {
  const counter = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}-${String(counter.seq).padStart(padLength, '0')}`;
}

module.exports = { nextNumber };
