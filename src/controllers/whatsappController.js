const User = require('../models/User');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const WhatsAppUser = require('../models/WhatsAppUser');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const { parseCommand } = require('../services/whatsappParser');
const { nextNumber } = require('../services/numberSequence');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_erp_whatsapp_2026';
const SESSION_TIMEOUT_MS = (Number(process.env.WHATSAPP_SESSION_TIMEOUT_MINUTES) || 30) * 60 * 1000;

const WELCOME_MESSAGE =
  '✅ Login successful.\n\n' +
  'You can now use the ERP through WhatsApp.\n\n' +
  'Try:\n' +
  '"create customer Usman"\n' +
  '"create supplier ABC Traders"\n' +
  '"CUST-0001 update email to usman@example.com"\n\n' +
  'Send "help" any time to see this again, or "logout" to end your session.';

const HELP_MESSAGE =
  'Available commands:\n\n' +
  '• create customer <name>\n' +
  '• create supplier <name>\n' +
  '• <code> update <field> to <value>  (field: name, email, phone, address, tax)\n' +
  '• <code> delete\n' +
  '• logout';

const NO_PENDING_CONFIRMATION = { action: null, entityType: null, code: null };

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      "Sorry, I couldn't understand that.\n\nTry: \"create customer <name>\", or send \"help\"."
    );
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

  if (command.action === 'UPDATE_RECORD') {
    await handleUpdateRecord(waUser, command.data);
  }

  if (command.action === 'DELETE_RECORD') {
    await handleDeleteRecord(waUser, command.data);
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

  const erpUser = await User.findById(waUser.erpUserId).populate('role');
  const permissions = erpUser?.role?.permissions || [];
  const allowed = permissions.includes('*') || permissions.includes('sales.manage');
  if (!allowed) {
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

  const erpUser = await User.findById(waUser.erpUserId).populate('role');
  const permissions = erpUser?.role?.permissions || [];
  const allowed = permissions.includes('*') || permissions.includes('purchases.manage');
  if (!allowed) {
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

async function handleUpdateRecord(waUser, data) {
  const { entityType, code, field, value } = data;
  const isCustomer = entityType === 'CUSTOMER';
  const Model = isCustomer ? Customer : Supplier;
  const requiredPermission = isCustomer ? 'sales.manage' : 'purchases.manage';

  const erpUser = await User.findById(waUser.erpUserId).populate('role');
  const permissions = erpUser?.role?.permissions || [];
  const allowed = permissions.includes('*') || permissions.includes(requiredPermission);
  if (!allowed) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ You don't have permission to update ${entityType.toLowerCase()}s.`);
    return;
  }

  const record = await Model.findOne({ code: new RegExp(`^${escapeRegex(code)}$`, 'i') });
  if (!record) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ No ${entityType.toLowerCase()} found with ID ${code}.`);
    return;
  }

  try {
    record[field] = value;
    await record.save();
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `✅ Updated.\n\n${record.code} — ${field}: ${record[field]}`
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
  const isCustomer = entityType === 'CUSTOMER';
  const Model = isCustomer ? Customer : Supplier;
  const requiredPermission = isCustomer ? 'sales.manage' : 'purchases.manage';

  const erpUser = await User.findById(waUser.erpUserId).populate('role');
  const permissions = erpUser?.role?.permissions || [];
  const allowed = permissions.includes('*') || permissions.includes(requiredPermission);
  if (!allowed) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ You don't have permission to delete ${entityType.toLowerCase()}s.`);
    return;
  }

  const record = await Model.findOne({ code: new RegExp(`^${escapeRegex(code)}$`, 'i') });
  if (!record) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ No ${entityType.toLowerCase()} found with ID ${code}.`);
    return;
  }

  waUser.pendingConfirmation = { action: 'DELETE_RECORD', entityType, code: record.code };
  await waUser.save();
  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `⚠️ Are you sure you want to delete ${entityType.toLowerCase()} ${record.code} (${record.name})?\n\nReply YES to confirm or NO to cancel.`
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
  const isCustomer = entityType === 'CUSTOMER';
  const Model = isCustomer ? Customer : Supplier;
  const RelatedModel = isCustomer ? Invoice : Bill;
  const relatedField = isCustomer ? 'customer' : 'supplier';
  const relatedLabel = isCustomer ? 'invoices' : 'bills';

  const record = await Model.findOne({ code: new RegExp(`^${escapeRegex(code)}$`, 'i') });
  if (!record) {
    await sendWhatsAppMessage(waUser.phoneNumber, `❌ No ${entityType.toLowerCase()} found with ID ${code}.`);
    return;
  }

  const hasRelated = await RelatedModel.exists({ [relatedField]: record._id });
  if (hasRelated) {
    await sendWhatsAppMessage(
      waUser.phoneNumber,
      `❌ Cannot delete ${record.code} — it has existing ${relatedLabel}. Deactivate it in the ERP instead.`
    );
    return;
  }

  await Model.findByIdAndDelete(record._id);
  await sendWhatsAppMessage(
    waUser.phoneNumber,
    `✅ ${isCustomer ? 'Customer' : 'Supplier'} ${record.code} (${record.name}) deleted.`
  );
}
