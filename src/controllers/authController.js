const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Role = require('../models/Role');
const BootstrapLock = require('../models/BootstrapLock');
const { getDefaultDbName, getCurrentDbName, runWithTenant } = require('../services/tenantContext');
const { getMasterModels } = require('../models/masterModels');
const { syncUserMembership } = require('../utils/seed');

function signToken(userId, { companyId = null, dbName = null } = {}) {
  return jwt.sign(
    {
      id: userId,
      companyId: companyId || null,
      dbName: dbName || getCurrentDbName() || getDefaultDbName()
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    }
  );
}

function userIsAdmin(user) {
  return (user?.roles || []).some(
    (r) => (r?.name || '').toLowerCase() === 'admin' || (r?.permissions || []).includes('*')
  );
}

function formatCompany(c) {
  if (!c) return null;
  return {
    id: c._id || c.id || null,
    name: c.name,
    code: c.code,
    dbName: c.dbName,
    isDefault: Boolean(c.isDefault),
    plan: c.plan || 'pro'
  };
}

async function buildTenantContextForUser(user, activeDbName) {
  const email = (user?.email || '').toLowerCase().trim();
  const currentDb = activeDbName || getCurrentDbName() || getDefaultDbName();
  const { MasterCompany, TenantMembership } = getMasterModels();

  let currentCompany = await MasterCompany.findOne({ dbName: currentDb });
  const memberships = await TenantMembership.find({ email, isActive: true }).populate('company');

  const isDefaultCompanyAdmin =
    Boolean(currentCompany?.isDefault || currentDb === getDefaultDbName()) && userIsAdmin(user);
  const isSuperAdmin =
    isDefaultCompanyAdmin || memberships.some((m) => m.isSuperAdmin && m.isActive);

  let companies = [];
  if (isSuperAdmin) {
    const allCompanies = await MasterCompany.find({ isActive: true }).sort({ isDefault: -1, name: 1 });
    companies = allCompanies.map(formatCompany);
  } else {
    companies = memberships
      .map((m) => m.company)
      .filter((c) => c && c.isActive)
      .map(formatCompany);
  }

  if (!currentCompany && companies.length > 0) {
    currentCompany = companies[0];
  }

  const formattedCurrent = currentCompany
    ? formatCompany(currentCompany)
    : {
        id: null,
        name: process.env.DEFAULT_COMPANY_NAME || 'Hussain uPVC',
        code: process.env.DEFAULT_COMPANY_CODE || 'HUSSAIN-UPVC',
        dbName: currentDb,
        isDefault: currentDb === getDefaultDbName(),
        plan: 'enterprise'
      };

  if (!companies.some((c) => c.dbName === formattedCurrent.dbName)) {
    companies.unshift(formattedCurrent);
  }

  return {
    company: formattedCurrent,
    companies,
    isSuperAdmin
  };
}

function formatUserResponse(user, tenantInfo) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    isSuperAdmin: Boolean(tenantInfo?.isSuperAdmin),
    company: tenantInfo?.company || null,
    companies: tenantInfo?.companies || [],
    roles: (user.roles || []).map((r) => ({
      id: r._id || r.id,
      name: r.name,
      permissions: r.permissions || []
    }))
  };
}

/*
  Registration is intentionally restricted: the very first user in an empty
  system becomes Admin (used for initial setup). After that, new users must
  be created by an admin via /api/users, not self-registration.
*/
exports.register = async (req, res, next) => {
  let lockClaimed = false;
  try {
    const userCount = await User.countDocuments();
    if (userCount > 0) {
      return res.status(403).json({
        message: 'Self-registration is disabled. Ask an administrator to create your account.'
      });
    }

    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

    try {
      await BootstrapLock.create({ _id: 'bootstrap' });
      lockClaimed = true;
    } catch (lockErr) {
      if (lockErr.code === 11000) {
        return res.status(403).json({
          message: 'Self-registration is disabled. Ask an administrator to create your account.'
        });
      }
      throw lockErr;
    }

    let adminRole = await Role.findOne({ name: 'Admin' });
    if (!adminRole) {
      adminRole = await Role.create({
        name: 'Admin',
        description: 'Full system access',
        permissions: ['*'],
        isSystem: true
      });
    }

    const user = await User.create({ name, email, password, roles: [adminRole._id] });
    await user.populate('roles');

    const dbName = getDefaultDbName();
    await syncUserMembership(user, dbName, { isSuperAdmin: true }).catch(() => {});
    const tenantInfo = await buildTenantContextForUser(user, dbName);
    const token = signToken(user._id, {
      companyId: tenantInfo.company?.id,
      dbName
    });

    res.status(201).json({
      token,
      user: formatUserResponse(user, tenantInfo)
    });
  } catch (err) {
    if (lockClaimed) {
      await BootstrapLock.deleteOne({ _id: 'bootstrap' }).catch(() => {});
    }
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password, companyId, companyCode } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const { MasterCompany, TenantMembership } = getMasterModels();

    // Build ordered list of candidate tenant DBs to check for this user
    const candidateDbs = [];
    const addCandidate = (dbName) => {
      if (dbName && !candidateDbs.includes(dbName)) candidateDbs.push(dbName);
    };

    if (companyId) {
      const requested = await MasterCompany.findById(companyId);
      if (requested && requested.isActive) addCandidate(requested.dbName);
    } else if (companyCode) {
      const requested = await MasterCompany.findOne({
        code: String(companyCode).toUpperCase().trim(),
        isActive: true
      });
      if (requested) addCandidate(requested.dbName);
    }

    const memberships = await TenantMembership.find({
      email: normalizedEmail,
      isActive: true
    })
      .sort({ isSuperAdmin: -1, createdAt: 1 })
      .populate('company');

    for (const m of memberships) {
      if (m.company && m.company.isActive) {
        addCandidate(m.company.dbName);
      } else if (m.dbName) {
        addCandidate(m.dbName);
      }
    }

    // Always include default DB as fallback so existing users in hussain_uPVC_erp_system never fail login
    addCandidate(getDefaultDbName());

    let matchedUser = null;
    let matchedDbName = null;
    let deactivatedAccountFound = false;

    for (const dbName of candidateDbs) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runWithTenant(dbName, async () => {
        const u = await User.findOne({ email: normalizedEmail })
          .select('+password')
          .populate('roles');
        if (!u) return null;
        const ok = await u.comparePassword(password);
        if (!ok) return null;
        if (!u.isActive) return { deactivated: true };

        u.lastLoginAt = new Date();
        await u.save();
        return { user: u };
      });

      if (result?.deactivated) {
        deactivatedAccountFound = true;
      } else if (result?.user) {
        matchedUser = result.user;
        matchedDbName = dbName;
        break;
      }
    }

    if (!matchedUser) {
      if (deactivatedAccountFound) {
        return res.status(403).json({ message: 'This account has been deactivated.' });
      }
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    await syncUserMembership(matchedUser, matchedDbName).catch(() => {});
    const tenantInfo = await buildTenantContextForUser(matchedUser, matchedDbName);
    const token = signToken(matchedUser._id, {
      companyId: tenantInfo.company?.id,
      dbName: matchedDbName
    });

    res.json({
      token,
      user: formatUserResponse(matchedUser, tenantInfo)
    });
  } catch (err) {
    next(err);
  }
};

exports.me = async (req, res, next) => {
  try {
    const user = req.user;
    const dbName = req.tenantDbName || getCurrentDbName();
    const tenantInfo = await buildTenantContextForUser(user, dbName);
    res.json(formatUserResponse(user, tenantInfo));
  } catch (err) {
    next(err);
  }
};

exports.switchCompany = async (req, res, next) => {
  try {
    const { companyId, companyCode } = req.body;
    if (!companyId && !companyCode) {
      return res.status(400).json({ message: 'Target companyId or companyCode is required.' });
    }

    const { MasterCompany } = getMasterModels();
    const targetCompany = companyId
      ? await MasterCompany.findById(companyId)
      : await MasterCompany.findOne({ code: String(companyCode).toUpperCase().trim() });

    if (!targetCompany || !targetCompany.isActive) {
      return res.status(404).json({ message: 'Company not found or inactive.' });
    }

    const currentDb = req.tenantDbName || getCurrentDbName();
    const currentTenantInfo = await buildTenantContextForUser(req.user, currentDb);
    const email = req.user.email.toLowerCase().trim();

    const canAccess =
      currentTenantInfo.isSuperAdmin ||
      currentTenantInfo.companies.some((c) => c.dbName === targetCompany.dbName);

    if (!canAccess) {
      return res.status(403).json({ message: 'You do not have access to this company.' });
    }

    // Grab current user's password hash in case we need to auto-provision a Super Admin in the target DB
    const currentUserWithHash = await User.findById(req.user._id).select('+password');

    const targetUser = await runWithTenant(targetCompany.dbName, async () => {
      let u = await User.findOne({ email }).populate('roles');
      if (!u && currentTenantInfo.isSuperAdmin && currentUserWithHash) {
        let adminRole = await Role.findOne({ name: 'Admin' });
        if (!adminRole) {
          adminRole = await Role.create({
            name: 'Admin',
            description: 'Full system access',
            permissions: ['*'],
            isSystem: true
          });
        }
        const inserted = await User.collection.insertOne({
          name: req.user.name,
          email,
          password: currentUserWithHash.password,
          roles: [adminRole._id],
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        });
        u = await User.findById(inserted.insertedId).populate('roles');
      }
      return u;
    });

    if (!targetUser || !targetUser.isActive) {
      return res.status(403).json({ message: 'Your user account is not active in the selected company.' });
    }

    await syncUserMembership(targetUser, targetCompany.dbName, {
      isSuperAdmin: currentTenantInfo.isSuperAdmin
    }).catch(() => {});

    const nextTenantInfo = await buildTenantContextForUser(targetUser, targetCompany.dbName);
    const token = signToken(targetUser._id, {
      companyId: targetCompany._id,
      dbName: targetCompany.dbName
    });

    res.json({
      token,
      user: formatUserResponse(targetUser, nextTenantInfo)
    });
  } catch (err) {
    next(err);
  }
};
