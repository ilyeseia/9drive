// Local, privacy-friendly avatar: renders initials as an inline SVG data URL.
// No network request is made (works offline / on Tailscale), and the exported
// signature is unchanged so existing callers do not need edits.
const PALETTE = [
  '#2563eb', // blue
  '#4f46e5', // indigo
  '#0891b2', // cyan
  '#059669', // emerald
  '#d97706', // amber
  '#db2777', // pink
  '#7c3aed', // violet
  '#dc2626', // red
]

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0 // Convert to 32bit integer
  }
  return Math.abs(hash)
}

function initialsFor(email: string): string {
  const local = email.split('@')[0] ?? ''
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  if (parts.length === 0) return 'U'
  if (parts.length === 1) return (parts[0].slice(0, 1) || 'U').toUpperCase()
  return ((parts[0].slice(0, 1) || '') + (parts[1].slice(0, 1) || '')).toUpperCase()
}

export async function getGravatarUrl(email: string | undefined, size: number) {
  const normalized = email?.trim().toLowerCase() ?? ''
  const initials = initialsFor(normalized)
  const background = PALETTE[hashString(normalized || 'default-user') % PALETTE.length]
  const fontSize = Math.round(size * 0.42)

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.5)}" fill="${background}"/>`,
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${initials}</text>`,
    `</svg>`,
  ].join('')

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
