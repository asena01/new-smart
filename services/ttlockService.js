import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Loaded here (not just in server.js) because this module is instantiated as a
// singleton at import time, which happens before server.js's own dotenv.config() call.
dotenv.config();

// This app's Client ID is registered on TTLock's EU Open Platform (euopen.ttlock.com),
// so every call must go through the matching EU regional API host — the generic
// api.ttlock.com / cnapi.ttlock.com hosts reject this account. The OAuth endpoint
// lives at the API root, NOT under /v3 — only the lock-control endpoints
// (lock/unlock/query/etc.) are versioned under /v3.
const TTLOCK_AUTH_BASE = 'https://euapi.ttlock.com';
const TTLOCK_API_BASE = 'https://euapi.ttlock.com/v3';

export class TTLockService {
  constructor() {
    this.clientId = process.env.TTLOCK_CLIENT_ID;
    this.clientSecret = process.env.TTLOCK_CLIENT_SECRET;
    this.username = process.env.TTLOCK_USERNAME;
    this.password = process.env.TTLOCK_PASSWORD;
    this.accessToken = process.env.TTLOCK_ACCESS_TOKEN;
    this.tokenExpiresAt = 0;
  }

  // TTLock's real API only supports the "password" grant type — it needs an actual
  // TTLock account (username + MD5-hashed password), not just API client credentials.
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;

    if (!this.username || !this.password) {
      throw new Error('TTLOCK_USERNAME and TTLOCK_PASSWORD are not configured');
    }

    try {
      const body = new URLSearchParams({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        username: this.username,
        password: crypto.createHash('md5').update(this.password, 'utf8').digest('hex'),
        grant_type: 'password',
      });

      const response = await axios.post(`${TTLOCK_AUTH_BASE}/oauth2/token`, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      if (!response.data.access_token) {
        const err = new Error(response.data.errmsg || 'TTLock authentication failed');
        err.response = { data: response.data };
        throw err;
      }

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = Date.now() + (response.data.expires_in ? response.data.expires_in * 1000 - 60000 : 3600000);
      return this.accessToken;
    } catch (error) {
      console.error('❌ TTLock token error:', error.message);
      throw error;
    }
  }

  // Provisions an app-account under this app's Client ID, for the backend to use as its
  // own service identity — TTLock's recommended pattern for system-to-system integration,
  // rather than requiring a human to sign into the consumer TTLock app. `rawUsername` may
  // only contain letters/digits; the returned username is prefixed by TTLock (e.g.
  // "abcd_myusername") and is what must be used for getAccessToken() afterwards.
  async registerUser(rawUsername, rawPassword) {
    const body = new URLSearchParams({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      username: rawUsername,
      password: crypto.createHash('md5').update(rawPassword, 'utf8').digest('hex'),
      date: Date.now().toString(),
    });

    const response = await axios.post(`${TTLOCK_API_BASE}/user/register`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!response.data.username) {
      const err = new Error(response.data.errmsg || 'TTLock user registration failed');
      err.response = { data: response.data };
      throw err;
    }

    return response.data.username;
  }

  // TTLock's real V3 API authenticates via clientId/accessToken as query params on
  // every request — NOT a Bearer Authorization header, which the API silently ignores.
  async authParams(extra = {}) {
    const accessToken = await this.getAccessToken();
    return { clientId: this.clientId, accessToken, date: Date.now(), ...extra };
  }

  // keyboardPwdType 3 = "Period": valid for the given start/end window, matching a guest's
  // check-in through check-out dates. Response shape is { keyboardPwd, keyboardPwdId } —
  // not { password } as an earlier, untested version of this method assumed.
  async generateAccessCode(lockId, startDate, endDate, guestName) {
    try {
      const response = await axios.post(
        `${TTLOCK_API_BASE}/keyboardPwd/get`,
        null,
        {
          params: await this.authParams({
            lockId,
            keyboardPwdType: 3,
            keyboardPwdName: guestName,
            startDate: new Date(startDate).getTime(),
            endDate: new Date(endDate).getTime(),
          }),
        }
      );

      if (!response.data.keyboardPwd) {
        const err = new Error(response.data.errmsg || 'TTLock passcode generation failed');
        err.response = { data: response.data };
        throw err;
      }

      return response.data;
    } catch (error) {
      console.error('❌ TTLock code generation error:', error.message);
      throw error;
    }
  }

  // Sends a remote eKey to receiverEmail, letting the recipient unlock via their own phone's
  // Bluetooth connection through the TTLock app — no gateway required, same as the passcode
  // path. createUser: 1 auto-provisions a TTLock account for receiverEmail if it isn't already
  // registered, with the account's password set by TTLock to the last 6 characters of the
  // email address (TTLock's own convention — we don't choose or store this password).
  async sendEkey(lockId, receiverEmail, keyName, startDate, endDate) {
    try {
      const response = await axios.post(`${TTLOCK_API_BASE}/key/send`, null, {
        params: await this.authParams({
          lockId,
          receiverUsername: receiverEmail,
          keyName,
          startDate: new Date(startDate).getTime(),
          endDate: new Date(endDate).getTime(),
          createUser: 1,
        }),
      });

      if (!response.data.keyId) {
        const err = new Error(response.data.errmsg || 'TTLock eKey send failed');
        err.response = { data: response.data };
        throw err;
      }

      return response.data;
    } catch (error) {
      console.error('❌ TTLock eKey send error:', error.message);
      throw error;
    }
  }

  // Deletes a specific keyboard passcode from the lock immediately. deleteType 2 = via
  // gateway/WiFi (matches lockDevice/unlockDevice already assuming remote connectivity,
  // rather than deleteType 1 which only marks it for deletion next time a phone connects
  // to the lock over Bluetooth).
  async deleteKeyboardPwd(lockId, keyboardPwdId) {
    try {
      const response = await axios.post(`${TTLOCK_API_BASE}/keyboardPwd/delete`, null, {
        params: await this.authParams({ lockId, keyboardPwdId, deleteType: 2 }),
      });

      if (response.data.errcode) {
        const err = new Error(response.data.errmsg || 'TTLock passcode deletion failed');
        err.response = { data: response.data };
        throw err;
      }

      return response.data;
    } catch (error) {
      console.error('❌ TTLock passcode deletion error:', error.message);
      throw error;
    }
  }

  // Revokes a previously-sent eKey so the guest's TTLock app can no longer unlock with it.
  async revokeEkey(lockId, keyId) {
    try {
      const response = await axios.post(`${TTLOCK_API_BASE}/key/delete`, null, {
        params: await this.authParams({ lockId, keyId }),
      });

      if (response.data.errcode) {
        const err = new Error(response.data.errmsg || 'TTLock eKey revocation failed');
        err.response = { data: response.data };
        throw err;
      }

      return response.data;
    } catch (error) {
      console.error('❌ TTLock eKey revocation error:', error.message);
      throw error;
    }
  }

  // Returns the raw `lockData` blob our own service-account key holds for this lock —
  // this is what the mobile app's native TTLock SDK needs to unlock over Bluetooth
  // directly, with no gateway and no guest-side TTLock account/eKey-sharing required.
  // Unlike a real per-guest eKey, this string carries no built-in expiry on TTLock's
  // side (it's our admin key), so the caller MUST enforce the guest's stay window
  // itself before ever handing this out.
  async getLockData(lockId) {
    const response = await axios.get(`${TTLOCK_API_BASE}/key/get`, {
      params: await this.authParams({ lockId }),
    });

    if (!response.data.lockData) {
      const err = new Error(response.data.errmsg || 'TTLock lock data lookup failed');
      err.response = { data: response.data };
      throw err;
    }

    return response.data;
  }

  async lockDevice(lockId) {
    try {
      const response = await axios.post(`${TTLOCK_API_BASE}/lock/lock`, null, {
        params: await this.authParams({ lockId }),
      });

      return response.data;
    } catch (error) {
      console.error('❌ TTLock lock error:', error.message);
      throw error;
    }
  }

  async unlockDevice(lockId) {
    try {
      const response = await axios.post(`${TTLOCK_API_BASE}/lock/unlock`, null, {
        params: await this.authParams({ lockId }),
      });

      return response.data;
    } catch (error) {
      console.error('❌ TTLock unlock error:', error.message);
      throw error;
    }
  }

  // Our service account controls locks via a shared eKey (same as getLockData/generateAccessCode
  // below), not by being the lock's registered owner — so /lock/list (owned locks) always comes
  // back empty for this account. /key/list is the endpoint that actually reflects "locks this
  // account holds a working key for", which is what determines whether getLockData will ever
  // succeed for a given lockId. This is also why a lock's Bluetooth-advertised name (e.g.
  // "H901_ebc7aa") previously got typed into the lockId field by mistake — there was no list to
  // pick from, so the admin had to guess an ID for a lock that, as it turned out, this account
  // was never even granted a key to in the first place.
  async listLocks() {
    const response = await axios.get(`${TTLOCK_API_BASE}/key/list`, {
      params: await this.authParams({ pageNo: 1, pageSize: 100 }),
    });

    if (response.data.errcode) {
      const err = new Error(response.data.errmsg || 'TTLock key list lookup failed');
      err.response = { data: response.data };
      throw err;
    }

    return response.data.list || [];
  }

  // Unlock/lock history TTLock itself retains per-lock — recordType distinguishes how it
  // was opened (app, passcode, IC card, fingerprint, gateway/remote, mechanical key, auto-lock,
  // tamper alert, etc). startDate/endDate are epoch ms; 0 means no bound on that side.
  async getLockRecords(lockId, { startDate = 0, endDate = 0, pageNo = 1, pageSize = 20 } = {}) {
    const response = await axios.get(`${TTLOCK_API_BASE}/lockRecord/list`, {
      params: await this.authParams({ lockId, startDate, endDate, pageNo, pageSize }),
    });

    if (response.data.errcode) {
      const err = new Error(response.data.errmsg || 'TTLock records lookup failed');
      err.response = { data: response.data };
      throw err;
    }

    return response.data;
  }

  async getLockDetail(lockId) {
    const response = await axios.get(`${TTLOCK_API_BASE}/lock/detail`, {
      params: await this.authParams({ lockId }),
    });

    if (response.data.errcode) {
      const err = new Error(response.data.errmsg || 'TTLock lock lookup failed');
      err.response = { data: response.data };
      throw err;
    }

    return response.data;
  }

  async testConnection(lockId) {
    try {
      if (lockId) {
        const detail = await this.getLockDetail(lockId);
        return {
          success: true,
          online: true,
          message: `Connected — ${detail.lockAlias || detail.lockName || 'lock'} (battery ${detail.electricQuantity}%).`
        };
      }

      await this.getAccessToken();
      return { success: true, message: 'Connected to TTLock.' };
    } catch (error) {
      const detail = error.response?.data;
      const reason = detail?.errmsg || error.message;
      return { success: false, message: `TTLock authentication failed: ${reason}` };
    }
  }
}

export default new TTLockService();
