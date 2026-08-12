const mongoose = require('mongoose');
const dns = require('dns');

const connectDB = async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/erp_system';

    // If using MongoDB Atlas SRV URI, some environments block DNS-SRV lookups.
    // Allow optionally overriding DNS servers via MONGO_DNS_SERVERS (csv),
    // otherwise default to Google's public DNS to help resolve Atlas SRV names.
    if (String(uri).toLowerCase().startsWith('mongodb+srv://')) {
      try {
        const envServers = process.env.MONGO_DNS_SERVERS;
        const servers = envServers
          ? envServers.split(',').map((s) => s.trim()).filter(Boolean)
          : ['8.8.8.8', '8.8.4.4'];
        dns.setServers(servers);
        console.log('[db] Using DNS servers for SRV lookup:', dns.getServers());
      } catch (dnsErr) {
        console.warn('[db] Failed to set DNS servers for SRV lookup:', dnsErr.message);
      }
    }

    await mongoose.connect(uri);
    console.log(`[db] MongoDB connected: ${mongoose.connection.host}`);
  } catch (err) {
    console.error('[db] Connection error:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
