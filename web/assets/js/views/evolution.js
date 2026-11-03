/** 视图:工具进化(Tool Evolution)· 候选版本/状态/审批/淘汰 */
;(function () {
  window.VIEWS = window.VIEWS || {}
  const STATUS = {
    draft: { name: '草稿', cls: 'p-line' },
    verified: { name: '待采纳', cls: 'p-honey' },
    stable: { name: '已上线', cls: 'p-green' },
    rejected: { name: '已拒绝', cls: 'p-rose' },
    deprecated: { name: '已淘汰', cls: 'p-line' },
    quarantined: { name: '隔离', cls: 'p-rose' },
  }

  window.VIEWS.evolution = {
    name: 'EvolutionView',
    setup() {
      const { ref, computed, onMounted } = Vue
      const { toast } = window.UI

      const list = ref([])
      const loading = ref(false)
      const filter = ref('')
      const detail = ref(null)
      const metrics = ref(null)
      const health = ref([])

      const load = async () => {
        loading.value = true
        try {
          const [tools, m, h] = await Promise.all([
            window.api.get('/tevo/tools'),
            window.api.get('/tevo/metrics').catch(() => null),
            window.api.get('/tevo/health').catch(() => []),
          ])
          list.value = tools || []
          metrics.value = m || null
          health.value = Array.isArray(h) ? h : []
        } catch (e) { toast(e.message, 'error') }
        finally { loading.value = false }
      }
      const approve = async (id) => {
        try { await window.api.post('/tevo/tools/' + id + '/approve'); toast('已采纳并注入，agent 可调用', 'success'); await load() }
        catch (e) { toast(e.message, 'error') }
      }
      const decommission = async (id) => {
        try { await window.api.post('/tevo/tools/' + id + '/decommission'); toast('已淘汰', 'info'); await load() }
        catch (e) { toast(e.message, 'error') }
      }
      const rollback = async (id) => {
        try { const r = await window.api.post('/tevo/tools/' + id + '/rollback'); toast(r.msg || '已设为当前上线版本', 'success'); await load() }
        catch (e) { toast(e.message, 'error') }
      }
      const loadDetail = async (id) => {
        try { detail.value = await window.api.get('/tevo/tools/' + id) }
        catch (e) { toast(e.message, 'error') }
      }

      const stats = computed(() => {
        const c = { draft: 0, verified: 0, stable: 0, rejected: 0, deprecated: 0 }
        for (const v of list.value) c[v.status] = (c[v.status] || 0) + 1
        return c
      })
      const filtered = computed(() => filter.value ? list.value.filter((v) => v.status === filter.value) : list.value)

      onMounted(load)
      return { list, loading, filter, filtered, stats, metrics, health, load, approve, decommission, rollback, detail, loadDetail, STATUS }
    },
    template: `
    <div>
      <page-head title="工具进化" icon="tool" desc="Tool Evolution · 候选生成(LLM+AST) → 验证(沙箱) → 审批 → 版本。在 QQ 对 bot 发 #进化工具 <能力描述> 生成候选">
        <button class="btn b-line" @click="load"><v-icon name="refresh"/>刷新</button>
      </page-head>

      <div class="card pad" style="--i:1" v-if="metrics">
        <div class="row g8 wrap">
          <span class="pill p-green">active {{ metrics.activeStable }}</span>
          <span class="pill p-line">stable {{ metrics.stable }}</span>
          <span class="pill p-line">版本 {{ metrics.totalVersions }}</span>
          <span class="pill p-sky">调用 {{ metrics.invocations }}</span>
          <span class="pill" :class="metrics.invocationFailRate > 0.2 ? 'p-rose' : 'p-line'">失败率 {{ (metrics.invocationFailRate * 100).toFixed(0) }}%</span>
          <span class="pill p-line">复用率 {{ (metrics.reuseRate * 100).toFixed(0) }}%</span>
        </div>
        <div v-if="health.length" class="mt12" style="display:flex;flex-direction:column;gap:6px">
          <div v-for="h in health" :key="h.versionId" class="mut" style="font-size:12px">
            ⚠️ <b class="mono">{{ h.toolName }}@{{ h.semver }}</b> 失败率 {{ (h.failRate * 100).toFixed(0) }}%（{{ h.failed }}/{{ h.total }}）· {{ h.topErrors.join(', ') }}
            <span class="mut2">→ #进化工具 修复 {{ h.toolName }} &lt;修复描述&gt;</span>
          </div>
        </div>
      </div>

      <div class="card pad" style="--i:1">
        <div class="row g8 wrap mb16">
          <button class="pill" :class="filter === '' ? 'p-pri' : ''" style="cursor:pointer" @click="filter=''">全部 {{ list.length }}</button>
          <button class="pill" :class="filter === 'verified' ? 'p-honey' : ''" style="cursor:pointer" @click="filter='verified'">待采纳 {{ stats.verified || 0 }}</button>
          <button class="pill" :class="filter === 'stable' ? 'p-green' : ''" style="cursor:pointer" @click="filter='stable'">已上线 {{ stats.stable || 0 }}</button>
          <button class="pill" :class="filter === 'rejected' ? 'p-rose' : ''" style="cursor:pointer" @click="filter='rejected'">已拒绝 {{ stats.rejected || 0 }}</button>
        </div>

        <empty-state v-if="!filtered.length && !loading" icon="tool" text="暂无进化工具版本" sub="在 QQ 对 bot 发 #进化工具 <能力描述> 生成候选"/>

        <div style="display:flex;flex-direction:column;gap:10px">
          <div v-for="v in filtered" :key="v.id" class="mem-row" style="align-items:center">
            <span class="pill" :class="(STATUS[v.status] || STATUS.draft).cls">{{ (STATUS[v.status] || STATUS.draft).name }}</span>
            <div style="flex:1;min-width:0">
              <b style="font-size:13px" class="mono">{{ v.name || v.tool_id }}</b>
              <span class="mono mut" style="margin-left:8px">v{{ v.semver }}</span>
              <span v-if="v.active" class="pill p-green" style="margin-left:6px">★ 当前上线</span>
              <div class="mut ell" style="font-size:12px;margin-top:2px">{{ v.description || '（无描述）' }}</div>
              <div class="mut2 mono ell" style="font-size:10.5px;margin-top:2px">
                id: {{ v.id }} · 权限: {{ (v.sideEffects || []).join('/') || '—' }} · 测试: {{ v.tests_count ?? 0 }} · 类别: {{ v.category || '—' }} · 来源: {{ v.provenanceKind || '—' }} · 生成模型: {{ v.generator_model || '—' }}
              </div>
            </div>
            <div class="row g6 wrap">
              <button class="btn b-line b-sm" @click="loadDetail(v.id)"><v-icon name="search"/>详情</button>
              <button v-if="v.status==='verified'" class="btn b-pri b-sm" @click="approve(v.id)"><v-icon name="check"/>采纳上线</button>
              <button v-if="v.status==='stable'" class="btn b-line b-sm" @click="rollback(v.id)"><v-icon name="undo"/>设为当前</button>
              <button v-if="v.status==='stable'" class="btn b-danger b-sm" @click="decommission(v.id)">淘汰</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 版本详情：源码 / 测试 / 验证证据，采纳前可审阅 -->
      <v-modal v-if="detail" :title="(detail.name || detail.tool_id) + ' v' + detail.semver" icon="tool" width="900px" @close="detail = null">
        <div class="row g6 wrap">
          <span class="pill" :class="(STATUS[detail.status] || STATUS.draft).cls">{{ (STATUS[detail.status] || STATUS.draft).name }}</span>
          <span class="pill p-line mono">{{ detail.namespace || '—' }}</span>
          <span class="pill p-line">{{ detail.category || '—' }}</span>
          <span class="pill p-line">权限 {{ (detail.manifest?.permissions?.sideEffects || []).join('/') || '—' }}</span>
          <span v-if="detail.active" class="pill p-green">★ 当前上线</span>
        </div>
        <p class="mut mt12" style="font-size:13px">{{ detail.manifest?.description || '（无描述）' }}</p>
        <div class="mut2 mono" style="font-size:11px;line-height:1.7">
          id: {{ detail.id }}<br>
          内容哈希: {{ detail.contentHash || '—' }} · 源码哈希: {{ detail.sourceHash || '—' }}<br>
          验证器: {{ detail.verifiedVerifier || '—' }} · 父版本: {{ detail.parentVersionId || '—' }} · 生成模型: {{ detail.generatorModel || '—' }}
        </div>
        <div class="field mt16">
          <label class="f-label">验证证据</label>
          <pre class="code" style="white-space:pre-wrap;max-height:180px;overflow:auto">{{ JSON.stringify(detail.evidence || {}, null, 2) }}</pre>
        </div>
        <div class="field mt16">
          <label class="f-label">测试用例（{{ (detail.tests || []).length }}）</label>
          <pre class="code" style="white-space:pre-wrap;max-height:220px;overflow:auto">{{ JSON.stringify(detail.tests || [], null, 2) }}</pre>
        </div>
        <div class="field mt16">
          <label class="f-label">源码</label>
          <pre class="code" style="white-space:pre-wrap;max-height:360px;overflow:auto">{{ detail.source || '（内置工具无制品源码）' }}</pre>
        </div>
      </v-modal>
    </div>`,
  }
})()
