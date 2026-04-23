import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { decrypt } from '../utils/encryption';
import { automationQueue } from '../workers/automationQueue';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// ─── GET /api/webhook/instagram — Verify webhook ──────────────────────────────
router.get('/instagram', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    logger.info('Instagram webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
});

// ─── POST /api/webhook/instagram — Receive events ────────────────────────────
router.post('/instagram', async (req: Request, res: Response) => {
  // Respond immediately to Meta
  res.status(200).json({ status: 'ok' });

  const body = req.body;
  if (body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;

    // Find the user with this Instagram page
    const igAccount = await prisma.instagramAccount.findFirst({
      where: { pageId, automationOn: true, isActive: true },
      include: { user: { include: { aiSettings: true } } },
    });

    if (!igAccount) continue;

    // Handle DMs
    for (const messaging of entry.messaging || []) {
      if (messaging.message && !messaging.message.is_echo) {
        await automationQueue.add('process-dm', {
          userId: igAccount.userId,
          igAccountId: igAccount.id,
          senderId: messaging.sender.id,
          message: messaging.message.text || '',
          messageId: messaging.message.mid,
          timestamp: messaging.timestamp,
        });
      }
    }

    // Handle Comments
    for (const change of entry.changes || []) {
      if (change.field === 'comments' && change.value?.verb === 'add') {
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
      }
    }
  }
});

// ─── POST /api/webhook/stripe ─────────────────────────────────────────────────
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

  logger.info('Stripe event received:', event.type);

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
        if (!user) break;

        await prisma.user.update({
          where: { id: user.id },
          data: {
            stripeSubId: sub.id,
            subStatus: sub.status,
          },
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: sub.customer as string },
        });
        if (!user) break;

        await prisma.user.update({
          where: { id: user.id },
          data: { subStatus: 'canceled', subPlan: 'free' },
        });

        // Turn off automation
        await prisma.instagramAccount.updateMany({
          where: { userId: user.id },
          data: { automationOn: false },
        });
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

    // Log billing event
    const userId = await getUserIdFromStripeEvent(event);
    if (userId) {
      await prisma.billingEvent.create({
        data: {
          userId,
          stripeEventId: event.id,
          type: event.type,
          status: 'processed',
          metadata: event.data.object as any,
        },
      });
    }
  } catch (err) {
    logger.error('Error processing Stripe event:', err);
  }

  res.json({ received: true });
});

async function getUserIdFromStripeEvent(event: Stripe.Event): Promise<string | null> {
  const obj = event.data.object as any;
  const customerId = obj.customer;
  if (!customerId) return null;

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  return user?.id || null;
}

export default router;
