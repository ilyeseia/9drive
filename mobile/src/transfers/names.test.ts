import { RLO, isBidiControl } from '../core/bidi';
import { canPreviewInApp, fileFamily, localDownloadName, safeFileName } from './names';

describe('safeFileName', () => {
  it('removes path separators and traversal', () => {
    for (const evil of ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path.txt', 'a/b/c.txt']) {
      const out = safeFileName(evil);
      expect(out).not.toMatch(/[\\/]/);
      expect(out.startsWith('.')).toBe(false);
    }
  });

  it('removes control, bidi and illegal characters', () => {
    const spoofed = safeFileName(`inv${String.fromCharCode(0)}oice${RLO}txt.exe`);
    expect(spoofed).toBe('inv_oice_txt.exe');
    expect([...spoofed].every((ch) => (ch.codePointAt(0) ?? 0) > 0x1f && !isBidiControl(ch.codePointAt(0) ?? 0))).toBe(true);
    expect(safeFileName('a:b*c?d"e<f>g|h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  it('never returns an empty or hidden name', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('////')).toBe('file');
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('x', 'fallback')).toBe('x');
    expect(safeFileName('', 'fallback')).toBe('fallback');
  });

  it('keeps Arabic, French and emoji names intact', () => {
    expect(safeFileName('تقرير 2026.pdf')).toBe('تقرير 2026.pdf');
    expect(safeFileName('Café été.txt')).toBe('Café été.txt');
    expect(safeFileName('photo 📷.jpg')).toBe('photo 📷.jpg');
  });

  it('truncates long names but keeps the extension', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    const out = safeFileName(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});

describe('localDownloadName', () => {
  it('is prefixed with the file id and safe', () => {
    expect(localDownloadName('3f2a-91bc-4d5e', 'report.pdf')).toBe('3f2a91bc-report.pdf');
    expect(localDownloadName('!!!', 'a.txt')).toBe('dl-a.txt');
    expect(localDownloadName('abc', '../../x')).not.toMatch(/[\\/]|\.\./);
  });
});

describe('fileFamily / preview', () => {
  it('classifies by MIME, falling back to extension', () => {
    expect(fileFamily('image/png')).toBe('image');
    expect(fileFamily('application/pdf')).toBe('pdf');
    expect(fileFamily('application/zip')).toBe('archive');
    expect(fileFamily('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('office');
    expect(fileFamily('application/octet-stream', 'clip.MOV')).toBe('video');
    expect(fileFamily('application/octet-stream', 'x.bin')).toBe('other');
  });

  it('never previews SVG in-app, and only previews raster images', () => {
    expect(canPreviewInApp('image', 'image/png')).toBe(true);
    expect(canPreviewInApp('image', 'image/svg+xml')).toBe(false);
    expect(canPreviewInApp('pdf', 'application/pdf')).toBe(false);
  });
});
