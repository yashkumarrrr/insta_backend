import Bull from 'bull';
import { prisma } from '../utils/prisma';
import { InstagramService } from '../services/instagram';
import { generateAIReply, generateCommentReply, detectIntent, shouldReply } from '../services/openai';
import { decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { findKeywordReply } from '../utils/keywordMatcher';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

logger.info(`🔴 Redis URL: ${REDIS_URL}`);

export const automationQueue = new Bull('automation', REDIS_URL, {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

automationQueue.on('ready', () => {
  logger.info('✅ Bull queue connected to Redis');
});

automationQueue.on('error', (err) => {
  logger.error('❌ Bull queue error:', err.message);
});

// Rate limiter state
const rateLimiter: Map<string, { count: number; windowStart: number }> = new Map();

// Username cache
const usernameCache = new Map<string, string>();

function checkRateLimit(userId: string, type: 'dm' | 'reply', maxPerHour: number): boolean {
  const key = `${userId}:${type}`;
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;

  const state = rateLimiter.get(key);
  if (!state || now - state.windowStart > windowMs) {
    rateLimiter.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (state.count >= maxPerHour) {
    logger.warn(`Rate limit hit for ${key}: ${state.count}/${maxPerHour}`);
    return false;
  }

  state.count++;
  return true;
}

// ─── Subscription Check ───────────────────────────────────────────────────────
async function hasActiveSubscription(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      isTrialActive: true,
      trialEndsAt: true,
      subStatus: true,
    },
  });

  if (!user) return false;

  const now = new Date();
  const isTrialValid = user.isTrialActive && new Date(user.trialEndsAt) > now;
  const isSubActive = ['active', 'trialing'].includes(user.subStatus || '');

  return isTrialValid || isSubActive;
}

// ─── Process DM ───────────────────────────────────────────────────────────────
automationQueue.process('process-dm', 5, async (job) => {
  const { userId, senderId, message, messageId, isFromComment } = job.data;

  logger.info('Processing DM automation', { userId, senderId });

  try {
    // ─── Subscription check ───────────────────────────────────────────────
    const subscribed = await hasActiveSubscription(userId);
    if (!subscribed) {
      logger.info('⛔ Subscription expired — skipping DM automation', { userId });
      return;
    }

    const [igAccount, aiSettings] = await Promise.all([
      prisma.instagramAccount.findUnique({ where: { userId } }),
      prisma.aISettings.findUnique({ where: { userId } }),
    ]);

    if (!igAccount?.accessToken || !igAccount.automationOn) {
      logger.info('Automation off or no account', { userId });
      return;
    }

    if (!checkRateLimit(userId, 'dm', aiSettings?.maxDMsPerHour || 20)) {
      await prisma.automationLog.create({
        data: { userId, type: 'rate_limit', status: 'failed', source: 'dm', igUserId: senderId },
      });
      return;
    }

    if (senderId === igAccount.igUserId) return;

    const token = igAccount.pageToken
      ? decrypt(igAccount.pageToken)
      : decrypt(igAccount.accessToken);

    const igService = new InstagramService(token, igAccount.igUserId, igAccount.pageId);

    let conversation = await prisma.conversation.findFirst({
      where: { userId, igUserId: senderId },
      include: { messages: { orderBy: { sentAt: 'desc' }, take: 10 } },
    });

    if (!conversation) {
      let igUsername: string | null = usernameCache.get(senderId) ?? null;
      if (!igUsername) {
        try {
          const profile = await igService.getUserProfile(senderId);
          igUsername = profile?.username ?? null;
          if (igUsername) usernameCache.set(senderId, igUsername);
        } catch {
          igUsername = null;
        }
      }
      conversation = await prisma.conversation.create({
        data: { userId, igUserId: senderId, igUsername, source: 'dm' },
        include: { messages: { orderBy: { sentAt: 'desc' }, take: 10 } },
      });
    }

    if (conversation && !conversation.igUsername) {
      let igUsername: string | null = usernameCache.get(senderId) ?? null;
      if (!igUsername) {
        try {
          const profile = await igService.getUserProfile(senderId);
          igUsername = profile?.username ?? null;
          if (igUsername) usernameCache.set(senderId, igUsername);
        } catch {
          igUsername = null;
        }
      }
      if (igUsername) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { igUsername },
        });
        conversation.igUsername = igUsername;
      }
    }

    if (!conversation.automationOn) {
      logger.info('Conversation automation paused', { conversationId: conversation.id });
      return;
    }

    // Save inbound message (idempotent)
    if (messageId && !isFromComment) {
      await prisma.message.upsert({
        where: { igMessageId: messageId },
        create: {
          conversationId: conversation.id,
          igMessageId: messageId,
          direction: 'inbound',
          senderType: 'user',
          content: message,
        },
        update: {},
      });
    }

    // ─── HYBRID: Keyword first, then AI ──────────────────────────────────────
    let aiReply: string;
    const keywordResult = await findKeywordReply(userId, message, 'dm');

    if (keywordResult.reply) {
      aiReply = keywordResult.reply;
      logger.info('🔑 Keyword reply used for DM', { userId, senderId });
    } else {
      // Filter time-wasters before spending AI tokens
      const businessContext = [
        aiSettings?.businessName,
        aiSettings?.businessDescription,
        aiSettings?.productDetails,
      ].filter(Boolean).join('. ') || 'Instagram automation tool for creators';

      const { reply: shouldReplyToThis, reason } = await shouldReply(message, businessContext);

      if (!shouldReplyToThis) {
        logger.info('🚫 Message filtered — not replying', { senderId, message, reason });
        await prisma.automationLog.create({
          data: {
            userId,
            type: 'filtered',
            status: 'skipped',
            source: 'dm',
            igUserId: senderId,
            response: `Filtered: ${reason}`,
          },
        });
        return;
      }

      const { isLead } = await detectIntent(message);

      const history = conversation.messages
        .reverse()
        .slice(-6)
        .map(m => ({
          role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
          content: m.content,
        }));

      aiReply = await generateAIReply(
        {
          businessName: aiSettings?.businessName || undefined,
          businessDescription: aiSettings?.businessDescription || undefined,
          productDetails: aiSettings?.productDetails || undefined,
          targetAudience: aiSettings?.targetAudience || undefined,
          goal: aiSettings?.goal || 'engagement',
          tone: aiSettings?.tone || 'friendly',
          customInstructions: aiSettings?.customInstructions || undefined,
        },
        {
          incomingMessage: message,
          source: 'dm',
          igUsername: conversation.igUsername ?? senderId,
          conversationHistory: history,
        }
      );

      logger.info('🤖 AI reply used for DM', { userId, senderId });

      // Update lead status
      if (isLead && !conversation.isLead) {
        await prisma.lead.upsert({
          where: { conversationId: conversation.id },
          create: {
            userId,
            conversationId: conversation.id,
            igUserId: senderId,
            igUsername: conversation.igUsername ?? null,
            source: 'dm',
            status: 'new',
          },
          update: {
            igUsername: conversation.igUsername ?? null,
          },
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { isLead: true },
        });
      }
    }

    await igService.sendDM(senderId, aiReply);

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'outbound',
        senderType: 'ai',
        content: aiReply,
        deliveredAt: new Date(),
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        messageCount: { increment: 2 },
        aiMessageCount: { increment: 1 },
        lastMessageAt: new Date(),
      },
    });

    await prisma.automationLog.create({
      data: {
        userId, type: 'dm_sent', status: 'success',
        source: 'dm', igUserId: senderId,
        response: aiReply.substring(0, 200),
      },
    });

    logger.info('✅ DM automation completed', { userId, senderId });
  } catch (error: any) {
    // Don't retry Meta permission errors
    if (error.message?.includes('capability') ||
        error.message?.includes('(#3)') ||
        error.message?.includes('Advanced Access') ||
        error.message?.includes('OAuthException')) {
      logger.warn('⚠️ DM permission not approved — skipping retry', { userId });
      return;
    }
    logger.error('❌ DM automation error:', error);
    await prisma.automationLog.create({
      data: {
        userId, type: 'error', status: 'failed',
        source: 'dm', igUserId: job.data.senderId,
        error: error.message,
      },
    });
    throw error;
  }
});
That's the only change needed in that file. Deploy and the error spam will stop.

// ─── Process Comment ──────────────────────────────────────────────────────────
automationQueue.process('process-comment', 3, async (job) => {
  const { userId, igAccountId, commentId, commentText, senderId, senderName, mediaId } = job.data;

  logger.info('Processing comment automation', { userId, commentId });

  try {
    // ─── Subscription check ───────────────────────────────────────────────
    const subscribed = await hasActiveSubscription(userId);
    if (!subscribed) {
      logger.info('⛔ Subscription expired — skipping comment automation', { userId });
      return;
    }

    const [igAccount, aiSettings] = await Promise.all([
      prisma.instagramAccount.findUnique({ where: { userId } }),
      prisma.aISettings.findUnique({ where: { userId } }),
    ]);

    if (!igAccount?.accessToken || !igAccount.automationOn) return;
    if (!aiSettings?.replyToComments) return;

    if (!checkRateLimit(userId, 'reply', aiSettings?.maxRepliesPerHour || 30)) {
      return;
    }

    if (senderId === igAccount.igUserId) return;

    const token = igAccount.pageToken
      ? decrypt(igAccount.pageToken)
      : decrypt(igAccount.accessToken);

    const igService = new InstagramService(token, igAccount.igUserId, igAccount.pageId);

    // ─── HYBRID: Keyword first, then AI ──────────────────────────────────────
    let reply: string;
    const keywordResult = await findKeywordReply(userId, commentText, 'comment', mediaId);

    if (keywordResult.reply) {
      reply = keywordResult.reply;
      logger.info('🔑 Keyword reply used for comment', { userId, mediaId });

      // Auto DM if configured
      if (keywordResult.autoDM && keywordResult.dmReply && senderId) {
        await automationQueue.add('process-keyword-dm', {
          userId,
          igAccountId,
          senderId,
          message: keywordResult.dmReply,
        }, { delay: 5000 });
        logger.info('📩 Auto DM queued from keyword rule', { userId, senderId });
      }

    } else {
      reply = await generateCommentReply(
        {
          businessName: aiSettings.businessName || undefined,
          businessDescription: aiSettings.businessDescription || undefined,
          productDetails: aiSettings.productDetails || undefined,
          targetAudience: aiSettings.targetAudience || undefined,
          goal: aiSettings.goal,
          tone: aiSettings.tone,
          customInstructions: aiSettings.customInstructions || undefined,
        },
        commentText,
        senderName || null,
      );
      logger.info('🤖 AI reply used for comment', { userId });
    }

    await igService.replyToComment(commentId, reply);

    await prisma.automationLog.create({
      data: {
        userId, type: 'ai_reply', status: 'success',
        source: 'comment', igUserId: senderId,
        messageId: commentId, response: reply.substring(0, 200),
      },
    });

    // Auto DM from AI settings (existing feature)
    if (aiSettings.autoSendDMs && !keywordResult.reply) {
      await automationQueue.add('process-dm', {
        userId, senderId,
        message: `${senderName || 'Someone'} commented: "${commentText}"`,
        messageId: `comment_${commentId}`,
        isFromComment: true,
      }, { delay: 30000 });
    }

    logger.info('✅ Comment automation completed', { userId, commentId });
  } catch (error: any) {
    logger.error('❌ Comment automation error:', error);
    await prisma.automationLog.create({
      data: {
        userId, type: 'error', status: 'failed',
        source: 'comment', error: error.message,
      },
    });
    throw error;
  }
});

// ─── Process Keyword DM ───────────────────────────────────────────────────────
automationQueue.process('process-keyword-dm', 5, async (job) => {
  const { userId, senderId, message } = job.data;

  try {
    // ─── Subscription check ───────────────────────────────────────────────
    const subscribed = await hasActiveSubscription(userId);
    if (!subscribed) {
      logger.info('⛔ Subscription expired — skipping keyword DM', { userId });
      return;
    }

    const igAccount = await prisma.instagramAccount.findUnique({
      where: { userId },
    });

    if (!igAccount?.accessToken) return;

    const token = igAccount.pageToken
      ? decrypt(igAccount.pageToken)
      : decrypt(igAccount.accessToken);

    const igService = new InstagramService(token, igAccount.igUserId, igAccount.pageId);
    await igService.sendDM(senderId, message);

    await prisma.automationLog.create({
      data: {
        userId,
        type: 'dm_sent',
        status: 'success',
        source: 'keyword',
        igUserId: senderId,
        response: message.substring(0, 200),
      },
    });

    logger.info('✅ Keyword DM sent', { userId, senderId });
  } catch (error: any) {
    logger.error('❌ Keyword DM error:', error);
    throw error;
  }
});

// Queue events
automationQueue.on('failed', (job, err) => {
  logger.error(`❌ Job ${job.id} failed:`, err.message);
});

automationQueue.on('completed', (job) => {
  logger.info(`✅ Job ${job.id} completed`);
});

export default automationQueue;
