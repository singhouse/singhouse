// SPDX-License-Identifier: AGPL-3.0-only
// Derive the sibling lyric representations from a canonical editor doc, so
// a saved set's plain_lyrics / synced_lyrics stay consistent with its edited
// word_sync (realign-against-active and LRC export read them).

function lineText(line) {
  return line.map((w) => w.text).join(' ')
}

export function docToPlain(doc) {
  return doc.lines.map(lineText).join('\n')
}

function lrcTimestamp(seconds) {
  const t = Math.max(0, seconds)
  const mm = Math.floor(t / 60)
  const ss = t - mm * 60
  return `[${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}]`
}

export function docToLrc(doc) {
  return doc.lines.map((line) => `${lrcTimestamp(line[0].start)} ${lineText(line)}`).join('\n')
}
