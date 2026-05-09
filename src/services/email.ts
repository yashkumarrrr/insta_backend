import { logger } from '../utils/logger';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.SMTP_USER
  ? `"RepliVa" <${process.env.SMTP_USER}>`
  : '"RepliVa" <noreply@step2dev.com>';

async function sendViaResend(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    logger.warn('RESEND_API_KEY not set — skipping email');
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });

    if (!res.ok) {
      const err = await res.json();
      logger.error('Resend API error:', err);
      return false;
    }

    logger.info(`✅ Email sent to ${to}: ${subject}`);
    return true;
  } catch (error) {
    logger.error('Failed to send email via Resend:', error);
    return false;
  }
}

// ─── Shared email wrapper styles ──────────────────────────────────────────────
const emailWrapper = (content: string) => `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background: #ffffff;">
    <div style="margin-bottom: 32px;">
      <span style="font-size: 24px; font-weight: 800; background: linear-gradient(135deg, #8B5CF6, #EC4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">RepliVa</span>
    </div>
    ${content}
    <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />
    <p style="color: #999; font-size: 13px; margin: 0;">RepliVa — AI-powered Instagram automation for creators<br/>
      <a href="${process.env.FRONTEND_URL}" style="color: #8B5CF6;">step2dev.com</a>
    </p>
  </div>
`;

const primaryBtn = (url: string, label: string) =>
  `<a href="${url}" style="display: inline-block; background: linear-gradient(135deg, #8B5CF6, #EC4899); color: #fff; padding: 14px 32px; border-radius: 100px; text-decoration: none; font-weight: 700; font-size: 15px; margin-bottom: 32px;">${label}</a>`;

export const emailService = {

  // ─── Welcome ───────────────────────────────────────────────────────────────
  async sendWelcome(email: string, name: string) {
    await sendViaResend(
      email,
      '🚀 Welcome to RepliVa – Your 7-day trial has started!',
      emailWrapper(`
        <h1 style="color: #111; font-size: 28px; font-weight: 700; margin-bottom: 8px; line-height: 1.2;">Welcome, ${name}! 👋</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          Your 7-day free trial of RepliVa has started. Connect your Instagram account and let AI handle your DMs and comments automatically — 24/7.
        </p>
        <div style="background: #f8f7ff; border: 1px solid #e5e0ff; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
          <p style="color: #6d28d9; font-size: 14px; font-weight: 600; margin: 0 0 12px;">Get started in 3 steps:</p>
          <p style="margin: 0; font-size: 14px; color: #444;">1️⃣ Connect your Instagram Business account</p>
          <p style="margin: 0; font-size: 14px; color: #444;">2️⃣ Set up your AI tone and business info</p>
          <p style="margin: 0; font-size: 14px; color: #444;">3️⃣ Turn on automation and watch it work</p>
        </div>
        ${primaryBtn(`${process.env.FRONTEND_URL}/dashboard`, 'Go to Dashboard →')}
      `)
    );
  },

  // ─── Password Reset ────────────────────────────────────────────────────────
  async sendPasswordReset(email: string, resetUrl: string) {
    await sendViaResend(
      email,
      'Reset your RepliVa password',
      emailWrapper(`
        <h1 style="color: #111; font-size: 24px; font-weight: 700; margin-bottom: 8px;">Reset your password</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          We received a request to reset your password. Click the button below — this link expires in 1 hour.
        </p>
        ${primaryBtn(resetUrl, 'Reset Password →')}
        <p style="color: #999; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
      `)
    );
  },

  // ─── Trial Expiring ────────────────────────────────────────────────────────
  async sendTrialExpiring(email: string, name: string) {
    await sendViaResend(
      email,
      '⏰ Your RepliVa trial expires tomorrow',
      emailWrapper(`
        <h1 style="color: #111; font-size: 24px; font-weight: 700; margin-bottom: 8px;">Your trial ends tomorrow, ${name} ⏰</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          Don't lose your AI automation. Upgrade now and keep growing on autopilot.
        </p>
        <div style="background: #fdf4ff; border: 1px solid #e9d5ff; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
          <p style="color: #7c3aed; font-size: 15px; font-weight: 700; margin: 0 0 8px;">What you'll keep with Pro:</p>
          <p style="margin: 4px 0; font-size: 14px; color: #444;">✅ Unlimited AI DM replies</p>
          <p style="margin: 4px 0; font-size: 14px; color: #444;">✅ Unlimited comment replies</p>
          <p style="margin: 4px 0; font-size: 14px; color: #444;">✅ Lead detection & CRM</p>
          <p style="margin: 4px 0; font-size: 14px; color: #444;">✅ Keyword automation</p>
          <p style="margin: 4px 0; font-size: 14px; color: #444;">✅ 24/7 automation</p>
        </div>
        ${primaryBtn(`${process.env.FRONTEND_URL}/dashboard/billing`, 'Upgrade Now →')}
      `)
    );
  },

  // ─── Trial Expired ─────────────────────────────────────────────────────────
  async sendTrialExpired(email: string, name: string) {
    await sendViaResend(
      email,
      '🔴 Your RepliVa trial has ended',
      emailWrapper(`
        <h1 style="color: #111; font-size: 24px; font-weight: 700; margin-bottom: 8px;">Your trial has ended, ${name}</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          Your AI automation has been paused. Upgrade to Pro to restore it instantly — all your data is still saved.
        </p>
        ${primaryBtn(`${process.env.FRONTEND_URL}/dashboard/billing`, 'Reactivate Now →')}
      `)
    );
  },

  // ─── Subscription Confirmed ────────────────────────────────────────────────
  async sendSubscriptionConfirmed(email: string, name: string) {
    await sendViaResend(
      email,
      '🎉 You\'re now on RepliVa Pro!',
      emailWrapper(`
        <h1 style="color: #111; font-size: 24px; font-weight: 700; margin-bottom: 8px;">Welcome to Pro, ${name}! 🎉</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          Your subscription is active. Your AI automation is running 24/7 and every DM and comment will be replied to automatically.
        </p>
        ${primaryBtn(`${process.env.FRONTEND_URL}/dashboard`, 'Go to Dashboard →')}
      `)
    );
  },

  // ─── Referral Invite (sent to friend) ─────────────────────────────────────
  async sendReferralInvite(toEmail: string, referrerName: string, referralLink: string) {
    await sendViaResend(
      toEmail,
      `${referrerName} invited you to try RepliVa 🎁`,
      emailWrapper(`
        <h1 style="color: #111; font-size: 26px; font-weight: 700; margin-bottom: 8px;">
          You've been invited! 🎉
        </h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 8px;">
          <strong>${referrerName}</strong> thinks you'd love RepliVa — the AI tool that automates your Instagram DMs and comments 24/7.
        </p>
        <div style="background: #f8f7ff; border: 1px solid #e5e0ff; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
          <p style="color: #6d28d9; font-size: 15px; font-weight: 700; margin: 0 0 10px;">🎁 Your referral bonus:</p>
          <p style="margin: 0; font-size: 15px; color: #444; font-weight: 600;">Get <strong>+7 extra days free trial</strong> when you sign up with this link</p>
          <p style="margin: 6px 0 0; font-size: 13px; color: #888;">No credit card required</p>
        </div>
        ${primaryBtn(referralLink, 'Claim Your Free Trial →')}
        <p style="color: #999; font-size: 13px;">This invite link is personal and expires when used.</p>
      `)
    );
  },

  // ─── Referral Pending (notify referrer someone signed up) ─────────────────
  async sendReferralPending(toEmail: string, name: string) {
    await sendViaResend(
      toEmail,
      '🎯 Someone signed up using your referral link!',
      emailWrapper(`
        <h1 style="color: #111; font-size: 24px; font-weight: 700; margin-bottom: 8px;">
          Nice one, ${name}! 🎯
        </h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          Someone just signed up using your referral link. When they subscribe to RepliVa Pro, you'll automatically receive <strong>+7 free days</strong> added to your account.
        </p>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; margin-bottom: 28px;">
          <p style="color: #166534; font-size: 14px; font-weight: 600; margin: 0 0 8px;">Your referral reward:</p>
          <p style="margin: 0; font-size: 15px; color: #444;">⏳ Status: <strong>Pending</strong> (waiting for them to subscribe)</p>
          <p style="margin: 8px 0 0; font-size: 14px; color: #444;">🎁 Reward: <strong>+7 free days</strong> when they go Pro</p>
        </div>
        <p style="color: #555; font-size: 15px; line-height: 1.6; margin-bottom: 24px;">
          Keep sharing your link to earn more free days!
        </p>
        ${primaryBtn(`${process.env.FRONTEND_URL}/dashboard/referral`, 'View Your Referrals →')}
      `)
    );
  },

  // ─── Referral Converted (referrer gets reward) ────────────────────────────
  async sendReferralConverted(toEmail: string, name: string, bonusDays: number) {
    await sendViaResend(
      toEmail,
      `🎉 You earned +${bonusDays} free days from your referral!`,
      emailWrapper(`
        <h1 style="color: #111; font-size: 26px; font-weight: 700; margin-bottom: 8px;">
          You earned your reward, ${name}! 🎉
        </h1>
        <p style="color: #555; font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
          One of your referred friends just subscribed to RepliVa Pro. Your reward has been applied automatically!
        </p>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 24px; margin-bottom: 28px; text-align: center;">
          <p style="color: #166534; font-size: 14px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .05em;">Reward Applied</p>
          <p style="color: #111; font-size: 42px; font-weight: 900; margin: 0; line-height: 1;">+${bonusDays} Days</p>
          <p style="color: #555; font-size: 14px; margin: 8px 0 0;">Added to your RepliVa account</p>
        </div>
        <p style="color: #555; font-size: 15px; line-height: 1.6; margin-bottom: 24px;">
          Keep referring and keep earning — every friend who subscribes = more free days for you. 🚀
        </p>
        ${primaryBtn(`${process.env.FRONTEND_URL}/dashboard/referral`, 'View Your Referrals →')}
      `)
    );
  },
};
