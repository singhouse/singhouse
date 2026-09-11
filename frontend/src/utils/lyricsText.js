// SPDX-License-Identifier: AGPL-3.0-only
//
// The two questions every lyrics textarea in the app asks about its own
// contents: is this LRC, and how many lines is it. Both were open-coded in
// three places, which is how the paste box and the version list came to
// disagree about what counted as a line.

// A leading `[mm:ss` timestamp is what makes text LRC. Deliberately loose —
// the server does the real parsing; this only decides which FIELD the text
// travels in (synced_lyrics vs plain_lyrics) and what the UI says about it.
export const LRC_REGEX = /\[\d{1,2}:\d{2}/

export function isLrcText(text) {
  return LRC_REGEX.test(text || '')
}

/** Non-blank lines. Blank ones are stanza spacing, not lyrics. */
export function countLyricLines(text) {
  if (!text || !text.trim()) return 0
  return text.trim().split('\n').filter(l => l.trim()).length
}
