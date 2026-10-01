/**
 * dsh-sound-cues —— 浏览器半边（单一 CJS bundle，由 __ModuleLoader__ 装载）。
 *
 * 结构：
 *   1. 音色库       —— WebAudio 实时合成，零资源文件即可开箱即用；
 *   2. 旋律表       —— 《关羽之歌(江上行)》《We Are the Champions》主题的合成演奏；
 *   3. cue 目录     —— 事件 → 默认音色 + 中文说明（设置页据此渲染）；
 *   4. 设置 store   —— localStorage 为主，同步落盘到宿主 state.json；
 *   5. 播放引擎     —— 合成音 / 用户上传音频文件两种源，统一音量与限流；
 *   6. cue 拉取     —— 对宿主 /sound-cues/events 做长轮询（服务端 push）；
 *   7. SettingsPanel—— 注册进 settings.section 的 React 组件；
 *   8. shell.overlay—— 右下角迷你提示（上一条 cue + 一键静音）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sound-cues',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var React = react.default !== undefined ? react.default : react
    var createElement = function (type, props) {
      var children = []
      for (var i = 2; i < arguments.length; i++) children.push(arguments[i])
      return React.createElement.apply(React, [type, props].concat(children))
    }
    var Fragment = React.Fragment
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback

    var PLUGIN_NAME = 'dsh-sound-cues'
    var PLUGIN_VERSION = '0.2.1'
    var BASE = '/sound-cues'
    var LS_KEY = 'dsh-sound-cues:v1'

    /* ══════════════════════════════ 1. 音色库 ══════════════════════════════ */

    var ac = null
    var master = null
    var globalVolume = 0.6
    /**
     * 当前这条 cue 自己的音量系数（0–1.5），由 playCue 在发声前设置。
     * tone / noise / playFileBuffer 都会乘上它 —— 这就是「逐条音量」的落点。
     */
    var cueGain = 1
    var lastPlay = {}
    /** 同一 cue 的最小间隔（毫秒）：防止一串工具失败把耳朵轰掉。 */
    var DEDUPE_MS = 350

    function ensureAudio() {
      if (ac) return ac
      var Ctor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null
      if (!Ctor) return null
      try {
        ac = new Ctor()
        master = ac.createGain()
        master.gain.value = globalVolume
        master.connect(ac.destination)
        var unlock = function () {
          if (ac && ac.state === 'suspended') ac.resume().catch(function () {})
        }
        window.addEventListener('pointerdown', unlock, { passive: true })
        window.addEventListener('keydown', unlock)
      } catch (e) {
        ac = null
      }
      return ac
    }

    function tone(o) {
      if (!ac) return
      var t0 = ac.currentTime + (o.when || 0)
      var dur = Math.max(0.01, o.dur)
      var osc = ac.createOscillator()
      var g = ac.createGain()
      osc.type = o.type || 'sine'
      osc.frequency.setValueAtTime(Math.max(20, o.freq), t0)
      if (o.slideTo) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t0 + dur)
      }
      var peak = Math.max(0.0002, (o.gain == null ? 0.16 : o.gain) * cueGain)
      var attack = o.attack == null ? 0.008 : o.attack
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(peak, t0 + attack)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      var node = g
      if (o.lowpass) {
        var lp = ac.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = o.lowpass
        g.connect(lp)
        node = lp
      }
      osc.connect(g)
      node.connect(master)
      osc.start(t0)
      osc.stop(t0 + dur + 0.03)
      track(osc)
    }

    /** 登记一个可被 stopAll 掐掉的音源，播完自动摘除。 */
    function track(node) {
      try {
        activeSources.push(node)
        node.onended = function () {
          var i = activeSources.indexOf(node)
          if (i >= 0) activeSources.splice(i, 1)
        }
      } catch (e) {
        /* ignore */
      }
    }

    function noise(o) {
      if (!ac) return
      var t0 = ac.currentTime + (o.when || 0)
      var dur = Math.max(0.01, o.dur)
      var len = Math.max(1, Math.floor(ac.sampleRate * dur))
      var buf = ac.createBuffer(1, len, ac.sampleRate)
      var data = buf.getChannelData(0)
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
      var src = ac.createBufferSource()
      src.buffer = buf
      var g = ac.createGain()
      var peak = Math.max(0.0002, (o.gain == null ? 0.18 : o.gain) * cueGain)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      var node = g
      if (o.lowpass) {
        var lp = ac.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = o.lowpass
        g.connect(lp)
        node = lp
      }
      if (o.highpass) {
        var hp = ac.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = o.highpass
        node.connect(hp)
        node = hp
      }
      src.connect(g)
      node.connect(master)
      src.start(t0)
      src.stop(t0 + dur + 0.03)
      track(src)
    }

    /** MIDI 音高 → 频率（A4=69→440Hz）。 */
    function midiToFreq(m) {
      return 440 * Math.pow(2, (m - 69) / 12)
    }

    /**
     * 演奏一段旋律。
     * @param notes 形如 [[midi, 起始拍, 时长拍], ...]
     * @param opts  { bpm, wave, gain, attack, lowpass }
     */
    function playMelody(notes, opts) {
      if (!ac || !notes || !notes.length) return 0
      var o = opts || {}
      var bpm = o.bpm || 112
      var spb = 60 / bpm
      var maxBeats = o.maxBeats || 999
      var total = 0
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i]
        var start = n[1]
        if (start > maxBeats) continue
        var dur = Math.min(n[2], maxBeats - start + 0.5)
        if (dur <= 0.02) continue
        tone({
          freq: midiToFreq(n[0]),
          dur: dur * spb * 0.97,
          when: start * spb,
          type: o.wave || 'triangle',
          gain: (o.gain == null ? 0.13 : o.gain),
          attack: o.attack == null ? 0.02 : o.attack,
          lowpass: o.lowpass,
        })
        // 叠一层高八度弱音，让合成音不至于太干
        tone({
          freq: midiToFreq(n[0] + 12),
          dur: dur * spb * 0.6,
          when: start * spb,
          type: 'sine',
          gain: (o.gain == null ? 0.13 : o.gain) * 0.35,
          attack: 0.03,
        })
        total = Math.max(total, (start + dur) * spb)
      }
      return total
    }

    /* ═══════════════════════ 2. 旋律表（合成演奏，非原版录音） ═══════════════════════ */

    /**
     * 《关羽之歌》**高潮句**——「早把这七尺身躯青龙偃月，付与苍生」的开头四小节。
     * 这是全曲反复三遍、层层推到顶的那一句，也是被引用得最多的一段。
     *
     * 来源：原名《江上行》，王健词 / 谷建芬曲，94 版《三国演义》插曲。
     * 音高逐小节抄自公开简谱（1=C，4/4，♩=112）；简谱图像见 provenance/。
     * 简谱（首调）: 2 2 2 2 1 2 3 | 5 1 1̇ 7̲ 6̲ 0 | 5 5 5 5 3 5 6 | 1̇ 1̇ 1̇ 7̲ 6̲ 6̲ 1̇
     */
    var MELODY_GUANYU_CLIMAX = [
      // 早把 这 七尺 身躯
      [62, 0.0, 0.5], [62, 0.5, 0.5], [62, 1.0, 0.5], [62, 1.5, 0.5],
      [60, 2.0, 0.5], [62, 2.5, 0.5], [64, 3.0, 1.0],
      // 青龙偃月，（留白）
      [67, 4.0, 0.5], [60, 4.5, 0.5], [72, 5.0, 1.0], [59, 6.0, 0.5], [57, 6.5, 0.5],
      // 早把 这 七尺 身躯
      [67, 8.0, 0.5], [67, 8.5, 0.5], [67, 9.0, 0.5], [67, 9.5, 0.5],
      [64, 10.0, 0.5], [67, 10.5, 0.5], [69, 11.0, 1.0],
      // 青龙偃月，早
      [72, 12.0, 0.5], [72, 12.5, 0.5], [72, 13.0, 0.5], [59, 13.5, 0.5],
      [57, 14.0, 0.5], [57, 14.5, 0.5], [72, 15.0, 1.0],
    ]

    /**
     * 《关羽之歌》**引子 + 首句**——竹笛引子接「好江风，将这轻舟催送」。
     * 想用更含蓄的版本时选它。
     */
    var MELODY_GUANYU_INTRO = [
      [64, 0.0, 0.5], [67, 0.5, 0.5],
      [57, 1.0, 3.0],
      [67, 4.0, 0.5], [64, 4.5, 0.5],
      [62, 5.0, 1.0], [64, 6.0, 2.0],
      [57, 8.0, 1.5], [60, 9.5, 0.5], [62, 10.0, 0.5],
      [64, 10.5, 0.5], [60, 11.0, 0.5], [59, 11.5, 0.5],
      [57, 12.0, 3.0],
    ]

    /**
     * 《We Are the Champions》**副歌**——「We are the champions, my friends /
     * and we'll keep on fighting till the end」。这是主歌之后全曲最著名的那一段。
     *
     * 音高取自一份**按歌词逐句对齐**的字母谱（noobnotes），并做了两处校正，
     * 以便与权威和声分析（Hooktheory）对得上 —— 两处独立校验同时吻合：
     *   · 整体上移 3 个半音 → 落进 Hooktheory 标注的副歌调 **F 大调**
     *     （和弦 I–iii–vi–IV–V = F–Am–Dm–Bb–C）；
     *   · 同时下移一个八度 → 音域正好落在 Hooktheory 标注的副歌旋律音域
     *     **A3–C5**。
     * 首调（F 大调）：1 7 1 7 5 | 3 6 3 | 5 1 2 3 5 3 | 6 7 6
     * 原曲 6/8、约 63 BPM；这里用 112 BPM 的四分音符拍，作提示音更利落。
     */
    var MELODY_CHAMPION = [
      // We are the champions,
      [65, 0.0, 0.5], [64, 0.5, 0.5], [65, 1.0, 0.5], [64, 1.5, 0.5],
      [60, 2.0, 2.0],
      // my friends
      [57, 4.0, 0.5], [62, 4.5, 1.0], [57, 5.5, 1.0],
      // And we'll keep on fighting
      [60, 6.5, 0.5], [65, 7.0, 0.5], [67, 7.5, 0.5], [69, 8.0, 0.5],
      [72, 8.5, 1.0], [69, 9.5, 1.0],
      // 'til the end
      [62, 10.5, 0.5], [64, 11.0, 0.5], [62, 11.5, 1.5],
    ]

    /** 上升的凯旋号角（自产动机，无版权问题）—— 想要「通用胜利感」时用。 */
    var MELODY_FANFARE = [
      [70, 0.0, 0.25], [74, 0.25, 0.25], [77, 0.5, 0.25], [82, 0.75, 0.75],
      [79, 1.5, 0.25], [82, 1.75, 0.25], [86, 2.0, 1.5],
      [84, 3.5, 0.25], [82, 3.75, 0.25], [79, 4.0, 0.25], [77, 4.25, 0.25],
      [82, 4.5, 2.0],
    ]

    /* ══════════════════════════ 3. cue 目录 ══════════════════════════ */

    /**
     * 内置音色：
     *   synth  —— 合成动机（零资源）
     *   melody —— 旋律演奏
     */
    var BUILTIN_SOUNDS = [
      { id: 'silent', label: '（静音）', kind: 'none' },

      { id: 'blip-up', label: '上行短音', kind: 'synth' },
      { id: 'blip-down', label: '下行短音', kind: 'synth' },
      { id: 'tick', label: '轻点', kind: 'synth' },
      { id: 'tick-soft', label: '柔点', kind: 'synth' },
      { id: 'chime-soft', label: '柔铃', kind: 'synth' },
      { id: 'down-soft', label: '柔和下落', kind: 'synth' },
      { id: 'error-buzz', label: '错误蜂鸣', kind: 'synth' },
      { id: 'warn-buzz', label: '警告低鸣', kind: 'synth' },
      { id: 'warn-beep', label: '警告双哔', kind: 'synth' },
      { id: 'thud', label: '闷响', kind: 'synth' },
      { id: 'attention', label: '注意铃', kind: 'synth' },
      { id: 'whoosh-up', label: '上滑风', kind: 'synth' },
      { id: 'shimmer', label: '微光', kind: 'synth' },
      { id: 'fanfare', label: '凯旋号角（自产）', kind: 'synth' },

      { id: 'guanyu', label: '关羽之歌《江上行》高潮句·早把这三尺身躯（合成）', kind: 'melody' },
      { id: 'guanyu-intro', label: '关羽之歌《江上行》引子+首句·好江风（合成）', kind: 'melody' },
      { id: 'champion', label: 'We Are the Champions 副歌·We are the champions（合成）', kind: 'melody' },
    ]

    function playBuiltin(id) {
      switch (id) {
        case 'blip-up':
          tone({ freq: 620, dur: 0.11, type: 'sine', slideTo: 1240, gain: 0.16 })
          break
        case 'blip-down':
          tone({ freq: 900, dur: 0.13, type: 'sine', slideTo: 430, gain: 0.15 })
          break
        case 'tick':
          tone({ freq: 1500, dur: 0.025, type: 'square', gain: 0.07 })
          break
        case 'tick-soft':
          tone({ freq: 1050, dur: 0.05, type: 'sine', gain: 0.09 })
          break
        case 'chime-soft':
          tone({ freq: 880, dur: 0.42, type: 'sine', gain: 0.13 })
          tone({ freq: 1320, dur: 0.34, type: 'sine', gain: 0.07, when: 0.02 })
          tone({ freq: 1760, dur: 0.22, type: 'sine', gain: 0.04, when: 0.04 })
          break
        case 'down-soft':
          tone({ freq: 520, dur: 0.22, type: 'triangle', slideTo: 300, gain: 0.13 })
          break
        case 'error-buzz':
          tone({ freq: 190, dur: 0.30, type: 'sawtooth', slideTo: 88, gain: 0.17, lowpass: 900 })
          noise({ dur: 0.14, gain: 0.10, lowpass: 700 })
          break
        case 'warn-buzz':
          tone({ freq: 233, dur: 0.10, type: 'square', gain: 0.10 })
          tone({ freq: 233, dur: 0.16, type: 'square', gain: 0.11, when: 0.16 })
          break
        case 'warn-beep':
          tone({ freq: 1046, dur: 0.07, type: 'sine', gain: 0.12 })
          tone({ freq: 1046, dur: 0.09, type: 'sine', gain: 0.12, when: 0.13 })
          break
        case 'thud':
          tone({ freq: 92, dur: 0.20, type: 'sine', gain: 0.22 })
          noise({ dur: 0.10, gain: 0.13, lowpass: 320 })
          break
        case 'attention':
          tone({ freq: 1046, dur: 0.14, type: 'sine', gain: 0.13 })
          tone({ freq: 1318, dur: 0.14, type: 'sine', gain: 0.12, when: 0.13 })
          tone({ freq: 1568, dur: 0.26, type: 'sine', gain: 0.11, when: 0.26 })
          break
        case 'whoosh-up':
          noise({ dur: 0.35, gain: 0.09, highpass: 400 })
          tone({ freq: 300, dur: 0.34, type: 'sine', slideTo: 1400, gain: 0.07 })
          break
        case 'shimmer':
          tone({ freq: 2093, dur: 0.55, type: 'sine', gain: 0.06 })
          tone({ freq: 2637, dur: 0.45, type: 'sine', gain: 0.045, when: 0.06 })
          tone({ freq: 3136, dur: 0.35, type: 'sine', gain: 0.03, when: 0.12 })
          break
        case 'fanfare':
          playMelody(MELODY_FANFARE, { bpm: 168, wave: 'sawtooth', gain: 0.055, lowpass: 2600, attack: 0.012 })
          break
        case 'guanyu':
          // 高潮句偏悲壮，用三角波 + 稍慢的 112 BPM
          playMelody(MELODY_GUANYU_CLIMAX, { bpm: 112, wave: 'triangle', gain: 0.115, lowpass: 3000 })
          break
        case 'guanyu-intro':
          playMelody(MELODY_GUANYU_INTRO, { bpm: 112, wave: 'triangle', gain: 0.115, lowpass: 3000 })
          break
        case 'champion':
          // 副歌要「凯旋」，用方波叠一层泛音，112 BPM 一行一句
          playMelody(MELODY_CHAMPION, { bpm: 112, wave: 'square', gain: 0.058, lowpass: 2600 })
          break
        default:
          break
      }
    }

    /**
     * cue 目录。`sound` 是默认音色，`on` 是默认开关。
     * 设置页完全由这张表驱动 —— 加一条 cue 只需在这里加一行。
     */
    var CUE_CATALOG = [
      { id: 'turn.start', group: '回合', label: '回合开始', sound: 'blip-up', on: false, desc: '助手开始处理你的消息' },
      { id: 'turn.done', group: '回合', label: '回合完成', sound: 'chime-soft', on: true, desc: '助手正常收尾' },
      { id: 'turn.error', group: '回合', label: '任务失败', sound: 'guanyu', on: true, desc: '回合以错误结束 —— 默认放关羽之歌' },
      { id: 'task.failed', group: '回合', label: '任务失败（宿主报错）', sound: 'guanyu', on: true, desc: '宿主 agent 抛出错误' },
      { id: 'turn.aborted', group: '回合', label: '被中断', sound: 'thud', on: true, desc: '你打断了，或上层取消' },
      { id: 'turn.blocked', group: '回合', label: '受阻', sound: 'warn-buzz', on: true },
      { id: 'turn.maxTokens', group: '回合', label: '达到 token 上限', sound: 'warn-beep', on: true },
      { id: 'user.message', group: '回合', label: '你发了消息', sound: 'blip-down', on: false },

      { id: 'goal.created', group: '目标', label: '目标已设定', sound: 'blip-up', on: true },
      { id: 'goal.completed', group: '目标', label: '🎉 目标达成', sound: 'champion', on: true, desc: 'goal 进入 complete —— 默认放 We Are the Champions' },
      { id: 'goal.blocked', group: '目标', label: '目标受阻', sound: 'warn-buzz', on: true },
      { id: 'goal.paused', group: '目标', label: '目标暂停', sound: 'down-soft', on: false },
      { id: 'goal.resumed', group: '目标', label: '目标恢复', sound: 'blip-up', on: false },
      { id: 'goal.cleared', group: '目标', label: '目标清除', sound: 'down-soft', on: false },

      { id: 'tool.error', group: '工具', label: '工具 / 命令失败', sound: 'error-buzz', on: true },
      { id: 'tool.done', group: '工具', label: '工具完成', sound: 'tick-soft', on: false },
      { id: 'tool.start', group: '工具', label: '工具开始', sound: 'tick', on: false },

      { id: 'approval.request', group: '等你处理', label: '请求授权', sound: 'attention', on: true },
      { id: 'question.asked', group: '等你处理', label: '向你提问', sound: 'attention', on: true },

      { id: 'job.done', group: '后台作业', label: '后台作业完成', sound: 'chime-soft', on: true },
      { id: 'job.failed', group: '后台作业', label: '后台作业失败', sound: 'error-buzz', on: true },

      { id: 'subagent.spawned', group: '子代理 / 团队', label: '派出子代理', sound: 'whoosh-up', on: false },
      { id: 'subagent.done', group: '子代理 / 团队', label: '子代理完成', sound: 'chime-soft', on: true },
      { id: 'subagent.failed', group: '子代理 / 团队', label: '子代理未正常结束', sound: 'error-buzz', on: true },
      { id: 'task.created', group: '子代理 / 团队', label: '任务板：新建任务', sound: 'tick-soft', on: false },
      { id: 'task.claimed', group: '子代理 / 团队', label: '任务板：有人认领', sound: 'tick', on: false },
      { id: 'task.completed', group: '子代理 / 团队', label: '任务板：任务完成', sound: 'chime-soft', on: true },

      { id: 'plan.entered', group: '计划 / 待办', label: '进入计划模式', sound: 'blip-up', on: true },
      { id: 'plan.exited', group: '计划 / 待办', label: '退出计划模式', sound: 'blip-down', on: false },
      { id: 'todo.updated', group: '计划 / 待办', label: '待办清单更新', sound: 'tick', on: false },

      { id: 'workflow.start', group: '工作流', label: '工作流开始', sound: 'whoosh-up', on: false },
      { id: 'workflow.done', group: '工作流', label: '工作流完成', sound: 'chime-soft', on: true },
      { id: 'workflow.failed', group: '工作流', label: '工作流失败', sound: 'error-buzz', on: true },

      { id: 'llm.retry', group: '系统', label: '模型重试', sound: 'warn-beep', on: true },
      { id: 'session.compaction', group: '系统', label: '上下文压缩', sound: 'shimmer', on: true },
      { id: 'session.title', group: '系统', label: '标题生成', sound: 'tick-soft', on: false },
      { id: 'command.error', group: '系统', label: '斜杠命令失败', sound: 'warn-buzz', on: true },
    ]

    var CUE_BY_ID = {}
    for (var ci = 0; ci < CUE_CATALOG.length; ci++) CUE_BY_ID[CUE_CATALOG[ci].id] = CUE_CATALOG[ci]

    /** 「失败音统一用关羽之歌」时改写的 cue。 */
    var FAILURE_CUES = [
      'turn.error',
      'task.failed',
      'turn.blocked',
      'tool.error',
      'job.failed',
      'goal.blocked',
      'subagent.failed',
      'workflow.failed',
      'command.error',
    ]

    var DEFAULTS = {
      enabled: true,
      volume: 0.6,
      maxMs: 9000,
      guanyuAllFailures: false,
      indicator: true,
      indicatorMs: 4000,
      cues: {}, // id -> { on?: boolean, sound?: string, file?: string }
    }

    function buildDefaultCues() {
      var out = {}
      for (var i = 0; i < CUE_CATALOG.length; i++) {
        var c = CUE_CATALOG[i]
        // vol = 这一条自己的音量系数（1 = 100%，相对主音量再乘一层）
        out[c.id] = { on: c.on, sound: c.sound, file: '', vol: 1 }
      }
      return out
    }

    function normalize(raw) {
      var s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {})
      var defs = buildDefaultCues()
      var saved = s.cues && typeof s.cues === 'object' ? s.cues : {}
      var cues = {}
      // 逐条**字段级**合并：老配置里缺的字段（例如后来才加的 vol）自动继承默认值，
      // 只整条替换会让已保存过的用户永远拿不到新字段。
      for (var id in defs) {
        var sv = saved[id] && typeof saved[id] === 'object' ? saved[id] : {}
        cues[id] = Object.assign({}, defs[id], sv)
      }
      // 目录里已经删掉的 cue id 也保留，不抹掉用户的历史设置
      for (var sid in saved) {
        if (!cues[sid]) cues[sid] = saved[sid]
      }
      s.cues = cues
      s.volume = Math.max(0, Math.min(1, Number(s.volume)))
      if (!isFinite(s.volume)) s.volume = DEFAULTS.volume
      s.maxMs = Math.max(1500, Math.min(60000, Number(s.maxMs) || DEFAULTS.maxMs))
      return s
    }

    /* ══════════════════════════ 4. 设置 store ══════════════════════════ */

    var store = (function () {
      var state = null
      var listeners = new Set()
      var hostSeen = 0

      function load() {
        var local = null
        try {
          local = JSON.parse(window.localStorage.getItem(LS_KEY) || 'null')
        } catch (e) {
          local = null
        }
        state = normalize(local)
        emit()
        // 本地为空时，尝试从宿主拉一份（换浏览器/清缓存后仍能恢复）
        fetch(BASE + '/config')
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            if (!local && j && j.ok && j.config && j.config.__soundCues) {
              state = normalize(j.config.__soundCues)
              emit()
            }
            hostSeen = Date.now()
            emit()
          })
          .catch(function () {})
        // 载入后同步一次：老配置缺的新字段（如 vol）会就此补齐到 localStorage
        // 与宿主 state.json，避免磁盘上留着一份形状过时的设置。
        persist()
      }

      function emit() {
        listeners.forEach(function (fn) {
          try {
            fn()
          } catch (e) {
            /* ignore */
          }
        })
      }

      function persist() {
        try {
          window.localStorage.setItem(LS_KEY, JSON.stringify(state))
        } catch (e) {
          /* ignore */
        }
        // 落盘到宿主（跨浏览器/清缓存后可恢复）；失败无所谓
        fetch(BASE + '/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: { __soundCues: state } }),
        }).catch(function () {})
      }

      load()

      return {
        get: function () {
          return state
        },
        hostSeen: function () {
          return hostSeen
        },
        subscribe: function (fn) {
          listeners.add(fn)
          return function () {
            listeners.delete(fn)
          }
        },
        setCue: function (id, patch) {
          state.cues[id] = Object.assign({}, state.cues[id], patch)
          state = Object.assign({}, state, { cues: Object.assign({}, state.cues) })
          persist()
          emit()
        },
        set: function (patch) {
          state = Object.assign({}, state, patch)
          persist()
          emit()
        },
        reset: function () {
          state = normalize(null)
          persist()
          emit()
        },
      }
    })()

    function useStore() {
      var pair = useState(store.get())
      var setS = pair[1]
      useEffect(function () {
        return store.subscribe(function () {
          setS(store.get())
        })
      }, [])
      return pair[0]
    }

    /* ═══════════════════════ 5. 播放引擎（合成 / 自定义文件） ═══════════════════════ */

    var bufferCache = Object.create(null)
    var activeSources = []
    var fileIndex = []

    function stopAll() {
      for (var i = 0; i < activeSources.length; i++) {
        try {
          activeSources[i].stop(0)
        } catch (e) {
          /* ignore */
        }
      }
      activeSources = []
    }

    function playFileBuffer(buf, gainValue) {
      if (!ac || !buf) return 0
      var src = ac.createBufferSource()
      src.buffer = buf
      var g = ac.createGain()
      g.gain.value = gainValue * cueGain
      src.connect(g)
      g.connect(master)
      src.start(0)
      track(src)
      return buf.duration * 1000
    }

    /** 按「文件路径」播放用户音频；首次会 fetch + decode，之后走缓存。 */
    function playFile(path, volume, onStatus) {
      if (!ac) return
      var url = /^https?:|^\//.test(path) ? path : BASE + '/audio/' + encodeURIComponent(path)
      var cached = bufferCache[url]
      if (cached) {
        playFileBuffer(cached, volume)
        return
      }
      fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.arrayBuffer()
        })
        .then(function (ab) {
          return new Promise(function (ok, bad) {
            ac.decodeAudioData(ab, ok, bad)
          })
        })
        .then(function (buf) {
          bufferCache[url] = buf
          playFileBuffer(buf, volume)
        })
        .catch(function (err) {
          if (onStatus) onStatus('音频加载失败：' + (err && err.message ? err.message : err))
        })
    }

    function loadFileIndex() {
      return fetch(BASE + '/assets')
        .then(function (r) {
          return r.json()
        })
        .then(function (j) {
          if (j && j.ok && Array.isArray(j.files)) {
            fileIndex = j.files
            return fileIndex
          }
          return fileIndex
        })
        .catch(function () {
          return fileIndex
        })
    }

    var playToken = 0

    /**
     * 播放一个 cue。
     * @param id cue id
     * @param force true 时忽略开关与限流（设置页「试听」用）
     */
    function playCue(id, force) {
      var s = store.get()
      if (!force && !s.enabled) return
      var def = CUE_BY_ID[id]
      if (!def && !force) return

      var conf = (s.cues && s.cues[id]) || {}
      var on = conf.on == null ? (def ? def.on : true) : conf.on
      if (!force && !on) return

      var sound = conf.sound || (def ? def.sound : 'chime-soft')
      if (force && conf.file) sound = 'file'
      // 失败音统一用关羽之歌
      if (!force && s.guanyuAllFailures && FAILURE_CUES.indexOf(id) >= 0 && !conf.file) {
        sound = 'guanyu'
      }

      var now = Date.now()
      if (!force) {
        var last = lastPlay[id] || 0
        if (now - last < DEDUPE_MS) return
      }
      lastPlay[id] = now

      ensureAudio()
      if (!ac) return
      if (ac.state === 'suspended') ac.resume().catch(function () {})
      globalVolume = s.volume
      if (master) master.gain.value = s.volume
      // 逐条音量（0–1.5，默认 1.0），相对主音量再乘一层
      cueGain = conf.vol == null ? 1 : Math.max(0, Math.min(1.5, Number(conf.vol) || 0))
      if (cueGain === 0) return

      // 旋律/音频这类「长音」互斥：新的一响起，旧的立刻让位；
      // 短促的点按音则允许自然叠加，不会互相打断。
      var isLong =
        sound === 'file' || conf.file || sound === 'guanyu' || sound === 'guanyu-intro' ||
        sound === 'champion' || sound === 'fanfare'
      playToken += 1
      var token = playToken
      if (isLong) stopAll()

      if (sound === 'file' || conf.file) {
        if (!conf.file) return
        playFile(conf.file, 1.0, function (msg) {
          if (typeof console !== 'undefined') console.warn('[sound-cues] ' + msg)
        })
      } else {
        playBuiltin(sound)
      }

      // 「单条最长」：到点把这一个 cue 的声音掐掉，不碰后来的
      if (isLong && s.maxMs > 0) {
        setTimeout(function () {
          if (token === playToken) stopAll()
        }, s.maxMs)
      }
    }

    /* ══════════════════ 6. cue 拉取（对宿主长轮询，服务端 push） ══════════════════ */

    var cueBus = (function () {
      var listeners = new Set()
      var since = null
      var running = false
      var connected = false
      var lastError = ''

      function notify(item) {
        listeners.forEach(function (fn) {
          try {
            fn(item)
          } catch (e) {
            /* ignore */
          }
        })
      }

      function pump() {
        if (!running) return
        var url = BASE + '/events' + (since == null ? '' : '?since=' + since)
        fetch(url, { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.json()
          })
          .then(function (j) {
            connected = true
            lastError = ''
            if (j && typeof j.seq === 'number') {
              if (since == null) {
                // 首连：不要回放宿主队列里的历史 cue
                since = j.seq
              } else {
                var cues = j.cues || []
                for (var i = 0; i < cues.length; i++) notify(cues[i])
                since = j.seq
              }
            }
            pump()
          })
          .catch(function (err) {
            connected = false
            lastError = err && err.message ? err.message : String(err)
            setTimeout(pump, 2500)
          })
      }

      return {
        start: function () {
          if (running) return
          running = true
          pump()
        },
        stop: function () {
          running = false
        },
        subscribe: function (fn) {
          listeners.add(fn)
          return function () {
            listeners.delete(fn)
          }
        },
        /** 仅供自检：手投一条 cue（不经过宿主）。 */
        publish: function (item) {
          notify(item)
        },
        status: function () {
          return { connected: connected, error: lastError }
        },
      }
    })()

    /* ══════════════════════════ 7. 悬浮提示条 ══════════════════════════ */

    function soundLabel(id) {
      for (var i = 0; i < BUILTIN_SOUNDS.length; i++) {
        if (BUILTIN_SOUNDS[i].id === id) return BUILTIN_SOUNDS[i].label
      }
      return id
    }

    function OverlayIndicator() {
      var s = useStore()
      var pair = useState(null)
      var last = pair[0]
      var setLast = pair[1]
      var timer = useRef(null)

      useEffect(function () {
        return cueBus.subscribe(function (item) {
          setLast(item)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(function () {
            setLast(null)
          }, store.get().indicatorMs || 4000)
        })
      }, [])

      if (!s.indicator) return null
      if (!last) return null
      var def = CUE_BY_ID[last.cue]
      return createElement(
        'div',
        {
          className: 'dsc-toast',
          'data-cue': last.cue,
          title: def ? def.desc || def.label : last.cue,
        },
        createElement('span', { className: 'dsc-toast-ico' }, '🔊'),
        createElement(
          'span',
          { className: 'dsc-toast-body' },
          createElement('b', null, def ? def.label : last.cue),
          last.detail ? createElement('span', { className: 'dsc-toast-detail' }, last.detail) : null,
        ),
        createElement(
          'button',
          {
            className: 'dsc-toast-x',
            title: '静音全部提示音',
            onClick: function () {
              store.set({ enabled: false })
              setLast(null)
            },
          },
          '静音',
        ),
      )
    }

    /* ══════════════════════════ 8. 设置页 ══════════════════════════ */

    function SoundPicker(props) {
      var id = props.id
      var conf = props.conf
      var onStatus = props.onStatus
      var value = conf.file ? '__file__' : conf.sound || 'chime-soft'

      var opts = []
      for (var i = 0; i < BUILTIN_SOUNDS.length; i++) {
        opts.push(
          createElement('option', { key: BUILTIN_SOUNDS[i].id, value: BUILTIN_SOUNDS[i].id }, BUILTIN_SOUNDS[i].label),
        )
      }
      if (conf.file) {
        opts.unshift(createElement('option', { key: '__file__', value: '__file__' }, '📁 ' + conf.file))
      }
      var userFiles = fileIndex.filter(function (f) {
        return f.custom
      })
      for (var k = 0; k < userFiles.length; k++) {
        opts.push(
          createElement('option', { key: 'uf' + k, value: '__user__' + userFiles[k].path }, '📁 ' + userFiles[k].name),
        )
      }

      return createElement(
        'select',
        {
          className: 'dsc-sel',
          value: value,
          onChange: function (e) {
            var v = e.target.value
            if (v.indexOf('__user__') === 0) {
              store.setCue(id, { file: v.slice('__user__'.length), sound: '' })
            } else if (v === '__file__') {
              /* 保持当前 file */
            } else {
              store.setCue(id, { sound: v, file: '' })
            }
          },
        },
        opts,
      )
    }

    function CueRow(props) {
      var c = props.cue
      var s = useStore()
      var conf = s.cues[c.id] || {}
      var on = conf.on == null ? c.on : conf.on
      var pair = useState('')
      var status = pair[0]
      var setStatus = pair[1]

      return createElement(
        'div',
        { className: 'dsc-row' + (on ? '' : ' dsc-row-off') },
        createElement('input', {
          type: 'checkbox',
          className: 'dsc-ck',
          checked: !!on,
          title: '开关这条提示音',
          onChange: function (e) {
            store.setCue(c.id, { on: e.target.checked })
          },
        }),
        createElement(
          'div',
          { className: 'dsc-row-main' },
          createElement('div', { className: 'dsc-row-label' }, c.label),
          createElement('div', { className: 'dsc-row-id' }, c.id + (c.desc ? ' · ' + c.desc : '')),
        ),
        createElement(SoundPicker, { id: c.id, conf: conf, onStatus: setStatus }),
        createElement(
          'span',
          { className: 'dsc-vol', title: '这一条自己的音量（相对主音量再乘一层，可到 150%）' },
          createElement('input', {
            type: 'range',
            min: 0,
            max: 150,
            step: 5,
            value: Math.round((conf.vol == null ? 1 : conf.vol) * 100),
            onChange: function (e) {
              store.setCue(c.id, { vol: Number(e.target.value) / 100 })
            },
          }),
          createElement('span', { className: 'dsc-vol-v' }, Math.round((conf.vol == null ? 1 : conf.vol) * 100) + '%'),
        ),
        createElement(
          'button',
          {
            className: 'dsc-btn dsc-btn-sm',
            title: '试听',
            onClick: function () {
              playCue(c.id, true)
            },
          },
          '▶',
        ),
        status ? createElement('div', { className: 'dsc-row-err' }, status) : null,
      )
    }

    function SettingsPanel() {
      var s = useStore()
      var pair = useState({ connected: false, error: '' })
      var cx = pair[0]
      var setCx = pair[1]
      var pair2 = useState('')
      var uploadMsg = pair2[0]
      var setUploadMsg = pair2[1]
      var pair3 = useState(fileIndex)
      var files = pair3[0]
      var setFiles = pair3[1]
      // 默认展开第一组（回合）—— 最常用的那几条一开始就看得见
      var pair4 = useState(CUE_CATALOG[0].group)
      var openGroup = pair4[0]
      var setOpenGroup = pair4[1]
      var fileInput = useRef(null)

      useEffect(function () {
        loadFileIndex().then(function (f) {
          setFiles(f.slice())
        })
        var t = setInterval(function () {
          setCx(cueBus.status())
        }, 1500)
        setCx(cueBus.status())
        return function () {
          clearInterval(t)
        }
      }, [])

      var groups = []
      var index = {}
      for (var i = 0; i < CUE_CATALOG.length; i++) {
        var c = CUE_CATALOG[i]
        if (!index[c.group]) {
          index[c.group] = []
          groups.push(c.group)
        }
        index[c.group].push(c)
      }

      function doUpload(file) {
        if (!file) return
        setUploadMsg('上传中：' + file.name + ' …')
        fetch(BASE + '/upload?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            if (j && j.ok) {
              setUploadMsg('已保存：' + j.name + '（' + Math.round(j.size / 1024) + ' KB）')
              setFiles((j.files || []).slice())
            } else {
              setUploadMsg('上传失败：' + ((j && j.error) || '未知错误'))
            }
          })
          .catch(function (err) {
            setUploadMsg('上传失败：' + (err && err.message ? err.message : err))
          })
      }

      var webAudioOK = typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)

      return createElement(
        'div',
        { className: 'dsc-panel' },

        /* ── 总开关 ── */
        createElement(
          'div',
          { className: 'dsc-head' },
          createElement(
            'label',
            { className: 'dsc-switch' },
            createElement('input', {
              type: 'checkbox',
              checked: !!s.enabled,
              onChange: function (e) {
                store.set({ enabled: e.target.checked })
              },
            }),
            createElement('span', null, s.enabled ? '提示音已开启' : '提示音已关闭'),
          ),
          createElement(
            'button',
            {
              className: 'dsc-btn',
              onClick: function () {
                playCue('goal.completed', true)
              },
            },
            '🎉 试听「目标达成」',
          ),
          createElement(
            'button',
            {
              className: 'dsc-btn',
              onClick: function () {
                playCue('turn.error', true)
              },
            },
            '🎻 试听「任务失败」',
          ),
        ),

        /* ── 环境诊断 ── */
        createElement(
          'div',
          { className: 'dsc-diag' },
          createElement('span', { className: cx.connected ? 'dsc-ok' : 'dsc-bad' }, cx.connected ? '● 已连上宿主' : '● 未连上宿主'),
          cx.error ? createElement('span', { className: 'dsc-bad' }, ' ' + cx.error) : null,
          createElement('span', null, ' · WebAudio ' + (webAudioOK ? '可用' : '不可用')),
          createElement('span', null, ' · 音频文件 ' + files.length + ' 个'),
          createElement('span', { className: 'dsc-dim' }, ' · ' + PLUGIN_NAME + ' v' + PLUGIN_VERSION),
        ),

        /* ── 音量 / 时长 ── */
        createElement(
          'div',
          { className: 'dsc-field' },
          createElement('span', { className: 'dsc-field-k' }, '音量'),
          createElement('input', {
            type: 'range',
            min: 0,
            max: 100,
            value: Math.round(s.volume * 100),
            onChange: function (e) {
              store.set({ volume: Number(e.target.value) / 100 })
            },
          }),
          createElement('span', { className: 'dsc-field-v' }, Math.round(s.volume * 100) + '%'),
        ),
        createElement(
          'div',
          { className: 'dsc-field' },
          createElement('span', { className: 'dsc-field-k' }, '单条最长'),
          createElement('input', {
            type: 'range',
            min: 1500,
            max: 30000,
            step: 500,
            value: s.maxMs,
            onChange: function (e) {
              store.set({ maxMs: Number(e.target.value) })
            },
          }),
          createElement('span', { className: 'dsc-field-v' }, Math.round(s.maxMs / 1000) + ' 秒'),
        ),

        /* ── 行为开关 ── */
        createElement(
          'label',
          { className: 'dsc-opt' },
          createElement('input', {
            type: 'checkbox',
            checked: !!s.guanyuAllFailures,
            onChange: function (e) {
              store.set({ guanyuAllFailures: e.target.checked })
            },
          }),
          createElement('span', null, '所有「失败」都用关羽之歌（回合失败 / 工具失败 / 作业失败 / 目标受阻）'),
        ),
        createElement(
          'label',
          { className: 'dsc-opt' },
          createElement('input', {
            type: 'checkbox',
            checked: !!s.indicator,
            onChange: function (e) {
              store.set({ indicator: e.target.checked })
            },
          }),
          createElement('span', null, '右下角显示提示条（上一条提示音的名称）'),
        ),

        /* ── 自定义音效 ── */
        createElement('hr', { className: 'dsc-hr' }),
        createElement(
          'div',
          { className: 'dsc-sec-head' },
          createElement('b', null, '自定义音效'),
          createElement(
            'span',
            { className: 'dsc-dim' },
            '上传你自己的音频（mp3 / wav / ogg / m4a / flac），然后在上方任意一条 cue 的下拉里选它',
          ),
        ),
        createElement(
          'div',
          { className: 'dsc-upload' },
          createElement('input', {
            ref: fileInput,
            type: 'file',
            accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus',
            multiple: true,
            onChange: function (e) {
              var list = e.target.files || []
              for (var i = 0; i < list.length; i++) doUpload(list[i])
              e.target.value = ''
            },
          }),
          uploadMsg ? createElement('span', { className: 'dsc-dim' }, uploadMsg) : null,
        ),
        files.length
          ? createElement(
              'div',
              { className: 'dsc-files' },
              files.map(function (f) {
                return createElement(
                  'div',
                  { key: f.path, className: 'dsc-file' },
                  createElement('span', null, (f.custom ? '📁 ' : '📦 ') + f.name),
                  createElement('span', { className: 'dsc-dim' }, ' ' + Math.round(f.size / 1024) + ' KB'),
                  createElement(
                    'button',
                    {
                      className: 'dsc-btn dsc-btn-sm',
                      onClick: function () {
                        playFile(f.path, 1.0, setUploadMsg)
                      },
                    },
                    '▶',
                  ),
                  f.custom
                    ? createElement(
                        'button',
                        {
                          className: 'dsc-btn dsc-btn-sm dsc-danger',
                          title: '删除',
                          onClick: function () {
                            fetch(BASE + '/delete/' + encodeURIComponent(f.name))
                              .then(function (r) {
                                return r.json()
                              })
                              .then(function () {
                                return loadFileIndex()
                              })
                              .then(function (all) {
                                setFiles(all.slice())
                              })
                              .catch(function () {})
                          },
                        },
                        '×',
                      )
                    : null,
                )
              }),
            )
          : null,

        /* ── cue 总表 ── */
        createElement('hr', { className: 'dsc-hr' }),
        createElement(
          'div',
          { className: 'dsc-sec-head' },
          createElement('b', null, '提示音总表'),
          createElement('span', { className: 'dsc-dim' }, '共 ' + CUE_CATALOG.length + ' 条 · 勾选启用 · 下拉选音色 · 滑杆单独调这一条的音量 · ▶ 试听'),
        ),
        groups.map(function (g) {
          var open = openGroup === g
          return createElement(
            'div',
            { key: g, className: 'dsc-group' },
            createElement(
              'button',
              {
                className: 'dsc-group-head',
                onClick: function () {
                  setOpenGroup(open ? '' : g)
                },
              },
              createElement('span', { className: 'dsc-chev' }, open ? '▾' : '▸'),
              createElement('b', null, g),
              createElement('span', { className: 'dsc-dim' }, ' ' + index[g].length + ' 条'),
            ),
            open
              ? createElement(
                  'div',
                  { className: 'dsc-group-body' },
                  index[g].map(function (c) {
                    return createElement(CueRow, { key: c.id, cue: c })
                  }),
                )
              : null,
          )
        }),

        /* ── 恢复默认 ── */
        createElement('hr', { className: 'dsc-hr' }),
        createElement(
          'div',
          { className: 'dsc-foot' },
          createElement(
            'button',
            {
              className: 'dsc-btn',
              onClick: function () {
                store.reset()
              },
            },
            '恢复默认设置',
          ),
          createElement(
            'span',
            { className: 'dsc-dim' },
            '注：「关羽之歌」按《江上行》（王健词 / 谷建芬曲）简谱合成，「We Are the Champions」主题按公开 MIDI 旋律声部合成——都是合成演奏，不是原版录音；想听原曲请上传音频文件后绑定。',
          ),
        ),
      )
    }

    /* ══════════════════════════ 通用设置页快捷行 ══════════════════════════ */

    function GeneralRow() {
      var s = useStore()
      return createElement(
        'label',
        { className: 'dsc-general-row' },
        createElement('input', {
          type: 'checkbox',
          checked: !!s.enabled,
          onChange: function (e) {
            store.set({ enabled: e.target.checked })
          },
        }),
        createElement('span', null, '提示音'),
        createElement('span', { className: 'dsc-dim' }, '在「设置 → 提示音」里逐条配置'),
      )
    }

    /* ══════════════════════════ 样式 ══════════════════════════ */

    var CSS_TEXT = [
      '.dsc-panel{display:flex;flex-direction:column;gap:10px;max-width:760px;font-size:13px;line-height:1.6}',
      '.dsc-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dsc-switch{display:flex;align-items:center;gap:7px;font-weight:600;margin-right:auto;cursor:pointer}',
      '.dsc-diag{display:flex;flex-wrap:wrap;gap:4px;font-size:12px;opacity:.85}',
      '.dsc-ok{color:#3fb950}',
      '.dsc-bad{color:#f85149}',
      '.dsc-dim{opacity:.6;font-weight:400}',
      '.dsc-field{display:flex;align-items:center;gap:10px}',
      '.dsc-field-k{width:78px;flex:none}',
      '.dsc-field input[type=range]{flex:1;max-width:340px}',
      '.dsc-field-v{width:60px;text-align:right;opacity:.75;font-variant-numeric:tabular-nums}',
      '.dsc-opt{display:flex;align-items:flex-start;gap:8px;cursor:pointer}',
      '.dsc-opt input{margin-top:4px;flex:none}',
      '.dsc-hr{border:0;border-top:1px solid currentColor;opacity:.12;margin:6px 0}',
      '.dsc-sec-head{display:flex;flex-direction:column;gap:2px}',
      '.dsc-group{border:1px solid currentColor;border-color:color-mix(in srgb, currentColor 16%, transparent);border-radius:8px;overflow:hidden}',
      '.dsc-group-head{display:flex;align-items:center;gap:7px;width:100%;background:none;border:0;padding:7px 10px;font:inherit;color:inherit;text-align:left;cursor:pointer}',
      '.dsc-group-head:hover{background:color-mix(in srgb, currentColor 7%, transparent)}',
      '.dsc-chev{font-size:10px;opacity:.6;width:10px}',
      '.dsc-group-body{padding:4px 8px 8px}',
      '.dsc-row{display:flex;align-items:center;gap:8px;padding:4px 2px;border-bottom:1px solid color-mix(in srgb, currentColor 8%, transparent);flex-wrap:wrap}',
      '.dsc-row:last-child{border-bottom:0}',
      '.dsc-row-off{opacity:.5}',
      '.dsc-ck{flex:none}',
      '.dsc-row-main{min-width:190px;flex:1}',
      '.dsc-row-label{font-weight:500}',
      '.dsc-row-id{font-size:11px;opacity:.55}',
      '.dsc-row-err{flex-basis:100%;font-size:11px;color:#f85149}',
      '.dsc-sel{max-width:260px;font:inherit;padding:2px 4px;border-radius:5px;border:1px solid color-mix(in srgb, currentColor 25%, transparent);background:color-mix(in srgb, currentColor 5%, transparent);color:inherit}',
      '.dsc-vol{display:flex;align-items:center;gap:5px;flex:none}',
      '.dsc-vol input[type=range]{width:74px}',
      '.dsc-vol-v{width:40px;text-align:right;font-size:11px;opacity:.7;font-variant-numeric:tabular-nums}',
      '.dsc-btn{font:inherit;padding:4px 10px;border-radius:6px;cursor:pointer;border:1px solid color-mix(in srgb, currentColor 25%, transparent);background:color-mix(in srgb, currentColor 6%, transparent);color:inherit}',
      '.dsc-btn:hover{background:color-mix(in srgb, currentColor 14%, transparent)}',
      '.dsc-btn-sm{padding:1px 7px}',
      '.dsc-danger:hover{color:#f85149}',
      '.dsc-upload{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsc-files{display:flex;flex-direction:column;gap:3px;max-height:190px;overflow:auto}',
      '.dsc-file{display:flex;align-items:center;gap:7px;font-size:12px}',
      '.dsc-foot{display:flex;flex-direction:column;gap:7px;align-items:flex-start}',
      '.dsc-general-row{display:flex;align-items:center;gap:8px;cursor:pointer}',
      /* 悬浮提示条：挂在 shell.overlay 上 —— 该层点穿透，条目自己开 pointer-events */
      '.dsc-toast{position:absolute;right:18px;bottom:18px;display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:10px;',
      'background:var(--dsw-alias-toast-bg,rgba(24,24,27,.94));color:var(--dsw-alias-label-primary,#f4f4f5);',
      'box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.45));',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));',
      'font:var(--dsw-font-s,12.5px)/1.4 var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);',
      'pointer-events:auto;z-index:60;max-width:340px;animation:dsc-in .18s ease-out}',
      '@media (prefers-reduced-motion:reduce){.dsc-toast{animation:none}}',
      '@keyframes dsc-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '.dsc-toast-ico{font-size:15px}',
      '.dsc-toast-body{display:flex;flex-direction:column;min-width:0}',
      '.dsc-toast-detail{opacity:.7;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsc-toast-x{font:inherit;font-size:11px;padding:2px 7px;border-radius:6px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.25));background:transparent;color:inherit}',
      '.dsc-toast-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12))}',
    ].join('')

    function injectCss() {
      try {
        if (document.getElementById('dsc-style')) return
        var el = document.createElement('style')
        el.id = 'dsc-style'
        // data-plugin 让 client-modules 的 HMR 记账认领这个 <style>
        el.setAttribute('data-plugin', PLUGIN_NAME)
        el.setAttribute('data-plugin-css', PLUGIN_NAME + '/panel.css')
        el.textContent = CSS_TEXT
        ;(document.head || document.documentElement).appendChild(el)
      } catch (e) {
        /* ignore */
      }
    }

    /* ══════════════════════════ 插件导出 ══════════════════════════ */

    var inject = ['slots']

    function apply(ctx) {
      injectCss()
      ensureAudio()

      // cue 到达 → 播声音（订阅最先装，避免漏掉启动瞬间的 cue）
      try {
        ctx.effect(function () {
          var off = cueBus.subscribe(function (item) {
            playCue(item.cue, false)
          })
          cueBus.start()
          return off
        })
      } catch (e) {
        /* ignore */
      }

      var slotOk = {}
      function record(name, fn) {
        try {
          fn()
          slotOk[name] = 'ok'
        } catch (e) {
          slotOk[name] = 'ERR: ' + (e && e.message ? e.message : e)
        }
      }

      // ① 主设置页
      record('settings', function () {
        ctx.effect(function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register(
              { name: 'settings.section', id: PLUGIN_NAME, order: 60, label: function () { return '提示音' } },
              SettingsPanel,
            )
          })
        }, 'sound-cues: settings section')
      })

      // ② 通用设置里的快捷开关（该 slot 由 ui-settings-general 运行时声明，缺席则自动跳过）
      record('general', function () {
        ctx.effect(function () {
          return ctx.slots.inject('settings.general.item', function () {
            return ctx.slots.register(
              { name: 'settings.general.item', id: 'sound-cues', order: 70 },
              GeneralRow,
            )
          })
        }, 'sound-cues: general row')
      })

      // ③ 右下角提示条（list slot，additive；overlay 层本身点穿透，条目需自己开 pointer-events）
      record('overlay', function () {
        ctx.effect(function () {
          return ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register(
              { name: 'shell.overlay', id: 'sound-cues-toast', order: 90 },
              OverlayIndicator,
            )
          })
        }, 'sound-cues: overlay toast')
      })

      // ④ 「有人向你提问」——宿主侧没有 question 事件（只有浏览器线帧），
      //    所以这条只能从浏览器侧的会话列表观察：pendingInteraction === 'question'。
      //    用 ctx.get 而不是直接 ctx.sessions —— 服务守卫会因为没 inject 而抛。
      try {
        var sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
          record('questionWatcher', function () {
            ctx.effect(function () {
              var seen = {}
              var read = function () {
                var st = sessions.list.getSnapshot()
                if (!st || !Array.isArray(st.ids)) return
                var next = {}
                for (var i = 0; i < st.ids.length; i++) {
                  var id = st.ids[i]
                  var row = st.byId ? st.byId[id] : null
                  if (!row) continue
                  var kind = row.pendingInteraction || ''
                  next[id] = kind
                  if (kind === 'question' && seen[id] !== 'question') {
                    playCue('question.asked', false)
                  }
                }
                seen = next
              }
              read()
              return sessions.list.subscribe(read)
            }, 'sound-cues: pending-question watcher')
          })
        }
      } catch (e) {
        /* ignore */
      }

      // 卸载时收干净：停轮询、停声、摘样式
      try {
        ctx.effect(function () {
          return function () {
            cueBus.stop()
            stopAll()
            var el = document.getElementById('dsc-style')
            if (el && el.parentNode) el.parentNode.removeChild(el)
          }
        })
      } catch (e) {
        /* ignore */
      }

      if (typeof console !== 'undefined') {
        console.info('[sound-cues] client applied', slotOk)
      }

      // 给宿主打个「网页半边起来了」的心跳，供 /sound-cues/state 确证
      try {
        fetch(BASE + '/hello', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: PLUGIN_VERSION, slots: slotOk }),
        }).catch(function () {})
      } catch (e) {
        /* ignore */
      }
    }

    exports.inject = inject
    exports.apply = apply
    exports.__internal = {
      CUE_CATALOG: CUE_CATALOG,
      BUILTIN_SOUNDS: BUILTIN_SOUNDS,
      MELODY_GUANYU_CLIMAX: MELODY_GUANYU_CLIMAX,
      MELODY_GUANYU_INTRO: MELODY_GUANYU_INTRO,
      MELODY_CHAMPION: MELODY_CHAMPION,
      store: store,
      normalize: normalize,
      cueBus: cueBus,
      playCue: playCue,
      loadFileIndex: loadFileIndex,
      fileIndex: function () {
        return fileIndex
      },
      slotStatus: function () {
        return slotOk
      },
    }
    return module.exports
  },
})
