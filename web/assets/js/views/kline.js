/** 视图:数据 K 线（整活）——把所有日序列压成蜡烛，汇总到一页 */
(function () {
  window.VIEWS = window.VIEWS || {}

  const niceMax = (v) => {
    if (!v || v <= 0) return 1
    const p = Math.pow(10, Math.floor(Math.log10(v)))
    const n = v / p
    const m = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
    return m * p
  }
  const shortNum = (v) => {
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M'
    if (v >= 1e4) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + 'k'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
    return String(Math.round(v))
  }

  /* 日 K：开=前一日数值，收=当日数值。
     可选的 wick 画成影线；总量用当日输入 tokens 当影线，别的是纯净蜡烛。 */
  const candleChart = (list, { W = 640, H = 220, L = 62, R = 14, T = 16, B = 30 } = {}) => {
    const hasData = list.length > 0
    const max = niceMax(Math.max(1, ...list.map((d) => d.v || 0)) * 1.08)
    const plotW = W - L - R
    const plotH = H - T - B
    const slot = list.length ? plotW / list.length : plotW
    const bw = Math.min(26, Math.max(9, slot * 0.42))
    const y = (v) => T + plotH * (1 - (v || 0) / max)
    const candles = list.map((d, i) => {
      const open = i === 0 ? d.v : list[i - 1].v
      const close = d.v
      const high = d.wick != null ? Math.max(open, close, d.wick) : Math.max(open, close)
      const low = d.wick != null ? Math.min(open, close, d.wick) : Math.min(open, close)
      const top = y(Math.max(open, close))
      const bottom = y(Math.min(open, close))
      return {
        x: L + i * slot + (slot - bw) / 2,
        y: top,
        w: bw,
        h: Math.max(2, bottom - top),
        up: close >= open,
        open, close, day: d.day, change: close - open,
        wickX: L + i * slot + slot / 2,
        wickTop: y(high),
        wickBottom: y(low),
      }
    })
    const ticks = 4
    const grid = hasData
      ? Array.from({ length: ticks + 1 }, (_, i) => {
        const v = (max * i) / ticks
        return { y: y(v), label: shortNum(v) }
      })
      : [{ y: H - B, label: '0' }]
    return {
      W, H, L, R, T, B, max, hasData, candles, grid,
      days: list.map((d, i) => ({ x: L + i * slot + slot / 2, label: d.day })),
      zeroY: H - B,
    }
  }

  const statOf = (series) => {
    const n = series.length
    const values = series.map((d) => d.v || 0)
    const sum = values.reduce((a, b) => a + b, 0)
    const last = values[n - 1] || 0
    const prev = values[n - 2] || 0
    const change = last - prev
    return {
      n, sum, last, prev, first: values[0] || 0, change,
      pct: prev ? (change / prev) * 100 : null,
      avg: n ? sum / n : 0,
      peak: n ? Math.max(...values) : 0,
      low: n ? Math.min(...values) : 0,
    }
  }

  window.VIEWS.kline = {
    name: 'KlineView',
    setup() {
      const { computed, onMounted, ref } = Vue
      const M = window.MOCK
      const fmt = window.UI.fmt
      const { toast } = window.UI

      const loading = ref(true)
      const refreshing = ref(false)
      const lastUpdated = ref(Date.now())
      const lastUpdatedLabel = computed(() => new Date(lastUpdated.value).toTimeString().slice(0, 5))

      const totalSeries = computed(() => (M.tokenTrend || []).map((d) => ({
        day: d.day, v: (d.input || 0) + (d.output || 0), wick: d.input || 0,
      })))
      const inSeries = computed(() => (M.tokenTrend || []).map((d) => ({ day: d.day, v: d.input || 0 })))
      const outSeries = computed(() => (M.tokenTrend || []).map((d) => ({ day: d.day, v: d.output || 0 })))
      const reqSeries = computed(() => (M.requestTrend || []).map((d) => ({ day: d.day, v: d.count || 0 })))

      const tokenStats = computed(() => statOf(totalSeries.value))
      const inStats = computed(() => statOf(inSeries.value))
      const outStats = computed(() => statOf(outSeries.value))
      const reqStats = computed(() => statOf(reqSeries.value))

      const bigChart = computed(() => candleChart(totalSeries.value, { W: 900, H: 400, L: 76, R: 22, T: 20, B: 34 }))
      const inChart = computed(() => candleChart(inSeries.value, { W: 640, H: 300 }))
      const outChart = computed(() => candleChart(outSeries.value, { W: 640, H: 300 }))
      const reqChart = computed(() => candleChart(reqSeries.value, { W: 640, H: 300 }))

      const pendingConfirms = computed(() => (M.confirms || []).length)
      const adoptions = computed(() => (M.personaAdoptions || []).filter((p) => p.status === 'pending'))
      const pendSug = computed(() => (M.suggestions || []).filter((s) => s.status === 'pending'))
      const pending = computed(() => pendingConfirms.value + adoptions.value.length + pendSug.value.length)
      const pendingNote = computed(() => {
        const a = []
        if (pendingConfirms.value) a.push(`工具 ${pendingConfirms.value}`)
        if (adoptions.value.length) a.push(`人设 ${adoptions.value.length}`)
        if (pendSug.value.length) a.push(`建议 ${pendSug.value.length}`)
        return a.length ? a.join(' · ') : '队列已清空'
      })

      const successRateText = computed(() => {
        if (M.toolSuccessRate != null) return (M.toolSuccessRate * 100).toFixed(1) + '%'
        if (M.toolOk != null && M.toolFail != null && M.toolOk + M.toolFail > 0) return ((M.toolOk / (M.toolOk + M.toolFail)) * 100).toFixed(1) + '%'
        return '—'
      })

      const cacheStats = computed(() => {
        const c = M.cache || null
        const input = c?.observedInput ?? inStats.value.sum
        const cached = c?.totalCacheRead ?? 0
        const hit = c?.tokenHitRate != null ? c.tokenHitRate * 100 : (input > 0 ? (cached / input) * 100 : null)
        return { input, cached, hit }
      })

      const toolTop = computed(() => M.toolTop || [])
      const toolMax = computed(() => Math.max(1, ...(M.toolTop || []).map((t) => t.count || 0)))
      const toolTotal = computed(() => (M.toolTop || []).reduce((s, t) => s + (t.count || 0), 0) || (M.totalToolCalls || 0))
      const conversations = computed(() => M.counts?.conversations ?? (M.conversations || []).length)
      const perceptions = computed(() => M.perceptions || [])
      const activeGroups = computed(() => perceptions.value.filter((p) => Date.now() - p.lastActive.at < 6 * 3600e3).length)
      const scopeCount = computed(() => (M.scopes || []).length)

      const runtime = computed(() => {
        const c = M.config || {}
        const provider = (c.llmProviders || []).find((p) => p.id === c.providerId)
        return {
          provider: provider?.name || c.providerId || '—',
          model: c.model || '未配置',
          protocol: ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' }[c.protocol] || c.protocol || '—'),
        }
      })

      const metricRows = computed(() => [
        { name: 'Token 总量', total: tokenStats.value.sum, avg: tokenStats.value.avg, peak: tokenStats.value.peak, note: `今收 ${fmt.num(tokenStats.value.last)}` },
        { name: '输入 tokens', total: inStats.value.sum, avg: inStats.value.avg, peak: inStats.value.peak, note: `占总量 ${tokenStats.value.sum ? ((inStats.value.sum / tokenStats.value.sum) * 100).toFixed(0) : 0}%` },
        { name: '输出 tokens', total: outStats.value.sum, avg: outStats.value.avg, peak: outStats.value.peak, note: `占总量 ${tokenStats.value.sum ? ((outStats.value.sum / tokenStats.value.sum) * 100).toFixed(0) : 0}%` },
        { name: '对话轮次', total: reqStats.value.sum, avg: reqStats.value.avg, peak: reqStats.value.peak, note: `今收 ${fmt.num(reqStats.value.last)}` },
        { name: '工具调用', total: toolTotal.value, avg: null, peak: null, note: `成功率 ${successRateText.value}` },
        { name: '活跃会话', total: conversations.value, avg: null, peak: null, note: '群聊 / 私聊' },
        { name: '缓存读取', total: cacheStats.value.cached, avg: null, peak: null, note: `命中率 ${cacheStats.value.hit != null ? cacheStats.value.hit.toFixed(1) + '%' : '—'}` },
        { name: '待你决定', total: pending.value, avg: null, peak: null, note: pendingNote.value },
        { name: '群情境', total: perceptions.value.length, avg: null, peak: null, note: `活跃 ${activeGroups.value}` },
        { name: '隔离范围', total: scopeCount.value, avg: null, peak: null, note: 'scope' },
      ])

      const changeClass = (v) => (v >= 0 ? 'is-up' : 'is-down')
      const signed = (v) => `${v >= 0 ? '+' : ''}${fmt.num(v)}`

      const loadAll = async (minMs = 0) => {
        const t0 = performance.now()
        const results = await Promise.allSettled([
          window.store.loadOverview(),
          window.store.loadConfig(),
          window.store.loadConfirm(),
          window.store.loadPersonaAdoptions(),
          window.store.loadSuggestions(null, 'pending'),
          window.store.loadScopes(),
        ])
        const wait = minMs - (performance.now() - t0)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        lastUpdated.value = Date.now()
        loading.value = false
        return results
      }
      const reload = async () => {
        if (refreshing.value) return
        refreshing.value = true
        try {
          const results = await loadAll()
          const failed = results.find((r) => r.status === 'rejected')
          if (failed) toast('部分数据刷新失败：' + (failed.reason?.message || failed.reason), 'warn')
          else toast('K 线已刷新', 'success')
        } finally { refreshing.value = false }
      }

      onMounted(async () => { await loadAll(420) })

      return {
        fmt, M, loading, refreshing, lastUpdatedLabel, reload,
        bigChart, inChart, outChart, reqChart,
        tokenStats, inStats, outStats, reqStats,
        pending, pendingNote, successRateText, cacheStats,
        toolTop, toolMax, toolTotal, conversations, perceptions, activeGroups, scopeCount,
        runtime, metricRows, changeClass, signed,
      }
    },
    template: `
    <div class="kline-page">
      <page-head title="数据 K 线" icon="chart" desc="Token、请求、工具与运行状态，全部汇到这张 K 线页 · 纯属整活">
        <span class="pill p-honey">整活</span>
        <span v-if="loading" class="load-state"><span class="load-ring"></span>载入行情…</span>
        <button class="btn b-line b-sm" :disabled="refreshing || loading" @click="reload">
          <v-icon name="refresh"/>{{ refreshing ? '刷新中…' : '刷新' }}
        </button>
      </page-head>

      <div class="kline-intro">
        <p class="kline-joke">老实说，狠枯燥吧</p>
        <p class="kline-joke-sub">把每天的用量当成一根蜡烛。红涨绿跌，总量的影线是当天输入 tokens；分项没有影线，因为那天只有收盘。</p>
        <p v-if="!loading" class="kline-updated">数据更新于 {{ lastUpdatedLabel }} · {{ runtime.provider }} / {{ runtime.model }} · {{ runtime.protocol }}</p>
        <p v-else class="kline-updated">正在载入行情，先把蜡烛摆好…</p>
      </div>

      <div v-if="!loading" class="kline-ready">
      <section class="panel kline-hero">
        <header class="panel-head">
          <div>
            <h2 class="panel-title">Token 总量</h2>
            <p class="panel-meta">近 7 日 · 开=前一日，收=当日 · 影线=当日输入</p>
          </div>
          <span class="panel-stat"><b>{{ fmt.num(tokenStats.last) }}</b> 今收</span>
        </header>
        <div class="kline-hero-grid">
          <div class="chart-body">
            <svg class="chart-svg" :viewBox="'0 0 ' + bigChart.W + ' ' + bigChart.H" role="img" aria-label="Token 总量日 K 线">
              <g class="chart-grid">
                <line v-for="g in bigChart.grid" :key="'g' + g.y" :x1="bigChart.L" :x2="bigChart.W - bigChart.R" :y1="g.y" :y2="g.y"/>
              </g>
              <g class="chart-ticks">
                <text v-for="g in bigChart.grid" :key="'t' + g.y" :x="bigChart.L - 8" :y="g.y + 3.5" text-anchor="end">{{ g.label }}</text>
              </g>
              <line v-for="c in bigChart.candles" :key="'w' + c.day" class="kline-wick" :class="c.up ? 'kline-wick-up' : 'kline-wick-down'" :x1="c.wickX" :x2="c.wickX" :y1="c.wickTop" :y2="c.wickBottom"/>
              <rect v-for="(c, i) in bigChart.candles" :key="'c' + c.day" class="kline-candle" :class="c.up ? 'kline-up' : 'kline-down'" :x="c.x" :y="c.y" :width="c.w" :height="c.h" :style="{ animationDelay: (i * 45) + 'ms' }">
                <title>{{ c.day }} · 开 {{ fmt.num(c.open) }} / 收 {{ fmt.num(c.close) }}（{{ signed(c.change) }}）</title>
              </rect>
              <g class="chart-days">
                <text v-for="d in bigChart.days" :key="'d' + d.label" :x="d.x" :y="bigChart.H - 8" text-anchor="middle">{{ d.label }}</text>
              </g>
              <line v-if="!bigChart.hasData" class="chart-zero" :x1="bigChart.L" :x2="bigChart.W - bigChart.R" :y1="bigChart.zeroY" :y2="bigChart.zeroY"/>
            </svg>
            <div v-if="!bigChart.hasData" class="chart-empty">暂无 Token 数据：产生对话后自动统计</div>
          </div>
          <aside class="kline-quote">
            <div class="quote-label">行情快照</div>
            <div class="quote-value num">{{ fmt.num(tokenStats.last) }}</div>
            <div class="quote-change" :class="changeClass(tokenStats.change)">
              {{ signed(tokenStats.change) }}<span v-if="tokenStats.pct != null"> · {{ tokenStats.pct >= 0 ? '+' : '' }}{{ tokenStats.pct.toFixed(1) }}%</span>
              <em>较昨日</em>
            </div>
            <div class="quote-rows">
              <div class="quote-row"><span>昨收</span><b class="num">{{ fmt.num(tokenStats.prev) }}</b></div>
              <div class="quote-row"><span>峰值</span><b class="num">{{ fmt.num(tokenStats.peak) }}</b></div>
              <div class="quote-row"><span>首日</span><b class="num">{{ fmt.num(tokenStats.first) }}</b></div>
              <div class="quote-row"><span>日均</span><b class="num">{{ fmt.num(tokenStats.avg) }}</b></div>
              <div class="quote-row"><span>区间</span><b class="num">{{ fmt.num(tokenStats.low) }} – {{ fmt.num(tokenStats.peak) }}</b></div>
              <div class="quote-row"><span>波动</span><b class="num">{{ fmt.num(tokenStats.peak - tokenStats.low) }}</b></div>
              <div class="quote-row"><span>请求</span><b class="num">{{ fmt.num(reqStats.sum) }}</b></div>
              <div class="quote-row"><span>工具</span><b class="num">{{ fmt.num(toolTotal) }}</b></div>
            </div>
            <p class="quote-note">不是行情。只是自家 Agent 的 Token。</p>
          </aside>
        </div>
      </section>

      <div class="kline-small-grid">
        <section class="panel">
          <header class="panel-head">
            <div><h2 class="panel-title">输入 tokens</h2><p class="panel-meta">近 7 日 · 今收 {{ fmt.num(inStats.last) }}</p></div>
            <span class="quote-change" :class="changeClass(inStats.change)">{{ signed(inStats.change) }}</span>
          </header>
          <div class="chart-body">
            <svg class="chart-svg" :viewBox="'0 0 ' + inChart.W + ' ' + inChart.H" role="img" aria-label="输入 tokens 日 K 线">
              <g class="chart-grid"><line v-for="g in inChart.grid" :key="'ig' + g.y" :x1="inChart.L" :x2="inChart.W - inChart.R" :y1="g.y" :y2="g.y"/></g>
              <g class="chart-ticks"><text v-for="g in inChart.grid" :key="'it' + g.y" :x="inChart.L - 8" :y="g.y + 3.5" text-anchor="end">{{ g.label }}</text></g>
              <rect v-for="(c, i) in inChart.candles" :key="'ic' + c.day" class="kline-candle" :class="c.up ? 'kline-up' : 'kline-down'" :x="c.x" :y="c.y" :width="c.w" :height="c.h" :style="{ animationDelay: (i * 45) + 'ms' }"><title>{{ c.day }} · {{ fmt.num(c.close) }}</title></rect>
              <g class="chart-days"><text v-for="d in inChart.days" :key="'id' + d.label" :x="d.x" :y="inChart.H - 8" text-anchor="middle">{{ d.label }}</text></g>
            </svg>
            <div v-if="!inChart.hasData" class="chart-empty">暂无数据</div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head">
            <div><h2 class="panel-title">输出 tokens</h2><p class="panel-meta">近 7 日 · 今收 {{ fmt.num(outStats.last) }}</p></div>
            <span class="quote-change" :class="changeClass(outStats.change)">{{ signed(outStats.change) }}</span>
          </header>
          <div class="chart-body">
            <svg class="chart-svg" :viewBox="'0 0 ' + outChart.W + ' ' + outChart.H" role="img" aria-label="输出 tokens 日 K 线">
              <g class="chart-grid"><line v-for="g in outChart.grid" :key="'og' + g.y" :x1="outChart.L" :x2="outChart.W - outChart.R" :y1="g.y" :y2="g.y"/></g>
              <g class="chart-ticks"><text v-for="g in outChart.grid" :key="'ot' + g.y" :x="outChart.L - 8" :y="g.y + 3.5" text-anchor="end">{{ g.label }}</text></g>
              <rect v-for="(c, i) in outChart.candles" :key="'oc' + c.day" class="kline-candle" :class="c.up ? 'kline-up' : 'kline-down'" :x="c.x" :y="c.y" :width="c.w" :height="c.h" :style="{ animationDelay: (i * 45) + 'ms' }"><title>{{ c.day }} · {{ fmt.num(c.close) }}</title></rect>
              <g class="chart-days"><text v-for="d in outChart.days" :key="'od' + d.label" :x="d.x" :y="outChart.H - 8" text-anchor="middle">{{ d.label }}</text></g>
            </svg>
            <div v-if="!outChart.hasData" class="chart-empty">暂无数据</div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head">
            <div><h2 class="panel-title">对话轮次</h2><p class="panel-meta">近 7 日 · 今收 {{ fmt.num(reqStats.last) }}</p></div>
            <span class="quote-change" :class="changeClass(reqStats.change)">{{ signed(reqStats.change) }}</span>
          </header>
          <div class="chart-body">
            <svg class="chart-svg" :viewBox="'0 0 ' + reqChart.W + ' ' + reqChart.H" role="img" aria-label="对话轮次日 K 线">
              <g class="chart-grid"><line v-for="g in reqChart.grid" :key="'rg' + g.y" :x1="reqChart.L" :x2="reqChart.W - reqChart.R" :y1="g.y" :y2="g.y"/></g>
              <g class="chart-ticks"><text v-for="g in reqChart.grid" :key="'rt' + g.y" :x="reqChart.L - 8" :y="g.y + 3.5" text-anchor="end">{{ g.label }}</text></g>
              <rect v-for="(c, i) in reqChart.candles" :key="'rc' + c.day" class="kline-candle" :class="c.up ? 'kline-up' : 'kline-down'" :x="c.x" :y="c.y" :width="c.w" :height="c.h" :style="{ animationDelay: (i * 45) + 'ms' }"><title>{{ c.day }} · {{ c.close }} 轮</title></rect>
              <g class="chart-days"><text v-for="d in reqChart.days" :key="'rd' + d.label" :x="d.x" :y="reqChart.H - 8" text-anchor="middle">{{ d.label }}</text></g>
            </svg>
            <div v-if="!reqChart.hasData" class="chart-empty">暂无数据</div>
          </div>
        </section>
      </div>

      <div class="kline-lower">
        <section class="panel">
          <header class="panel-head">
            <div><h2 class="panel-title">全部数据</h2><p class="panel-meta">近 7 日汇总 · 所有能看的都在这里</p></div>
          </header>
          <div class="tbl-w">
            <table class="tbl kline-table">
              <thead><tr><th>指标</th><th class="num">合计</th><th class="num">日均</th><th class="num">峰值</th><th>备注</th></tr></thead>
              <tbody>
                <tr v-for="r in metricRows" :key="r.name">
                  <td>{{ r.name }}</td>
                  <td class="num">{{ fmt.num(r.total) }}</td>
                  <td class="num">{{ r.avg == null ? '—' : fmt.num(Math.round(r.avg)) }}</td>
                  <td class="num">{{ r.peak == null ? '—' : fmt.num(r.peak) }}</td>
                  <td class="mut">{{ r.note }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head">
            <div><h2 class="panel-title">工具与缓存</h2><p class="panel-meta">Top 5 · 共 {{ fmt.num(toolTotal) }} 次</p></div>
            <a class="panel-link" href="#/evolution">工具进化 <span aria-hidden="true">→</span></a>
          </header>
          <div v-if="toolTop.length" class="tool-rank">
            <div v-for="(t, i) in toolTop" :key="t.name" class="tool-row">
              <div class="tool-row-top">
                <span class="tool-name mono">{{ t.name }}</span>
                <span class="tool-count num">{{ fmt.num(t.count) }}<em> 次</em></span>
              </div>
              <div class="tool-track"><i :style="{ width: (t.count / toolMax * 100) + '%', animationDelay: (i * 45) + 'ms' }"></i></div>
            </div>
          </div>
          <div v-else class="detail-empty">暂无工具调用</div>
          <div class="kline-cache">
            <div><span>缓存读取</span><b class="num">{{ fmt.num(cacheStats.cached) }}</b></div>
            <div><span>缓存命中率</span><b class="num">{{ cacheStats.hit != null ? cacheStats.hit.toFixed(1) + '%' : '—' }}</b></div>
            <div><span>工具成功率</span><b class="num">{{ successRateText }}</b></div>
            <div><span>待你决定</span><b class="num">{{ pending }}</b></div>
          </div>
        </section>
      </div>

      <p class="kline-disclaimer">仅用于观察自家 Agent 的用量，不构成任何投资建议。</p>
      </div>
      <div v-else class="kline-loading" role="status" aria-live="polite">
        <div class="kline-load-head">
          <span class="load-ring"></span>
          <div><b>正在开盘</b><span>拉取 Token、请求与工具数据…</span></div>
        </div>
        <div class="kline-load-hero">
          <div class="kline-load-head-lines">
            <div class="skel skel-line w30"></div>
            <div class="skel skel-line w18"></div>
          </div>
          <div class="kline-load-hero-grid">
            <div class="kline-load-chart">
              <i v-for="i in 7" :key="i" class="skel-candle" :style="{ height: (22 + (i * 13) % 56) + '%', animationDelay: (i * 70) + 'ms' }"></i>
            </div>
            <div class="kline-load-quote">
              <div class="skel skel-line w40"></div>
              <div class="skel skel-line w60"></div>
              <div class="skel skel-line w30"></div>
              <div class="skel skel-line w60"></div>
              <div class="skel skel-line w30"></div>
              <div class="skel skel-line w60"></div>
              <div class="skel skel-line w30"></div>
            </div>
          </div>
        </div>
        <div class="kline-load-small">
          <div v-for="i in 3" :key="i" class="kline-load-card">
            <div class="skel skel-line w40"></div>
            <div class="skel skel-line w20"></div>
            <div class="skel kline-load-mini"></div>
          </div>
        </div>
      </div>
    </div>`,
  }
})()
