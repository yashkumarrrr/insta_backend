import OpenAI from 'openai';
import { logger } from '../utils/logger';

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

export interface AIReplyContext {
  businessName?: string;
  businessDescription?: string;
  productDetails?: string;
  targetAudience?: string;
  goal: string;
  tone: string;
  customInstructions?: string;
}

export interface MessageContext {
  incomingMessage: string;
  source: 'dm' | 'comment';
  igUsername: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

const TONE_GUIDES: Record<string, string> = {
  friendly: 'warm, casual, and approachable. Use conversational language, occasional emojis (not excessive). Feel like a helpful friend.',
  professional: 'polished, respectful, and business-like. Clear and confident without being cold. No slang.',
  aggressive: 'direct, bold, and action-oriented. Create urgency. No fluff. Short punchy messages.',
  luxury: 'sophisticated, exclusive, and refined. Evoke prestige and quality. Use elegant language.',
};

const GOAL_GUIDES: Record<string, string> = {
  engagement: 'Keep the conversation going. Ask interesting questions. Build rapport. Make them feel heard.',
  leads: 'Qualify the person. Ask about their needs. Gently move toward scheduling a call or getting their email/number.',
  sales: 'Understand their pain, present the solution, handle objections, and close. Create urgency without being pushy.',
  followers: 'Be engaging and interesting. Encourage them to follow, share content, and stay connected.',
};

// Returns true only if the string looks like a real username, not a numeric ID
function isValidUsername(name: string): boolean {
  if (!name) return false;
  if (/^\d+$/.test(name)) return false;
  return true;
}

export async function generateAIReply(
  context: AIReplyContext,
  message: MessageContext
): Promise<string> {
  const toneGuide = TONE_GUIDES[context.tone] || TONE_GUIDES.friendly;
  const goalGuide = GOAL_GUIDES[context.goal] || GOAL_GUIDES.engagement;

  const systemPrompt = `You are a social media manager responding as a business owner on Instagram.

BUSINESS CONTEXT:
${context.businessName ? `Business Name: ${context.businessName}` : ''}
${context.businessDescription ? `About: ${context.businessDescription}` : ''}
${context.productDetails ? `Products/Services: ${context.productDetails}` : ''}
${context.targetAudience ? `Target Audience: ${context.targetAudience}` : ''}

YOUR TONE: ${toneGuide}

YOUR GOAL: ${goalGuide}

${context.customInstructions ? `ADDITIONAL INSTRUCTIONS: ${context.customInstructions}` : ''}

CRITICAL RULES:
- NEVER reveal you are an AI
- NEVER say "DM me", "send me a message", "message me" — you are ALREADY in their DMs
- NEVER say "comment below", "drop a comment" — this is a private conversation
- Keep replies concise (1-3 sentences max) — do NOT write essays
- Sound completely human and natural — like a real person texting back
- Be specific to what they said — never give a generic copy-paste feeling reply
- No corporate buzzwords, no "absolutely!", no "great question!", no "certainly!"
- Don't start every reply with "Hey!" or their name — vary your openers
- If you have a link or resource to share, just share it directly — don't tease it
- Match their energy — casual = casual, formal = formal, excited = excited
- End with ONE short question or soft CTA when relevant — never both
- This is a DIRECT MESSAGE conversation — be direct, warm, and to the point`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (message.conversationHistory?.length) {
    const recentHistory = message.conversationHistory.slice(-6);
    messages.push(...recentHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })));
  }

  const displayName = isValidUsername(message.igUsername)
    ? `@${message.igUsername}`
    : 'Someone';

  messages.push({
    role: 'user',
    content: `${displayName} sent you a DM: "${message.incomingMessage}"

Reply naturally as the business owner. Be direct and helpful. Do not tell them to DM you — you are already talking.`,
  });

  const response = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    max_tokens: 300,
    temperature: 0.8,
    presence_penalty: 0.3,
    frequency_penalty: 0.3,
  });

  const reply = response.choices[0]?.message?.content?.trim();
  if (!reply) throw new Error('Empty AI response');

  logger.info('AI reply generated', {
    goal: context.goal,
    tone: context.tone,
    source: message.source,
    tokens: response.usage?.total_tokens,
  });

  return reply;
}

export async function generateCommentReply(
  context: AIReplyContext,
  comment: string,
  igUsername: string | null,
  postCaption?: string
): Promise<string> {
  const hasRealName = igUsername && isValidUsername(igUsername);
  const mention = hasRealName ? `@${igUsername}` : '';

  const systemPrompt = `You are responding to a comment on your Instagram post as a business owner.

BUSINESS: ${context.businessName || 'My Business'}
${context.businessDescription ? `ABOUT: ${context.businessDescription}` : ''}
TONE: ${TONE_GUIDES[context.tone] || TONE_GUIDES.friendly}
GOAL: ${GOAL_GUIDES[context.goal] || GOAL_GUIDES.engagement}

Rules:
- Reply to comments publicly (these are visible to everyone)
- Be concise (1-2 sentences max)
- Sound human and natural
${hasRealName ? `- You may address them as ${mention} if it feels natural` : '- Do not address by name — their username is not available'}
- Encourage further engagement
- NEVER reveal you are AI`;

  const userPrompt = postCaption
    ? `Post caption: "${postCaption}"\n\n${hasRealName ? mention : 'Someone'} commented: "${comment}"`
    : `${hasRealName ? mention : 'Someone'} commented: "${comment}"`;

  const response = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 150,
    temperature: 0.8,
  });

  const reply = response.choices[0]?.message?.content?.trim();
  if (!reply) throw new Error('Empty AI response');
  return reply;
}

export async function detectIntent(message: string): Promise<{
  intent: 'purchase' | 'inquiry' | 'complaint' | 'compliment' | 'spam' | 'other';
  isLead: boolean;
  sentiment: 'positive' | 'neutral' | 'negative';
}> {
  const response = await openai.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: 'Analyze the intent of this Instagram message. Return JSON only.',
      },
      {
        role: 'user',
        content: `Message: "${message}"\n\nReturn: {"intent": "purchase|inquiry|complaint|compliment|spam|other", "isLead": true/false, "sentiment": "positive|neutral|negative"}`,
      },
    ],
    max_tokens: 100,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  try {
    return JSON.parse(response.choices[0]?.message?.content || '{}');
  } catch {
    return { intent: 'other', isLead: false, sentiment: 'neutral' };
  }
}

export async function shouldReply(
  message: string,
  businessContext: string
): Promise<{ reply: boolean; reason: string }> {
  const response = await openai.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `You are a smart filter for a business's Instagram DMs.
Decide if this message deserves a real reply or should be ignored.

Business context: ${businessContext}

Ignore if the message is:
- Spam or mass promotion ("follow me", "check my page", "collab?", random emojis only)
- Completely irrelevant to the business
- Just a greeting with zero intent ("hi", "hello", "hey", "sup" with nothing else)
- A bot or fake account message
- Abusive, rude, or trolling
- A simple reaction like "thanks", "ok", "👍" with no question

Reply if the message:
- Shows genuine interest in the product or service
- Has a real question worth answering
- Shows buying intent
- Is a complaint that needs handling
- Is a lead worth nurturing
- Contains any actual content beyond a single word greeting

When in doubt, reply — it is better to reply than to ignore a real person.

Return JSON only: {"reply": true/false, "reason": "one line explanation"}`,
      },
      {
        role: 'user',
        content: `Message: "${message}"`,
      },
    ],
    max_tokens: 80,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  try {
    return JSON.parse(response.choices[0]?.message?.content || '{}');
  } catch {
    return { reply: true, reason: 'parse error — defaulting to reply' };
  }
}
