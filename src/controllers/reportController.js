const Account = require('../models/Account');
const JournalEntry = require('../models/JournalEntry');
const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const Receipt = require('../models/Receipt');
const Payment = require('../models/Payment');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Order = require('../models/Order');
const BankTransaction = require('../models/BankTransaction');
const BankAccount = require('../models/BankAccount');
const StockMovement = require('../models/StockMovement');
const Warehouse = require('../models/Warehouse');
const { round2 } = require('../services/ledgerService');

/*
  Date-only query params (e.g. "2026-08-18") must be parsed in local time and
  widened to the full day, not left at UTC midnight — otherwise a "to"/"asOf"
  filter silently excludes same-day transactions that happened after 00:00.
*/
function startOfDay(value) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}
function endOfDay(value) {
  const d = startOfDay(value);
  if (!d) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

/* Sums debit - credit per account for every journal line dated strictly before `date`, in one query. */
async function openingBalancesByAccount(date) {
  if (!date) return {};
  const result = await JournalEntry.aggregate([
    { $match: { date: { $lt: startOfDay(date) } } },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } }
  ]);
  const map = {};
  for (const r of result) {
    map[r._id.toString()] = round2(r.debit - r.credit);
  }
  return map;
}

/* Builds a map of accountId -> { debit, credit } totals within an optional date range. */
async function accountTotals({ from, to } = {}) {
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = startOfDay(from);
    if (to) filter.date.$lte = endOfDay(to);
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

async function computeTrialBalance({ from, to } = {}) {
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

  return { rows, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit) };
}

exports.trialBalance = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    res.json(await computeTrialBalance({ from, to }));
  } catch (err) {
    next(err);
  }
};

async function computeProfitAndLoss({ from, to } = {}) {
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

  return {
    income, expense,
    totalIncome: round2(totalIncome),
    totalExpense: round2(totalExpense),
    netProfit: round2(totalIncome - totalExpense)
  };
}

exports.profitAndLoss = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    res.json(await computeProfitAndLoss({ from, to }));
  } catch (err) {
    next(err);
  }
};

async function computeBalanceSheet({ asOf } = {}) {
  const totals = await accountTotals({ to: asOf });
  const accounts = await Account.find({ type: { $in: ['ASSET', 'LIABILITY', 'EQUITY'] }, isActive: true }).sort({ code: 1 });

  // Net profit-to-date rolls into equity as "Retained Earnings (current period)"
  const plTotals = totals;
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

  return {
    assets, liabilities, equity,
    totalAssets: round2(totalAssets),
    totalLiabilities: round2(totalLiabilities),
    totalEquity: round2(totalEquity),
    balanced: round2(totalAssets) === round2(totalLiabilities + totalEquity)
  };
}

exports.balanceSheet = async (req, res, next) => {
  try {
    const { asOf } = req.query;
    res.json(await computeBalanceSheet({ asOf }));
  } catch (err) {
    next(err);
  }
};

async function computeStockSummary({ asOf } = {}) {
  const products = await Product.find({ type: 'STOCK' }).populate('stockByWarehouse.warehouse', 'name code');

  let rows;
  if (asOf) {
    // Stock on hand is a running balance, not a period total — reconstruct
    // it as of a past date by replaying the StockMovement audit trail,
    // since the cached stockByWarehouse field only reflects the present.
    const cutoff = endOfDay(asOf);
    const movements = await StockMovement.aggregate([
      { $match: { date: { $lte: cutoff } } },
      {
        $group: {
          _id: { product: '$product', warehouse: '$warehouse' },
          qty: { $sum: { $cond: [{ $eq: ['$direction', 'IN'] }, '$quantity', { $multiply: ['$quantity', -1] }] } }
        }
      }
    ]);

    const warehouses = await Warehouse.find();
    const warehouseName = {};
    warehouses.forEach((w) => { warehouseName[w._id.toString()] = w.name; });

    const qtyByProduct = {};
    const qtyByProductWarehouse = {};
    for (const m of movements) {
      const productId = m._id.product.toString();
      const warehouseId = m._id.warehouse.toString();
      qtyByProduct[productId] = (qtyByProduct[productId] || 0) + m.qty;
      qtyByProductWarehouse[productId] = qtyByProductWarehouse[productId] || {};
      qtyByProductWarehouse[productId][warehouseId] = m.qty;
    }

    rows = products.map((p) => {
      const pid = p._id.toString();
      const totalQty = round2(qtyByProduct[pid] || 0);
      return {
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        totalQuantity: totalQty,
        stockValue: round2(totalQty * (p.costPrice || 0)),
        reorderLevel: p.reorderLevel,
        belowReorder: totalQty <= p.reorderLevel,
        byWarehouse: Object.entries(qtyByProductWarehouse[pid] || {}).map(([whId, qty]) => ({
          warehouse: warehouseName[whId] || 'Unknown',
          quantity: round2(qty)
        }))
      };
    });
  } else {
    rows = products.map((p) => {
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
  }

  const totalStockValue = round2(rows.reduce((s, r) => s + r.stockValue, 0));
  return { rows, totalStockValue, asOf: asOf || null };
}

exports.stockSummary = async (req, res, next) => {
  try {
    res.json(await computeStockSummary({ asOf: req.query.asOf }));
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

exports.salesJournal = async (req, res, next) => {
  try {
    const { from, to, customerId } = req.query;
    const filter = {};
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = startOfDay(from);
      if (to) filter.date.$lte = endOfDay(to);
    }
    if (customerId) filter.customer = customerId;

    const [invoices, receipts] = await Promise.all([
      Invoice.find(filter).populate('customer', 'name code').sort({ date: -1 }),
      Receipt.find(filter).populate('customer', 'name code').sort({ date: -1 })
    ]);

    const rows = [
      ...invoices.map((i) => ({
        _id: i._id,
        date: i.date,
        type: 'Invoice',
        reference: i.invoiceNumber,
        customer: i.customer?.name || 'Unknown',
        description: i.notes || '',
        debit: round2(i.grandTotal || 0),
        credit: 0,
        status: i.status
      })),
      ...receipts.map((r) => ({
        _id: r._id,
        date: r.date,
        type: 'Receipt',
        reference: r.receiptNumber,
        customer: r.customer?.name || 'Unknown',
        description: r.notes || '',
        debit: 0,
        credit: round2(r.amount || 0),
        status: r.status || 'POSTED'
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    let totalDebit = 0, totalCredit = 0;
    rows.forEach((r) => { totalDebit += r.debit; totalCredit += r.credit; });
    res.json({ rows, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit) });
  } catch (err) {
    next(err);
  }
};

exports.purchaseJournal = async (req, res, next) => {
  try {
    const { from, to, supplierId } = req.query;
    const filter = {};
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = startOfDay(from);
      if (to) filter.date.$lte = endOfDay(to);
    }
    if (supplierId) filter.supplier = supplierId;

    const [bills, payments] = await Promise.all([
      Bill.find(filter).populate('supplier', 'name code').sort({ date: -1 }),
      Payment.find(filter).populate('supplier', 'name code').sort({ date: -1 })
    ]);

    const rows = [
      ...bills.map((b) => ({
        _id: b._id,
        date: b.date,
        type: 'Bill',
        reference: b.billNumber,
        supplier: b.supplier?.name || 'Unknown',
        description: b.notes || '',
        debit: 0,
        credit: round2(b.grandTotal || 0),
        status: b.status
      })),
      ...payments.map((p) => ({
        _id: p._id,
        date: p.date,
        type: 'Payment',
        reference: p.paymentNumber,
        supplier: p.supplier?.name || 'Unknown',
        description: p.notes || '',
        debit: round2(p.amount || 0),
        credit: 0,
        status: p.status || 'POSTED'
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    let totalDebit = 0, totalCredit = 0;
    rows.forEach((r) => { totalDebit += r.debit; totalCredit += r.credit; });
    res.json({ rows, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit) });
  } catch (err) {
    next(err);
  }
};

exports.bankActivity = async (req, res, next) => {
  try {
    const { from, to, bankId } = req.query;
    const filter = {};

    if (bankId) {
      filter.bankAccount = bankId;
    }

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = startOfDay(from);
      if (to) filter.date.$lte = endOfDay(to);
    }

    const transactions = await BankTransaction.find(filter)
      .populate('bankAccount', 'accountNumber name')
      .populate('contraAccount', 'name code')
      .populate('toBankAccount', 'accountNumber name')
      .sort({ date: -1 });

    const rows = transactions.map((t) => ({
      _id: t._id,
      date: t.date,
      bankAccount: t.bankAccount?.name || t.bankAccount?.accountNumber || 'Unknown',
      type: t.type,
      reference: t.reference || '',
      description: t.notes || '',
      amount: round2(t.amount || 0),
      contraDetails: t.type === 'TRANSFER'
        ? `To: ${t.toBankAccount?.name || t.toBankAccount?.accountNumber || 'Unknown'}`
        : (t.contraAccount?.name || t.contraAccount?.code || 'Unknown')
    }));

    res.json(rows);
  } catch (err) {
    next(err);
  }
};

exports.generalLedger = async (req, res, next) => {
  try {
    const { from, to, accountId, bankId } = req.query;
    let resolvedAccountId = accountId || null;

    if (!resolvedAccountId && bankId) {
      const bankAccount = await BankAccount.findById(bankId).select('account');
      if (bankAccount) {
        resolvedAccountId = bankAccount.account?.toString() || null;
      }
    }

    const filter = {};
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = startOfDay(from);
      if (to) filter.date.$lte = endOfDay(to);
    }

    const accounts = resolvedAccountId ? await Account.find({ _id: resolvedAccountId }) : await Account.find({ isActive: true }).sort({ code: 1 });
    // Ascending — the running balance below must accumulate oldest-first.
    const allEntries = await JournalEntry.find(filter).sort({ date: 1 });
    const openingBalances = await openingBalancesByAccount(from);

    const rows = [];
    for (const account of accounts) {
      const accountLines = [];
      for (const entry of allEntries) {
        const matchingLines = entry.lines.filter((l) => l.account.toString() === account._id.toString());
        if (matchingLines.length > 0) {
          for (const line of matchingLines) {
            accountLines.push({
              date: entry.date,
              reference: entry.reference || entry._id.toString().slice(0, 8),
              description: entry.narration || '',
              debit: line.debit,
              credit: line.credit
            });
          }
        }
      }

      const openingBalance = openingBalances[account._id.toString()] || 0;
      if (accountLines.length > 0 || openingBalance !== 0) {
        let balance = openingBalance;
        const entries = accountLines.map((l) => {
          balance += l.debit - l.credit;
          return { ...l, balance: round2(balance) };
        });

        let totalDebit = 0, totalCredit = 0;
        entries.forEach((e) => { totalDebit += e.debit; totalCredit += e.credit; });

        rows.push({
          account: { _id: account._id, code: account.code, name: account.name, type: account.type },
          openingBalance: round2(openingBalance),
          entries,
          totalDebit: round2(totalDebit),
          totalCredit: round2(totalCredit),
          closingBalance: round2(balance)
        });
      }
    }

    res.json(resolvedAccountId ? rows[0] || null : rows);
  } catch (err) {
    next(err);
  }
};

async function computePendingOrders({ from, to, customerId } = {}) {
  const filter = { status: { $in: ['OPEN', 'PARTIALLY_INVOICED'] } };
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = startOfDay(from);
    if (to) filter.date.$lte = endOfDay(to);
  }
  if (customerId) filter.customer = customerId;

  const orders = await Order.find(filter)
    .populate('customer', 'name code')
    .sort({ date: -1 });

  return orders.map((order) => ({
    _id: order._id,
    orderNumber: order.orderNumber,
    customer: order.customer?.name || 'Unknown customer',
    customerCode: order.customer?.code || '',
    date: order.date,
    dueDate: order.dueDate,
    status: order.status,
    grandTotal: round2(order.grandTotal || 0),
    amountInvoiced: round2(order.amountInvoiced || 0),
    balanceDue: round2(Math.max(0, (order.grandTotal || 0) - (order.amountInvoiced || 0)))
  }));
}

exports.pendingOrders = async (req, res, next) => {
  try {
    const { from, to, customerId } = req.query;
    res.json(await computePendingOrders({ from, to, customerId }));
  } catch (err) {
    next(err);
  }
};

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

function agingBucket(daysOverdue) {
  if (daysOverdue === 0) return 'Current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

/*
  "As on date" aging means reconstructing the balance as it stood on that
  date — not today's amountPaid. Payments/receipts dated after the cutoff
  don't count yet, so an invoice/bill can show as outstanding here even
  though it's fully paid today.
*/
async function computeAgedReceivables({ asOf, customerId } = {}) {
  const cutoff = asOf ? endOfDay(asOf) : new Date();

  const invoices = await Invoice.find({
    status: { $in: ['POSTED', 'PARTIALLY_PAID', 'PAID'] },
    date: { $lte: cutoff },
    ...(customerId ? { customer: customerId } : {})
  }).populate('customer', 'name code');

  const invoiceIds = invoices.map((i) => i._id);
  const receipts = await Receipt.find({ 'allocations.invoice': { $in: invoiceIds }, date: { $lte: cutoff } });
  const paidByInvoice = {};
  for (const r of receipts) {
    for (const a of r.allocations) {
      const key = a.invoice.toString();
      paidByInvoice[key] = (paidByInvoice[key] || 0) + a.amount;
    }
  }

  const rows = invoices
    .map((i) => {
      const balanceDue = round2(i.grandTotal - (paidByInvoice[i._id.toString()] || 0));
      if (balanceDue <= 0) return null;
      const daysOverdue = i.dueDate ? Math.max(0, Math.floor((cutoff - new Date(i.dueDate).getTime()) / 86400000)) : 0;
      return {
        customer: i.customer?.name,
        invoiceNumber: i.invoiceNumber,
        dueDate: i.dueDate,
        balanceDue,
        daysOverdue,
        bucket: agingBucket(daysOverdue)
      };
    })
    .filter(Boolean);

  return { rows, asOf: asOf || null };
}

exports.agedReceivables = async (req, res, next) => {
  try {
    res.json(await computeAgedReceivables({ asOf: req.query.asOf, customerId: req.query.customerId }));
  } catch (err) {
    next(err);
  }
};

async function computeAgedPayables({ asOf, supplierId } = {}) {
  const cutoff = asOf ? endOfDay(asOf) : new Date();

  const bills = await Bill.find({
    status: { $in: ['POSTED', 'PARTIALLY_PAID', 'PAID'] },
    date: { $lte: cutoff },
    ...(supplierId ? { supplier: supplierId } : {})
  }).populate('supplier', 'name code');

  const billIds = bills.map((b) => b._id);
  const payments = await Payment.find({ 'allocations.bill': { $in: billIds }, date: { $lte: cutoff } });
  const paidByBill = {};
  for (const p of payments) {
    for (const a of p.allocations) {
      const key = a.bill.toString();
      paidByBill[key] = (paidByBill[key] || 0) + a.amount;
    }
  }

  const rows = bills
    .map((b) => {
      const balanceDue = round2(b.grandTotal - (paidByBill[b._id.toString()] || 0));
      if (balanceDue <= 0) return null;
      const daysOverdue = b.dueDate ? Math.max(0, Math.floor((cutoff - new Date(b.dueDate).getTime()) / 86400000)) : 0;
      return {
        supplier: b.supplier?.name,
        billNumber: b.billNumber,
        dueDate: b.dueDate,
        balanceDue,
        daysOverdue,
        bucket: agingBucket(daysOverdue)
      };
    })
    .filter(Boolean);

  return { rows, asOf: asOf || null };
}

exports.agedPayables = async (req, res, next) => {
  try {
    res.json(await computeAgedPayables({ asOf: req.query.asOf, supplierId: req.query.supplierId }));
  } catch (err) {
    next(err);
  }
};

/*
  Pure compute functions, exported alongside the HTTP handlers above so the
  WhatsApp bot can pull the same numbers without an internal HTTP round-trip
  and without duplicating (and risking drift in) the calculation logic.
*/
exports.computeTrialBalance = computeTrialBalance;
exports.computeProfitAndLoss = computeProfitAndLoss;
exports.computeBalanceSheet = computeBalanceSheet;
exports.computeStockSummary = computeStockSummary;
exports.computePendingOrders = computePendingOrders;
exports.computeAgedReceivables = computeAgedReceivables;
exports.computeAgedPayables = computeAgedPayables;
exports.buildCustomerLedger = buildCustomerLedger;
exports.buildSupplierLedger = buildSupplierLedger;
