const User = require('../models/User');
const Role = require('../models/Role');
const { getMasterModels } = require('../models/masterModels');
const { getDefaultDbName, getCurrentDbName, runWithTenant } = require('../services/tenantContext');
const { seedTenantDatabase, syncUserMembership } = require('../utils/seed');
const { isAdminRequest } = require('../middleware/rbac');

function sanitizeSlug(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 18);
}

function generateDbName(name, code) {
  const base = sanitizeSlug(code || name) || 'tenant';
  const suffix = Date.now().toString(36).slice(-4);
  // Keep <= 32 chars so MongoDB Atlas cluster database name limits (38 bytes) are never exceeded
  return `erp_${base}_${suffix}`.slice(0, 32);
}

async function resolveSuperAdminAndMemberships(req) {
  const { TenantMembership } = getMasterModels();
  const email = (req.user?.email || '').toLowerCase().trim();
  const currentDb = req.tenantDbName || getCurrentDbName();
  const memberships = await TenantMembership.find({ email, isActive: true });

  const isDefaultAdmin = currentDb === getDefaultDbName() && isAdminRequest(req);
  const isSuperAdmin =
    isDefaultAdmin || memberships.some((m) => m.isSuperAdmin && m.isActive);

  return { isSuperAdmin, memberships };
}

exports.list = async (req, res, next) => {
  try {
    const { MasterCompany } = getMasterModels();
    const { isSuperAdmin, memberships } = await resolveSuperAdminAndMemberships(req);

    let companies;
    if (isSuperAdmin) {
      companies = await MasterCompany.find().sort({ isDefault: -1, createdAt: 1 });
    } else {
      const companyIds = memberships.map((m) => m.company);
      companies = await MasterCompany.find({ _id: { $in: companyIds }, isActive: true }).sort({
        isDefault: -1,
        createdAt: 1
      });
    }

    res.json(companies);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  let createdCompany = null;
  try {
    const { isSuperAdmin } = await resolveSuperAdminAndMemberships(req);
    if (!isSuperAdmin) {
      return res.status(403).json({
        message: 'Forbidden. Only the platform Super Admin can create new companies.'
      });
    }

    const {
      name,
      code,
      plan,
      phone,
      email,
      address,
      taxNumber,
      whatsappPhoneNumberId,
      adminName,
      adminEmail,
      adminPassword
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'Company name is required.' });
    }

    const { MasterCompany } = getMasterModels();

    const cleanCode = String(
      code ||
        name
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 16)
    )
      .toUpperCase()
      .trim();

    if (!cleanCode) {
      return res.status(400).json({ message: 'A valid company code is required.' });
    }

    const existingCode = await MasterCompany.findOne({ code: cleanCode });
    if (existingCode) {
      return res.status(400).json({ message: `Company code "${cleanCode}" is already in use.` });
    }

    const dbName = generateDbName(name, cleanCode);

    // Grab current creator's password hash from the active DB before switching context
    const creatorWithHash = await User.findById(req.user._id).select('+password');

    createdCompany = await MasterCompany.create({
      name: String(name).trim(),
      code: cleanCode,
      dbName,
      isDefault: false,
      isActive: true,
      plan: plan || 'pro',
      phone: phone || '',
      email: email || '',
      address: address || '',
      taxNumber: taxNumber || '',
      whatsappPhoneNumberId: whatsappPhoneNumberId || ''
    });

    // Seed the new company's isolated database with Chart of Accounts, Roles, Warehouse, and the creator Super Admin
    await seedTenantDatabase(createdCompany.dbName, {
      adminUser: creatorWithHash
        ? {
            name: creatorWithHash.name,
            email: creatorWithHash.email,
            passwordHash: creatorWithHash.password,
            isSuperAdmin: true
          }
        : null
    });

    // Optionally create a dedicated company admin user (tenant-only admin, NOT SuperAdmin)
    if (
      adminEmail &&
      adminPassword &&
      String(adminEmail).toLowerCase().trim() !== (req.user.email || '').toLowerCase().trim()
    ) {
      await runWithTenant(createdCompany.dbName, async () => {
        const adminRole = await Role.findOne({ name: 'Admin' });
        const newAdmin = await User.create({
          name: adminName || `${createdCompany.name} Admin`,
          email: String(adminEmail).toLowerCase().trim(),
          password: adminPassword,
          roles: adminRole ? [adminRole._id] : []
        });
        await newAdmin.populate('roles');
        await syncUserMembership(newAdmin, createdCompany.dbName, { isSuperAdmin: false });
      });
    }

    res.status(201).json(createdCompany);
  } catch (err) {
    if (createdCompany?._id) {
      const { MasterCompany } = getMasterModels();
      await MasterCompany.deleteOne({ _id: createdCompany._id }).catch(() => {});
    }
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { isSuperAdmin } = await resolveSuperAdminAndMemberships(req);
    if (!isSuperAdmin) {
      return res.status(403).json({
        message: 'Forbidden. Only the platform Super Admin can modify company settings.'
      });
    }

    const { MasterCompany } = getMasterModels();
    const company = await MasterCompany.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ message: 'Company not found.' });
    }

    const {
      name,
      code,
      plan,
      phone,
      email,
      address,
      taxNumber,
      whatsappPhoneNumberId,
      isActive
    } = req.body;

    if (company.isDefault && isActive === false) {
      return res.status(400).json({ message: 'The primary default company cannot be deactivated.' });
    }

    if (name !== undefined) company.name = String(name).trim();
    if (code !== undefined) company.code = String(code).toUpperCase().trim();
    if (plan !== undefined) company.plan = plan;
    if (phone !== undefined) company.phone = phone;
    if (email !== undefined) company.email = email;
    if (address !== undefined) company.address = address;
    if (taxNumber !== undefined) company.taxNumber = taxNumber;
    if (whatsappPhoneNumberId !== undefined) company.whatsappPhoneNumberId = whatsappPhoneNumberId;
    if (isActive !== undefined) company.isActive = Boolean(isActive);

    await company.save();
    res.json(company);
  } catch (err) {
    next(err);
  }
};
