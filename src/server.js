require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/db');
const { ensureBaseData } = require('./utils/seed');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const roleRoutes = require('./routes/roleRoutes');
const accountRoutes = require('./routes/accountRoutes');
const customerRoutes = require('./routes/customerRoutes');
const supplierRoutes = require('./routes/supplierRoutes');
const productRoutes = require('./routes/productRoutes');
const warehouseRoutes = require('./routes/warehouseRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');
const receiptRoutes = require('./routes/receiptRoutes');
const billRoutes = require('./routes/billRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const bankRoutes = require('./routes/bankRoutes');
const journalRoutes = require('./routes/journalRoutes');
const reportRoutes = require('./routes/reportRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();

connectDB()
  .then(async () => {
    try {
      await ensureBaseData();
    } catch (seedErr) {
      console.error('[server] Base-data seed failed:', seedErr.message);
    }
  })
  .catch((err) => {
    console.error('[server] DB connection failed on startup:', err.message);
  });

app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*', credentials: true }));
app.use(express.json());
app.use(morgan('dev'));

function normalizeWhatsAppNumber(value) {
  if (!value) return '';

  let digits = String(value).trim();
  digits = digits.replace(/\s+/g, '').replace(/[^\d+]/g, '');

  if (!digits) return '';
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0')) return `+92${digits.slice(1)}`;
  if (digits.length === 10) return `+92${digits}`;
  return `+${digits}`;
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.post('/api/whatsapp/test', async (req, res) => {
  try {
    const to = normalizeWhatsAppNumber(req.body?.to || '03492045983');
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({ message: 'WhatsApp access token or phone number ID is not configured.' });
    }

    if (!to || to.length < 10) {
      return res.status(400).json({ message: 'A valid recipient number is required.' });
    }

    const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: {
          body: 'ERP WhatsApp test message from Ledgerline. Your WhatsApp integration is working.'
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[whatsapp] send failed:', data);
      return res.status(502).json({
        message: data?.error?.message || 'Failed to send WhatsApp test message.',
        details: data
      });
    }

    console.log('[whatsapp] sent test message to', to);
    return res.json({
      ok: true,
      recipient: to,
      message: 'WhatsApp test message sent successfully.',
      data
    });
  } catch (error) {
    console.error('[whatsapp] test route error:', error);
    return res.status(500).json({ message: 'Could not send the WhatsApp test message.', error: error.message });
  }
});

// WhatsApp webhook verification and message receiver
// See README: Meta/WhatsApp requires a GET verification handshake.
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_erp_whatsapp_2026';

app.get('/api/whatsapp/webhook', (req, res) => {
	const mode = req.query['hub.mode'];
	const token = req.query['hub.verify_token'];
	const challenge = req.query['hub.challenge'];

	if (mode === 'subscribe' && token === VERIFY_TOKEN) {
		console.log('[whatsapp] webhook verified');
		return res.status(200).send(challenge);
	}
	return res.sendStatus(403);
});

app.post('/api/whatsapp/webhook', (req, res) => {
	console.log('[whatsapp] message received');
	console.log(JSON.stringify(req.body, null, 2));
	// Acknowledge receipt quickly
	res.sendStatus(200);
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/products', productRoutes);
app.use('/api/warehouses', warehouseRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/bills', billRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.use((req, res) => res.status(404).json({ message: 'Route not found' }));
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`[server] ERP API running on port ${PORT}`));
