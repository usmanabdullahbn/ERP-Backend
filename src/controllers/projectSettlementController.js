const ProjectSettlement = require('../models/ProjectSettlement');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const Receipt = require('../models/Receipt');
const BankAccount = require('../models/BankAccount');
const Account = require('../models/Account');
const JournalEntry = require('../models/JournalEntry');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { getAccountByCode } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');
const { withTransaction, httpError } = require('../services/transaction');

async function createMaalReceipt({ customer, date, bank, amount, invoice, reference, userId }) {
  const receiptNumber = await nextNumber('receipt', 'RCPT');
  const arAccount = await getAccountByCode(SYS.ACCOUNTS_RECEIVABLE);

  const entry = await postJournal({
    date,
    sourceType: 'RECEIPT',
    reference: receiptNumber,
    narration: `Receipt for Maal Invoice ${invoice.invoiceNumber} (${reference})`,
    lines: [
      { account: bank.account, debit: amount, credit: 0, memo: `Receipt ${receiptNumber} (${invoice.invoiceNumber})` },
      { account: arAccount._id, debit: 0, credit: amount, memo: `Allocation to ${invoice.invoiceNumber}` }
    ],
    createdBy: userId
  });

  const receipt = await Receipt.create({
    receiptNumber,
    customer: invoice.customer?._id || invoice.customer || customer,
    date,
    bankAccount: bank._id,
    amount,
    reference: `${reference} / ${invoice.invoiceNumber}`,
    method: bank.type === 'CASH' ? 'CASH' : 'BANK_TRANSFER',
    allocations: [{ invoice: invoice._id, amount, discount: 0 }],
    notes: `Project settlement (${reference}) — allocated to ${invoice.invoiceNumber}`,
    journalEntry: entry._id,
    createdBy: userId
  });

  entry.sourceId = receipt._id;
  await entry.save();

  invoice.amountPaid = round2((invoice.amountPaid || 0) + amount);
  if (invoice.amountPaid >= invoice.grandTotal - 0.005) {
    invoice.status = 'PAID';
  } else if (invoice.amountPaid > 0) {
    invoice.status = 'PARTIALLY_PAID';
  }
  await invoice.save();

  return receipt;
}

async function buildAndPostSettlement({ projectNumber, body, userId }) {
  const {
    projectType = 'IN_HOUSE',
    customer,
    date,
    reference = '',
    notes = '',
    maalInvoice: maalInvoiceId,
    maalInvoices: rawMaalInvoices,
    dealAmount: rawDealAmount,
    fabricatorName = '',
    fabricatorAccount: fabricatorAccountId,
    fabricatorQuotation: rawFabricatorQuotation = 0,
    fabricatorPaidAmount: rawFabricatorPaidAmount = 0,
    fabricatorPaidFromBankAccount: fabricatorPaidFromBankAccountId,
    expenses: rawExpenses = [],
    cashAmount: rawCashAmount = 0,
    cashBankAccount: cashBankAccountId,
    bankAmount: rawBankAmount = 0,
    bankBankAccount: bankBankAccountId,
    expensePaidFromBankAccount: expensePaidFromBankAccountId,
    incomeAccount: incomeAccountId,
    receivableAccount: receivableAccountId
  } = body;

  const isOutsource = projectType === 'OUTSOURCE';

  const customerDoc = await Customer.findById(customer);
  if (!customerDoc) throw httpError(400, 'Selected customer (client) does not exist.');

  const dealAmount = round2(Number(rawDealAmount) || 0);
  if (dealAmount <= 0) throw httpError(400, 'Total client deal amount must be greater than zero.');

  const incomeAccount = await Account.findById(incomeAccountId);
  if (!incomeAccount) throw httpError(400, 'Select a Project Income / Commission account.');
  const receivableAccount = await Account.findById(receivableAccountId);
  if (!receivableAccount) throw httpError(400, 'Select a Project Receivable account.');

  // Normalize one or multiple Maal Invoice IDs (preserving selection order and uniqueness)
  const requestedIds = Array.isArray(rawMaalInvoices) && rawMaalInvoices.length > 0
    ? rawMaalInvoices
    : maalInvoiceId
      ? [maalInvoiceId]
      : [];
  const uniqueInvoiceIds = [...new Set(requestedIds.filter(Boolean).map(String))];

  const invoiceDocs = [];
  let maalInvoiceAmount = 0;
  let maalDue = 0;
  const dueByInvId = new Map();

  for (const invId of uniqueInvoiceIds) {
    const inv = await Invoice.findById(invId).populate('customer', 'name');
    if (!inv) throw httpError(400, 'One of the selected Maal invoices does not exist.');
    if (['DRAFT', 'VOID', 'POSTING'].includes(inv.status)) {
      throw httpError(400, `Maal invoice ${inv.invoiceNumber} must be posted before settling.`);
    }
    invoiceDocs.push(inv);
    maalInvoiceAmount = round2(maalInvoiceAmount + round2(inv.grandTotal));
    const due = round2(Math.max(0, inv.grandTotal - (inv.amountPaid || 0)));
    dueByInvId.set(String(inv._id), due);
    maalDue = round2(maalDue + due);
  }
  const invoice = invoiceDocs[0] || null;
  const maalInvNumbersLabel = invoiceDocs.map((i) => i.invoiceNumber).join(', ');

  if (dealAmount < maalInvoiceAmount) {
    throw httpError(400, 'Total client deal amount cannot be less than the combined Maal invoices total.');
  }

  const projectCharges = round2(dealAmount - maalInvoiceAmount);

  const cashAmount = round2(Math.max(0, Number(rawCashAmount) || 0));
  const bankAmount = round2(Math.max(0, Number(rawBankAmount) || 0));

  let cashBank = null;
  if (cashAmount > 0) {
    if (!cashBankAccountId) throw httpError(400, 'Select a Cash account for Cash Advance.');
    cashBank = await BankAccount.findById(cashBankAccountId);
    if (!cashBank) throw httpError(400, 'Selected Cash account not found.');
  }

  let bankBank = null;
  if (bankAmount > 0) {
    if (!bankBankAccountId) throw httpError(400, 'Select a Bank account for Bank Payment.');
    bankBank = await BankAccount.findById(bankBankAccountId);
    if (!bankBank) throw httpError(400, 'Selected Bank account not found.');
  }

  const expenses = [];
  let extraExpensesTotal = 0;
  for (const exp of rawExpenses) {
    const amt = round2(Number(exp.amount) || 0);
    if (amt <= 0) continue;
    let expAcc = null;
    if (exp.account) {
      expAcc = await Account.findById(exp.account);
    }
    expenses.push({
      account: expAcc ? expAcc._id : null,
      label: (exp.label || (expAcc ? expAcc.name : 'Project Expense')).trim(),
      amount: amt
    });
    extraExpensesTotal = round2(extraExpensesTotal + amt);
  }

  let expenseBank = null;
  if (extraExpensesTotal > 0) {
    const paidFromId = expensePaidFromBankAccountId || cashBankAccountId;
    if (!paidFromId) throw httpError(400, 'Select the Cash/Bank account used to pay direct project expenses.');
    expenseBank = await BankAccount.findById(paidFromId);
    if (!expenseBank) throw httpError(400, 'Expense payment account not found.');
  }

  const docDate = date || new Date();
  const refLabel = reference ? `${reference} (${projectNumber})` : projectNumber;

  const createdReceipts = [];
  const createdJvs = [];
  const paymentLogs = [];

  let fabricatorAccDoc = null;
  let fabricatorQuotation = 0;
  let fabricatorNetCost = 0;
  let fabricatorPaidAmount = 0;
  let fabricatorBank = null;
  let fabricatorBalanceDue = 0;
  let totalExpenses = extraExpensesTotal;
  let netProfit = 0;
  let maalSettledByProject = 0;
  let maalSettledDirectlyInJv = false;
  const clientPaidTotal = round2(cashAmount + bankAmount);
  let clientBalance = 0;

  const maalAllocations = [];

  if (isOutsource) {
    fabricatorQuotation = round2(Number(rawFabricatorQuotation) || 0);
    if (fabricatorQuotation <= 0) {
      throw httpError(400, 'Enter the Fabricator Quotation amount for an Outsource project.');
    }
    if (fabricatorQuotation < maalInvoiceAmount) {
      throw httpError(400, 'Fabricator Quotation cannot be less than the Maal Invoice(s) given to the fabricator.');
    }
    if (!fabricatorAccountId) {
      throw httpError(400, 'Select the Outsource Fabricator account (e.g. 5050 Rashid Butt or 5060 Sajjad).');
    }
    fabricatorAccDoc = await Account.findById(fabricatorAccountId);
    if (!fabricatorAccDoc) throw httpError(400, 'Selected Outsource Fabricator account not found.');

    maalSettledByProject = invoiceDocs.length ? maalDue : 0;
    maalSettledDirectlyInJv = maalSettledByProject > 0;

    fabricatorNetCost = round2(fabricatorQuotation - maalInvoiceAmount);
    totalExpenses = round2(fabricatorNetCost + extraExpensesTotal);
    netProfit = round2(projectCharges - totalExpenses);

    fabricatorPaidAmount = round2(Math.max(0, Number(rawFabricatorPaidAmount) || 0));
    if (fabricatorPaidAmount > fabricatorNetCost) {
      throw httpError(400, 'Amount paid to fabricator now cannot exceed Net Payable to Fabricator (Quotation − Maal Invoices).');
    }
    if (fabricatorPaidAmount > 0) {
      if (!fabricatorPaidFromBankAccountId) {
        throw httpError(400, 'Select the Bank/Cash account used to pay the fabricator.');
      }
      fabricatorBank = await BankAccount.findById(fabricatorPaidFromBankAccountId);
      if (!fabricatorBank) throw httpError(400, 'Selected Fabricator payment Bank/Cash account not found.');
    }
    fabricatorBalanceDue = round2(fabricatorNetCost - fabricatorPaidAmount);

    for (const invDoc of invoiceDocs) {
      const due = round2(dueByInvId.get(String(invDoc._id)) || 0);
      maalAllocations.push({
        invoice: invDoc._id,
        invoiceAmount: round2(invDoc.grandTotal),
        settledAmount: due
      });
      if (due > 0) {
        invDoc.amountPaid = round2((invDoc.amountPaid || 0) + due);
        if (invDoc.amountPaid >= invDoc.grandTotal - 0.005) {
          invDoc.status = 'PAID';
        } else if (invDoc.amountPaid > 0) {
          invDoc.status = 'PARTIALLY_PAID';
        }
        await invDoc.save();
      }
    }

    const clientBilledInProjectAr = round2(projectCharges + maalSettledByProject);
    clientBalance = round2(clientBilledInProjectAr - clientPaidTotal);

    const arAccount = await getAccountByCode(SYS.ACCOUNTS_RECEIVABLE);
    const fabDisplay = (fabricatorName || fabricatorAccDoc.name).trim();

    const jv1Lines = [
      {
        account: receivableAccount._id,
        debit: clientBilledInProjectAr,
        credit: 0,
        memo: `${customerDoc.name} — Outsource Project Deal (${refLabel})`
      }
    ];

    if (maalSettledByProject > 0 && invoiceDocs.length) {
      jv1Lines.push({
        account: arAccount._id,
        debit: 0,
        credit: maalSettledByProject,
        memo: `Maal ${maalInvNumbersLabel} deducted from ${fabDisplay} quotation`
      });
    }

    if (netProfit > 0) {
      jv1Lines.push({
        account: incomeAccount._id,
        debit: 0,
        credit: netProfit,
        memo: `Net Commission Income (Deal ${dealAmount} - Fabricator ${fabricatorQuotation}${extraExpensesTotal > 0 ? ` - Expenses ${extraExpensesTotal}` : ''})`
      });
    } else if (netProfit < 0) {
      jv1Lines.push({
        account: incomeAccount._id,
        debit: round2(-netProfit),
        credit: 0,
        memo: `Project loss (${refLabel})`
      });
    }

    if (fabricatorNetCost > 0) {
      jv1Lines.push({
        account: fabricatorAccDoc._id,
        debit: 0,
        credit: fabricatorNetCost,
        memo: `Net Payable to ${fabDisplay} (Quotation ${fabricatorQuotation} - Maal ${maalInvoiceAmount})`
      });
    }

    if (extraExpensesTotal > 0 && expenseBank) {
      const expMemo = expenses.map((e) => `${e.label} ${e.amount}`).join(' + ');
      jv1Lines.push({
        account: expenseBank.account,
        debit: 0,
        credit: extraExpensesTotal,
        memo: `Extra project expenses paid: ${expMemo}`
      });
    }

    if (jv1Lines.length >= 2) {
      const jv1 = await postJournal({
        date: docDate,
        sourceType: 'MANUAL',
        reference: `${customerDoc.name} / ${reference || projectNumber}`,
        narration: `Outsource Project Deal ${projectNumber}: Client ${customerDoc.name} Deal Rs. ${dealAmount}; Fabricator ${fabDisplay} Quotation Rs. ${fabricatorQuotation}; Maal ${maalInvNumbersLabel || 'None'} Rs. ${maalInvoiceAmount}; Net Payable to Fabricator Rs. ${fabricatorNetCost}; Net Commission Rs. ${netProfit}`,
        lines: jv1Lines,
        createdBy: userId
      });
      createdJvs.push(jv1._id);
    }

    if (fabricatorPaidAmount > 0 && fabricatorBank) {
      const jvFabPay = await postJournal({
        date: docDate,
        sourceType: 'MANUAL',
        reference: `${fabDisplay} / Payment (${projectNumber})`,
        narration: `Payment to Outsource Fabricator ${fabDisplay} for ${reference || projectNumber}`,
        lines: [
          {
            account: fabricatorAccDoc._id,
            debit: fabricatorPaidAmount,
            credit: 0,
            memo: `Paid to ${fabDisplay} (${refLabel})`
          },
          {
            account: fabricatorBank.account,
            debit: 0,
            credit: fabricatorPaidAmount,
            memo: `Fabricator payment from ${fabricatorBank.name}`
          }
        ],
        createdBy: userId
      });
      createdJvs.push(jvFabPay._id);
      paymentLogs.push({
        type: 'FABRICATOR_PAYMENT',
        date: docDate,
        amount: fabricatorPaidAmount,
        bankAccount: fabricatorBank._id,
        reference: `Initial payment (${projectNumber})`,
        journalEntry: jvFabPay._id
      });
    }

    if (cashAmount > 0 && cashBank) {
      const jvCash = await postJournal({
        date: docDate,
        sourceType: 'MANUAL',
        reference: `${customerDoc.name} / Cash Advance (${projectNumber})`,
        narration: `Cash advance received from ${customerDoc.name} for ${reference || projectNumber}`,
        lines: [
          {
            account: cashBank.account,
            debit: cashAmount,
            credit: 0,
            memo: `Cash advance from ${customerDoc.name}`
          },
          {
            account: receivableAccount._id,
            debit: 0,
            credit: cashAmount,
            memo: `${customerDoc.name} — Cash advance credited`
          }
        ],
        createdBy: userId
      });
      createdJvs.push(jvCash._id);
      paymentLogs.push({
        type: 'CLIENT_RECEIPT',
        date: docDate,
        amount: cashAmount,
        bankAccount: cashBank._id,
        reference: `Cash Advance (${projectNumber})`,
        journalEntry: jvCash._id
      });
    }

    if (bankAmount > 0 && bankBank) {
      const jvBank = await postJournal({
        date: docDate,
        sourceType: 'MANUAL',
        reference: `${customerDoc.name} / Bank Advance (${projectNumber})`,
        narration: `Bank payment received in ${bankBank.name} from ${customerDoc.name} for ${reference || projectNumber}`,
        lines: [
          {
            account: bankBank.account,
            debit: bankAmount,
            credit: 0,
            memo: `Bank transfer from ${customerDoc.name} in ${bankBank.name}`
          },
          {
            account: receivableAccount._id,
            debit: 0,
            credit: bankAmount,
            memo: `${customerDoc.name} — Bank payment credited`
          }
        ],
        createdBy: userId
      });
      createdJvs.push(jvBank._id);
      paymentLogs.push({
        type: 'CLIENT_RECEIPT',
        date: docDate,
        amount: bankAmount,
        bankAccount: bankBank._id,
        reference: `Bank Advance in ${bankBank.name} (${projectNumber})`,
        journalEntry: jvBank._id
      });
    }
  } else {
    totalExpenses = extraExpensesTotal;
    netProfit = round2(projectCharges - totalExpenses);

    const totalReceived = round2(cashAmount + bankAmount);
    const maalReceiptTotal = invoiceDocs.length ? round2(Math.min(maalDue, totalReceived)) : 0;
    const cashForMaal = round2(Math.min(cashAmount, maalReceiptTotal));
    const bankForMaal = round2(maalReceiptTotal - cashForMaal);
    maalSettledByProject = maalReceiptTotal;
    maalSettledDirectlyInJv = false;

    let remCash = cashForMaal;
    let remBank = bankForMaal;
    for (const invDoc of invoiceDocs) {
      const due = round2(dueByInvId.get(String(invDoc._id)) || 0);
      let settledOnThisInv = 0;
      if (due > 0 && remCash > 0) {
        const cAmt = round2(Math.min(due, remCash));
        const r = await createMaalReceipt({
          customer,
          date: docDate,
          bank: cashBank,
          amount: cAmt,
          invoice: invDoc,
          reference: reference || projectNumber,
          userId
        });
        createdReceipts.push(r._id);
        remCash = round2(remCash - cAmt);
        settledOnThisInv = round2(settledOnThisInv + cAmt);
      }
      const remDue = round2(due - settledOnThisInv);
      if (remDue > 0 && remBank > 0) {
        const bAmt = round2(Math.min(remDue, remBank));
        const r = await createMaalReceipt({
          customer,
          date: docDate,
          bank: bankBank,
          amount: bAmt,
          invoice: invDoc,
          reference: reference || projectNumber,
          userId
        });
        createdReceipts.push(r._id);
        remBank = round2(remBank - bAmt);
        settledOnThisInv = round2(settledOnThisInv + bAmt);
      }
      maalAllocations.push({
        invoice: invDoc._id,
        invoiceAmount: round2(invDoc.grandTotal),
        settledAmount: settledOnThisInv
      });
    }

    const cashForProject = round2(cashAmount - cashForMaal);
    const bankForProject = round2(bankAmount - bankForMaal);
    const maalUnpaidRemaining = invoiceDocs.length ? round2(Math.max(0, maalDue - maalReceiptTotal)) : 0;
    clientBalance = round2(projectCharges + maalUnpaidRemaining - cashForProject - bankForProject);

    if (projectCharges > 0 || totalExpenses > 0) {
      const jv1Lines = [];
      if (projectCharges > 0) {
        jv1Lines.push({
          account: receivableAccount._id,
          debit: projectCharges,
          credit: 0,
          memo: `${customerDoc.name} (${reference || 'Project fabrication billed'})`
        });
      }
      if (netProfit > 0) {
        jv1Lines.push({
          account: incomeAccount._id,
          debit: 0,
          credit: netProfit,
          memo: `Net Commission Income (Rs. ${projectCharges} - ${totalExpenses})`
        });
      } else if (netProfit < 0) {
        jv1Lines.push({
          account: incomeAccount._id,
          debit: round2(-netProfit),
          credit: 0,
          memo: `Project loss (${refLabel})`
        });
      }
      if (totalExpenses > 0 && expenseBank) {
        const expSummary = expenses.map((e) => `${e.label} ${e.amount}`).join(' + ');
        jv1Lines.push({
          account: expenseBank.account,
          debit: 0,
          credit: totalExpenses,
          memo: `Paid from ${expenseBank.name}: ${expSummary}`
        });
      }

      if (jv1Lines.length >= 2) {
        const expSummary = expenses.map((e) => `${e.label} ${e.amount}`).join(' + ');
        const jv1 = await postJournal({
          date: docDate,
          sourceType: 'MANUAL',
          reference: `${customerDoc.name} / Deal & Commission Breakdown`,
          narration: `Project deal billing (${projectNumber}): Rs. ${projectCharges} billed to ${customerDoc.name}; Expenses Rs. ${totalExpenses}${expSummary ? ` (${expSummary})` : ''}; Net Commission Income Rs. ${netProfit}`,
          lines: jv1Lines,
          createdBy: userId
        });
        createdJvs.push(jv1._id);
      }
    }

    if (cashForProject > 0 && cashBank) {
      const jv2 = await postJournal({
        date: docDate,
        sourceType: 'MANUAL',
        reference: `${customerDoc.name} / Cash Advance Balance`,
        narration: `Cash advance balance received from ${customerDoc.name}: Rs. ${cashAmount} total cash minus Rs. ${cashForMaal} applied to Maal invoice`,
        lines: [
          {
            account: cashBank.account,
            debit: cashForProject,
            credit: 0,
            memo: `Cash advance balance received from ${customerDoc.name}`
          },
          {
            account: receivableAccount._id,
            debit: 0,
            credit: cashForProject,
            memo: `${customerDoc.name} (Cash advance balance credited)`
          }
        ],
        createdBy: userId
      });
      createdJvs.push(jv2._id);
      paymentLogs.push({
        type: 'CLIENT_RECEIPT',
        date: docDate,
        amount: cashForProject,
        bankAccount: cashBank._id,
        reference: `Cash Advance Balance (${projectNumber})`,
        journalEntry: jv2._id
      });
    }

    if (bankForProject > 0 && bankBank) {
      const jv3 = await postJournal({
        date: docDate,
        sourceType: 'MANUAL',
        reference: `${customerDoc.name} / Bank Payment to ${bankBank.name}`,
        narration: `Online bank transfer received in ${bankBank.name} from ${customerDoc.name} (${reference || projectNumber})`,
        lines: [
          {
            account: bankBank.account,
            debit: bankForProject,
            credit: 0,
            memo: `${customerDoc.name} transfer to ${bankBank.name}`
          },
          {
            account: receivableAccount._id,
            debit: 0,
            credit: bankForProject,
            memo: `${customerDoc.name} (Bank transfer credited)`
          }
        ],
        createdBy: userId
      });
      createdJvs.push(jv3._id);
      paymentLogs.push({
        type: 'CLIENT_RECEIPT',
        date: docDate,
        amount: bankForProject,
        bankAccount: bankBank._id,
        reference: `Bank Payment in ${bankBank.name} (${projectNumber})`,
        journalEntry: jv3._id
      });
    }
  }

  return {
    projectNumber,
    projectType: isOutsource ? 'OUTSOURCE' : 'IN_HOUSE',
    date: docDate,
    customer,
    reference,
    notes,
    maalInvoice: invoice ? invoice._id : null,
    maalInvoices: invoiceDocs.map((i) => i._id),
    maalAllocations,
    maalInvoiceAmount,
    maalSettledByProject,
    maalSettledDirectlyInJv,
    dealAmount,
    projectCharges,
    fabricatorName: isOutsource ? (fabricatorName || (fabricatorAccDoc ? fabricatorAccDoc.name : '')) : '',
    fabricatorAccount: fabricatorAccDoc ? fabricatorAccDoc._id : null,
    fabricatorQuotation,
    fabricatorNetCost,
    fabricatorPaidAmount,
    fabricatorPaidFromBankAccount: fabricatorBank ? fabricatorBank._id : null,
    fabricatorBalanceDue,
    expenses,
    totalExpenses,
    netProfit,
    cashAmount,
    cashBankAccount: cashBank ? cashBank._id : null,
    bankAmount,
    bankBankAccount: bankBank ? bankBank._id : null,
    expensePaidFromBankAccount: expenseBank ? expenseBank._id : null,
    incomeAccount: incomeAccount._id,
    receivableAccount: receivableAccount._id,
    clientPaidTotal,
    clientBalance,
    receipts: createdReceipts,
    journalEntry: createdJvs[0] || null,
    journalEntries: createdJvs,
    paymentLogs,
    status: 'POSTED',
    createdBy: userId
  };
}

exports.list = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.customerId) filter.customer = req.query.customerId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.projectType) filter.projectType = req.query.projectType;
    const items = await ProjectSettlement.find(filter)
      .populate('customer', 'name code')
      .populate({
        path: 'maalInvoice',
        select: 'invoiceNumber grandTotal amountPaid status customer',
        populate: { path: 'customer', select: 'name code' }
      })
      .populate({
        path: 'maalInvoices',
        select: 'invoiceNumber grandTotal amountPaid status customer',
        populate: { path: 'customer', select: 'name code' }
      })
      .populate('fabricatorAccount', 'code name')
      .populate('incomeAccount', 'code name')
      .populate('receivableAccount', 'code name')
      .sort({ date: -1, createdAt: -1 });
    res.json(items);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const doc = await ProjectSettlement.findById(req.params.id)
      .populate('customer', 'name code')
      .populate({
        path: 'maalInvoice',
        select: 'invoiceNumber grandTotal amountPaid status customer',
        populate: { path: 'customer', select: 'name code' }
      })
      .populate({
        path: 'maalInvoices',
        select: 'invoiceNumber grandTotal amountPaid status customer',
        populate: { path: 'customer', select: 'name code' }
      })
      .populate('fabricatorAccount', 'code name')
      .populate('fabricatorPaidFromBankAccount', 'name type')
      .populate('expenses.account', 'code name')
      .populate('cashBankAccount', 'name type')
      .populate('bankBankAccount', 'name type')
      .populate('expensePaidFromBankAccount', 'name type')
      .populate('incomeAccount', 'code name')
      .populate('receivableAccount', 'code name')
      .populate('receipts', 'receiptNumber amount date reference')
      .populate('journalEntry', 'entryNumber date reference totalDebit')
      .populate('journalEntries', 'entryNumber date reference narration totalDebit')
      .populate('paymentLogs.bankAccount', 'name type')
      .populate('paymentLogs.journalEntry', 'entryNumber date');
    if (!doc) return res.status(404).json({ message: 'Project settlement not found.' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const settlementId = await withTransaction(async () => {
      const projectNumber = await nextNumber('projectSettlement', 'PRJ');
      const fields = await buildAndPostSettlement({
        projectNumber,
        body: req.body,
        userId: req.user._id
      });
      const [created] = await ProjectSettlement.create([fields]);
      return created._id;
    });

    const populated = await ProjectSettlement.findById(settlementId)
      .populate('customer', 'name code')
      .populate('maalInvoice', 'invoiceNumber grandTotal status')
      .populate('maalInvoices', 'invoiceNumber grandTotal status');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

/*
  Edit / Update an existing Project Deal:
  Cleanly unwinds the previous Maal invoice settlement, receipts, and JVs
  created by this project deal inside one transaction, and re-posts the
  updated JVs and invoice settlement.
*/
exports.update = async (req, res, next) => {
  try {
    await withTransaction(async () => {
      const doc = await ProjectSettlement.findById(req.params.id);
      if (!doc) throw httpError(404, 'Project settlement not found.');
      if (doc.status === 'VOID') throw httpError(400, 'Cannot edit a voided project settlement.');

      // 1. Restore old Maal Invoice(s) amountPaid if settled directly in JV (Outsource mode)
      if (doc.maalSettledDirectlyInJv) {
        if (doc.maalAllocations && doc.maalAllocations.length > 0) {
          for (const alloc of doc.maalAllocations) {
            if (!alloc.invoice || !(alloc.settledAmount > 0)) continue;
            const inv = await Invoice.findById(alloc.invoice);
            if (inv) {
              inv.amountPaid = round2(Math.max(0, (inv.amountPaid || 0) - alloc.settledAmount));
              if (inv.status !== 'VOID' && inv.status !== 'DRAFT') {
                inv.status = inv.amountPaid >= inv.grandTotal - 0.005
                  ? 'PAID'
                  : inv.amountPaid > 0
                    ? 'PARTIALLY_PAID'
                    : 'POSTED';
              }
              await inv.save();
            }
          }
        } else if (doc.maalInvoice && doc.maalSettledByProject > 0) {
          const inv = await Invoice.findById(doc.maalInvoice);
          if (inv) {
            inv.amountPaid = round2(Math.max(0, (inv.amountPaid || 0) - doc.maalSettledByProject));
            if (inv.status !== 'VOID' && inv.status !== 'DRAFT') {
              inv.status = inv.amountPaid >= inv.grandTotal - 0.005
                ? 'PAID'
                : inv.amountPaid > 0
                  ? 'PARTIALLY_PAID'
                  : 'POSTED';
            }
            await inv.save();
          }
        }
      }

      // 2. Remove old Receipts created by this project deal and restore invoice allocations
      for (const receiptId of doc.receipts || []) {
        const receipt = await Receipt.findById(receiptId);
        if (!receipt) continue;
        for (const alloc of receipt.allocations || []) {
          const inv = await Invoice.findById(alloc.invoice);
          if (!inv) continue;
          inv.amountPaid = round2(Math.max(0, (inv.amountPaid || 0) - alloc.amount - (alloc.discount || 0)));
          if (inv.status !== 'VOID' && inv.status !== 'DRAFT') {
            inv.status = inv.amountPaid >= inv.grandTotal - 0.005
              ? 'PAID'
              : inv.amountPaid > 0
                ? 'PARTIALLY_PAID'
                : 'POSTED';
          }
          await inv.save();
        }
        if (receipt.journalEntry) {
          await JournalEntry.deleteOne({ _id: receipt.journalEntry });
        }
        await Receipt.deleteOne({ _id: receipt._id });
      }

      // 3. Remove old JVs created by this project deal
      const jvIds = doc.journalEntries?.length
        ? doc.journalEntries
        : doc.journalEntry
          ? [doc.journalEntry]
          : [];
      for (const jvId of jvIds) {
        await JournalEntry.deleteOne({ _id: jvId });
      }

      // 4. Build and post updated project settlement with the same projectNumber
      const fields = await buildAndPostSettlement({
        projectNumber: doc.projectNumber,
        body: req.body,
        userId: req.user._id
      });

      Object.assign(doc, fields);
      await doc.save();
    });

    return exports.get(req, res, next);
  } catch (err) {
    next(err);
  }
};

/*
  Follow-up Client Receipt: When client pays the remaining balance (e.g. Rs. 143,837 on Najam Masjid)
*/
exports.receiveClientPayment = async (req, res, next) => {
  try {
    await withTransaction(async () => {
      const doc = await ProjectSettlement.findById(req.params.id).populate('customer', 'name');
      if (!doc) throw httpError(404, 'Project settlement not found.');
      if (doc.status === 'VOID') throw httpError(400, 'Cannot receive payment on a voided project.');

      const amount = round2(Number(req.body.amount) || 0);
      if (amount <= 0) throw httpError(400, 'Payment amount must be greater than zero.');
      if (amount > round2(doc.clientBalance + 0.01)) {
        throw httpError(400, `Payment amount cannot exceed remaining client balance (${doc.clientBalance}).`);
      }

      const bank = await BankAccount.findById(req.body.bankAccount);
      if (!bank) throw httpError(400, 'Select a valid Bank/Cash account.');

      const payDate = req.body.date || new Date();
      const payRef = (req.body.reference || `${doc.customer?.name || 'Client'} / Balance Payment (${doc.projectNumber})`).trim();

      const jv = await postJournal({
        date: payDate,
        sourceType: 'MANUAL',
        reference: payRef,
        narration: `Project balance received in ${bank.name} from ${doc.customer?.name || 'Client'} for ${doc.reference || doc.projectNumber}`,
        lines: [
          {
            account: bank.account,
            debit: amount,
            credit: 0,
            memo: `Received from ${doc.customer?.name || 'Client'} (${doc.projectNumber})`
          },
          {
            account: doc.receivableAccount,
            debit: 0,
            credit: amount,
            memo: `${doc.customer?.name || 'Client'} — Project balance credited (${doc.projectNumber})`
          }
        ],
        createdBy: req.user._id
      });

      doc.clientPaidTotal = round2((doc.clientPaidTotal || 0) + amount);
      doc.clientBalance = round2(Math.max(0, (doc.clientBalance || 0) - amount));
      doc.journalEntries = [...(doc.journalEntries || []), jv._id];
      doc.paymentLogs = [
        ...(doc.paymentLogs || []),
        {
          type: 'CLIENT_RECEIPT',
          date: payDate,
          amount,
          bankAccount: bank._id,
          reference: payRef,
          journalEntry: jv._id
        }
      ];
      await doc.save();
    });

    return exports.get(req, res, next);
  } catch (err) {
    next(err);
  }
};

/*
  Follow-up Fabricator Payment: When work completes and we pay the fabricator
  (e.g. Rashid Butt: Quotation 364,281 - Maal INV-000020 274,898 = Rs. 89,383)
*/
exports.payFabricatorBalance = async (req, res, next) => {
  try {
    await withTransaction(async () => {
      const doc = await ProjectSettlement.findById(req.params.id).populate('fabricatorAccount', 'name code');
      if (!doc) throw httpError(404, 'Project settlement not found.');
      if (doc.status === 'VOID') throw httpError(400, 'Cannot pay fabricator on a voided project.');
      if (doc.projectType !== 'OUTSOURCE' || !doc.fabricatorAccount) {
        throw httpError(400, 'This project does not have an Outsource Fabricator account.');
      }

      const amount = round2(Number(req.body.amount) || 0);
      if (amount <= 0) throw httpError(400, 'Payment amount must be greater than zero.');
      if (amount > round2(doc.fabricatorBalanceDue + 0.01)) {
        throw httpError(400, `Payment amount cannot exceed remaining fabricator payable (${doc.fabricatorBalanceDue}).`);
      }

      const bank = await BankAccount.findById(req.body.bankAccount);
      if (!bank) throw httpError(400, 'Select a valid Bank/Cash account.');

      const payDate = req.body.date || new Date();
      const fabName = doc.fabricatorName || doc.fabricatorAccount.name;
      const payRef = (req.body.reference || `${fabName} / Settlement (${doc.projectNumber})`).trim();

      const jv = await postJournal({
        date: payDate,
        sourceType: 'MANUAL',
        reference: payRef,
        narration: `Paid to Outsource Fabricator ${fabName} from ${bank.name} for ${doc.reference || doc.projectNumber} (Quotation ${doc.fabricatorQuotation} - Maal ${doc.maalInvoiceAmount})`,
        lines: [
          {
            account: doc.fabricatorAccount._id,
            debit: amount,
            credit: 0,
            memo: `Settlement paid to ${fabName} (${doc.projectNumber})`
          },
          {
            account: bank.account,
            debit: 0,
            credit: amount,
            memo: `Paid from ${bank.name} to ${fabName}`
          }
        ],
        createdBy: req.user._id
      });

      doc.fabricatorPaidAmount = round2((doc.fabricatorPaidAmount || 0) + amount);
      doc.fabricatorBalanceDue = round2(Math.max(0, (doc.fabricatorBalanceDue || 0) - amount));
      doc.journalEntries = [...(doc.journalEntries || []), jv._id];
      doc.paymentLogs = [
        ...(doc.paymentLogs || []),
        {
          type: 'FABRICATOR_PAYMENT',
          date: payDate,
          amount,
          bankAccount: bank._id,
          reference: payRef,
          journalEntry: jv._id
        }
      ];
      await doc.save();
    });

    return exports.get(req, res, next);
  } catch (err) {
    next(err);
  }
};

exports.voidSettlement = async (req, res, next) => {
  try {
    await withTransaction(async () => {
      const doc = await ProjectSettlement.findById(req.params.id);
      if (!doc) throw httpError(404, 'Project settlement not found.');
      if (doc.status === 'VOID') throw httpError(400, 'Project settlement is already void.');

      const jvIds = doc.journalEntries?.length
        ? doc.journalEntries
        : doc.journalEntry
          ? [doc.journalEntry]
          : [];

      const seenJvs = new Set();
      for (const jvId of jvIds) {
        const key = String(jvId);
        if (seenJvs.has(key)) continue;
        seenJvs.add(key);
        await reverseJournal(jvId, { createdBy: req.user._id });
      }

      if (doc.maalSettledDirectlyInJv) {
        if (doc.maalAllocations && doc.maalAllocations.length > 0) {
          for (const alloc of doc.maalAllocations) {
            if (!alloc.invoice || !(alloc.settledAmount > 0)) continue;
            const inv = await Invoice.findById(alloc.invoice);
            if (inv) {
              inv.amountPaid = round2(Math.max(0, (inv.amountPaid || 0) - alloc.settledAmount));
              if (inv.status !== 'VOID' && inv.status !== 'DRAFT') {
                inv.status = inv.amountPaid >= inv.grandTotal - 0.005
                  ? 'PAID'
                  : inv.amountPaid > 0
                    ? 'PARTIALLY_PAID'
                    : 'POSTED';
              }
              await inv.save();
            }
          }
        } else if (doc.maalInvoice && doc.maalSettledByProject > 0) {
          const inv = await Invoice.findById(doc.maalInvoice);
          if (inv) {
            inv.amountPaid = round2(Math.max(0, (inv.amountPaid || 0) - doc.maalSettledByProject));
            if (inv.status !== 'VOID' && inv.status !== 'DRAFT') {
              inv.status = inv.amountPaid >= inv.grandTotal - 0.005
                ? 'PAID'
                : inv.amountPaid > 0
                  ? 'PARTIALLY_PAID'
                  : 'POSTED';
            }
            await inv.save();
          }
        }
      }

      for (const receiptId of doc.receipts || []) {
        const receipt = await Receipt.findById(receiptId);
        if (!receipt) continue;
        if (receipt.journalEntry) {
          await reverseJournal(receipt.journalEntry, { createdBy: req.user._id });
        }
        for (const alloc of receipt.allocations || []) {
          const inv = await Invoice.findById(alloc.invoice);
          if (!inv) continue;
          inv.amountPaid = round2(Math.max(0, (inv.amountPaid || 0) - alloc.amount - (alloc.discount || 0)));
          if (inv.status !== 'VOID' && inv.status !== 'DRAFT') {
            inv.status = inv.amountPaid >= inv.grandTotal - 0.005
              ? 'PAID'
              : inv.amountPaid > 0
                ? 'PARTIALLY_PAID'
                : 'POSTED';
          }
          await inv.save();
        }
        await Receipt.deleteOne({ _id: receipt._id });
      }

      doc.status = 'VOID';
      await doc.save();
    });

    res.json({ message: 'Project settlement voided and all linked entries reversed.' });
  } catch (err) {
    next(err);
  }
};

exports.report = async (req, res, next) => {
  try {
    const { from, to, customerId, projectType } = req.query;
    const filter = { status: 'POSTED' };
    if (from || to) {
      filter.date = {};
      if (from) {
        const d = new Date(from);
        d.setHours(0, 0, 0, 0);
        filter.date.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        d.setHours(23, 59, 59, 999);
        filter.date.$lte = d;
      }
    }
    if (customerId) filter.customer = customerId;
    if (projectType) filter.projectType = projectType;

    const docs = await ProjectSettlement.find(filter)
      .populate('customer', 'name code')
      .populate({
        path: 'maalInvoice',
        select: 'invoiceNumber customer',
        populate: { path: 'customer', select: 'name' }
      })
      .populate({
        path: 'maalInvoices',
        select: 'invoiceNumber grandTotal customer',
        populate: { path: 'customer', select: 'name' }
      })
      .populate('fabricatorAccount', 'code name')
      .sort({ date: -1, createdAt: -1 });

    const summary = docs.reduce(
      (acc, d) => {
        acc.totalDealAmount = round2(acc.totalDealAmount + (d.dealAmount || 0));
        acc.totalMaalAmount = round2(acc.totalMaalAmount + (d.maalInvoiceAmount || 0));
        acc.totalProjectCharges = round2(acc.totalProjectCharges + (d.projectCharges || 0));
        acc.totalExpenses = round2(acc.totalExpenses + (d.totalExpenses || 0));
        acc.totalNetProfit = round2(acc.totalNetProfit + (d.netProfit || 0));
        acc.totalReceived = round2(acc.totalReceived + (d.clientPaidTotal || ((d.cashAmount || 0) + (d.bankAmount || 0))));
        acc.totalClientBalance = round2(acc.totalClientBalance + (d.clientBalance || 0));
        acc.totalFabricatorBalanceDue = round2(acc.totalFabricatorBalanceDue + (d.fabricatorBalanceDue || 0));
        return acc;
      },
      {
        totalDealAmount: 0,
        totalMaalAmount: 0,
        totalProjectCharges: 0,
        totalExpenses: 0,
        totalNetProfit: 0,
        totalReceived: 0,
        totalClientBalance: 0,
        totalFabricatorBalanceDue: 0
      }
    );

    res.json({ rows: docs, summary });
  } catch (err) {
    next(err);
  }
};
