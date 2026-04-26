import Bull from 'bull';
import { prisma } from '../utils/prisma';
import { InstagramService } from '../services/instagram';
import { generateAIReply, generateCommentReply, detectIntent } from '../services/openai';
import { decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

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

// Rate limiter state (in-memory; use Redis in production cluster)
const rateLimiter: Map<string, { count: number; windowStart: number }> = new Map();

function checkRateLimit(userId: string, type: 'dm' | 'reply', maxPerHour: number): boolean {
  const key = `${userId}:${type}`;
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour

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

// ─── Process DM ───────────────────────────────────────────────────────────────
automationQueue.process('process-dm', 5, async (job) => {
  const { userId, senderId, message, messageId } = job.data;

  logger.info('Processing DM automation', { userId, senderId });

  try {
    // Get user's IG account and AI settings
    const [igAccount] = await Promise.all([
  prisma.instagramAccount.findUnique({ where: { id: igAccountId } }),
    ]);

    if (!igAccount?.accessToken || !igAccount.automationOn) {
      logger.info('Automation off or no account', { userId });
      return;
    }

    // Rate limiting
    if (!checkRateLimit(userId, 'dm', aiSettings?.maxDMsPerHour || 20)) {
      await prisma.automationLog.create({
        data: { userId, type: 'rate_limit', status: 'failed', source: 'dm', igUserId: senderId },
      });
      return;
    }

    // Skip own messages
    if (senderId === igAccount.igUserId) return;

    const token = decrypt(igAccount.accessToken);
    const igService = new InstagramService(token, igAccount.igUserId);

    // Get or create conversation
    let conversation = await prisma.conversation.findFirst({
      where: { userId, igUserId: senderId },
      include: { messages: { orderBy: { sentAt: 'desc' }, take: 10 } },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { userId, igUserId: senderId, source: 'dm' },
        include: { messages: { orderBy: { sentAt: 'desc' }, take: 10 } },
      });
    }

    if (!conversation.automationOn) {
      logger.info('Conversation automation paused', { conversationId: conversation.id });
      return;
    }

    // Store incoming message
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        igMessageId: messageId,
        direction: 'inbound',
        senderType: 'user',
        content: message,
      },
    });

    // Detect intent
    const { isLead } = await detectIntent(message);

    // Build conversation history for AI context
    const history = conversation.messages
      .reverse()
      .slice(-6)
      .map(m => ({
        role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      }));

    // Generate AI reply
    const aiReply = await generateAIReply(
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
        igUsername: senderId,
        conversationHistory: history,
      }
    );

    // Send DM via Instagram
    await igService.sendDM(senderId, aiReply);

    // Store outbound message
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'outbound',
        senderType: 'ai',
        content: aiReply,
        deliveredAt: new Date(),
      },
    });

    // Update conversation stats
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        messageCount: { increment: 2 },
        aiMessageCount: { increment: 1 },
        lastMessageAt: new Date(),
        isLead: isLead || conversation.isLead,
      },
    });

    // Create lead if detected
    if (isLead && !conversation.isLead) {
      await prisma.lead.upsert({
        where: { conversationId: conversation.id },
        create: {
          userId,
          conversationId: conversation.id,
          igUserId: senderId,
          source: 'dm',
          status: 'new',
        },
        update: {},
      });
    }

    await prisma.automationLog.create({
      data: {
        userId, type: 'dm_sent', status: 'success',
        source: 'dm', igUserId: senderId,
        response: aiReply.substring(0, 200),
      },
    });

    logger.info('DM automation completed', { userId, senderId });
  } catch (error: any) {
    logger.error('DM automation error:', error);
    await prisma.automationLog.create({
      data: {
        userId, type: 'error', status: 'failed',
        source: 'dm', igUserId: job.data.senderId,
        error: error.message,
      },
    });
    throw error; // Triggers retry
  }
});

// ─── Process Comment ──────────────────────────────────────────────────────────
automationQueue.process('process-comment', 3, async (job) => {
  const { userId, commentId, commentText, senderId, senderName, mediaId } = job.data;

  logger.info('Processing comment automation', { userId, commentId });

  try {
    const [igAccount, aiSettings] = await Promise.all([
      prisma.instagramAccount.findUnique({ where: { userId } }),
      prisma.aISettings.findUnique({ where: { userId } }),
    ]);

    if (!igAccount?.accessToken || !igAccount.automationOn) return;
    if (!aiSettings?.replyToComments) return;

    if (!checkRateLimit(userId, 'reply', aiSettings?.maxRepliesPerHour || 30)) {
      return;
    }

    // Skip own comments
    if (senderId === igAccount.igUserId) return;

    const token = decrypt(igAccount.accessToken);
    const igService = new InstagramService(token, igAccount.igUserId);

    const reply = await generateCommentReply(
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
      senderName || senderId,
    );

    await igService.replyToComment(commentId, reply);

    await prisma.automationLog.create({
      data: {
        userId, type: 'ai_reply', status: 'success',
        source: 'comment', igUserId: senderId,
        messageId: commentId, response: reply.substring(0, 200),
      },
    });

    // If user also wants to send follow-up DM
    if (aiSettings.autoSendDMs) {
      await automationQueue.add('process-dm', {
        userId, senderId,
        message: `${senderName || 'Someone'} commented: "${commentText}"`,
        messageId: `comment_${commentId}`,
        isFromComment: true,
      }, { delay: 30000 }); // 30s delay after comment reply
    }

    logger.info('Comment automation completed', { userId, commentId });
  } catch (error: any) {
    logger.error('Comment automation error:', error);
    await prisma.automationLog.create({
      data: {
        userId, type: 'error', status: 'failed',
        source: 'comment', error: error.message,
      },
    });
    throw error;
  }
});

// Queue events
automationQueue.on('failed', (job, err) => {
  logger.error(`Job ${job.id} failed:`, err.message);
});

automationQueue.on('completed', (job) => {
  logger.debug(`Job ${job.id} completed`);
});

export default automationQueue;
