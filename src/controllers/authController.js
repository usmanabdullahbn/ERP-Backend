const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Role = require('../models/Role');

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

/*
  Registration is intentionally restricted: the very first user in an empty
  system becomes Admin (used for initial setup). After that, new users must
  be created by an admin via /api/users, not self-registration.
*/
exports.register = async (req, res, next) => {
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

    let adminRole = await Role.findOne({ name: 'Admin' });
    if (!adminRole) {
      adminRole = await Role.create({
        name: 'Admin',
        description: 'Full system access',
        permissions: ['*'],
        isSystem: true
      });
    }

    const user = await User.create({ name, email, password, role: adminRole._id });
    const token = signToken(user._id);

    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: adminRole.name }
    });
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password').populate('role');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: 'This account has been deactivated.' });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = signToken(user._id);
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: { id: user.role._id, name: user.role.name, permissions: user.role.permissions }
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.me = async (req, res) => {
  const user = req.user;
  res.json({
    id: user._id,
    name: user.name,
    email: user.email,
    role: {
      id: user.role._id,
      name: user.role.name,
      permissions: user.role.permissions
    }
  });
};
