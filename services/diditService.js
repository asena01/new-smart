import axios from 'axios';
import dotenv from 'dotenv';

// Loaded here (not just in server.js) because this module is instantiated as a
// singleton at import time, which happens before server.js's own dotenv.config() call.
dotenv.config();

const DIDIT_API_BASE = 'https://verification.didit.me';

export class DiditService {
  constructor() {
    this.apiKey = process.env.DIDIT_API_KEY;
    this.workflowId = process.env.DIDIT_WORKFLOW_ID;
  }

  async createSession(vendorData, callbackUrl) {
    try {
      const response = await axios.post(
        `${DIDIT_API_BASE}/v3/session/`,
        {
          workflow_id: this.workflowId,
          vendor_data: vendorData,
          callback: callbackUrl,
        },
        {
          headers: {
            'x-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error('❌ Didit session creation error:', error.message);
      throw error;
    }
  }

  async getSessionDecision(sessionId) {
    try {
      const response = await axios.get(
        `${DIDIT_API_BASE}/v3/session/${sessionId}/decision/`,
        { headers: { 'x-api-key': this.apiKey } }
      );
      return response.data;
    } catch (error) {
      console.error('❌ Didit decision fetch error:', error.message);
      throw error;
    }
  }
}

export default new DiditService();
