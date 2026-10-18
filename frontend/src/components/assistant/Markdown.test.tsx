import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown, parseBlocks } from '@/components/assistant/Markdown'

afterEach(cleanup)

describe('Markdown', () => {
  it('renders bold, italic, inline code, lists and headings', () => {
    const { container } = render(<Markdown text={'## Summary\n\nYou have **3 accounts** and *one* needs `attention`.\n\n- first\n- second\n\n1. one\n2. two'} />)
    expect(container.querySelector('strong')?.textContent).toBe('3 accounts')
    expect(container.querySelector('em')?.textContent).toBe('one')
    expect(container.querySelector('code')?.textContent).toBe('attention')
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
    expect(screen.getByText('Summary')).toBeTruthy()
  })

  it('renders fenced code verbatim and tables', () => {
    const { container } = render(<Markdown text={'```\nconst x = **not bold**\n```\n\n| Name | Used |\n| --- | ---: |\n| Drive | 5 GB |\n| Dropbox | 1 GB |'} />)
    expect(container.querySelector('pre code')?.textContent).toBe('const x = **not bold**')
    expect(container.querySelectorAll('thead th')).toHaveLength(2)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(screen.getByText('Dropbox')).toBeTruthy()
  })

  it('never turns model output into HTML or script', () => {
    const evil = '<img src=x onerror="alert(1)"> <script>alert(2)</script> [click](javascript:alert(3)) [ok](https://example.com/a?b=1)'
    const { container } = render(<Markdown text={evil} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    const anchors = [...container.querySelectorAll('a')]
    expect(anchors).toHaveLength(1)
    expect(anchors[0].getAttribute('href')).toBe('https://example.com/a?b=1')
    expect(anchors[0].getAttribute('rel')).toContain('noopener')
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(container.textContent).toContain('[click](javascript:alert(3))')
  })

  it('keeps single line breaks and handles empty input', () => {
    const { container } = render(<Markdown text={'line one\nline two'} />)
    expect(container.querySelectorAll('br')).toHaveLength(1)
    expect(parseBlocks('')).toEqual([])
    expect(parseBlocks('\n\n')).toEqual([])
  })

  it('does not hang or throw on unbalanced markers', () => {
    expect(() => render(<Markdown text={'**open ` tick | pipe\n- \n```\nunclosed'} />)).not.toThrow()
  })
})
