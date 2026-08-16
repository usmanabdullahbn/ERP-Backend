const mongoose = require('mongoose');

/*
  One row per inbound WhatsApp message ID. Meta can redeliver the same webhook
  event, so we claim the message ID up front (unique index) before acting on
  it, and skip processing if it's already been claimed.
*/
const whatsAppMessageSchema = new mongoose.Schema(
  {
    whatsappMessageId: { type: String, required: true, unique: true },
    phoneNumber: { type: String, required: true },
    message: { type: String, default: '' },
    processed: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('WhatsAppMessage', whatsAppMessageSchema);
