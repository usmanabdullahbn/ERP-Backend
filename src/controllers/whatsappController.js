const User = require('../models/User');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const Order = require('../models/Order');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const WhatsAppUser = require('../models/WhatsAppUser');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { parseCommand } = require('../services/whatsappParser');
const { nextNumber } = require('../services/numberSequence');
const { round2 } = require('../services/ledgerService');

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
  '"CUST-0001 update email to usman@example.com"\n\n' +
  'Send "help" any time to see this again, or "logout" to end your session.';

const HELP_MESSAGE =
  'Available commands:\n\n' +
  '• create customer <name>\n' +
  '• create supplier <name>\n' +
  '• create product <name> [@ <price>]\n' +
  '• create order for <customer>: <qty> x <product> [@ <price>]\n' +
  '   (customer/product can be a name or a code/SKU, e.g. CUST-0002 or SKU-00001)\n' +
  '• <code> update <field> to <value>\n' +
  '   (customer/supplier fields: name, email, phone, address, tax)\n' +
  '   (order fields: notes, duedate)\n' +
  '• <code> delete\n' +
  '• <SO-code> create invoice  (converts an order to a draft invoice)\n' +
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
  return permissions.includes('*') || permissions.includes(required);
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

async function runCommand(waUser, text) {
  const command = parseCommand(text);

  // A pending delete confirmation captures the reply unless it's a logout —
  // that always stays available as an escape hatch.
  if (waUser.pendingConfirmation?.action && command?.action !== 'LOGOUT') {
    await handleDeleteConfirmation(waUser, text);
    return;
  }

  if (!command) {
    await sendWhatsAppMessage(waUser.phoneNumber, fallbackHint(text));
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

  if (command.action === 'UPDATE_RECORD') {
    await handleUpdateRecord(waUser, command.data);
  }

  if (command.action === 'DELETE_RECORD') {
    await handleDeleteRecord(waUser, command.data);
  }

  if (command.action === 'CONVERT_ORDER') {
    await handleConvertOrder(waUser, command.data);
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
