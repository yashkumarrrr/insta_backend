import axios from 'axios';
import { logger } from '../utils/logger';

const BASE_URL = 'https://graph.facebook.com/v18.0';

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
    this.accessToken = accessToken;
    this.igUserId = igUserId;
  }

  private async get(endpoint: string, params: Record<string, any> = {}) {
    const response = await axios.get(`${BASE_URL}/${endpoint}`, {
      params: { access_token: this.accessToken, ...params },
    });
    return response.data;
  }

  private async post(endpoint: string, data: Record<string, any> = {}) {
    const response = await axios.post(`${BASE_URL}/${endpoint}`, {
      access_token: this.accessToken,
      ...data,
    });
    return response.data;
  }

  // ─── Send DM ─────────────────────────────────────────────────────────────
  async sendDM(recipientId: string, message: string): Promise<{ message_id: string }> {
    try {
      const data = await this.post(`${this.igUserId}/messages`, {
        recipient: { id: recipientId },
        message: { text: message },
      });
      logger.info('DM sent', { recipientId, messageId: data.message_id });
      return data;
    } catch (error: any) {
      logger.error('Failed to send DM:', error.response?.data || error.message);
      throw new Error(error.response?.data?.error?.message || 'Failed to send DM');
    }
  }

  // ─── Reply to Comment ─────────────────────────────────────────────────────
  async replyToComment(commentId: string, message: string): Promise<{ id: string }> {
    try {
      const data = await this.post(`${commentId}/replies`, { message });
      return data;
    } catch (error: any) {
      logger.error('Failed to reply to comment:', error.response?.data);
      throw new Error(error.response?.data?.error?.message || 'Failed to reply to comment');
    }
  }

  // ─── Get Conversations ────────────────────────────────────────────────────
  async getConversations(limit = 20): Promise<IGConversation[]> {
    try {
      const data = await this.get(`${this.igUserId}/conversations`, {
        fields: 'id,messages{message,from,created_time},participants',
        limit,
      });
      return data.data || [];
    } catch (error: any) {
      logger.error('Failed to get conversations:', error.response?.data);
      return [];
    }
  }

  // ─── Get Messages in Conversation ────────────────────────────────────────
  async getMessages(conversationId: string, limit = 50): Promise<IGMessage[]> {
    try {
      const data = await this.get(`${conversationId}/messages`, {
        fields: 'id,message,from,created_time,attachments',
        limit,
      });
      return data.data || [];
    } catch (error: any) {
      logger.error('Failed to get messages:', error.response?.data);
      return [];
    }
  }

  // ─── Get Media Comments ───────────────────────────────────────────────────
  async getMediaComments(mediaId: string): Promise<any[]> {
    try {
      const data = await this.get(`${mediaId}/comments`, {
        fields: 'id,text,username,timestamp,from',
        limit: 50,
      });
      return data.data || [];
    } catch (error: any) {
      logger.error('Failed to get comments:', error.response?.data);
      return [];
    }
  }

  // ─── Get User Media ───────────────────────────────────────────────────────
  async getUserMedia(limit = 10): Promise<any[]> {
    try {
      const data = await this.get(`${this.igUserId}/media`, {
        fields: 'id,caption,media_type,timestamp,comments_count,like_count',
        limit,
      });
      return data.data || [];
    } catch (error: any) {
      logger.error('Failed to get media:', error.response?.data);
      return [];
    }
  }

  // ─── Get Account Info ─────────────────────────────────────────────────────
  async getAccountInfo(): Promise<any> {
    try {
      return await this.get(this.igUserId, {
        fields: 'id,username,name,profile_picture_url,followers_count,media_count,biography',
      });
    } catch (error: any) {
      logger.error('Failed to get account info:', error.response?.data);
      throw error;
    }
  }

  // ─── Subscribe to Webhooks ────────────────────────────────────────────────
  async subscribeToWebhooks(pageId: string, pageToken: string): Promise<boolean> {
    try {
      await axios.post(`${BASE_URL}/${pageId}/subscribed_apps`, {
        subscribed_fields: 'messages,comments,messaging_postbacks',
        access_token: pageToken,
      });
      return true;
    } catch (error: any) {
      logger.error('Failed to subscribe webhooks:', error.response?.data);
      return false;
    }
  }
}

// ─── Exchange OAuth Code for Token ────────────────────────────────────────────
export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<{
  access_token: string;
  user_id: string;
}> {
  const response = await axios.get(`${BASE_URL}/oauth/access_token`, {
    params: {
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: redirectUri,
      code,
    },
  });
  return response.data;
}

// ─── Exchange Short-lived for Long-lived Token ────────────────────────────────
export async function getLongLivedToken(shortToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const response = await axios.get(`${BASE_URL}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: shortToken,
    },
  });
  return response.data;
}
