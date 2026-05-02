import { prisma } from './prisma';

export interface KeywordMatchResult {
  reply: string | null;
  dmReply: string | null;
  autoDM: boolean;
}

export async function findKeywordReply(
  userId: string,
  message: string,
  source: 'dm' | 'comment',
  mediaId?: string
): Promise<KeywordMatchResult> {

  const rules = await prisma.keywordRule.findMany({
    where: {
      userId,
      isActive: true,
      source: { in: [source, 'both'] },
    },
  });

  const lowerMessage = message.toLowerCase().trim();

  // Post-specific rules first, then global
  const postSpecificRules = rules.filter(r => r.mediaId === mediaId);
  const globalRules = rules.filter(r => !r.mediaId);
  const orderedRules = [...postSpecificRules, ...globalRules];

  for (const rule of orderedRules) {
    const keyword = rule.keyword.toLowerCase().trim();

    const matched =
      rule.matchType === 'exact'
        ? lowerMessage === keyword
        : rule.matchType === 'startsWith'
        ? lowerMessage.startsWith(keyword)
        : lowerMessage.includes(keyword);

    if (matched) {
      return {
        reply: rule.replyText,
        dmReply: rule.dmReplyText || null,
        autoDM: rule.autoDM,
      };
    }
  }

  return { reply: null, dmReply: null, autoDM: false };
}
