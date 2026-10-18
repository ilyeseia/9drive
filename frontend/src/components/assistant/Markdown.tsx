import { Fragment, type ReactNode } from 'react'

/**
 * Small, dependency-free Markdown renderer for assistant answers (paragraphs, headings, lists,
 * code, tables, bold/italic/inline code, http(s) links). It builds React elements only — model
 * output is never interpreted as HTML, so it cannot inject markup or script.
 */

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'quote'; text: string }

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const isTableSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }
    const fence = line.match(/^\s*```/)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i += 1
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      i += 1
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') rows.push(splitRow(lines[i++]))
      blocks.push({ kind: 'table', head, rows })
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/
    const numbered = /^\s*\d+[.)]\s+(.*)$/
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line)
      const matcher = ordered ? numbered : bullet
      const items: string[] = []
      while (i < lines.length && matcher.test(lines[i])) items.push(lines[i++].match(matcher)![1])
      blocks.push({ kind: ordered ? 'ol' : 'ul', items })
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', text: quote.join('\n') })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      para.push(lines[i++])
    }
    blocks.push({ kind: 'p', text: para.join('\n') })
  }
  return blocks
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    const token = match[0]
    const key = `${keyPrefix}-${n++}`
    if (token.startsWith('`')) {
      out.push(<code key={key} className="rounded bg-slate-200/60 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>)
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link && SAFE_URL.test(link[2])) {
        out.push(<a key={key} href={link[2]} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-blue-600 underline">{link[1]}</a>)
      } else {
        out.push(token)
      }
    } else {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>)
    }
    last = start + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const withBreaks = (text: string, key: string): ReactNode[] =>
  text.split('\n').flatMap((line, index) => (index === 0 ? [<Fragment key={`${key}-l0`}>{renderInline(line, `${key}-0`)}</Fragment>] : [<br key={`${key}-b${index}`} />, <Fragment key={`${key}-l${index}`}>{renderInline(line, `${key}-${index}`)}</Fragment>]))

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <div className="space-y-2 break-words" data-testid="markdown">
      {blocks.map((block, index) => {
        const key = `b${index}`
        switch (block.kind) {
          case 'heading':
            return <p key={key} className={block.level <= 2 ? 'text-base font-extrabold' : 'text-sm font-bold'}>{renderInline(block.text, key)}</p>
          case 'ul':
            return <ul key={key} className="list-disc space-y-0.5 ps-5">{block.items.map((item, k) => <li key={k}>{renderInline(item, `${key}-${k}`)}</li>)}</ul>
          case 'ol':
            return <ol key={key} className="list-decimal space-y-0.5 ps-5">{block.items.map((item, k) => <li key={k}>{renderInline(item, `${key}-${k}`)}</li>)}</ol>
          case 'code':
            return <pre key={key} dir="ltr" className="overflow-x-auto rounded-xl bg-slate-900/90 p-3 text-xs text-slate-100"><code>{block.text}</code></pre>
          case 'quote':
            return <blockquote key={key} className="border-s-2 border-slate-300 ps-3 text-slate-600 dark:text-slate-300">{withBreaks(block.text, key)}</blockquote>
          case 'table':
            return (
              <div key={key} className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>{block.head.map((cell, k) => <th key={k} className="border-b border-slate-300 px-2 py-1 text-start font-bold">{renderInline(cell, `${key}-h${k}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>{row.map((cell, k) => <td key={k} className="border-b border-slate-200/60 px-2 py-1 align-top">{renderInline(cell, `${key}-${r}-${k}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return <p key={key}>{withBreaks(block.text, key)}</p>
        }
      })}
    </div>
  )
}
