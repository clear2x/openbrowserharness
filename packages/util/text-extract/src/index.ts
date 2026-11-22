/**
 * Deterministic extractive text compression: keep the highest-signal blocks
 * under a character budget instead of cutting a raw prefix. Headings, early
 * prose, and keyword-dense sentences survive; boilerplate and repetition
 * drop. Pure functions, no runtime APIs, so the behavior is identical on
 * every surface and fully replayable — a model-facing render stays a
 * deterministic function of its tool result.
 *
 * @module @deepseek-ai/dsh-util-text-extract
 */

/**
 * The default character budget extractive compression targets. Chosen so the
 * compressed body fits comfortably in one request's tool-result slot while
 * keeping roughly an order of magnitude more source signal than a same-size
 * prefix cut.
 */
export const DEFAULT_EXTRACT_BUDGET_CHARS = 12_000

/** Whether a rendered line is a markdown heading (kept regardless of length). */
function isHeading(line: string): boolean {
  return /^#{1,6}\s/u.test(line)
}

/**
 * The content-word frequency table the keyword score reads. Latin words
 * (3+ chars) and CJK bigrams, both without stopword tables — raw frequency
 * already discounts the ubiquitous function words.
 */
function buildTermFrequencies(text: string): Map<string, number> {
  const frequencies = new Map<string, number>()
  const latin = text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/gu) ?? []
  for (const word of latin) frequencies.set(word, (frequencies.get(word) ?? 0) + 1)
  const cjk = text.match(/[\u4e00-\u9fff]/gu) ?? []
  for (let offset = 0; offset + 1 < cjk.length; offset += 1) {
    const bigram = `${cjk[offset] ?? ''}${cjk[offset + 1] ?? ''}`
    frequencies.set(bigram, (frequencies.get(bigram) ?? 0) + 1)
  }
  return frequencies
}

/** Score one sentence: keyword density × lead bias × length fit. */
function scoreSentence(sentence: string, index: number, total: number, frequencies: Map<string, number>): number {
  // Long sentences skip Latin termization to bound the work; CJK bigrams are
  // computed for every sentence because they are the mass carrier there.
  const latin = sentence.length < 400
    ? (sentence.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/gu) ?? [])
    : []
  const cjk = sentence.match(/[\u4e00-\u9fff]/gu) ?? []
  let keywordMass = 0
  for (const word of latin) keywordMass += frequencies.get(word) ?? 0
  for (let offset = 0; offset + 1 < cjk.length; offset += 1) {
    const bigram = `${cjk[offset] ?? ''}${cjk[offset + 1] ?? ''}`
    keywordMass += frequencies.get(bigram) ?? 0
  }
  // Normalize by length so long sentences do not win on raw mass alone.
  const density = keywordMass / Math.max(8, sentence.length / 4)
  // Lead bias: the first fifth of the document carries the thesis.
  const position = index / Math.max(1, total)
  const leadBias = position < 0.2 ? 1.5 : position < 0.5 ? 1.2 : 1
  // Very short fragments (nav labels, cookie notices) and very long dumps
  // both score low; 40–400 chars is the content sweet spot.
  const lengthFit = sentence.length < 24 ? 0.2 : sentence.length > 400 ? 0.5 : 1
  return density * leadBias * lengthFit
}

/**
 * Score and order the source's blocks. Paragraph breaks (`\n\n`) keep blocks
 * whole; within a paragraph, sentences score individually. Headings always
 * rank first (they are the document's structure).
 * @param text - the source text.
 * @returns the scored blocks in source order.
 */
export function scoreBlocks(text: string): Array<{ index: number; text: string; separator: string; score: number }> {
  const frequencies = buildTermFrequencies(text)
  const blocks: Array<{ index: number; text: string; separator: string; score: number }> = []
  let totalSentences = 0
  const pending: Array<{ text: string; separator: string; isHeading: boolean }> = []
  for (const paragraph of text.split(/\n{2,}/u)) {
    const trimmed = paragraph.trim()
    if (trimmed.length === 0) continue
    const heading = isHeading(trimmed)
    const separator = heading || !trimmed.includes('\n') ? '\n\n' : '\n'
    // A paragraph stays whole only when it cannot carry an internal break:
    // headings, or prose with no sentence-final punctuation anywhere.
    const hasBreak = /[.!?。！？；;]/u.test(trimmed)
    if (heading || (!hasBreak && trimmed.length <= 120)) {
      pending.push({ text: trimmed, separator, isHeading: heading })
      totalSentences += 1
      continue
    }
    const sentences = splitSentences(trimmed)
    if (sentences.length === 0) {
      pending.push({ text: trimmed, separator, isHeading: heading })
      totalSentences += 1
      continue
    }
    for (const [localIndex, sentence] of sentences.entries()) {
      const tail = localIndex === sentences.length - 1 ? separator : ' '
      pending.push({ text: sentence, separator: tail, isHeading: false })
      totalSentences += 1
    }
  }
  for (const block of pending) {
    const score = block.isHeading
      ? Number.POSITIVE_INFINITY
      : scoreSentence(block.text, blocks.length, totalSentences, frequencies)
    blocks.push({ index: blocks.length, text: block.text, separator: block.separator, score })
  }
  return blocks
}

/** Split one paragraph into sentences across Chinese and Latin punctuation. */
function splitSentences(paragraph: string): string[] {
  const sentences: string[] = []
  let start = 0
  for (let offset = 0; offset < paragraph.length; offset += 1) {
    const char = paragraph[offset]
    if (char === '.' || char === '!' || char === '?' || char === '。' || char === '！' || char === '？' || char === '；' || char === ';') {
      // A Latin period only ends a sentence at a whitespace/punctuation
      // boundary, so "3.14" and "e.g." stay inside one sentence.
      if (char === '.' && !/[\s'"”」)）\]}]/u.test(paragraph[offset + 1] ?? ' ')) continue
      const sentence = paragraph.slice(start, offset + 1).trim()
      if (sentence.length > 0) sentences.push(sentence)
      start = offset + 1
    }
  }
  const tail = paragraph.slice(start).trim()
  if (tail.length >= 24) sentences.push(tail)
  return sentences
}

/** The compression notice appended after a compressed body. */
export const COMPRESSION_FOOTER = '\n\n(Locally compressed: highest-signal blocks kept, full text available at the source.)'

/**
 * The candidate terms of one block (Latin words + CJK bigrams) — the overlap
 * key the redundancy gate reads.
 */
function termsOf(text: string): Set<string> {
  const terms = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/gu) ?? []) terms.add(word)
  const cjk = text.match(/[\u4e00-\u9fff]/gu) ?? []
  for (let offset = 0; offset + 1 < cjk.length; offset += 1) {
    terms.add(`${cjk[offset] ?? ''}${cjk[offset + 1] ?? ''}`)
  }
  return terms
}

/**
 * Compress the source to the budget: headings always, then sentences by
 * score, both emitted in source order. A candidate whose terms largely
 * repeat already-selected content is skipped (repeated boilerplate wins on
 * raw frequency otherwise). A tail guarantee keeps the highest-scored block
 * from the document's last quarter in the selection, so a once-stated fact
 * at the end is never crowded out entirely. The compression footer's reserve
 * is the caller's budget math — the returned text never exceeds `budget`
 * characters. Text at or under the budget passes through untouched.
 * @param text - the source text.
 * @param budget - the maximum characters of the returned string.
 * @returns the compressed text (or the source verbatim when it already fits).
 */
export function compressToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text
  const blocks = scoreBlocks(text)
  const tailStart = Math.floor(blocks.length * 0.75)
  const ranked = blocks
    .map((block, order) => ({ block, order }))
    .sort((a, b) => {
      const scoreA = Number.isFinite(a.block.score) ? a.block.score : Number.MAX_VALUE
      const scoreB = Number.isFinite(b.block.score) ? b.block.score : Number.MAX_VALUE
      if (scoreA !== scoreB) return scoreB - scoreA
      return a.order - b.order
    })
  const chosen: Array<{ block: { text: string; separator: string; score: number }; order: number }> = []
  const selectedTerms = new Set<string>()
  const withinTail = (candidate: { order: number }): boolean => candidate.order >= tailStart
  let used = 0
  const costOf = (candidate: { block: { text: string; separator: string } }): number =>
    candidate.block.text.length + candidate.block.separator.length
  const passGate = (candidate: { block: { text: string } }): boolean => {
    // Redundancy gate: a term-rich candidate that mostly repeats what the
    // selection already carries is boilerplate (site footers, repeated
    // notices); short fragments lack enough terms to judge and stay eligible.
    const terms = termsOf(candidate.block.text)
    if (terms.size >= 6) {
      let overlap = 0
      for (const term of terms) if (selectedTerms.has(term)) overlap += 1
      if (overlap / terms.size > 0.6) return false
    }
    return true
  }
  for (const candidate of ranked) {
    const cost = costOf(candidate)
    if (used + cost > budget) continue
    if (!passGate(candidate)) continue
    chosen.push(candidate)
    used += cost
    for (const term of termsOf(candidate.block.text)) selectedTerms.add(term)
  }
  // Tail guarantee: when the score-driven selection picked no tail block,
  // admit the highest-scored tail candidate that fits — replacing the
  // lowest-scored non-tail pick when the slack alone cannot hold it.
  if (!chosen.some(entry => withinTail(entry))) {
    const tailCandidate = ranked.find(entry => withinTail(entry) && !chosen.includes(entry))
    if (tailCandidate !== undefined) {
      const cost = costOf(tailCandidate)
      const slack = budget - used
      if (cost <= slack) {
        chosen.push(tailCandidate)
      } else {
        const weakest = chosen
          .filter(item => !withinTail(item))
          .sort((a, b) => a.block.score - b.block.score)
          .at(0)
        const weakestCost = weakest === undefined ? 0 : weakest.block.text.length + weakest.block.separator.length
        if (weakest !== undefined && weakestCost + slack >= cost) {
          chosen.splice(chosen.indexOf(weakest), 1)
          chosen.push(tailCandidate)
        }
      }
    }
  }
  chosen.sort((a, b) => a.order - b.order)
  return chosen.map(entry => entry.block.text + entry.block.separator).join('').trimEnd()
}
