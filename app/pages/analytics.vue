<script setup lang="ts">
useHead({ title: 'Visual Analytics · OracleDB Data Lab' })
const { activeId } = useActiveProfile()
const { schema, prefix } = useLabTarget()
const months = ref(24)
const a = useLoader<any>(() => (activeId.value && schema.value ? `/api/connections/${activeId.value}/analytics` : null), {
  query: () => ({ schema: schema.value, prefix: prefix.value, months: months.value }),
})
const monthX = (m: string) => Date.parse(`${m}-01T00:00:00`)
const fmtMonth = (v: number) => new Date(v).toLocaleDateString(undefined, { year: '2-digit', month: 'short' })
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Visual Analytics</h1>
        <p>Business views over a generated dataset. Each chart is an aggregate query against the lab tables — useful to see seasonality, skew and lifecycle patterns the generator produced.</p>
      </div>
      <div class="row">
        <label class="field"><span>Schema</span><input v-model="schema" class="input mono" style="width: 140px" ></label>
        <label class="field"><span>Prefix</span><input v-model="prefix" class="input mono" style="width: 90px" ></label>
        <label class="field">
          <span>Window</span>
          <select v-model.number="months" class="input">
            <option :value="6">6 months</option>
            <option :value="12">12 months</option>
            <option :value="24">24 months</option>
            <option :value="60">5 years</option>
          </select>
        </label>
      </div>
    </div>
    <UiRequireProfile>
      <div v-if="a.error.value" class="callout bad">{{ a.error.value }}</div>
      <div v-else-if="!a.data.value" class="subtle">Running aggregate queries…</div>
      <div v-else class="stack">
        <div class="grid two">
          <UiCard title="Revenue per month" icon="lucide:trending-up">
            <UiPanelView :panel="a.data.value.monthly" empty-text="No orders in this window — generate data first.">
              <template #default="{ data }">
                <ChartsLine :series="[{ name: 'Revenue (IDR)', points: data.map((m: any) => ({ x: monthX(m.month), y: m.revenue })) }]" :x-format="fmtMonth" :y-format="(v) => fmtCompact(v)" area :height="200" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Orders and active customers per month" icon="lucide:users">
            <UiPanelView :panel="a.data.value.monthly">
              <template #default="{ data }">
                <ChartsLine
                  :series="[
                    { name: 'Orders', slot: 0, points: data.map((m: any) => ({ x: monthX(m.month), y: m.orders })) },
                    { name: 'Distinct customers', slot: 2, points: data.map((m: any) => ({ x: monthX(m.month), y: m.customers })) },
                    { name: 'Cancelled', slot: 1, points: data.map((m: any) => ({ x: monthX(m.month), y: m.cancelled })) },
                  ]"
                  :x-format="fmtMonth"
                  :height="200"
                />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Revenue by category" icon="lucide:shapes">
            <UiPanelView :panel="a.data.value.byCategory">
              <template #default="{ data }">
                <ChartsBars :items="data.map((c: any) => ({ label: c.category, value: c.revenue, sub: `returns ${fmtPct(c.returnRatePct)}` }))" :format="(v) => fmtCompact(v)" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Orders by channel" icon="lucide:store">
            <UiPanelView :panel="a.data.value.byChannel">
              <template #default="{ data }">
                <ChartsBars :items="data.map((c: any) => ({ label: c.channel, value: c.orders, sub: fmtCompact(c.revenue) }))" :format="(v) => fmtCompact(v)" :hue="2" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Order status mix" icon="lucide:list-checks">
            <UiPanelView :panel="a.data.value.byStatus">
              <template #default="{ data }">
                <ChartsBars :items="data.map((c: any) => ({ label: c.status, value: c.orders }))" :format="(v) => fmtCompact(v)" :hue="1" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Orders by weekday" icon="lucide:calendar-days">
            <UiPanelView :panel="a.data.value.weekday">
              <template #default="{ data }">
                <ChartsBars :items="data.map((c: any) => ({ label: c.day, value: c.orders }))" :format="(v) => fmtCompact(v)" />
              </template>
            </UiPanelView>
          </UiCard>
        </div>
        <UiCard title="Top customers" icon="lucide:crown" flush>
          <div style="padding: 12px">
            <UiPanelView :panel="a.data.value.topCustomers">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[{ key: 'customer', label: 'Customer', mono: true }, { key: 'segment', label: 'Segment' }, { key: 'tier', label: 'Tier' }, { key: 'orders', label: 'Orders', num: true }, { key: 'revenue', label: 'Revenue', num: true, format: (v) => fmtNum(v, 0) }]"
                  :rows="data"
                  row-key="customer"
                />
              </template>
            </UiPanelView>
          </div>
        </UiCard>
      </div>
    </UiRequireProfile>
  </div>
</template>
