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
    const glIds = accounts.map((a) => a.account?._id || a.account).filter(Boolean);
    const entries = await JournalEntry.find({
      'lines.account': { $in: glIds },
      isReversed: { $ne: true },
      reversalOf: null
    });
    const balMap = new Map();
    for (const e of entries) {
      for (const l of e.lines) {
        const k = String(l.account);
        balMap.set(k, round2((balMap.get(k) || 0) + (l.debit || 0) - (l.credit || 0)));
      }
    }
    const out = accounts.map((a) => {
      const obj = a.toObject();
      const k = a.account ? String(a.account._id || a.account) : '';
      obj.currentBalance = round2(balMap.get(k) || 0);
      return obj;
    });
    res.json(out);
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
    const allBanks = await BankAccount.find().populate('account', 'code name');
    const bankByGlId = new Map();
    for (const b of allBanks) {
      if (b.account) bankByGlId.set(String(b.account._id || b.account), b);
    }

    let targetBanks = allBanks;
    if (req.query.bankAccount) {
      targetBanks = allBanks.filter((b) => String(b._id) === String(req.query.bankAccount));
    }
    const targetGlIds = targetBanks
      .map((b) => (b.account ? String(b.account._id || b.account) : null))
      .filter(Boolean);

    if (targetGlIds.length === 0) return res.json([]);
    const targetGlSet = new Set(targetGlIds);

    const entries = await JournalEntry.find({
      'lines.account': { $in: targetGlIds },
      isReversed: { $ne: true },
      reversalOf: null
    })
      .populate('lines.account', 'code name')
      .sort({ date: -1, createdAt: -1, _id: -1 });

    const out = [];
    for (const entry of entries) {
      const bankLines = entry.lines.filter((l) => l.account && targetGlSet.has(String(l.account._id)));
      const allBankLines = entry.lines.filter((l) => l.account && bankByGlId.has(String(l.account._id)));
      const nonBankLines = entry.lines.filter((l) => l.account && !bankByGlId.has(String(l.account._id)));
      const isTransfer = entry.sourceType === 'BANK_TRANSFER' || (allBankLines.length >= 2 && nonBankLines.length === 0);

      for (const line of bankLines) {
        const glId = String(line.account._id);
        const bankDoc = bankByGlId.get(glId);
        const debit = round2(line.debit || 0);
        const credit = round2(line.credit || 0);
        if (debit === 0 && credit === 0) continue;

        const isInflow = debit > 0;
        const amount = isInflow ? debit : credit;
        const type = isTransfer ? 'TRANSFER' : isInflow ? 'DEPOSIT' : 'WITHDRAWAL';

        const otherLines = entry.lines.filter((l) => l !== line && l.account);
        let toBankAccount = null;
        let contraAccount = null;
        for (const ol of otherLines) {
          const ob = bankByGlId.get(String(ol.account._id));
          if (ob && !toBankAccount) {
            toBankAccount = { _id: ob._id, name: isInflow ? `From: ${ob.name}` : ob.name };
          } else if (!contraAccount) {
            contraAccount = { _id: ol.account._id, code: ol.account.code, name: `${ol.account.code} — ${ol.account.name}` };
          }
        }

        out.push({
          _id: `${entry._id}_${line._id || glId}`,
          date: entry.date,
          bankAccount: bankDoc ? { _id: bankDoc._id, name: bankDoc.name } : { name: line.account.name },
          toBankAccount,
          contraAccount,
          type,
          direction: isInflow ? 'IN' : 'OUT',
          debit,
          credit,
          amount,
          reference: entry.reference || entry.entryNumber || '',
          notes: line.memo || entry.narration || '',
          jvId: entry._id,
          jvNumber: entry.entryNumber || ''
        });
      }
    }

    res.json(out);
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
      const contra = await Account.findById(contraAccount);
      if (!contra) return res.status(400).json({ message: 'Selected contra account does not exist.' });
      lines = [
        { account: bank.account, debit: amount, credit: 0 },
        { account: contraAccount, debit: 0, credit: amount }
      ];
    } else if (type === 'WITHDRAWAL') {
      if (!contraAccount) return res.status(400).json({ message: 'contraAccount is required for a withdrawal.' });
      const contra = await Account.findById(contraAccount);
      if (!contra) return res.status(400).json({ message: 'Selected contra account does not exist.' });
      lines = [
        { account: contraAccount, debit: amount, credit: 0 },
        { account: bank.account, debit: 0, credit: amount }
      ];
    } else if (type === 'TRANSFER') {
      if (!toBankAccount) return res.status(400).json({ message: 'toBankAccount is required for a transfer.' });
      if (String(toBankAccount) === String(bankAccount)) {
        return res.status(400).json({ message: 'Cannot transfer a bank account to itself.' });
      }
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

/* Running balance for a bank account = sum of GL postings to its linked account (opening balance included) */
exports.balance = async (req, res, next) => {
  try {
    const bank = await BankAccount.findById(req.params.id);
    if (!bank) return res.status(404).json({ message: 'Bank account not found.' });

    const entries = await JournalEntry.find({ 'lines.account': bank.account });
    // The opening balance is already posted as a journal entry when the account is created.
    let balance = 0;
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
