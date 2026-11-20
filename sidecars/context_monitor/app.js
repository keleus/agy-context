/*
 * AGY Context Monitor frontend.
 *
 * Compact, Antigravity-native UI with EN/ZH i18n (default EN):
 *   - Session: Full-window horizontal bar (including free space), expandable
 *     single-row composition list with per-model usage rows, output speed,
 *     context trend, and tabbed Files/Commands/Tools drawer.
 *   - Trace: Full chronological interaction history (Input / Model / Tool calls)
 *     with 3-track timeline strip and master-detail inspector.
 *   - Project / Global: Cross-session telemetry, dynamic time-bucket usage chart,
 *     token & timing breakdowns, per-model usage, activity heatmap, and session cards.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = 'agy-context.settings.v2';

  // ---------- i18n Dictionary (Default: English) ----------
  const I18N = {
    en: {
      'tab.session': 'Session',
      'tab.trace': 'Trace',
      'tab.project': 'Project',
      'tab.global': 'Global',
      'trace.input': 'Input',
      'trace.injected': 'Injected',
      'trace.skill': 'Skill',
      'trace.model': 'Model',
      'trace.tool': 'Tool',
      'trace.system': 'Injected',
      'trace.timeContext': 'Time Context',
      'trace.error': 'Error',
      'trace.follow': 'Follow',
      'trace.followTip': 'Auto-scroll to latest events',
      'trace.latest': 'Latest',
      'trace.search': 'Search tool, args, result…',
      'trace.empty': 'No matching trace events',
      'trace.toolOnly': '(tool calls only)',
      'td.overview': 'Overview',
      'td.preview': 'Preview',
      'td.raw': 'Raw',
      'td.args': 'Args',
      'td.result': 'Result',
      'td.thinking': 'Thinking',
      'td.reply': 'Reply',
      'td.timing': 'Timing',
      'td.reqTiming': 'Request Timing',
      'td.estTtft': 'Est. TTFT',
      'td.genTime': 'Generation',
      'td.throughput': 'Throughput',
      'td.block': 'Block #{n}',
      'td.attachments': 'Attachments',
      'td.source': 'Source',
      'td.status': 'Status',
      'td.turnStep': 'Turn / Step',
      'td.model': 'Model',
      'td.tool': 'Tool',
      'td.tokens': 'Tokens',
      'td.start': 'Started',
      'td.end': 'Ended',
      'td.duration': 'Duration',
      'td.speed': 'Speed',
      'td.copy': 'Copy',
      'td.copied': 'Copied',
      'td.expand': 'Expand',
      'td.collapse': 'Collapse',
      'td.timingUnavailable': 'Completion time is not logged for final replies without tool calls.',
      'td.hostError': 'Host Error',
      'td.loading': 'Loading…',
      'td.noContent': '(empty)',
      'live.ok': 'Live',
      'live.stale': 'Reconnecting',
      'live.generating': 'Generating',
      'live.tools': 'Tools',
      'hooks.title': 'Turn Execution',
      'hooks.turnsCount': '{n} turns',
      'hooks.avgTurn': 'Avg Turn',
      'hooks.maxTurn': 'max {v}',
      'hooks.loopDepth': 'Loop Depth',
      'hooks.callsPerTurn': 'calls / turn',
      'hooks.toolErrors': 'Tool Errors',
      'hooks.toolCallsSub': 'of {n} calls',
      'hooks.reason.NO_TOOL_CALL': 'Done',
      'hooks.reason.USER_CANCELED': 'Canceled',
      'hooks.reason.ERROR': 'Error',
      'hooks.reason.MAX_INVOCATIONS': 'Max Steps',
      'hooks.reason.MAX_TOKEN_BUDGET_EXCEEDED': 'Token Cap',
      'hooks.reason.TERMINAL_STEP_TYPE': 'Terminal',
      'inspect.viewing': 'Inspecting',
      'inspect.open': 'Open',
      'inspect.back': 'Back to current',
      'empty.noDataTitle': 'Waiting for session context…',
      'empty.noDataDesc': 'Send a message to inspect live context occupancy, composition, and model telemetry.',
      'empty.noConvTitle': 'No active conversation detected',
      'empty.noConvDesc': 'Open this panel in an Antigravity conversation sidebar, or switch to Overview.',
      'empty.gotoOverview': 'View Global Overview',
      'unit.tokens': 'tokens',
      'session.free': 'free',
      'session.cached': 'cached',
      'session.composition': 'Context Breakdown',
      'session.trend': 'Context Trend',
      'session.recentTrace': 'Recent Trace',
      'session.recentCount': 'latest {n} of {total}',
      'session.limitDefault': 'Default session ceiling (500k)',
      'session.limitCompacted': 'Observed from 1st compaction ({v})',
      'session.limitExtended': 'Auto-extended without compaction (peak {v})',
      'session.compacted': '{n} compacted',
      'session.turnsSteps': '{turns} turns · {steps} steps',
      'sort.byTokens': 'Size',
      'sort.byStep': 'Order',
      'sort.count': 'Count',
      'sort.recent': 'Recent',
      'sort.tokens': 'Tokens',
      'sort.context': 'Context',
      'action.expandAll': 'Expand all',
      'action.collapseAll': 'Collapse',
      'action.cancel': 'Cancel',
      'action.save': 'Save',
      'kpi.totalTokens': 'Total Tokens',
      'kpi.cacheRead': 'Cache Read',
      'kpi.output': 'Output',
      'kpi.activeTime': 'Active Time',
      'kpi.ioSub': 'In {in} · Out {out}',
      'kpi.hitSub': '{pct} hit rate',
      'kpi.callsSub': '{calls} calls · {tools} tools',
      'trend.stacked': 'Stacked',
      'trend.line': 'Curve',
      'trend.calls': '{n} calls',
      'act.files': 'Files',
      'act.commands': 'Commands',
      'act.tools': 'Tools',
      'act.all': 'All',
      'act.read': 'Read',
      'act.edit': 'Edit',
      'act.write': 'Write',
      'act.ok': 'OK',
      'act.failed': 'Failed',
      'act.noFiles': 'No file activity yet',
      'act.noCmds': 'No commands executed yet',
      'act.noTools': 'No tool calls yet',
      'cat.system_prompt': 'System prompt',
      'cat.tool_definitions': 'System tools',
      'cat.skill_injection': 'Skills',
      'cat.user_messages': 'User messages',
      'cat.tool_calls': 'Tool results',
      'cat.injected_content': 'Injected context',
      'cat.thinking': 'Thinking',
      'cat.assistant_reply': 'Replies',
      'cat.free_space': 'Free space',
      'time.modelWaitMs': 'Model wait',
      'time.thinkingMs': 'Thinking',
      'time.replyMs': 'Reply gen',
      'time.toolArgsMs': 'Tool args',
      'time.toolExecMs': 'Tool exec',
      'time.otherMs': 'Overhead',
      'range.today': 'Today',
      'range.7d': '7d',
      'range.30d': '30d',
      'range.all': 'All',
      'ov.clearDate': 'Click to clear date filter',
      'ov.sessions': 'Sessions',
      'ov.tokens': 'Tokens',
      'ov.output': 'Output',
      'ov.cache': 'Cache Hit',
      'legend.cached': 'Cached',
      'legend.uncached': 'New In + Out',
      'tip.newIn': 'New In',
      'tip.cacheRead': 'Cached',
      'tip.out': 'Out',
      'ov.tools': 'Tool Calls',
      'ov.duration': 'Active Time',
      'ov.daily': 'Usage',
      'usage.hour': 'Today · Hourly',
      'usage.dateHour': '{date} · Hourly',
      'usage.7d': '7-Day Usage',
      'usage.30d': '30-Day Usage',
      'usage.day': 'Usage · Daily',
      'usage.week': 'Usage · Weekly',
      'usage.month': 'Usage · Monthly',
      'usage.year': 'Usage · Yearly',
      'usage.clickDay': 'Click bar to inspect hourly usage',
      'ov.tokenStats': 'Token Breakdown',
      'ov.timingStats': 'Time Breakdown',
      'ov.activity': 'Activity',
      'ov.clickDate': 'Click day to filter',
      'ov.less': 'Less',
      'ov.more': 'More',
      'ov.skills': 'Skills',
      'ov.toolUsage': 'Tools',
      'ov.cmdUsage': 'Commands',
      'ov.searchSkills': 'Filter skills…',
      'ov.searchSessions': 'Search title, workspace, message…',
      'ov.allTotal': '{n} total',
      'ov.turns': '{n} turns',
      'ov.pricedSessions': '{n} sessions',
      'ov.cachedSessions': '{n} cached',
      'ov.toolExec': 'exec {dur}',
      'ov.modelCalls': '{n} calls',
      'ov.speed': '{v} tok/s',
      'ov.skillsSub': '{u} skills · {c} loads',
      'ov.toolsSub': '{u} tools · {c} calls',
      'ov.cmdsSub': '{u} bins · {c} runs',
      'ov.noSkills': 'No skills loaded',
      'ov.noMatchSkills': 'No matching skills',
      'ov.noTools': 'No tool calls',
      'ov.noCmds': 'No commands run',
      'ov.noSessions': 'No matching sessions',
      'ov.current': 'Current',
      'ov.open': 'Open',
      'ov.lastMsg': 'Last',
      'models.title': 'Models',
      'models.count': '{n} models',
      'models.callsOnly': '{c} calls',
      'models.sessionsCalls': '{s}s · {c} calls',
      'models.noModels': 'No model calls yet',
      'hm.weeks': '{n}w',
      'model.thinking': 'Thinking',
      'model.replies': 'Replies',
      'model.cache': 'Cache',
      'model.speed': 'Speed',
      'model.calls': 'Calls',
      'step.label': 'Step #{step}',
      'step.turn': 'Turn {turn}',
      'step.prompt': 'Context',
      'step.output': 'Out',
      'step.compacted': 'Compacted',
      'items.more': '+{n} more items',
      'items.empty': 'No itemized records',
      'settings.title': 'Settings',
      'settings.lang': 'Language',
      'settings.currency': 'Currency',
      'settings.rate': 'USD → CNY Rate',
      'settings.poll': 'Refresh Interval',
      'settings.defaultTab': 'Default View',
      'settings.models': 'Model Context Windows (tokens)',
      'settings.modelsHint': 'Antigravity does not expose its runtime compaction threshold (e.g. 512K) to plugins. Override each model\'s effective limit here.',
      'settings.reset': 'Reset',
      'settings.colModel': 'Prefix',
      'settings.colWin': 'Context Window',
      'settings.checkUpdate': 'Check updates',
      'update.checking': 'Checking GitHub…',
      'update.upToDate': 'Up to date (v{ver})',
      'update.available': 'New version v{latest} available! Update via:',
      'update.noRepo': 'Set "repository" in plugin.json to enable GitHub update checks.',
      'update.error': 'Could not reach GitHub.',
      'hm.mon': 'Mon',
      'hm.wed': 'Wed',
      'hm.fri': 'Fri',
      'hm.tip': '{s} sessions · {t} tokens',
      'hm.tipAction': 'Click to filter by day',
      'rel.now': 'now',
      'rel.m': '{n}m',
      'rel.h': '{n}h',
      'rel.d': '{n}d',
      'rel.mo': '{n}mo',
      'tip.windowShare': '{pct} of context window',
      'tip.usedShare': '{pct} of used context',
    },
    zh: {
      'tab.session': '当前会话',
      'tab.trace': '轨迹',
      'tab.project': '当前项目',
      'tab.global': '全局洞察',
      'trace.input': '输入',
      'trace.injected': '注入',
      'trace.skill': '技能',
      'trace.model': '模型',
      'trace.tool': '工具',
      'trace.system': '注入',
      'trace.timeContext': '时间上下文',
      'trace.error': '错误',
      'trace.follow': '跟随',
      'trace.followTip': '新事件到来时自动滚动到底部',
      'trace.latest': '最新',
      'trace.search': '搜索工具、参数或结果…',
      'trace.empty': '暂无匹配的调用记录',
      'trace.toolOnly': '（仅工具调用）',
      'td.overview': '概述',
      'td.preview': '预览',
      'td.raw': '原始内容',
      'td.args': '参数',
      'td.result': '结果',
      'td.thinking': '思考',
      'td.reply': '回复',
      'td.timing': '计时',
      'td.reqTiming': '请求计时',
      'td.estTtft': '预估首字延迟',
      'td.genTime': '生成耗时',
      'td.throughput': '吞吐量',
      'td.block': '块 #{n}',
      'td.attachments': '附件',
      'td.source': '来源',
      'td.status': '状态',
      'td.turnStep': '轮次 / 步骤',
      'td.model': '模型',
      'td.tool': '工具',
      'td.tokens': 'Token',
      'td.start': '开始时间',
      'td.end': '结束时间',
      'td.duration': '耗时',
      'td.speed': '速度',
      'td.copy': '复制',
      'td.copied': '已复制',
      'td.expand': '展开',
      'td.collapse': '收起',
      'td.timingUnavailable': '无工具调用的最终回复未在日志中记录结束时间，无法精确计算耗时与吞吐。',
      'td.hostError': '宿主报错',
      'td.loading': '加载中…',
      'td.noContent': '（无内容）',
      'live.ok': '实时',
      'live.stale': '重连中',
      'live.generating': '生成中',
      'live.tools': '工具中',
      'hooks.title': '轮次与执行',
      'hooks.turnsCount': '已记录 {n} 轮',
      'hooks.avgTurn': '单轮均值',
      'hooks.maxTurn': '最长 {v}',
      'hooks.loopDepth': '平均步深',
      'hooks.callsPerTurn': '次调用 / 轮',
      'hooks.toolErrors': '工具异常',
      'hooks.toolCallsSub': '共 {n} 次调用',
      'hooks.reason.NO_TOOL_CALL': '正常完成',
      'hooks.reason.USER_CANCELED': '手动中断',
      'hooks.reason.ERROR': '异常终止',
      'hooks.reason.MAX_INVOCATIONS': '步数上限',
      'hooks.reason.MAX_TOKEN_BUDGET_EXCEEDED': 'Token 上限',
      'hooks.reason.TERMINAL_STEP_TYPE': '终态结束',
      'inspect.viewing': '查看历史',
      'inspect.open': '打开会话',
      'inspect.back': '返回当前',
      'empty.noDataTitle': '等待会话上下文数据…',
      'empty.noDataDesc': '发送一条消息后，这里将实时显示上下文占用百分比、组成明细与模型速度。',
      'empty.noConvTitle': '未检测到当前会话',
      'empty.noConvDesc': '请在 Antigravity 会话右侧面板打开，或切换到全局洞察查看历史会话。',
      'empty.gotoOverview': '查看全局洞察',
      'unit.tokens': 'tokens',
      'session.free': '剩余',
      'session.cached': '缓存命中',
      'session.composition': '上下文组成',
      'session.trend': '上下文趋势',
      'session.recentTrace': '最新轨迹',
      'session.recentCount': '最新 {n} / 共 {total} 条',
      'session.limitDefault': '默认会话上限（500k）',
      'session.limitCompacted': '按首次压缩上限自适应（{v}）',
      'session.limitExtended': '超出未压缩，已自动延长上限（峰值 {v}）',
      'session.compacted': '压缩 {n} 次',
      'session.turnsSteps': '{turns} 轮 · {steps} 步',
      'sort.byTokens': '按大小',
      'sort.byStep': '按顺序',
      'sort.count': '次数',
      'sort.recent': '最近',
      'sort.tokens': 'Token',
      'sort.context': 'Context',
      'action.expandAll': '全部展开',
      'action.collapseAll': '全部收起',
      'action.cancel': '取消',
      'action.save': '保存',
      'kpi.totalTokens': '累计 Token',
      'kpi.cacheRead': '缓存读取',
      'kpi.output': '输出 Token',
      'kpi.activeTime': '活跃时长',
      'kpi.ioSub': '入 {in} · 出 {out}',
      'kpi.hitSub': '命中率 {pct}',
      'kpi.callsSub': '{calls} 次调用 · {tools} 工具',
      'trend.stacked': '堆叠',
      'trend.line': '曲线',
      'trend.calls': '{n} 次调用',
      'act.files': '文件',
      'act.commands': '命令',
      'act.tools': '工具',
      'act.all': '全部',
      'act.read': '读取',
      'act.edit': '编辑',
      'act.write': '写入',
      'act.ok': '成功',
      'act.failed': '失败',
      'act.noFiles': '暂无文件操作',
      'act.noCmds': '暂无命令执行',
      'act.noTools': '暂无工具调用',
      'cat.system_prompt': '系统提示词',
      'cat.tool_definitions': '工具定义',
      'cat.skill_injection': '技能注入',
      'cat.user_messages': '用户消息',
      'cat.tool_calls': '工具结果',
      'cat.injected_content': '注入内容',
      'cat.thinking': '模型思考',
      'cat.assistant_reply': '模型回复',
      'cat.free_space': '空闲空间',
      'time.modelWaitMs': '模型等待',
      'time.thinkingMs': '模型思考',
      'time.replyMs': '回复生成',
      'time.toolArgsMs': '工具参数',
      'time.toolExecMs': '工具执行',
      'time.otherMs': '其他开销',
      'range.today': '今天',
      'range.7d': '近7天',
      'range.30d': '近30天',
      'range.all': '全部',
      'ov.clearDate': '点击清除单日筛选',
      'ov.sessions': '会话',
      'ov.tokens': 'Token',
      'ov.output': '输出 Token',
      'ov.cache': '缓存命中',
      'legend.cached': '缓存命中',
      'legend.uncached': '新增入+出',
      'tip.newIn': '新增输入',
      'tip.cacheRead': '缓存命中',
      'tip.out': '输出',
      'ov.tools': '工具调用',
      'ov.duration': '活跃时长',
      'ov.daily': '用量趋势',
      'usage.hour': '今日每小时用量',
      'usage.dateHour': '{date} · 每小时用量',
      'usage.7d': '近 7 天用量',
      'usage.30d': '近 30 天用量',
      'usage.day': '用量趋势 · 按天',
      'usage.week': '用量趋势 · 按周',
      'usage.month': '用量趋势 · 按月',
      'usage.year': '用量趋势 · 按年',
      'usage.clickDay': '点击柱条查看当日小时明细',
      'ov.tokenStats': 'Token 统计',
      'ov.timingStats': '耗时统计',
      'ov.activity': '活跃度',
      'ov.clickDate': '点击按日期筛选',
      'ov.less': '少',
      'ov.more': '多',
      'ov.skills': '技能加载',
      'ov.toolUsage': '工具调用',
      'ov.cmdUsage': '命令执行',
      'ov.searchSkills': '筛选技能…',
      'ov.searchSessions': '搜索标题 / 工作区 / 消息…',
      'ov.allTotal': '总计 {n} 个',
      'ov.turns': '{n} 轮',
      'ov.pricedSessions': '计价 {n} 会话',
      'ov.cachedSessions': '含 {n} 会话',
      'ov.toolExec': '执行 {dur}',
      'ov.modelCalls': '{n} 次调用',
      'ov.speed': '速度 {v} tok/s',
      'ov.skillsSub': '{u} 技能 · {c} 次加载',
      'ov.toolsSub': '{u} 工具 · {c} 次调用',
      'ov.cmdsSub': '{u} 程序 · {c} 次执行',
      'ov.noSkills': '暂无技能加载',
      'ov.noMatchSkills': '无匹配技能',
      'ov.noTools': '暂无工具调用',
      'ov.noCmds': '暂无命令执行',
      'ov.noSessions': '暂无匹配会话',
      'ov.current': '当前',
      'ov.open': '打开',
      'ov.lastMsg': '最后',
      'models.title': '模型用量',
      'models.count': '{n} 个模型',
      'models.callsOnly': '{c} 次调用',
      'models.sessionsCalls': '{s} 会话 · {c} 次',
      'models.noModels': '暂无模型调用',
      'hm.weeks': '近 {n} 周',
      'model.thinking': '思考',
      'model.replies': '回复',
      'model.cache': '缓存',
      'model.speed': '速度',
      'model.calls': '调用',
      'step.label': '步骤 #{step}',
      'step.turn': '第 {turn} 轮',
      'step.prompt': '上下文',
      'step.output': '输出',
      'step.compacted': '已压缩',
      'items.more': '还有 {n} 项',
      'items.empty': '暂无明细条目',
      'settings.title': '插件设置',
      'settings.lang': '界面语言',
      'settings.currency': '计费货币',
      'settings.rate': 'USD → CNY 汇率',
      'settings.poll': '刷新间隔',
      'settings.defaultTab': '默认视图',
      'settings.models': '模型上下文窗口（tokens）',
      'settings.modelsHint': 'Antigravity 暂未向插件暴露运行时的压缩阈值（如 512K），可在此手动设置各模型的实际生效上限。',
      'settings.reset': '恢复默认',
      'settings.colModel': '模型前缀',
      'settings.colWin': '上下文窗口',
      'settings.checkUpdate': '检查更新',
      'update.checking': '正在检查 GitHub 更新…',
      'update.upToDate': '已是最新版本 (v{ver})',
      'update.available': '发现新版本 v{latest}，可使用以下命令更新：',
      'update.noRepo': '请在 plugin.json 中填写 GitHub repository 字段以启用远端版本检查。',
      'update.error': '无法连接 GitHub 检查更新。',
      'hm.mon': '周一',
      'hm.wed': '周三',
      'hm.fri': '周五',
      'hm.tip': '{s} 会话 · {t} tokens',
      'hm.tipAction': '点击按该日筛选',
      'rel.now': '刚刚',
      'rel.m': '{n}分前',
      'rel.h': '{n}时前',
      'rel.d': '{n}天前',
      'rel.mo': '{n}月前',
      'tip.windowShare': '占总窗口 {pct}',
      'tip.usedShare': '占已用上下文 {pct}',
    },
  };

  const NON_MODEL_CATS = [
    { key: 'system_prompt', color: 'var(--slate-ink)' },
    { key: 'tool_definitions', color: 'var(--amber)' },
    { key: 'skill_injection', color: 'var(--pink)' },
    { key: 'user_messages', color: 'var(--green)' },
    { key: 'tool_calls', color: 'var(--cyan)' },
    { key: 'injected_content', color: 'var(--blue)' },
  ];

  const ALL_OVERVIEW_CATS = [
    ...NON_MODEL_CATS,
    { key: 'thinking', color: 'var(--violet)' },
    { key: 'assistant_reply', color: 'var(--rose)' },
  ];

  const MODEL_COLORS = ['var(--violet)', 'var(--rose)', '#14b8a6', '#f97316'];

  const TIMING_META = [
    { key: 'modelWaitMs', color: 'var(--blue)' },
    { key: 'thinkingMs', color: 'var(--violet)' },
    { key: 'replyMs', color: 'var(--rose)' },
    { key: 'toolArgsMs', color: 'var(--amber)' },
    { key: 'toolExecMs', color: 'var(--cyan)' },
    { key: 'otherMs', color: 'var(--green)' },
  ];

  const BAR_PALETTE = ['var(--blue)', 'var(--cyan)', 'var(--green)', 'var(--amber)', 'var(--violet)', 'var(--pink)', 'var(--rose)'];

  const DEFAULT_SESSION_CTX_LIMIT = 500_000;

  function loadSettings() {
    const base = {
      lang: 'en',
      pollMs: 1500,
      defaultTab: 'session',
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw);
      return {
        ...base,
        lang: parsed.lang === 'zh' ? 'zh' : 'en',
        pollMs: Math.max(1000, Number(parsed.pollMs) || 1500),
        defaultTab: parsed.defaultTab || 'session',
      };
    } catch {
      return base;
    }
  }

  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }

  const params = new URLSearchParams(location.search);
  const settings = loadSettings();

  function t(key, vars = null) {
    const dict = I18N[settings.lang] || I18N.en;
    let str = dict[key] ?? I18N.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, String(v));
      }
    }
    return str;
  }

  function applyStaticI18n() {
    document.documentElement.lang = settings.lang === 'zh' ? 'zh-CN' : 'en';
    $('btn-lang').textContent = settings.lang === 'zh' ? '简' : 'EN';
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
  }

  const IS_TRACE_PANE = location.pathname.replace(/\/+$/, '').endsWith('/trace')
    || params.get('view') === 'trace'
    || params.get('tab') === 'trace';

  function normalizeTabParam(raw) {
    if (IS_TRACE_PANE) return 'trace';
    if (raw === 'project' || raw === 'global' || raw === 'session') return raw;
    if (raw === 'overview') return 'global';
    return null;
  }

  const state = {
    tab: IS_TRACE_PANE ? 'trace' : (normalizeTabParam(params.get('tab')) || normalizeTabParam(settings.defaultTab) || 'session'),
    inspectedConvId: null,
    lastHostConvId: '',
    currentProject: { workspace: '', workspaceUri: '' },
    sessionEtag: '',
    sessionData: null,
    traceEtag: '',
    traceData: null,
    traceEnabled: new Set(['input', 'system', 'skill', 'model', 'tool', 'error']),
    traceQuery: '',
    traceSelectedIdx: null,
    traceDetailTab: 'overview',
    traceThinkingCollapsed: false,
    traceOverviewExpanded: false,
    traceDetailCache: new Map(),
    traceFollow: true,
    traceStick: true,
    traceFirstScroll: true,
    overviewEtag: '',
    overviewData: null,
    // Session interactive state (preserved across live polls!)
    expandedKeys: new Set(),
    expandedItems: new Set(),
    expandedRecent: new Set(),
    trendMode: 'stacked', // 'stacked' | 'line'
    trendSpan: '24', // '24' | 'all'
    // Overview state
    range: '30d',
    selectedDate: '',
    hmMode: 'tokens',
    skillSort: 'count',
    skillQuery: '',
    sessionQuery: '',
    sessionWorkspace: '',
    sessionSort: 'recent',
    liveState: null,
    liveTickTimer: null,
    pollTimer: null,
    inFlight: false,
  };

  // ---------- Theme Sync with Antigravity Host ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Helpers & Formatters ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function hostConvId() {
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  function activeSessionId() {
    return state.inspectedConvId || hostConvId();
  }

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  /**
   * Adaptive per-session context ceiling:
   *  1. Default 500k per session.
   *  2. Once the first compaction occurs, lock to that observed compaction peak.
   *  3. If the session exceeds the current limit without compacting, auto-extend
   *     cleanly in 100k (or 250k above 1M) steps so occupancy never overflows.
   */
  function resolveSessionContextLimit(s) {
    const firstCompact = Number(s?.compactions?.[0]?.from || s?.firstCompactionFrom || 0);
    const observedPeak = Math.max(
      Number(s?.currentContext || 0),
      Number(s?.peakContext || 0),
      Number(s?.lastPromptTokens || 0),
    );
    let limit = firstCompact > 0 ? firstCompact : DEFAULT_SESSION_CTX_LIMIT;
    let source = firstCompact > 0 ? 'compaction' : 'default';

    if (observedPeak > limit) {
      const step = observedPeak > 1_000_000 ? 250_000 : 100_000;
      limit = Math.ceil(observedPeak / step) * step;
      source = 'extended';
    }
    return { limit, source, observedPeak, firstCompact };
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2).replace(/\.00$/, '')}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(Math.round(v));
  }

  function fmtPct(ratio, digits = 1) {
    const p = (Number(ratio) || 0) * 100;
    if (p <= 0) return '0%';
    if (p < 0.1) return '<0.1%';
    return `${p.toFixed(digits)}%`;
  }

  function fmtDur(ms) {
    const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h${rm}m` : `${h}h`;
  }

  function fmtRelative(ms) {
    if (!ms) return '';
    const diff = Math.max(0, Date.now() - ms);
    const s = Math.floor(diff / 1000);
    if (s < 60) return t('rel.now');
    const m = Math.floor(s / 60);
    if (m < 60) return t('rel.m', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('rel.h', { n: h });
    const d = Math.floor(h / 24);
    if (d < 30) return t('rel.d', { n: d });
    return t('rel.mo', { n: Math.floor(d / 30) });
  }

  function fmtDateShort(dateKey) {
    return dateKey && dateKey.length >= 10 ? dateKey.slice(5) : (dateKey || '');
  }

  // ---------- Tooltip ----------
  const tipEl = $('tooltip');
  function showTip(evt, html) {
    tipEl.innerHTML = html;
    tipEl.classList.remove('hidden');
    moveTip(evt);
  }
  function moveTip(evt) {
    const pad = 10;
    const rect = tipEl.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, evt.clientX - rect.width - pad);
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, evt.clientY - rect.height - pad);
    tipEl.style.left = `${x}px`;
    tipEl.style.top = `${y}px`;
  }
  function hideTip() { tipEl.classList.add('hidden'); }

  const CHEVRON_SVG = '<svg class="bd-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';

  // ---------- Build Breakdown Rows (Non-model categories + Per-model rows + Free space) ----------
  function buildSessionRows(s, ctxLimit) {
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

    // Per-model usage rows (replaces generic Thinking & Replies!)
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

    models.forEach((mc, idx) => {
      if (!mc.total && !mc.calls) return;
      rows.push({
        id: `model:${mc.model}`,
        kind: 'model',
        model: mc.model,
        label: mc.model,
        color: MODEL_COLORS[idx % MODEL_COLORS.length],
        value: mc.total || 0,
        count: mc.calls || 0,
        speed: mc.tokPerSec || 0,
        thinking: mc.thinking || 0,
        reply: mc.reply || 0,
        cacheHitRate: mc.cacheHitRate || 0,
        items: Array.isArray(mc.items) ? mc.items : [],
      });
    });

    // Sort all non-free categories strictly descending by token size
    rows.sort((a, b) => b.value - a.value);

    const usedSum = rows.reduce((a, r) => a + r.value, 0);
    const freeTokens = Math.max(0, ctxLimit - usedSum);
    return { rows, usedSum, freeTokens };
  }

  // ---------- Live In-Flight Pill & Hook Execution Card ----------
  function updateLivePill() {
    const pill = $('live-pill');
    const lbl = $('live-label');
    if (!pill || !lbl) return;
    if (pill.classList.contains('stale')) return;

    const ls = state.liveState;
    const isBusy = Boolean(ls && ls.active && !state.inspectedConvId && (state.tab === 'session' || state.tab === 'trace'));
    if (isBusy) {
      const elapsedMs = Math.max(100, Date.now() - (ls.sinceMs || Date.now()));
      const elapsedText = elapsedMs >= 60_000 ? fmtDur(elapsedMs) : `${(elapsedMs / 1000).toFixed(1)}s`;
      const phaseKey = ls.phase === 'tools' ? 'live.tools' : 'live.generating';
      pill.classList.add('busy');
      pill.classList.toggle('phase-tools', ls.phase === 'tools');
      lbl.textContent = `${t(phaseKey)} · ${elapsedText}`;
      if (!state.liveTickTimer) {
        state.liveTickTimer = setInterval(updateLivePill, 250);
      }
    } else {
      pill.classList.remove('busy', 'phase-tools');
      lbl.textContent = t('live.ok');
      if (state.liveTickTimer) {
        clearInterval(state.liveTickTimer);
        state.liveTickTimer = null;
      }
    }
  }

  function setLiveState(ls) {
    state.liveState = ls && ls.active ? ls : null;
    updateLivePill();
  }

  function renderHooksCard(cardEl, metaEl, statsEl, reasonsEl, data) {
    if (!cardEl) return;
    const turnStats = data?.turnStats || data || {};
    const toolStats = data?.toolStats || { calls: data?.toolCalls || 0, errors: data?.toolErrors || 0 };
    const completedTurns = turnStats.completedTurns || 0;
    const toolCalls = toolStats.calls || 0;
    const toolErrors = toolStats.errors || 0;
    const hasData = Boolean(data?.hasData && (completedTurns > 0 || toolCalls > 0));

    cardEl.classList.toggle('hidden', !hasData);
    if (!hasData) return;

    metaEl.textContent = completedTurns > 0 ? t('hooks.turnsCount', { n: completedTurns }) : '';

    const avgTurn = completedTurns > 0 ? fmtDur(turnStats.avgTurnMs || 0) : '—';
    const maxTurnSub = completedTurns > 0 && turnStats.maxTurnMs ? t('hooks.maxTurn', { v: fmtDur(turnStats.maxTurnMs) }) : '';
    const avgDepth = completedTurns > 0 ? String(turnStats.avgInvocations || 0) : '—';
    const errRateText = toolCalls > 0 ? `${Math.round((toolErrors / toolCalls) * 100)}%` : '';
    const errVal = toolCalls > 0 ? `${toolErrors}${errRateText ? ` (${errRateText})` : ''}` : '0';

    statsEl.innerHTML = `
      <div class="hooks-stat-cell">
        <div class="hooks-stat-label">${esc(t('hooks.avgTurn'))}</div>
        <div class="hooks-stat-val">${esc(avgTurn)}</div>
        <div class="hooks-stat-sub">${esc(maxTurnSub)}</div>
      </div>
      <div class="hooks-stat-cell">
        <div class="hooks-stat-label">${esc(t('hooks.loopDepth'))}</div>
        <div class="hooks-stat-val">${esc(avgDepth)}</div>
        <div class="hooks-stat-sub">${esc(t('hooks.callsPerTurn'))}</div>
      </div>
      <div class="hooks-stat-cell">
        <div class="hooks-stat-label">${esc(t('hooks.toolErrors'))}</div>
        <div class="hooks-stat-val${toolErrors > 0 ? ' err' : ' ok'}">${esc(errVal)}</div>
        <div class="hooks-stat-sub">${esc(t('hooks.toolCallsSub', { n: toolCalls }))}</div>
      </div>
    `;

    const reasons = turnStats.reasons || {};
    const reasonEntries = Object.entries(reasons).filter(([, cnt]) => cnt > 0);
    reasonEntries.sort((a, b) => b[1] - a[1]);
    reasonsEl.innerHTML = reasonEntries.map(([code, cnt]) => {
      const i18nKey = `hooks.reason.${code}`;
      const label = (I18N[settings.lang]?.[i18nKey] || I18N.en[i18nKey]) ? t(i18nKey) : code;
      const cls = code === 'NO_TOOL_CALL' ? 'ok'
        : code === 'USER_CANCELED' ? 'warn'
        : code === 'ERROR' ? 'err'
        : '';
      return `<span class="reason-pill ${cls}">${esc(label)} <strong>${cnt}</strong></span>`;
    }).join('');
  }

  // ---------- Shared Per-Model Usage Renderer (Session / Project / Global) ----------
  function renderModelsCard(listEl, barEl, metaEl, modelsList, { showSessions = false } = {}) {
    const items = Array.isArray(modelsList) ? modelsList : [];
    metaEl.textContent = items.length ? t('models.count', { n: items.length }) : '';
    if (!items.length) {
      barEl.classList.add('hidden');
      listEl.innerHTML = `<div class="empty-inline">${esc(t('models.noModels'))}</div>`;
      return;
    }

    const totalAll = items.reduce((a, m) => a + (m.totalTokens || 0), 0) || 1;
    barEl.classList.toggle('hidden', items.length <= 1);
    if (items.length > 1) {
      barEl.innerHTML = items.map((m, idx) => {
        const w = Math.max(1, ((m.totalTokens || 0) / totalAll) * 100);
        const color = MODEL_COLORS[idx % MODEL_COLORS.length];
        return `<div class="ctx-seg" style="width:${w.toFixed(2)}%;background:${color}" title="${esc(m.model)}: ${fmtTokens(m.totalTokens)}"></div>`;
      }).join('');
    }

    listEl.innerHTML = items.map((m, idx) => {
      const color = MODEL_COLORS[idx % MODEL_COLORS.length];
      const callText = showSessions && m.sessions
        ? t('models.sessionsCalls', { s: m.sessions, c: m.calls })
        : t('models.callsOnly', { c: m.calls });
      const tipText = `In ${fmtTokens(m.inputTokens)} · Cache ${fmtTokens(m.cacheReadTokens)} · Out ${fmtTokens(m.outputTokens)}`;
      return `
        <div class="model-stat-row" title="${esc(tipText)}">
          <div class="ms-left">
            <span class="bd-dot" style="background:${color}"></span>
            <span class="ms-name">${esc(m.model)}</span>
            <span class="ms-calls">${esc(callText)}</span>
          </div>
          <div class="ms-metrics">
            <strong>${fmtTokens(m.totalTokens)}</strong>
            <span>${fmtPct(m.cacheHitRate, 0)}</span>
            <span>${m.tokPerSec || 0} tok/s</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ---------- Render Tab 1: Current Session ----------
  function renderSession() {
    const s = state.sessionData;
    const inspecting = !!state.inspectedConvId;

    $('inspect-banner').classList.toggle('hidden', !inspecting);
    if (inspecting && s) {
      $('inspect-title').textContent = s.title || s.conversationId;
      $('btn-open-inspected').classList.toggle('hidden', !window.sidecar?.ui?.toggleConversation);
    }

    if (!s || !s.modelCalls) {
      $('session-content').classList.add('hidden');
      $('session-empty').classList.remove('hidden');
      const hasConv = !!activeSessionId();
      $('session-empty-title').textContent = t(hasConv ? 'empty.noDataTitle' : 'empty.noConvTitle');
      $('session-empty-desc').textContent = t(hasConv ? 'empty.noDataDesc' : 'empty.noConvDesc');
      return;
    }

    $('session-empty').classList.add('hidden');
    $('session-content').classList.remove('hidden');

    const ctxMeta = resolveSessionContextLimit(s);
    const ctxLimit = ctxMeta.limit;
    const { rows, usedSum, freeTokens } = buildSessionRows(s, ctxLimit);
    const used = usedSum || s.currentContext || s.lastPromptTokens || 0;
    const ratio = Math.min(1, used / ctxLimit);
    const speed = s.timing?.outputTokPerSec || 0;

    // Top metadata line: model chip + compactions (if any) + speed
    $('s-model').textContent = s.model || 'default';
    const compList = s.compactions || [];
    const compCount = compList.length;
    const compChip = $('s-compactions');
    compChip.classList.toggle('hidden', compCount === 0);
    if (compCount > 0) {
      compChip.textContent = t('session.compacted', { n: compCount });
      compChip.title = compList
        .map((c) => `#${c.step}: ${fmtTokens(c.from)} → ${fmtTokens(c.to)}`)
        .join('\n');
    } else {
      compChip.title = '';
    }

    $('s-speed-chip').textContent = `${speed} tok/s`;

    // Occupancy headline
    $('s-ctx-used').textContent = fmtTokens(used);
    const limitEl = $('s-ctx-limit');
    limitEl.textContent = fmtTokens(ctxLimit);
    limitEl.title = ctxMeta.source === 'compaction'
      ? t('session.limitCompacted', { v: fmtTokens(ctxMeta.firstCompact) })
      : ctxMeta.source === 'extended'
        ? t('session.limitExtended', { v: fmtTokens(ctxMeta.observedPeak) })
        : t('session.limitDefault');
    $('s-ctx-pct').textContent = fmtPct(ratio, 1);

    // Sub strip (free, cached, turns/steps)
    const lastPoint = s.timeline?.[s.timeline.length - 1];
    const cacheRatio = lastPoint && lastPoint.promptTokens > 0
      ? lastPoint.cacheReadTokens / lastPoint.promptTokens
      : (s.totals?.cacheHitRate || 0);
    $('s-ctx-remain').textContent = fmtTokens(freeTokens);
    $('s-cache-rate').textContent = fmtPct(cacheRatio, 1);
    $('s-turns-steps').textContent = t('session.turnsSteps', { turns: s.turns, steps: s.steps });

    // Full-window horizontal bar (colored segments + Free Space segment!)
    const barEl = $('s-stack-bar');
    const segHtml = rows
      .filter((r) => r.value > 0)
      .map((r) => {
        const winFrac = (r.value / ctxLimit) * 100;
        return `<div class="ctx-seg" data-id="${esc(r.id)}" style="width:${Math.max(0.4, winFrac).toFixed(3)}%;background:${r.color}"></div>`;
      })
      .join('');
    const freeHtml = freeTokens > 0
      ? `<div class="ctx-seg free" data-id="free"></div>`
      : '';
    barEl.innerHTML = segHtml + freeHtml;

    barEl.querySelectorAll('.ctx-seg').forEach((seg) => {
      const id = seg.dataset.id;
      const row = rows.find((r) => r.id === id);
      seg.addEventListener('mouseenter', (e) => {
        if (id === 'free') {
          showTip(e, `<strong>${esc(t('cat.free_space'))}</strong><br>${fmtTokens(freeTokens)} (${fmtPct(freeTokens / ctxLimit, 1)})`);
        } else if (row) {
          showTip(e, `
            <div><strong>${esc(row.label)}</strong> · ${fmtTokens(row.value)}</div>
            <div>${esc(t('tip.windowShare', { pct: fmtPct(row.value / ctxLimit, 2) }))}</div>
            <div style="opacity:.75">${esc(t('tip.usedShare', { pct: fmtPct(row.value / Math.max(1, used), 1) }))}</div>
          `);
        }
      });
      seg.addEventListener('mousemove', moveTip);
      seg.addEventListener('mouseleave', hideTip);
      if (row) {
        seg.addEventListener('click', () => {
          if (state.expandedKeys.has(row.id)) state.expandedKeys.delete(row.id);
          else state.expandedKeys.add(row.id);
          renderBreakdownList(rows, freeTokens, ctxLimit);
        });
      }
    });

    // Expandable single-row composition list
    renderBreakdownList(rows, freeTokens, ctxLimit);

    // Compact 4-Metric Telemetry Strip
    const tot = s.totals || {};
    $('s-total-tokens').textContent = fmtTokens(tot.totalTokens || 0);
    $('s-total-io').textContent = t('kpi.ioSub', {
      in: fmtTokens((tot.inputTokens || 0) + (tot.cacheReadTokens || 0)),
      out: fmtTokens(tot.outputTokens || 0),
    });
    $('s-cache-read').textContent = fmtTokens(tot.cacheReadTokens || 0);
    $('s-cache-sub').textContent = t('kpi.hitSub', { pct: fmtPct(tot.cacheHitRate || 0, 1) });
    $('s-output-tokens').textContent = fmtTokens(tot.outputTokens || 0);
    $('s-calls').textContent = t('kpi.callsSub', { calls: s.modelCalls, tools: s.toolCallsCount });
    $('s-duration').textContent = fmtDur(s.timing?.activeMs || 0);
    $('s-speed').textContent = `${speed} tok/s`;

    // Per-Model Breakdown (Session)
    const sessModels = Array.isArray(s.modelsBreakdown) && s.modelsBreakdown.length
      ? s.modelsBreakdown
      : Object.entries(s.modelsUsed || {}).map(([m, mv]) => {
          const p = (mv.inputTokens || 0) + (mv.cacheReadTokens || 0);
          return {
            model: m,
            ...mv,
            totalTokens: p + (mv.outputTokens || 0),
            cacheHitRate: p > 0 ? (mv.cacheReadTokens || 0) / p : 0,
            tokPerSec: mv.durationMs > 0 ? Math.round(((mv.outputTokens || 0) / (mv.durationMs / 1000)) * 10) / 10 : 0,
          };
        }).sort((a, b) => b.totalTokens - a.totalTokens);
    renderModelsCard($('s-models-list'), $('s-models-bar'), $('s-models-meta'), sessModels, { showSessions: false });

    // Lifecycle Hook Turn & Execution Telemetry (Session)
    renderHooksCard($('s-hooks-card'), $('s-hooks-meta'), $('s-hooks-stats'), $('s-hooks-reasons'), s.hookTelemetry);

    // Context Trend Chart (hover tooltips only, no step box below)
    renderTrendChart(s.timeline || [], ctxLimit);

    // Recent Trace (latest chronological events)
    renderRecentTrace(s);
  }

  function renderBreakdownList(rows, freeTokens, ctxLimit) {
    const listEl = $('s-breakdown-list');
    const expandableIds = rows.map((r) => r.id);
    const allOpen = expandableIds.length > 0 && expandableIds.every((id) => state.expandedKeys.has(id));
    $('btn-toggle-all').textContent = t(allOpen ? 'action.collapseAll' : 'action.expandAll');

    const sortBySizeDesc = (items) => [...items].sort((a, b) => (b.tokens || 0) - (a.tokens || 0));

    const rowHtml = rows.map((r) => {
      const isOpen = state.expandedKeys.has(r.id);
      const pct = fmtPct(r.value / ctxLimit, 1);
      const sorted = sortBySizeDesc(r.items || []);
      const visible = sorted.slice(0, 16);
      const hiddenCount = Math.max(0, sorted.length - visible.length);

      let childrenInner = '';
      if (r.kind === 'model') {
        childrenInner += `
          <div class="bd-model-summary">
            <span>${esc(t('model.thinking'))} <strong>${fmtTokens(r.thinking)}</strong></span>
            <span>${esc(t('model.replies'))} <strong>${fmtTokens(r.reply)}</strong></span>
            <span>${esc(t('model.cache'))} <strong>${fmtPct(r.cacheHitRate, 1)}</strong></span>
            <span>${esc(t('model.speed'))} <strong>${r.speed} tok/s</strong></span>
          </div>
        `;
        if (visible.length) {
          childrenInner += visible.map((it, idx) => {
            const itemKey = `${r.id}:${it.step}:${idx}`;
            const hasDetail = !!(it.preview && it.preview.length > 0);
            const itemOpen = hasDetail && state.expandedItems.has(itemKey);
            return `
              <div class="bd-child${hasDetail ? ' has-detail' : ''}${itemOpen ? ' open' : ''}" data-item-key="${esc(itemKey)}">
                <div class="bd-child-main">
                  <div class="bd-child-left">
                    <span class="bd-child-tag">#${it.step}</span>
                    <span class="bd-child-label">${esc(it.preview || `${t('model.thinking')} ${fmtTokens(it.thinkingTokens)} · ${t('model.replies')} ${fmtTokens(it.replyTokens)}`)}</span>
                  </div>
                  <div class="bd-child-right">
                    <span class="bd-child-tok">+${fmtTokens(it.tokens)}</span>
                  </div>
                </div>
                ${hasDetail ? `<div class="bd-child-preview">${esc(it.preview)}</div>` : ''}
              </div>
            `;
          }).join('');
        }
      } else if (visible.length) {
        childrenInner += visible.map((it, idx) => {
          const itemKey = `${r.id}:${it.step || 0}:${it.label || idx}`;
          const previewText = it.preview || (it.detail && it.detail !== it.label ? it.detail : '');
          const hasDetail = !!previewText;
          const itemOpen = hasDetail && state.expandedItems.has(itemKey);
          return `
            <div class="bd-child${hasDetail ? ' has-detail' : ''}${itemOpen ? ' open' : ''}" data-item-key="${esc(itemKey)}">
              <div class="bd-child-main">
                <div class="bd-child-left">
                  ${it.tool && it.tool !== 'user' && it.tool !== 'system' ? `<span class="bd-child-tag${it.status === 'ERROR' ? ' err' : ''}">${esc(it.tool)}</span>` : ''}
                  <span class="bd-child-label">${esc(it.label || '')}</span>
                </div>
                <div class="bd-child-right">
                  ${it.step ? `<span>#${it.step}</span>` : ''}
                  <span class="bd-child-tok">${r.key === 'system_prompt' || r.key === 'tool_definitions' ? '' : '+'}${fmtTokens(it.tokens)}</span>
                </div>
              </div>
              ${hasDetail ? `
                <div class="bd-child-preview">
                  ${it.detail && it.preview && it.detail !== it.preview ? `<div class="bd-child-path">${esc(it.detail)}</div>` : ''}
                  ${esc(previewText)}
                </div>
              ` : ''}
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
              ${r.count > 0 ? `<span class="bd-count">${r.count}</span>` : ''}
              ${r.kind === 'model' && r.speed ? `<span class="bd-speed">${r.speed} tok/s</span>` : ''}
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

    listEl.querySelectorAll('.bd-group .bd-row.clickable').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.bd-group');
        const id = group.dataset.groupId;
        const willOpen = !state.expandedKeys.has(id);
        if (willOpen) state.expandedKeys.add(id);
        else state.expandedKeys.delete(id);
        group.classList.toggle('open', willOpen);
        btn.setAttribute('aria-expanded', String(willOpen));
        const allNow = expandableIds.every((k) => state.expandedKeys.has(k));
        $('btn-toggle-all').textContent = t(allNow ? 'action.collapseAll' : 'action.expandAll');
      });
    });

    listEl.querySelectorAll('.bd-child.has-detail').forEach((child) => {
      child.addEventListener('click', (e) => {
        if (e.target.closest('.bd-child-preview')) return; // allow text selection inside preview
        const key = child.dataset.itemKey;
        const willOpen = !state.expandedItems.has(key);
        if (willOpen) state.expandedItems.add(key);
        else state.expandedItems.delete(key);
        child.classList.toggle('open', willOpen);
      });
    });
  }

  function renderTrendChart(allPoints) {
    const el = $('s-timeline-chart');
    $('s-timeline-meta').textContent = t('trend.calls', { n: allPoints.length });
    if (!allPoints.length) {
      el.innerHTML = `<div class="empty-inline">${esc(t('items.empty'))}</div>`;
      return;
    }

    const offset = state.trendSpan === '24' && allPoints.length > 24 ? allPoints.length - 24 : 0;
    const points = allPoints.slice(offset);

    const W = 400;
    const H = 112;
    const padL = 36;
    const padR = 10;
    const padT = 10;
    const padB = 20;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxTok = Math.max(...points.map((p) => p.promptTokens), 1000);
    const yMax = Math.max(maxTok * 1.12, 1000);
    const yOf = (v) => padT + plotH - (Math.min(yMax, Math.max(0, v)) / yMax) * plotH;

    const yTicks = [0, 0.5, 1].map((f) => ({
      y: padT + plotH * (1 - f),
      label: fmtTokens(yMax * f),
    }));

    const stackOrder = [
      { key: 'system', color: 'var(--blue)' },
      { key: 'user', color: 'var(--green)' },
      { key: 'skill', color: 'var(--pink)' },
      { key: 'tools', color: 'var(--cyan)' },
      { key: 'model', color: 'var(--violet)' },
    ];

    let seriesSvg = '';
    if (state.trendMode === 'stacked') {
      const slotW = plotW / points.length;
      const barW = Math.min(16, Math.max(3, slotW * 0.72));
      seriesSvg = points.map((p, i) => {
        const globalIdx = offset + i;
        const cx = padL + slotW * i + slotW / 2;
        const x = cx - barW / 2;
        const b = p.buckets || { system: 0, user: 0, skill: 0, tools: p.promptTokens, model: 0 };
        let cum = 0;
        const rects = [];
        for (const s of stackOrder) {
          const val = b[s.key] || 0;
          if (val <= 0) continue;
          const y1 = yOf(cum + val);
          const y0 = yOf(cum);
          const h = Math.max(0.8, y0 - y1);
          rects.push(`<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"/>`);
          cum += val;
        }
        return `
          <g class="trend-hit" data-gidx="${globalIdx}">
            <rect x="${(padL + slotW * i).toFixed(1)}" y="${padT}" width="${slotW.toFixed(1)}" height="${plotH}" fill="transparent"/>
            ${rects.join('')}
            ${p.compacted ? `<circle cx="${cx.toFixed(1)}" cy="${Math.max(padT + 4, yOf(p.promptTokens) - 5).toFixed(1)}" r="2.8" fill="var(--amber)"/>` : ''}
          </g>
        `;
      }).join('');
    } else {
      const xOf = (i) => (points.length === 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW);
      const coords = points.map((p, i) => [xOf(i), yOf(p.promptTokens)]);
      const lineD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      const areaD = `${lineD} L${coords[coords.length - 1][0].toFixed(1)},${(padT + plotH).toFixed(1)} L${coords[0][0].toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
      seriesSvg = `
        <defs>
          <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--cyan)" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="var(--cyan)" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <path d="${areaD}" fill="url(#trendGrad)"/>
        <path d="${lineD}" fill="none" stroke="var(--cyan)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
        ${points.map((p, i) => {
          const globalIdx = offset + i;
          const [x, y] = coords[i];
          const r = p.compacted ? 3.5 : 2.3;
          const fill = p.compacted ? 'var(--amber)' : 'var(--cyan)';
          return `<circle class="trend-hit" data-gidx="${globalIdx}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" stroke="var(--card)" stroke-width="1.2"/>`;
        }).join('')}
      `;
    }

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}">
        ${yTicks.map((tk) => `
          <line x1="${padL}" y1="${tk.y.toFixed(1)}" x2="${W - padR}" y2="${tk.y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
          <text x="${padL - 4}" y="${(tk.y + 3).toFixed(1)}" text-anchor="end" fill="var(--fg-muted)" font-size="9">${esc(tk.label)}</text>
        `).join('')}
        ${seriesSvg}
        <text x="${padL}" y="${H - 4}" fill="var(--fg-muted)" font-size="9">#${points[0].step}</text>
        <text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="var(--fg-muted)" font-size="9">#${points[points.length - 1].step}</text>
      </svg>
    `;

    el.querySelectorAll('.trend-hit').forEach((node) => {
      const p = allPoints[Number(node.dataset.gidx)];
      node.addEventListener('mouseenter', (e) => {
        const sign = p.delta >= 0 ? '+' : '';
        const cachePct = p.promptTokens > 0 ? fmtPct(p.cacheReadTokens / p.promptTokens, 1) : '0%';
        showTip(e, `
          <div><strong>${esc(t('step.label', { step: p.step }))}</strong> · ${esc(t('step.turn', { turn: p.turn || 1 }))}</div>
          <div>${esc(t('step.prompt'))}: <strong>${fmtTokens(p.promptTokens)}</strong> (${sign}${fmtTokens(p.delta)})</div>
          <div>${esc(t('session.cached'))}: ${cachePct} · ${esc(t('step.output'))}: ${fmtTokens(p.outputTokens)} · ${p.tokPerSec} tok/s</div>
        `);
      });
      node.addEventListener('mousemove', moveTip);
      node.addEventListener('mouseleave', hideTip);
    });
  }

  function isTimeContextItem(it) {
    if (!it || it.kind !== 'system') return false;
    return it.systemBadge === 'time_context'
      || (it.systemType === 'ADDITIONAL_METADATA' && /The current local time is:/i.test(it.preview || it.content || ''));
  }

  function renderModelBadges(it) {
    const badges = [];
    if (it.hasThinking) {
      badges.push(`<span class="tr-think-badge">${esc(t('td.thinking'))}</span>`);
    }
    if ((it.toolCount || 0) > 0) {
      badges.push('<span class="tr-think-badge badge-toolcall">toolcall</span>');
    }
    const hasOut = it.hasReply !== undefined
      ? Boolean(it.hasReply)
      : Boolean(!it.hasThinking && it.preview && it.preview !== t('trace.toolOnly'));
    if (hasOut) {
      badges.push('<span class="tr-think-badge badge-output">output</span>');
    }
    return badges.join('');
  }

  function renderRecentTrace(s) {
    const el = $('s-recent-trace');
    const metaEl = $('s-recent-trace-meta');
    const items = Array.isArray(s.recentTrace) ? s.recentTrace : [];
    const total = s.traceCount || items.length;
    metaEl.textContent = items.length ? t('session.recentCount', { n: items.length, total }) : '';

    if (!items.length) {
      el.innerHTML = `<div class="empty-inline">${esc(t('trace.empty'))}</div>`;
      return;
    }

    const wasNearTop = el.scrollTop <= 24;
    const prevTop = el.scrollTop;
    const newestFirst = [...items].reverse();

    el.innerHTML = newestFirst.map((it) => {
      const dotCls = it.hasError ? 'error' : it.kind;
      let name = '';
      let preview = '';
      let extraBadge = '';
      let rightMeta = `#${it.step}`;

      if (it.kind === 'input') {
        name = t('trace.input');
        preview = it.preview || '';
        rightMeta = `T${it.turn} · #${it.step}`;
      } else if (it.kind === 'system') {
        name = it.systemType || t('trace.injected');
        if (isTimeContextItem(it)) {
          extraBadge = `<span class="tr-think-badge" style="color:var(--blue);background:color-mix(in srgb,var(--blue) 12%,transparent)">${esc(t('trace.timeContext'))}</span>`;
        }
        preview = it.preview || '';
        rightMeta = `#${it.step}`;
      } else if (it.kind === 'skill') {
        name = it.skillName || t('trace.skill');
        extraBadge = `<span class="tr-think-badge" style="color:var(--pink);background:color-mix(in srgb,var(--pink) 12%,transparent)">SKILL</span>`;
        preview = it.resultPreview || '';
        rightMeta = `#${it.step}`;
      } else if (it.kind === 'model') {
        name = it.model || t('trace.model');
        extraBadge = renderModelBadges(it);
        preview = it.preview || '';
        rightMeta = `${fmtTokens(it.outputTokens)} · #${it.step}`;
      } else {
        name = it.toolName || t('trace.tool');
        preview = it.argsPreview
          ? (it.resultPreview ? `${it.argsPreview} → ${it.resultPreview}` : it.argsPreview)
          : (it.resultPreview || '');
        rightMeta = `${it.durationMs ? `${fmtDur(it.durationMs)} · ` : ''}#${it.step}`;
      }

      return `
        <div class="tr-row static">
          <div class="tr-left">
            <span class="tr-dot ${dotCls}"></span>
            <span class="tr-name">${esc(name)}</span>
            ${extraBadge}
            <span class="tr-preview${it.kind === 'tool' ? ' mono' : ''}">${esc(preview)}</span>
          </div>
          <div class="tr-right"><span>${esc(rightMeta)}</span></div>
        </div>
      `;
    }).join('');

    if (wasNearTop) {
      el.scrollTop = 0;
    } else {
      el.scrollTop = prevTop;
    }
  }

  // ---------- Render Tab 2 / 3: Project & Global Overview ----------
  function renderOverview() {
    const d = state.overviewData;
    if (!d) return;

    const isProject = state.tab === 'project';
    const projPill = $('ov-project-pill');
    const projName = d.workspace || state.currentProject.workspace || '';
    projPill.classList.toggle('hidden', !isProject || !projName);
    if (isProject && projName) projPill.textContent = projName;

    const badge = $('ov-date-badge');
    if (state.selectedDate) {
      $('ov-date-range').textContent = `${state.selectedDate} ✕`;
      badge.classList.add('active-filter');
    } else {
      $('ov-date-range').textContent = `${d.startDate} → ${d.endDate}`;
      badge.classList.remove('active-filter');
    }

    const kpi = d.kpi || {};
    $('ov-kpi-sessions').textContent = String(kpi.totalSessions || 0);
    $('ov-kpi-sessions-sub').textContent = t('ov.allTotal', { n: kpi.allSessionsCount || 0 });
    $('ov-kpi-tokens').textContent = fmtTokens(kpi.totalTokens || 0);
    $('ov-kpi-tokens-sub').textContent = t('ov.turns', { n: kpi.totalTurns || 0 });
    $('ov-kpi-output').textContent = fmtTokens(kpi.totalOutput || 0);
    $('ov-kpi-output-sub').textContent = t('ov.speed', { v: d.timing?.outputTokPerSec || 0 });
    $('ov-kpi-cache').textContent = fmtPct(kpi.cacheHitRate || 0, 1);
    $('ov-kpi-cache-sub').textContent = t('ov.cachedSessions', { n: kpi.cachedSessionsCount || 0 });
    $('ov-kpi-tools').textContent = String(kpi.totalToolCalls || 0);
    $('ov-kpi-tools-sub').textContent = t('ov.toolExec', { dur: fmtDur(kpi.toolExecMs || 0) });
    $('ov-kpi-duration').textContent = fmtDur(kpi.activeMs || 0);
    $('ov-kpi-duration-sub').textContent = t('ov.modelCalls', { n: kpi.totalModelCalls || 0 });

    renderUsageChart(d.usageSeries, d.range, state.selectedDate);

    // Token breakdown (compact horizontal bar + 2-col legend — unified with Session view!)
    const cum = d.cumulativeComposition || {};
    const tokSegs = ALL_OVERVIEW_CATS.map((c) => ({ ...c, label: t(`cat.${c.key}`), value: cum[c.key] || 0 }));
    const tokTotal = tokSegs.reduce((a, x) => a + x.value, 0) || 1;
    $('ov-token-total-meta').textContent = fmtTokens(kpi.totalTokens || 0);
    $('ov-token-bar').innerHTML = tokSegs
      .filter((x) => x.value > 0)
      .map((x) => `<div class="ctx-seg" style="width:${((x.value / tokTotal) * 100).toFixed(2)}%;background:${x.color}" title="${esc(x.label)}: ${fmtTokens(x.value)}"></div>`)
      .join('');
    $('ov-token-legend').innerHTML = tokSegs.map((x) => `
      <div class="comp-item" title="${esc(x.label)}: ${fmtTokens(x.value)} (${fmtPct(x.value / tokTotal, 1)})">
        <div class="comp-left">
          <span class="comp-dot" style="background:${x.color}"></span>
          <span class="comp-name">${esc(x.label)}</span>
        </div>
        <div class="comp-right">
          <span class="comp-sub">${fmtTokens(x.value)}</span>
          <span class="comp-pct">${fmtPct(x.value / tokTotal, 1)}</span>
        </div>
      </div>
    `).join('');

    // Timing breakdown
    const tm = d.timing || {};
    $('ov-output-speed').textContent = t('ov.speed', { v: tm.outputTokPerSec || 0 });
    const tmSegs = TIMING_META.map((x) => ({ ...x, label: t(`time.${x.key}`), value: tm[x.key] || 0 }));
    const tmTotal = tmSegs.reduce((a, x) => a + x.value, 0) || 1;
    $('ov-timing-bar').innerHTML = tmSegs
      .filter((x) => x.value > 0)
      .map((x) => `<div class="ctx-seg" style="width:${((x.value / tmTotal) * 100).toFixed(2)}%;background:${x.color}" title="${esc(x.label)}: ${fmtDur(x.value)}"></div>`)
      .join('');
    $('ov-timing-legend').innerHTML = tmSegs.map((x) => `
      <div class="comp-item" title="${esc(x.label)}: ${fmtDur(x.value)} (${fmtPct(x.value / tmTotal, 1)})">
        <div class="comp-left">
          <span class="comp-dot" style="background:${x.color}"></span>
          <span class="comp-name">${esc(x.label)}</span>
        </div>
        <div class="comp-right">
          <span class="comp-sub">${fmtDur(x.value)}</span>
          <span class="comp-pct">${fmtPct(x.value / tmTotal, 1)}</span>
        </div>
      </div>
    `).join('');

    // Per-Model Breakdown (Project / Global)
    renderModelsCard($('ov-models-list'), $('ov-models-bar'), $('ov-models-meta'), d.modelsBreakdown || [], { showSessions: true });

    renderHeatmap(d.heatmap || {}, {
      range: d.range,
      startDate: d.startDate,
      endDate: d.endDate,
      heatmapSpan: d.heatmapSpan,
    });
    renderOverviewSkills(d.skills || []);

    const tools = d.tools || [];
    $('ov-tools-sub').textContent = t('ov.toolsSub', { u: tools.length, c: tools.reduce((a, x) => a + x.count, 0) });
    renderBarList($('ov-tools-list'), tools.slice(0, 7), { empty: t('ov.noTools'), showTime: true });

    const cmds = d.commands || [];
    $('ov-cmds-sub').textContent = t('ov.cmdsSub', { u: cmds.length, c: cmds.reduce((a, x) => a + x.count, 0) });
    renderBarList($('ov-cmds-list'), cmds.slice(0, 7), { empty: t('ov.noCmds'), showTime: true });

    renderHooksCard($('ov-hooks-card'), $('ov-hooks-meta'), $('ov-hooks-stats'), $('ov-hooks-reasons'), d.hookOverview);

    renderSessionsList(d.sessions || [], d.workspaces || {});
  }

  function usageTitleFor(granularity, range, selectedDate) {
    if (selectedDate) return t('usage.dateHour', { date: selectedDate });
    if (range === 'today') return t('usage.hour');
    if (range === '7d') return t('usage.7d');
    if (range === '30d') return t('usage.30d');
    if (granularity === 'hour') return t('usage.hour');
    if (granularity === 'week') return t('usage.week');
    if (granularity === 'month') return t('usage.month');
    if (granularity === 'year') return t('usage.year');
    return t('usage.day');
  }

  function pickVisibleTickIndices(n, maxTicks = 7) {
    const set = new Set();
    if (n <= 0) return set;
    if (n <= maxTicks) {
      for (let i = 0; i < n; i++) set.add(i);
      return set;
    }
    set.add(0);
    set.add(n - 1);
    const step = (n - 1) / (maxTicks - 1);
    for (let k = 1; k < maxTicks - 1; k++) {
      set.add(Math.round(k * step));
    }
    return set;
  }

  function renderUsageChart(series, range, selectedDate) {
    const el = $('ov-daily-chart');
    const gran = series?.granularity || 'day';
    const pts = Array.isArray(series?.points) ? series.points : [];
    $('ov-usage-title').textContent = usageTitleFor(gran, range, selectedDate);

    if (!pts.length) {
      el.innerHTML = `<div class="empty-inline">${esc(t('items.empty'))}</div>`;
      return;
    }

    const W = 440;
    const H = 132;
    const padL = 40;
    const padR = 12;
    const padT = 14;
    const padB = 20;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxTok = Math.max(...pts.map((d) => d.tokens || 0), 1000);
    const n = pts.length;
    const stepW = plotW / n;
    const barW = Math.min(20, Math.max(3, stepW * 0.68));
    const yTicks = [0, 0.5, 1];
    const visibleTicks = pickVisibleTickIndices(n, 7);

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}">
        ${yTicks.map((f) => {
          const y = padT + plotH * (1 - f);
          return `
            <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
            <text x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="var(--fg-muted)" font-size="8.5">${f === 0 ? '0' : esc(fmtTokens(maxTok * f))}</text>
          `;
        }).join('')}
        ${pts.map((d, i) => {
          const cx = padL + stepW * i + stepW / 2;
          const x = cx - barW / 2;
          const tot = d.tokens || 0;
          const cached = Math.min(tot, d.cacheReadTokens || 0);
          const uncached = Math.max(0, tot - cached);
          const hTot = tot > 0 ? Math.max(2, (tot / maxTok) * plotH) : 0;
          const hCached = tot > 0 ? (cached / tot) * hTot : 0;
          const hUncached = Math.max(0, hTot - hCached);
          const yBase = padT + plotH;
          const yCached = yBase - hCached;
          const yTop = yBase - hTot;
          const showLbl = visibleTicks.has(i);
          const lblText = gran === 'hour' ? d.label.slice(0, 2) : d.label;
          return `
            <g class="day-bar-group" data-idx="${i}" style="cursor:${d.dateKey ? 'pointer' : 'default'}">
              <rect x="${(padL + stepW * i).toFixed(1)}" y="${padT}" width="${stepW.toFixed(1)}" height="${plotH}" fill="transparent"/>
              ${hCached > 0 ? `<rect x="${x.toFixed(1)}" y="${yCached.toFixed(1)}" width="${barW.toFixed(2)}" height="${hCached.toFixed(1)}" rx="1.2" fill="var(--blue)"/>` : ''}
              ${hUncached > 0 ? `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(2)}" height="${Math.max(1.2, hUncached).toFixed(1)}" rx="1.2" fill="var(--cyan)"/>` : ''}
              ${showLbl ? `<text x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle" fill="var(--fg-muted)" font-size="8.5">${esc(lblText)}</text>` : ''}
            </g>
          `;
        }).join('')}
      </svg>
    `;

    el.querySelectorAll('.day-bar-group').forEach((g) => {
      const d = pts[Number(g.dataset.idx)];
      g.addEventListener('mouseenter', (e) => {
        showTip(e, `
          <div><strong>${esc(d.fullLabel || d.label)}</strong></div>
          <div>${esc(t('ov.tokens'))}: <strong>${fmtTokens(d.tokens)}</strong></div>
          <div style="opacity:.85">${esc(t('tip.newIn'))} ${fmtTokens(d.inputTokens)} · ${esc(t('tip.cacheRead'))} ${fmtTokens(d.cacheReadTokens)} · ${esc(t('tip.out'))} ${fmtTokens(d.outputTokens)}</div>
          ${d.dateKey ? `<div style="opacity:.7">${esc(t('usage.clickDay'))}</div>` : ''}
        `);
      });
      g.addEventListener('mousemove', moveTip);
      g.addEventListener('mouseleave', hideTip);
      if (d.dateKey) {
        g.addEventListener('click', () => toggleDateFilter(d.dateKey));
      }
    });
  }

  function renderHeatmap(heatmap, { range = '30d', startDate = '', endDate = '', heatmapSpan = null } = {}) {
    const el = $('ov-heatmap');
    const cell = 12;
    const gap = 3;
    const padL = 28;
    const padT = 14;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDow = (today.getDay() + 6) % 7;

    // Adapt heatmap width cleanly:
    // - today / 7d / 30d: recent 12 weeks, visually highlighting the active date range
    // - all: span from earliest active date to today (min 12w, capped at 52w = 1 year)
    let weeks = 12;
    if (range === 'all' && heatmapSpan?.minDate) {
      const [y, m, d] = heatmapSpan.minDate.split('-').map(Number);
      const minDt = new Date(y, (m || 1) - 1, d || 1);
      const diffDays = Math.max(0, Math.round((today.getTime() - minDt.getTime()) / 86_400_000));
      weeks = Math.min(52, Math.max(12, Math.ceil((diffDays + todayDow + 1) / 7)));
    }
    $('ov-heatmap-meta').textContent = t('hm.weeks', { n: weeks });

    const start = new Date(today);
    start.setDate(today.getDate() - (weeks - 1) * 7 - todayDow);

    const cells = [];
    let maxVal = 0;
    const monthLabels = new Map();
    const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const highlightRange = range !== 'all' && !state.selectedDate && startDate && endDate;

    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start);
        dt.setDate(start.getDate() + w * 7 + d);
        if (dt > today) continue;
        const dk = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        const entry = heatmap[dk] || { sessions: 0, tokens: 0 };
        const val = state.hmMode === 'sessions' ? entry.sessions : entry.tokens;
        if (val > maxVal) maxVal = val;
        if (dt.getDate() <= 7 && !monthLabels.has(w)) {
          const mLabel = settings.lang === 'zh' ? `${dt.getMonth() + 1}月` : monthsEn[dt.getMonth()];
          if (monthLabels.get(w - 1) !== mLabel) monthLabels.set(w, mLabel);
        }
        const outOfRange = highlightRange ? (dk < startDate || dk > endDate) : false;
        cells.push({ w, d, dk, val, entry, outOfRange });
      }
    }

    const levelOf = (v) => {
      if (!v || maxVal <= 0) return 0;
      const r = v / maxVal;
      if (r <= 0.25) return 1;
      if (r <= 0.5) return 2;
      if (r <= 0.75) return 3;
      return 4;
    };

    const W = padL + weeks * (cell + gap) + 4;
    const H = padT + 7 * (cell + gap) + 4;
    const dayLabels = [[0, t('hm.mon')], [2, t('hm.wed')], [4, t('hm.fri')]];

    el.innerHTML = `
      <svg class="heatmap-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
        ${[...monthLabels.entries()].map(([w, lbl]) => `
          <text x="${padL + w * (cell + gap)}" y="10" fill="var(--fg-muted)" font-size="8.5">${esc(lbl)}</text>
        `).join('')}
        ${dayLabels.map(([d, lbl]) => `
          <text x="${padL - 4}" y="${padT + d * (cell + gap) + 9}" text-anchor="end" fill="var(--fg-muted)" font-size="8.5">${esc(lbl)}</text>
        `).join('')}
        ${cells.map((c, idx) => {
          const x = padL + c.w * (cell + gap);
          const y = padT + c.d * (cell + gap);
          const lv = levelOf(c.val);
          const sel = state.selectedDate === c.dk ? ' selected' : '';
          const dim = c.outOfRange ? ' out-of-range' : '';
          return `<rect class="hm-rect${sel}${dim}" data-idx="${idx}" x="${x}" y="${y}" width="${cell}" height="${cell}" fill="var(--hm-${lv})"/>`;
        }).join('')}
      </svg>
    `;

    // When expanded > 12w in All mode, keep the latest weeks scrolled into view
    el.scrollLeft = el.scrollWidth;

    el.querySelectorAll('.hm-rect').forEach((r) => {
      const c = cells[Number(r.dataset.idx)];
      r.addEventListener('mouseenter', (e) => {
        showTip(e, `
          <div><strong>${esc(c.dk)}</strong></div>
          <div>${esc(t('hm.tip', { s: c.entry.sessions, t: fmtTokens(c.entry.tokens) }))}</div>
          <div style="opacity:.7">${esc(t('hm.tipAction'))}</div>
        `);
      });
      r.addEventListener('mousemove', moveTip);
      r.addEventListener('mouseleave', hideTip);
      r.addEventListener('click', () => toggleDateFilter(c.dk));
    });
  }

  function renderOverviewSkills(skills) {
    const totalLoads = skills.reduce((a, x) => a + x.count, 0);
    $('ov-skills-sub').textContent = t('ov.skillsSub', { u: skills.length, c: totalLoads });
    const q = state.skillQuery.trim().toLowerCase();
    let list = skills.filter((s) => !q || s.name.toLowerCase().includes(q));
    list = [...list].sort((a, b) => (state.skillSort === 'recent' ? b.lastAt - a.lastAt : b.count - a.count));
    renderBarList($('ov-skills-list'), list.slice(0, 7), { empty: q ? t('ov.noMatchSkills') : t('ov.noSkills'), showTime: true });
  }

  function renderBarList(el, rows, { empty = '', showTime = true } = {}) {
    if (!rows.length) {
      el.innerHTML = `<div class="empty-inline">${esc(empty)}</div>`;
      return;
    }
    const maxCount = Math.max(...rows.map((r) => r.count), 1);
    el.innerHTML = rows.map((r, i) => {
      const color = BAR_PALETTE[i % BAR_PALETTE.length];
      const pct = Math.max(4, (r.count / maxCount) * 100);
      return `
        <div class="bar-row">
          <div class="bar-row-top">
            <div class="bar-label-wrap">
              <span class="bar-dot" style="background:${color}"></span>
              <span class="bar-label">${esc(r.name)}</span>
            </div>
            <div class="bar-right">
              <span class="bar-val">×${r.count}</span>
              ${showTime ? `<span class="bar-time">${esc(fmtRelative(r.lastAt))}</span>` : ''}
            </div>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
        </div>
      `;
    }).join('');
  }

  function renderSessionsList(sessions, workspaces) {
    const isProject = state.tab === 'project';
    const wsEntries = Object.entries(workspaces).sort((a, b) => b[1] - a[1]);
    const chipsEl = $('ov-ws-chips');
    chipsEl.classList.toggle('hidden', isProject);
    if (isProject) {
      state.sessionWorkspace = '';
    } else {
      chipsEl.innerHTML = [
        `<button type="button" class="ws-chip${!state.sessionWorkspace ? ' active' : ''}" data-ws="">${esc(t('range.all'))} ${sessions.length}</button>`,
        ...wsEntries.map(([ws, count]) =>
          `<button type="button" class="ws-chip${state.sessionWorkspace === ws ? ' active' : ''}" data-ws="${esc(ws)}">${esc(ws)} ${count}</button>`),
      ].join('');

      chipsEl.querySelectorAll('.ws-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.sessionWorkspace = btn.dataset.ws || '';
          renderSessionsList(sessions, workspaces);
        });
      });
    }

    const q = state.sessionQuery.trim().toLowerCase();
    let list = sessions.filter((s) => {
      if (state.sessionWorkspace && s.workspace !== state.sessionWorkspace) return false;
      if (!q) return true;
      return (s.title || '').toLowerCase().includes(q)
        || (s.workspace || '').toLowerCase().includes(q)
        || (s.lastUserMessage || '').toLowerCase().includes(q);
    });

    list = [...list].sort((a, b) => {
      if (state.sessionSort === 'tokens') return (b.totals?.totalTokens || 0) - (a.totals?.totalTokens || 0);
      if (state.sessionSort === 'context') return (b.currentContext || 0) - (a.currentContext || 0);
      return (b.lastMs || 0) - (a.lastMs || 0);
    });

    $('ov-sessions-count').textContent = String(list.length);
    const grid = $('ov-sessions-grid');

    if (!list.length) {
      grid.innerHTML = `<div class="empty-inline">${esc(t('ov.noSessions'))}</div>`;
      return;
    }

    const currentHost = hostConvId();
    const canJump = !!window.sidecar?.ui?.toggleConversation;

    grid.innerHTML = list.map((s) => {
      const limit = resolveSessionContextLimit(s).limit;
      const used = s.currentContext || s.lastPromptTokens || 0;
      const ratio = Math.min(1, used / limit);
      const isCurrent = currentHost && s.conversationId === currentHost;

      const comp = s.composition || {};
      const segs = ALL_OVERVIEW_CATS
        .map((c) => ({ label: t(`cat.${c.key}`), color: c.color, value: comp[c.key] || 0 }))
        .filter((x) => x.value > 0)
        .sort((a, b) => b.value - a.value);
      const segSum = segs.reduce((a, x) => a + x.value, 0) || 1;
      const barSegs = segs.map((x) => {
        const pct = (x.value / segSum) * 100;
        return `<div class="ctx-seg" style="width:${pct.toFixed(2)}%;background:${x.color}" title="${esc(x.label)}: ${fmtTokens(x.value)} (${pct.toFixed(1)}%)"></div>`;
      }).join('');

      const rawLast = String(s.lastUserMessage || '').trim();
      const shortLast = rawLast.length > 52 ? `${rawLast.slice(0, 52)}…` : (rawLast || '—');

      return `
        <article class="card session-card${isCurrent ? ' is-current' : ''}" data-conv="${esc(s.conversationId)}">
          <div class="sc-head">
            <div class="sc-title" title="${esc(s.title)}">${esc(s.title)}</div>
            <div class="sc-time">${esc(fmtRelative(s.lastMs))}</div>
          </div>
          <div class="sc-tags">
            <span class="badge-ws">${esc(s.workspace || 'default-workspace')}</span>
            <div style="display:flex;align-items:center;gap:4px">
              ${isCurrent ? `<span class="badge-cur">${esc(t('ov.current'))}</span>` : ''}
              ${canJump && !isCurrent ? `<button type="button" class="sc-open-btn" data-jump="${esc(s.conversationId)}">${esc(t('ov.open'))}</button>` : ''}
            </div>
          </div>
          <div class="sc-ctx-line">
            <span>${fmtTokens(used)} / ${fmtTokens(limit)}</span>
            <strong>${fmtPct(ratio, 1)}</strong>
          </div>
          <div class="ctx-bar thin" style="margin-bottom:2px">${barSegs}</div>
          <div class="sc-metrics-inline">
            <span><strong>${s.turns}</strong>t · <strong>${s.steps}</strong>s</span>
            <span>${esc(t('ov.tokens'))} <strong>${fmtTokens(s.totals?.totalTokens || 0)}</strong></span>
            <span>${esc(t('session.cached'))} <strong>${fmtPct(s.totals?.cacheHitRate || 0, 0)}</strong></span>
          </div>
          <div class="sc-foot" title="${esc(rawLast)}">${esc(t('ov.lastMsg'))}: ${esc(shortLast)}</div>
        </article>
      `;
    }).join('');

    grid.querySelectorAll('.session-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        const jumpBtn = e.target.closest('[data-jump]');
        if (jumpBtn) {
          e.stopPropagation();
          window.sidecar?.ui?.toggleConversation?.(jumpBtn.dataset.jump);
          return;
        }
        const convId = card.dataset.conv;
        if (!convId) return;
        state.inspectedConvId = convId === hostConvId() ? null : convId;
        state.sessionEtag = '';
        state.traceEtag = '';
        state.traceSelectedIdx = null;
        state.traceDetailCache.clear();
        selectTab('session');
      });
    });
  }

  // ---------- Render Tab 2: Session Trace (Full Interaction History) ----------
  function fmtIsoLocal(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function isNearTraceBottom() {
    const el = $('trace-list');
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  }

  function updateTraceJumpBtn() {
    const btn = $('btn-trace-latest');
    if (!btn) return;
    const listEl = $('trace-list');
    const scrollable = listEl && listEl.scrollHeight > listEl.clientHeight + 24;
    btn.classList.toggle('hidden', !scrollable || state.traceStick);
  }

  function scrollTraceToBottom(smooth = false) {
    const el = $('trace-list');
    if (el) {
      if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      else el.scrollTop = el.scrollHeight;
    }
    const stripScroll = $('trace-strip-scroll');
    if (stripScroll) {
      if (smooth) stripScroll.scrollTo({ left: stripScroll.scrollWidth, behavior: 'smooth' });
      else stripScroll.scrollLeft = stripScroll.scrollWidth;
    }
    state.traceStick = true;
    updateTraceJumpBtn();
  }

  const TRACE_TAG_DEFS = [
    { key: 'input', labelKey: 'trace.input', color: 'var(--green)' },
    { key: 'system', labelKey: 'trace.injected', color: 'var(--blue)' },
    { key: 'skill', labelKey: 'trace.skill', color: 'var(--pink)' },
    { key: 'model', labelKey: 'trace.model', color: 'var(--violet)' },
    { key: 'tool', labelKey: 'trace.tool', color: 'var(--amber)' },
    { key: 'error', labelKey: 'trace.error', color: 'var(--rose)' },
  ];

  function traceEventMatchesTags(it) {
    if (it.hasError) return state.traceEnabled.has('error') || state.traceEnabled.has(it.kind);
    return state.traceEnabled.has(it.kind);
  }

  function renderTraceTags(counts) {
    const el = $('trace-tags');
    if (!el) return;
    el.innerHTML = TRACE_TAG_DEFS.map((def) => {
      const on = state.traceEnabled.has(def.key);
      const cnt = counts?.[def.key] || 0;
      return `
        <button type="button" class="trace-tag${on ? '' : ' off'}" data-ttag="${def.key}" aria-pressed="${on}">
          <span class="trace-tag-dot" style="background:${def.color}"></span>
          <span>${esc(t(def.labelKey))}</span>
          ${cnt > 0 ? `<span class="trace-tag-cnt">${cnt}</span>` : ''}
        </button>
      `;
    }).join('');
    el.querySelectorAll('.trace-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.ttag;
        if (state.traceEnabled.has(k)) state.traceEnabled.delete(k);
        else state.traceEnabled.add(k);
        renderTrace();
      });
    });
  }

  function renderProse(rawText) {
    const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
    if (!text) return `<div class="empty-inline">${esc(t('td.noContent'))}</div>`;

    const inlineFmt = (raw) => {
      // Protect inline code spans first so markdown syntax inside backticks is untouched
      const codeSpans = [];
      let s = esc(raw).replace(/`([^`\n]+)`/g, (_, code) => {
        const idx = codeSpans.push(`<code>${code}</code>`) - 1;
        return `\u0000C${idx}\u0000`;
      });
      // Links [label](url) — allow http(s) and file:// only
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

        // Horizontal rule
        if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
          out.push('<hr>');
          i++;
          continue;
        }

        // Heading (# .. ####)
        const hMatch = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
        if (hMatch) {
          const lvl = hMatch[1].length;
          out.push(`<h${lvl}>${inlineFmt(hMatch[2])}</h${lvl}>`);
          i++;
          continue;
        }

        // Markdown table
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

        // Blockquote
        if (/^\s*>\s?/.test(line)) {
          const bq = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            bq.push(lines[i].replace(/^\s*>\s?/, ''));
            i++;
          }
          out.push(`<blockquote>${bq.map((l) => (l.trim() ? `<p>${inlineFmt(l)}</p>` : '')).join('')}</blockquote>`);
          continue;
        }

        // Unordered list
        if (/^\s*[-*•]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
            items.push(`<li>${inlineFmt(lines[i].replace(/^\s*[-*•]\s+/, ''))}</li>`);
            i++;
          }
          out.push(`<ul>${items.join('')}</ul>`);
          continue;
        }

        // Ordered list
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            items.push(`<li>${inlineFmt(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
            i++;
          }
          out.push(`<ol>${items.join('')}</ol>`);
          continue;
        }

        // Paragraph (until blank line or next block construct)
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

    // Split on fenced code blocks (```lang ... ```)
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

  function renderTrace() {
    const data = state.traceData;
    const listEl = $('trace-list');
    const stripEl = $('trace-strip');
    const allItems = Array.isArray(data?.items) ? data.items : [];
    const prevScrollTop = listEl.scrollTop;
    const prevStripScroll = $('trace-strip-scroll')?.scrollLeft || 0;
    const shouldStick = state.traceFirstScroll || (state.traceFollow && state.traceStick);

    if ($('trace-total-count')) $('trace-total-count').textContent = String(allItems.length);
    renderTraceTags(data?.counts || {});

    if (!allItems.length) {
      stripEl.classList.add('hidden');
      listEl.innerHTML = `<div class="empty-inline">${esc(t('trace.empty'))}</div>`;
      $('btn-trace-latest').classList.add('hidden');
      closeTraceDetail();
      return;
    }

    // Filter by multi-select enabled tags + search
    const q = state.traceQuery.trim().toLowerCase();
    const filtered = allItems.filter((it) => {
      if (!traceEventMatchesTags(it)) return false;
      if (!q) return true;
      return String(it.toolName || '').toLowerCase().includes(q)
        || String(it.skillName || '').toLowerCase().includes(q)
        || String(it.model || '').toLowerCase().includes(q)
        || String(it.systemType || '').toLowerCase().includes(q)
        || (isTimeContextItem(it) && (t('trace.timeContext').toLowerCase().includes(q) || 'time context'.includes(q) || '时间上下文'.includes(q)))
        || String(it.preview || '').toLowerCase().includes(q)
        || String(it.argsPreview || '').toLowerCase().includes(q)
        || String(it.resultPreview || '').toLowerCase().includes(q);
    });

    // 4-track mini visual strip with fixed left labels + scrollable right track.
    // ONLY the cell belonging to an event's own lane is interactive and selectable!
    const stripItems = filtered.length > 400 ? filtered.slice(-400) : filtered;
    if (!stripItems.length) {
      stripEl.classList.add('hidden');
    } else {
      stripEl.classList.remove('hidden');
      const lanes = [
        { key: 'input', labelKey: 'trace.input', match: (it) => it.kind === 'input' || it.kind === 'system' },
        { key: 'model', labelKey: 'trace.model', match: (it) => it.kind === 'model' },
        { key: 'tool', labelKey: 'trace.tool', match: (it) => it.kind === 'tool' || it.kind === 'skill' },
      ];
      const renderLaneCells = (lane) => `
        <div class="ts-cells">
          ${stripItems.map((it) => {
            if (!lane.match(it)) return '<div class="ts-cell"></div>';
            const cls = it.hasError ? 'on-error' : `on-${it.kind}`;
            const sel = state.traceSelectedIdx === it.idx ? ' selected' : '';
            const label = it.skillName || it.toolName || it.model || it.systemType || t(`trace.${it.kind}`);
            return `<div class="ts-cell hit ${cls}${sel}" data-tidx="${it.idx}" title="#${it.step} ${esc(label)}"></div>`;
          }).join('')}
        </div>
      `;
      stripEl.innerHTML = `
        <div class="ts-labels">
          ${lanes.map((l) => `<span class="ts-lane-label">${esc(t(l.labelKey))}</span>`).join('')}
        </div>
        <div id="trace-strip-scroll" class="ts-scroll">
          ${lanes.map(renderLaneCells).join('')}
        </div>
      `;
      stripEl.querySelectorAll('.ts-cell.hit').forEach((cell) => {
        cell.addEventListener('click', () => {
          const idx = Number(cell.dataset.tidx);
          const opened = toggleTraceDetail(idx);
          if (opened) {
            const row = listEl.querySelector(`.tr-row[data-tidx="${idx}"]`);
            if (row) row.scrollIntoView({ block: 'nearest' });
          }
        });
      });
    }

    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-inline">${esc(t('trace.empty'))}</div>`;
      $('btn-trace-latest').classList.add('hidden');
      return;
    }

    // Cap rendered DOM rows to latest 400 matching items for snappy scrolling on huge sessions
    const visible = filtered.length > 400 ? filtered.slice(-400) : filtered;
    listEl.innerHTML = visible.map((it) => {
      const sel = state.traceSelectedIdx === it.idx ? ' selected' : '';
      const dotCls = it.hasError ? 'error' : it.kind;
      let name = '';
      let preview = '';
      let extraBadge = '';
      let rightMeta = `#${it.step}`;

      if (it.kind === 'input') {
        name = t('trace.input');
        preview = it.preview || (it.mediaCount ? `[${it.mediaCount} media]` : '');
        rightMeta = `T${it.turn} · #${it.step}`;
      } else if (it.kind === 'system') {
        name = it.systemType || t('trace.injected');
        if (isTimeContextItem(it)) {
          extraBadge = `<span class="tr-think-badge" style="color:var(--blue);background:color-mix(in srgb,var(--blue) 12%,transparent)">${esc(t('trace.timeContext'))}</span>`;
        }
        preview = it.preview || '';
        rightMeta = `#${it.step}`;
      } else if (it.kind === 'skill') {
        name = it.skillName || t('trace.skill');
        extraBadge = `<span class="tr-think-badge" style="color:var(--pink);background:color-mix(in srgb,var(--pink) 12%,transparent)">SKILL</span>`;
        preview = it.resultPreview || '';
        rightMeta = `#${it.step}`;
      } else if (it.kind === 'model') {
        name = it.model || t('trace.model');
        extraBadge = renderModelBadges(it);
        preview = it.preview || '';
        rightMeta = `${fmtTokens(it.outputTokens)} · #${it.step}`;
      } else {
        name = it.toolName || t('trace.tool');
        preview = it.argsPreview
          ? (it.resultPreview ? `${it.argsPreview}  →  ${it.resultPreview}` : it.argsPreview)
          : it.resultPreview;
        rightMeta = `${it.durationMs ? `${fmtDur(it.durationMs)} · ` : ''}#${it.step}`;
      }

      return `
        <button type="button" class="tr-row${sel}" data-tidx="${it.idx}">
          <div class="tr-left">
            <span class="tr-dot ${dotCls}"></span>
            <span class="tr-name">${esc(name)}</span>
            ${extraBadge}
            <span class="tr-preview${it.kind === 'tool' ? ' mono' : ''}">${esc(preview)}</span>
          </div>
          <div class="tr-right"><span>${esc(rightMeta)}</span></div>
        </button>
      `;
    }).join('');

    listEl.querySelectorAll('.tr-row').forEach((btn) => {
      btn.addEventListener('click', () => toggleTraceDetail(Number(btn.dataset.tidx)));
    });

    const stripScroll = $('trace-strip-scroll');
    if (shouldStick) {
      state.traceFirstScroll = false;
      requestAnimationFrame(() => scrollTraceToBottom(false));
    } else {
      listEl.scrollTop = prevScrollTop;
      if (stripScroll) stripScroll.scrollLeft = prevStripScroll;
      updateTraceJumpBtn();
    }

    if (state.traceSelectedIdx != null) {
      const cached = state.traceDetailCache.get(`${activeSessionId()}:${state.traceSelectedIdx}`);
      if (cached) renderTraceDetailPanel(cached);
    }
  }

  function closeTraceDetail() {
    state.traceSelectedIdx = null;
    $('trace-detail').classList.add('hidden');
    $('trace-split').classList.remove('has-detail');
    document.querySelectorAll('.tr-row.selected, .ts-cell.selected').forEach((el) => el.classList.remove('selected'));
  }

  function toggleTraceDetail(idx) {
    if (state.traceSelectedIdx === idx && !$('trace-detail').classList.contains('hidden')) {
      closeTraceDetail();
      return false;
    }
    openTraceDetail(idx);
    return true;
  }

  async function openTraceDetail(idx) {
    state.traceSelectedIdx = idx;
    state.traceDetailTab = 'overview';
    state.traceOverviewExpanded = false;
    $('trace-detail').classList.remove('hidden');
    $('trace-split').classList.add('has-detail');

    document.querySelectorAll('.tr-row').forEach((el) => el.classList.toggle('selected', Number(el.dataset.tidx) === idx));
    document.querySelectorAll('.ts-cell.hit').forEach((el) => el.classList.toggle('selected', Number(el.dataset.tidx) === idx));
    // Keep clicked row & corresponding top-strip cell visible after splitting top/bottom
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

  function renderTraceDetailPanel(item) {
    const badge = $('td-kind-badge');
    const badgeCls = item.hasError ? 'tag-err'
      : item.kind === 'input' ? 'tag-write'
      : item.kind === 'model' ? 'tag-read'
      : item.kind === 'skill' ? 'tag-read'
      : item.kind === 'system' ? 'tag-read'
      : 'tag-edit';
    badge.className = `tag-pill ${badgeCls}`;
    badge.textContent = item.kind === 'tool'
      ? (item.toolName || t('trace.tool'))
      : item.kind === 'skill'
        ? (item.skillName || t('trace.skill'))
        : item.kind === 'system'
          ? (isTimeContextItem(item) ? t('trace.timeContext') : (item.systemType || t('trace.injected')))
          : t(`trace.${item.kind}`);
    $('td-step-label').textContent = `${t('step.turn', { turn: item.turn })} · ${t('step.label', { step: item.step })}`;

    // Tailored tabs per event kind:
    // - Model: Overview | Preview | Raw
    // - Tool / Skill: Overview | Args | Result | Timing
    // - Input: Overview | Preview | Raw
    // - Injected / System: Overview | Raw
    const tabs = (item.kind === 'tool' || item.kind === 'skill')
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

    if (item.kind === 'tool' || item.kind === 'skill') {
      const argsJson = JSON.stringify(item.args || {}, null, 2);
      const resultText = item.result || item.hookError || t('td.noContent');
      const errBlock = item.hookError
        ? `<div><div class="td-section-head"><span>${esc(t('td.hostError'))}</span></div><div class="td-err-box">${esc(item.hookError)}</div></div>`
        : '';
      if (tab === 'timing') {
        bodyEl.innerHTML = kv([
          [t('td.start'), fmtIsoLocal(item.at)],
          [t('td.end'), fmtIsoLocal(item.endAt)],
          [t('td.duration'), item.durationMs ? `${item.durationMs.toLocaleString()} ms (${fmtDur(item.durationMs)})` : '—'],
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
        bodyEl.innerHTML = `
          ${kv([
            [item.kind === 'skill' ? t('trace.skill') : t('td.tool'), item.skillName || item.toolName || '—'],
            [t('td.status'), item.status || 'DONE'],
            [t('td.turnStep'), `${t('step.turn', { turn: item.turn })} · #${item.step}`],
            [t('td.duration'), item.durationMs ? `${item.durationMs.toLocaleString()} ms` : '—'],
          ])}
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
      const estTtftMs = item.durationMs ? Math.round(item.durationMs * 0.28) : 0;
      const genMs = Math.max(0, (item.durationMs || 0) - estTtftMs);

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
        // Model Overview tab: inline-expandable Markdown preview + accurate Request Timing
        const expanded = !!state.traceOverviewExpanded;
        const hasTiming = (item.durationMs || 0) > 0;
        const hasPreviewBody = !!(item.thinking || item.content || tcs.length);
        bodyEl.innerHTML = `
          ${kv([
            [t('td.model'), item.model || '—'],
            [t('td.status'), item.status || 'DONE'],
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
            ${kv([
              [t('td.start'), fmtIsoLocal(item.at)],
              [t('td.duration'), hasTiming ? `${(item.durationMs / 1000).toFixed(2)}s` : '—'],
              [t('td.estTtft'), hasTiming && estTtftMs ? `${estTtftMs} ms` : '—'],
              [t('td.genTime'), hasTiming && genMs ? `${(genMs / 1000).toFixed(2)}s` : '—'],
              [t('td.throughput'), hasTiming && item.tokPerSec ? `${item.tokPerSec} tok/s` : '—'],
            ])}
            ${!hasTiming ? `<div class="td-timing-note">${esc(t('td.timingUnavailable'))}</div>` : ''}
          </div>
        `;
      }
    } else if (item.kind === 'system') {
      const sysText = item.content || t('td.noContent');
      const isTimeCtx = isTimeContextItem(item);
      if (tab === 'raw') {
        bodyEl.innerHTML = `
          <div><div class="td-section-head"><span>${esc(item.systemType || t('trace.injected'))}</span>${copyBtnHtml('td-pre-sys')}</div>
          <pre id="td-pre-sys" class="td-pre">${esc(sysText)}</pre></div>
        `;
      } else {
        bodyEl.innerHTML = `
          ${kv([
            [t('td.status'), isTimeCtx ? `${t('trace.timeContext')} (${item.systemType})` : (item.systemType || 'INJECTED')],
            [t('td.source'), item.source || 'SYSTEM'],
            [t('td.turnStep'), `${t('step.turn', { turn: item.turn })} · #${item.step}`],
            [t('td.start'), fmtIsoLocal(item.at)],
          ])}
          <div class="td-prose">${renderProse(sysText)}</div>
        `;
      }
    } else {
      // User Input: Overview | Preview | Raw
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

  // ---------- Tab, Project Resolution, Language & Settings Actions ----------
  function selectTab(tab) {
    const prev = state.tab;
    state.tab = normalizeTabParam(tab) || 'session';
    if (prev !== state.tab && (state.tab === 'project' || state.tab === 'global')) {
      state.overviewEtag = '';
      state.sessionWorkspace = '';
    }
    document.querySelectorAll('.seg-tab').forEach((btn) => {
      const active = btn.dataset.tab === state.tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    $('view-session').classList.toggle('active', state.tab === 'session');
    $('view-trace').classList.toggle('active', state.tab === 'trace');
    $('view-overview').classList.toggle('active', state.tab === 'project' || state.tab === 'global');
    updateLivePill();
    pollNow();
  }

  async function resolveCurrentProject() {
    // 1. Prefer live host workspace URIs when available from window.sidecar
    try {
      if (typeof window.sidecar?.getWorkspaceUris === 'function') {
        const uris = await window.sidecar.getWorkspaceUris();
        if (Array.isArray(uris) && uris[0]) {
          const clean = String(uris[0]).replace(/\/+$/, '');
          const name = clean.replace(/^file:\/\//, '').split('/').filter(Boolean).pop() || clean;
          state.currentProject = { workspace: name, workspaceUri: clean };
          return state.currentProject;
        }
      }
    } catch {
      // Fall back to current conversation's metadata
    }

    // 2. Use current host conversation's workspace if already loaded
    if (state.sessionData && !state.inspectedConvId && (state.sessionData.workspace || state.sessionData.workspaceUri)) {
      state.currentProject = {
        workspace: state.sessionData.workspace || '',
        workspaceUri: state.sessionData.workspaceUri || '',
      };
      return state.currentProject;
    }

    // 3. Query current host conversation once to resolve its workspace
    const hostId = hostConvId();
    if (hostId) {
      try {
        const res = await apiGet(`/api/session?conversationId=${encodeURIComponent(hostId)}`);
        if (res.found && res.session) {
          state.currentProject = {
            workspace: res.session.workspace || '',
            workspaceUri: res.session.workspaceUri || '',
          };
          return state.currentProject;
        }
      } catch {
        // ignore
      }
    }

    // 4. Standalone fallback: keep last known or most recent session's workspace
    if (!state.currentProject.workspace && state.overviewData?.sessions?.[0]) {
      const s0 = state.overviewData.sessions[0];
      state.currentProject = { workspace: s0.workspace || '', workspaceUri: s0.workspaceUri || '' };
    }
    return state.currentProject;
  }

  function toggleDateFilter(dateKey) {
    if (!dateKey) return;
    state.selectedDate = state.selectedDate === dateKey ? '' : dateKey;
    state.overviewEtag = '';
    pollNow();
  }

  function setLanguage(lang) {
    settings.lang = lang === 'zh' ? 'zh' : 'en';
    saveSettings(settings);
    applyStaticI18n();
    renderSession();
    renderTrace();
    renderOverview();
  }

  async function openSettings() {
    $('set-lang').value = settings.lang;
    $('set-poll').value = String(settings.pollMs);
    $('set-default-tab').value = settings.defaultTab;
    $('set-update-status').classList.add('hidden');
    $('settings-modal').classList.remove('hidden');
    try {
      const ver = await apiGet('/api/version');
      $('set-version-label').textContent = `agy-context v${ver.currentVersion}`;
    } catch { /* ignore */ }
  }

  async function checkUpdates() {
    const statusEl = $('set-update-status');
    statusEl.classList.remove('hidden');
    statusEl.textContent = t('update.checking');
    try {
      const res = await apiGet('/api/version?check=1');
      $('set-version-label').textContent = `agy-context v${res.currentVersion}`;
      if (res.error === 'no_repository') {
        statusEl.textContent = t('update.noRepo');
      } else if (res.error) {
        statusEl.textContent = t('update.error');
      } else if (res.hasUpdate) {
        statusEl.innerHTML = `${esc(t('update.available', { latest: res.latestVersion }))}<br><code>agy plugin install ${esc(res.repository)}</code>`;
      } else {
        statusEl.textContent = t('update.upToDate', { ver: res.currentVersion });
      }
    } catch {
      statusEl.textContent = t('update.error');
    }
  }

  function closeSettings() { $('settings-modal').classList.add('hidden'); }

  function applySettings() {
    settings.lang = $('set-lang').value === 'zh' ? 'zh' : 'en';
    settings.pollMs = Math.max(1000, Number($('set-poll').value) || 1500);
    settings.defaultTab = $('set-default-tab').value;
    saveSettings(settings);
    closeSettings();
    applyStaticI18n();
    renderSession();
    renderTrace();
    renderOverview();
    schedulePoll();
  }

  // ---------- Live Polling Loop ----------
  async function pollOnce() {
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      const currentHost = hostConvId();
      if (currentHost && currentHost !== state.lastHostConvId) {
        state.lastHostConvId = currentHost;
        if (!state.inspectedConvId) {
          state.sessionEtag = '';
          state.traceEtag = '';
          state.traceSelectedIdx = null;
          state.traceFirstScroll = true;
          state.traceStick = true;
          state.traceDetailCache.clear();
        }
      }

      if (state.tab === 'session') {
        let targetId = activeSessionId();
        if (!targetId) {
          const ov = await apiGet('/api/overview?range=all');
          state.overviewData = ov;
          targetId = ov.sessions?.[0]?.conversationId || '';
          if (targetId) state.inspectedConvId = targetId;
        }
        if (targetId) {
          const qs = new URLSearchParams({ conversationId: targetId });
          if (state.sessionEtag) qs.set('etag', state.sessionEtag);
          const res = await apiGet(`/api/session?${qs}`);
          if (!res.unchanged) {
            state.sessionEtag = res.etag || '';
            state.sessionData = res.found ? res.session : null;
            if (state.sessionData && !state.inspectedConvId) {
              state.currentProject = {
                workspace: state.sessionData.workspace || state.currentProject.workspace,
                workspaceUri: state.sessionData.workspaceUri || state.currentProject.workspaceUri,
              };
            }
            setLiveState(state.inspectedConvId ? null : (state.sessionData?.hookTelemetry?.liveState || null));
            renderSession();
          }
        } else {
          state.sessionData = null;
          setLiveState(null);
          renderSession();
        }
      } else if (state.tab === 'trace') {
        let targetId = activeSessionId();
        if (!targetId) {
          const ov = await apiGet('/api/overview?range=all');
          state.overviewData = ov;
          targetId = ov.sessions?.[0]?.conversationId || '';
          if (targetId) state.inspectedConvId = targetId;
        }
        if (targetId) {
          const qs = new URLSearchParams({ conversationId: targetId });
          if (state.traceEtag) qs.set('etag', state.traceEtag);
          const res = await apiGet(`/api/trace?${qs}`);
          if (!res.unchanged) {
            state.traceEtag = res.etag || '';
            state.traceData = res.found ? res : null;
            setLiveState(state.inspectedConvId ? null : (res.liveState || null));
            renderTrace();
          }
        } else {
          state.traceData = null;
          setLiveState(null);
          renderTrace();
        }
      } else {
        const qs = new URLSearchParams({ range: state.range });
        if (state.selectedDate) qs.set('date', state.selectedDate);
        if (state.tab === 'project') {
          const proj = await resolveCurrentProject();
          if (proj.workspace) qs.set('workspace', proj.workspace);
          if (proj.workspaceUri) qs.set('workspaceUri', proj.workspaceUri);
        }
        if (state.overviewEtag) qs.set('etag', state.overviewEtag);
        const res = await apiGet(`/api/overview?${qs}`);
        if (!res.unchanged) {
          state.overviewEtag = res.etag || '';
          state.overviewData = res;
          renderOverview();
        }
      }

      $('live-pill').classList.remove('stale');
      updateLivePill();
    } catch {
      $('live-pill').classList.add('stale');
      $('live-pill').classList.remove('busy', 'phase-tools');
      $('live-label').textContent = t('live.stale');
    } finally {
      state.inFlight = false;
    }
  }

  function schedulePoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollOnce, settings.pollMs || 1500);
  }

  function pollNow() {
    pollOnce();
    schedulePoll();
  }

  // ---------- Event Wiring ----------
  document.querySelectorAll('.seg-tab').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });

  $('btn-lang').addEventListener('click', () => {
    setLanguage(settings.lang === 'en' ? 'zh' : 'en');
  });

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-check-update').addEventListener('click', checkUpdates);
  $('btn-save-settings').addEventListener('click', applySettings);
  document.querySelectorAll('[data-close-modal]').forEach((el) => el.addEventListener('click', closeSettings));

  $('btn-goto-overview').addEventListener('click', () => selectTab('global'));
  $('btn-back-current').addEventListener('click', () => {
    state.inspectedConvId = null;
    state.sessionEtag = '';
    state.traceEtag = '';
    state.traceSelectedIdx = null;
    state.traceDetailCache.clear();
    pollNow();
  });

  // Trace controls
  $('trace-search').addEventListener('input', (e) => {
    state.traceQuery = e.target.value;
    renderTrace();
  });

  $('btn-close-detail').addEventListener('click', closeTraceDetail);

  $('btn-trace-follow').addEventListener('click', () => {
    state.traceFollow = !state.traceFollow;
    const btn = $('btn-trace-follow');
    btn.classList.toggle('active', state.traceFollow);
    btn.setAttribute('aria-pressed', String(state.traceFollow));
    if (state.traceFollow) scrollTraceToBottom(true);
  });

  $('btn-trace-latest').addEventListener('click', () => {
    state.traceFollow = true;
    $('btn-trace-follow').classList.add('active');
    $('btn-trace-follow').setAttribute('aria-pressed', 'true');
    scrollTraceToBottom(true);
  });

  $('trace-list').addEventListener('scroll', () => {
    state.traceStick = isNearTraceBottom();
    updateTraceJumpBtn();
  }, { passive: true });
  $('btn-open-inspected').addEventListener('click', () => {
    if (state.inspectedConvId) window.sidecar?.ui?.toggleConversation?.(state.inspectedConvId);
  });

  // Expand/collapse all breakdown groups
  $('btn-toggle-all').addEventListener('click', () => {
    if (!state.sessionData) return;
    const limit = resolveSessionContextLimit(state.sessionData).limit;
    const { rows, freeTokens } = buildSessionRows(state.sessionData, limit);
    const ids = rows.map((r) => r.id);
    const allOpen = ids.every((id) => state.expandedKeys.has(id));
    if (allOpen) state.expandedKeys.clear();
    else ids.forEach((id) => state.expandedKeys.add(id));
    renderBreakdownList(rows, freeTokens, limit);
  });

  // Trend mode & span
  document.querySelectorAll('[data-trend-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.trendMode = btn.dataset.trendMode;
      document.querySelectorAll('[data-trend-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      if (state.sessionData) renderTrendChart(state.sessionData.timeline || []);
    });
  });

  document.querySelectorAll('[data-trend-span]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.trendSpan = btn.dataset.trendSpan;
      document.querySelectorAll('[data-trend-span]').forEach((b) => b.classList.toggle('active', b === btn));
      if (state.sessionData) renderTrendChart(state.sessionData.timeline || []);
    });
  });

  // Overview controls
  document.querySelectorAll('.range-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      state.selectedDate = '';
      state.overviewEtag = '';
      document.querySelectorAll('.range-pill').forEach((b) => b.classList.toggle('active', b === btn));
      pollNow();
    });
  });

  $('ov-date-badge').addEventListener('click', () => {
    if (state.selectedDate) {
      state.selectedDate = '';
      state.overviewEtag = '';
      pollNow();
    }
  });

  document.querySelectorAll('[data-hm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.hmMode = btn.dataset.hm;
      document.querySelectorAll('[data-hm]').forEach((b) => b.classList.toggle('active', b === btn));
      if (state.overviewData) {
        const d = state.overviewData;
        renderHeatmap(d.heatmap || {}, {
          range: d.range,
          startDate: d.startDate,
          endDate: d.endDate,
          heatmapSpan: d.heatmapSpan,
        });
      }
    });
  });

  document.querySelectorAll('[data-skill-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.skillSort = btn.dataset.skillSort;
      document.querySelectorAll('[data-skill-sort]').forEach((b) => b.classList.toggle('active', b === btn));
      if (state.overviewData) renderOverviewSkills(state.overviewData.skills || []);
    });
  });

  $('ov-skill-search').addEventListener('input', (e) => {
    state.skillQuery = e.target.value;
    if (state.overviewData) renderOverviewSkills(state.overviewData.skills || []);
  });

  $('ov-session-search').addEventListener('input', (e) => {
    state.sessionQuery = e.target.value;
    if (state.overviewData) renderSessionsList(state.overviewData.sessions || [], state.overviewData.workspaces || {});
  });

  document.querySelectorAll('.sort-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sessionSort = btn.dataset.sort;
      document.querySelectorAll('.sort-pill').forEach((b) => b.classList.toggle('active', b === btn));
      if (state.overviewData) renderSessionsList(state.overviewData.sessions || [], state.overviewData.workspaces || {});
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings-modal').classList.contains('hidden')) closeSettings();
  });

  // Boot: configure standalone Trace pane vs Context pane
  if (IS_TRACE_PANE) {
    document.title = 'Trace';
    $('ctx-tabs').classList.add('hidden');
    $('trace-pane-head').classList.remove('hidden');
    $('btn-trace-follow').classList.remove('hidden');
  }
  applyStaticI18n();
  selectTab(state.tab);
})();
