import axios from 'axios';
import { logger } from '../utils/logger';

const BASE_URL = 'https://graph.facebook.com/v21.0';  // ✅ Fixed closing quote

export interface IGMessage {
  id: string;
  message: string;
  from: { id: string; username?: string };
  created_time: string;
}

export interface IGConversation {
  id: string;
  messages: { data: IGMessage[] };
  participants: { data: Array<{ id: string; username?: string }> };
}

export class InstagramService {
  private accessToken: string;
  private igUserId: string;

  constructor(accessToken: string, igUserId: string) {
    if (!accessToken) throw new Error('Missing accessToken');
    if (!igUserId) throw new Error('Missing igUserId (this is required)');
    this.accessToken = accessToken;
    this.igUserId = igUserId;
  }

  // ─── GET REQUEST ─────────────────────────────────────────────────────────
  private async get(endpoint: string, params: Record<string, any> = {}) {
    try {
      const response = await axios.get(`${BASE_URL}/${endpoint}`, {
        params: { access_token: this.accessToken, ...params },
      });
      return response.data;
    } catch (error: any) {
      logger.error('GET request failed', error.response?.data || error.message);
      throw error;
    }
  }

  // ─── POST REQUEST (FIXED) ────────────────────────────────────────────────
  // Token in params, data as JSON body — required for DM and comment endpoints
  private async post(endpoint: string, data: Record<string, any> = {}) {
    try {
      const response = await axios.post(
        `${BASE_URL}/${endpoint}`,
        data,                                          // ✅ JSON body
        { params: { access_token: this.accessToken } } // ✅ token in params
      );
      return response.data;
    } catch (error: any) {
      logger.error('POST request failed', error.response?.data || error.message);
      throw error;
    }
  }

  // ─── SEND DM ─────────────────────────────────────────────────────────────
  async sendDM(recipientId: string, message: string) {
    try {
      const data = await this.post(`${this.igUserId}/messages`, {
        recipient: { id: recipientId },
        message: { text: message },
      });
      logger.info('DM sent', { recipientId, messageId: data.message_id });
      return data;
    } catch (error: any) {
      logger.error('Failed to send DM', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to send DM');
    }
  }

  // ─── REPLY TO COMMENT ────────────────────────────────────────────────────
  async replyToComment(commentId: string, message: string) {
    try {
      return await this.post(`${commentId}/replies`, { message });
    } catch (error: any) {
      logger.error('Failed to reply to comment', error.response?.data);
      throw new Error(error.response?.data?.error?.message || 'Failed to reply');
    }
  }

  // ─── GET CONVERSATIONS ──────────────────────────────────────────────────
  async getConversations(limit = 20): Promise<IGConversation[]> {
    try {
      const data = await this.get(`${this.igUserId}/conversations`, {
        fields: 'id,messages{message,from,created_time},participants',
        limit,
      });
      return data?.data ?? [];
    } catch (error: any) {
      logger.error('Failed to get conversations', error.response?.data);
      return [];
    }
  }

  // ─── GET MESSAGES ────────────────────────────────────────────────────────
  async getMessages(conversationId: string, limit = 50) {
    try {
      const data = await this.get(`${conversationId}/messages`, {
        fields: 'id,message,from,created_time,attachments',
        limit,
      });
      return data?.data ?? [];
    } catch (error: any) {
      logger.error('Failed to get messages', error.response?.data);
      return [];
    }
  }

  // ─── GET COMMENTS ───────────────────────────────────────────────────────
  async getMediaComments(mediaId: string) {
    try {
      const data = await this.get(`${mediaId}/comments`, {
        fields: 'id,text,username,timestamp,from',
        limit: 50,
      });
      return data?.data ?? [];
    } catch (error: any) {
      logger.error('Failed to get comments', error.response?.data);
      return [];
    }
  }

  // ─── GET MEDIA ───────────────────────────────────────────────────────────
  async getUserMedia(limit = 10) {
    try {
      const data = await this.get(`${this.igUserId}/media`, {
        fields: 'id,caption,media_type,timestamp,comments_count,like_count',
        limit,
      });
      return data?.data ?? [];
    } catch (error: any) {
      logger.error('Failed to get media', error.response?.data);
      return [];
    }
  }

  // ─── ACCOUNT INFO ────────────────────────────────────────────────────────
  async getAccountInfo() {
    try {
      return await this.get(this.igUserId, {
        fields: 'id,username,name',
      });
    } catch (error: any) {
      logger.error('Failed to get account info', error.response?.data);
      throw error;
    }
  }

  // ─── SUBSCRIBE WEBHOOKS ──────────────────────────────────────────────────
  async subscribeToWebhooks(pageId: string, pageToken: string) {
    try {
      await axios.post(`${BASE_URL}/${pageId}/subscribed_apps`, null, {
        params: {
          access_token: pageToken,
          subscribed_fields: 'messages,comments,messaging_postbacks',
        },
      });
      return true;
    } catch (error: any) {
      logger.error('Webhook subscribe failed', error.response?.data);
      return false;
    }
  }
}

// ─── OAUTH: EXCHANGE CODE ──────────────────────────────────────────────────
// ✅ FIXED: Facebook does NOT return user_id in token exchange
// We fetch it separately via /me endpoint
export async function exchangeCodeForToken(code: string, redirectUri: string) {
  try {
    // Step 1 — exchange code for access token
    const tokenRes = await axios.get(`${BASE_URL}/oauth/access_token`, {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: redirectUri,
        code,
      },
    });

    const access_token = tokenRes.data.access_token;

    // Step 2 — fetch user ID separately (not included in token response)
    const meRes = await axios.get(`${BASE_URL}/me`, {
      params: { access_token, fields: 'id' },
    });

    return {
      access_token,
      user_id: meRes.data.id,
    };
  } catch (error: any) {
    logger.error('OAuth token exchange failed', error.response?.data);
    throw error;
  }
}

// ─── LONG LIVED TOKEN ──────────────────────────────────────────────────────
export async function getLongLivedToken(shortToken: string) {
  try {
    const response = await axios.get(`${BASE_URL}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: shortToken,
      },
    });
    return response.data;
  } catch (error: any) {
    logger.error('Long-lived token failed', error.response?.data);
    throw error;
  }
}
