require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Account = require('../models/Account');
const Role = require('../models/Role');
const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const SYS = require('./systemAccounts');

const CHART_OF_ACCOUNTS = [
  { code: '1000', name: 'Bank & Cash (parent)', type: 'ASSET', subType: 'Bank', normalBalance: 'debit', isSystem: true },
  { code: SYS.ACCOUNTS_RECEIVABLE, name: 'Accounts Receivable', type: 'ASSET', subType: 'Accounts Receivable', normalBalance: 'debit', isSystem: true },
  { code: SYS.INVENTORY_ASSET, name: 'Inventory Asset', type: 'ASSET', subType: 'Inventory', normalBalance: 'debit', isSystem: true },
  { code: SYS.INPUT_TAX_RECEIVABLE, name: 'Input Tax Receivable', type: 'ASSET', subType: 'Tax', normalBalance: 'debit', isSystem: true },
  { code: SYS.ACCOUNTS_PAYABLE, name: 'Accounts Payable', type: 'LIABILITY', subType: 'Accounts Payable', normalBalance: 'credit', isSystem: true },
  { code: SYS.SALES_TAX_PAYABLE, name: 'Sales Tax Payable', type: 'LIABILITY', subType: 'Tax', normalBalance: 'credit', isSystem: true },
  { code: SYS.OPENING_BALANCE_EQUITY, name: 'Opening Balance Equity', type: 'EQUITY', subType: 'Equity', normalBalance: 'credit', isSystem: true },
  { code: '3000', name: "Owner's Equity", type: 'EQUITY', subType: 'Equity', normalBalance: 'credit', isSystem: false },
  { code: SYS.SALES_REVENUE, name: 'Sales Revenue', type: 'INCOME', subType: 'Operating Income', normalBalance: 'credit', isSystem: true },
  { code: SYS.COST_OF_GOODS_SOLD, name: 'Cost of Goods Sold', type: 'EXPENSE', subType: 'COGS', normalBalance: 'debit', isSystem: true },
  { code: SYS.PURCHASES_EXPENSE, name: 'Purchases / General Expense', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: true },
  { code: '5100', name: 'Rent Expense', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: false },
  { code: '5200', name: 'Salaries & Wages', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: false },
  { code: '5300', name: 'Utilities Expense', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: false },
  { code: '5400', name: 'Office Supplies Expense', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: false },
  { code: '5500', name: 'Bank Charges', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: false }
];

const DEFAULT_ROLES = [
  { name: 'Admin', description: 'Full system access', permissions: ['*'], isSystem: true },
  {
    name: 'Accountant',
    description: 'Full access to accounting, banking and reports',
    permissions: ['accounting.view', 'accounting.manage', 'banking.view', 'banking.manage', 'reports.view', 'sales.view', 'purchases.view', 'inventory.view'],
    isSystem: false
  },
  {
    name: 'Sales Executive',
    description: 'Manage customers, invoices and receipts',
    permissions: ['sales.view', 'sales.manage', 'inventory.view', 'reports.view'],
    isSystem: false
  },
  {
    name: 'Purchase Executive',
    description: 'Manage suppliers, bills and payments',
    permissions: ['purchases.view', 'purchases.manage', 'inventory.view', 'reports.view'],
    isSystem: false
  },
  {
    name: 'Inventory Manager',
    description: 'Manage products, warehouses and stock',
    permissions: ['inventory.view', 'inventory.manage', 'reports.view'],
    isSystem: false
  },
  {
    name: 'Viewer',
    description: 'Read-only access across the system',
    permissions: ['sales.view', 'purchases.view', 'inventory.view', 'banking.view', 'accounting.view', 'reports.view'],
    isSystem: false
  }
];

async function run() {
  await connectDB();
  console.log('[seed] Connected. Seeding base data...');

  for (const acc of CHART_OF_ACCOUNTS) {
    await Account.findOneAndUpdate({ code: acc.code }, acc, { upsert: true, new: true, setDefaultsOnInsert: true });
  }
  console.log(`[seed] Chart of accounts ready (${CHART_OF_ACCOUNTS.length} accounts).`);

  for (const role of DEFAULT_ROLES) {
    await Role.findOneAndUpdate({ name: role.name }, role, { upsert: true, new: true, setDefaultsOnInsert: true });
  }
  console.log(`[seed] Roles ready (${DEFAULT_ROLES.length} roles).`);

  const existingWarehouse = await Warehouse.findOne({ isDefault: true });
  if (!existingWarehouse) {
    await Warehouse.create({ code: 'WH-001', name: 'Main Warehouse', location: 'Head Office', isDefault: true });
    console.log('[seed] Default warehouse created.');
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
  const existingAdmin = await User.findOne({ email: adminEmail });
  if (!existingAdmin) {
    const adminRole = await Role.findOne({ name: 'Admin' });
    await User.create({
      name: 'System Administrator',
      email: adminEmail,
      password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
      role: adminRole._id
    });
    console.log(`[seed] Admin user created -> email: ${adminEmail} / password: ${process.env.SEED_ADMIN_PASSWORD || 'Admin@12345'}`);
    console.log('[seed] IMPORTANT: log in and change this password immediately.');
  } else {
    console.log('[seed] Admin user already exists, skipping.');
  }

  console.log('[seed] Done.');
  await mongoose.connection.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
