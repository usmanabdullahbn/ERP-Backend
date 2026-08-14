const mongoose = require('mongoose');
const dns = require('dns');

const LOCAL_URI = 'mongodb://127.0.0.1:27017/erp_system';

const connectDB = async () => {
  const configuredUri = process.env.MONGO_URI || LOCAL_URI;
  const candidates = [configuredUri, LOCAL_URI];

  for (const uri of candidates) {
    if (!uri) continue;
    if (uri === configuredUri && uri !== LOCAL_URI && String(uri).toLowerCase().startsWith('mongodb+srv://')) {
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

    try {
      await mongoose.connect(uri);
      console.log(`[db] MongoDB connected: ${mongoose.connection.host}`);
      return;
    } catch (err) {
      const isLastCandidate = uri === candidates[candidates.length - 1];
      if (isLastCandidate) {
        console.error('[db] Connection error:', err.message);
        throw err;
      }
      console.warn(`[db] Primary URI failed (${uri}). Retrying with fallback: ${LOCAL_URI}`);
    }
  }
};

module.exports = connectDB;
