const mongoose = require('mongoose');

/*
  Tracks the login/session state of a WhatsApp number talking to the ERP bot.
  State machine: NEW -> WAITING_USERNAME -> WAITING_PASSWORD -> READY
  erpUserId is only set once the number has successfully authenticated against
  the ERP's own User/password check (no separate password is ever stored here).
*/
const whatsAppUserSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, required: true, unique: true, trim: true },
    erpUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    authenticated: { type: Boolean, default: false },
    state: {
      type: String,
      enum: ['NEW', 'WAITING_USERNAME', 'WAITING_PASSWORD', 'READY'],
      default: 'NEW'
    },
    pendingUsername: { type: String, default: '' },
    lastActivity: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('WhatsAppUser', whatsAppUserSchema);
