const Counter = require('../models/Counter');

async function nextNumber(key, prefix, padLength = 6) {
  const counter = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}-${String(counter.seq).padStart(padLength, '0')}`;
}

module.exports = { nextNumber };
