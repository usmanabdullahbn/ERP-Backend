require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const {
  getDefaultDbName,
  getCurrentDbName,
  runWithTenant,
  getAllTenantModels
} = require('../services/tenantContext');
const { getMasterModels } = require('../models/masterModels');
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
  { code: SYS.DISCOUNT_RECEIVED, name: 'Discount Received', type: 'INCOME', subType: 'Other Income', normalBalance: 'credit', isSystem: true },
  { code: SYS.COST_OF_GOODS_SOLD, name: 'Cost of Goods Sold', type: 'EXPENSE', subType: 'COGS', normalBalance: 'debit', isSystem: true },
  { code: SYS.PURCHASES_EXPENSE, name: 'Purchases / General Expense', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: true },
  { code: SYS.INVENTORY_ADJUSTMENT, name: 'Inventory Adjustments', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: true },
  { code: SYS.DISCOUNT_ALLOWED, name: 'Discount Allowed', type: 'EXPENSE', subType: 'Operating Expense', normalBalance: 'debit', isSystem: true },
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

function userHasAdminRole(user) {
  return (user?.roles || []).some(
    (r) => (r?.name || '').toLowerCase() === 'admin' || (r?.permissions || []).includes('*')
  );
}

async function syncUserMembership(user, dbName, options = {}) {
  if (!user || !user.email) return null;
  const targetDb = dbName || getCurrentDbName();
  const { MasterCompany, TenantMembership } = getMasterModels();

  const company = await MasterCompany.findOne({ dbName: targetDb });
  if (!company) return null;

  const update = {
    email: user.email.toLowerCase().trim(),
    company: company._id,
    dbName: company.dbName,
    tenantUserId: user._id,
    isActive: user.isActive !== false
  };

  if (options.isSuperAdmin !== undefined) {
    update.isSuperAdmin = Boolean(options.isSuperAdmin);
  } else if (company.isDefault) {
    update.isSuperAdmin = Boolean(userHasAdminRole(user));
  }

  return TenantMembership.findOneAndUpdate(
    { email: update.email, company: company._id },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function removeUserMembership(email, dbName) {
  if (!email) return;
  const targetDb = dbName || getCurrentDbName();
  const { MasterCompany, TenantMembership } = getMasterModels();
  const company = await MasterCompany.findOne({ dbName: targetDb });
  if (!company) return;
  await TenantMembership.deleteOne({ email: email.toLowerCase().trim(), company: company._id });
}

async function syncDefaultCompanyToMaster() {
  const defaultDbName = getDefaultDbName();
  const { MasterCompany, TenantMembership } = getMasterModels();

  await MasterCompany.init().catch(() => {});
  await TenantMembership.init().catch(() => {});

  let defaultCompany = await MasterCompany.findOne({ dbName: defaultDbName });
  if (!defaultCompany) {
    const defaultName = process.env.DEFAULT_COMPANY_NAME || 'Hussain uPVC';
    const defaultCode = (process.env.DEFAULT_COMPANY_CODE || 'HUSSAIN-UPVC').toUpperCase();
    defaultCompany = await MasterCompany.create({
      name: defaultName,
      code: defaultCode,
      dbName: defaultDbName,
      isDefault: true,
      isActive: true,
      plan: 'enterprise'
    });
    console.log(`[seed] Registered existing database "${defaultDbName}" in ERP_MASTER as "${defaultCompany.name}" (${defaultCompany.code}).`);
  } else if (!defaultCompany.isDefault) {
    defaultCompany.isDefault = true;
    await defaultCompany.save();
  }

  // Read existing users from the default database (read-only) and index their memberships in ERP_MASTER
  await runWithTenant(defaultDbName, async () => {
    const users = await User.find().populate('roles');
    for (const u of users) {
      await syncUserMembership(u, defaultDbName, {
        isSuperAdmin: userHasAdminRole(u)
      });
    }
    console.log(`[seed] Synced ${users.length} existing user(s) from "${defaultDbName}" to ERP_MASTER.`);
  });

  return defaultCompany;
}

/**
 * Seeds base data (Chart of Accounts, Default Roles, Default Warehouse, and initial Admin)
 * inside whichever tenant database is currently active in tenantContext (or targetDbName if provided).
 */
async function seedTenantDatabase(targetDbName, { adminUser } = {}) {
  const dbToSeed = targetDbName || getCurrentDbName();

  return runWithTenant(dbToSeed, async () => {
    console.log(`[seed] Seeding base data for database "${dbToSeed}"...`);

    for (const acc of CHART_OF_ACCOUNTS) {
      await Account.updateOne({ code: acc.code }, { $setOnInsert: acc }, { upsert: true });
    }

    for (const model of getAllTenantModels()) {
      await model.init().catch(() => {});
      await model.createCollection().catch(() => {});
    }

    for (const role of DEFAULT_ROLES) {
      await Role.findOneAndUpdate({ name: role.name }, role, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      });
    }

    const existingWarehouse = await Warehouse.findOne({ isDefault: true });
    if (!existingWarehouse) {
      await Warehouse.create({
        code: 'WH-001',
        name: 'Main Warehouse',
        location: 'Head Office',
        isDefault: true
      });
    }

    const adminRole = await Role.findOne({ name: 'Admin' });

    if (adminUser && adminUser.email) {
      const email = adminUser.email.toLowerCase().trim();
      let tenantAdmin = await User.findOne({ email });
      if (!tenantAdmin) {
        if (adminUser.passwordHash) {
          // Insert directly with existing bcrypt hash so the user keeps their exact same password
          const res = await User.collection.insertOne({
            name: adminUser.name || 'Administrator',
            email,
            password: adminUser.passwordHash,
            roles: [adminRole._id],
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date()
          });
          tenantAdmin = await User.findById(res.insertedId).populate('roles');
        } else {
          tenantAdmin = await User.create({
            name: adminUser.name || 'Administrator',
            email,
            password: adminUser.password || process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
            roles: [adminRole._id]
          });
          await tenantAdmin.populate('roles');
        }
      }
      await syncUserMembership(tenantAdmin, dbToSeed, {
        isSuperAdmin: Boolean(adminUser.isSuperAdmin)
      });
    } else {
      const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
      const existingAdmin = await User.findOne({ email: adminEmail });
      if (!existingAdmin) {
        await User.create({
          name: 'System Administrator',
          email: adminEmail,
          password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
          roles: [adminRole._id]
        });
        console.log(`[seed] Admin user created -> email: ${adminEmail}`);
      }
    }

    console.log(`[seed] Database "${dbToSeed}" ready.`);
    return true;
  });
}

async function ensureBaseData() {
  if (mongoose.connection.readyState === 0) {
    await connectDB();
  }

  // Require all tenant models up front so their schemas are registered in tenantContext
  require('../models/Account');
  require('../models/Assembly');
  require('../models/BankAccount');
  require('../models/BankTransaction');
  require('../models/Bill');
  require('../models/BillOfMaterial');
  require('../models/BootstrapLock');
  require('../models/Counter');
  require('../models/Customer');
  require('../models/Invoice');
  require('../models/JournalEntry');
  require('../models/Order');
  require('../models/Payment');
  require('../models/Product');
  require('../models/PurchaseOrder');
  require('../models/Receipt');
  require('../models/Role');
  require('../models/StockMovement');
  require('../models/Supplier');
  require('../models/User');
  require('../models/Warehouse');
  require('../models/WhatsAppMessage');
  require('../models/WhatsAppUser');

  await seedTenantDatabase(getDefaultDbName());
  await syncDefaultCompanyToMaster();
  return true;
}

async function run() {
  await ensureBaseData();
  await mongoose.connection.close();
  process.exit(0);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('[seed] Failed:', err);
    process.exit(1);
  });
}

module.exports = {
  ensureBaseData,
  seedTenantDatabase,
  syncDefaultCompanyToMaster,
  syncUserMembership,
  removeUserMembership,
  userHasAdminRole,
  run
};
