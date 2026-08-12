const Account = require('../models/Account');
const JournalEntry = require('../models/JournalEntry');

exports.list = async (req, res, next) => {
  try {
    const { type } = req.query;
    const filter = {};
    if (type) filter.type = type;
    const accounts = await Account.find(filter).sort({ code: 1 });
    res.json(accounts);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { code, name, type, subType, normalBalance, description, parent } = req.body;
    const account = await Account.create({ code, name, type, subType, normalBalance, description, parent });
    res.status(201).json(account);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (account.isSystem) {
      return res.status(400).json({ message: 'System control accounts cannot be edited.' });
    }
    const { code, name, subType, description, isActive } = req.body;
    if (code !== undefined && code !== account.code) {
      const hasPostings = await JournalEntry.exists({ 'lines.account': account._id });
      if (hasPostings) {
        return res.status(400).json({ message: 'Cannot change the code of an account that already has journal entry postings.' });
      }
      account.code = code;
    }
    if (name !== undefined) account.name = name;
    if (subType !== undefined) account.subType = subType;
    if (description !== undefined) account.description = description;
    if (isActive !== undefined) account.isActive = isActive;
    await account.save();
    res.json(account);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found.' });
    if (account.isSystem) {
      return res.status(400).json({ message: 'System control accounts cannot be deleted.' });
    }
    const hasPostings = await JournalEntry.exists({ 'lines.account': account._id });
    if (hasPostings) {
      return res.status(400).json({ message: 'Cannot delete an account that has journal entry postings. Deactivate it instead.' });
    }
    await account.deleteOne();
    res.json({ message: 'Account deleted.' });
  } catch (err) {
    next(err);
  }
};
