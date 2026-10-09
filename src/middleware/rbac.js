/*
  Usage: requirePermission('sales.manage')
  A user's Role document carries a permissions[] array of strings.
  The special permission '*' (assigned to the Admin system role) bypasses all checks.
*/
const requirePermission = (...permissions) => {
  return (req, res, next) => {
    const userPerms = req.user?.role?.permissions || [];

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

/* Restricts an endpoint to admin users only.
   Admin = role named "Admin" (case-insensitive) OR role with the '*' wildcard permission. */
const requireAdmin = (req, res, next) => {
  const userPerms = req.user?.role?.permissions || [];
  const roleName = req.user?.role?.name || '';

  if (userPerms.includes('*') || roleName.toLowerCase() === 'admin') {
    return next();
  }

  return res.status(403).json({ message: 'Forbidden. Admin access required.' });
};

module.exports = { requirePermission, requireAdmin };
