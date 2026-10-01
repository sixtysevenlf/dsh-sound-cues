# dsh-sound-cues 🔊

把 **DSH 的各种状态变成听得见的提示音**的插件：

- 🎻 **任务失败 → 《关羽之歌》**（《江上行》，王健词 / 谷建芬曲，94 版《三国演义》插曲）
- 🎉 **goal 目标达成 → 《We Are the Champions》**（Queen，副歌主题）
- 外加 **37 条**覆盖回合 / 工具 / 目标 / 审批 / 后台作业 / 子代理 / 任务板 / 工作流 / 系统的提示音
- 支持 **用户自定义音效**：上传自己的 mp3/wav/ogg/m4a，绑定到任意一条提示音
- 设置界面就长在 **DSH 设置里**（侧栏「设置 → 提示音」）

---

## 一、它长什么样

### 1. 设置页（设置 → 提示音）

| 区块 | 内容 |
|---|---|
| 总开关 | 开 / 关提示音；两个「试听」大按钮（目标达成 / 任务失败） |
| 环境诊断 | 宿主连接状态、WebAudio 可用性、已装音频文件数、版本 |
| 主音量 / 单条最长 | 全局音量滑杆；单条提示音最长播放时长（超时自动掐掉） |
| 行为开关 | 「所有失败都用关羽之歌」；「右下角显示提示条」 |
| 自定义音效 | 多选上传音频文件 → 列在下面，可试听 / 删除 |
| 提示音总表 | 按分组折叠，每条 = `[开关] 名称+id  [音色下拉] [单独音量滑杆] [▶ 试听]` |
| 恢复默认 | 一键还原（含所有逐条音量） |

### ⭐ 每条提示音都能单独设音量

每一行右边都有一个自己的音量滑杆（**0–150%**），和顶部的主音量是**两层相乘**：

```
实际响度 = 主音量 × 这一条的音量
```

所以你可以把「工具/命令失败」压到 30% 免得吵，同时把「目标达成」开到 130% 让它够爽。
0% 等于不响（此时直接跳过发声，不占音频资源）。存的是单条系数，改主音量不会覆盖它。

### 2. 右下角提示条

挂在 `shell.overlay` 上的一条轻量提示（默认开），显示最近一次提示音的名称与细节；带「静音」按钮。该层本身点击穿透，只有提示条自己接管指针事件。

### 3. 通用设置快捷行

`设置 → 通用` 里多一行「提示音」开关，用于快速静音。

---

## 二、提示音总表（37 条 / 9 个分组）

`●` = 默认开启。

### 回合
| | cue id | 名称 | 默认音色 |
|---|---|---|---|
| ● | `turn.start` | 回合开始 | 上行短音 |
| ● | `turn.done` | 回合完成 | 柔铃 |
| ● | `turn.error` | **任务失败**（`turn/end` 的 `reason.kind === 'error'`） | **关羽之歌·高潮句** |
| ● | `task.failed` | 任务失败（宿主 `agent/error`） | **关羽之歌·高潮句** |
| ● | `turn.aborted` | 被中断（`aborted` / `interrupted`） | 闷响 |
| ● | `turn.blocked` | 回合受阻 | 警告低鸣 |
| ● | `turn.maxTokens` | 达到 token 上限 | 警告双哔 |
| | `user.message` | 你发了消息 | 下行短音 |

### 目标
| | cue id | 名称 | 默认音色 |
|---|---|---|---|
| ● | `goal.created` | 目标已设定 / 已修改 | 上行短音 |
| ● | `goal.completed` | **🎉 目标达成**（`phase === 'complete'`） | **Champions·副歌** |
| ● | `goal.blocked` | 目标受阻 | 警告低鸣 |
| | `goal.paused` | 目标暂停 | 柔和下落 |
| | `goal.resumed` | 目标恢复 | 上行短音 |
| | `goal.cleared` | 目标清除 | 柔和下落 |

### 工具
| | cue id | 名称 | 默认音色 |
|---|---|---|---|
| ● | `tool.error` | 工具 / 命令失败 | 错误蜂鸣 |
| | `tool.done` | 工具完成 | 柔点 |
| | `tool.start` | 工具开始 | 轻点 |

### 等你处理
| | cue id | 名称 | 默认音色 | 数据来源 |
|---|---|---|---|---|
| ● | `approval.request` | 请求授权 | 注意铃 | 会话事件 `approval/asked` |
| ● | `question.asked` | 向你提问 | 注意铃 | **浏览器侧** `pendingInteraction === 'question'` |

> 为什么提问走浏览器侧：DSH 宿主**没有** question 事件（只有浏览器线帧
> `question/requested`），宿主插件订阅不到。而 `approval/request` 是 cordis
> **waterfall**，把它当普通事件订阅会破坏授权流程 —— 所以审批改听纯审计的
> `approval/asked`。

### 后台作业（**没有** cordis 事件，只能挂服务回调）
| | cue id | 名称 | 默认音色 |
|---|---|---|---|
| ● | `job.done` | 后台作业完成 | 柔铃 |
| ● | `job.failed` | 后台作业失败 / 被杀 | 错误蜂鸣 |

### 子代理 / 团队任务板
| | cue id | 名称 | 默认音色 |
|---|---|---|---|
| | `subagent.spawned` | 派出子代理 | 上滑风 |
| ● | `subagent.done` | 子代理完成 | 柔铃 |
| ● | `subagent.failed` | 子代理未正常结束 | 错误蜂鸣 |
| | `task.created` | 任务板：新建任务 | 柔点 |
| | `task.claimed` | 任务板：有人认领 | 轻点 |
| ● | `task.completed` | 任务板：任务完成 | 柔铃 |

### 计划 / 待办 / 工作流 / 系统
| | cue id | 名称 | 默认音色 |
|---|---|---|---|
| ● | `plan.entered` | 进入计划模式 | 上行短音 |
| | `plan.exited` | 退出计划模式 | 下行短音 |
| | `todo.updated` | 待办清单更新 | 轻点 |
| | `workflow.start` | 工作流开始 | 上滑风 |
| ● | `workflow.done` | 工作流完成 | 柔铃 |
| ● | `workflow.failed` | 工作流失败 | 错误蜂鸣 |
| ● | `llm.retry` | 模型重试 | 警告双哔 |
| ● | `session.compaction` | 上下文压缩（含压缩失败） | 微光 |
| | `session.title` | 标题生成 | 柔点 |
| ● | `command.error` | 斜杠命令失败 | 警告低鸣 |

---

## 三、音色

### 18 个内置音色（零资源文件，WebAudio 实时合成）

`（静音）` `上行短音` `下行短音` `轻点` `柔点` `柔铃` `柔和下落` `错误蜂鸣`
`警告低鸣` `警告双哔` `闷响` `注意铃` `上滑风` `微光` `凯旋号角（自产）`
**`关羽之歌·高潮句（合成）`** **`关羽之歌·引子首句（合成）`** **`We Are the Champions·副歌（合成）`**

### ⚠ 关于两首「歌」的保真度 —— 请务必读这一段

插件里放的是**合成演奏**，不是原版录音（版权原因不能打包）：

| 音色 | 是哪一段 | 来源 |
|---|---|---|
| `关羽之歌·高潮句`**（默认）** | 「早把这三尺身躯青龙偃月，付与苍生」开头四小节 —— 全曲反复三遍、层层推到顶的那一句 | 音高逐小节抄自**简谱**（1=C，4/4，♩=112） |
| `关羽之歌·引子首句` | 竹笛引子接「好江风，将这轻舟催送」 | 同上简谱 |
| `We Are the Champions·副歌`**（默认）** | 「We are the champions, my friends / and we'll keep on fighting till the end」 | 按歌词逐句对齐的字母谱 + 与 Hooktheory 分析双向校对（见下） |
| `凯旋号角（自产）` | 我写的动机 | 无版权顾虑的通用胜利感 |

**想听原曲**：在设置页「自定义音效」里把 `champions.mp3` / `guanyu.mp3`
传上去，然后到 `goal.completed` / `turn.error` 那一行把下拉切到该文件即可。
10 秒搞定，且从此播放的是你的原版音频。

### 副歌是怎么定位并对上调的（可复核）

「随便一段旋律」和「那段知名副歌」的区别，全靠这两步：

1. **按歌词定位** —— 用一份**把歌词逐句写在音符下面**的字母谱
   （[noobnotes](https://noobnotes.net/we-are-the-champions-queen/)），
   所以拿到的必定是副歌那段，而不是随便截的小节。
2. **按权威分析定调 + 定音域** —— 用 [Hooktheory 的 TheoryTab 分析](https://www.hooktheory.com/theorytab/view/queen/we-are-the-champions)
   （整首歌 **C 小调**，**副歌转到 F 大调**，和弦 I–iii–vi–IV–V = F–Am–Dm–Bb–C，
   副歌**旋律音域 A3–C5**）。把字母谱整体上移 3 个半音落进 F 大调、
   同时下移一个八度，音域就**正好落成 A3–C5** —— 两处独立校验同时吻合，
   这不是巧合。

结果（首调，F 大调）：

```
We are the champions,   my friends   and we'll keep on fighting   'til the end
1 7 1 7 5               3 6 3        5 1 2 3 5 3                  6 7 6
```

`test/client-smoke.mjs` 把上面四个音级序列、音域 A3–C5、以及「除借用音外全落在
F 大调音阶内」都写成了断言，改坏任何一个都会红。

### 旋律出处（可审计）

`provenance/` 里放着我据以抄写的原始材料，你可以自己核：

| 文件 | 用途 |
|---|---|
| `江上行-关羽之歌-简谱.jpg` | 关羽之歌的**简谱扫描件**（标明「又名：关羽之歌」，王健词 / 谷建芬曲，崔京浩演唱）。高潮句就是从它上面逐小节读出来的 |
| `we-are-the-champions.mid` | 最初下载的公开 MIDI —— **它其实没有旋律声部**（ch5 是 Choir 和弦垫，ch3/ch6 是弦乐副旋律）。这份是反例，留着说明为什么不能拿它当旋律来源 |
| `analyze_midi.py` | 通用 MIDI 分析工具：`channels` 看各通道概况 / `dump <ch>` 转储 / `find` 按音程轮廓模板搜索。当初就是用 `channels` 发现「没有一条人声线」 |
| `extract_melody_from_midi.py` | 早期的通道转储脚本（`analyze_midi.py` 的前身） |
| `parse_midi.py` | 更早的 SMF 解析草稿 |
| `extract_hooktheory.py` | 从 Hooktheory 页面里把内联的分析数据抠出来的脚本 |

两条**走过但没用的路**也记在这里，免得下次重走：人人钢琴网那套 Champions 简谱
只对外发 200×260 的缩略图（原图要登录），读不出音符；本地的 Python 没有
PDF 渲染库（fitz / pypdfium2 / pdf2image 都没有），所以那份 Piano/Vocal PDF
乐谱也读不了。

简谱与字母谱是**图像 / 文本**，音高是我按谱面读出来的（先把图切成条带放大再读）；
MIDI 相关的结论是**程序跑出来的**，可复现。全部都不是原版录音。

### 自定义音效支持格式

`mp3` `wav` `ogg` `m4a` `aac` `flac` `webm` `opus`

上传的文件落在插件目录的 `assets/custom/`，由宿主 HTTP 端点提供字节。
文件名做了白名单过滤（非法扩展名拒绝、路径穿越拒绝）。

---

## 四、架构

```
┌──────────────────────── 宿主半边  lib/index.js ─────────────────────────┐
│ inject: ['webServer']                                                   │
│                                                                         │
│  A. cordis 全局事件   ctx.on('agent/error' | 'subagent/*' |             │
│                              'workflow/*' | 'goal/changed')             │
│  B. 会话持久事件      ctx.on('session/event', …)  ← 主战场，48 种类型     │
│  C. 服务局部回调      ctx.jobs.onJobDone(…)       ← 作业没有 cordis 事件 │
│                          ↓ 压成 cue 队列（自增 id）                       │
│  HTTP 端点（webServer.register，全在 /sound-cues 下）                    │
│    GET  /sound-cues/events?since=N   长轮询，有新 cue 立刻返回（≤20s）    │
│    GET  /sound-cues/state            健康 / 版本 / 队列长度              │
│    GET  /sound-cues/assets           音频文件清单                        │
│    GET  /sound-cues/audio/<path>     音频字节（白名单 + 越界拒绝）        │
│    POST /sound-cues/upload?name=     上传自定义音效                      │
│    GET  /sound-cues/delete/<name>    删除自定义音效                      │
│    GET/POST /sound-cues/config       设置读写（落盘 state.json）          │
│    GET  /sound-cues/ping?cue=X       手动投一条（设置页试听/自检）        │
│    POST /sound-cues/hello            浏览器半边的心跳（证明网页侧已生效）  │
└─────────────────────────────────────────────────────────────────────────┘
                                   ↓ 长轮询（服务端 push，延迟 <1ms）
┌────────────────────── 浏览器半边  lib/client.js ────────────────────────┐
│ window.__ModuleLoader__.load({ id: 'dsh-sound-cues', factory })         │
│ inject = ['slots']                                                      │
│  ① settings.section       → 提示音设置页（React 函数组件）               │
│  ② settings.general.item  → 通用里的快捷静音行                           │
│  ③ shell.overlay          → 右下角提示条                                 │
│  ④ 提问观察器（可选）      → ctx.get('sessions') 轮询 pendingInteraction  │
│                                                                         │
│  音效引擎：合成音 / 用户音频（decodeAudioData + 缓存），主音量、限流、    │
│            「长音互斥、短音可叠」、单条最长自动掐断                       │
│  设置持久化：localStorage 为主 + 落盘到宿主 state.json                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 为什么不把事件观测全放浏览器侧

DSH 客户端确实有一流的可观察对象层（`ctx.sessions.list`、
`ctx.sessions.binding(id).session`），但它拿不到全部信息：

- `turn/end` 的**精确结局**（`reason.kind` ∈ completed / error / aborted /
  interrupted / blocked / max-tokens）只有宿主侧看得到；
- 后台作业**没有事件**，宿主侧也只能靠 `onJobDone` 回调；
- 跨会话（后台跑着的别的会话）浏览器侧只有当前选中会话的完整快照。

反过来，**「有人向你提问」只有浏览器侧看得到**（宿主没有 question 事件）。
所以两边各取所长：主战场在宿主，提问这一条挂在浏览器。

---

## 五、安装（已完成）

```
D:\DSH\plugins\dsh-sound-cues            ← 源码 + 产物（无构建步骤）
  ├─ package.json                        dsh.bundle.patch + dsh.client(platform=web)
  ├─ cordis.patch.yml                    顶层 - insert:（关键，见下）
  ├─ lib/index.js                        宿主半边（纯 ESM，只用 node: 内置模块）
  ├─ lib/client.js                       浏览器半边（单文件 classic script 封套）
  ├─ assets/custom/                      用户上传的音效落这里
  ├─ state.json                          设置落盘（运行后生成）
  └─ test/                               三个自检脚本，共 150 条断言
```

已写入 desktop profile：

- `C:\Users\sixtyseven67\.dsh\profiles\desktop\package.json`
  - `dependencies["dsh-sound-cues"] = "link:D:/DSH/plugins/dsh-sound-cues"`
  - `dsh.profile.bundles` 追加 `"dsh-sound-cues"`
- `node_modules\dsh-sound-cues` → junction 指向 `D:\DSH\plugins\dsh-sound-cues`

> ⚠ **没有**改 profile 的 `cordis.patch.yml`。本插件通过自己的
> `dsh.bundle.patch` 自装配一条**顶层** insert；同一个 id 在 bundle 层和
> profile 层各插一次会触发重复注册。
>
> ⚠ 这个 insert **必须是顶层**：`@deepseek-ai/dsh-client-modules` 的宿主半边
> 只扫描 enabled 的**顶层 Loader 条目**来组合浏览器启动图。挂在 preset 的
> `config.plugins` 之类嵌套行里的插件它扫不到，`dsh.client` 永远不会被服务成
> bundle —— 表现是「设置里没有这一页」且**不报任何错**。

### 为什么没有构建步骤

DSH 的宿主半边用原生 `import()` 直接加载 `.js`（`dsh-git-bash`、
`dsh-shell-switch`、`dsh-divination-108` 都是手写 JS，没有 bundler）。
浏览器半边则必须是一个**叫 `window.__ModuleLoader__.load(...)` 的 classic
script**，但它同样可以手写。所以本插件两半都是手写纯 JS，不需要
tsc/tsdown/pnpm —— 免掉整条工具链和它的失败面。

### 回滚

```powershell
$p = 'C:\Users\sixtyseven67\.dsh\profiles\desktop'
# 1) 还原配置（备份带时间戳）
Copy-Item "$p\package.json.bak-soundcues-*"        "$p\package.json" -Force
Copy-Item "$p\pnpm-lock.yaml.bak-soundcues-*"      "$p\pnpm-lock.yaml" -Force
# 2) 摘掉 junction（先确认路径，再用目录 API，避免 -Recurse 跟进源目录）
$t = "$p\node_modules\dsh-sound-cues"
if ((Get-Item $t -Force -ErrorAction SilentlyContinue).LinkType) { [System.IO.Directory]::Delete($t) }
```

源码目录 `D:\DSH\plugins\dsh-sound-cues` 不受影响，可随时重新挂上。

---

## 六、自检

```powershell
$node = "D:\DSH DESKTOP\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node D:\DSH\plugins\dsh-sound-cues\test\host-smoke.mjs      # 82 条：宿主事件→cue、HTTP 端点
& $node D:\DSH\plugins\dsh-sound-cues\test\client-smoke.mjs    # 112 条：封套、slot、整树渲染与交互、逐条音量、旋律、向后兼容
& $node D:\DSH\plugins\dsh-sound-cues\test\react-render.mjs    # 29 条：用真 React 18 渲染成 HTML 校验
& $node D:\DSH\plugins\dsh-sound-cues\test\install-verify.mjs  # 33 条：复刻装载器的启动期检查
```

（合计 **256** 条断言，当前全绿。）

**网页半边的三层校验**，一层比一层更接近真实：

1. `client-smoke.mjs` 用一个**最小 React hook 实现**（自写约 90 行）把
   `SettingsPanel` / `OverlayIndicator` / `GeneralRow` **真的渲染一遍并点**：
   展开 / 收起分组、读出行数与中文名、点总开关 / 音量滑杆 / 音色下拉 /
   试听按钮 / 静音按钮，断言每一步都真的写进了 store、真的发出了声音。
2. `react-render.mjs` 换成磁盘上的**真 React 18.3.1 + react-dom 18.3.1**，
   用 `renderToStaticMarkup` 让 React 自己去执行 hooks 规则、走整棵组件树，
   并把 **React 的告警当成失败**（hook 违规 / 非法 props 都会被抓出来）。
   还会真的走一遍 `loadFileIndex()`，断言上传后的文件名出现在文件列表
   与每一行的音色下拉里。
3. `install-verify.mjs` 复刻 `dsh-client-modules` 启动时对包做的每一项检查
   （`parseDshClient` / `clientExportOf` / `initialBundleRevision`），
   以及宿主半边的导入纯净度（只允许 `node:` 与相对路径）。

`host-smoke.mjs` 会桩一个 cordis ctx 跑**真代码**，覆盖：
`turn/end` 六种结局、`tool/result` 的失败判据、`goal/changed` 各 operation、
`approval/asked`、`plan/mode`、`command/done`、`compaction/end`、
`team/task`、`todo/write`、`agent/error`、`subagent/start|end`、
`workflow/start|end`、`jobs.onJobDone`；
以及上传 / 列表 / 取字节 / 路径穿越拒绝 / 非法扩展名拒绝 / 删除 /
设置读写 / 增量拉取 / 长轮询挂起与唤醒（<1s）。

---

## 七、运行期自检

宿主半边的健康端点（**不需要**网页认证）：

```powershell
(Invoke-WebRequest 'http://127.0.0.1:19387/sound-cues/state' -UseBasicParsing).Content
(Invoke-WebRequest 'http://127.0.0.1:19387/sound-cues/events?since=0' -UseBasicParsing).Content
# 手动投一条，浏览器侧应立刻响 + 右下角出提示条
(Invoke-WebRequest 'http://127.0.0.1:19387/sound-cues/ping?cue=goal.completed' -UseBasicParsing).Content
```

**判断网页半边有没有真的跑起来** —— 看 `/sound-cues/state` 里的 `client` 字段：

- `"client": null` → 网页半边还没加载（需要重启 DSH，或刷新页面）
- `"client": {"ts": …, "version": "0.1.0", "slots": {"settings":"ok","general":"ok","overlay":"ok"}}`
  → 网页半边已 apply，三个 slot 全部注册成功

这个心跳是浏览器侧 `apply()` 时 POST 到 `/sound-cues/hello` 打的，不依赖 DevTools。

也可以打开浏览器 DevTools 控制台看：

```
[sound-cues] client applied { settings: 'ok', general: 'ok', overlay: 'ok' }
```

`settings` / `overlay` 任一为 `ERR: …` 说明该 slot 没声明（不同 DSH 版本
slot 名会变），其余功能不受影响。

---

## 八、已知边界

1. **两首歌的原版录音不含在插件内**（版权），默认是合成演奏；上传音频文件即可换成原版。
2. `settings.section.icon`（设置导航图标）未注册 —— 该 seat 不是所有 DSH 版本都有，
   缺席时 shell 会渲染自带的齿轮图标。
3. `question.asked` 依赖客户端会话列表的 `pendingInteraction`；若某版本没有该字段，
   这条不响，其余不受影响。
4. 插件目录若为只读，上传会失败，但合成音与设置（存 localStorage）照常工作。
5. 宿主侧读 `ctx.jobs` 包在 try/catch 里 —— 某些 profile 没有 jobs 服务时
   cordis 的服务守卫会抛，吃掉即可，其余事件不受影响。
