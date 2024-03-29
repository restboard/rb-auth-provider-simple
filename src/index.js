import { errors, RbAuthProvider } from "rb-core-module";
import { defaultClient, retryCodes } from "./http.js";
import storage from "./storage.js";

class RbSimpleAuthProvider extends RbAuthProvider {
  constructor(
    authURL,
    {
      checkURL,
      parseUserDetails,
      parseToken,
      tokenCacheKey,
      userIdentifier,
      tenantIdentifier,
      acl,
      timeout,
      retries,
      backoff,
      client,
      writeToStorage,
      readFromStorage,
      removeFromStorage,
    } = {}
  ) {
    super();
    this.authURL = authURL;
    this.checkURL = checkURL || authURL;
    this.parseUserDetails = parseUserDetails || (res => res.user);
    this.parseToken = parseToken || (res => res.token);
    this.tokenCacheKey = tokenCacheKey || "rb-auth-token";
    this.userIdentifier = userIdentifier;
    this.tenantIdentifier = tenantIdentifier;
    this.acl = acl;
    this.timeout = timeout || 5000;
    this.retries = retries || 3;
    this.backoff = backoff || 300;
    this.client = client || defaultClient;
    this.writeToStorage = writeToStorage || storage.writeToStorage;
    this.readFromStorage = readFromStorage || storage.readFromStorage;
    this.removeFromStorage = removeFromStorage || storage.removeFromStorage;
  }

  async login({ keepLogged = false, ...credentials }) {
    return this._performAuth(this.authURL, keepLogged, credentials);
  }

  async logout() {
    if (this.removeFromStorage) {
      await this.removeFromStorage(this.tokenCacheKey);
    }
  }

  async checkAuth() {
    const { token, keepLogged } = await this._getTokenFromCache();
    return this._performAuth(this.checkURL, keepLogged, token);
  }

  async getIdentity(user = {}) {
    if (this.userIdentifier) {
      return this.userIdentifier(user);
    }
    return user.fullname || user.name || user.username || user.email || "";
  }

  async getTenantIdentity(user = {}) {
    if (this.tenantIdentifier) {
      return this.tenantIdentifier(user);
    }
    return null;
  }

  async can(user, action, subject) {
    if (!user) {
      throw new Error(errors.ERR_UNAUTHORIZED);
    }
    if (!action) {
      throw new Error(errors.ERR_INVALID_ACTION);
    }
    if (this.acl) {
      const isAuthorized = await this.acl(user, action, subject);
      if (!isAuthorized) {
        throw new Error(errors.ERR_FORBIDDEN);
      }
    }
  }

  async _performRequest(url, options, retries, backoff) {
    const _backoff = backoff || this.backoff;
    const res = await this.client(url, {
      timeout: this.timeout,
      ...options,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        ...options.headers,
      },
    });
    if (!res.ok) {
      if (retries > 1 && retryCodes.includes(res.status)) {
        return new Promise((resolve, reject) => {
          setTimeout(async () => {
            try {
              const res = await this._performRequest(
                url,
                options,
                retries - 1,
                _backoff * 2
              );
              resolve(res);
            } catch (err) {
              reject(err);
            }
          }, _backoff);
        });
      } else {
        throw new Error(res.statusText);
      }
    }
    return res.json();
  }

  async _performAuth(url, keepLogged, tokenOrCredentials = null) {
    if (!tokenOrCredentials) {
      throw new Error(errors.ERR_UNAUTHORIZED);
    }
    const isBearerToken = typeof tokenOrCredentials === "string";
    const headers = {};
    if (isBearerToken) {
      headers["Authorization"] = `Bearer ${tokenOrCredentials}`;
    }
    const body = !isBearerToken && tokenOrCredentials;
    const res = await this._performRequest(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body || {}),
      },
      this.retries
    );
    const user = this.parseUserDetails(res);
    const token = this.parseToken(res);
    await this._storeTokenToCache(token, keepLogged);
    return {
      data: user,
    };
  }

  async _storeTokenToCache(token, keepLogged) {
    if (this.writeToStorage) {
      await this.writeToStorage(this.tokenCacheKey, token, keepLogged);
    }
  }

  async _getTokenFromCache() {
    if (!this.readFromStorage) {
      return { token: null, keepLogged: false };
    }
    const { value: token, persistent: keepLogged } = await this.readFromStorage(this.tokenCacheKey);
    return { token, keepLogged };
  }
}

function createAuthProvider(authURL, opts) {
  return new RbSimpleAuthProvider(authURL, opts);
}

export default createAuthProvider;
