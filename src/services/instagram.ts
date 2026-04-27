import axios from 'axios';
import { logger } from '../utils/logger';

const BASE_URL = 'https://graph.facebook.com/v21.0';

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
    if (!igUserId) throw new Error('Missing igUserId');
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
      logger.error('GET request failed', {
        endpoint,
        error: error.response?.data || error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  // ─── POST REQUEST ────────────────────────────────────────────────────────
  private async post(endpoint: string, data: Record<string, any> = {}) {
    try {
      const response = await axios.post(
        `${BASE_URL}/${endpoint}`,
        data,
        { params: { access_token: this.accessToken } }
      );
      return response.data;
    } catch (error: any) {
      logger.error('POST request failed', {
        endpoint,
        error: error.response?.data || error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  // ─── ACCOUNT INFO ─────────────────────────────────────────────────────────
  // THE FIX: Facebook user ID ≠ Instagram Business Account ID
  // Must go through /me/accounts → find page → get IG business account
  async getAccountInfo() {
    try {
      // Step 1: Get all Facebook Pages this user manages
      const pagesData = await this.get('me/accounts', {
        fields: 'id,name,access_token,instagram_business_account',
      });

      logger.info('Pages fetched', { pages: JSON.stringify(pagesData) });

      const pages = pagesData?.data ?? [];

      if (pages.length === 0) {
        throw new Error('NO_PAGES: No Facebook Pages found. Create a Facebook Page and connect Instagram to it.');
      }

      // Step 2: Find page that has Instagram Business Account linked
      const pageWithIG = pages.find(
        (p: any) => p.instagram_business_account?.id
      );

      if (!pageWithIG) {
        throw new Error('NO_IG_BUSINESS: None of your Facebook Pages have an Instagram Business account linked. Go to Instagram → Settings → Account Type → Switch to Professional Account, then link it to your Facebook Page.');
      }

      const igAccountId = pageWithIG.instagram_business_account.id;
      const pageAccessToken = pageWithIG.access_token;

      logger.info('Found IG business account', {
        igAccountId,
        pageName: pageWithIG.name,
      });

      // Step 3: Get Instagram account details using PAGE access token
      const igInfo = await axios.get(`${BASE_URL}/${igAccountId}`, {
        params: {
          access_token: pageAccessToken, // ← must use PAGE token not user token
          fields: 'id,username,profile_picture_url,followers_count,media_count,biography',
        },
      });

      logger.info('IG account info fetched', { username: igInfo.data.username });

      return {
        id: igAccountId,
        username: igInfo.data.username,
        profile_picture_url: igInfo.data.profile_picture_url ?? null,
        followers_count: igInfo.data.followers_count ?? 0,
        media_count: igInfo.data.media_count ?? 0,
        biography: igInfo.data.biography ?? '',
        // Return page token — needed for posting comments/DMs
        page_access_token: pageAccessToken,
        page_id: pageWithIG.id,
      };
    } catch (error: any) {
      logger.error('getAccountInfo failed', {
        message: error.message,
        fbError: error.response?.data,
        status: error.response?.status,
      });
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

  // ─── GET CONVERSATIONS ───────────────────────────────────────────────────
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

  // ─── GET COMMENTS ────────────────────────────────────────────────────────
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

  // ─── SUBSCRIBE WEBHOOKS ──────────────────────────────────────────────────
  async subscribeToWebhooks(pageId: string, pageToken: string) {
    try {
      await axios.post(`${BASE_URL}/${pageId}/subscribed_apps`, null, {
        params: {
          access_token: pageToken,
          subscribed_fields: 'messages,comments,messaging_postbacks',
        },
      });
      logger.info('Webhooks subscribed for page', { pageId });
      return true;
    } catch (error: any) {
      logger.error('Webhook subscribe failed', error.response?.data);
      return false;
    }
  }
}

// ─── OAUTH: EXCHANGE CODE ─────────────────────────────────────────────────
export async function exchangeCodeForToken(code: string, redirectUri: string) {
  try {
    // Step 1 — exchange code for short-lived user access token
    const tokenRes = await axios.get(`${BASE_URL}/oauth/access_token`, {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: redirectUri,
        code,
      },
    });

    const access_token = tokenRes.data.access_token;

    logger.info('Short-lived token obtained');

    // Step 2 — fetch Facebook User ID
    const meRes = await axios.get(`${BASE_URL}/me`, {
      params: { access_token, fields: 'id,name' },
    });

    logger.info('Facebook user identified', { userId: meRes.data.id });

    return {
      access_token,
      user_id: meRes.data.id,
    };
  } catch (error: any) {
    logger.error('OAuth token exchange failed', {
      error: error.response?.data || error.message,
      status: error.response?.status,
    });
    throw error;
  }
}

// ─── LONG LIVED TOKEN ────────────────────────────────────────────────────
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
    logger.info('Long-lived token obtained', {
      expires_in: response.data.expires_in,
    });
    return response.data;
  } catch (error: any) {
    logger.error('Long-lived token failed', {
      error: error.response?.data || error.message,
    });
    throw error;
  }
}
