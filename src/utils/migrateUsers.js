require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Role = require('../models/Role');
const User = require('../models/User');

async function run() {
  await connectDB();
  console.log('[migrate] Connected.');

  const deleted = await User.deleteMany({});
  console.log(`[migrate] Deleted ${deleted.deletedCount} user(s).`);

  let adminRole = await Role.findOne({ name: 'Admin' });
  if (!adminRole) {
    adminRole = await Role.create({ name: 'Admin', description: 'Full system access', permissions: ['*'], isSystem: true });
    console.log('[migrate] Admin role created.');
  }

  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';

  await User.create({
    name: 'System Administrator',
    email: adminEmail,
    password: adminPassword,
    roles: [adminRole._id],
    isActive: true
  });

  console.log(`[migrate] Admin user created.`);
  console.log(`          Email   : ${adminEmail}`);
  console.log(`          Password: ${adminPassword}`);
  console.log('[migrate] Done. Please log in with these credentials.');

  await mongoose.connection.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[migrate] Failed:', err.message);
  process.exit(1);
});
