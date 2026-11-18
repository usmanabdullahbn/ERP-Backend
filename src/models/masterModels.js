const mongoose = require('mongoose');
const { getMasterDb } = require('../services/tenantContext');

const masterCompanySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    dbName: { type: String, required: true, unique: true, trim: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    plan: { type: String, default: 'pro', trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    taxNumber: { type: String, default: '', trim: true },
    whatsappPhoneNumberId: { type: String, default: '', trim: true }
  },
  { timestamps: true, collection: 'companies' }
);

const tenantMembershipSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterCompany', required: true },
    dbName: { type: String, required: true, trim: true },
    tenantUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
    isSuperAdmin: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true, collection: 'tenantmemberships' }
);

tenantMembershipSchema.index({ email: 1, company: 1 }, { unique: true });
tenantMembershipSchema.index({ email: 1 });

const masterWhatsAppSessionSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, required: true, unique: true, trim: true },
    email: { type: String, lowercase: true, trim: true, default: '' },
    activeDbName: { type: String, default: '' },
    activeCompanyName: { type: String, default: '' },
    activeCompanyCode: { type: String, default: '' }
  },
  { timestamps: true, collection: 'whatsappsessions' }
);

function getMasterModels() {
  const masterDb = getMasterDb();
  const MasterCompany =
    masterDb.models.MasterCompany || masterDb.model('MasterCompany', masterCompanySchema);
  const TenantMembership =
    masterDb.models.TenantMembership || masterDb.model('TenantMembership', tenantMembershipSchema);
  const MasterWhatsAppSession =
    masterDb.models.MasterWhatsAppSession ||
    masterDb.model('MasterWhatsAppSession', masterWhatsAppSessionSchema);

  return { MasterCompany, TenantMembership, MasterWhatsAppSession };
}

module.exports = { getMasterModels };
