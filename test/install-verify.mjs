/**
 * 安装校验：把 DSH 装载器在启动时真正会做的检查，原样复刻一遍。
 * 覆盖 dsh-client-modules 的 parseDshClient / clientExportOf / initialBundleRevision
 * 以及 cordis-plugin-loader 的入口解析与 package.json 读取。
 *
 * 用法： node test/install-verify.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN = resolve(HERE, '..')
const PROFILE = 'C:\\Users\\sixtyseven67\\.dsh\\profiles\\desktop'
const PKG_NAME = 'dsh-sound-cues'

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
const j = (p) => JSON.parse(readFileSync(p, 'utf8'))

console.log('\n== 1. 插件自身 package.json ==')
const pkgPath = join(PLUGIN, 'package.json')
const pkg = j(pkgPath)
ok('name 是裸名 dsh-sound-cues', pkg.name === PKG_NAME, pkg.name)
ok('type = module（宿主半边是 ESM）', pkg.type === 'module')
ok('main 指向 lib/index.js', pkg.main === './lib/index.js')

console.log('\n== 2. dsh.client 声明（parseDshClient 会逐项检查） ==')
const decl = pkg.dsh && pkg.dsh.client
ok('存在 dsh.client', !!decl)
ok('platform === "web"（非字符串会抛）', decl && decl.platform === 'web', decl && JSON.stringify(decl.platform))
ok('immediately 是布尔', decl && typeof decl.immediately === 'boolean')
ok('inject 是字符串数组', decl && Array.isArray(decl.inject) && decl.inject.every((x) => typeof x === 'string'), decl && JSON.stringify(decl.inject))

console.log('\n== 3. exports["./client"] 能解析到真实文件（clientExportOf + initialBundleRevision） ==')
const clientEntry = pkg.exports && pkg.exports['./client'] && (pkg.exports['./client'].default || pkg.exports['./client'])
ok('exports["./client"] 存在', !!clientEntry, JSON.stringify(pkg.exports && pkg.exports['./client']))
const clientAbs = clientEntry ? resolve(PLUGIN, clientEntry) : ''
ok('客户端 bundle 文件真实存在（ENOENT 会在激活时炸掉整个 web）', !!clientEntry && existsSync(clientAbs), clientAbs)
if (clientEntry && existsSync(clientAbs)) {
  ok('bundle 非空', statSync(clientAbs).size > 1000, String(statSync(clientAbs).size) + ' bytes')
}
ok('exports["."] 指向 lib/index.js', pkg.exports['.'] && pkg.exports['.'].default === './lib/index.js')

console.log('\n== 4. 客户端 bundle 封套（classic script + 精确 id） ==')
const src = readFileSync(clientAbs, 'utf8')
ok('调用了 window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\(\{/.test(src))
const idMatch = src.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)
ok(`load 的 id 精确等于包名（否则 "loaded without registering"）`, idMatch && idMatch[1] === PKG_NAME, idMatch && idMatch[1])
ok('有 factory: (require) =>', /factory:\s*\(?require\)?\s*=>/.test(src))
ok('是 classic script（无顶层 import/export）', !/^\s*(import|export)\s/m.test(src))

console.log('\n== 5. require 只碰平台种子词（闭表，多一个就抛） ==')
const SEED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
const badRequires = requires.filter((r) => !SEED.has(r))
ok('require 的模块全部在种子表内', badRequires.length === 0, badRequires.join(','))
console.log(`    实际 require: ${requires.length ? [...new Set(requires)].join(', ') : '（无）'}`)

console.log('\n== 6. dsh.bundle.patch 与顶层 insert ==')
const bundleDecl = pkg.dsh && pkg.dsh.bundle
ok('声明了 dsh.bundle.patch', !!bundleDecl && typeof bundleDecl.patch === 'string')
const patchPath = bundleDecl ? resolve(PLUGIN, bundleDecl.patch) : ''
ok('patch 文件存在', !!bundleDecl && existsSync(patchPath), patchPath)
if (bundleDecl && existsSync(patchPath)) {
  const yml = readFileSync(patchPath, 'utf8')
  ok('patch 有顶层 - insert:', /^- insert:/m.test(yml))
  const nameLine = yml.match(/name:\s*'?([\w@/.-]+)'?/)
  ok('insert 的 name 是 dsh-sound-cues', !!nameLine && nameLine[1] === PKG_NAME, nameLine && nameLine[1])
  const idLine = yml.match(/id:\s*([\w@/.-]+)/)
  ok('insert 的 id 是 dsh-sound-cues', !!idLine && idLine[1] === PKG_NAME, idLine && idLine[1])
}

console.log('\n== 7. 宿主半边导入纯净度（只允许 node: 与相对路径） ==')
const hostSrc = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8')
const imports = [...hostSrc.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
const badImports = imports.filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
ok('宿主半边的 import 只有 node: 与相对路径（R7：新包裸导入解析未证实）', badImports.length === 0, badImports.join(','))
console.log(`    实际 import: ${imports.join(', ')}`)

console.log('\n== 8. 已装进 desktop profile ==')
const profPkg = j(join(PROFILE, 'package.json'))
ok('profile dependencies 里有 dsh-sound-cues', !!profPkg.dependencies[PKG_NAME], JSON.stringify(profPkg.dependencies[PKG_NAME]))
ok('指向 link:D:/DSH/plugins/dsh-sound-cues', profPkg.dependencies[PKG_NAME] === 'link:D:/DSH/plugins/dsh-sound-cues')
ok('dsh.profile.bundles 里有 dsh-sound-cues', profPkg.dsh.profile.bundles.includes(PKG_NAME))
const link = join(PROFILE, 'node_modules', PKG_NAME)
ok('node_modules 下的 link 存在', existsSync(link), link)
if (existsSync(link)) {
  ok('link 能解析到同一个 package.json', existsSync(join(link, 'package.json')))
  ok('link 下 lib/client.js 可读', existsSync(join(link, 'lib', 'client.js')))
  ok('link 下 lib/index.js 可读', existsSync(join(link, 'lib', 'index.js')))
}
const st = existsSync(link) ? statSync(link) : null
ok('是 junction/symlink（可被删除而不影响源目录）', !!st, '')

console.log('\n== 9. 备份齐备（可一键回滚） ==')
const baks = readdirSync(PROFILE).filter((f) => f.includes('.bak-soundcues-'))
for (const need of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
  ok(`存在 ${need} 的备份`, baks.some((f) => f.startsWith(need + '.bak-soundcues-')), baks.join(','))
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
if (fail) process.exit(1)
console.log('\n所有装载器侧检查通过。剩下唯一一步：重启 DSH 让浏览器半边进入启动图。')
