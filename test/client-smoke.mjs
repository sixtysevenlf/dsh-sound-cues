/**
 * dsh-sound-cues 浏览器半边冒烟测试。
 * 桩掉 window / document / react / WebAudio，直接跑真 bundle，验证：
 *   - 包封套（__ModuleLoader__.load）与 id 正确
 *   - apply 注册了 3 个 slot，且注册的组件是 React 组件函数
 *   - 每一个内置音色都能在 WebAudio 上跑通不抛异常
 *   - 设置 store 读写、cue 开关与「试听」路径
 * 用法： node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
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

/* ── 桩：WebAudio ── */
const audioCalls = []
function node(kind) {
  const n = {
    kind,
    connect(x) {
      audioCalls.push(kind + '.connect')
      return x && x.connect ? x : n
    },
    disconnect() {},
    start() {
      audioCalls.push(kind + '.start')
    },
    stop() {
      audioCalls.push(kind + '.stop')
    },
  }
  return n
}
class FakeAudioContext {
  constructor() {
    this.currentTime = 0
    this.sampleRate = 44100
    this.state = 'running'
    this.destination = node('destination')
    audioCalls.push('new AudioContext')
  }
  resume() {
    return Promise.resolve()
  }
  createGain() {
    const g = node('gain')
    g.gain = {
      value: 0,
      setValueAtTime() {},
      exponentialRampToValueAtTime(v) {
        audioCalls.push('gain.ramp:' + v)
      },
    }
    return g
  }
  createOscillator() {
    const o = node('osc')
    o.type = 'sine'
    o.frequency = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }
    o.onended = null
    return o
  }
  createBiquadFilter() {
    const f = node('biquad')
    f.type = 'lowpass'
    f.frequency = { value: 0 }
    return f
  }
  createBufferSource() {
    const s = node('bufferSource')
    s.buffer = null
    s.onended = null
    return s
  }
  createBuffer(ch, len) {
    return { length: len, getChannelData: () => new Float32Array(len) }
  }
  decodeAudioData(ab, okcb) {
    okcb({ duration: 1 })
  }
}

/* ── 桩：DOM ── */
const styleTags = []
const documentStub = {
  head: { appendChild: (el) => styleTags.push(el) },
  documentElement: { appendChild: (el) => styleTags.push(el) },
  getElementById: (id) => styleTags.find((t) => t.id === id) || null,
  hidden: false,
  visibilityState: 'visible',
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      id: '',
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = v
      },
      appendChild() {},
      remove() {},
    }
  },
}
const lsStore = {}
const windowStub = {
  addEventListener() {},
  localStorage: {
    getItem: (k) => (k in lsStore ? lsStore[k] : null),
    setItem: (k, v) => {
      lsStore[k] = String(v)
    },
  },
  AudioContext: FakeAudioContext,
}
globalThis.window = windowStub
globalThis.document = documentStub

/* ── 桩：fetch（宿主不在，全部失败也没关系 —— 插件必须优雅降级） ── */
const fetchCalls = []
globalThis.fetch = (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body })
  if (String(url).indexOf('/hello') >= 0) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  }
  if (String(url).indexOf('/config') >= 0) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  }
  return Promise.reject(new Error('offline-stub'))
}

/* ── 桩：react（带真实 hook 语义的最小实现，让组件树真的能被渲染） ── */
const hookStore = new Map() // 组件路径 -> { hooks, idx }
let curRec = null
let effectQueue = []
let dirty = false

const ReactStub = {
  createElement(type, props, ...children) {
    return { __el: true, type, props: props || {}, children }
  },
  Fragment: Symbol('Fragment'),
  useState(init) {
    const rec = curRec
    const i = rec.idx++
    if (!(i in rec.hooks)) rec.hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const next = typeof v === 'function' ? v(rec.hooks[i]) : v
      if (rec.hooks[i] !== next) {
        rec.hooks[i] = next
        dirty = true
      }
    }
    return [rec.hooks[i], set]
  },
  useEffect(fn, deps) {
    const rec = curRec
    const i = rec.idx++
    const prev = rec.hooks[i]
    if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])) {
      rec.hooks[i] = { deps }
      effectQueue.push(fn)
    }
  },
  useRef(v) {
    const rec = curRec
    const i = rec.idx++
    if (!(i in rec.hooks)) rec.hooks[i] = { current: v }
    return rec.hooks[i]
  },
  useCallback(fn) {
    curRec.idx++
    return fn
  },
}

/** 极简渲染器：按路径给每个组件实例分配独立 hook 槽，插件树形状稳定即可正确复现 React 语义。 */
function renderEl(el, path) {
  if (el === null || el === undefined || el === false || el === true) return null
  if (typeof el === 'string' || typeof el === 'number') return { text: String(el) }
  if (Array.isArray(el)) return el.map((c, i) => renderEl(c, path + '[' + i + ']'))
  if (!el.__el) return { text: String(el) }

  const props = Object.assign({}, el.props)
  if (el.children.length === 1) props.children = el.children[0]
  else if (el.children.length > 1) props.children = el.children

  if (el.type === ReactStub.Fragment) return renderEl(el.children, path)

  if (typeof el.type === 'function') {
    const key = path + '/' + (el.type.name || 'anon')
    let rec = hookStore.get(key)
    if (!rec) {
      rec = { hooks: [], idx: 0 }
      hookStore.set(key, rec)
    }
    rec.idx = 0
    const prevRec = curRec
    curRec = rec
    let out
    try {
      out = el.type(props)
    } finally {
      curRec = prevRec
    }
    return renderEl(out, key)
  }

  return {
    tag: String(el.type),
    props,
    children: el.children.map((c, i) => renderEl(c, path + '/' + el.type + '[' + i + ']')),
  }
}

/** 渲染一棵树并把本次产生的 effect 跑掉（收集清理函数）。 */
function renderTree(el) {
  effectQueue = []
  dirty = false
  const tree = renderEl(el, 'root')
  const cleanups = []
  const q = effectQueue.slice()
  effectQueue = []
  for (const fn of q) {
    const c = fn()
    if (typeof c === 'function') cleanups.push(c)
  }
  return { tree, cleanups, dirty }
}

/** 取出树里所有可见文本。 */
function textOf(node) {
  if (!node) return ''
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.text !== undefined) return node.text
  return (node.children || []).map(textOf).join(' ')
}

/** 深度优先找第一个 className 命中的节点。 */
function findByClass(node, cls) {
  if (!node || Array.isArray(node)) {
    if (Array.isArray(node)) {
      for (const c of node) {
        const hit = findByClass(c, cls)
        if (hit) return hit
      }
    }
    return null
  }
  const cn = node.props && node.props.className
  if (typeof cn === 'string' && cn.split(/\s+/).indexOf(cls) >= 0) return node
  for (const c of node.children || []) {
    const hit = findByClass(c, cls)
    if (hit) return hit
  }
  return null
}

function findAllByClass(node, cls, out = []) {
  if (!node) return out
  if (Array.isArray(node)) {
    for (const c of node) findAllByClass(c, cls, out)
    return out
  }
  const cn = node.props && node.props.className
  if (typeof cn === 'string' && cn.split(/\s+/).indexOf(cls) >= 0) out.push(node)
  for (const c of node.children || []) findAllByClass(c, cls, out)
  return out
}

/* ── 桩：__ModuleLoader__ ── */
let loaded = null
windowStub.__ModuleLoader__ = {
  load(def) {
    loaded = def
  },
}

const src = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
// 用 new Function 在一个受控作用域里执行 classic script
const run = new Function('window', 'document', 'React', 'require', 'console', src)
run(windowStub, documentStub, ReactStub, (spec) => {
  if (spec === 'react') return ReactStub
  throw new Error('unexpected require: ' + spec)
}, console)

console.log('\n== 包封套 ==')
ok('调用了 __ModuleLoader__.load', loaded !== null)
ok('id 等于包名 dsh-sound-cues', loaded && loaded.id === 'dsh-sound-cues', loaded && loaded.id)
ok('factory 是函数', loaded && typeof loaded.factory === 'function')

const exportsObj = loaded.factory((spec) => {
  if (spec === 'react') return ReactStub
  throw new Error('unexpected require: ' + spec)
})
ok('导出 inject = ["slots"]', Array.isArray(exportsObj.inject) && exportsObj.inject[0] === 'slots', JSON.stringify(exportsObj.inject))
ok('导出 apply 函数', typeof exportsObj.apply === 'function')
ok('没在静态表之外 require 任何模块', true)

/** 插件为自检导出的内部句柄（提前取，后面各段都要用）。 */
const internal = exportsObj.__internal

console.log('\n== apply(ctx) 注册 slot ==')
const registrations = []
const effects = []
const injected = []
const ctx = {
  slots: {
    inject(key, cb) {
      injected.push(key)
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    register(opts, comp) {
      registrations.push({ opts, comp })
      return () => {}
    },
  },
  effect(fn, label) {
    effects.push(label)
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  logger: { warn: () => {} },
}
let applyErr = null
try {
  exportsObj.apply(ctx)
} catch (e) {
  applyErr = e
}
ok('apply 不抛异常', applyErr === null, applyErr && applyErr.stack)
ok('inject 了 3 个 slot（settings.section / settings.general.item / shell.overlay）', injected.length === 3, JSON.stringify(injected))

const byName = {}
for (const r of registrations) byName[r.opts.name] = r

ok('注册了 settings.section', !!byName['settings.section'])
ok('settings.section 带 id', byName['settings.section'] && byName['settings.section'].opts.id === 'dsh-sound-cues')
ok('settings.section label 是函数', byName['settings.section'] && typeof byName['settings.section'].opts.label === 'function')
ok('settings.section label() = 提示音', byName['settings.section'] && byName['settings.section'].opts.label() === '提示音')
ok('settings.section 组件是 React 函数组件', byName['settings.section'] && typeof byName['settings.section'].comp === 'function')

ok('注册了 settings.general.item（list 必须有 id）', byName['settings.general.item'] && !!byName['settings.general.item'].opts.id)
ok('注册了 shell.overlay（list 必须有 id）', byName['shell.overlay'] && !!byName['shell.overlay'].opts.id)

console.log('\n== 样式注入 ==')
const style = styleTags.find((t) => t.id === 'dsc-style')
ok('apply 注入了 <style id=dsc-style>', !!style)
ok('带 data-plugin = 包名（供 HMR 认领）', !!style && style.attrs['data-plugin'] === 'dsh-sound-cues', style && JSON.stringify(style.attrs))
ok('CSS 用 DSH 主题 token 且有回退', !!style && /--dsw-alias-toast-bg/.test(style.textContent || ''), (style && (style.textContent || '')).slice(0, 80))
ok('CSS 前缀化（避免污染全局）', /\bdsc-/.test((style && style.textContent) || ''))

console.log('\n== 心跳：网页半边向宿主报到 ==')
const hello = fetchCalls.find((c) => c.url.indexOf('/hello') >= 0)
ok('apply 时 POST 了 /sound-cues/hello', !!hello && hello.method === 'POST', JSON.stringify(fetchCalls.slice(0, 6)))
ok('启动时也拉了 /sound-cues/events（长轮询）', fetchCalls.some((c) => c.url.indexOf('/events') >= 0), JSON.stringify(fetchCalls.map((c) => c.url)))

console.log('\n== 投递回执（后台/最小化场景的判据） ==')
{
  const before = fetchCalls.length
  internal.cueBus.publish({ id: 4242, cue: 'turn.error', detail: '回执测试' })
  const post = fetchCalls.slice(before).find((c) => c.url.indexOf('/config') >= 0 && c.method === 'POST')
  ok('收到 cue 后回报了 /sound-cues/config', !!post, JSON.stringify(fetchCalls.slice(before)))
  if (post && post.body) {
    let payload = null
    try {
      payload = JSON.parse(post.body)
    } catch (e) {
      /* ignore */
    }
    const d = payload && payload.config && payload.config.__diag
    ok('回执带 lastCue / lastCueId / at', !!d && d.lastCue === 'turn.error' && d.lastCueId === 4242 && typeof d.at === 'number', JSON.stringify(d))
    ok('回执带窗口可见性（分辨「没送到」还是「送到了没出声」）', !!d && typeof d.hidden === 'boolean', JSON.stringify(d))
    ok('回执带 AudioContext 状态', !!d && typeof d.audio === 'string', JSON.stringify(d))
    ok('回执带累计计数（宿主只留最后一条，计数看得出总共收到几条）', !!d && typeof d.count === 'number' && d.count >= 1, JSON.stringify(d))
  }
}

console.log('\n== 真的把组件树渲染一遍（最小 React hook 语义） ==')
const SettingsPanelComp = byName['settings.section'].comp
const OverlayComp = byName['shell.overlay'].comp
const GeneralComp = byName['settings.general.item'].comp

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

function findNode(node, pred) {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const c of node) {
      const h = findNode(c, pred)
      if (h) return h
    }
    return null
  }
  if (pred(node)) return node
  for (const c of node.children || []) {
    const h = findNode(c, pred)
    if (h) return h
  }
  return null
}
const isInput = (t) => (n) => n.props && n.props.type === t

let uiOk = true
try {
  // ── 设置页首屏 ──
  const r1 = renderTree(ReactStub.createElement(SettingsPanelComp, {}))
  const txt = textOf(r1.tree)
  ok('渲染设置页不抛异常', true)
  ok('含总开关文案', /提示音已(开启|关闭)/.test(txt), txt.slice(0, 120))
  ok('含「自定义音效」区块', /自定义音效/.test(txt))
  ok('含「提示音总表」', /提示音总表/.test(txt))
  ok('含「恢复默认设置」', /恢复默认设置/.test(txt))
  ok(
    `含 cue 总数文案（共 ${internal.CUE_CATALOG.length} 条）`,
    txt.indexOf('共 ' + internal.CUE_CATALOG.length + ' 条') >= 0,
  )
  ok('含两首主题的署名说明（不谎称原版录音）', /合成演奏，不是原版录音/.test(txt))

  const groups = [...new Set(internal.CUE_CATALOG.map((c) => c.group))]
  const heads = findAllByClass(r1.tree, 'dsc-group-head')
  ok(`渲染出全部 ${groups.length} 个分组头`, heads.length === groups.length, `${heads.length} vs ${groups.length}`)

  // ── 默认展开第一组「回合」──
  const g0 = groups[0]
  const expectRows = internal.CUE_CATALOG.filter((c) => c.group === g0).length
  ok(`默认展开「${g0}」，渲染出 ${expectRows} 行`, findAllByClass(r1.tree, 'dsc-row').length === expectRows)

  // ── 点一下收起，再点一下展开 ──
  heads[0].props.onClick()
  const r1b = renderTree(ReactStub.createElement(SettingsPanelComp, {}))
  ok('再点一下收起该组', findAllByClass(r1b.tree, 'dsc-row').length === 0)
  findAllByClass(r1b.tree, 'dsc-group-head')[0].props.onClick()
  const r2 = renderTree(ReactStub.createElement(SettingsPanelComp, {}))
  const rows = findAllByClass(r2.tree, 'dsc-row')
  ok(`再点一下重新展开 ${expectRows} 行`, rows.length === expectRows, `${rows.length} vs ${expectRows}`)
  const txt2 = textOf(r2.tree)
  const g0Labels = internal.CUE_CATALOG.filter((c) => c.group === g0).map((c) => c.label)
  ok('展开后每行的中文名都渲染了', g0Labels.every((l) => txt2.indexOf(l) >= 0), g0Labels.join(' | '))
  ok('每行都有开关勾选框', findAllByClass(r2.tree, 'dsc-ck').length === expectRows)
  ok('每行都有音色下拉', findAllByClass(r2.tree, 'dsc-sel').length === expectRows)
  ok('每行都有试听按钮', findAllByClass(r2.tree, 'dsc-btn-sm').length >= expectRows)

  // ── 总开关真的能写进 store ──
  const switchBox = findNode(findByClass(r2.tree, 'dsc-switch'), isInput('checkbox'))
  ok('总开关是 checkbox', !!switchBox)
  if (switchBox) {
    switchBox.props.onChange({ target: { checked: false } })
    ok('关掉总开关写进了 store', internal.store.get().enabled === false)
    switchBox.props.onChange({ target: { checked: true } })
    ok('再打开也写进 store', internal.store.get().enabled === true)
  }

  // ── 音量滑杆 ──
  const ranges = findAllByClass(r2.tree, 'dsc-field')
    .map((f) => findNode(f, isInput('range')))
    .filter(Boolean)
  ok('音量与单条最长两个滑杆都在', ranges.length === 2, String(ranges.length))
  if (ranges[0]) {
    ranges[0].props.onChange({ target: { value: '30' } })
    ok('音量滑杆写入 0.3', Math.abs(internal.store.get().volume - 0.3) < 1e-9, String(internal.store.get().volume))
    internal.store.set({ volume: 0.6 })
  }

  // ── 某一行改音色 + 试听 ──
  const firstRow = rows[0]
  const sel = findNode(firstRow, (n) => n.tag === 'select')
  ok('行内有 select', !!sel)
  if (sel) {
    const target = sel.props.value === 'guanyu' ? 'chime-soft' : 'guanyu'
    sel.props.onChange({ target: { value: target } })
    const firstCueId = internal.CUE_CATALOG.filter((c) => c.group === g0)[0].id
    ok(`下拉改音色写进 store（${firstCueId} → ${target}）`, internal.store.get().cues[firstCueId].sound === target, JSON.stringify(internal.store.get().cues[firstCueId]))
  }
  const before = audioCalls.length
  const listenBtn = findNode(firstRow, (n) => n.props && n.props.title === '试听')
  ok('行内有试听按钮', !!listenBtn)
  if (listenBtn) {
    listenBtn.props.onClick()
    ok('点试听真的发出了声音', audioCalls.length > before, `${before} → ${audioCalls.length}`)
  }

  // ── 逐条音量滑杆 ──
  const volBox = findNode(firstRow, (n) => n.props && n.props.type === 'range')
  ok('行内有「这一条的音量」滑杆', !!volBox)
  const firstCueId = internal.CUE_CATALOG.filter((c) => c.group === g0)[0].id
  if (volBox) {
    volBox.props.onChange({ target: { value: '40' } })
    ok(`滑杆写进 store（${firstCueId}.vol = 0.4）`, Math.abs(internal.store.get().cues[firstCueId].vol - 0.4) < 1e-9, String(internal.store.get().cues[firstCueId].vol))
    ok('每行都有独立的音量滑杆', rows.every((r) => !!findNode(r, (n) => n.props && n.props.type === 'range')))
  }

  // ── 顶部两个大试听按钮 ──
  const headBtns = findAllByClass(r2.tree, 'dsc-btn').filter((b) => typeof textOf(b) === 'string' && /试听/.test(textOf(b)))
  ok('顶部有 2 个「试听」大按钮', headBtns.length === 2, headBtns.map((b) => textOf(b)).join(' | '))
  const n0 = audioCalls.length
  headBtns.forEach((b) => b.props.onClick())
  ok('两个大按钮都能发声', audioCalls.length > n0)
  internal.store.reset()

  // ── 通用设置快捷行 ──
  const r3 = renderTree(ReactStub.createElement(GeneralComp, {}))
  ok('通用快捷行渲染不抛异常', true)
  ok('快捷行含「提示音」', /提示音/.test(textOf(r3.tree)), textOf(r3.tree))
} catch (e) {
  uiOk = false
  ok('设置页整树渲染', false, e && e.stack)
}

console.log('\n== 右下角提示条 ==')
{
  const r0 = renderTree(ReactStub.createElement(OverlayComp, {}))
  ok('无 cue 时提示条渲染 null', r0.tree === null)

  internal.cueBus.publish({ id: 1, cue: 'goal.completed', detail: '冒烟测试' })
  const r1 = renderTree(ReactStub.createElement(OverlayComp, {}))
  ok('收到 cue 后渲染出提示条', !!findByClass(r1.tree, 'dsc-toast'))
  const t = textOf(r1.tree)
  ok('提示条显示 cue 的中文名', /目标达成/.test(t), t)
  ok('提示条显示 detail', /冒烟测试/.test(t), t)
  const mute = findByClass(r1.tree, 'dsc-toast-x')
  ok('提示条带「静音」按钮', !!mute)
  if (mute) {
    mute.props.onClick()
    ok('点静音后总开关关闭', internal.store.get().enabled === false)
    internal.store.set({ enabled: true })
  }

  // 关掉提示条开关后不该再渲染
  internal.store.set({ indicator: false })
  const r2 = renderTree(ReactStub.createElement(OverlayComp, {}))
  ok('关掉「显示提示条」后不再渲染', findByClass(r2.tree, 'dsc-toast') === null)
  internal.store.set({ indicator: true })
}

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval

console.log('\n== 音色库：每个内置音色都能上机 ==')
ok('导出了 __internal（自检用）', !!internal)
ok('cue 目录 >= 25 条', internal.CUE_CATALOG.length >= 25, String(internal.CUE_CATALOG.length))

const catalogIds = internal.CUE_CATALOG.map((c) => c.id)
const dupes = catalogIds.filter((id, i) => catalogIds.indexOf(id) !== i)
ok('cue id 无重复', dupes.length === 0, dupes.join(','))
const soundIds = new Set(internal.BUILTIN_SOUNDS.map((s) => s.id))
const dangling = internal.CUE_CATALOG.filter((c) => !soundIds.has(c.sound)).map((c) => c.id + '→' + c.sound)
ok('每条 cue 的默认音色都存在', dangling.length === 0, dangling.join(','))

const failures = []
for (const s of internal.BUILTIN_SOUNDS) {
  for (const c of internal.CUE_CATALOG) {
    if (c.sound !== s.id) continue
  }
}
// 逐音色直接试听（用任意 cue id 换音色不现实，这里直接改 store 后 playCue）
for (const s of internal.BUILTIN_SOUNDS) {
  try {
    internal.store.setCue('turn.done', { sound: s.id, on: true, file: '' })
    internal.playCue('turn.done', true)
  } catch (e) {
    failures.push(s.id + ': ' + (e && e.message))
  }
}
ok('全部 ' + internal.BUILTIN_SOUNDS.length + ' 个音色播放无异常', failures.length === 0, failures.join(' | '))

console.log('\n== 旋律数据健全性 ==')
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const nm = (p) => NAMES[p % 12] + (Math.floor(p / 12) - 1)
const checkMelody = (name, notes) => {
  const bad = []
  for (const n of notes) {
    if (!Array.isArray(n) || n.length !== 3) bad.push('shape ' + JSON.stringify(n))
    else if (typeof n[0] !== 'number' || n[0] < 21 || n[0] > 108) bad.push('pitch ' + n[0])
    else if (n[2] <= 0) bad.push('dur ' + n[2])
  }
  const sorted = notes.every((n, i) => i === 0 || n[1] >= notes[i - 1][1])
  ok(name + ' 音符合法（' + notes.length + ' 个）', bad.length === 0, bad.join(','))
  ok(name + ' 按起始拍升序', sorted)
  ok(name + ' 无重叠（后一音的起点不早于前一音的结束）', notes.every((n, i) => i === 0 || n[1] >= notes[i - 1][1] + notes[i - 1][2] - 1e-9))
  return notes
}

const gClimax = checkMelody('关羽之歌·高潮句', internal.MELODY_GUANYU_CLIMAX)
const gIntro = checkMelody('关羽之歌·引子首句', internal.MELODY_GUANYU_INTRO)
const champ = checkMelody('Champions·副歌', internal.MELODY_CHAMPION)

console.log('\n== 两段「知名段落」的硬性特征 ==')
{
  // ── Champions 副歌：Hooktheory 标注副歌调 F 大调、旋律音域 A3–C5 ──
  const lo = Math.min(...champ.map((n) => n[0]))
  const hi = Math.max(...champ.map((n) => n[0]))
  ok(`Champions 副歌音域正好 A3–C5（实测 ${nm(lo)}–${nm(hi)}）`, nm(lo) === 'A3' && nm(hi) === 'C5', `${nm(lo)}–${nm(hi)}`)
  // 首调（F 大调）应落在 F 自然大调音阶内，只有 "cause..." 那句的 b3(Ab) 是借用音
  const FMAJ = new Set([5, 7, 9, 10, 0, 2, 4]) // F G A Bb C D E 的音级
  const outside = champ.filter((n) => !FMAJ.has(n[0] % 12))
  ok('副歌除借用音外全落在 F 大调音阶内', outside.length <= 2, outside.map((n) => nm(n[0])).join(','))
  ok('借用音是 b3（Ab），不是写错调号', outside.every((n) => nm(n[0]).startsWith('G#')), outside.map((n) => nm(n[0])).join(','))
  // 副歌主题的骨架（首调，F 大调）：1-7-1-7-5 | 3-6-3 | 5-1-2-3-5-3 | 6-7-6
  const FF = { 5: 1, 7: 2, 9: 3, 10: 4, 0: 5, 2: 6, 4: 7 }
  const deg = (p) => FF[p % 12]
  const seq = (a, b) => champ.slice(a, b).map((n) => deg(n[0]))
  ok('第 1 句 = 1 7 1 7 5（We are the champions）', seq(0, 5).join(' ') === '1 7 1 7 5', seq(0, 5).join(' '))
  ok('第 2 句 = 3 6 3（my friends）', seq(5, 8).join(' ') === '3 6 3', seq(5, 8).join(' '))
  ok('第 3 句 = 5 1 2 3 5 3（and we’ll keep on fighting，上行拱形）', seq(8, 14).join(' ') === '5 1 2 3 5 3', seq(8, 14).join(' '))
  ok('第 4 句 = 6 7 6（’til the end）', seq(14, 17).join(' ') === '6 7 6', seq(14, 17).join(' '))
  ok('全曲最高音 C5 落在第 3 句的“fighting”上', champ[12][0] === 72 && Math.max(...champ.map((n) => n[0])) === 72, nm(champ[12][0]))

  // ── 关羽之歌高潮句：简谱 2 2 2 2 1 2 3 | 5 1 1̇ 7̲ 6̲ 0 | ... （1=C）──
  const JP = {
    55: '5̲', 57: '6̲', 59: '7̲',
    60: '1', 62: '2', 64: '3', 65: '4', 67: '5', 69: '6', 71: '7',
    72: '1̇', 74: '2̇', 76: '3̇',
  }
  const jp = (p) => JP[p] || '?' + p
  // 小节切分：|7|5|7|7|
  const bar = (i) => gClimax.slice([0, 7, 12, 19][i], [7, 12, 19, 26][i]).map((n) => n[0])
  ok('高潮句第一小节 = 2 2 2 2 1 2 3', bar(0).map(jp).join(' ') === '2 2 2 2 1 2 3', bar(0).map(jp).join(' '))
  ok('高潮句第二小节 = 5 1 1̇ 7̲ 6̲', bar(1).map(jp).join(' ') === '5 1 1̇ 7̲ 6̲', bar(1).map(jp).join(' '))
  ok('高潮句第三小节 = 5 5 5 5 3 5 6', bar(2).map(jp).join(' ') === '5 5 5 5 3 5 6', bar(2).map(jp).join(' '))
  ok('高潮句第四小节 = 1̇ 1̇ 1̇ 7̲ 6̲ 6̲ 1̇', bar(3).map(jp).join(' ') === '1̇ 1̇ 1̇ 7̲ 6̲ 6̲ 1̇', bar(3).map(jp).join(' '))
  ok('高潮句收在 1̇（C5，全曲那个落点）', gClimax[gClimax.length - 1][0] === 72, nm(gClimax[gClimax.length - 1][0]))
  ok('高潮句比引子首句更长（是完整的乐句）', gClimax.length > gIntro.length, `${gClimax.length} vs ${gIntro.length}`)

  // ── 时长：单条提示音不该超过默认 maxMs ──
  const beats = (arr) => Math.max(...arr.map((n) => n[1] + n[2]))
  const secs = (arr, bpm) => (beats(arr) * 60) / bpm
  ok(`Champions 副歌 ≈${secs(champ, 112).toFixed(1)}s（2–9s 内）`, secs(champ, 112) > 2 && secs(champ, 112) < 9)
  ok(`关羽之歌高潮句 ≈${secs(gClimax, 112).toFixed(1)}s（2–12s 内）`, secs(gClimax, 112) > 2 && secs(gClimax, 112) < 12)
  ok('两个默认音色的名字都能在音色表里找到', internal.BUILTIN_SOUNDS.some((s) => s.id === 'guanyu') && internal.BUILTIN_SOUNDS.some((s) => s.id === 'champion'))
  ok('高潮句与引子都作为可选音色存在', internal.BUILTIN_SOUNDS.some((s) => s.id === 'guanyu-intro'))
}

console.log('\n== 逐条音量：真的改变增益，不只是存了个数 ==')
{
  const peakOf = (id, vol) => {
    internal.store.setCue(id, { sound: 'tick', on: true, file: '', vol })
    audioCalls.length = 0
    internal.playCue(id, true)
    const ramps = audioCalls
      .filter((c) => c.indexOf('gain.ramp:') === 0)
      .map((c) => parseFloat(c.slice('gain.ramp:'.length)))
      .filter((v) => isFinite(v))
    return ramps.length ? Math.max(...ramps) : 0
  }
  const full = peakOf('turn.done', 1)
  const half = peakOf('turn.done', 0.5)
  const zero = peakOf('turn.done', 0)
  const loud = peakOf('turn.done', 1.5)
  ok(`100% 有声（峰值 ${full.toFixed(4)}）`, full > 0)
  ok(`50% 峰值恰为 100% 的一半（${half.toFixed(4)}）`, Math.abs(half - full / 2) < 1e-9)
  ok('0% 完全不出声', zero === 0)
  ok(`150% 能调更响（峰值 ${loud.toFixed(4)}）`, loud > full)
  ok('150% 恰为 100% 的 1.5 倍（与主音量两层相乘，互不覆盖）', Math.abs(loud - full * 1.5) < 1e-9)
  internal.store.set({ volume: 0.3 })
  ok('主音量是另一层（改它不影响单条系数）', internal.store.get().cues['turn.done'].vol === 1.5, String(internal.store.get().cues['turn.done'].vol))
  internal.store.set({ volume: 0.6 })
  internal.store.reset()
}

console.log('\n== 老配置向后兼容（字段级合并） ==')
{
  // 模拟「上一版存下来的配置」：没有 vol 字段，且含一个已从目录删掉的 cue
  const legacy = {
    enabled: true,
    volume: 0.42,
    cues: {
      'turn.error': { on: false, sound: 'error-buzz', file: '' }, // 老配置：没有 vol
      'ghost.cue': { on: true, sound: 'tick', file: '' }, // 已经不存在的 cue
    },
  }
  const out = internal.normalize(legacy)
  ok('老配置的 volume 被保留（0.42）', Math.abs(out.volume - 0.42) < 1e-9, String(out.volume))
  ok('老配置里 turn.error 的开关与音色都保留', out.cues['turn.error'].on === false && out.cues['turn.error'].sound === 'error-buzz')
  ok(
    '老配置缺的 vol 自动补 1（关键：整条替换会让老用户永远拿不到新字段）',
    out.cues['turn.error'].vol === 1,
    String(out.cues['turn.error'].vol),
  )
  ok('目录里有、老配置里没有的 cue 用默认值补齐', out.cues['goal.completed'].sound === 'champion')
  ok('目录里已删掉的旧 cue id 仍保留（不抹用户历史）', !!out.cues['ghost.cue'])
  ok(
    'cue 总数 = 目录 ∪ 旧配置',
    Object.keys(out.cues).length === internal.CUE_CATALOG.length + 1,
    String(Object.keys(out.cues).length),
  )
  ok('每条默认 cue 都有 vol 字段', internal.CUE_CATALOG.every((c) => typeof out.cues[c.id].vol === 'number'))
}

console.log('\n== 设置 store 行为 ==')
ok('默认 enabled=true', internal.store.get().enabled === true)
internal.store.set({ enabled: false })
ok('set({enabled:false}) 生效', internal.store.get().enabled === false)
internal.store.set({ enabled: true })
ok('默认音量在 0..1', internal.store.get().volume > 0 && internal.store.get().volume <= 1)
ok('默认总表已填充', Object.keys(internal.store.get().cues).length === internal.CUE_CATALOG.length)
ok('turn.error 默认音色 = guanyu', internal.store.get().cues['turn.error'].sound === 'guanyu')
ok('goal.completed 默认音色 = champion', internal.store.get().cues['goal.completed'].sound === 'champion')
internal.store.setCue('goal.completed', { on: false })
ok('setCue 关掉单条生效', internal.store.get().cues['goal.completed'].on === false)
internal.store.reset()
ok('reset 恢复默认音色', internal.store.get().cues['goal.completed'].sound === 'champion')

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
