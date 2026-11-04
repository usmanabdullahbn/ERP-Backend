/*
  Usage: requirePermission('sales.manage')
  Permissions are merged from all roles assigned to the user.
  The special permission '*' grants full access.
*/
const requirePermission = (...permissions) => {
  return (req, res, next) => {
    const userPerms = req.mergedPerms || [];

    if (userPerms.includes('*')) return next();

    const allowed = permissions.some((p) => userPerms.includes(p));
    if (!allowed) {
      return res.status(403).json({
        message: `Forbidden. Requires one of: ${permissions.join(', ')}`
      });
    }
    next();
  };
};

/* Admin = any assigned role named "Admin" OR any role with the '*' wildcard permission. */
const isAdminRequest = (req) => {
  const userPerms = req.mergedPerms || [];
  const roleNames = req.roleNames || [];
  return userPerms.includes('*') || roleNames.includes('admin');
};

/* Restricts an endpoint to admin users only. */
const requireAdmin = (req, res, next) => {
  if (isAdminRequest(req)) return next();

  return res.status(403).json({ message: 'Forbidden. Admin access required.' });
};

module.exports = { requirePermission, requireAdmin, isAdminRequest };
