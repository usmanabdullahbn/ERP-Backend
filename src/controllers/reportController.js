const Account = require('../models/Account');
const JournalEntry = require('../models/JournalEntry');
const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
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
