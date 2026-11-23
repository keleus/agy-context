/**
 * Trace master-detail inspector drawer: tailored tabs for Model, Tool/Skill/MCP,
 * User Input, and System/Injected trace entries.
 */

import { $, apiGet, esc, fmtIsoLocal, fmtPct, fmtTokens, fmtTraceDur } from '../format.js';
import { t } from '../i18n.js';
import { activeSessionId, state } from '../state.js';
import { formatSystemName, getSystemBadges, isCompactionItem } from '../components/breakdowns.js';
import { renderProse } from '../components/prose.js';

export function closeTraceDetail() {
  state.traceSelectedIdx = null;
  $('trace-detail').classList.add('hidden');
  $('trace-split').classList.remove('has-detail');
  document.querySelectorAll('.tr-row.selected, .ts-cell.selected').forEach((el) => el.classList.remove('selected'));
}

export function toggleTraceDetail(idx) {
  if (state.traceSelectedIdx === idx && !$('trace-detail').classList.contains('hidden')) {
    closeTraceDetail();
    return false;
  }
  openTraceDetail(idx);
  return true;
}

export async function openTraceDetail(idx) {
  state.traceSelectedIdx = idx;
  state.traceDetailTab = 'overview';
  state.traceOverviewExpanded = false;
  $('trace-detail').classList.remove('hidden');
  $('trace-split').classList.add('has-detail');

  document.querySelectorAll('.tr-row').forEach((el) => el.classList.toggle('selected', Number(el.dataset.tidx) === idx));
  document.querySelectorAll('.ts-cell.hit').forEach((el) => el.classList.toggle('selected', Number(el.dataset.tidx) === idx));
  requestAnimationFrame(() => {
    const row = $('trace-list')?.querySelector(`.tr-row[data-tidx="${idx}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    const cell = $('trace-strip-scroll')?.querySelector('.ts-cell.hit.selected');
    if (cell) cell.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });

  const convId = activeSessionId();
  const cacheKey = `${convId}:${idx}`;
  const hit = state.traceDetailCache.get(cacheKey);
  if (hit) {
    renderTraceDetailPanel(hit);
    return;
  }

  $('td-body').innerHTML = `<div class="empty-inline">${esc(t('td.loading'))}</div>`;
  try {
    const res = await apiGet(`/api/trace-detail?conversationId=${encodeURIComponent(convId)}&idx=${idx}`);
    if (res.found && res.item) {
      if (state.traceDetailCache.size > 120) state.traceDetailCache.clear();
      state.traceDetailCache.set(cacheKey, res.item);
      if (state.traceSelectedIdx === idx) renderTraceDetailPanel(res.item);
    }
  } catch {
    $('td-body').innerHTML = `<div class="empty-inline">${esc(t('td.noContent'))}</div>`;
  }
}

export function renderTraceDetailPanel(item) {
  const badge = $('td-kind-badge');
  const isComp = isCompactionItem(item);
  const badgeCls = item.hasError ? 'tag-err'
    : isComp ? 'tag-neutral'
    : item.kind === 'input' ? 'tag-write'
    : item.kind === 'mcp' ? 'tag-mcp'
    : item.kind === 'model' ? 'tag-read'
    : item.kind === 'skill' ? 'tag-read'
    : item.kind === 'system' ? 'tag-read'
    : 'tag-edit';
  badge.className = `tag-pill ${badgeCls}`;
  badge.textContent = isComp
    ? t('trace.compaction')
    : item.kind === 'mcp'
      ? (item.mcpServer && item.mcpTool ? `${item.mcpServer} / ${item.mcpTool}` : (item.mcpTool || item.toolName || t('trace.mcp')))
      : item.kind === 'tool'
        ? ((item.isCommand && item.commandName) ? item.commandName : (item.toolName || t('trace.tool')))
        : item.kind === 'skill'
          ? (item.skillName || t('trace.skill'))
          : item.kind === 'system'
            ? formatSystemName(item)
            : t(`trace.${item.kind}`);
  $('td-step-label').textContent = `${t('step.turn', { turn: item.turn })} · ${t('step.label', { step: item.step })}${item.reverted ? ` · ${t('trace.reverted')}` : ''}`;

  const tabs = (item.kind === 'tool' || item.kind === 'skill' || item.kind === 'mcp')
    ? [
        ['overview', t('td.overview')],
        ['args', t('td.args')],
        ['result', t('td.result')],
        ['timing', t('td.timing')],
      ]
    : (item.kind === 'model' || item.kind === 'input')
      ? [
          ['overview', t('td.overview')],
          ['preview', t('td.preview')],
          ['raw', t('td.raw')],
        ]
      : [
          ['overview', t('td.overview')],
          ['raw', t('td.raw')],
        ];

  if (!tabs.some(([k]) => k === state.traceDetailTab)) state.traceDetailTab = 'overview';

  const tabsEl = $('td-tabs');
  tabsEl.innerHTML = tabs.map(([k, lbl]) =>
    `<button type="button" class="td-tab${state.traceDetailTab === k ? ' active' : ''}" data-tdtab="${k}">${esc(lbl)}</button>`).join('');
  tabsEl.querySelectorAll('.td-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.traceDetailTab = btn.dataset.tdtab;
      renderTraceDetailPanel(item);
    });
  });

  const copyBtnHtml = (id) => `<button type="button" class="link-btn" data-copy-id="${id}">${esc(t('td.copy'))}</button>`;
  const kv = (rows) => `<div class="td-kv">${rows.map(([k, v]) => `<span class="td-kv-k">${esc(k)}</span><span class="td-kv-v">${esc(v)}</span>`).join('')}</div>`;
  const bodyEl = $('td-body');
  const tab = state.traceDetailTab;

  if (item.kind === 'tool' || item.kind === 'skill' || item.kind === 'mcp') {
    const argsJson = JSON.stringify(item.args || {}, null, 2);
    const resultText = item.result || item.hookError || t('td.noContent');
    const errBlock = item.hookError
      ? `<div><div class="td-section-head"><span>${esc(t('td.hostError'))}</span></div><div class="td-err-box">${esc(item.hookError)}</div></div>`
      : '';
    if (tab === 'timing') {
      bodyEl.innerHTML = kv([
        [t('td.start'), fmtIsoLocal(item.at)],
        [t('td.end'), fmtIsoLocal(item.endAt)],
        [t('td.duration'), item.durationMs ? `${item.durationMs.toLocaleString()} ms (${fmtTraceDur(item.durationMs)})` : '—'],
      ]);
    } else if (tab === 'args') {
      bodyEl.innerHTML = `
        <div><div class="td-section-head"><span>${esc(t('td.args'))}</span>${copyBtnHtml('td-pre-args')}</div>
        <pre id="td-pre-args" class="td-pre">${esc(argsJson)}</pre></div>
      `;
    } else if (tab === 'result') {
      bodyEl.innerHTML = `
        ${errBlock}
        <div><div class="td-section-head"><span>${esc(t('td.result'))}</span>${copyBtnHtml('td-pre-res')}</div>
        <pre id="td-pre-res" class="td-pre">${esc(resultText)}</pre></div>
      `;
    } else {
      const metaRows = item.kind === 'mcp'
        ? [
            [t('td.mcpServer'), item.mcpServer || '—'],
            [t('td.mcpTool'), item.mcpTool || '—'],
            ...(item.toolName && item.toolName !== item.mcpTool ? [[t('td.rawTool'), item.toolName]] : []),
            [t('td.status'), item.status || 'DONE'],
            [t('td.turnStep'), `${t('step.turn', { turn: item.turn })} · #${item.step}`],
            [t('td.duration'), item.durationMs ? `${item.durationMs.toLocaleString()} ms` : '—'],
          ]
        : item.isCommand
          ? [
              [t('td.command'), item.commandName || '—'],
              [t('td.status'), item.status || 'DONE'],
              [t('td.turnStep'), `${t('step.turn', { turn: item.turn })} · #${item.step}`],
              [t('td.duration'), item.durationMs ? `${item.durationMs.toLocaleString()} ms` : '—'],
            ]
          : [
              [item.kind === 'skill' ? t('trace.skill') : t('td.tool'), item.skillName || item.toolName || '—'],
              [t('td.status'), item.status || 'DONE'],
              [t('td.turnStep'), `${t('step.turn', { turn: item.turn })} · #${item.step}`],
              [t('td.duration'), item.durationMs ? `${item.durationMs.toLocaleString()} ms` : '—'],
            ];
      bodyEl.innerHTML = `
        ${kv(metaRows)}
        ${errBlock}
        <div><div class="td-section-head"><span>${esc(t('td.args'))}</span>${copyBtnHtml('td-pre-args')}</div>
        <pre id="td-pre-args" class="td-pre">${esc(argsJson)}</pre></div>
        <div><div class="td-section-head"><span>${esc(t('td.result'))}</span>${copyBtnHtml('td-pre-res')}</div>
        <pre id="td-pre-res" class="td-pre">${esc(resultText.slice(0, 6000))}${resultText.length > 6000 ? '\n…' : ''}</pre></div>
      `;
    }
  } else if (item.kind === 'model') {
    const tcs = Array.isArray(item.toolCalls) ? item.toolCalls : [];
    const childIdxs = Array.isArray(item.childToolIdxs) ? item.childToolIdxs : [];
    const cachePct = item.promptTokens > 0 ? fmtPct(item.cacheReadTokens / item.promptTokens, 1) : '0%';

    const renderThinkingBox = (clamped) => {
      if (!item.thinking) return '';
      const collapsed = !clamped && state.traceThinkingCollapsed;
      return `
        <div class="td-thinking-box">
          <button type="button" class="td-thinking-toggle" data-toggle-think>
            <span>${esc(t('td.thinking'))} ${collapsed ? '▸' : '▾'}</span>
          </button>
          ${collapsed ? '' : `<div class="td-prose muted${clamped ? ' clamped' : ''}">${renderProse(item.thinking)}</div>`}
        </div>
      `;
    };

    const renderToolJumps = () => tcs.map((tc, i) => {
      const targetIdx = childIdxs[i];
      const argStr = JSON.stringify(tc.args || {});
      return `
        <button type="button" class="td-call-jump" ${targetIdx != null ? `data-jump-idx="${targetIdx}"` : 'disabled'}>
          <strong>${esc(tc.name)}</strong>
          <span class="tc-args">${esc(argStr.slice(0, 120))}</span>
          ${targetIdx != null ? '<span>›</span>' : ''}
        </button>
      `;
    }).join('');

    if (tab === 'preview') {
      bodyEl.innerHTML = `
        ${renderThinkingBox(false)}
        ${item.content ? `<div class="td-prose">${renderProse(item.content)}</div>` : ''}
        ${tcs.length ? renderToolJumps() : ''}
        ${!item.thinking && !item.content && !tcs.length ? `<div class="empty-inline">${esc(t('td.noContent'))}</div>` : ''}
      `;
    } else if (tab === 'raw') {
      const blocks = [];
      let bNum = 1;
      if (item.thinking) {
        const id = `td-raw-${bNum}`;
        blocks.push(`
          <div class="td-raw-block">
            <div class="td-raw-head"><span>${esc(t('td.block', { n: bNum }))} · thinking</span>${copyBtnHtml(id)}</div>
            <pre id="${id}" class="td-pre">${esc(item.thinking)}</pre>
          </div>
        `);
        bNum++;
      }
      if (item.content) {
        const id = `td-raw-${bNum}`;
        blocks.push(`
          <div class="td-raw-block">
            <div class="td-raw-head"><span>${esc(t('td.block', { n: bNum }))} · reply</span>${copyBtnHtml(id)}</div>
            <pre id="${id}" class="td-pre">${esc(item.content)}</pre>
          </div>
        `);
        bNum++;
      }
      tcs.forEach((tc, i) => {
        const id = `td-raw-${bNum}`;
        const targetIdx = childIdxs[i];
        blocks.push(`
          <div class="td-raw-block">
            <div class="td-raw-head">
              <button type="button" class="td-raw-jump" ${targetIdx != null ? `data-jump-idx="${targetIdx}"` : 'disabled'}>
                ${esc(t('td.block', { n: bNum }))} · tool-call · ${esc(tc.name)}${targetIdx != null ? ' ›' : ''}
              </button>
              ${copyBtnHtml(id)}
            </div>
            <pre id="${id}" class="td-pre">${esc(JSON.stringify(tc.args || {}, null, 2))}</pre>
          </div>
        `);
        bNum++;
      });
      bodyEl.innerHTML = blocks.length ? blocks.join('') : `<div class="empty-inline">${esc(t('td.noContent'))}</div>`;
    } else {
      const expanded = !!state.traceOverviewExpanded;
      const hasTiming = (item.durationMs || 0) > 0;
      const speedMs = (item.streamMs || 0) > 0
        ? item.streamMs
        : ((item.ttftMs || 0) > 0 ? 0 : (item.durationMs || 0));
      const detailThroughput = speedMs > 0 && (item.outputTokens || 0) > 0
        ? Math.round((item.outputTokens / (speedMs / 1000)) * 10) / 10
        : (item.tokPerSec || 0);
      const timingRows = [[t('td.start'), fmtIsoLocal(item.at)]];
      if ((item.ttftMs || 0) > 0) timingRows.push([t('td.ttft'), `${(item.ttftMs / 1000).toFixed(2)}s`]);
      if ((item.thinkingMs || 0) > 0) timingRows.push([t('td.thinkingTime'), `${(item.thinkingMs / 1000).toFixed(2)}s`]);
      if ((item.streamMs || 0) > 0) timingRows.push([t('td.genTime'), `${(item.streamMs / 1000).toFixed(2)}s`]);
      timingRows.push([t('td.duration'), hasTiming ? `${(item.durationMs / 1000).toFixed(2)}s` : '—']);
      timingRows.push([t('td.throughput'), detailThroughput > 0 ? `${detailThroughput} tok/s` : '—']);
      const hasPreviewBody = !!(item.thinking || item.content || tcs.length);
      bodyEl.innerHTML = `
        ${kv([
          [t('td.model'), item.model || '—'],
          [t('td.status'), item.reverted ? `${item.status || 'DONE'} (${t('trace.reverted')})` : (item.status || 'DONE')],
          [t('td.tokens'), `${fmtTokens(item.outputTokens)} out · ${fmtTokens(item.inputTokens)} in · ${fmtTokens(item.cacheReadTokens)} cached (${cachePct})`],
        ])}
        ${hasPreviewBody ? `
          <div>
            <div class="td-preview-head">
              <span class="td-preview-title">${esc(t('td.preview'))}</span>
              <button type="button" class="td-expand-btn" data-toggle-ov-preview>${esc(expanded ? t('td.collapse') : t('td.expand'))}</button>
            </div>
            ${renderThinkingBox(!expanded)}
            ${item.content ? `<div class="td-prose${expanded ? '' : ' clamped'}">${renderProse(item.content)}</div>` : ''}
            ${!item.content && !item.thinking && tcs.length ? renderToolJumps() : (expanded && tcs.length ? renderToolJumps() : '')}
          </div>
        ` : ''}
        <div>
          <div class="td-section-head"><span>${esc(t('td.reqTiming'))}</span></div>
          ${kv(timingRows)}
          ${!hasTiming ? `<div class="td-timing-note">${esc(t('td.timingUnavailable'))}</div>` : ''}
        </div>
      `;
    }
  } else if (item.kind === 'system') {
    const sysText = item.content || t('td.noContent');
    const sysBadges = getSystemBadges(item);
    const badgeLabels = sysBadges.map((b) => t(`inj.${b}`)).join(' · ');
    if (tab === 'raw') {
      bodyEl.innerHTML = `
        <div><div class="td-section-head"><span>${esc(formatSystemName(item))}</span>${copyBtnHtml('td-pre-sys')}</div>
        <pre id="td-pre-sys" class="td-pre">${esc(sysText)}</pre></div>
      `;
    } else {
      bodyEl.innerHTML = `
        ${kv([
          [t('td.status'), badgeLabels ? `${badgeLabels} (${formatSystemName(item)})` : formatSystemName(item)],
          [t('td.source'), item.source || 'SYSTEM'],
          [t('td.turnStep'), `${t('step.turn', { turn: item.turn })} · #${item.step}`],
          [t('td.start'), fmtIsoLocal(item.at)],
        ])}
        <div class="td-prose">${renderProse(sysText)}</div>
      `;
    }
  } else {
    const promptText = item.userText || t('td.noContent');
    const media = Array.isArray(item.media) ? item.media : [];
    if (tab === 'preview') {
      bodyEl.innerHTML = `
        <div class="td-prose">${renderProse(promptText)}</div>
        ${media.length ? `<div><div class="td-section-head"><span>${esc(t('td.attachments'))} (${media.length})</span></div><pre class="td-pre">${esc(media.map((m) => `${m.mime_type || 'file'}: ${m.uri || ''}`).join('\n'))}</pre></div>` : ''}
      `;
    } else if (tab === 'raw') {
      bodyEl.innerHTML = `
        <div><div class="td-section-head"><span>${esc(t('td.raw'))}</span>${copyBtnHtml('td-pre-in')}</div>
        <pre id="td-pre-in" class="td-pre">${esc(item.rawContent || promptText)}</pre></div>
      `;
    } else {
      const expanded = !!state.traceOverviewExpanded;
      bodyEl.innerHTML = `
        ${kv([
          [t('td.turnStep'), `${t('step.turn', { turn: item.turn })} · #${item.step}`],
          [t('td.start'), fmtIsoLocal(item.at)],
          ...(media.length ? [[t('td.attachments'), String(media.length)]] : []),
        ])}
        <div>
          <div class="td-preview-head">
            <span class="td-preview-title">${esc(t('td.preview'))}</span>
            <button type="button" class="td-expand-btn" data-toggle-ov-preview>${esc(expanded ? t('td.collapse') : t('td.expand'))}</button>
          </div>
          <div class="td-prose${expanded ? '' : ' clamped'}">${renderProse(promptText)}</div>
        </div>
      `;
    }
  }

  bodyEl.querySelectorAll('[data-toggle-ov-preview]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.traceOverviewExpanded = !state.traceOverviewExpanded;
      renderTraceDetailPanel(item);
    });
  });

  bodyEl.querySelectorAll('[data-file-uri]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const uri = link.dataset.fileUri;
      if (uri && window.sidecar?.ui?.toggleAuxPane) {
        window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
      }
    });
  });

  bodyEl.querySelectorAll('[data-toggle-think]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.traceThinkingCollapsed = !state.traceThinkingCollapsed;
      renderTraceDetailPanel(item);
    });
  });

  bodyEl.querySelectorAll('[data-jump-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = Number(btn.dataset.jumpIdx);
      if (Number.isInteger(target)) openTraceDetail(target);
    });
  });

  bodyEl.querySelectorAll('[data-copy-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pre = $(btn.dataset.copyId);
      if (!pre) return;
      try {
        await navigator.clipboard.writeText(pre.textContent || '');
        btn.textContent = t('td.copied');
        setTimeout(() => { btn.textContent = t('td.copy'); }, 1200);
      } catch { /* ignore */ }
    });
  });
}
