/**
 * Invite SMS / share-sheet copy. iOS Messages puts a standalone `url` field
 * first (rich preview, then the text). Fold the link into `text` so the
 * ask comes first on the web share sheet.
 */

export const INVITE_SHARE_TITLE = 'Poker Party!';
export const INVITE_SHARE_LEAD = "Join my dealer's choice table:";

export function inviteShareText(url: string): string {
  return `${INVITE_SHARE_LEAD}\n${url}`;
}

export function inviteSharePayload(url: string): { title: string; text: string } {
  return {
    title: INVITE_SHARE_TITLE,
    text: inviteShareText(url),
  };
}
