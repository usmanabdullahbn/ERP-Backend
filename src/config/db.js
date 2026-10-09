const mongoose = require('mongoose');
const dns = require('dns');

const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not defined in .env');

  if (String(uri).toLowerCase().startsWith('mongodb+srv://')) {
    try {
      const envServers = process.env.MONGO_DNS_SERVERS;
      const servers = envServers
        ? envServers.split(',').map((s) => s.trim()).filter(Boolean)
        : ['8.8.8.8', '8.8.4.4'];
      dns.setServers(servers);
    } catch (dnsErr) {
      console.warn('[db] Failed to set DNS servers:', dnsErr.message);
    }
  }

  await mongoose.connect(uri);
  console.log(`[db] MongoDB connected: ${mongoose.connection.host}`);
};

module.exports = connectDB;
