/**
 * dsh-sound-cues 宿主半边冒烟测试（不依赖 DSH，直接桩一个 cordis ctx 跑真代码）。
 * 用法： node test/host-smoke.mjs
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN = resolve(HERE, '..')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

/* ── 桩：cordis ctx ── */
const handlers = new Map()
const routes = []
let jobsHooked = false
let jobDone = null
const ctx = {
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(fn)
  },
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') d()
    return () => {}
  },
  webServer: {
    register({ kind, path, handler }) {
      routes.push({ kind, path, handler })
      return () => {}
    },
  },
  // 后台作业没有 cordis 事件，只有服务回调（family C）
  jobs: {
    onJobDone(fn) {
      jobsHooked = true
      jobDone = fn
      return () => {}
    },
  },
  logger: { warn: (m) => console.log('    [warn] ' + m) },
}
/** 队列游标：每段测试自己记录基准，避免互相干扰。 */
let LAST = 0
const res0Ok = (j) => !!j && j.ok === true && Array.isArray(j.cues)

const mod = await import('file://' + join(PLUGIN, 'lib', 'index.js').replace(/\\/g, '/'))

console.log('\n== 模块契约 ==')
ok('导出 name === "dsh-sound-cues"', mod.name === 'dsh-sound-cues', `got ${mod.name}`)
ok('导出 apply 是函数', typeof mod.apply === 'function')
ok('inject 含 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'))

mod.apply(ctx)

console.log('\n== 路由注册 ==')
const paths = routes.map((r) => r.path).sort()
ok('注册了 /sound-cues/events', paths.includes('/sound-cues/events'), paths.join(','))
ok('注册了 /sound-cues/state', paths.includes('/sound-cues/state'))
ok('注册了 /sound-cues/assets', paths.includes('/sound-cues/assets'))
ok('注册了 /sound-cues/audio', paths.includes('/sound-cues/audio'))
ok('注册了 /sound-cues/upload', paths.includes('/sound-cues/upload'))
ok('注册了 /sound-cues/config', paths.includes('/sound-cues/config'))
ok('路由数 >= 7', routes.length >= 7, String(routes.length))

console.log('\n== 事件订阅 ==')
ok('订阅了 session/event', handlers.has('session/event'))
ok('订阅了 goal/changed', handlers.has('goal/changed'))

/* ── 桩：http req/res ── */
function fakeRes() {
  return {
    headersSent: false,
    status: 0,
    headers: null,
    body: '',
    writeHead(s, h) {
      this.headersSent = true
      this.status = s
      this.headers = h
    },
    end(b) {
      this.body = Buffer.isBuffer(b) ? b : String(b ?? '')
    },
  }
}
function fakeReq(url, method = 'GET', body = null) {
  const ls = {}
  const req = {
    url,
    method,
    on(ev, fn) {
      ;(ls[ev] = ls[ev] || []).push(fn)
      return req
    },
    destroy() {},
  }
  setTimeout(() => {
    if (body) for (const f of ls.data || []) f(Buffer.isBuffer(body) ? body : Buffer.from(body))
    for (const f of ls.end || []) f()
  }, 0)
  return req
}
const call = async (path, method = 'GET', body = null) => {
  const route = routes
    .slice()
    .sort((a, b) => b.path.length - a.path.length)
    .find((r) => (r.kind === 'exact' ? r.path === path.split('?')[0] : path.startsWith(r.path)))
  if (!route) throw new Error('no route for ' + path)
  const res = fakeRes()
  route.handler(fakeReq(path, method, body), res)
  const t0 = Date.now()
  while (!res.headersSent && Date.now() - t0 < 400) await new Promise((r) => setTimeout(r, 5))
  return res
}
const jsonOf = (res) => {
  try {
    return JSON.parse(res.body)
  } catch {
    return null
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('\n== GET /sound-cues/state ==')
{
  const res = await call('/sound-cues/state')
  const j = jsonOf(res)
  ok('200 + ok:true', res.status === 200 && j && j.ok === true, res.body.slice(0, 120))
  ok('带 seq 字段', j && typeof j.seq === 'number')
  ok('带 uploadDir', j && typeof j.uploadDir === 'string')
}

console.log('\n== 事件 → cue 队列 ==')
{
  const se = handlers.get('session/event')[0]
  se({}, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom', code: 'X' } } } })
  se({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  se({}, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  se({}, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  se({}, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  se({}, { type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  // 工具失败的真判据是 message.content[0].isError
  se({}, { type: 'tool/result', data: { message: { content: [{ isError: true }] }, error: { name: 'E', code: 'ABORTED' } } })
  se({}, { type: 'tool/result', data: { message: { content: [{ isError: false }] } } })
  // 高频事件必须被忽略
  se({}, { type: 'assistant/chunk', data: { chunk: 'x' } })
  se({}, { type: 'step/start', data: { step: 1 } })

  const j = jsonOf(await call('/sound-cues/events?since=0'))
  const cues = j.cues.map((c) => c.cue)
  ok('200 + 有 cues', res0Ok(j), JSON.stringify(j).slice(0, 120))
  ok('turn/end(error) → turn.error', cues.includes('turn.error'), cues.join(','))
  ok('turn/end(completed) → turn.done', cues.includes('turn.done'))
  ok('turn/end(aborted) → turn.aborted', cues.includes('turn.aborted'))
  ok('turn/end(blocked) → turn.blocked', cues.includes('turn.blocked'))
  ok('turn/end(max-tokens) → turn.maxTokens', cues.includes('turn.maxTokens'))
  ok('turn/end(interrupted) → turn.aborted', cues.filter((c) => c === 'turn.aborted').length === 2, cues.join(','))
  ok('tool/result(isError) → tool.error', cues.includes('tool.error'))
  ok('tool/result(ok) → tool.done', cues.includes('tool.done'))
  ok('assistant/chunk 与 step/start 被忽略（共 8 条）', j.cues.length === 8, `got ${j.cues.length}: ${cues.join(',')}`)
  ok('cue 带自增 id', j.cues[0].id === 1 && j.cues[7].id === 8, JSON.stringify(j.cues.map((c) => c.id)))
  ok('error cue 带 error 摘要', (j.cues.find((c) => c.cue === 'turn.error') || {}).meta?.error === 'boom')
  ok('aborted cue 带 cause=user', (j.cues.find((c) => c.cue === 'turn.aborted') || {}).meta?.cause === 'user')
  ok('tool.error 带 error code', (j.cues.find((c) => c.cue === 'tool.error') || {}).meta?.error === 'ABORTED')
  LAST = j.seq
}

console.log('\n== 会话事件：审批 / 计划 / 命令 / 压缩 / 任务板 ==')
{
  const se = handlers.get('session/event')[0]
  const base = LAST
  se({}, { type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh' } })
  se({}, { type: 'plan/mode', data: { active: true } })
  se({}, { type: 'plan/mode', data: { active: false } })
  se({}, { type: 'command/done', data: { kind: 'error', text: 'nope' } })
  se({}, { type: 'command/done', data: { kind: 'success' } })
  se({}, { type: 'compaction/end', data: { compactionId: 'c1', error: 'failed' } })
  se({}, { type: 'compaction/end', data: { compactionId: 'c2' } })
  se({}, { type: 'team/task', data: { task: { status: 'pending', subject: 'T1' } } })
  se({}, { type: 'team/task', data: { task: { status: 'in_progress', subject: 'T1' } } })
  se({}, { type: 'team/task', data: { task: { status: 'completed', subject: 'T1' } } })
  se({}, { type: 'todo/write', data: { todos: [] } })

  const j = jsonOf(await call('/sound-cues/events?since=' + base))
  const cues = j.cues.map((c) => c.cue)
  ok('approval/asked → approval.request', cues.includes('approval.request'), cues.join(','))
  ok('plan/mode(true) → plan.entered', cues.includes('plan.entered'))
  ok('plan/mode(false) → plan.exited', cues.includes('plan.exited'))
  ok('command/done(error) → command.error', cues.includes('command.error'))
  ok('command/done(success) 不响', !cues.includes('command.done'))
  ok('compaction/end(error) 与 (ok) 都映射到 session.compaction', cues.filter((c) => c === 'session.compaction').length === 2, cues.join(','))
  ok('team/task pending → task.created', cues.includes('task.created'))
  ok('team/task in_progress → task.claimed', cues.includes('task.claimed'))
  ok('team/task completed → task.completed', cues.includes('task.completed'))
  ok('todo/write → todo.updated', cues.includes('todo.updated'))
  LAST = j.seq
}

console.log('\n== cordis 事件：agent/error · subagent · workflow ==')
{
  const base = LAST
  handlers.get('agent/error')[0]({ agent: {}, turn: 1, step: 1, error: new Error('x') })
  handlers.get('subagent/start')[0]({ runId: 'r1', provider: 'p', id: 's1', local: true })
  handlers.get('subagent/end')[0]({ runId: 'r1', stopReason: 'completed' })
  handlers.get('subagent/end')[0]({ runId: 'r2', stopReason: 'error' })
  handlers.get('workflow/start')[0]({ runId: 'w1' })
  handlers.get('workflow/end')[0]({ runId: 'w1' }, { stopReason: 'completed' })
  handlers.get('workflow/end')[0]({ runId: 'w2' }, { stopReason: 'CANCELLED' })

  const j = jsonOf(await call('/sound-cues/events?since=' + base))
  const cues = j.cues.map((c) => c.cue)
  ok('agent/error → task.failed', cues.includes('task.failed'), cues.join(','))
  ok('subagent/start → subagent.spawned', cues.includes('subagent.spawned'))
  ok('subagent/end(completed) → subagent.done', cues.includes('subagent.done'))
  ok('subagent/end(error) → subagent.failed', cues.includes('subagent.failed'))
  ok('workflow/start → workflow.start', cues.includes('workflow.start'))
  ok('workflow/end(completed) → workflow.done', cues.includes('workflow.done'))
  ok('workflow/end(CANCELLED) → workflow.failed', cues.includes('workflow.failed'))
  LAST = j.seq
}

console.log('\n== 后台作业（服务回调，无 cordis 事件） ==')
{
  ok('apply 时尝试挂了 jobs.onJobDone', jobsHooked, 'jobs callback not registered')
  if (jobsHooked) {
    const base = LAST
    jobDone({ id: 'job-1', kind: 'bash', status: 'completed', detail: 'exit code: 0' })
    jobDone({ id: 'job-2', kind: 'bash', status: 'failed', detail: 'exit code: 3' })
    jobDone({ id: 'job-3', kind: 'bash', status: 'killed' })
    const j = jsonOf(await call('/sound-cues/events?since=' + base))
    const cues = j.cues.map((c) => c.cue)
    ok('job completed → job.done', cues.includes('job.done'), cues.join(','))
    ok('job failed → job.failed', cues.includes('job.failed'))
    ok('job killed → job.failed', cues.filter((c) => c === 'job.failed').length === 2, cues.join(','))
    ok('失败作业带 detail', (j.cues.find((c) => c.cue === 'job.failed') || {}).meta?.detail === 'exit code: 3')
    LAST = j.seq
  }
}

console.log('\n== goal/changed → cue ==')
{
  const base = LAST
  const goalHandler = handlers.get('goal/changed')[0]
  goalHandler({ change: { operation: 'complete', goal: { phase: 'complete', objective: '做完插件' } } })
  goalHandler({ change: { operation: 'block', goal: { phase: 'blocked', blockedReason: { code: 'x', message: 'y' } } } })
  goalHandler({ change: { operation: 'pause', goal: { phase: 'paused' } } })
  goalHandler({ change: { operation: 'clear' } })
  goalHandler({ change: { goal: { phase: 'active' } } })
  const j = jsonOf(await call('/sound-cues/events?since=' + base))
  const cues = j.cues.map((c) => c.cue)
  ok('operation=complete → goal.completed', cues.includes('goal.completed'), cues.join(','))
  ok('operation=block → goal.blocked', cues.includes('goal.blocked'))
  ok('operation=pause → goal.paused', cues.includes('goal.paused'))
  ok('operation=clear → goal.cleared', cues.includes('goal.cleared'))
  ok('无 operation 且 phase=active 时不误报', j.cues.length === 4, `got ${j.cues.length}: ${cues.join(',')}`)
  ok('goal.completed 带目标文本', (j.cues.find((c) => c.cue === 'goal.completed') || {}).meta?.goal === '做完插件')
  LAST = j.seq
}

console.log('\n== 增量拉取（since） ==')
{
  // since 落在队列中间 → 只回之后的部分
  const mid = jsonOf(await call('/sound-cues/events?since=' + (LAST - 1)))
  ok('since=队尾-1 只回最后 1 条', mid.cues.length === 1, JSON.stringify(mid.cues.map((c) => c.id)))
  // since 追上队尾 → 没有新 cue，长轮询应当挂起而不是立刻返回空
  const res = await call('/sound-cues/events?since=' + LAST)
  ok('since 追上队尾时长轮询挂起（不立刻回空）', res.body === '', 'body=' + res.body.slice(0, 60))
}

console.log('\n== 上传 / 列表 / 取音频 ==')
{
  const wav = Buffer.alloc(64)
  wav.write('RIFF', 0)
  const up = jsonOf(await call('/sound-cues/upload?name=test-tone.wav', 'POST', wav))
  ok('上传返回 ok', up && up.ok === true, JSON.stringify(up))

  const assets = jsonOf(await call('/sound-cues/assets'))
  ok('列表含刚上传的文件', assets.files.some((f) => f.name === 'test-tone.wav'), JSON.stringify(assets.files))
  ok('自定义文件带 custom:true', (assets.files.find((f) => f.name === 'test-tone.wav') || {}).custom === true)

  const audio = await call('/sound-cues/audio/custom/test-tone.wav')
  ok('取音频 200', audio.status === 200)
  ok('Content-Type = audio/wav', audio.headers && audio.headers['Content-Type'] === 'audio/wav', String(audio.headers && audio.headers['Content-Type']))
  ok('字节数一致', audio.body.length === 64, String(audio.body.length))

  // 路径穿越必须被拒
  const evil = await call('/sound-cues/audio/..%2F..%2F..%2Fpackage.json')
  ok('路径穿越被拒（非 200）', evil.status !== 200, `status=${evil.status}`)

  // 非法扩展名必须被拒
  const bad = jsonOf(await call('/sound-cues/upload?name=evil.exe', 'POST', wav))
  ok('非音频扩展名被拒', bad && bad.ok === false, JSON.stringify(bad))

  // 删除
  const del = jsonOf(await call('/sound-cues/delete/test-tone.wav'))
  ok('删除返回 ok', del && del.ok === true, JSON.stringify(del))
  const after = jsonOf(await call('/sound-cues/assets'))
  ok('删除后列表里没了', !after.files.some((f) => f.name === 'test-tone.wav'))
}

console.log('\n== 设置读写 ==')
{
  const before = jsonOf(await call('/sound-cues/config'))
  ok('GET config 返回对象', before && before.ok === true && typeof before.config === 'object')
  const payload = JSON.stringify({ config: { __soundCues: { enabled: false, volume: 0.25 } } })
  const post = jsonOf(await call('/sound-cues/config', 'POST', payload))
  ok('POST config 回显', post.ok === true && post.config.__soundCues.volume === 0.25, JSON.stringify(post))
  const after = jsonOf(await call('/sound-cues/config'))
  ok('再次 GET 拿到刚写的值', after.config.__soundCues.volume === 0.25)
  const badPost = await call('/sound-cues/config', 'POST', JSON.stringify({ nope: 1 }))
  ok('非法 body 返回 400', badPost.status === 400, String(badPost.status))
}

console.log('\n== 手动 ping ==')
{
  const j = jsonOf(await call('/sound-cues/ping?cue=goal.completed'))
  ok('ping 返回 ok + cue', j.ok === true && j.cue === 'goal.completed')
  const after = jsonOf(await call('/sound-cues/events?since=' + (j.seq - 1)))
  ok('ping 的 cue 进了队列', after.cues.some((c) => c.cue === 'goal.completed'))
}

console.log('\n== 浏览器半边心跳 ==')
{
  const before = jsonOf(await call('/sound-cues/state'))
  ok('未报到时 client 为 null', before.client === null, JSON.stringify(before.client))
  const hello = jsonOf(
    await call('/sound-cues/hello', 'POST', JSON.stringify({ version: '0.1.0', slots: { settings: 'ok' } })),
  )
  ok('hello 返回 ok', hello && hello.ok === true, JSON.stringify(hello))
  const after = jsonOf(await call('/sound-cues/state'))
  ok('state.client 记录了报到', !!after.client && after.client.version === '0.1.0', JSON.stringify(after.client))
  ok('带上 slot 状态便于远程诊断', after.client.slots && after.client.slots.settings === 'ok')
}

console.log('\n== 长轮询挂起与唤醒 ==')
{
  // since 停在队尾：没有新 cue 时应当挂起（不立刻 end）
  const cur = jsonOf(await call('/sound-cues/state'))
  const res = fakeRes()
  const route = routes.find((r) => r.path === '/sound-cues/events')
  route.handler(fakeReq('/sound-cues/events?since=' + cur.seq), res)
  await wait(120)
  ok('无新 cue 时挂起（尚未 end）', res.body === '', 'body=' + res.body.slice(0, 60))
  // 期间来一条 cue → 立刻唤醒（而不是等 20 秒超时）
  const t0 = Date.now()
  handlers.get('session/event')[0]({}, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  for (let i = 0; i < 60 && res.body === ''; i++) await wait(10)
  const took = Date.now() - t0
  const j = jsonOf(res)
  ok('新 cue 到达即唤醒长轮询', j && j.cues.some((c) => c.cue === 'turn.aborted'), res.body.slice(0, 160))
  ok('唤醒延迟 < 1 秒（不是等超时）', took < 1000, took + 'ms')
}

// 清理测试残留
const stateFile = join(PLUGIN, 'state.json')
if (existsSync(stateFile)) unlinkSync(stateFile)
const customDir = join(PLUGIN, 'assets', 'custom')
for (const f of ['test-tone.wav']) {
  const p = join(customDir, f)
  if (existsSync(p)) unlinkSync(p)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
