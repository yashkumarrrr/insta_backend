import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { automationQueue } from '../workers/automationQueue';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ─────────────────────────────────────────────
// ✅ INSTAGRAM WEBHOOK VERIFY (GET)
// ─────────────────────────────────────────────
router.get('/instagram', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    token === process.env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    logger.info('✅ Instagram webhook verified');
    return res.status(200).send(challenge);
  }

  logger.warn('❌ Instagram webhook verification failed');
  return res.status(403).json({ error: 'Forbidden' });
});

// ─────────────────────────────────────────────
// ✅ INSTAGRAM WEBHOOK EVENTS (POST)
// ─────────────────────────────────────────────
router.post('/instagram', async (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;

    if (!body || body.object !== 'instagram') {
      return;
    }

    for (const entry of body.entry || []) {
      const igId = entry.id;

      logger.info(`🔥 Instagram webhook IG ID: ${igId}`);

      const igAccount = await prisma.instagramAccount.findFirst({
        where: {
          igUserId: igId,
          automationOn: true,
          isActive: true,
        },
        include: {
          user: {
            include: {
              aiSettings: true,
            },
          },
        },
      });

      if (!igAccount) {
        logger.warn(`❌ No IG account matched for ID: ${igId}`);
        continue;
      }

      logger.info(`✅ IG account found: ${igAccount.id}`);
      logger.info(`📦 Raw entry: ${JSON.stringify(entry).substring(0, 800)}`);

      // ADD THESE 4 LINES:
      logger.info(`📋 Changes count: ${entry.changes?.length || 0}`);
      logger.info(`📋 Messaging count: ${entry.messaging?.length || 0}`);
      for (const change of entry.changes || []) {
       logger.info(`📋 Change field: "${change.field}", verb: "${change.value?.verb}"`);
      }

      if (!igAccount.webhookVerified) {
        await prisma.instagramAccount.update({
          where: { id: igAccount.id },
          data: { webhookVerified: true },
        });
      }

      // ─────────────────────────────
      // 📩 MESSAGES (DM)
      // ─────────────────────────────
      for (const messaging of entry.messaging || []) {
        // Skip edits, reads, reactions — only process new messages
        if (messaging.message_edit) continue;
        if (messaging.read) continue;
        if (messaging.reaction) continue;

        if (messaging.message && !messaging.message.is_echo) {
          await automationQueue.add('process-dm', {
            userId: igAccount.userId,
            igAccountId: igAccount.id,
            senderId: messaging.sender.id,
            message: messaging.message.text || '',
            messageId: messaging.message.mid,
            timestamp: messaging.timestamp,
          });

          logger.info(`📩 DM queued for user ${igAccount.userId}`);
        }
      }

      // ─────────────────────────────
      // 💬 COMMENTS
      // ─────────────────────────────
      for (const change of entry.changes || []) {
        if (
           change.field === 'comments' || change.field === 'feed'
        ) {
          await automationQueue.add('process-comment', {
            userId: igAccount.userId,
            igAccountId: igAccount.id,
            commentId: change.value.id,
            commentText: change.value.text,
            senderId: change.value.from?.id,
            senderName: change.value.from?.name,
            mediaId: change.value.media?.id,
            timestamp: change.value.created_time,
          });

          logger.info(`💬 Comment queued for user ${igAccount.userId}`);
        }
      }
    }
  } catch (err) {
    logger.error('❌ Instagram webhook error:', err);
  }
});

// ─────────────────────────────────────────────
// 💳 STRIPE WEBHOOK
// ─────────────────────────────────────────────
router.post('/stripe', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    logger.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.info(`💳 Stripe event: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        if (!userId) break;

        await prisma.user.update({
          where: { id: userId },
          data: {
            stripeCustomerId: session.customer as string,
            stripeSubId: session.subscription as string,
            subStatus: 'active',
            subPlan: 'pro',
            isTrialActive: false,
          },
        });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: sub.customer as string },
        });

        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: {
              stripeSubId: sub.id,
              subStatus: sub.status,
            },
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: sub.customer as string },
        });

        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: {
              subStatus: 'canceled',
              subPlan: 'free',
            },
          });

          await prisma.instagramAccount.updateMany({
            where: { userId: user.id },
            data: { automationOn: false },
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: invoice.customer as string },
        });

        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { subStatus: 'past_due' },
          });
        }
        break;
      }
    }
  } catch (err) {
    logger.error('Stripe processing error:', err);
  }

  res.json({ received: true });
});

export default router;
