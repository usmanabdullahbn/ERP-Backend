const Account = require('../models/Account');
const JournalEntry = require('../models/JournalEntry');
const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const Receipt = require('../models/Receipt');
const Payment = require('../models/Payment');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const { round2 } = require('../services/ledgerService');

/* Builds a map of accountId -> { debit, credit } totals within an optional date range. */
async function accountTotals({ from, to } = {}) {
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }
  const entries = await JournalEntry.find(filter);
  const totals = {};
  for (const e of entries) {
    for (const l of e.lines) {
      const key = l.account.toString();
      if (!totals[key]) totals[key] = { debit: 0, credit: 0 };
      totals[key].debit += l.debit;
      totals[key].credit += l.credit;
    }
  }
  return totals;
}

exports.trialBalance = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const totals = await accountTotals({ from, to });
    const accounts = await Account.find({ isActive: true }).sort({ code: 1 });

    let totalDebit = 0;
    let totalCredit = 0;
    const rows = accounts.map((a) => {
      const t = totals[a._id.toString()] || { debit: 0, credit: 0 };
      const net = t.debit - t.credit;
      const debitBal = net > 0 ? round2(net) : 0;
      const creditBal = net < 0 ? round2(-net) : 0;
      totalDebit += debitBal;
      totalCredit += creditBal;
      return { code: a.code, name: a.name, type: a.type, debit: debitBal, credit: creditBal };
    }).filter((r) => r.debit !== 0 || r.credit !== 0);

    res.json({ rows, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit) });
  } catch (err) {
    next(err);
  }
};

exports.profitAndLoss = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const totals = await accountTotals({ from, to });
    const accounts = await Account.find({ type: { $in: ['INCOME', 'EXPENSE'] }, isActive: true }).sort({ code: 1 });

    const income = [];
    const expense = [];
    let totalIncome = 0;
    let totalExpense = 0;

    for (const a of accounts) {
      const t = totals[a._id.toString()] || { debit: 0, credit: 0 };
      if (a.type === 'INCOME') {
        const amount = round2(t.credit - t.debit);
        if (amount !== 0) { income.push({ code: a.code, name: a.name, amount }); totalIncome += amount; }
      } else {
        const amount = round2(t.debit - t.credit);
        if (amount !== 0) { expense.push({ code: a.code, name: a.name, amount }); totalExpense += amount; }
      }
    }

    res.json({
      income, expense,
      totalIncome: round2(totalIncome),
      totalExpense: round2(totalExpense),
      netProfit: round2(totalIncome - totalExpense)
    });
  } catch (err) {
    next(err);
  }
};

exports.balanceSheet = async (req, res, next) => {
  try {
    const { asOf } = req.query;
    const totals = await accountTotals({ to: asOf });
    const accounts = await Account.find({ type: { $in: ['ASSET', 'LIABILITY', 'EQUITY'] }, isActive: true }).sort({ code: 1 });

    // Net profit-to-date rolls into equity as "Retained Earnings (current period)"
    const plTotals = await accountTotals({ to: asOf });
    const incomeExpenseAccounts = await Account.find({ type: { $in: ['INCOME', 'EXPENSE'] } });
    let netProfit = 0;
    for (const a of incomeExpenseAccounts) {
      const t = plTotals[a._id.toString()] || { debit: 0, credit: 0 };
      netProfit += a.type === 'INCOME' ? (t.credit - t.debit) : -(t.debit - t.credit);
    }

    const assets = [];
    const liabilities = [];
    const equity = [];
    let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;

    for (const a of accounts) {
      const t = totals[a._id.toString()] || { debit: 0, credit: 0 };
      if (a.type === 'ASSET') {
        const amount = round2(t.debit - t.credit);
        if (amount !== 0) { assets.push({ code: a.code, name: a.name, amount }); totalAssets += amount; }
      } else if (a.type === 'LIABILITY') {
        const amount = round2(t.credit - t.debit);
        if (amount !== 0) { liabilities.push({ code: a.code, name: a.name, amount }); totalLiabilities += amount; }
      } else {
        const amount = round2(t.credit - t.debit);
        if (amount !== 0) { equity.push({ code: a.code, name: a.name, amount }); totalEquity += amount; }
      }
    }
    equity.push({ code: '3999', name: 'Retained Earnings (current period)', amount: round2(netProfit) });
    totalEquity += round2(netProfit);

    res.json({
      assets, liabilities, equity,
      totalAssets: round2(totalAssets),
      totalLiabilities: round2(totalLiabilities),
      totalEquity: round2(totalEquity),
      balanced: round2(totalAssets) === round2(totalLiabilities + totalEquity)
    });
  } catch (err) {
    next(err);
  }
};

exports.stockSummary = async (req, res, next) => {
  try {
    const products = await Product.find({ type: 'STOCK' }).populate('stockByWarehouse.warehouse', 'name code');
    const rows = products.map((p) => {
      const totalQty = p.stockByWarehouse.reduce((s, w) => s + w.quantity, 0);
      return {
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        totalQuantity: totalQty,
        stockValue: round2(totalQty * (p.costPrice || 0)),
        reorderLevel: p.reorderLevel,
        belowReorder: totalQty <= p.reorderLevel,
        byWarehouse: p.stockByWarehouse.map((w) => ({ warehouse: w.warehouse?.name, quantity: w.quantity }))
      };
    });
    const totalStockValue = round2(rows.reduce((s, r) => s + r.stockValue, 0));
    res.json({ rows, totalStockValue });
  } catch (err) {
    next(err);
  }
};

async function buildCustomerLedger({ customerId, from, to } = {}) {
  const customers = customerId ? await Customer.find({ _id: customerId }) : await Customer.find().sort({ name: 1 });

  const rows = [];
  for (const customer of customers) {
    const parseDate = (value) => {
      if (!value) return null;
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day);
    };

    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    if (toDate) toDate.setHours(23, 59, 59, 999);

    const invoices = await Invoice.find({
      customer: customer._id,
      status: { $nin: ['DRAFT', 'VOID'] },
      ...(from || to ? { date: { ...(from ? { $gte: fromDate } : {}), ...(to ? { $lte: toDate } : {}) } } : {})
    }).sort({ date: 1 });

    const receipts = await Receipt.find({
      customer: customer._id,
      ...(from || to ? { date: { ...(from ? { $gte: fromDate } : {}), ...(to ? { $lte: toDate } : {}) } } : {})
    }).sort({ date: 1 });

    const allEntries = [
      ...invoices.map((i) => ({ date: i.date, type: 'Invoice', ref: i.invoiceNumber, debit: i.grandTotal, credit: 0 })),
      ...receipts.map((r) => ({ date: r.date, type: 'Receipt', ref: r.receiptNumber, debit: 0, credit: r.amount }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let openingBalance = customer.openingBalance || 0;
    let entries = allEntries;

    if (fromDate) {
      const beforeFrom = entries.filter((e) => new Date(e.date) < fromDate);
      openingBalance += beforeFrom.reduce((sum, e) => sum + e.debit - e.credit, 0);
      entries = entries.filter((e) => new Date(e.date) >= fromDate);
    }

    if (toDate) {
      entries = entries.filter((e) => new Date(e.date) <= toDate);
    }

    let balance = openingBalance;
    const ledgerEntries = entries.map((e) => {
      balance += e.debit - e.credit;
      return {
        date: e.date,
        type: e.type,
        ref: e.ref,
        debit: round2(e.debit),
        credit: round2(e.credit),
        balance: round2(balance)
      };
    });

    rows.push({
      customer: { _id: customer._id, name: customer.name, code: customer.code },
      openingBalance: round2(openingBalance),
      entries: ledgerEntries,
      closingBalance: round2(balance)
    });
  }

  return rows;
}

async function buildSupplierLedger({ supplierId, from, to } = {}) {
  const suppliers = supplierId ? await Supplier.find({ _id: supplierId }) : await Supplier.find().sort({ name: 1 });

  const rows = [];
  for (const supplier of suppliers) {
    const parseDate = (value) => {
      if (!value) return null;
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day);
    };

    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    if (toDate) toDate.setHours(23, 59, 59, 999);

    const bills = await Bill.find({
      supplier: supplier._id,
      status: { $nin: ['DRAFT', 'VOID'] },
      ...(from || to ? { date: { ...(from ? { $gte: fromDate } : {}), ...(to ? { $lte: toDate } : {}) } } : {})
    }).sort({ date: 1 });

    const payments = await Payment.find({
      supplier: supplier._id,
      ...(from || to ? { date: { ...(from ? { $gte: fromDate } : {}), ...(to ? { $lte: toDate } : {}) } } : {})
    }).sort({ date: 1 });

    const allEntries = [
      ...bills.map((b) => ({ date: b.date, type: 'Bill', ref: b.billNumber, debit: 0, credit: b.grandTotal })),
      ...payments.map((p) => ({ date: p.date, type: 'Payment', ref: p.paymentNumber, debit: p.amount, credit: 0 }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let openingBalance = supplier.openingBalance || 0;
    let entries = allEntries;

    if (fromDate) {
      const beforeFrom = entries.filter((e) => new Date(e.date) < fromDate);
      openingBalance += beforeFrom.reduce((sum, e) => sum + e.credit - e.debit, 0);
      entries = entries.filter((e) => new Date(e.date) >= fromDate);
    }

    if (toDate) {
      entries = entries.filter((e) => new Date(e.date) <= toDate);
    }

    let balance = openingBalance;
    const ledgerEntries = entries.map((e) => {
      balance += e.credit - e.debit;
      return {
        date: e.date,
        type: e.type,
        ref: e.ref,
        debit: round2(e.debit),
        credit: round2(e.credit),
        balance: round2(balance)
      };
    });

    rows.push({
      supplier: { _id: supplier._id, name: supplier.name, code: supplier.code },
      openingBalance: round2(openingBalance),
      entries: ledgerEntries,
      closingBalance: round2(balance)
    });
  }

  return rows;
}

exports.customerLedger = async (req, res, next) => {
  try {
    const { customerId, from, to } = req.query;
    const rows = await buildCustomerLedger({ customerId, from, to });
    res.json(customerId ? rows[0] || null : rows);
  } catch (err) {
    next(err);
  }
};

exports.supplierLedger = async (req, res, next) => {
  try {
    const { supplierId, from, to } = req.query;
    const rows = await buildSupplierLedger({ supplierId, from, to });
    res.json(supplierId ? rows[0] || null : rows);
  } catch (err) {
    next(err);
  }
};

exports.agedReceivables = async (req, res, next) => {
  try {
    const invoices = await Invoice.find({ status: { $in: ['POSTED', 'PARTIALLY_PAID'] } }).populate('customer', 'name code');
    const now = Date.now();
    const rows = invoices.map((i) => {
      const daysOverdue = i.dueDate ? Math.max(0, Math.floor((now - new Date(i.dueDate).getTime()) / 86400000)) : 0;
      const bucket = daysOverdue === 0 ? 'Current' : daysOverdue <= 30 ? '1-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '90+';
      return {
        customer: i.customer?.name,
        invoiceNumber: i.invoiceNumber,
        dueDate: i.dueDate,
        balanceDue: round2(i.grandTotal - i.amountPaid),
        daysOverdue,
        bucket
      };
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

exports.agedPayables = async (req, res, next) => {
  try {
    const bills = await Bill.find({ status: { $in: ['POSTED', 'PARTIALLY_PAID'] } }).populate('supplier', 'name code');
    const now = Date.now();
    const rows = bills.map((b) => {
      const daysOverdue = b.dueDate ? Math.max(0, Math.floor((now - new Date(b.dueDate).getTime()) / 86400000)) : 0;
      const bucket = daysOverdue === 0 ? 'Current' : daysOverdue <= 30 ? '1-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '90+';
      return {
        supplier: b.supplier?.name,
        billNumber: b.billNumber,
        dueDate: b.dueDate,
        balanceDue: round2(b.grandTotal - b.amountPaid),
        daysOverdue,
        bucket
      };
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
