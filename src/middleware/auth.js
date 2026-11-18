const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getDefaultDbName, runWithTenant } = require('../services/tenantContext');
const { getMasterModels } = require('../models/masterModels');

const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.split(' ')[1] : null;

    if (!token) {
      return res.status(401).json({ message: 'Not authenticated. No token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const dbName = decoded.dbName || getDefaultDbName();

    if (dbName !== getDefaultDbName()) {
      const { MasterCompany } = getMasterModels();
      const company = await MasterCompany.findOne({ dbName });
      if (!company || !company.isActive) {
        return res.status(403).json({ message: 'This company workspace has been deactivated.' });
      }
    }

    return await runWithTenant(dbName, async () => {
      const user = await User.findById(decoded.id).populate('roles');

      if (!user || !user.isActive) {
        return res.status(401).json({ message: 'User not found or inactive.' });
      }

      const allPerms = [...new Set((user.roles || []).flatMap((r) => r.permissions || []))];
      const roleNames = (user.roles || []).map((r) => (r.name || '').toLowerCase());

      req.user = user;
      req.tenantDbName = dbName;
      req.companyId = decoded.companyId || null;
      req.mergedPerms = allPerms;
      req.roleNames = roleNames;
      return next();
    });
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
};

module.exports = { protect };
