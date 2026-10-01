/**
 * dsh-sound-cues —— 宿主半边。
 *
 * 职责（只做两件事，绝不碰 UI）：
 *   1. 监听 DSH 的各类事件，把「值得响一声」的状态变化压成 cue 队列；
 *   2. 通过 webServer 暴露一组 HTTP 端点，供浏览器半边长轮询取 cue、
 *      读写设置、上传/读取用户自定义音效文件。
 *
 * ── 事件来源（DSH 里「宿主事件」其实是四个不同的东西，这里全都用到了）──
 *   A. cordis 全局事件       ctx.on('agent/error' | 'subagent/*' | 'workflow/*' | …)
 *   B. 会话持久事件firehose  ctx.on('session/event', (session, event) => …)  ← 主战场，48 种
 *   C. 服务局部回调          ctx.jobs.onJobDone(fn)  —— 后台作业**没有** cordis 事件
 *   D. 浏览器线帧            —— 插件订阅不到，不走
 *
 * ⚠ 特别小心 `approval/request`：那是 cordis **waterfall**（观察者必须调用
 *   next()），把它当普通 emit 事件订阅会破坏授权流程。所以审批改听
 *   family-B 的 `approval/asked`（纯审计事件）。
 *
 * 事件名走「订阅不存在的名字也无害」的 cordis 语义，故改表即可增删 cue。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-sound-cues'

/** webServer 是必须的：没有它浏览器半边拿不到任何 cue。 */
export const inject = ['webServer']

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const UPLOAD_DIR = join(PLUGIN_DIR, 'assets', 'custom')
const STATE_FILE = join(PLUGIN_DIR, 'state.json')

const MAX_QUEUE = 300
const LONGPOLL_MS = 20000
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm', '.opus'])

/* ──────────────────────────── 事件 → cue 映射表 ──────────────────────────── */

/** `turn/end` 的 reason.kind → cue。六种取值全部覆盖。 */
const TURN_END_RULES = {
  completed: { cue: 'turn.done', detail: '回合正常完成' },
  error: { cue: 'turn.error', detail: '任务失败' },
  aborted: { cue: 'turn.aborted', detail: '被中断' },
  interrupted: { cue: 'turn.aborted', detail: '崩溃后收尾' },
  blocked: { cue: 'turn.blocked', detail: '回合受阻' },
  'max-tokens': { cue: 'turn.maxTokens', detail: '达到 token 上限' },
}

/** `goal/change`（会话事件）与 `goal/changed`（cordis 事件）共用的 operation 映射。 */
const GOAL_RULES = {
  create: { cue: 'goal.created', detail: '目标已设定' },
  edit: { cue: 'goal.created', detail: '目标已修改' },
  complete: { cue: 'goal.completed', detail: '目标达成' },
  block: { cue: 'goal.blocked', detail: '目标受阻' },
  pause: { cue: 'goal.paused', detail: '目标暂停' },
  resume: { cue: 'goal.resumed', detail: '目标恢复' },
  clear: { cue: 'goal.cleared', detail: '目标已清除' },
}

/** `session/event` 里「类型本身就是语义」的那些。值为 null = 故意忽略。 */
const SESSION_TYPE_RULES = {
  'turn/start': { cue: 'turn.start', detail: '回合开始' },
  'tool/call': { cue: 'tool.start', detail: '工具开始' },
  'user/message': { cue: 'user.message', detail: '你发了消息' },
  'compaction/start': { cue: 'session.compaction', detail: '开始压缩上下文' },
  'llm/retry': { cue: 'llm.retry', detail: '模型重试' },
  'session/title': { cue: 'session.title', detail: '标题已生成', once: true },
  'todo/write': { cue: 'todo.updated', detail: '待办已更新' },
  // 审批走这个纯审计事件（approval/request 是 waterfall，不能碰）
  'approval/asked': { cue: 'approval.request', detail: '有操作等你授权' },
  'step/start': null,
  'step/end': null,
  'assistant/chunk': null,
  'assistant/message': null,
  'llm/retry-started': null,
}

/** 直接订阅的 cordis 事件 → cue。 */
const CORDIS_CUE_RULES = {
  'agent/error': { cue: 'task.failed', detail: '任务失败（agent 报错）' },
  'agent-loop/config-start-failed': { cue: 'task.failed', detail: '装配失败，会话没能起来' },
  'subagent/start': { cue: 'subagent.spawned', detail: '派出子代理' },
  'workflow/start': { cue: 'workflow.start', detail: '工作流开始' },
}

/* ─────────────────────────────── 小工具 ─────────────────────────────── */

const isObj = (v) => v !== null && typeof v === 'object'
const str = (v) => (typeof v === 'string' ? v : '')

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/* ─────────────────────────────── 插件主体 ─────────────────────────────── */

/**
 * @param {object} ctx 宿主 cordis 上下文（已注入 webServer）。
 */
export function apply(ctx) {
  try {
    if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true })
  } catch {
    /* 只读安装时静默：上传会失败，插件其余部分照常工作 */
  }

  let seq = 0
  const queue = []
  const waiters = new Set()

  let state = readJson(STATE_FILE, {})
  if (!isObj(state)) state = {}

  /**
   * 浏览器半边的「我还活着」心跳：client apply 时 POST /sound-cues/hello。
   * 有了它，就能在**不打开 DevTools** 的情况下从宿主端点确证网页半边真的跑起来了
   * （重启后自检的关键证据）。
   */
  let clientBeacon = null

  function saveState() {
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  function emit(cue, detail, extra) {
    if (!cue) return
    seq += 1
    const item = { id: seq, cue, ts: Date.now(), detail: detail || '' }
    if (isObj(extra)) {
      const meta = {}
      for (const k of Object.keys(extra)) if (extra[k]) meta[k] = extra[k]
      if (Object.keys(meta).length) item.meta = meta
    }
    queue.push(item)
    while (queue.length > MAX_QUEUE) queue.shift()
    const pending = [...waiters]
    waiters.clear()
    for (const wake of pending) {
      try {
        wake()
      } catch {
        /* 单个 waiter 抛错不能影响其余 */
      }
    }
  }

  /* ── B. 会话持久事件 firehose ── */

  ctx.on('session/event', (_session, event) => {
    try {
      if (!isObj(event)) return
      const type = str(event.type)
      const data = isObj(event.data) ? event.data : {}

      switch (type) {
        // ── 回合结局：正常 / 报错 / 被打断 / 受阻 / 超限 ──
        case 'turn/end': {
          const reason = isObj(data.reason) ? data.reason : {}
          const kind = str(reason.kind) || 'completed'
          const rule = TURN_END_RULES[kind] || TURN_END_RULES.completed
          let extra
          if (kind === 'error') {
            const err = isObj(reason.error) ? reason.error : {}
            extra = { error: str(err.message) || str(err.code) || '未知错误' }
          } else if (kind === 'aborted') {
            const cause = isObj(reason.reason) ? str(reason.reason.kind) : ''
            extra = { cause }
          }
          emit(rule.cue, rule.detail, extra)
          return
        }

        // ── 工具结果：失败判据是 content[0].isError，error 字段仅失败时出现 ──
        case 'tool/result': {
          const msg = isObj(data.message) ? data.message : {}
          const block = Array.isArray(msg.content) && isObj(msg.content[0]) ? msg.content[0] : {}
          const failed = block.isError === true || isObj(data.error)
          const err = isObj(data.error) ? data.error : {}
          emit(
            failed ? 'tool.error' : 'tool.done',
            failed ? '工具 / 命令失败' : '工具完成',
            failed ? { error: str(err.code) || str(err.name), tool: str(block.name) } : undefined,
          )
          return
        }

        // ── 目标相位（与 cordis 的 goal/changed 是同一次变更的另一条腿）──
        case 'goal/change': {
          const op = str(data.operation)
          const goal = isObj(data.goal) ? data.goal : {}
          const rule = GOAL_RULES[op]
          if (!rule) return
          emit(rule.cue, rule.detail, { goal: str(goal.objective) })
          return
        }

        // ── 计划模式开关 ──
        case 'plan/mode': {
          if (data.active === true) emit('plan.entered', '进入计划模式')
          else emit('plan.exited', '退出计划模式')
          return
        }

        // ── 斜杠命令结局 ──
        case 'command/done': {
          if (str(data.kind) === 'error') emit('command.error', '命令执行失败')
          return
        }

        // ── 压缩：error 字段存在 = 这次压缩失败 ──
        case 'compaction/end': {
          if (data.error) emit('session.compaction', '上下文压缩失败')
          else emit('session.compaction', '上下文压缩完成')
          return
        }

        // ── 团队任务板：整值快照，status 就是状态 ──
        case 'team/task': {
          const task = isObj(data.task) ? data.task : {}
          const status = str(task.status)
          if (status === 'pending') emit('task.created', '任务板：新建任务', { subject: str(task.subject) })
          else if (status === 'in_progress') emit('task.claimed', '任务板：有人认领', { subject: str(task.subject) })
          else if (status === 'completed') emit('task.completed', '任务板：任务完成', { subject: str(task.subject) })
          return
        }

        default:
          break
      }

      const rule = SESSION_TYPE_RULES[type]
      if (rule === null || rule === undefined) return
      if (rule.once) {
        // 同一会话只响一次（避免标题每次变化都响）
        if (state.__once && state.__once[type] === true) return
        state.__once = Object.assign({}, state.__once, { [type]: true })
        saveState()
      }
      emit(rule.cue, rule.detail)
    } catch {
      /* 静默：声音提示绝不能让宿主会话挂掉 */
    }
  })

  /* ── A. cordis 全局事件 ── */

  ctx.on('goal/changed', (payload) => {
    try {
      if (!isObj(payload)) return
      const change = isObj(payload.change) ? payload.change : {}
      const op = str(change.operation)
      const goal = isObj(change.goal) ? change.goal : {}
      const phase = str(goal.phase)
      // operation 是动词、phase 是状态；operation 缺失时退回 phase
      const rule = GOAL_RULES[op] || (phase ? GOAL_RULES[phase === 'complete' ? 'complete' : phase] : null)
      if (!rule) return
      emit(rule.cue, rule.detail, { goal: str(goal.objective) })
    } catch {
      /* 静默 */
    }
  })

  for (const [eventName, rule] of Object.entries(CORDIS_CUE_RULES)) {
    try {
      ctx.on(eventName, () => {
        try {
          emit(rule.cue, rule.detail)
        } catch {
          /* 静默 */
        }
      })
    } catch {
      /* 静默 */
    }
  }

  // subagent/end 带 stopReason，要区分成功/失败
  try {
    ctx.on('subagent/end', (info) => {
      try {
        const reason = isObj(info) ? str(info.stopReason) : ''
        const failed = reason && reason !== 'completed'
        emit(failed ? 'subagent.failed' : 'subagent.done', failed ? '子代理未正常结束' : '子代理完成', {
          reason,
        })
      } catch {
        /* 静默 */
      }
    })
  } catch {
    /* 静默 */
  }

  // workflow/end 带 stopReason
  try {
    ctx.on('workflow/end', (_info, result) => {
      try {
        const stop = isObj(result) ? str(result.stopReason) || str(result.status) : ''
        const failed = !!stop && stop !== 'completed' && stop !== 'success'
        emit(failed ? 'workflow.failed' : 'workflow.done', failed ? '工作流失败' : '工作流完成', {
          reason: stop,
        })
      } catch {
        /* 静默 */
      }
    })
  } catch {
    /* 静默 */
  }

  /* ── C. 后台作业：没有 cordis 事件，只能挂服务回调 ── */
  try {
    const jobs = ctx.jobs
    if (jobs && typeof jobs.onJobDone === 'function') {
      jobs.onJobDone((snapshot) => {
        try {
          const status = isObj(snapshot) ? str(snapshot.status) : ''
          const failed = status === 'failed' || status === 'killed'
          emit(failed ? 'job.failed' : 'job.done', failed ? '后台作业失败' : '后台作业完成', {
            detail: isObj(snapshot) ? str(snapshot.detail) : '',
          })
        } catch {
          /* 静默 */
        }
      })
    }
  } catch {
    /* 该 profile 没有 jobs 服务 —— cordis 的服务守卫会抛，吃掉即可 */
  }

  /* ───────────────────────────── HTTP 端点 ───────────────────────────── */

  const json = (res, payload, status = 200) => {
    if (!res.headersSent) {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
    }
    res.end(JSON.stringify(payload))
  }

  const readRawBody = (req, limitBytes = 32 * 1024 * 1024) =>
    new Promise((settle) => {
      const chunks = []
      let size = 0
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        settle(v)
      }
      req.on('data', (c) => {
        size += c.length
        if (size > limitBytes) {
          req.destroy()
          finish(null)
          return
        }
        chunks.push(c)
      })
      req.on('end', () => finish(Buffer.concat(chunks)))
      req.on('error', () => finish(null))
    })

  const readJsonBody = async (req) => {
    const buf = await readRawBody(req)
    if (!buf) return {}
    try {
      return JSON.parse(buf.toString('utf8'))
    } catch {
      return {}
    }
  }

  function safeAudioName(raw) {
    const base = String(raw || '')
      .replace(/[\\/]+/g, '_')
      .replace(/[^\w.\-\u4e00-\u9fa5 ]/g, '')
      .trim()
    if (!base) return ''
    return AUDIO_EXT.has(extname(base).toLowerCase()) ? base.slice(-120) : ''
  }

  /** 「内置名 / custom/名」→ 真实存在的绝对路径；越界一律拒。 */
  function resolveAudioPath(raw) {
    const rel = String(raw || '').replace(/\\/g, '/')
    if (!rel || rel.includes('..')) return null
    const candidates = []
    if (rel.startsWith('custom/')) candidates.push(join(UPLOAD_DIR, rel.slice('custom/'.length)))
    else {
      candidates.push(join(UPLOAD_DIR, rel))
      candidates.push(join(PLUGIN_DIR, 'assets', rel))
    }
    for (const c of candidates) {
      const abs = resolve(c)
      if (!abs.startsWith(resolve(PLUGIN_DIR) + sep)) continue
      try {
        if (existsSync(abs) && statSync(abs).isFile()) return abs
      } catch {
        /* ignore */
      }
    }
    return null
  }

  function listAudioFiles() {
    const out = []
    const scan = (dir, prefix) => {
      try {
        if (!existsSync(dir)) return
        for (const entry of readdirSync(dir)) {
          const abs = join(dir, entry)
          let st
          try {
            st = statSync(abs)
          } catch {
            continue
          }
          if (!st.isFile() || !AUDIO_EXT.has(extname(entry).toLowerCase())) continue
          const p = prefix ? `${prefix}/${entry}` : entry
          out.push({
            name: entry,
            path: p,
            size: st.size,
            url: `/sound-cues/audio/${encodeURIComponent(p)}`,
            custom: Boolean(prefix),
          })
        }
      } catch {
        /* ignore */
      }
    }
    scan(join(PLUGIN_DIR, 'assets'), '')
    scan(UPLOAD_DIR, 'custom')
    out.sort((a, b) => (a.custom === b.custom ? a.name.localeCompare(b.name) : a.custom ? 1 : -1))
    return out
  }

  ctx.effect(() => {
    const disposers = []
    const route = (kind, path, handler) => {
      try {
        disposers.push(ctx.webServer.register({ kind, path, handler }))
      } catch (err) {
        try {
          ctx.logger?.warn?.(`[sound-cues] 注册路由 ${path} 失败: ${err && err.message}`)
        } catch {
          /* ignore */
        }
      }
    }

    route('exact', '/sound-cues/state', (_req, res) => {
      json(res, {
        ok: true,
        name,
        version: '0.1.0',
        seq,
        queued: queue.length,
        now: Date.now(),
        uploadDir: UPLOAD_DIR,
        client: clientBeacon,
        config: state,
      })
    })

    // 浏览器半边的心跳（设置页/提示条跑起来了才会打这里）
    route('exact', '/sound-cues/hello', async (req, res) => {
      let body = {}
      try {
        body = await readJsonBody(req)
      } catch {
        body = {}
      }
      clientBeacon = {
        ts: Date.now(),
        version: str(body && body.version) || '?',
        slots: isObj(body && body.slots) ? body.slots : undefined,
      }
      json(res, { ok: true, seq })
    })

    // 长轮询：有新 cue 立刻返回；没有就挂起，最多 LONGPOLL_MS 后返回空。
    route('exact', '/sound-cues/events', (req, res) => {
      let since = 0
      try {
        since = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('since') || 0) || 0
      } catch {
        since = 0
      }
      const take = () => queue.filter((e) => e.id > since)

      if (take().length > 0) {
        json(res, { ok: true, seq, cues: take() })
        return
      }

      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(finish)
        try {
          json(res, { ok: true, seq, cues: take() })
        } catch {
          /* 客户端已断开 */
        }
      }
      const timer = setTimeout(finish, LONGPOLL_MS)
      waiters.add(finish)
      req.on('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(finish)
      })
    })

    // 手动投一条 cue（设置页「试听」按钮走这里，顺便验证整条链路）
    route('exact', '/sound-cues/ping', (req, res) => {
      let cue = 'turn.done'
      try {
        cue = new URL(req.url || '/', 'http://localhost').searchParams.get('cue') || cue
      } catch {
        /* ignore */
      }
      emit(cue, '（手动试听）')
      json(res, { ok: true, seq, cue })
    })

    route('exact', '/sound-cues/assets', (_req, res) => {
      json(res, { ok: true, files: listAudioFiles(), uploadDir: UPLOAD_DIR })
    })

    route('prefix', '/sound-cues/audio', (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://localhost')
        const raw = decodeURIComponent(u.pathname.slice('/sound-cues/audio/'.length))
        const file = resolveAudioPath(raw)
        if (!file) {
          json(res, { ok: false, error: 'not found' }, 404)
          return
        }
        const buf = readFileSync(file)
        const mime =
          {
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.ogg': 'audio/ogg',
            '.oga': 'audio/ogg',
            '.m4a': 'audio/mp4',
            '.aac': 'audio/aac',
            '.flac': 'audio/flac',
            '.webm': 'audio/webm',
            '.opus': 'audio/ogg',
          }[extname(file).toLowerCase()] || 'application/octet-stream'
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
        })
        res.end(buf)
      } catch (err) {
        json(res, { ok: false, error: String(err && err.message) }, 500)
      }
    })

    // 上传自定义音效：POST /sound-cues/upload?name=xxx.mp3（原始字节体）
    route('exact', '/sound-cues/upload', async (req, res) => {
      try {
        let raw = ''
        try {
          raw = new URL(req.url || '/', 'http://localhost').searchParams.get('name') || ''
        } catch {
          raw = ''
        }
        const safeName = safeAudioName(raw)
        if (!safeName) {
          json(res, { ok: false, error: '文件名不合法（只允许音频扩展名与安全字符）' }, 400)
          return
        }
        const buf = await readRawBody(req)
        if (!buf || buf.length === 0) {
          json(res, { ok: false, error: '空文件' }, 400)
          return
        }
        if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true })
        writeFileSync(join(UPLOAD_DIR, safeName), buf)
        json(res, { ok: true, name: safeName, size: buf.length, files: listAudioFiles() })
      } catch (err) {
        json(res, { ok: false, error: String(err && err.message) }, 500)
      }
    })

    // 删除一个用户上传的音效（只允许删 assets/custom/ 下的）
    route('prefix', '/sound-cues/delete', (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://localhost')
        const safeName = safeAudioName(u.pathname.split('/').pop() || '')
        if (!safeName) {
          json(res, { ok: false, error: '文件名不合法' }, 400)
          return
        }
        const target = resolve(join(UPLOAD_DIR, safeName))
        if (!target.startsWith(resolve(UPLOAD_DIR) + sep)) {
          json(res, { ok: false, error: '越界路径' }, 400)
          return
        }
        if (existsSync(target)) unlinkSync(target)
        json(res, { ok: true, files: listAudioFiles() })
      } catch (err) {
        json(res, { ok: false, error: String(err && err.message) }, 500)
      }
    })

    // 设置：读 / 写（浏览器半边每次改动都同步到这里落盘）
    route('exact', '/sound-cues/config', async (req, res) => {
      if (String(req.method || 'GET').toUpperCase() === 'GET') {
        json(res, { ok: true, config: state })
        return
      }
      const body = await readJsonBody(req)
      if (isObj(body) && isObj(body.config)) {
        state = Object.assign({}, state, body.config)
        saveState()
        json(res, { ok: true, config: state })
        return
      }
      json(res, { ok: false, error: 'body.config 必须是对象' }, 400)
    })

    return () => {
      for (const d of disposers) {
        try {
          if (typeof d === 'function') d()
        } catch {
          /* ignore */
        }
      }
    }
  })
}
