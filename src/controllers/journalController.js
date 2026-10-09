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

exports.remove = async (req, res, next) => {
  try {
    const entry = await JournalEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Journal entry not found.' });
    if (entry.sourceType !== 'MANUAL') {
      return res.status(400).json({ message: `This entry was created by a ${entry.sourceType}. Delete or void the source document to remove it.` });
    }
    await entry.deleteOne();
    res.json({ message: 'Journal entry deleted.' });
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

exports.update = async (req, res, next) => {
  try {
    const entry = await JournalEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Journal entry not found.' });

    const { date, reference, narration, lines } = req.body;
    if (!lines || lines.length < 2) {
      return res.status(400).json({ message: 'At least two lines are required.' });
    }
    const accountIds = [...new Set(lines.map((l) => String(l.account)))];
    const accounts = await Account.find({ _id: { $in: accountIds } });
    if (accounts.length !== accountIds.length) {
      return res.status(400).json({ message: 'One or more journal lines reference an account that does not exist.' });
    }

    const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.005 || totalDebit === 0) {
      return res.status(400).json({ message: 'Debits must equal credits.' });
    }

    entry.date = date;
    entry.reference = reference;
    entry.narration = narration;
    entry.lines = lines.map((l) => ({ account: l.account, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo || '' }));
    entry.totalDebit = round2(totalDebit);
    entry.totalCredit = round2(totalCredit);
    await entry.save();

    const populated = await JournalEntry.findById(entry._id).populate('lines.account', 'code name');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const entry = await JournalEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Journal entry not found.' });
    await entry.deleteOne();
    res.json({ message: 'Journal entry deleted.' });
  } catch (err) {
    next(err);
  }
};
