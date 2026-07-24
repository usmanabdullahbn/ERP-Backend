const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const Product = require('../models/Product');
const BankAccount = require('../models/BankAccount');
const JournalEntry = require('../models/JournalEntry');
const { round2 } = require('../services/ledgerService');

exports.summary = async (req, res, next) => {
  try {
    const [invoices, bills, products, banks] = await Promise.all([
      Invoice.find({ status: { $ne: 'DRAFT' } }),
      Bill.find({ status: { $ne: 'DRAFT' } }),
      Product.find({ type: 'STOCK' }),
      BankAccount.find()
    ]);

    const totalReceivable = round2(invoices.reduce((s, i) => s + (i.grandTotal - i.amountPaid), 0));
    const totalPayable = round2(bills.reduce((s, b) => s + (b.grandTotal - b.amountPaid), 0));
    const totalSales30d = round2(
      invoices
        .filter((i) => Date.now() - new Date(i.date).getTime() <= 30 * 86400000)
        .reduce((s, i) => s + i.grandTotal, 0)
    );
    const totalStockValue = round2(
      products.reduce((s, p) => s + p.stockByWarehouse.reduce((s2, w) => s2 + w.quantity, 0) * (p.costPrice || 0), 0)
    );
    const lowStockCount = products.filter(
      (p) => p.stockByWarehouse.reduce((s, w) => s + w.quantity, 0) <= p.reorderLevel
    ).length;

    let cashAndBank = 0;
    for (const b of banks) {
      const entries = await JournalEntry.find({ 'lines.account': b.account });
      let balance = b.openingBalance || 0;
      for (const e of entries) {
        for (const l of e.lines) {
          if (l.account.toString() === b.account.toString()) balance += l.debit - l.credit;
        }
      }
      cashAndBank += balance;
    }

    // Sales trend for last 6 months
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), month: d.getMonth(), label: d.toLocaleString('default', { month: 'short' }) });
    }
    const salesTrend = months.map(({ year, month, label }) => {
      const total = invoices
        .filter((i) => {
          const dt = new Date(i.date);
          return dt.getFullYear() === year && dt.getMonth() === month;
        })
        .reduce((s, i) => s + i.grandTotal, 0);
      return { label, total: round2(total) };
    });

    res.json({
      totalReceivable,
      totalPayable,
      totalSales30d,
      totalStockValue,
      lowStockCount,
      cashAndBank: round2(cashAndBank),
      salesTrend,
      invoiceCount: invoices.length,
      billCount: bills.length
    });
  } catch (err) {
    next(err);
  }
};
