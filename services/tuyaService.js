import axios from 'axios';
import crypto from 'crypto';

const TUYA_BASE = process.env.TUYA_REGION || 'https://openapi.tuyaeu.com';

class TuyaService {
  constructor() {
    this.clientId = process.env.TUYA_CLIENT_ID;
    this.clientSecret = process.env.TUYA_CLIENT_SECRET;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.uid = null;
  }

  sha256(str) {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
  }

  hmac(str) {
    return crypto.createHmac('sha256', this.clientSecret).update(str, 'utf8').digest('hex').toUpperCase();
  }

  sign(method, path, includeToken) {
    const t = Date.now().toString();
    const contentHash = this.sha256('');
    const stringToSign = [method, contentHash, '', path].join('\n');
    const base = includeToken
      ? this.clientId + this.token + t + stringToSign
      : this.clientId + t + stringToSign;
    return { sign: this.hmac(base), t };
  }

  // Fetches (and caches) an app-level access token via Tuya's Cloud "custom project" auth.
  // No per-user login is required for this grant type — client_id/secret alone are enough.
  async getAccessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const path = '/v1.0/token?grant_type=1';
    const { sign, t } = this.sign('GET', path, false);

    const response = await axios.get(`${TUYA_BASE}${path}`, {
      headers: { client_id: this.clientId, sign, t, sign_method: 'HMAC-SHA256' }
    });

    if (!response.data.success) {
      throw new Error(response.data.msg || 'Tuya authentication failed');
    }

    this.token = response.data.result.access_token;
    this.uid = response.data.result.uid;
    this.tokenExpiresAt = Date.now() + (response.data.result.expire_time - 60) * 1000;
    return this.token;
  }

  // Tuya's signature check recomputes the string-to-sign from the query string it
  // receives — if the keys aren't in alphabetical order, verification silently fails
  // with a generic "sign invalid" rather than anything param-related. Building the
  // query string here (once, sorted) means every caller gets this for free instead
  // of having to remember to alphabetize their own query params.
  buildPath(basePath, params = {}) {
    const query = Object.keys(params)
      .filter(key => params[key] !== undefined && params[key] !== null)
      .sort()
      .map(key => `${key}=${encodeURIComponent(params[key])}`)
      .join('&');
    return query ? `${basePath}?${query}` : basePath;
  }

  async request(method, path) {
    await this.getAccessToken();
    const { sign, t } = this.sign(method, path, true);

    const response = await axios({
      method,
      url: `${TUYA_BASE}${path}`,
      headers: { client_id: this.clientId, access_token: this.token, sign, t, sign_method: 'HMAC-SHA256' }
    });

    if (!response.data.success) {
      throw new Error(response.data.msg || 'Tuya API request failed');
    }

    return response.data.result;
  }

  // Every device already linked to this Tuya Cloud project's account (via the Smart Life /
  // Tuya Smart app). Used to let the admin import real devices instead of typing IDs blind.
  async listAccountDevices() {
    await this.getAccessToken();
    return this.request('GET', this.buildPath('/v1.0/iot-01/associated-users/devices', { uid: this.uid }))
      .then(result => result.devices || []);
  }

  async getDeviceDetail(deviceId) {
    return this.request('GET', `/v1.0/devices/${deviceId}`);
  }

  // type=7 is "data point report" — status-change events like a door sensor's open/
  // close transitions or a battery reading update. query_type=1 (the default) is the
  // free tier; the enhanced paid tier isn't needed for this simple event history.
  async getDeviceLogs(deviceId, { startTime = 0, endTime = Date.now(), size = 20, codes, startRowKey } = {}) {
    const path = this.buildPath(`/v1.0/devices/${deviceId}/logs`, {
      type: 7,
      start_time: startTime,
      end_time: endTime,
      size,
      query_type: 1,
      codes,
      start_row_key: startRowKey
    });
    return this.request('GET', path);
  }
}

export default new TuyaService();
