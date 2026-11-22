/**
 * Lightweight, safe Markdown-to-HTML prose renderer for Trace detail previews.
 */

import { esc } from '../format.js';
import { t } from '../i18n.js';

export function renderProse(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!text) return `<div class="empty-inline">${esc(t('td.noContent'))}</div>`;

  const inlineFmt = (raw) => {
    const codeSpans = [];
    let s = esc(raw).replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = codeSpans.push(`<code>${code}</code>`) - 1;
      return `\u0000C${idx}\u0000`;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, rawHref) => {
      const href = rawHref.replace(/&amp;/g, '&');
      if (/^https?:\/\//i.test(href)) {
        return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      if (/^file:\/\//i.test(href)) {
        return `<a href="#" data-file-uri="${esc(href)}">${label}</a>`;
      }
      return label;
    });
    s = s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>');
    return s.replace(/\u0000C(\d+)\u0000/g, (_, idx) => codeSpans[Number(idx)] || '');
  };

  const renderBlockLines = (chunk) => {
    const lines = chunk.split('\n');
    const out = [];
    let i = 0;

    const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
    const splitTableRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }

      if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
        out.push('<hr>');
        i++;
        continue;
      }

      const hMatch = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
      if (hMatch) {
        const lvl = hMatch[1].length;
        out.push(`<h${lvl}>${inlineFmt(hMatch[2])}</h${lvl}>`);
        i++;
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const headers = splitTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        out.push(`<table><thead><tr>${headers.map((h) => `<th>${inlineFmt(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${headers.map((_, ci) => `<td>${inlineFmt(r[ci] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const bq = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          bq.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${bq.map((l) => (l.trim() ? `<p>${inlineFmt(l)}</p>` : '')).join('')}</blockquote>`);
        continue;
      }

      if (/^\s*[-*•]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
          items.push(`<li>${inlineFmt(lines[i].replace(/^\s*[-*•]\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${inlineFmt(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      const para = [];
      while (
        i < lines.length
        && lines[i].trim()
        && !/^(#{1,4})\s+/.test(lines[i])
        && !/^(?:---+|\*\*\*+|___+)$/.test(lines[i].trim())
        && !/^\s*>\s?/.test(lines[i])
        && !/^\s*[-*•]\s+/.test(lines[i])
        && !/^\s*\d+\.\s+/.test(lines[i])
        && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
      ) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        out.push(`<p>${para.map(inlineFmt).join('<br>')}</p>`);
      }
    }
    return out.join('');
  };

  const parts = text.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return parts.map((part) => {
    const codeMatch = part.match(/^```([^\n]*)\n([\s\S]*?)```$/);
    if (codeMatch) {
      const lang = codeMatch[1].trim();
      const body = codeMatch[2].replace(/\n$/, '');
      return lang
        ? `<div class="md-code-wrap"><div class="md-code-lang">${esc(lang)}</div><pre><code>${esc(body)}</code></pre></div>`
        : `<pre><code>${esc(body)}</code></pre>`;
    }
    return renderBlockLines(part);
  }).join('');
}
