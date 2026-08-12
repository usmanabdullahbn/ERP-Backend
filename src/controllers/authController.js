const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Role = require('../models/Role');
const BootstrapLock = require('../models/BootstrapLock');

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

    // Atomically claim the one-time bootstrap slot. Only one concurrent
    // request can insert this fixed _id; every other request gets a
    // duplicate-key error and is correctly rejected below, closing the race
    // that countDocuments() alone can't close.
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

    const user = await User.create({ name, email, password, role: adminRole._id });
    const token = signToken(user._id);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: { id: adminRole._id, name: adminRole.name, permissions: adminRole.permissions }
      }
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
