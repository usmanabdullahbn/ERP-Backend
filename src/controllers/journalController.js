const JournalEntry = require('../models/JournalEntry');
const Account = require('../models/Account');
const { postJournal, round2 } = require('../services/ledgerService');

exports.list = async (req, res, next) => {
  try {
    const { sourceType, from, to } = req.query;
    const filter = {};
    if (sourceType) filter.sourceType = sourceType;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    }
    const entries = await JournalEntry.find(filter).populate('lines.account', 'code name').populate('createdBy', 'name').sort({ date: -1, createdAt: -1 });
    res.json(entries);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const entry = await JournalEntry.findById(req.params.id).populate('lines.account', 'code name').populate('createdBy', 'name');
    if (!entry) return res.status(404).json({ message: 'Journal entry not found.' });
    res.json(entry);
  } catch (err) {
    next(err);
  }
};

/* Manual journal entry — for adjustments accountants need outside the automated modules. */
exports.createManual = async (req, res, next) => {
  try {
    const { date, reference, narration, lines } = req.body;
    if (!lines || lines.length < 2) {
      return res.status(400).json({ message: 'At least two lines are required.' });
    }
    const accountIds = [...new Set(lines.map((l) => String(l.account)))];
    const accounts = await Account.find({ _id: { $in: accountIds } });
    if (accounts.length !== accountIds.length) {
      return res.status(400).json({ message: 'One or more journal lines reference an account that does not exist.' });
    }
    const entry = await postJournal({
      date, sourceType: 'MANUAL', reference, narration, lines, createdBy: req.user._id
    });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
};
