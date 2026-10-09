const User = require('../models/User');

exports.list = async (req, res, next) => {
  try {
    const users = await User.find().populate('roles', 'name permissions').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { name, email, password, roles } = req.body;
    if (!roles || !roles.length) {
      return res.status(400).json({ message: 'At least one role is required.' });
    }
    const user = await User.create({ name, email, password, roles });
    await user.populate('roles', 'name permissions');
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { name, email, roles, isActive, password } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (roles !== undefined) {
      if (!roles.length) return res.status(400).json({ message: 'At least one role is required.' });
      user.roles = roles;
    }
    if (isActive !== undefined) user.isActive = isActive;
    if (password) user.password = password;

    await user.save();
    await user.populate('roles', 'name permissions');
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'User deleted.' });
  } catch (err) {
    next(err);
  }
};
