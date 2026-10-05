const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(input: string | number | bigint | null | undefined) {
  if (input === null || input === undefined) return '--'
  const bytes = Number(input)
  if (!Number.isFinite(bytes)) return '--'
  if (bytes === 0) return '0 B'
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${BYTE_UNITS[index]}`
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function formatDate(value: string) {
  return formatDateTime(value)
}

const providerNames: Record<string, string> = {
  google_drive: 'Google Drive',
  s3: 'S3 Storage',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  pcloud: 'pCloud',
  box: 'Box',
  yandex_disk: 'Yandex Disk',
  koofr: 'Koofr',
  mega: 'MEGA',
  mediafire: 'MediaFire',
  terabox: 'TeraBox',
  proton_drive: 'Proton Drive',
  icedrive: 'Icedrive',
  sync: 'Sync.com',
  idrive: 'IDrive',
  internxt: 'Internxt',
  idrive_e2: 'IDrive e2',
  backblaze_b2: 'Backblaze B2',
  cloudflare_r2: 'Cloudflare R2',
  minio: 'MinIO',
  wasabi: 'Wasabi',
}

export function providerLabel(provider: string | undefined | null) {
  if (!provider) return 'Google Drive'
  return providerNames[provider] ?? provider.replace(/_/g, ' ')
}

export function percentOf(value: string | number | bigint | null | undefined, total: string | number | bigint | null | undefined) {
  const amount = Number(value ?? 0)
  const max = Number(total ?? 0)
  if (!Number.isFinite(amount) || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((amount / max) * 100)))
}

export function formatPercent(value: string | number | bigint | null | undefined, total: string | number | bigint | null | undefined) {
  return `${percentOf(value, total)}%`
}
