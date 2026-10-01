/**
 * dsh-sound-cues 浏览器半边 —— **真 React** 渲染校验。
 *
 * client-smoke.mjs 用的是自写的最小 hook 实现；这一份换成磁盘上的真
 * React 18.3.1 + react-dom 18.3.1 的 renderToStaticMarkup，
 * 让 React 自己去执行 hooks 规则、去走整棵组件树。
 *
 * 发现 React 包路径找不到时会优雅跳过（不算失败）。
 *
 * 用法： node test/react-render.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN = resolve(HERE, '..')

let pass = 0
let fail = 0
let skip = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

/* ── 定位真 React ── */
const CANDIDATES = [
  'D:/DSH/tmp/rendertest/package.json',
  'D:/DSH/harness-3081/package.json',
]
let React = null
let renderToStaticMarkup = null
for (const c of CANDIDATES) {
  if (!existsSync(c)) continue
  try {
    const req = createRequire(c)
    const r = req('react')
    const s = req('react-dom/server')
    if (r && s && typeof s.renderToStaticMarkup === 'function') {
      React = r
      renderToStaticMarkup = s.renderToStaticMarkup
      console.log(`真 React 来自: ${c}  (react ${r.version})`)
      break
    }
  } catch (e) {
    /* 换下一个候选 */
  }
}
if (!React) {
  console.log('未找到可用的 react + react-dom（跳过真 React 渲染校验）')
  process.exit(0)
}

/* ── 环境桩 ── */
class FakeAudioContext {
  constructor() {
    this.currentTime = 0
    this.sampleRate = 44100
    this.state = 'running'
    this.destination = { connect() {} }
  }
  resume() {
    return Promise.resolve()
  }
  createGain() {
    const g = { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x || g }
    return g
  }
  createOscillator() {
    const o = {
      type: '',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (x) => x || o,
      start() {},
      stop() {},
    }
    return o
  }
  createBiquadFilter() {
    const f = { type: '', frequency: { value: 0 }, connect: (x) => x || f }
    return f
  }
  createBufferSource() {
    const s = { buffer: null, connect: (x) => x || s, start() {}, stop() {} }
    return s
  }
  createBuffer(ch, len) {
    return { length: len, getChannelData: () => new Float32Array(len) }
  }
}

const styleTags = []
const documentStub = {
  head: { appendChild: (el) => styleTags.push(el) },
  documentElement: { appendChild: (el) => styleTags.push(el) },
  getElementById: (id) => styleTags.find((t) => t.id === id) || null,
  createElement: (tag) => ({
    tagName: String(tag).toUpperCase(),
    id: '',
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    appendChild() {},
    remove() {},
  }),
}
const ls = {}
const windowStub = {
  addEventListener() {},
  localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => (ls[k] = String(v)) },
  AudioContext: FakeAudioContext,
}
globalThis.window = windowStub
globalThis.document = documentStub

let assetFiles = []
globalThis.fetch = (url) => {
  const u = String(url)
  if (u.indexOf('/assets') >= 0) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, files: assetFiles }) })
  }
  if (u.indexOf('/hello') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
  return Promise.reject(new Error('offline-stub'))
}

/* ── 装载 bundle（require('react') 给真 React） ── */
let loaded = null
windowStub.__ModuleLoader__ = { load: (def) => (loaded = def) }
const src = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
new Function('window', 'document', 'React', 'require', 'console', src)(
  windowStub,
  documentStub,
  React,
  (spec) => {
    if (spec === 'react') return React
    throw new Error('unexpected require: ' + spec)
  },
  console,
)

const exportsObj = loaded.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})

/* ── 注册，拿到组件 ── */
const regs = []
const ctx = {
  slots: {
    inject: (key, cb) => {
      const d = cb()
      return typeof d === 'function' ? d : () => {}
    },
    register: (opts, comp) => {
      regs.push({ opts, comp })
      return () => {}
    },
  },
  effect: (fn) => {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  logger: { warn: () => {} },
}
exportsObj.apply(ctx)
const byName = {}
for (const r of regs) byName[r.opts.name] = r
const internal = exportsObj.__internal

/* ── 抓 React 的告警：hook 违规、非法 props 都会在这里出现 ── */
const warnings = []
const realError = console.error
console.error = (...a) => {
  warnings.push(a.map(String).join(' '))
}

let htmlPanel = ''
let htmlOverlay = ''
let htmlGeneral = ''
let renderErr = null
try {
  htmlPanel = renderToStaticMarkup(React.createElement(byName['settings.section'].comp, {}))
  htmlGeneral = renderToStaticMarkup(React.createElement(byName['settings.general.item'].comp, {}))
  internal.cueBus.publish({ id: 1, cue: 'goal.completed', detail: '真 React 校验' })
  htmlOverlay = renderToStaticMarkup(React.createElement(byName['shell.overlay'].comp, {}))
} catch (e) {
  renderErr = e
} finally {
  console.error = realError
}

console.log('\n== 真 React 18 渲染 ==')
ok('renderToStaticMarkup 渲染设置页不抛异常', renderErr === null, renderErr && renderErr.stack)
ok('渲染过程没有 React 告警（hook 违规 / 非法 props）', warnings.length === 0, warnings.slice(0, 3).join(' || '))

console.log('\n== 设置页 HTML ==')
ok('产出了非空 HTML', htmlPanel.length > 2000, String(htmlPanel.length) + ' 字符')
ok('含总开关', /提示音已(开启|关闭)/.test(htmlPanel))
ok('含「自定义音效」', /自定义音效/.test(htmlPanel))
ok('含「提示音总表」', /提示音总表/.test(htmlPanel))
ok(`含 cue 总数（共 ${internal.CUE_CATALOG.length} 条）`, htmlPanel.indexOf('共 ' + internal.CUE_CATALOG.length + ' 条') >= 0)
ok('含「恢复默认设置」', /恢复默认设置/.test(htmlPanel))
ok('含不谎称原版录音的署名', /合成演奏，不是原版录音/.test(htmlPanel))

console.log('\n== 默认展开那一组的行真的渲染成了 HTML ==')
const g0 = internal.CUE_CATALOG[0].group
const g0Cues = internal.CUE_CATALOG.filter((c) => c.group === g0)
for (const c of g0Cues) {
  ok(`行「${c.label}」在 HTML 里`, htmlPanel.indexOf(c.label) >= 0)
}
const rowRe = /class="dsc-row(?: dsc-row-off)?"/g
ok(
  `行容器 dsc-row 恰好出现 ${g0Cues.length} 次`,
  (htmlPanel.match(rowRe) || []).length === g0Cues.length,
  String((htmlPanel.match(rowRe) || []).length),
)
ok('音色下拉 dsc-sel 出现 ' + g0Cues.length + ' 次', (htmlPanel.match(/class="dsc-sel"/g) || []).length === g0Cues.length, String((htmlPanel.match(/class="dsc-sel"/g) || []).length))
const optionCount = (htmlPanel.match(/<option/g) || []).length
ok('下拉里有全部内置音色选项（≥ 17 × 行数）', optionCount >= internal.BUILTIN_SOUNDS.length * g0Cues.length, String(optionCount))
ok('下拉选项含「关羽之歌」', htmlPanel.indexOf('关羽之歌') >= 0)
ok('下拉选项含 Champions 主题', htmlPanel.indexOf('We Are the Champions') >= 0)

console.log('\n== 自定义音效列表（loadFileIndex 真路径） ==')
await internal.loadFileIndex()
{
  assetFiles = [
    { name: 'champions.mp3', path: 'custom/champions.mp3', size: 4096, custom: true, url: '/x' },
    { name: 'guanyu.mp3', path: 'custom/guanyu.mp3', size: 8192, custom: true, url: '/y' },
  ]
  await internal.loadFileIndex()
  let html2 = ''
  const realError2 = console.error
  console.error = () => {}
  try {
    html2 = renderToStaticMarkup(React.createElement(byName['settings.section'].comp, {}))
  } finally {
    console.error = realError2
  }
  ok('文件列表出现 champions.mp3', html2.indexOf('champions.mp3') >= 0)
  ok('文件列表出现 guanyu.mp3', html2.indexOf('guanyu.mp3') >= 0)
  ok('文件大小做了 KB 换算', /4 KB/.test(html2) && /8 KB/.test(html2))
  ok('每行下拉里出现用户文件选项', html2.indexOf('📁 champions.mp3') >= 0 && html2.indexOf('📁 guanyu.mp3') >= 0)
}

console.log('\n== 右下角提示条 ==')
// SSR 不执行 useEffect，所以订阅还没装上、状态还是初始值 —— 这里只能验证
// 「无 cue 时不渲染任何东西」。「有 cue 时弹出提示条并显示中文名 / detail /
// 静音按钮」由 client-smoke.mjs 的最小 hook 实现覆盖（那条路径需要状态更新）。
ok('无 cue 时提示条为空（SSR 语义下符合预期）', htmlOverlay === '', htmlOverlay.slice(0, 120))
console.log('    （有 cue 时的提示条渲染由 client-smoke.mjs 覆盖）')

console.log('\n== 通用设置快捷行 HTML ==')
ok('快捷行含「提示音」', /提示音/.test(htmlGeneral))
ok('快捷行是 label + checkbox', /<label/.test(htmlGeneral) && /type="checkbox"/.test(htmlGeneral))

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
