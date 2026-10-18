import { Fragment, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { spacing, useTheme } from '../theme/theme';
import { AppText } from './components';

/**
 * Restricted Markdown for assistant answers: paragraphs, headings, lists, code, simple tables, quotes, bold/italic/
 * inline code. It builds React Native <Text> nodes only — model output can never become executable markup, and
 * links are deliberately NOT tappable: a URL is shown as text ("label (https://…)") so the user sees where it
 * points, and nothing is opened on a model's say-so.
 */

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'quote'; text: string };

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const isTableSeparator = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('|');

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) body.push(lines[i++] ?? '');
      i += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      i += 1;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? '')) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') rows.push(splitRow(lines[i++] ?? ''));
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const matcher = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && matcher.test(lines[i] ?? '')) items.push((lines[i++] ?? '').match(matcher)?.[1] ?? '');
      blocks.push({ kind: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: quote.join('\n') });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^\s*```/.test(lines[i] ?? '') &&
      !/^(#{1,4})\s+/.test(lines[i] ?? '') &&
      !BULLET.test(lines[i] ?? '') &&
      !NUMBERED.test(lines[i] ?? '') &&
      !/^\s*>\s?/.test(lines[i] ?? '')
    ) {
      para.push(lines[i++] ?? '');
    }
    blocks.push({ kind: 'p', text: para.join('\n') });
  }
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] };

/** Pure inline parser (exported for tests). Links become plain text with the URL visible. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) });
    const token = match[0];
    if (token.startsWith('`')) out.push({ type: 'code', text: token.slice(1, -1) });
    else if (token.startsWith('**') || token.startsWith('__')) out.push({ type: 'bold', children: parseInline(token.slice(2, -2)) });
    else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push({ type: 'text', text: link ? `${link[1]} (${link[2]})` : token });
    } else out.push({ type: 'italic', children: parseInline(token.slice(1, -1)) });
    last = start + token.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

function renderInline(nodes: Inline[], codeBg: string, keyPrefix = 'i'): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    if (node.type === 'text') return <Fragment key={key}>{node.text}</Fragment>;
    if (node.type === 'code') {
      return (
        <Text key={key} style={{ fontFamily: 'monospace', backgroundColor: codeBg }}>
          {node.text}
        </Text>
      );
    }
    if (node.type === 'bold') {
      return (
        <Text key={key} style={{ fontWeight: '700' }}>
          {renderInline(node.children, codeBg, key)}
        </Text>
      );
    }
    return (
      <Text key={key} style={{ fontStyle: 'italic' }}>
        {renderInline(node.children, codeBg, key)}
      </Text>
    );
  });
}

export function Markdown({ text }: { text: string }) {
  const { colors } = useTheme();
  const blocks = parseBlocks(text);
  return (
    <View style={{ gap: spacing.sm }} accessible={false}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'heading':
            return (
              <AppText key={key} variant={block.level <= 2 ? 'heading' : 'label'} accessibilityRole="header">
                {renderInline(parseInline(block.text), colors.surfaceAlt, key)}
              </AppText>
            );
          case 'ul':
          case 'ol':
            return (
              <View key={key} style={{ gap: 2 }}>
                {block.items.map((item, k) => (
                  <View key={k} style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <AppText>{block.kind === 'ol' ? `${k + 1}.` : '•'}</AppText>
                    <AppText style={{ flex: 1 }}>{renderInline(parseInline(item), colors.surfaceAlt, `${key}-${k}`)}</AppText>
                  </View>
                ))}
              </View>
            );
          case 'code':
            return (
              <ScrollView key={key} horizontal style={{ backgroundColor: colors.surfaceAlt, borderRadius: 8 }}>
                <Text selectable style={{ fontFamily: 'monospace', color: colors.text, padding: spacing.sm, writingDirection: 'ltr' }}>
                  {block.text}
                </Text>
              </ScrollView>
            );
          case 'quote':
            return (
              <View key={key} style={{ borderStartWidth: 3, borderStartColor: colors.border, paddingStart: spacing.sm }}>
                <AppText muted>{renderInline(parseInline(block.text), colors.surfaceAlt, key)}</AppText>
              </View>
            );
          case 'table':
            return (
              <ScrollView key={key} horizontal>
                <View style={{ gap: 2 }}>
                  <View style={{ flexDirection: 'row', gap: spacing.md }}>
                    {block.head.map((cell, k) => (
                      <AppText key={k} variant="label" style={{ minWidth: 80 }}>
                        {cell}
                      </AppText>
                    ))}
                  </View>
                  {block.rows.map((row, r) => (
                    <View key={r} style={{ flexDirection: 'row', gap: spacing.md }}>
                      {row.map((cell, k) => (
                        <AppText key={k} variant="caption" style={{ minWidth: 80 }}>
                          {cell}
                        </AppText>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
          default:
            return <AppText key={key}>{renderInline(parseInline(block.text), colors.surfaceAlt, key)}</AppText>;
        }
      })}
    </View>
  );
}
