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

  // Gateways bridge a Bluetooth lock to WiFi so it can be controlled/queried remotely
  // (deleteType 2 elsewhere in this file, and lock/unlock generally, depend on a gateway
  // being present and online — without one, those calls only work while a phone is within
  // Bluetooth range of the lock itself).
  async listGateways() {
    const response = await axios.get(`${TTLOCK_API_BASE}/gateway/list`, {
      params: await this.authParams({ pageNo: 1, pageSize: 100 }),
    });

    if (response.data.errcode) {
      const err = new Error(response.data.errmsg || 'TTLock gateway list lookup failed');
      err.response = { data: response.data };
      throw err;
    }

    return response.data.list || [];
  }

  // Unlike listGateways() (which only returns gateways THIS account owns — always empty
  // for our service account since the gateway is on a separate personal TTLock account),
  // this looks up by lockId instead and works regardless of gateway ownership, since it
  // only requires holding a key to the lock. Returns rssi (signal strength: TTLock's own
  // scale is >-75 strong, -85 to -75 medium, below -85 weak) and the gateway's name.
  async listGatewaysForLock(lockId) {
    const response = await axios.get(`${TTLOCK_API_BASE}/gateway/listByLock`, {
      params: await this.authParams({ lockId }),
    });

    if (response.data.errcode) {
      const err = new Error(response.data.errmsg || 'TTLock gateway-for-lock lookup failed');
      err.response = { data: response.data };
      throw err;
    }

    return response.data.list || [];
  }

  // Registers a card's physical number (cardNumber, read off the card after it's been
  // encoded — encoding itself happens outside this API, via the E3 encoder hardware and
  // its own local software) as an authorized key on a lock. addType 2 = via gateway,
  // matching how every other remote command in this app reaches a lock — see hasGateway
  // on SmartLockDevice; a Bluetooth-only lock would need addType 1 instead, delivered the
  // next time a phone with a key to the lock is nearby (not implemented here since every
  // lock we currently support this feature on has a gateway).
  async addIdentityCard({ lockId, cardNumber, cardName, startDate, endDate }) {
    const response = await axios.post(`${TTLOCK_API_BASE}/identityCard/add`, null, {
      params: await this.authParams({
        lockId,
        cardNumber,
        cardName,
        startDate,
        endDate,
        addType: 2,
      }),
    });

    if (!response.data.cardId) {
      const err = new Error(response.data.errmsg || 'Failed to authorize the card on this lock');
      err.response = { data: response.data };
      throw err;
    }

    return response.data;
  }

  // cardId here is TTLock's own identifier for the authorization (returned by
  // addIdentityCard), not the card's physical number.
  async deleteIdentityCard(lockId, cardId) {
    const response = await axios.post(`${TTLOCK_API_BASE}/identityCard/delete`, null, {
      params: await this.authParams({ lockId, cardId, deleteType: 2 }),
    });

    if (response.data.errcode) {
      const err = new Error(response.data.errmsg || 'Failed to revoke the card');
      err.response = { data: response.data };
      throw err;
    }

    return response.data;
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

  // For the offline hotel-card scheme (E3 card encoder / CardEncoder.dll): this is the one
  // piece we'd wrongly assumed only TTHotel Pro's own private backend could hand out. It's a
  // plain Open Platform call, authenticated with clientId+clientSecret (not accessToken) —
  // the same app-level credentials this service already holds. The value is only valid for
  // 10 minutes, so callers must fetch it fresh right before writing/reading a card, never cache
  // it.
  async getHotelInfo() {
    const response = await axios.get(`${TTLOCK_API_BASE}/hotel/getInfo`, {
      params: { clientId: this.clientId, clientSecret: this.clientSecret, date: Date.now() },
    });

    if (!response.data.hotelInfo) {
      const err = new Error(response.data.errmsg || 'Failed to fetch hotelInfo');
      err.response = { data: response.data };
      throw err;
    }

    return response.data.hotelInfo;
  }

  async testConnection(lockId) {
    try {
      if (lockId) {
        const detail = await this.getLockDetail(lockId);
        const hasGateway = detail.hasGateway === 1;

        // Same staleness check as jobs/deviceMonitor.js — a successful API call alone doesn't
        // mean the lock itself is still reachable, since TTLock keeps returning its last cached
        // report even after a lock has gone dark. Only meaningful for gateway-connected locks
        // (see that file's comment for why Bluetooth-only locks can't use this signal).
        const reportedAt = Math.max(detail.lockUpdateDate || 0, detail.electricQuantityUpdateDate || 0);
        const staleThresholdMs = Number(process.env.DEVICE_STALE_THRESHOLD_MS) || 15 * 60 * 1000;
        const staleness = reportedAt ? Date.now() - reportedAt : 0;
        const isStale = hasGateway && staleness > staleThresholdMs;

        // Best-effort — this is a real-time signal-strength read from a device we don't own
        // (see listGatewaysForLock's comment), so a hiccup here shouldn't fail the whole check.
        let gatewayName = null;
        let gatewaySignal = null;
        if (hasGateway) {
          try {
            const [gateway] = await this.listGatewaysForLock(lockId);
            if (gateway) {
              gatewayName = gateway.gatewayName || null;
              gatewaySignal = typeof gateway.rssi === 'number' ? gateway.rssi : null;
            }
          } catch (gatewayError) {
            console.error('Gateway-for-lock lookup failed:', gatewayError.message);
          }
        }

        return {
          success: true,
          online: !isStale,
          battery: detail.electricQuantity,
          hasGateway,
          gatewayName,
          gatewaySignal,
          lastReportedAt: reportedAt ? new Date(reportedAt) : null,
          message: isStale
            ? `No status update from ${detail.lockAlias || detail.lockName || 'this lock'} in over ${Math.round(staleness / 60000)} minutes — it may be out of gateway range or have a dead battery.`
            : `Connected — ${detail.lockAlias || detail.lockName || 'lock'} (battery ${detail.electricQuantity}%).`
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
