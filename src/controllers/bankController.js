const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Account = require('../models/Account');
const JournalEntry = require('../models/JournalEntry');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, round2 } = require('../services/ledgerService');
const SYS = require('../utils/systemAccounts');

exports.listAccounts = async (req, res, next) => {
  try {
    const accounts = await BankAccount.find().populate('account', 'code name');
    res.json(accounts);
  } catch (err) {
    next(err);
  }
};

exports.createAccount = async (req, res, next) => {
  try {
    const { name, accountNumber, bankName, type, openingBalance } = req.body;

    // Auto-create a linked GL account under ASSET (Bank/Cash) for this bank account
    const code = await nextNumber('glAccount', '1' + (type === 'CASH' ? '1' : '0'), 3);
    const glAccount = await Account.create({
      code: `${SYS.BANK_CASH_DEFAULT}-${code}`,
      name: `${name} (${type === 'CASH' ? 'Cash' : 'Bank'})`,
      type: 'ASSET',
      subType: type === 'CASH' ? 'Cash' : 'Bank',
      normalBalance: 'debit',
      isSystem: true
    });

    const bankAccount = await BankAccount.create({
      name, accountNumber, bankName, type, account: glAccount._id, openingBalance
    });

    // Opening balance journal, offset against Opening Balance Equity
    if (openingBalance && openingBalance !== 0) {
      const { getAccountByCode } = require('../utils/getAccount');
      const obe = await getAccountByCode(SYS.OPENING_BALANCE_EQUITY);
      await postJournal({
        sourceType: 'OPENING_BALANCE',
        reference: bankAccount.name,
        narration: `Opening balance for ${bankAccount.name}`,
        lines: openingBalance > 0
          ? [{ account: glAccount._id, debit: openingBalance, credit: 0 }, { account: obe._id, debit: 0, credit: openingBalance }]
          : [{ account: obe._id, debit: -openingBalance, credit: 0 }, { account: glAccount._id, debit: 0, credit: -openingBalance }],
        createdBy: req.user._id
      });
    }

    const populated = await BankAccount.findById(bankAccount._id).populate('account', 'code name');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.transactions = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.bankAccount) filter.bankAccount = req.query.bankAccount;
    const txns = await BankTransaction.find(filter)
      .populate('bankAccount', 'name')
      .populate('toBankAccount', 'name')
      .populate('contraAccount', 'code name')
      .sort({ date: -1 });
    res.json(txns);
  } catch (err) {
    next(err);
  }
};

exports.createTransaction = async (req, res, next) => {
  try {
    const { bankAccount, date, type, amount, contraAccount, toBankAccount, reference, notes } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than zero.' });

    const bank = await BankAccount.findById(bankAccount);
    if (!bank) return res.status(400).json({ message: 'Bank account not found.' });

    let lines = [];
    if (type === 'DEPOSIT') {
      if (!contraAccount) return res.status(400).json({ message: 'contraAccount is required for a deposit.' });
      lines = [
        { account: bank.account, debit: amount, credit: 0 },
        { account: contraAccount, debit: 0, credit: amount }
      ];
    } else if (type === 'WITHDRAWAL') {
      if (!contraAccount) return res.status(400).json({ message: 'contraAccount is required for a withdrawal.' });
      lines = [
        { account: contraAccount, debit: amount, credit: 0 },
        { account: bank.account, debit: 0, credit: amount }
      ];
    } else if (type === 'TRANSFER') {
      if (!toBankAccount) return res.status(400).json({ message: 'toBankAccount is required for a transfer.' });
      const toBank = await BankAccount.findById(toBankAccount);
      if (!toBank) return res.status(400).json({ message: 'Destination bank account not found.' });
      lines = [
        { account: toBank.account, debit: amount, credit: 0 },
        { account: bank.account, debit: 0, credit: amount }
      ];
    } else {
      return res.status(400).json({ message: 'Invalid transaction type.' });
    }

    const entry = await postJournal({
      date: date || new Date(),
      sourceType: 'BANK_TRANSFER',
      reference,
      narration: notes || `${type} on ${bank.name}`,
      lines,
      createdBy: req.user._id
    });

    const txn = await BankTransaction.create({
      bankAccount, date, type, amount, contraAccount, toBankAccount, reference, notes,
      journalEntry: entry._id, createdBy: req.user._id
    });
    entry.sourceId = txn._id;
    await entry.save();

    const populated = await BankTransaction.findById(txn._id).populate('bankAccount', 'name').populate('toBankAccount', 'name');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

/* Running balance for a bank account = opening balance + sum of GL postings to its linked account */
exports.balance = async (req, res, next) => {
  try {
    const bank = await BankAccount.findById(req.params.id);
    if (!bank) return res.status(404).json({ message: 'Bank account not found.' });

    const entries = await JournalEntry.find({ 'lines.account': bank.account });
    let balance = bank.openingBalance || 0;
    for (const e of entries) {
      for (const l of e.lines) {
        if (l.account.toString() === bank.account.toString()) {
          balance += l.debit - l.credit;
        }
      }
    }
    res.json({ bankAccount: bank.name, balance: round2(balance) });
  } catch (err) {
    next(err);
  }
};
