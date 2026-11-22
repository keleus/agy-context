/**
 * Current-window context composition row builder and expandable breakdown list
 * (Categories, Level-2 MCP Servers / Commands, Level-3 concrete items, and Per-Model rows).
 */

import {
  CHEVRON_SVG,
  MODEL_COLORS,
  MODEL_TYPE_COLORS,
  NON_MODEL_CATS,
  USER_INPUT_COLORS,
} from '../constants.js';
import { $, esc, fmtPct, fmtTokens } from '../format.js';
import { hasI18nKey, t } from '../i18n.js';
import { state } from '../state.js';

export function computeSessionSpeedStats(s) {
  const avgSpeed = Number(s?.timing?.outputTokPerSec || 0);
  const tl = Array.isArray(s?.timeline) ? s.timeline : [];

  let maxSpeed = Number(s?.timing?.maxTokPerSec || 0);
  if (!maxSpeed && tl.length) {
    let bestQualified = 0;
    let bestAny = 0;
    for (const pt of tl) {
      const rate = Number(pt?.tokPerSec || 0);
      if (rate <= 0) continue;
      if (rate > bestAny) bestAny = rate;
      if ((pt.durationMs || 0) >= 200 && (pt.outputTokens || 0) >= 10 && rate > bestQualified) {
        bestQualified = rate;
      }
    }
    maxSpeed = Math.max(avgSpeed, bestQualified || bestAny || 0);
  }

  let lastCompIdx = -1;
  for (let i = tl.length - 1; i >= 0; i--) {
    if (tl[i]?.compacted) {
      lastCompIdx = i;
      break;
    }
  }
  const postWindow = lastCompIdx >= 0 ? tl.slice(lastCompIdx) : tl;
  const agg = {};
  for (const pt of postWindow) {
    const dur = Number(pt?.durationMs || 0);
    const out = Number(pt?.outputTokens || 0);
    const m = pt?.model || 'default';
    if (dur > 0 && out > 0) {
      if (!agg[m]) agg[m] = { tok: 0, ms: 0 };
      agg[m].tok += out;
      agg[m].ms += dur;
    }
  }
  const postCompactByModel = {};
  for (const [m, v] of Object.entries(agg)) {
    postCompactByModel[m] = v.ms > 0 ? Math.round((v.tok / (v.ms / 1000)) * 10) / 10 : 0;
  }

  return { avgSpeed, maxSpeed, postCompactByModel };
}

export function buildSessionRows(s, ctxLimit) {
  const comp = s.composition || {};
  const catItems = s.categoryItems || {};
  const rows = [];

  for (const c of NON_MODEL_CATS) {
    const value = comp[c.key] || 0;
    const items = Array.isArray(catItems[c.key]) ? catItems[c.key] : [];
    if (value === 0 && items.length === 0) continue;
    rows.push({
      id: `cat:${c.key}`,
      kind: 'category',
      key: c.key,
      label: t(`cat.${c.key}`),
      color: c.color,
      value,
      count: items.length,
      items,
    });
  }

  const models = Array.isArray(s.modelComposition) && s.modelComposition.length
    ? s.modelComposition
    : [{
        model: s.model || 'default',
        total: (comp.thinking || 0) + (comp.assistant_reply || 0),
        thinking: comp.thinking || 0,
        reply: comp.assistant_reply || 0,
        calls: s.modelCalls || 0,
        cacheHitRate: s.totals?.cacheHitRate || 0,
        tokPerSec: s.timing?.outputTokPerSec || 0,
        items: [],
      }];

  const speedStats = computeSessionSpeedStats(s);
  models.forEach((mc, idx) => {
    if (!mc.total && !mc.calls) return;
    const inTok = mc.inputTokens || 0;
    const cacheTok = mc.cacheReadTokens || 0;
    const outTok = mc.outputTokens || 0;
    const postSpeed = mc.postCompactTokPerSec
      || speedStats.postCompactByModel[mc.model]
      || mc.tokPerSec
      || 0;
    rows.push({
      id: `model:${mc.model}`,
      kind: 'model',
      model: mc.model,
      label: mc.model,
      color: MODEL_COLORS[idx % MODEL_COLORS.length],
      value: mc.total || 0,
      count: mc.calls || 0,
      speed: postSpeed,
      avgSpeed: mc.tokPerSec || 0,
      thinking: mc.thinking || 0,
      reply: mc.reply || 0,
      cacheHitRate: mc.cacheHitRate || 0,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      totalTokens: mc.totalTokens || (inTok + cacheTok + outTok),
      typeBreakdown: Array.isArray(mc.typeBreakdown) ? mc.typeBreakdown : null,
      items: Array.isArray(mc.items) ? mc.items : [],
    });
  });

  rows.sort((a, b) => b.value - a.value);

  const usedSum = rows.reduce((a, r) => a + r.value, 0);
  const freeTokens = Math.max(0, ctxLimit - usedSum);
  return { rows, usedSum, freeTokens };
}

export function isBreakdownRowExpandable(r) {
  if (!r) return false;
  if (r.kind === 'model') return true;
  if (r.key === 'system_prompt' || r.key === 'tool_definitions') return false;
  return Array.isArray(r.items) && r.items.length > 0;
}

export function collectExpandableSubIds(rows) {
  const ids = [];
  for (const r of rows) {
    if (r.key !== 'tool_calls' || !Array.isArray(r.items)) continue;
    const top = [...r.items].sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, 16);
    for (const it of top) {
      if (!Array.isArray(it?.children) || !it.children.length) continue;
      if (it.isMcp) ids.push(`mcp:${it.mcpServer || it.label}`);
      else if (it.isCommandGroup) ids.push('cmd:commands');
    }
  }
  return ids;
}

export function renderBreakdownList(rows, freeTokens, ctxLimit) {
  const listEl = $('s-breakdown-list');
  const expandableIds = rows.filter(isBreakdownRowExpandable).map((r) => r.id);
  const expandableSubIds = collectExpandableSubIds(rows);
  const isAllExpanded = () => expandableIds.length > 0
    && expandableIds.every((id) => state.expandedKeys.has(id))
    && expandableSubIds.every((id) => state.expandedItems.has(id));
  $('btn-toggle-all').textContent = t(isAllExpanded() ? 'action.collapseAll' : 'action.expandAll');

  const sortBySizeDesc = (items) => [...items].sort((a, b) => (b.tokens || 0) - (a.tokens || 0));

  const rowHtml = rows.map((r) => {
    const expandable = isBreakdownRowExpandable(r);
    const pct = fmtPct(r.value / ctxLimit, 1);

    if (!expandable) {
      return `
        <div class="bd-row">
          <div class="bd-left">
            <span class="bd-chevron placeholder"></span>
            <span class="bd-dot" style="background:${r.color}"></span>
            <span class="bd-name">${esc(r.label)}</span>
          </div>
          <div class="bd-right">
            <span class="bd-tok">${fmtTokens(r.value)}</span>
            <span class="bd-pct">${pct}</span>
          </div>
        </div>
      `;
    }

    const isOpen = state.expandedKeys.has(r.id);
    let rawItems = r.items || [];
    if (r.key === 'user_messages' && rawItems.length && rawItems.some((it) => !it.group)) {
      const mergedMap = new Map();
      for (const it of rawItems) {
        const mediaN = Number(it.mediaCount || 0);
        const tok = Math.max(0, Number(it.tokens || 0));
        const imgTok = mediaN > 0 ? Math.min(tok, mediaN * 258) : 0;
        const txtTok = Math.max(0, tok - imgTok);
        if (txtTok > 0) {
          const cur = mergedMap.get('text') || { group: 'text', label: 'Text input', count: 0, tokens: 0, tool: 'user', step: 0 };
          cur.count += 1;
          cur.tokens += txtTok;
          mergedMap.set('text', cur);
        }
        if (imgTok > 0) {
          const cur = mergedMap.get('image') || { group: 'image', label: 'Image input', count: 0, tokens: 0, tool: 'user', step: 0 };
          cur.count += mediaN;
          cur.tokens += imgTok;
          mergedMap.set('image', cur);
        }
      }
      rawItems = [...mergedMap.values()];
    }
    const sorted = r.kind === 'model' ? [] : sortBySizeDesc(rawItems);
    const visible = sorted.slice(0, 16);
    const hiddenCount = Math.max(0, sorted.length - visible.length);

    let childrenInner = '';
    if (r.kind === 'model') {
      const typeRows = [
        { type: 'thinking', tokens: Math.max(0, Number(r.thinking || 0)) },
        { type: 'reply', tokens: Math.max(0, Number(r.reply || 0)) },
      ].filter((x) => x.tokens > 0);
      const typeTotal = typeRows.reduce((a, x) => a + x.tokens, 0) || r.value || 1;
      childrenInner += `
        <div class="bd-model-summary">
          <span>${esc(t('model.calls'))} <strong>${r.count || 0}</strong></span>
          <span>${esc(t('model.cache'))} <strong>${fmtPct(r.cacheHitRate, 1)}</strong></span>
          <span>${esc(t('model.speed'))} <strong>${r.speed || 0} tok/s</strong></span>
        </div>
      `;
      if (typeRows.length) {
        childrenInner += typeRows.map((tb) => {
          const dotColor = MODEL_TYPE_COLORS[tb.type] || 'var(--fg-muted)';
          const label = t(`mtype.${tb.type}`);
          return `
            <div class="bd-child">
              <div class="bd-child-main">
                <div class="bd-child-left">
                  <span class="bd-child-dot" style="background:${dotColor}"></span>
                  <span class="bd-child-label">${esc(label)}</span>
                </div>
                <div class="bd-child-right">
                  <span class="bd-child-tok">${fmtTokens(tb.tokens)}</span>
                  <span class="bd-child-pct">${fmtPct(tb.tokens / typeTotal, 1)}</span>
                </div>
              </div>
            </div>
          `;
        }).join('');
      } else {
        childrenInner += `<div class="bd-more">${esc(t('items.empty'))}</div>`;
      }
    } else if (visible.length) {
      childrenInner += visible.map((it) => {
        const isUserRow = r.key === 'user_messages';
        const isSkillRow = r.key === 'skill_injection' || it.tool === 'skill';
        const isToolRow = r.key === 'tool_calls';

        if (isToolRow && (it.isMcp || it.isCommandGroup) && Array.isArray(it.children) && it.children.length > 0) {
          const isCmdGrp = Boolean(it.isCommandGroup);
          const grpName = isCmdGrp ? t('bd.commands') : (it.mcpServer || it.label || 'mcp');
          const subId = isCmdGrp ? 'cmd:commands' : `mcp:${it.mcpServer || it.label || 'mcp'}`;
          const subOpen = state.expandedItems.has(subId);
          const grpBadge = isCmdGrp
            ? '<span class="bd-child-tag cmd">CMD</span>'
            : '<span class="bd-child-tag mcp">MCP</span>';
          const grpCountPill = it.count > 1 ? `<span class="bd-child-tag">×${it.count}</span>` : '';
          const grpErrPill = it.failedCount > 0
            ? `<span class="bd-child-tag err">${esc(it.failedCount > 1 ? `${t('trace.error')} ×${it.failedCount}` : t('trace.error'))}</span>`
            : '';
          const subChildrenHtml = sortBySizeDesc(it.children).map((ch) => {
            const chFailed = ch.failed || ch.status === 'ERROR';
            const chName = isCmdGrp ? (ch.commandName || ch.label || '') : (ch.mcpTool || ch.label || '');
            let chPill = '';
            if (chFailed) {
              const errTxt = ch.count > 1 ? `${t('trace.error')} ×${ch.count}` : t('trace.error');
              chPill = `<span class="bd-child-tag err">${esc(errTxt)}</span>`;
            } else if (ch.count > 1) {
              chPill = `<span class="bd-child-tag">×${ch.count}</span>`;
            }
            return `
              <div class="bd-child bd-grandchild">
                <div class="bd-child-main">
                  <div class="bd-child-left">
                    ${!isCmdGrp && ch.isMcpSchema ? '<span class="bd-child-tag schema">schema</span>' : ''}
                    <span class="bd-child-label mono" title="${esc(chName)}">${esc(chName)}</span>
                    ${chPill}
                  </div>
                  <div class="bd-child-right">
                    <span class="bd-child-tok">+${fmtTokens(ch.tokens)}</span>
                  </div>
                </div>
              </div>
            `;
          }).join('');

          return `
            <div class="bd-sub-group${isCmdGrp ? ' cmd-group' : ''}${subOpen ? ' open' : ''}" data-sub-id="${esc(subId)}">
              <button type="button" class="bd-child bd-sub-row" aria-expanded="${subOpen}">
                <div class="bd-child-main">
                  <div class="bd-child-left">
                    ${CHEVRON_SVG}
                    ${grpBadge}
                    <span class="bd-child-label${isCmdGrp ? '' : ' mono'}" title="${esc(grpName)}">${esc(grpName)}</span>
                    ${grpCountPill}
                    ${grpErrPill}
                  </div>
                  <div class="bd-child-right">
                    <span class="bd-child-tok">+${fmtTokens(it.tokens)}</span>
                  </div>
                </div>
              </button>
              <div class="bd-sub-children">${subChildrenHtml}</div>
            </div>
          `;
        }

        const isFailedTool = isToolRow && (it.failed || it.status === 'ERROR');
        const isInjectedRow = r.key === 'injected_content';
        const showToolTag = !isUserRow && !isSkillRow && !isToolRow && !isInjectedRow && it.tool && it.tool !== 'user' && it.tool !== 'system';
        const childLabel = isUserRow && it.group && hasI18nKey(`uinput.${it.group}`)
          ? t(`uinput.${it.group}`)
          : isInjectedRow && it.group && hasI18nKey(`inj.${it.group}`)
            ? t(`inj.${it.group}`)
            : (it.label || '');
        const userDot = isUserRow && it.group
          ? `<span class="bd-child-dot" style="background:${USER_INPUT_COLORS[it.group] || 'var(--green)'}"></span>`
          : '';
        const cmdTag = isToolRow && it.isCommand ? '<span class="bd-child-tag cmd">CMD</span>' : '';
        let countPill = '';
        if (isFailedTool) {
          const errTxt = it.count > 1 ? `${t('trace.error')} ×${it.count}` : t('trace.error');
          countPill = `<span class="bd-child-tag err">${esc(errTxt)}</span>`;
        } else if ((isUserRow || isInjectedRow || isSkillRow || isToolRow) && it.count > 1) {
          countPill = `<span class="bd-child-tag">×${it.count}</span>`;
        } else if (isUserRow && (it.group === 'image' || it.group === 'file') && it.count > 0) {
          countPill = `<span class="bd-child-tag">×${it.count}</span>`;
        }
        return `
          <div class="bd-child">
            <div class="bd-child-main">
              <div class="bd-child-left">
                ${userDot}
                ${cmdTag}
                ${showToolTag ? `<span class="bd-child-tag${it.status === 'ERROR' ? ' err' : ''}">${esc(it.tool)}</span>` : ''}
                <span class="bd-child-label${isToolRow ? ' mono' : ''}" title="${esc(childLabel)}">${esc(childLabel)}</span>
                ${countPill}
              </div>
              <div class="bd-child-right">
                ${it.step ? `<span>#${it.step}</span>` : ''}
                <span class="bd-child-tok">+${fmtTokens(it.tokens)}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');
    } else {
      childrenInner = `<div class="bd-more">${esc(t('items.empty'))}</div>`;
    }

    if (hiddenCount > 0) {
      childrenInner += `<div class="bd-more">${esc(t('items.more', { n: hiddenCount }))}</div>`;
    }

    return `
      <div class="bd-group${isOpen ? ' open' : ''}" data-group-id="${esc(r.id)}">
        <button type="button" class="bd-row clickable" aria-expanded="${isOpen}">
          <div class="bd-left">
            ${CHEVRON_SVG}
            <span class="bd-dot" style="background:${r.color}"></span>
            <span class="bd-name${r.kind === 'model' ? ' mono' : ''}">${esc(r.label)}</span>
            ${r.kind !== 'model' && r.count > 0 ? `<span class="bd-count">${r.count}</span>` : ''}
            ${r.kind === 'model' && r.speed ? `<span class="bd-speed" title="${esc(t('model.postCompactSpeed'))}">${r.speed} tok/s</span>` : ''}
          </div>
          <div class="bd-right">
            <span class="bd-tok">${fmtTokens(r.value)}</span>
            <span class="bd-pct">${pct}</span>
          </div>
        </button>
        <div class="bd-children">${childrenInner}</div>
      </div>
    `;
  }).join('');

  const freeRowHtml = `
    <div class="bd-row free-row">
      <div class="bd-left">
        <span class="bd-chevron placeholder"></span>
        <span class="bd-dot free"></span>
        <span class="bd-name">${esc(t('cat.free_space'))}</span>
      </div>
      <div class="bd-right">
        <span class="bd-tok">${fmtTokens(freeTokens)}</span>
        <span class="bd-pct">${fmtPct(freeTokens / ctxLimit, 1)}</span>
      </div>
    </div>
  `;

  listEl.innerHTML = rowHtml + freeRowHtml;

  listEl.querySelectorAll('.bd-group > .bd-row.clickable').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.bd-group');
      const id = group.dataset.groupId;
      const willOpen = !state.expandedKeys.has(id);
      if (willOpen) state.expandedKeys.add(id);
      else state.expandedKeys.delete(id);
      group.classList.toggle('open', willOpen);
      btn.setAttribute('aria-expanded', String(willOpen));
      $('btn-toggle-all').textContent = t(isAllExpanded() ? 'action.collapseAll' : 'action.expandAll');
    });
  });

  listEl.querySelectorAll('.bd-sub-group > .bd-sub-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = btn.closest('.bd-sub-group');
      const subId = sub.dataset.subId;
      const willOpen = !state.expandedItems.has(subId);
      if (willOpen) state.expandedItems.add(subId);
      else state.expandedItems.delete(subId);
      sub.classList.toggle('open', willOpen);
      btn.setAttribute('aria-expanded', String(willOpen));
      $('btn-toggle-all').textContent = t(isAllExpanded() ? 'action.collapseAll' : 'action.expandAll');
    });
  });
}
