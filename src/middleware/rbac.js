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

module.exports = { requirePermission };
