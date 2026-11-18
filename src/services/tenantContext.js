const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const tenantStorage = new AsyncLocalStorage();

// Registry of all tenant-scoped schemas registered via mongoose.model(name, schema)
const registeredSchemas = new Map();

// Keep a reference to the original mongoose.model before patching
const originalMongooseModel = mongoose.model.bind(mongoose);

function getDefaultDbName() {
  return mongoose.connection?.name || 'hussain_uPVC_erp_system';
}

function getMasterDbName() {
  return process.env.MASTER_DB_NAME || 'ERP_MASTER';
}

function getCurrentDbName() {
  const store = tenantStorage.getStore();
  return store?.dbName || getDefaultDbName();
}

/**
 * Returns the Mongoose Connection for a given tenant dbName, using connection-pool
 * sharing via useDb(..., { useCache: true }) and ensuring all tenant schemas are
 * registered on that connection so .populate() works everywhere.
 */
function getDbConnection(dbName) {
  const targetDb = dbName || getCurrentDbName();
  const defaultDb = getDefaultDbName();

  if (!targetDb || targetDb === defaultDb) {
    return mongoose.connection;
  }

  const conn = mongoose.connection.useDb(targetDb, { useCache: true });

  // Ensure every registered tenant schema is compiled on this cached tenant connection
  // so cross-model .populate('roles'), .populate('customer'), etc. never fail.
  for (const [modelName, { schema, collection }] of registeredSchemas.entries()) {
    if (!conn.models[modelName]) {
      conn.model(modelName, schema, collection);
    }
  }

  return conn;
}

function getTenantConnection() {
  return getDbConnection(getCurrentDbName());
}

function getMasterDb() {
  return mongoose.connection.useDb(getMasterDbName(), { useCache: true });
}

function runWithTenant(dbName, fn) {
  const resolved = dbName || getDefaultDbName();
  return tenantStorage.run({ dbName: resolved }, fn);
}

function resolveActiveModel(name, baseModel) {
  const store = tenantStorage.getStore();
  const defaultDb = getDefaultDbName();
  if (!store || !store.dbName || store.dbName === defaultDb) {
    return baseModel;
  }
  const conn = getDbConnection(store.dbName);
  return conn.models[name] || conn.model(name, registeredSchemas.get(name)?.schema);
}

function createTenantModelProxy(name, baseModel) {
  return new Proxy(baseModel, {
    get(target, prop) {
      const activeModel = resolveActiveModel(name, target);
      const desc = Object.getOwnPropertyDescriptor(target, prop);
      if (desc && !desc.configurable && !desc.writable) {
        return Reflect.get(target, prop, target);
      }
      const value = Reflect.get(activeModel, prop, activeModel);
      return typeof value === 'function' ? value.bind(activeModel) : value;
    },
    set(target, prop, value) {
      const activeModel = resolveActiveModel(name, target);
      return Reflect.set(activeModel, prop, value, activeModel);
    },
    construct(target, args) {
      const activeModel = resolveActiveModel(name, target);
      return new activeModel(...args);
    },
    getPrototypeOf(target) {
      const activeModel = resolveActiveModel(name, target);
      return Reflect.getPrototypeOf(activeModel);
    }
  });
}

// Cache of model proxies so calling mongoose.model('Invoice') multiple times returns the same proxy
const modelProxies = new Map();

mongoose.model = function patchedMongooseModel(name, schema, collection, options) {
  if (schema) {
    registeredSchemas.set(name, { schema, collection });
  }
  const baseModel = originalMongooseModel(name, schema, collection, options);
  if (!modelProxies.has(name)) {
    modelProxies.set(name, createTenantModelProxy(name, baseModel));
  }
  return modelProxies.get(name);
};

/**
 * Returns all compiled models for the currently active tenant connection.
 * Used during tenant DB initialization/seeding.
 */
function getAllTenantModels() {
  const conn = getTenantConnection();
  return Array.from(registeredSchemas.keys()).map((name) => conn.models[name] || conn.model(name));
}

module.exports = {
  getDefaultDbName,
  getMasterDbName,
  getCurrentDbName,
  getDbConnection,
  getTenantConnection,
  getMasterDb,
  runWithTenant,
  getAllTenantModels
};
