import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = `"InstaClient AI" <${process.env.SMTP_USER || 'noreply@instaclientai.com'}>`;

export const emailService = {
  async sendWelcome(email: string, name: string) {
    try {
      await transporter.sendMail({
        from: FROM,
        to: email,
        subject: '🚀 Welcome to InstaClient AI – Your 3-day trial has started!',
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="color: #111; font-size: 28px; margin-bottom: 8px;">Welcome, ${name}! 👋</h1>
            <p style="color: #555; font-size: 16px; line-height: 1.6;">
              Your 3-day free trial of InstaClient AI has started. Connect your Instagram account and let AI handle your DMs and comments.
            </p>
            <a href="${process.env.FRONTEND_URL}/dashboard" 
               style="display: inline-block; background: #111; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 24px;">
              Go to Dashboard →
            </a>
            <p style="color: #999; font-size: 14px; margin-top: 40px;">
              InstaClient AI — Automate your Instagram growth with AI
            </p>
          </div>
        `,
      });
    } catch (error) {
      logger.error('Failed to send welcome email:', error);
    }
  },

  async sendPasswordReset(email: string, resetUrl: string) {
    try {
      await transporter.sendMail({
        from: FROM,
        to: email,
        subject: 'Reset your InstaClient AI password',
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="color: #111; font-size: 24px;">Reset your password</h1>
            <p style="color: #555; font-size: 16px; line-height: 1.6;">
              Click the button below to reset your password. This link expires in 1 hour.
            </p>
            <a href="${resetUrl}" 
               style="display: inline-block; background: #111; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 24px;">
              Reset Password
            </a>
            <p style="color: #999; font-size: 14px; margin-top: 40px;">
              If you didn't request this, ignore this email.
            </p>
          </div>
        `,
      });
    } catch (error) {
      logger.error('Failed to send reset email:', error);
    }
  },

  async sendTrialExpiring(email: string, name: string) {
    try {
      await transporter.sendMail({
        from: FROM,
        to: email,
        subject: '⏰ Your InstaClient AI trial expires tomorrow',
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="color: #111; font-size: 24px;">Your trial ends tomorrow, ${name}</h1>
            <p style="color: #555; font-size: 16px; line-height: 1.6;">
              Don't lose your AI automation. Upgrade now for just $10/month and keep growing on autopilot.
            </p>
            <a href="${process.env.FRONTEND_URL}/dashboard/billing" 
               style="display: inline-block; background: #111; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 24px;">
              Upgrade Now →
            </a>
          </div>
        `,
      });
    } catch (error) {
      logger.error('Failed to send trial expiry email:', error);
    }
  },
};
