(function (global) {
  'use strict';

  var DB_NAME = 'belmiroke-family-hub';
  var DB_VERSION = 1;
  var ACCOUNT_STORE = 'accounts';
  var STATE_STORE = 'states';
  var SESSION_KEY = 'belmiroke:session:v1';
  var FALLBACK_PREFIX = 'belmiroke:db:v1:';
  var dbPromise = null;

  function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
  }

  function makeFallbackKey(kind, username) {
    return FALLBACK_PREFIX + kind + ':' + normalizeUsername(username);
  }

  function requestToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error('IndexedDB request failed'));
      };
    });
  }

  function openDatabase() {
    if (!global.indexedDB) {
      return Promise.resolve(null);
    }

    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var request = global.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function (event) {
          var db = event.target.result;
          if (!db.objectStoreNames.contains(ACCOUNT_STORE)) {
            db.createObjectStore(ACCOUNT_STORE, { keyPath: 'username' });
          }
          if (!db.objectStoreNames.contains(STATE_STORE)) {
            db.createObjectStore(STATE_STORE, { keyPath: 'username' });
          }
        };

        request.onsuccess = function () {
          resolve(request.result);
        };

        request.onerror = function () {
          reject(request.error || new Error('Failed to open database'));
        };
      });
    }

    return dbPromise;
  }

  function getFallbackAccount(username) {
    return new Promise(function (resolve) {
      resolve(JSON.parse(global.localStorage.getItem(makeFallbackKey('account', username)) || 'null'));
    });
  }

  function setFallbackAccount(account) {
    global.localStorage.setItem(makeFallbackKey('account', account.username), JSON.stringify(account));
    return Promise.resolve(account);
  }

  function getFallbackState(username) {
    return new Promise(function (resolve) {
      resolve(JSON.parse(global.localStorage.getItem(makeFallbackKey('state', username)) || 'null'));
    });
  }

  function setFallbackState(username, snapshot) {
    global.localStorage.setItem(makeFallbackKey('state', username), JSON.stringify({
      username: normalizeUsername(username),
      snapshot: snapshot,
      updatedAt: Date.now(),
    }));
    return Promise.resolve(snapshot);
  }

  function hashPassword(username, password) {
    var seed = normalizeUsername(username) + '::' + String(password || '') + '::belmiroke';

    if (global.crypto && global.crypto.subtle && global.TextEncoder) {
      return global.crypto.subtle.digest('SHA-256', new global.TextEncoder().encode(seed)).then(function (buffer) {
        return Array.prototype.map
          .call(new Uint8Array(buffer), function (byte) {
            return byte.toString(16).padStart(2, '0');
          })
          .join('');
      });
    }

    return Promise.resolve('fallback:' + seed);
  }

  async function getAccount(username) {
    var normalized = normalizeUsername(username);
    var db = await openDatabase();

    if (db) {
      return await requestToPromise(db.transaction(ACCOUNT_STORE, 'readonly').objectStore(ACCOUNT_STORE).get(normalized));
    }

    return getFallbackAccount(normalized);
  }

  async function saveAccount(account) {
    var db = await openDatabase();
    var payload = {
      username: normalizeUsername(account.username),
      passwordHash: String(account.passwordHash || ''),
      displayName: String(account.displayName || account.username || '').trim(),
      createdAt: Number(account.createdAt) || Date.now(),
      updatedAt: Date.now(),
    };

    if (db) {
      await requestToPromise(db.transaction(ACCOUNT_STORE, 'readwrite').objectStore(ACCOUNT_STORE).put(payload));
      return payload;
    }

    return setFallbackAccount(payload);
  }

  async function loginOrRegister(username, password) {
    var normalized = normalizeUsername(username);
    var passwordHash;
    var existing;
    var created = false;

    if (!normalized || !String(password || '').trim()) {
      throw new Error('Usuario e senha sao obrigatorios.');
    }

    passwordHash = await hashPassword(normalized, password);
    existing = await getAccount(normalized);

    if (existing && existing.passwordHash !== passwordHash) {
      throw new Error('Senha incorreta.');
    }

    if (!existing) {
      existing = await saveAccount({
        username: normalized,
        passwordHash: passwordHash,
        displayName: String(username || '').trim() || normalized,
        createdAt: Date.now(),
      });
      created = true;
    }

    return {
      account: existing,
      created: created,
    };
  }

  async function loadSnapshot(username) {
    var normalized = normalizeUsername(username);
    var db = await openDatabase();
    var entry;

    if (db) {
      entry = await requestToPromise(db.transaction(STATE_STORE, 'readonly').objectStore(STATE_STORE).get(normalized));
      return entry && entry.snapshot ? entry.snapshot : null;
    }

    entry = await getFallbackState(normalized);
    return entry && entry.snapshot ? entry.snapshot : null;
  }

  async function saveSnapshot(username, snapshot) {
    var normalized = normalizeUsername(username);
    var db = await openDatabase();
    var entry = {
      username: normalized,
      snapshot: snapshot,
      updatedAt: Date.now(),
    };

    if (db) {
      await requestToPromise(db.transaction(STATE_STORE, 'readwrite').objectStore(STATE_STORE).put(entry));
      return snapshot;
    }

    await setFallbackState(normalized, snapshot);
    return snapshot;
  }

  global.BelmirokeDb = {
    sessionKey: SESSION_KEY,
    normalizeUsername: normalizeUsername,
    loginOrRegister: loginOrRegister,
    loadSnapshot: loadSnapshot,
    saveSnapshot: saveSnapshot,
    getAccount: getAccount,
    saveAccount: saveAccount,
    hashPassword: hashPassword,
  };
})(window);
