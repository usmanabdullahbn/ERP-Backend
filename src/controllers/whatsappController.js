const User = require('../models/User');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const Order = require('../models/Order');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const Account = require('../models/Account');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const WhatsAppUser = require('../models/WhatsAppUser');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { parseCommand } = require('../services/whatsappParser');
const { nextNumber } = require('../services/numberSequence');
const { recordMovement } = require('../services/inventoryService');
const { postJournal, round2 } = require('../services/ledgerService');
const { getAccountByCode } = require('../utils/getAccount');
const BillOfMaterial = require('../models/BillOfMaterial');
const { createAssemblyRun } = require('./assemblyController');
const SYS = require('../utils/systemAccounts');
const {
  computeProfitAndLoss,
  computeBalanceSheet,
  computeTrialBalance,
  computeStockSummary,
  computePendingOrders,
  computeAgedReceivables,
  computeAgedPayables,
  buildCustomerLedger,
  buildSupplierLedger
} = require('./reportController');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_erp_whatsapp_2026';
const SESSION_TIMEOUT_MS = (Number(process.env.WHATSAPP_SESSION_TIMEOUT_MINUTES) || 30) * 60 * 1000;

const WELCOME_MESSAGE =
  '✅ Login successful.\n\n' +
  'You can now use the ERP through WhatsApp.\n\n' +
  'Try:\n' +
  '"create customer Usman"\n' +
  '"create supplier ABC Traders"\n' +
  '"create product Laptop @ 150000"\n' +
  '"create order for Usman: 2 x Laptop @ 150000"\n' +
  '"create bill from ABC Traders: 10 x Laptop @ 140000"\n' +
  '"journal debit 5010 credit 1000 5000 Office supplies"\n' +
  '"CUST-0001 update email to usman@example.com"\n' +
  '"report p&l" or "CUST-0002 balance"\n\n' +
  'Send "help" any time to see this again, or "logout" to end your session.';

const HELP_MESSAGE =
  'Available commands:\n\n' +
  '• create customer <name>\n' +
  '• create supplier <name>\n' +
  '• create product <name> [@ <price>]\n' +
  '• create warehouse <name>\n' +
  '• create order for <customer>: <qty> x <product> [@ <price>]\n' +
  '• create invoice for <customer>: <qty> x <product> [@ <price>]\n' +
  '• create bill from <supplier>: <qty> x <product> [@ <price>]\n' +
  '   (customer/supplier/product can be a name or a code/SKU, e.g. CUST-0002 or SKU-00001)\n' +
  '• journal debit <account> credit <account> <amount> [narration]\n' +
  '   (account can be a chart-of-accounts code or name)\n' +
  '• increase|decrease stock <product> by <qty> in <warehouse> [, reason]\n' +
  '• create bom for <product>: <qty> x <component>, <qty> x <component>, ...\n' +
  '• produce <qty> x <product> in <warehouse> [, note]\n' +
  '   (needs a Bill of Materials defined first, see above)\n' +
  '• create account <code> <name> as asset|liability|equity|income|expense\n' +
  '• create bank account <name> [<account #>] [opening <amount>]\n' +
  '• create cash account <name> [opening <amount>]\n' +
  '• deposit <amount> into <bank> from <account> [, note]\n' +
  '• withdraw <amount> from <bank> for <account> [, note]\n' +
  '• transfer <amount> from <bank> to <bank> [, note]\n' +
  '• <code> update <field> to <value>\n' +
  '   (customer/supplier fields: name, email, phone, address, tax)\n' +
  '   (order fields: notes, duedate)\n' +
  '• <code> delete\n' +
  '• <SO-code> create invoice  (converts an order to a draft invoice)\n' +
  '• <CUST/SUPP-code> balance\n' +
  '• report p&l / balance sheet / trial balance [today|this year]\n' +
  '• report stock / low stock\n' +
  '• report aged receivables / aged payables\n' +
  '• report pending orders\n' +
  '• logout';

const NO_PENDING_CONFIRMATION = { action: null, entityType: null, code: null };

/*
  When a message doesn't parse, a generic "couldn't understand" reply is
  unhelpful for a near-miss — someone typing their own take on an order or
  product command needs the exact working syntax, not just "try help".
*/
function fallbackHint(text) {
  const lower = text.toLowerCase();

  if (lower.includes('order')) {
    return (
      "That doesn't match the order format I understand.\n\n" +
      'Use: "create order for <customer>: <qty> x <product> [@ <price>]"\n\n' +
      'You can use a name or a code/SKU for the customer and product. Example:\n' +
      '"create order for CUST-0002: 1 x SKU-00001"'
    );
  }

  if (lower.includes('product')) {
    return (
      "That doesn't match the product format I understand.\n\n" +
      'Use: "create product <name> [@ <price>]"\n\n' +
      'Example: "create product Laptop @ 150000"'
    );
  }

  return "Sorry, I couldn't understand that.\n\nTry: \"create customer <name>\", or send \"help\".";
}

/*
  Shared per-entity config for the generic update/delete flows. checkDeleteBlocked
  mirrors the same business rule each entity's own web-app controller already
  enforces (can't delete a customer/supplier with existing invoices/bills, or
  an order that's already been converted to an invoice).
*/
const ENTITY_CONFIG = {
  CUSTOMER: {
    Model: Customer,
    permission: 'sales.manage',
    label: 'customer',
    checkDeleteBlocked: async (record) =>
      (await Invoice.exists({ customer: record._id })) ? 'it has existing invoices' : null
  },
  SUPPLIER: {
    Model: Supplier,
    permission: 'purchases.manage',
    label: 'supplier',
    checkDeleteBlocked: async (record) =>
      (await Bill.exists({ supplier: record._id })) ? 'it has existing bills' : null
  },
  ORDER: {
    Model: Order,
    permission: 'sales.manage',
    label: 'order',
    checkDeleteBlocked: async (record) =>
      record.invoice || record.status === 'INVOICED' ? 'it has already been converted to an invoice' : null
  }
};

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Orders are identified by orderNumber, not code — every other entity uses code.
function codeFieldFor(entityType) {
  return entityType === 'ORDER' ? 'orderNumber' : 'code';
}

function findByCode(entityType, code) {
  const config = ENTITY_CONFIG[entityType];
  return config.Model.findOne({ [codeFieldFor(entityType)]: new RegExp(`^${escapeRegex(code)}$`, 'i') });
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

async function getPermissions(waUser) {
  const erpUser = await User.findById(waUser.erpUserId).populate('role');
  return erpUser?.role?.permissions || [];
}

function hasPermission(permissions, required) {
  if (permissions.includes('*')) return true;
  const requiredList = Array.isArray(required) ? required : [required];
  return requiredList.some((r) => permissions.includes(r));
}

async function requireReportPermission(waUser) {
  const permissions = await getPermissions(waUser);
  if (hasPermission(permissions, 'reports.view')) return true;
  await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to view reports.");
  return false;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

exports.sendTest = async (req, res) => {
  try {
    const to = req.body?.to || '03492045983';
    if (!to || String(to).length < 10) {
      return res.status(400).json({ message: 'A valid recipient number is required.' });
    }

    const result = await sendWhatsAppMessage(
      to,
      'ERP WhatsApp test message from Ledgerline. Your WhatsApp integration is working.'
    );

    if (!result.ok) {
      return res.status(502).json({ message: result.error, details: result.details });
    }

    console.log('[whatsapp] sent test message to', to);
    return res.json({ ok: true, recipient: to, message: 'WhatsApp test message sent successfully.', data: result.data });
  } catch (err) {
    console.error('[whatsapp] test route error:', err);
    return res.status(500).json({ message: 'Could not send the WhatsApp test message.', error: err.message });
  }
};

exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[whatsapp] webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

exports.receiveWebhook = async (req, res) => {
  // Acknowledge immediately; Meta retries if it doesn't get a fast 200.
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // status callbacks etc. — nothing to do

    const phoneNumber = message.from;
    const wamid = message.id;
    const text = message.text?.body || '';

    if (!phoneNumber || !wamid) return;

    // Claim this message ID atomically so redelivered webhooks are a no-op.
    try {
      await WhatsAppMessage.create({ whatsappMessageId: wamid, phoneNumber, message: text });
    } catch (err) {
      if (err.code === 11000) return; // already processed
      throw err;
    }

    await handleIncomingMessage(phoneNumber, text);
  } catch (err) {
    console.error('[whatsapp] webhook handling error:', err);
  }
};

async function handleIncomingMessage(phoneNumber, text) {
  let waUser = await WhatsAppUser.findOne({ phoneNumber });
  if (!waUser) {
    waUser = await WhatsAppUser.create({ phoneNumber });
  }

  const now = new Date();
  if (waUser.state === 'READY' && now - waUser.lastActivity > SESSION_TIMEOUT_MS) {
    waUser.authenticated = false;
    waUser.state = 'NEW';
    waUser.erpUserId = null;
    await sendWhatsAppMessage(waUser.phoneNumber, '⏳ Your session expired due to inactivity.');
  }

  waUser.lastActivity = now;
  await waUser.save();

  if (waUser.state !== 'READY') {
    await runAuthFlow(waUser, text);
    return;
  }

  await runCommand(waUser, text);
}

async function runAuthFlow(waUser, text) {
  const trimmed = text.trim();

  if (waUser.state === 'NEW') {
    waUser.state = 'WAITING_USERNAME';
    await waUser.save();
    await sendWhatsAppMessage(waUser.phoneNumber, 'Welcome to ERP.\n\nPlease enter your ERP username (email):');
    return;
  }

  if (waUser.state === 'WAITING_USERNAME') {
    waUser.pendingUsername = trimmed;
    waUser.state = 'WAITING_PASSWORD';
    await waUser.save();
    await sendWhatsAppMessage(waUser.phoneNumber, 'Please enter your ERP password:');
    return;
  }

  if (waUser.state === 'WAITING_PASSWORD') {
    const email = waUser.pendingUsername.toLowerCase();
    const user = await User.findOne({ email }).select('+password').populate('role');
    const valid = user && user.isActive && (await user.comparePassword(trimmed));

    if (!valid) {
      waUser.state = 'WAITING_USERNAME';
      waUser.pendingUsername = '';
      await waUser.save();
      await sendWhatsAppMessage(
        waUser.phoneNumber,
        '❌ Invalid username or password.\n\nPlease enter your ERP username (email):'
      );
      return;
    }

    waUser.erpUserId = user._id;
    waUser.authenticated = true;
    waUser.state = 'READY';
    waUser.pendingUsername = '';
    await waUser.save();
    await sendWhatsAppMessage(waUser.phoneNumber, WELCOME_MESSAGE);
    return;
  }
}

/*
  A WhatsApp message can contain several newline-separated lines — either
  because the user deliberately pasted/typed a batch of commands, or because
  the client soft-wrapped one long line (which never inserts a real newline,
  so that case always lands here as a single line anyway). Each line is
  parsed and dispatched independently, in order, with its own reply, so a
  batch behaves exactly like sending the same lines as separate messages.
*/
async function runCommand(waUser, text) {
  const wholeCommand = parseCommand(text);

  // A pending delete confirmation captures the reply unless it's a logout —
  // that always stays available as an escape hatch. This is checked against
  // the whole message, never a split line, since a YES/NO answer is always
  // its own standalone reply, not part of a batch.
  if (waUser.pendingConfirmation?.action && wholeCommand?.action !== 'LOGOUT') {
    await handleDeleteConfirmation(waUser, text);
    return;
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length <= 1) {
    await dispatchLine(waUser, wholeCommand, text);
    return;
  }

  for (const line of lines) {
    await dispatchLine(waUser, parseCommand(line), line);
  }
}

async function dispatchLine(waUser, command, rawText) {
  if (!command) {
    await sendWhatsAppMessage(waUser.phoneNumber, fallbackHint(rawText));
    return;
  }

  if (command.action === 'LOGOUT') {
    waUser.authenticated = false;
    waUser.state = 'NEW';
    waUser.erpUserId = null;
    waUser.pendingConfirmation = NO_PENDING_CONFIRMATION;
    await waUser.save();
    await sendWhatsAppMessage(waUser.phoneNumber, 'You have been logged out.');
    return;
  }

  if (command.action === 'HELP') {
    await sendWhatsAppMessage(waUser.phoneNumber, HELP_MESSAGE);
    return;
  }

  if (command.action === 'CREATE_CUSTOMER') {
    await handleCreateCustomer(waUser, command.data);
  }

  if (command.action === 'CREATE_SUPPLIER') {
    await handleCreateSupplier(waUser, command.data);
  }

  if (command.action === 'CREATE_ORDER') {
    await handleCreateOrder(waUser, command.data);
  }

  if (command.action === 'CREATE_PRODUCT') {
    await handleCreateProduct(waUser, command.data);
  }

  if (command.action === 'CREATE_WAREHOUSE') {
    await handleCreateWarehouse(waUser, command.data);
  }

  if (command.action === 'CREATE_INVOICE') {
    await handleCreateInvoice(waUser, command.data);
  }

  if (command.action === 'CREATE_BILL') {
    await handleCreateBill(waUser, command.data);
  }

  if (command.action === 'CREATE_JOURNAL') {
    await handleCreateJournal(waUser, command.data);
  }

  if (command.action === 'STOCK_ADJUSTMENT') {
    await handleStockAdjustment(waUser, command.data);
  }

  if (command.action === 'CREATE_BOM') {
    await handleCreateBom(waUser, command.data);
  }

  if (command.action === 'CREATE_ASSEMBLY') {
    await handleCreateAssembly(waUser, command.data);
  }

  if (command.action === 'CREATE_ACCOUNT') {
    await handleCreateAccount(waUser, command.data);
  }

  if (command.action === 'CREATE_BANK_ACCOUNT') {
    await handleCreateBankAccount(waUser, command.data);
  }

  if (command.action === 'CREATE_BANK_DEPOSIT') {
    await handleBankDeposit(waUser, command.data);
  }

  if (command.action === 'CREATE_BANK_WITHDRAWAL') {
    await handleBankWithdrawal(waUser, command.data);
  }

  if (command.action === 'CREATE_BANK_TRANSFER') {
    await handleBankTransfer(waUser, command.data);
  }

  if (command.action === 'UPDATE_RECORD') {
    await handleUpdateRecord(waUser, command.data);
  }

  if (command.action === 'DELETE_RECORD') {
    await handleDeleteRecord(waUser, command.data);
  }

  if (command.action === 'CONVERT_ORDER') {
    await handleConvertOrder(waUser, command.data);
  }

  if (command.action === 'REPORT_BALANCE') {
    await handleReportBalance(waUser, command.data);
  }

  if (command.action === 'REPORT_PL') {
    await handleReportPL(waUser, command.data);
  }

  if (command.action === 'REPORT_BALANCE_SHEET') {
    await handleReportBalanceSheet(waUser);
  }

  if (command.action === 'REPORT_TRIAL_BALANCE') {
    await handleReportTrialBalance(waUser, command.data);
  }

  if (command.action === 'REPORT_STOCK') {
    await handleReportStock(waUser, command.data);
  }

  if (command.action === 'REPORT_AGED_RECEIVABLES') {
    await handleReportAgedReceivables(waUser);
  }

  if (command.action === 'REPORT_AGED_PAYABLES') {
    await handleReportAgedPayables(waUser);
  }

  if (command.action === 'REPORT_PENDING_ORDERS') {
    await handleReportPendingOrders(waUser);
  }
}

async function handleCreateCustomer(waUser, data) {
  const { name, phone } = data;

  if (!name) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      'Please provide the customer name.\n\nExample: "create customer Usman"'
    );
    return;
  }

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'sales.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create customers.");
    return;
  }

  const existing = await Customer.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (existing) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `⚠️ Customer already exists.\n\nCustomer: ${existing.name}\nCustomer ID: ${existing.code}`
    );
    return;
  }

  try {
    const code = await nextNumber('customer', 'CUST', 4);
    const customer = await Customer.create({ code, name, phone: phone || '' });
    const phoneLine = customer.phone ? `\nPhone: ${customer.phone}` : '';
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Customer created successfully.\n\nName: ${customer.name}${phoneLine}\nCustomer ID: ${customer.code}`
    );
  } catch (err) {
    console.error('[whatsapp] create customer failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Customer could not be created. Please try again.');
  }
}

async function handleCreateSupplier(waUser, data) {
  const { name, phone } = data;

  if (!name) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      'Please provide the supplier name.\n\nExample: "create supplier ABC Traders"'
    );
    return;
  }

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'purchases.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create suppliers.");
    return;
  }

  const existing = await Supplier.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (existing) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `⚠️ Supplier already exists.\n\nSupplier: ${existing.name}\nSupplier ID: ${existing.code}`
    );
    return;
  }

  try {
    const code = await nextNumber('supplier', 'SUPP', 4);
    const supplier = await Supplier.create({ code, name, phone: phone || '' });
    const phoneLine = supplier.phone ? `\nPhone: ${supplier.phone}` : '';
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Supplier created successfully.\n\nName: ${supplier.name}${phoneLine}\nSupplier ID: ${supplier.code}`
    );
  } catch (err) {
    console.error('[whatsapp] create supplier failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Supplier could not be created. Please try again.');
  }
}

/*
  Looks a term up by exact code/SKU first (unambiguous by definition), then by
  exact name, then falls back to a substring name search. Never guesses
  between multiple candidates — the AI-generation risk this bot is built to
  avoid (inventing IDs) applies just as much to a regex parser, so ambiguous
  matches are always handed back to the user to disambiguate.
*/
async function findSingleMatch(Model, term, waUser, label, codeField = 'code') {
  const trimmed = term.trim();

  const byCode = await Model.findOne({ [codeField]: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') });
  if (byCode) return byCode;

  const exact = await Model.find({ name: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const list = exact.map((m) => `• ${m.name} (${m[codeField]})`).join('\n');
    await sendWhatsAppMessage(waUser.phoneNumber, `I found multiple ${label}s named "${trimmed}":\n\n${list}\n\nPlease specify which one (use its code/SKU).`);
    return null;
  }

  const partial = await Model.find({ name: new RegExp(escapeRegex(trimmed), 'i') }).limit(6);
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const list = partial.map((m) => `• ${m.name} (${m[codeField]})`).join('\n');
    await sendWhatsAppMessage(waUser.phoneNumber, `I found multiple ${label}s matching "${trimmed}":\n\n${list}\n\nPlease use the exact name or code/SKU.`);
    return null;
  }

  await sendWhatsAppMessage(waUser.phoneNumber, `❌ No ${label} found matching "${trimmed}". Please check the spelling/code or create it first.`);
  return null;
}

async function handleCreateOrder(waUser, data) {
  const { customerName, quantity, productName, price } = data;

  if (!(quantity > 0)) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Quantity must be greater than zero.');
    return;
  }

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'sales.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create orders.");
    return;
  }

  const customerDoc = await findSingleMatch(Customer, customerName, waUser, 'customer');
  if (!customerDoc) return;

  const productDoc = await findSingleMatch(Product, productName, waUser, 'product', 'sku');
  if (!productDoc) return;

  const warehouse = (await Warehouse.findOne({ isDefault: true })) || (await Warehouse.findOne());
  if (!warehouse) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ No warehouse is configured. Add one in the ERP first.');
    return;
  }

  const unitPrice = price != null ? price : productDoc.salePrice;
  const taxRate = productDoc.taxRate || 0;
  const discountRate = Number(customerDoc.discountRate || 0);

  const lineBase = round2(quantity * unitPrice);
  const discountAmount = round2((lineBase * discountRate) / 100);
  const taxableBase = round2(lineBase - discountAmount);
  const lineTax = round2((taxableBase * taxRate) / 100);
  const lineTotal = round2(taxableBase + lineTax);

  try {
    const orderNumber = await nextNumber('salesOrder', 'SO');
    const order = await Order.create({
      orderNumber,
      customer: customerDoc._id,
      date: new Date(),
      items: [{
        product: productDoc._id,
        quantity,
        unitPrice,
        taxRate,
        discountRate,
        warehouse: warehouse._id,
        lineTotal
      }],
      subTotal: taxableBase,
      taxTotal: lineTax,
      grandTotal: lineTotal,
      status: 'OPEN',
      createdBy: waUser.erpUserId
    });

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Order created.\n\nOrder #: ${order.orderNumber}\nCustomer: ${customerDoc.name}\nItem: ${quantity} x ${productDoc.name} @ ${unitPrice}\nTotal: ${lineTotal}\n\nWhen ready: "${order.orderNumber} create invoice"`
    );
  } catch (err) {
    console.error('[whatsapp] create order failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Order could not be created. Please try again.');
  }
}

async function handleCreateProduct(waUser, data) {
  const { name, price } = data;

  if (!name) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      'Please provide the product name.\n\nExample: "create product Laptop @ 150000"'
    );
    return;
  }

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'inventory.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create products.");
    return;
  }

  const existing = await Product.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (existing) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `⚠️ Product already exists.\n\nProduct: ${existing.name}\nSKU: ${existing.sku}`
    );
    return;
  }

  try {
    const sku = await nextNumber('product', 'SKU', 5);
    const product = await Product.create({ sku, name, salePrice: price || 0 });
    const priceLine = product.salePrice ? `\nSale price: ${product.salePrice}` : '';
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Product created successfully.\n\nName: ${product.name}${priceLine}\nSKU: ${product.sku}`
    );
  } catch (err) {
    console.error('[whatsapp] create product failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Product could not be created. Please try again.');
  }
}

async function handleCreateWarehouse(waUser, data) {
  const { name } = data;

  if (!name) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      'Please provide the warehouse name.\n\nExample: "create warehouse Main Store"'
    );
    return;
  }

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'inventory.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create warehouses.");
    return;
  }

  const existing = await Warehouse.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (existing) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `⚠️ Warehouse already exists.\n\nWarehouse: ${existing.name}\nCode: ${existing.code}`
    );
    return;
  }

  try {
    const code = await nextNumber('warehouse', 'WH', 3);
    const warehouse = await Warehouse.create({ code, name });
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Warehouse created successfully.\n\nName: ${warehouse.name}\nCode: ${warehouse.code}`
    );
  } catch (err) {
    console.error('[whatsapp] create warehouse failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Warehouse could not be created. Please try again.');
  }
}

/* Standalone draft invoice — independent of the order flow. Saved as DRAFT,
   same as an order->invoice conversion, so it still needs posting from the
   ERP before it affects stock or the ledger. */
async function handleCreateInvoice(waUser, data) {
  const { customerName, quantity, productName, price } = data;

  if (!(quantity > 0)) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Quantity must be greater than zero.');
    return;
  }

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'sales.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create invoices.");
    return;
  }

  const customerDoc = await findSingleMatch(Customer, customerName, waUser, 'customer');
  if (!customerDoc) return;

  const productDoc = await findSingleMatch(Product, productName, waUser, 'product', 'sku');
  if (!productDoc) return;

  const warehouse = (await Warehouse.findOne({ isDefault: true })) || (await Warehouse.findOne());
  if (!warehouse) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ No warehouse is configured. Add one in the ERP first.');
    return;
  }

  const unitPrice = price != null ? price : productDoc.salePrice;
  const taxRate = productDoc.taxRate || 0;
  const discountRate = Number(customerDoc.discountRate || 0);

  const lineBase = round2(quantity * unitPrice);
  const discountAmount = round2((lineBase * discountRate) / 100);
  const taxableBase = round2(lineBase - discountAmount);
  const lineTax = round2((taxableBase * taxRate) / 100);
  const lineTotal = round2(taxableBase + lineTax);

  try {
    const invoiceNumber = await nextNumber('invoice', 'INV');
    const invoice = await Invoice.create({
      invoiceNumber,
      customer: customerDoc._id,
      date: new Date(),
      items: [{
        product: productDoc._id,
        quantity,
        unitPrice,
        taxRate,
        discountRate,
        warehouse: warehouse._id,
        lineTotal
      }],
      subTotal: taxableBase,
      taxTotal: lineTax,
      grandTotal: lineTotal,
      status: 'DRAFT',
      createdBy: waUser.erpUserId
    });

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Invoice created as draft.\n\nInvoice #: ${invoice.invoiceNumber}\nCustomer: ${customerDoc.name}\nItem: ${quantity} x ${productDoc.name} @ ${unitPrice}\nTotal: ${lineTotal}\n\nPost it from the ERP when ready.`
    );
  } catch (err) {
    console.error('[whatsapp] create invoice failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Invoice could not be created. Please try again.');
  }
}

/* Standalone draft bill, mirroring handleCreateInvoice. Saved as DRAFT —
   posting (which moves stock and hits the ledger) stays a deliberate step
   in the ERP, not something a WhatsApp text triggers by itself. */
async function handleCreateBill(waUser, data) {
  const { supplierName, quantity, productName, price } = data;

  if (!(quantity > 0)) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Quantity must be greater than zero.');
    return;
  }

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'purchases.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create bills.");
    return;
  }

  const supplierDoc = await findSingleMatch(Supplier, supplierName, waUser, 'supplier');
  if (!supplierDoc) return;

  const productDoc = await findSingleMatch(Product, productName, waUser, 'product', 'sku');
  if (!productDoc) return;

  const warehouse = (await Warehouse.findOne({ isDefault: true })) || (await Warehouse.findOne());
  if (!warehouse) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ No warehouse is configured. Add one in the ERP first.');
    return;
  }

  const unitCost = price != null ? price : productDoc.costPrice;
  const taxRate = productDoc.taxRate || 0;

  const lineBase = round2(quantity * unitCost);
  const lineTax = round2((lineBase * taxRate) / 100);
  const lineTotal = round2(lineBase + lineTax);

  try {
    const billNumber = await nextNumber('bill', 'BILL');
    const bill = await Bill.create({
      billNumber,
      supplier: supplierDoc._id,
      date: new Date(),
      items: [{
        product: productDoc._id,
        quantity,
        unitCost,
        taxRate,
        discountRate: 0,
        warehouse: warehouse._id,
        lineTotal
      }],
      subTotal: lineBase,
      taxTotal: lineTax,
      grandTotal: lineTotal,
      status: 'DRAFT',
      createdBy: waUser.erpUserId
    });

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Bill created as draft.\n\nBill #: ${bill.billNumber}\nSupplier: ${supplierDoc.name}\nItem: ${quantity} x ${productDoc.name} @ ${unitCost}\nTotal: ${lineTotal}\n\nPost it from the ERP when ready.`
    );
  } catch (err) {
    console.error('[whatsapp] create bill failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Bill could not be created. Please try again.');
  }
}

/* Manual journal entry, fixed to a single debit/single credit line — see
   parseCreateJournal for why free-text multi-line entries aren't supported. */
async function handleCreateJournal(waUser, data) {
  const { debitTerm, creditTerm, amount, narration } = data;

  if (!(amount > 0)) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Amount must be greater than zero.');
    return;
  }

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'accounting.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to post journal entries.");
    return;
  }

  const debitAccount = await findSingleMatch(Account, debitTerm, waUser, 'account');
  if (!debitAccount) return;

  const creditAccount = await findSingleMatch(Account, creditTerm, waUser, 'account');
  if (!creditAccount) return;

  if (debitAccount._id.equals(creditAccount._id)) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ The debit and credit accounts must be different.');
    return;
  }

  try {
    const entry = await postJournal({
      date: new Date(),
      sourceType: 'MANUAL',
      narration: narration || 'WhatsApp journal entry',
      lines: [
        { account: debitAccount._id, debit: amount, credit: 0, memo: narration || '' },
        { account: creditAccount._id, debit: 0, credit: amount, memo: narration || '' }
      ],
      createdBy: waUser.erpUserId
    });

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Journal entry posted.\n\nEntry #: ${entry.entryNumber}\nDebit: ${debitAccount.name} (${debitAccount.code}) — ${round2(amount)}\nCredit: ${creditAccount.name} (${creditAccount.code}) — ${round2(amount)}`
    );
  } catch (err) {
    console.error('[whatsapp] create journal failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Journal entry could not be posted. Please try again.');
  }
}

async function handleStockAdjustment(waUser, data) {
  const { direction, productTerm, quantity, warehouseTerm, note } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'inventory.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to adjust stock.");
    return;
  }

  const productDoc = await findSingleMatch(Product, productTerm, waUser, 'product', 'sku');
  if (!productDoc) return;

  const warehouseDoc = await findSingleMatch(Warehouse, warehouseTerm, waUser, 'warehouse', 'code');
  if (!warehouseDoc) return;

  try {
    await recordMovement({
      product: productDoc._id,
      warehouse: warehouseDoc._id,
      direction,
      quantity,
      sourceType: 'ADJUSTMENT',
      sourceId: null,
      note: note || 'WhatsApp stock adjustment',
      createdBy: waUser.erpUserId
    });

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Stock adjusted.\n\nProduct: ${productDoc.name}\nWarehouse: ${warehouseDoc.name}\n${direction === 'IN' ? 'Increased' : 'Decreased'} by: ${quantity}`
    );
  } catch (err) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ ${err.message || 'Could not adjust stock. Please try again.'}`);
  }
}

/* Defines the recipe a later "produce" command runs against. One BOM per
   finished product — matches bomController's own uniqueness rule, so this
   gives the same "already has a BOM, edit it instead" message the web app
   would (WhatsApp has no edit command for this, only create). */
async function handleCreateBom(waUser, data) {
  const { productTerm, components } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'inventory.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to define a Bill of Materials.");
    return;
  }

  const productDoc = await findSingleMatch(Product, productTerm, waUser, 'product', 'sku');
  if (!productDoc) return;

  const existing = await BillOfMaterial.findOne({ product: productDoc._id });
  if (existing) {
    await sendWhatsAppMessage(waUser.phoneNumber, `⚠️ ${productDoc.name} already has a Bill of Materials. Edit it from the ERP's Assembly screen instead of recreating it.`);
    return;
  }

  const resolvedComponents = [];
  for (const c of components) {
    const componentDoc = await findSingleMatch(Product, c.componentTerm, waUser, 'product', 'sku');
    if (!componentDoc) return;
    if (componentDoc._id.equals(productDoc._id)) {
      await sendWhatsAppMessage(waUser.phoneNumber, `❌ ${productDoc.name} cannot be a component of its own Bill of Materials.`);
      return;
    }
    resolvedComponents.push({ component: componentDoc._id, quantity: c.quantity, name: componentDoc.name });
  }

  try {
    await BillOfMaterial.create({
      product: productDoc._id,
      components: resolvedComponents.map(({ component, quantity }) => ({ component, quantity }))
    });

    const list = resolvedComponents.map((c) => `${c.quantity} × ${c.name}`).join('\n');
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Bill of Materials created.\n\nFinished product: ${productDoc.name}\nComponents (per 1 unit):\n${list}\n\nYou can now run "produce <qty> x ${productDoc.name} in <warehouse>".`
    );
  } catch (err) {
    console.error('[whatsapp] create BOM failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Bill of Materials could not be created. Please try again.');
  }
}

/* Production run against an EXISTING Bill of Materials — this command can't
   define a BOM itself (that's component + quantity per component, too much
   structure for a chat message), only run one already set up in the ERP. */
async function handleCreateAssembly(waUser, data) {
  const { quantity, productTerm, warehouseTerm, note } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'inventory.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to record production.");
    return;
  }

  const productDoc = await findSingleMatch(Product, productTerm, waUser, 'product', 'sku');
  if (!productDoc) return;

  const warehouseDoc = await findSingleMatch(Warehouse, warehouseTerm, waUser, 'warehouse', 'code');
  if (!warehouseDoc) return;

  try {
    const assembly = await createAssemblyRun({
      product: productDoc._id,
      warehouse: warehouseDoc._id,
      quantity,
      note,
      userId: waUser.erpUserId
    });

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Production recorded.\n\nRun #: ${assembly.assemblyNumber}\nProduct: ${productDoc.name}\nWarehouse: ${warehouseDoc.name}\nQuantity produced: ${quantity}\nUnit cost: ${round2(assembly.unitCost)}`
    );
  } catch (err) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ ${err.message || 'Could not record production. Please try again.'}`);
  }
}

async function handleCreateAccount(waUser, data) {
  const { code, name, type } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'accounting.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create chart of accounts entries.");
    return;
  }

  const existing = await Account.findOne({ code });
  if (existing) {
    await sendWhatsAppMessage(waUser.phoneNumber, `⚠️ Account code ${code} already exists (${existing.name}).`);
    return;
  }

  const normalBalance = (type === 'ASSET' || type === 'EXPENSE') ? 'debit' : 'credit';

  try {
    const account = await Account.create({ code, name, type, normalBalance });
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Account created.\n\nCode: ${account.code}\nName: ${account.name}\nType: ${account.type}`
    );
  } catch (err) {
    console.error('[whatsapp] create account failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Account could not be created. Please try again.');
  }
}

async function handleCreateBankAccount(waUser, data) {
  const { name, accountNumber, type, openingBalance } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'banking.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to create bank/cash accounts.");
    return;
  }

  const existing = await BankAccount.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  if (existing) {
    await sendWhatsAppMessage(waUser.phoneNumber, `⚠️ A bank/cash account named "${existing.name}" already exists.`);
    return;
  }

  try {
    // Auto-create a linked GL account, same convention bankController.createAccount uses.
    const seq = await nextNumber('glAccount', '1' + (type === 'CASH' ? '1' : '0'), 3);
    const glAccount = await Account.create({
      code: `${SYS.BANK_CASH_DEFAULT}-${seq}`,
      name: `${name} (${type === 'CASH' ? 'Cash' : 'Bank'})`,
      type: 'ASSET',
      subType: type === 'CASH' ? 'Cash' : 'Bank',
      normalBalance: 'debit',
      isSystem: true
    });

    const bankAccount = await BankAccount.create({
      name, accountNumber, type, account: glAccount._id, openingBalance: openingBalance || 0
    });

    if (openingBalance) {
      const obe = await getAccountByCode(SYS.OPENING_BALANCE_EQUITY);
      await postJournal({
        sourceType: 'OPENING_BALANCE',
        reference: bankAccount.name,
        narration: `Opening balance for ${bankAccount.name}`,
        lines: openingBalance > 0
          ? [{ account: glAccount._id, debit: openingBalance, credit: 0 }, { account: obe._id, debit: 0, credit: openingBalance }]
          : [{ account: obe._id, debit: -openingBalance, credit: 0 }, { account: glAccount._id, debit: 0, credit: -openingBalance }],
        createdBy: waUser.erpUserId
      });
    }

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ ${type === 'CASH' ? 'Cash' : 'Bank'} account created.\n\nName: ${bankAccount.name}${accountNumber ? `\nAccount #: ${accountNumber}` : ''}${openingBalance ? `\nOpening balance: ${round2(openingBalance)}` : ''}`
    );
  } catch (err) {
    console.error('[whatsapp] create bank account failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Bank account could not be created. Please try again.');
  }
}

async function findBankAccountMatch(term, waUser) {
  return findSingleMatch(BankAccount, term, waUser, 'bank account', 'accountNumber');
}

async function handleBankDeposit(waUser, data) {
  const { amount, bankTerm, contraTerm, note } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'banking.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to record bank transactions.");
    return;
  }

  const bank = await findBankAccountMatch(bankTerm, waUser);
  if (!bank) return;
  const contra = await findSingleMatch(Account, contraTerm, waUser, 'account');
  if (!contra) return;

  await postBankTransaction(waUser, { bankAccount: bank, type: 'DEPOSIT', amount, contraAccount: contra, notes: note });
}

async function handleBankWithdrawal(waUser, data) {
  const { amount, bankTerm, contraTerm, note } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'banking.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to record bank transactions.");
    return;
  }

  const bank = await findBankAccountMatch(bankTerm, waUser);
  if (!bank) return;
  const contra = await findSingleMatch(Account, contraTerm, waUser, 'account');
  if (!contra) return;

  await postBankTransaction(waUser, { bankAccount: bank, type: 'WITHDRAWAL', amount, contraAccount: contra, notes: note });
}

async function handleBankTransfer(waUser, data) {
  const { amount, fromBankTerm, toBankTerm, note } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'banking.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to record bank transactions.");
    return;
  }

  const fromBank = await findBankAccountMatch(fromBankTerm, waUser);
  if (!fromBank) return;
  const toBank = await findBankAccountMatch(toBankTerm, waUser);
  if (!toBank) return;
  if (fromBank._id.equals(toBank._id)) {
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Cannot transfer a bank account to itself.');
    return;
  }

  await postBankTransaction(waUser, { bankAccount: fromBank, type: 'TRANSFER', amount, toBankAccount: toBank, notes: note });
}

/* Shared posting for deposit/withdrawal/transfer — mirrors bankController.createTransaction's
   line-building exactly, just fed already-resolved documents instead of raw ids from a request body. */
async function postBankTransaction(waUser, { bankAccount, type, amount, contraAccount, toBankAccount, notes }) {
  let lines;
  if (type === 'DEPOSIT') {
    lines = [
      { account: bankAccount.account, debit: amount, credit: 0 },
      { account: contraAccount._id, debit: 0, credit: amount }
    ];
  } else if (type === 'WITHDRAWAL') {
    lines = [
      { account: contraAccount._id, debit: amount, credit: 0 },
      { account: bankAccount.account, debit: 0, credit: amount }
    ];
  } else {
    lines = [
      { account: toBankAccount.account, debit: amount, credit: 0 },
      { account: bankAccount.account, debit: 0, credit: amount }
    ];
  }

  try {
    const entry = await postJournal({
      date: new Date(),
      sourceType: 'BANK_TRANSFER',
      narration: notes || `${type} on ${bankAccount.name}`,
      lines,
      createdBy: waUser.erpUserId
    });

    const txn = await BankTransaction.create({
      bankAccount: bankAccount._id,
      type,
      amount,
      contraAccount: contraAccount?._id || null,
      toBankAccount: toBankAccount?._id || null,
      notes,
      journalEntry: entry._id,
      createdBy: waUser.erpUserId
    });
    entry.sourceId = txn._id;
    await entry.save();

    const detail = type === 'TRANSFER'
      ? `${bankAccount.name} → ${toBankAccount.name}`
      : `${bankAccount.name} ${type === 'DEPOSIT' ? 'from' : 'for'} ${contraAccount.name}`;

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ ${capitalize(type.toLowerCase())} recorded.\n\n${detail}\nAmount: ${round2(amount)}`
    );
  } catch (err) {
    console.error('[whatsapp] bank transaction failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ ${err.message || 'Could not record the bank transaction. Please try again.'}`);
  }
}

async function handleUpdateRecord(waUser, data) {
  const { entityType, code, field, value } = data;
  const config = ENTITY_CONFIG[entityType];

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, config.permission)) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ You don't have permission to update ${config.label}s.`);
    return;
  }

  const record = await findByCode(entityType, code);
  if (!record) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ No ${config.label} found with ID ${code}.`);
    return;
  }

  if (entityType === 'ORDER' && ['INVOICED', 'CANCELLED'].includes(record.status)) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ ${record.orderNumber} is ${record.status.toLowerCase()} and can no longer be edited.`);
    return;
  }

  try {
    if (field === 'dueDate') {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        await sendWhatsAppMessage(waUser.phoneNumber, '❌ Could not understand that date. Use YYYY-MM-DD.');
        return;
      }
      record.dueDate = parsed;
    } else {
      record[field] = value;
    }
    await record.save();
    const displayCode = record.code || record.orderNumber;
    const displayValue = field === 'dueDate' ? record.dueDate.toISOString().slice(0, 10) : record[field];
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Updated.\n\n${displayCode} — ${field}: ${displayValue}`
    );
  } catch (err) {
    console.error('[whatsapp] update record failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Could not update the record. Please try again.');
  }
}

/* Delete is destructive, so this only checks permission + existence and then
   parks the request behind a YES/NO confirmation — nothing is removed here. */
async function handleDeleteRecord(waUser, data) {
  const { entityType, code } = data;
  const config = ENTITY_CONFIG[entityType];

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, config.permission)) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ You don't have permission to delete ${config.label}s.`);
    return;
  }

  const record = await findByCode(entityType, code);
  if (!record) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ No ${config.label} found with ID ${code}.`);
    return;
  }

  const displayCode = record.code || record.orderNumber;
  waUser.pendingConfirmation = { action: 'DELETE_RECORD', entityType, code: displayCode };
  await waUser.save();
  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `⚠️ Are you sure you want to delete ${config.label} ${displayCode}${record.name ? ` (${record.name})` : ''}?\n\nReply YES to confirm or NO to cancel.`
  );
}

async function handleDeleteConfirmation(waUser, text) {
  const answer = text.trim().toLowerCase();
  const { entityType, code } = waUser.pendingConfirmation;

  if (answer === 'yes' || answer === 'y') {
    waUser.pendingConfirmation = NO_PENDING_CONFIRMATION;
    await waUser.save();
    await performDelete(waUser, entityType, code);
    return;
  }

  if (answer === 'no' || answer === 'n' || answer === 'cancel') {
    waUser.pendingConfirmation = NO_PENDING_CONFIRMATION;
    await waUser.save();
    await sendWhatsAppMessage(waUser.phoneNumber, 'Cancelled. Nothing was deleted.');
    return;
  }

  await sendWhatsAppMessage(waUser.phoneNumber, `Please reply YES to delete ${code}, or NO to cancel.`);
}

async function performDelete(waUser, entityType, code) {
  const config = ENTITY_CONFIG[entityType];

  const record = await findByCode(entityType, code);
  if (!record) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ No ${config.label} found with ID ${code}.`);
    return;
  }

  const blockedReason = await config.checkDeleteBlocked(record);
  if (blockedReason) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ Cannot delete ${code} — ${blockedReason}.`);
    return;
  }

  await config.Model.findByIdAndDelete(record._id);
  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `✅ ${capitalize(config.label)} ${code}${record.name ? ` (${record.name})` : ''} deleted.`
  );
}

async function handleConvertOrder(waUser, data) {
  const { code } = data;

  const permissions = await getPermissions(waUser);
  if (!hasPermission(permissions, 'sales.manage')) {
    await sendWhatsAppMessage(waUser.phoneNumber, "❌ You don't have permission to convert orders to invoices.");
    return;
  }

  const order = await Order.findOne({ orderNumber: new RegExp(`^${escapeRegex(code)}$`, 'i') }).populate('customer');
  if (!order) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ No order found with ID ${code}.`);
    return;
  }
  if (order.invoice) {
    await sendWhatsAppMessage(waUser.phoneNumber, `⚠️ ${order.orderNumber} already has an invoice.`);
    return;
  }

  try {
    const invoice = await Invoice.create({
      invoiceNumber: await nextNumber('invoice', 'INV'),
      customer: order.customer._id,
      date: order.date,
      dueDate: order.dueDate,
      items: order.items.map((item) => ({
        product: item.product,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate,
        discountRate: item.discountRate,
        warehouse: item.warehouse,
        lineTotal: item.lineTotal
      })),
      subTotal: order.subTotal,
      taxTotal: order.taxTotal,
      grandTotal: order.grandTotal,
      status: 'DRAFT',
      notes: order.notes,
      createdBy: waUser.erpUserId
    });

    order.invoice = invoice._id;
    order.amountInvoiced = order.grandTotal;
    order.status = 'INVOICED';
    await order.save();

    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Invoice created from ${order.orderNumber}.\n\nInvoice #: ${invoice.invoiceNumber}\nCustomer: ${order.customer.name}\nTotal: ${invoice.grandTotal}\n\nIt's saved as a draft — post it from the ERP when ready.`
    );
  } catch (err) {
    console.error('[whatsapp] convert order to invoice failed:', err);
    await sendWhatsAppMessage(waUser.phoneNumber, '❌ Could not create the invoice. Please try again.');
  }
}

/* Quick balance lookup, gated by the same view permission the web app's
   customer/supplier list uses — this isn't a "report" so much as looking up
   one record's own running balance. */
async function handleReportBalance(waUser, data) {
  const { entityType, code } = data;
  const isCustomer = entityType === 'CUSTOMER';

  const permissions = await getPermissions(waUser);
  const required = isCustomer ? ['sales.view', 'sales.manage'] : ['purchases.view', 'purchases.manage'];
  if (!hasPermission(permissions, required)) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ You don't have permission to view ${isCustomer ? 'customer' : 'supplier'} balances.`);
    return;
  }

  const record = await findByCode(entityType, code);
  if (!record) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ No ${isCustomer ? 'customer' : 'supplier'} found with ID ${code}.`);
    return;
  }

  const ledgerRows = isCustomer
    ? await buildCustomerLedger({ customerId: record._id })
    : await buildSupplierLedger({ supplierId: record._id });
  const ledger = ledgerRows[0];

  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `💰 ${record.name} (${record.code})\n\nCurrent balance: ${fmt(ledger?.closingBalance || 0)}`
  );
}

async function handleReportPL(waUser, data) {
  if (!(await requireReportPermission(waUser))) return;

  const result = await computeProfitAndLoss({ from: data.from, to: data.to });
  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `📊 Profit & Loss (${data.label})\n\n` +
    `Total Income: ${fmt(result.totalIncome)}\n` +
    `Total Expense: ${fmt(result.totalExpense)}\n` +
    `Net Profit: ${fmt(result.netProfit)}`
  );
}

async function handleReportBalanceSheet(waUser) {
  if (!(await requireReportPermission(waUser))) return;

  const result = await computeBalanceSheet({});
  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `📊 Balance Sheet (as of today)\n\n` +
    `Total Assets: ${fmt(result.totalAssets)}\n` +
    `Total Liabilities: ${fmt(result.totalLiabilities)}\n` +
    `Total Equity: ${fmt(result.totalEquity)}\n\n` +
    (result.balanced ? '✅ Balanced' : '⚠️ Out of balance — check postings in the ERP')
  );
}

async function handleReportTrialBalance(waUser, data) {
  if (!(await requireReportPermission(waUser))) return;

  const result = await computeTrialBalance({ from: data.from, to: data.to });
  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `📊 Trial Balance (${data.label})\n\n` +
    `Total Debit: ${fmt(result.totalDebit)}\n` +
    `Total Credit: ${fmt(result.totalCredit)}\n\n` +
    (result.totalDebit === result.totalCredit ? '✅ Balanced' : '⚠️ Out of balance')
  );
}

async function handleReportStock(waUser, data) {
  if (!(await requireReportPermission(waUser))) return;

  const result = await computeStockSummary({});
  const lowStockItems = result.rows.filter((r) => r.belowReorder);

  if (data.lowOnly) {
    if (!lowStockItems.length) {
      await sendWhatsAppMessage(waUser.phoneNumber, '✅ No products are below their reorder level.');
      return;
    }
    const list = lowStockItems
      .slice(0, 15)
      .map((r) => `• ${r.name} (${r.sku}): ${r.totalQuantity} ${r.unit} — reorder at ${r.reorderLevel}`)
      .join('\n');
    const more = lowStockItems.length > 15 ? `\n…and ${lowStockItems.length - 15} more` : '';
    await sendWhatsAppMessage(waUser.phoneNumber, `⚠️ Low stock (${lowStockItems.length}):\n\n${list}${more}`);
    return;
  }

  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `📦 Stock Summary\n\n` +
    `Total stock value: ${fmt(result.totalStockValue)}\n` +
    `Products tracked: ${result.rows.length}\n` +
    `Below reorder level: ${lowStockItems.length}\n\n` +
    'Send "report low stock" to list them.'
  );
}

async function handleReportAgedReceivables(waUser) {
  if (!(await requireReportPermission(waUser))) return;

  const result = await computeAgedReceivables({});
  if (!result.rows.length) {
    await sendWhatsAppMessage(waUser.phoneNumber, '✅ No outstanding receivables.');
    return;
  }

  const buckets = {};
  let total = 0;
  for (const r of result.rows) {
    buckets[r.bucket] = (buckets[r.bucket] || 0) + r.balanceDue;
    total += r.balanceDue;
  }
  const bucketLines = Object.entries(buckets).map(([b, amt]) => `${b}: ${fmt(amt)}`).join('\n');
  const top = [...result.rows]
    .sort((a, b) => b.balanceDue - a.balanceDue)
    .slice(0, 5)
    .map((r) => `• ${r.customer} — ${r.invoiceNumber}: ${fmt(r.balanceDue)} (${r.daysOverdue}d overdue)`)
    .join('\n');

  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `📊 Aged Receivables (as of today)\n\n` +
    `Total outstanding: ${fmt(total)}\n\n${bucketLines}\n\n` +
    `Top overdue:\n${top}`
  );
}

async function handleReportAgedPayables(waUser) {
  if (!(await requireReportPermission(waUser))) return;

  const result = await computeAgedPayables({});
  if (!result.rows.length) {
    await sendWhatsAppMessage(waUser.phoneNumber, '✅ No outstanding payables.');
    return;
  }

  const buckets = {};
  let total = 0;
  for (const r of result.rows) {
    buckets[r.bucket] = (buckets[r.bucket] || 0) + r.balanceDue;
    total += r.balanceDue;
  }
  const bucketLines = Object.entries(buckets).map(([b, amt]) => `${b}: ${fmt(amt)}`).join('\n');
  const top = [...result.rows]
    .sort((a, b) => b.balanceDue - a.balanceDue)
    .slice(0, 5)
    .map((r) => `• ${r.supplier} — ${r.billNumber}: ${fmt(r.balanceDue)} (${r.daysOverdue}d overdue)`)
    .join('\n');

  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `📊 Aged Payables (as of today)\n\n` +
    `Total outstanding: ${fmt(total)}\n\n${bucketLines}\n\n` +
    `Top overdue:\n${top}`
  );
}

async function handleReportPendingOrders(waUser) {
  if (!(await requireReportPermission(waUser))) return;

  const rows = await computePendingOrders({});
  if (!rows.length) {
    await sendWhatsAppMessage(waUser.phoneNumber, '✅ No pending orders.');
    return;
  }

  const total = rows.reduce((s, r) => s + r.balanceDue, 0);
  const top = rows
    .slice(0, 5)
    .map((r) => `• ${r.orderNumber} — ${r.customer}: ${fmt(r.balanceDue)}`)
    .join('\n');

  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `📦 Pending Orders\n\n` +
    `Count: ${rows.length}\n` +
    `Total balance due: ${fmt(total)}\n\n${top}`
  );
}
