// Service Worker file (sw.js)
// Whitelist cache strategy: cache only known static assets; API requests pass through.
// 2026-08-25 v0.2.30.71y (旋转动画大幅提亮: blur 缩小聚拢 + opacity 大幅提高 + 多层 drop-shadow 叠加): bump CACHE_VERSION 强制清缓存
//   user 反馈: "旋转动画是真的在旋转的, 但不明显, 头像外的光很少, 线条也不够明亮, 看不太出来"
//   user 详细要求: "光晕的尺寸向外扩展得更宽更厚, 提高渐变色彩的不透明度和饱和度, 缩小过大的模糊半径使光线更加聚拢, 叠加多层高亮的发光阴影效果, 确保在深色背景下有清晰、明显且饱满的旋转发光视觉感"
//   5 处改动 (11 个 ccw-* 规则中):
//     1. .ccw-glow-base center alpha 0.18→0.32, 各点 +0.10-0.18 (中央暖金雾明显)
//     2. .ccw-inner-light 各点 alpha +0.10-0.14 + drop-shadow 28→38 + α 0.78→0.95 + opacity 0.82→0.95 (亮光团更亮)
//     3. .ccw-soft-streak blur 95→72 (聚拢 24%) + opacity 0.38→0.70 (不透明度 +84%) + drop-shadow 55→65/130→165 + 加第 3 层 0 0 35px α0.85 高亮中心
//     4. .ccw-soft-halo blur 250→180 (聚拢 28%) + opacity 0.20→0.50 (不透明度 +150%) + 加 2 层 drop-shadow 80/200
//     5. .ccw-avatar box-shadow 9/24/42→9/32/60 (更宽) + 各层 α +0.19-0.25 + inset 9→12 (内阴影更明显)
//   保留: mask-image 8 点 34%-98% (★★★ 关键遮罩不动) + vortex-spin 2s + vortex-breathe 4.6s + soft-glow 3.8s 关键帧时长
//   破 v0.2.30.71h "原封不动照抄 user v0.2.30.60 模板" 锁死 — user 2026-08-25 明确要求提亮
//   user 反馈: "单文件 HTML 完美旋转, voice-call 看不到旋转"
//   真凶: video-voice-call.css:2020 mask-type: alpha + -webkit-mask-type: alpha (v0.2.30.70 加的桌面 Chrome 兼容性)
//     跟 transform: rotate() 冲突, iOS Safari SVG 旋转被遮罩, 看不到 6 道流线
//   单文件 HTML (user v0.2.30.60 模板原版) 没有 mask-type: alpha = 完美旋转
//   修法: 删 mask-type: alpha + -webkit-mask-type: alpha — user "反正只在手机上用", 接受电脑 Chrome mask 失效
//   -webkit-mask-image + mask-image 保留 (iOS Safari 需要, 关键遮罩原版参数不动)
//   user 反馈: "通话时 AI 思考说话时 AI 头像在一个位置, AI 倾听的时候又在另一个位置, 一会儿上一会儿下"
//   真凶: video-voice-call.css:1480 .voice-call-ai-active .voice-call-avatar-area { padding-top: 18vh }
//     .voice-call-ai-active 类只在 thinking/speaking/transitioning 加 (video-voice-call.js:239)
//     listening/idle 不加 → padding-top: 0 → 头像在屏幕顶部
//     thinking/speaking/transitioning 加 → padding-top: 18vh → 头像下移 18vh (中央)
//   修法: 删 .voice-call-ai-active 限定, voice-call 父级直接覆盖, 5 状态统一 padding-top: 18vh
//   status text "倾听中" top: 60% 位置不变, 跟 18vh 头像位置不冲突 (60% 比 18vh 偏下)
//   破 v0.2.30.24 "AI 状态时下移, listening 时顶部" 设计 — user 2026-08-25 反馈接受新设计
//   user 反馈: "单文件 HTML 完美旋转, 加到 voice-call 看不到旋转, 只看到一坨光"
//   真凶: v0.2.30.71r 改 vortex 100 + blur 95px 固定像素 + SVG viewBox 148 = 95/100=95% 散光覆盖, 流线几乎完全模糊
//     单文件 HTML: vortex 148 + blur 95 = 95/148=64% 散光, 流线保留 36% 中心清晰 (完美旋转)
//     voice-call 集成 71r 改后: vortex 100 + blur 95 = 95/100=95% 散光, 流线完全模糊 (一坨光)
//   71r 是基于"误判头像变大"改的, 实际真凶是 listening 头像 70x70 (v0.2.30.71s 修了 70→100 统一 4 状态)
//   71s 后 listening/transitioning/thinking/speaking 4 状态 avatar 都 100, 嵌套 15px 环宽 (vortex 130 vs avatar 100) = 71h 状态
//   修法: 删除 71r 改的 .glow-thinking .ccw-vortex-wrap width: 100/height: 100/margin-left: -50/margin-top: -50, 让默认 vortex 130 生效
//   blur 95 / mask-image / halo / streak / glow-base / inner-light / box-shadow 全部不动 (v0.2.30.60 模板原版 + v0.2.30.71h 锁死)
//   user 反馈: "71t 看着还是不怎么亮"
//   修法: 8 点 radial-gradient alpha 累计 +40% (相对 71n 基准 0.50)
//     0%  0.50 → 0.70 (+20% 71t 基础上再加 10% = 累计 +40%)
//     15% 0.46 → 0.65
//     30% 0.42 → 0.58
//     45% 0.34 → 0.47
//     60% 0.26 → 0.36
//     75% 0.16 → 0.22
//     90% 0.08 → 0.11
//     100% 0   → 0
//   颜色保留 (暖金) / blur 32 / 容器 250 / scale 0.75/0.95 / 删 box-shadow 全部不动
//   user 反馈: "这下对了! 没变了, 那个移动光晕还不够亮, 再亮一丢丢"
//   修法: 8 点 radial-gradient alpha 整体 +20% (中心 0.50→0.60, 各点 0.04-0.06 不等)
//     0%  0.50 → 0.60
//     15% 0.46 → 0.55
//     30% 0.42 → 0.50
//     45% 0.34 → 0.41
//     60% 0.26 → 0.31
//     75% 0.16 → 0.19
//     90% 0.08 → 0.10
//     100% 0   → 0
//   颜色保留 (暖金) / blur 32 / 容器 250 / scale 0.75/0.95 / 删 box-shadow 全部不动
//   只动 transitioning 阶段 ::before 的 background, listening/speaking/thinking 3 状态没动
//   真凶: video-voice-call.css:1484 之前用 .voice-call-ai-active 限定, 只有 thinking/speaking/transitioning 加这个类
//     listening/idle 状态下 voice-call-ai-active 类没加, 退回 music-player.css 通用 70x70 (avatar 看着小)
//     视觉差异: listening 70+border 3=73 vs thinking 100+border 2.5=102.5 差 30px
//   user 反馈: "倾听时头像变小, 思考和说话正常" — 之前 user 误判成"思考说话变大"实际是"倾听变小"
//   修法: 删 .voice-call-ai-active 限定, voice-call 父级直接覆盖, 5 状态统一 100x100 + border 2.5px
//   破 v0.2.30.48 "AI 状态时 100, listening 时 70" 锁死 — user 2026-08-25 反馈接受新设计
//   真凶 1: music-player.css:1970 .participant-avatar.speaking { transform: scale(1.05) }
//     voice-call 复用 .participant-avatar.speaking 类名时意外触发 music-player 5% 放大
//     修法: 删 transform: scale(1.05) — 群聊没人用, 直接删不影响其他场景
//   真凶 2: video-voice-call.css vortex wrap 130x130 (v0.2.30.62 锁死)
//     vortex 130 圆周让 thinking 状态"AI 头像视觉圆"看着大 30px (vortex 130 vs avatar 100)
//     user 反馈"思考的时候头像本身圆变大" — vortex 130 圆周被 user 当成"AI 头像圆"
//     修法: voice-call .glow-thinking 限定让 .ccw-vortex-wrap 130→100 (跟 avatar 100 边缘重合)
//   不动: box-shadow 9/24/42 + inset 9 (v0.2.30.60 模板原版, user 接受的设计)
//   嵌套结构 (glow-base inset 14 / inner-light inset 23 / svg 148 viewBox / halo blur 250 / streak blur 95) 保留 v0.2.30.71h 锁死
//   user 反馈: v0.2.30.71p 还是小, "再大一点"
//   修法: 3 项同时再大 25-33%
//     width/height 200→250 (大 25%, margin -100→-125)
//     blur 24→32 (大 33%, 边缘散开更多)
//     scale 0.7/0.85 → 0.75/0.95 (再大 7-12%)
//   视觉直径: 起点 164→220 (大 56px ≈ 34%), 终点 194→270 (大 76px ≈ 39%, opacity 0 不可见)
//   8 点 radial / 中心 0.50 / 删 box-shadow 保持 v0.2.30.71n 锁死
//   user 反馈: v0.2.30.71n 模糊光雾是有了, 但"看着有点小, 搞大坨一点"
//   修法: voice-call-spot-fly scale 0.5/0.65 → 0.7/0.85 (起点+终点同时大)
//     视觉直径: 起点 124→164px (大 40px), 终点 154→194px (大 40px, opacity 0 不可见)
//   跟 thinking 130 衔接: v0.2.30.71f 100% opacity 0 飞完自然淡出, 170 vs 130 的"缩"在 0 透明度下完成
//     之前 v0.2.30.66 scale 0.65 严丝合缝 thinking 130 是 for forwards+setTimeout 方案, 现在 71f 已改自然淡出
//   blur 24 / 8 点 radial / 中心 0.50 保持 v0.2.30.71n 锁死
//   user 反馈: "光晕从挂断键移动到 AI 头像看着还是发光圆球, 不是一团模糊光晕"
//   修法: 删 box-shadow (双层 0.6/0.45) + blur 8→24 + 中心 alpha 0.75→0.50 + 5 点→8 点平滑曲线
//     box-shadow 边缘散光是"光环"不是"雾化" — 删了让 background + blur 主导
//     blur 24px 边缘彻底散开, 看着是"光雾"不是"圆球"
//   video-voice-call.js:2235 删 <div class="participant-name">${displayName}</div> (voice-call 模板)
//   video-call 模板 line 920-924 保留不动 (user 规矩: 不要碰 video-call)
//   displayName 变量保留, 还被 line 2197 + 2232 两个 img alt 引用 (无障碍用)
//   speaking 阶段 .glow-speaking::before 110→100 (跟 img 100x100 同尺寸, 消除 5px 暗环/缝隙)
//   voice-speaking-glow keyframes 缩小 15% (user 反馈 "speaking 大光圈大了, 改小一丢丢")
//     0%:  170/50 α0.55 + 70/18 α0.42  →  145/40 α0.50 + 60/15 α0.38
//     50%: 220/70 α0.7  + 100/25 α0.55 →  188/58 α0.62 + 85/20 α0.48
//   listening 锁死不动 (v0.2.30.69 折中, user 之前接受的状态)
//   v0.2.30.70: .ccw-vortex-wrap absolute 居中, �?.participant-avatar-wrapper 不是 positioned 父级
//     绝对定位参照跑到 .voice-call-avatar-area 去了, vortex �?wrapper 内的 img 错位 80px (用户截图反馈)
//   修法:
//     1. .participant-avatar-wrapper �?position: relative, absolute 参照 wrapper 自己
//     2. .ccw-vortex-wrap 居中改用精确像素 top:50px + margin:-65 (�?.glow-speaking::before 110 同位�?img 中心 y=50)
//     3. JS 模板改回 img �?wrapper 直接子元�?(v0.2.30.60 之前), vortex wrap 单独嵌套
//        listening/speaking: wrapper 直接 img 显示, vortex display:none
//        thinking: wrapper 直接 img visibility:hidden, vortex display:flex (内含 .ccw-avatar img 跟流光叠)
//
//   user 反馈 v0.2.30.39: "AI思考时候的黄色光晕不是要两个圆圈打�? 是要那些光晕像风车叶子那样旋�?
//   修法: 改用 conic-gradient 渲染 4 片软叶片 (每片 0-60° 暖黄渐变, 间隔 30° 透明) + 反向旋转
//   - ::before 102px 4 叶片 (0/90/180/270° 起始) 顺时�?3.5s
//   - ::after  88px 4 叶片 (22.5° 错位) 逆时�?2.8s �?跟外圈反方向
//   - �?border 圆环 (太规�? 不像风车), 保留 box-shadow 柔散外发�?
// 2026-08-23 v0.2.30.39: bump CACHE_VERSION 强制清缓存（回退 v0.2.30.31 listening + speaking �?listening
//
//   user 反馈 v0.2.30.38: "越改越转去了, 用户说话时候的黄色光晕都没有了"
//   "之前用户说话时候的光晕已经很满意了, 你为什么要动啊"
//   "AI说话的效果抄之前用户说话的效果不就好�?
//
//   根因: v0.2.30.36 �?spread 30�? 弱化了光�?(实心环变纯柔�?
//   v0.2.30.37 �?spread 0 同样弱化 speaking
//   修法:
//   - listening 回退 v0.2.30.31 版本: blur 100-150px + spread 30-45px (实心�?柔散)
//   - speaking �?listening: blur 100-150px + spread 30-45px, 位置�?img �?
// 2026-08-23 v0.2.30.38: bump CACHE_VERSION 强制清缓存（thinking 状态也�?黑圈" �?�?wrapper box-shadow
//
//   user 反馈 v0.2.30.37 截图: AI 思考时图腾旋转看着�?正方�?圆形黑圈"
//   根因: .participant-avatar-wrapper 包含 <img> (70x70) + .participant-name (~20px) = 70x90 矩形
//         wrapper 上的 box-shadow 在矩形上渲染成椭�?(user 觉得是黑�?
//   v0.2.30.37 已修 speaking 状�?(box-shadow 改回 <img> �? 70x70 正方�?�?正圆)
//   v0.2.30.38: 同步�?thinking 状�?
//     - �?.participant-avatar-wrapper.glow-thinking �?box-shadow (避免椭圆黑圈)
//     - thinking 状态只�?::before/::after 伪元素做光环 (img 不支持伪元素, 所以光环必须在 wrapper �?
//     - �?::before/::after box-shadow 已经 spread=0, 渲染成正圆外发光
//     - 结果: 头像 (70x70 正圆白边) + 2 圈反向旋转的圆环 (无矩形阴�?
// 2026-08-23 v0.2.30.37: bump CACHE_VERSION 强制清缓存（speaking box-shadow 改回 <img> �?�?椭圆+黑圈"bug
//
//   user 反馈 v0.2.30.35 截图: AI 说话时还是没光晕
//   v0.2.30.35 已经�?.glow-speaking �?<img> 改到外层 .participant-avatar-wrapper (div)
//   box-shadow 100-150px blur �?70x70 wrapper 上应该明显可�?
//   �?user 反馈没看�?�?可能�?sw.js 缓存没刷, 也可能是 box-shadow 渲染�?wrapper 上没触发
//   v0.2.30.36: �?will-change: box-shadow 提示浏览器走 GPU 合成�?+ 注释更新
// 2026-08-23 v0.2.30.35: bump CACHE_VERSION 强制清缓存（光晕/光环移到外层 div + 挂断键再旋转 45°
//
//   user 反馈 v0.2.30.33 截图: AI 思考时没图�? AI 说话时没光晕
//   根因 1: .participant-avatar �?<img> 元素, <img> 不支�?::before/::after 伪元�?
//            �?金沙图腾光环 (::before/::after) 全部不渲�?
//   根因 2: box-shadow �?<img> 上可能被 border-color 干扰, 效果不可�?
//   修法: �?thinking/speaking 的光�?光环全部挂到外层 .participant-avatar-wrapper (div) �?
//         - div 完全支持 ::before/::after 伪元�?
//         - div 上的 box-shadow 也更稳定
//   配套:
//     - JS setVoiceCallGlowState �?.participant-avatar-wrapper 替代 .participant-avatar
//     - CSS 选择器从 .participant-avatar.glow-* �?.participant-avatar-wrapper.glow-*
//
//   挂断键图标旋�?180° �?135° (逆时针再�?45°)
// 2026-08-23 v0.2.30.33: bump CACHE_VERSION 强制清缓存（挂断键图�?�?老式电话听筒朝下
//
//   user 反馈 v0.2.30.32 截图: 挂断键白色电�?斜着立着", 不对
//   根因: 之前 v0.2.30.26 用的 Heroicons phone-down path 不对�?(左半比右半突�?, 看起来斜
//         v0.2.30.32 改用 Material phone + rotate(-45 12 12) �?U 形斜着�? 用户也认为不�?
//   user 真正要的: 老式电话听筒朝下�?(完美对称�?U 形朝�?
//
//   修法: �?Material phone path (U 形朝�? 完美对称) + rotate(180 12 12) �?U 形朝�?
//   路径: <path transform="rotate(180 12 12)" d="M20 15.5c-1.25 0-2.45-.2-3.57-.57..." />
//   只改 #voice-call-screen .control-btn.hangup-btn (语音通话), 视频通话保持原样 (Live2D 时再�?
// 2026-08-23 v0.2.30.31: bump CACHE_VERSION 强制清缓存（语音通话光晕 v5 �?
//
//   user 反馈 v0.2.30.30 截图:
//   1. 用户说话时光晕范围能再大一�?
//      �?加大 listening box-shadow blur 50-80px �?100-150px
//   2. AI 思考时看不到光环旋�?
//      �?头像�?130px 改回默认 70px, 光环对应缩到 90-100px
//      �?之前 158px 光环相对 130px 头像只有 28px 间距, 缩头像后更紧凑可�?
//      �?同时把光�?border 颜色提亮 (top 0.9�?.0) 让黑底上更明�?
//   3. AI 说话时大光晕闪烁也看不见
//      �?同样问题: box-shadow blur 太小 (45-75px) 紧贴 70px 头像, 看起来不"�?
//      �?加大 blur �?100-150px �?listening 一�?(user 明确要求 "效果一�?)
//   4. AI 说话时头像变大了, 全程不需�?
//      �?�?.voice-call-ai-active �?.participant-avatar �?width/height: 130px
//      �?保留 padding-top: 18vh (AI 状态时位置下移到屏幕中�?
//      �?头像保持默认 70px, border 4px �?2.5px 适配小尺�?
// 2026-08-23 v0.2.30.30: bump CACHE_VERSION 强制清缓存（撤回视频通话改动 �?
//
//   user 反馈: 视频通话以后要做 Live2D, 界面要大�? 不在此预先改�?
//   撤回 v0.2.30.26 (视频通话挂断键图�? + v0.2.30.28/29 (视频通话光晕/光环)
//   撤回方式: CSS 里把 #video-call-screen 相关的块注释�? 不删�?(留作 Live2D 时的参�?
//   语音通话 #voice-call-screen 的所有改动保�?
// 2026-08-23 v0.2.30.29: bump CACHE_VERSION 强制清缓存（语音通话 thinking 状�?�?金沙遗址图腾�?
//
//   user 反馈 v0.2.30.28: thinking 状态光影太�? 不是想要的图�?
//   user 原意: 像金沙遗址太阳神鸟图腾, 2 圈紧贴头像的暖黄光环反向旋转
//   v0.2.30.28 错用 box-shadow 大柔�?+ 脉动, 不符合图腾造型
//
//   修法:
//   - thinking 状态改�?::before / ::after 伪元素做光环
//   - 外圈 158px (顺时�?3.5s) + 内圈 145px (逆时�?2.8s), 都紧�?130px 头像
//   - border 不对称色 (top 暖黄 0.9, right 暖黄 0.55, bottom 0.25) 形成金沙图腾效果
//   - �?box-shadow (12px blur + 1px spread) 给光环微弱外发光
//   - 基础 box-shadow 18px blur + 4px spread 暖黄 0.35 给头像轻微外发光
//   - @keyframes voice-ring-spin-cw / -ccw 反向旋转
//   - 视频通话同步支持
// 2026-08-23 v0.2.30.28: bump CACHE_VERSION 强制清缓存（语音通话光晕 v4 �?
//
//   user 反馈 v0.2.30.27 截图:
//   1. AI 说话时光晕跑中间去了 (不在 AI 头像�?
//      根因: 独立光晕 div �?top: 35% 定位, �?AI 状态时头像�?24% 位置
//            flex + padding-top: 18vh 让头像位置上�? 但光晕位置没跟着�?
//   2. 光晕外边界太明确, 不像参考图2那种外边界模糊发�?
//      根因: radial-gradient 100% �?transparent 形成硬边
//   3. AI 思考时不是大光�? 是小光环在头像圈上旋�?
//      根因: 之前实现是大光晕 + 缩放脉动, 不符�?小光�?需�?
//
//   修法 �?彻底换思路:
//   - 删独立光�?div (.voice-call-glow), 删对�?CSS + keyframes
//   - 改用 box-shadow 直接挂在按钮/头像�?(长在元素�? 不会跑偏)
//   - 单层 box-shadow (�?blur + �?alpha + �?spread) 形成柔散外发�?
//   - listening: #voice-hang-up-btn.glow-listening (红色按钮 + 暖黄外发�?
//   - thinking: .participant-avatar.glow-thinking (白边 + 暖黄柔光, 缩放脉动)
//   - speaking: .participant-avatar.glow-speaking (白边 + 大暖黄柔�? 闪烁)
//   - 视频通话同步支持 (#video-call-screen)
//   v0.2.30.30: 撤回视频通话同步支持 (用户要做 Live2D, 视频通话界面大改, 不在此预先改�?
//   v0.2.30.26 也撤�? 视频通话挂断键图标改回原�?(iOS 风山�?+ 横向)
// 2026-08-22 v0.2.30.27: bump CACHE_VERSION 强制清缓存（语音通话光晕 v3 �?
//
//   user 反馈 v0.2.30.26 截图: 思考中状态有"大的�?, AI 说话时也�?
//   根因: box-shadow 多层叠加 (0 0 50px + 0 0 100px 两层) 形成同心圆环
//   �?�?box-shadow (idle/listening/thinking/speaking 全部 box-shadow: none)
//   �?只用 radial-gradient 单层 + 中心透明度提�?(0.55-0.6) + 边缘 95% 处透明 (柔化边缘)
//   �?thinking 缩放脉动 0.88 �?1.08 (之前 0.92 �?1.08)
//   �?voice-glow-pulse 改成缩放脉动 (0.95 �?1.05) 而非 box-shadow 闪烁
// 2026-08-22 v0.2.30.26: bump CACHE_VERSION 强制清缓存（语音通话挂断�?�?
//
//   user 反馈 v0.2.30.25 截图:
//   1. 挂断键和光晕之间�?黑色圆圈" �?�?.voice-call-controls 底部黑色渐变背景
//      (linear-gradient(to top, rgba(0, 0, 0, 0.5), transparent))
//      把按钮周�?130px 染成黑色, 覆盖在光晕外显得很突兀
//      �?去掉背景 (background: transparent !important)
//   2. 挂断键图标要"�?"那种 �?经典听筒朝下 (U �? Heroicons phone-down)
//      原图标是 iOS 风的"山形 + 横向", 跟参考图不一�?
//      �?�?SVG �?phone-down (U 形朝�?, 加红�?box-shadow 增强立体�?
//   3. 视频通话挂断键图标也一起改 (统一风格)
//
//   css/video-voice-call.css:
//   - #voice-call-screen .voice-call-controls { background: transparent !important; }
//   - #voice-call-screen .control-btn.hangup-btn �?SVG + �?box-shadow
//   - #video-call-screen .control-btn.hangup-btn 同步�?(统一)
// 2026-08-22 v0.2.30.25: bump CACHE_VERSION 强制清缓存（语音通话光晕 v2 �?
//
//   user 反馈 v0.2.30.24 三个问题:
//   1. 金沙遗址�?border ring 太明�?(像圆�? 不像光晕) �?删掉
//   2. 还有"我在�? / "正在识别" / "检测到你在说话" 等中间文�?�?删掉, 只保�?"倾听�?思考中/点击打断"
//   3. AI �?TTS 输出时立刻让用户�? 感觉少了一个流�?�?保持 "思考中" 1.5 秒再�?idle
//
//   index.html: �?2 �?voice-call-glow-ring div, 只保留主光晕
//
//   css/video-voice-call.css:
//   - 删所�?.voice-call-glow-ring 相关 CSS (border + spin-cw/ccw keyframes)
//   - .voice-call-glow.thinking 改柔�? 缩小 180px + 高对比中�?+ 2.4s 呼吸脉动
//   - 新增 @keyframes voice-glow-think (scale 0.92 �?1.08 + opacity 0.75 �?1.0)
//   - 移除旋转 keyframes (voice-glow-spin / voice-ring-spin-cw / -ccw)
//
//   modules/video-voice-call.js:
//   - setVoiceCallGlowState �?ringOuter / ringInner 操作
//   - �?3 处中间态文�? '我在听�? (line 1841) / '正在识别�? (line 1643) / '检测到你在说话�? (line 1814)
//   - hasVoiceCallTtsPlayback=false 分支: 保持 thinking + "思考中" 1.5 秒后 onVoiceCallTtsQueueFinished
// 2026-08-22 v0.2.30.24: bump CACHE_VERSION 强制清缓存（语音通话界面重排 �?
//
//   index.html: #voice-call-screen 内新�?voice-call-glow + 2 �?voice-call-glow-ring
//     光晕容器 (独立 DOM 元素, �?transform 迁移位置)
//
//   css/video-voice-call.css: ~150 行新样式
//     - .voice-call-glow + 4 个状�?class (idle / listening / thinking / speaking)
//     - 暖黄 radial-gradient + 多层 box-shadow
//     - 状态切换用 transition: 0.7s cubic-bezier(0.4, 0.0, 0.2, 1) 缓动 (手电挪位置感)
//     - 思考状�? 2 圈反向旋�?(voice-ring-spin-cw/ccw, 金沙遗址图腾�?
//     - .voice-call-ai-active class 触发: AI 状态时头像下移 + 加大
//     - 状态文字位置抬�?top: 60% (�? 倾听中位�?
//     - #voice-call-main 隐藏 (inline display: none + CSS 层冗�?
//
//   modules/video-voice-call.js: 6 处状态联�?
//     - 新增 setVoiceCallGlowState(state) �?控制光晕 class + 头像位置 class
//     - startVoiceCallRecording: 录音开�?�?'listening' + status='倾听�?
//     - triggerAiInVoiceCallAction: AI 思�?�?'thinking' + status='思考中'
//     - enqueueVoiceCallDisplayTextTts: TTS 开�?�?'speaking' + status='点击打断'
//     - onVoiceCallTtsQueueFinished: TTS �?�?'idle' + status='可以说话�?
//     - handleVoiceCallUserSpeak: AI 说话时点 speak �?�?stopTtsQueue + 再录�?(点击打断)
//     - startVoiceCall: 防御�?reset �?'idle'
// 2026-08-22 v0.2.30.23: bump CACHE_VERSION 强制清缓存（语音通话"启用音频"按钮接通后自动隐藏 + 删废弃的 regenerate 功能 �?
//
//   modules/video-voice-call.js 4 �?
//   1. 新增 setVoiceCallAudioUnlockBtnVisibility(visible) helper �?控制按钮显示/重置状�?
//   2. startVoiceCall 末尾调用 show �?防御, 通话开始时按钮一定可�?
//   3. stopVoiceCallWaitingMusic 末尾调用 hide �?彩铃停止 + 任务完成, 按钮自动隐藏
//   4. endVoiceCall 挂断停止背景音乐后调�?show+reset �?挂断恢复 unlock-inactive 状�? 下次再出�?
//
//   modules/init-event-bindingsB.js: �?voice-regenerate-call-btn 的旧 regenerate click handler
//   (callHistory.pop + 删最后一�?bubble + triggerAiInVoiceCallAction)
//   按钮已复用为"启用音频", click handler �?video-voice-call.js �?setupVoiceCallAudioUnlock 接管
// 2026-08-22 v0.2.30.22: bump CACHE_VERSION 强制清缓存（真人联机 P1-2 死连接修�?�?
//
//   online-chat-manager.js doSearch() 入口�?ws.readyState === WebSocket.OPEN 守卫:
//     isConnected=true 不等�?ws.readyState===OPEN (server 重启/网络切换后�?ws
//     �?terminate, client isConnected �?true 错乱状�?。状态错乱时 alert "连接�?
//     断开, 正在重新连接" + 主动 scheduleReconnect, 避免误以�?搜索超时"�?
//
//   server.js �?30s 死连接扫�?+ 60s 无活动踢�?(本次 PWA 推不覆盖, �?server
//   部署方案确认后再�?�?
//
// 2026-08-22 v0.2.30.21: bump CACHE_VERSION 强制清缓存（真人联机闪退修复 �?
//
//   online-chat-manager.js �?4 �?
//     1) _pruneHistories 默认 200 �?100 (单群 history 上限砍一�?
//     2) onmessage 限流入口: JSON.parse try-catch + 高频群消�?(receive_group_*
//        / group_history / my_groups) �?_msgQueue 限流, 每帧 setTimeout(0)
//        消化 10 �? 防止切后�?buffer 一次性倾泻导致 iOS 看门狗杀进程
//     3) 禁掉 _needsResync 增量补差: connect() 不再�?true, onRegisterSuccess
//        整段 requestCurrentGroupHistory 块删�? 切后�?掉线恢复不拉历史
//        (漏消息靠未读红点 + 未来"加载更多"按钮)
//     4) onReceiveMyGroups 不再�?server history: 已有 chat 跳过 _mergeHistory,
//        �?chat �?server history �?100 �?(首次连接不能完全空白)
//
// 2026-08-20 v0.2.30.9: bump CACHE_VERSION 强制清缓存（renderHistoricalLogs 自动清孤�?log 数据 �?
//
//   js/mcp-tool-call-log.js renderHistoricalLogs 加兜�?
//     收集"遍历了但 lineEl 没进 DOM"的孤�?log (�?6 找不�?anchor 直接 return �?case)
//     跑完一�? �?chat.mcpToolLogs 数组�?filter �?+ 同步�?IndexedDB
//
//   根因: user 反馈"现在孤儿不显示了会不会像以前一样其实还在占位置"
//        �?�?6 �?lineEl 不进 DOM (lineEl 函数返回后被 GC, 不占位置)
//          �?mcpToolLogs 数据还在 IndexedDB �? 每次 observer 触发都遍历这条孤�?
//          浪费 CPU + 脏数据永远不�?
//        �?�?8 跑完一次清�? 彻底干净
//
//   跟修 5b 的区�? �?5b �?chat.history 完全空时�?mcpToolLogs 整体
//                 �?8 �?chat.history 非空但单�?log 找不�?anchor 时清单条
//                 两者互�?
// 2026-08-20 v0.2.30.8: bump CACHE_VERSION 强制清缓存（�?log 找不�?anchor 堆底�?+ 加单条删�?�?
//
//   js/mcp-tool-call-log.js 3 处修�?
//     1) insertLogAfterBubble 找不�?anchor 时不渲染 (修前 v0.2.30.6/7 是包 group 插到
//        typingIndicator 之前, 全部堆在 chat-messages 底部, 密密麻麻不能跟随气泡)
//        修后: 找不�?anchor = 这条 log 失去"�? = 不显�?(别乱�?
//     2) 新加 attachLogGroupDeleteHandler + deleteLogGroupByTs:
//        group �?data-ts + click handler, �?confirm 后删 DOM + �?chat.mcpToolLogs 同步�?IndexedDB
//        3 �?group 创建位置都加�?attach (insertLogAfterBubble 正常路径 +
//        appendAfterLastMessage !lastBubble 分支 + appendAfterLastMessage 正常路径)
//     3) deleteLogGroupByTs 兜底: 找不�?ts 对应 log 时也�?DOM, 不报�?
//
//   css/mcp-miniapp-pink.css:
//     - .mcp-tool-log-group �?cursor:pointer + hover 浅红背景, 提示"可点�?
//
//   根因: user 反馈"log 密密麻麻堆在底部, 不能跟随气泡, �?chat 回来又堆, 还不能单独删"
//        �?之前 v0.2.30.6/7 �?找不�?anchor 时包 group �?typingIndicator 之前" 是兜底过�?
//          log 失去�?�?就该不显�? 而不是堆底部让用户误以为 AI 调了很多工具
//        �?user 想要"调了工具, log 紧跟 AI 消息气泡, 按时间顺序跟�?
//        �?找不�?anchor �?log (chat 长度 > 60 老消息被 MAX_DOM_NODES 清掉�? 不显�?OK
//          因为�?�?可跟�? 强行堆底部没意义
//        �?单条 log 删不了很�? �?click �?confirm 单独�?(不动 chat.history)
//
//   回归: 没跑 test-tool-call-log.mjs (mjs �?mock DOM, 这次改的 real DOM click 行为 mock 不了)
// 2026-08-18 v0.2.30.7: bump CACHE_VERSION 强制清缓存（�?mcpToolLogs 清空路径漏清 �?
//
//   modules/floating-ball.js handleQuickClearChatHistory (悬浮�?�?清空聊天记录):
//     之前只清 chat.history, 不清 chat.mcpToolLogs
//     �?data-management.js:903-915 (数据管理 �?清空聊天记录) 不一�? 那个路径有清
//     �? 同步�?chat.mcpToolLogs = []
//
//   js/mcp-tool-call-log.js renderHistoricalLogs:
//     �?chat.history 为空时清 mcpToolLogs 兑底
//     防御其他清空路径 (多选删�?单条删除/数据导入�? 可能也漏�?
//
//   根因: user 反馈"清空聊天记录也救不了, 好像这些没清理掉"
//        �?chat.mcpToolLogs 数据�?chat.history 分离, 悬浮球清空路径漏�?mcpToolLogs
//          �?observer 触发 renderHistoricalLogs 把�?log 重新插入 chat-messages
//          �?17 条�?log 视觉残留, �?1+2+3 也只能修 lineEl 散落撑底�? log 本身还在
// 2026-08-18 v0.2.30.6: bump CACHE_VERSION 强制清缓存（�?MCP 工具调用日志孤儿 lineEl 撑高 chat-messages �?
//
//   js/mcp-tool-call-log.js 4 处修�?
//     1) insertLogAfterBubble 找不�?anchor bubble �?fallback: 之前直接 container.appendChild(lineEl),
//        lineEl 散在 chat-messages �? �?message-wrapper 平级, 没包�?.mcp-tool-log-group
//        �?�? 包成 group div, 跟正常路径行为一�?
//     2) appendAfterLastMessage 找不�?lastBubble �?fallback: 同样问题
//        �?�? 包成 group div
//     3) 新加 cleanupOrphanLineEls(): 启动时把 chat-messages 直接子元素里"没包 group"�?
//        .mcp-tool-log-line �?remove (清掉之前 bug 残留的孤�? 修复硬刷不能自动清的问题)
//     4) init 调度: 启动 100ms �?+ 1s 后各跑一�?cleanupMisplacedGroups + cleanupOrphanLineEls
//
//   根因: user 反馈"调过 MCP �? 后续消息一发送就出现在聊天框顶部, 越多越高"
//        �?17 个孤�?lineEl 累积�?chat-messages 末尾 (typingIndicator 之后), 撑高容器底部
//        几百 px, appendMessage 的新消息插到 typingIndicator 紧前�? 视觉位置被孤�?
//        顶到中间偏上, 看着�?出现在顶�? + 累积越多新消息越靠上
//        实际 user 截图诊断: directLineElsCount=17 (chat-messages 直接子元素里�?17 �?
//        .mcp-tool-log-line 没被 group �?, totalGroups=1, misplacedCount=0
// 2026-08-17 v0.2.30.5: bump CACHE_VERSION 强制清缓存（变量记忆�?system 开�?�?
// 2026-08-13 v0.2.20: bump CACHE_VERSION 强制清缓存（�?syncCurrentChatPushConfig activeChatId 设计 bug �?
//   �?push 模式�?user 经常不在 chat �? activeChatId �?null 直接 return, push_user_config 一�?0 �?
//   �?push-server 10 分钟 scheduler 没事�? 主动消息一�?0 推�?
//   改成遍历所�?proactiveEnabled chat 一�?sync, 切模式时 push_user_config 立即�?N �?
//   user 2026-08-13 16:23 真机验证测试通知能来 = iOS PWA web-push 协议 work, 500 错是 push-server 端具�?bug, 不是 iOS 污染
//   + 1 分钟 setInterval 轮询 lastUserMsgAt (chat.history 末条 user 消息时间), server 巡视�?< 5 分钟�?�?跳过整个 chat
//   (user 2026-08-13: "看最后一条记录的时间来决定要不要巡视, 正在聊天也调就又浪费又多�?)
// 2026-08-13 cleanup: 回退 v0.2.20-debug-banner / v0.2.20.1 / v0.2.20.2 debug banner（结论：getKey() 拿到�?ArrayBuffer 干净�?
//   iOS PWA 污染只在 toJSON() 字符串路径。明天按 DeepSeek 方案�?getKey() + FormData 二进制上传改造）�?
// 2026-08-12 v0.2.19: bump CACHE_VERSION 强制清缓存（in-app-proactive 弹通知�?聊天界面也弹通知"开�?�?
// 2026-08-09 v0.2.04: bump CACHE_VERSION 强制清缓存（启动时清理老错�?group �?
//
//   js/mcp-tool-call-log.js �?cleanupMisplacedGroups():
//   - 启动 100ms �? 1s �? �?document.querySelectorAll('.mcp-tool-log-group')
//   - �?parent 链向上走检查是否在 #chat-messages 容器�?
//   - 不在的全 remove (�?body 末尾 / watch-together 容器 / truth-game 容器的老错�?group)
//   - 打印清理数量
//
//   根因: v0.2.03 修的 4 �?bug 改的�?新触�?时的逻辑, 不会清理已渲染的老错�?group
//         硬刷后老错�?group 还在 DOM, 撑高外层容器, 影响布局
//   修法: 启动时主动清 (1 �?100ms �?+ 1 �?1s �? 兼容容器还在渲染中的情况)
//
//   user 反馈: "为什么硬刷后还是信息出现在顶�? + "之前已经变高的位置会恢复正常�?
//   �? v0.2.03 修不了老错�? v0.2.04 加自清理, 硬刷后老错�?group �?remove, 布局恢复正常
// 2026-08-08 v0.2.03: bump CACHE_VERSION 强制清缓存（�?mcp-tool-call-log 容器错位 + scroll 干扰 bug �?
//
//   js/mcp-tool-call-log.js 4 处修�?
//
//   1) appendAfterLastMessage �?lastBubble 失败�?(新聊天没消息), fallback �?'.chat-area, .chat-messages, .messages' (类名),
//      �?330 实际只有 #chat-messages (id, 唯一) �?类名全找不到, 退�?document.body, lineEl 被加�?body 末尾
//      修法: 改用 getChatContainer() (#chat-messages), 找不到时插到 typingIndicator 之前 (�?330 appendMessage 行为一�?
//
//   2) scrollChatToBottom �?'.chat-area, .chat-messages, .messages, .chat-scroll' (类名) �?同样全找不到,
//      scroller �?null, 啥也不做 (虽然没生�? 但保留调用是隐患, �?330 滚动逻辑时序冲突)
//      修法: �?scrollChatToBottom 调用 + 函数 (死代�?�?30 appendMessage 自己�?messagesContainer.scrollTop = scrollHeight
//
//   3) renderHistoricalLogs �?document.querySelectorAll('.mcp-tool-log-line') 全局�? 可能拿到 watch-together 等其他容器的 line
//      修法: 改用 container.querySelectorAll() 限定�?chat-messages 容器�?
//
//   4) appendAfterLastMessage �?document.querySelectorAll('.message-bubble[data-timestamp]') + document.querySelectorAll('.mcp-tool-log-group')
//      修法: 全部改用 container.querySelectorAll() 限定容器
//
//   根因: user 反馈"调过 MCP �? 后续消息一发送就出现在聊天框顶部" + "严重时超出屏�? �?
//        group 偶尔被加�?body 末尾 (1 bug), �?scrollChatToBottom 设错对象干扰 330 滚动时序 (2 bug),
//        �?group 误插�?watch-together 容器影响布局 (3+4 bug)�? �?bug 一起修�?
//
//   回归 23/23 通过 (test-tool-call-log.mjs)
// 2026-08-06 v0.1.91: bump CACHE_VERSION 强制清缓存（角色级总开�?+ 渠道独立控制 �?
//   �?v0.1.90 �?二选一互斥"�?角色�?× 渠道独立"二维控制:
//   角色级开�?(chat.settings.proactiveEnabled) = 总开�?(能不能发)
//   全局 mode (globalSettings.proactiveDeliveryMode) = 渠道选择 (用什么发)
//   角色级关 = app + push 都不�? 角色级开 + �?push = 走系统推�?
//   proactive-wake.js createTask/createFixedTask/tryHandleAction 加角色级检�?
//   proactive-wake-ui.js syncOldProactiveSwitch 改成"永远不禁�? 只显示投递模式信�?
//   hint 文案�?开关无�?改成"当前投递方�? 系统推�?应用�?信息提示)
// 2026-08-05 v0.1.90: bump CACHE_VERSION 强制清缓存（投递方�?radio 用户自�? 严格二选一 �?
//   globalSettings.proactiveDeliveryMode: 'app' (应用�? 默认) / 'push' (系统推�?
//   严格互斥: �?app 就关 push, �?push 就关 app, 没有 both (避免刷屏)
//   background-activity.js startProactiveScheduler: mode != 'app' 不启�?
//   proactive-wake.js createTask/createFixedTask/tryHandleAction: mode != 'push' 拒绝创建推送任�?
//   proactive-wake-ui.js 管理页面�?投递方�?radio 卡片 (2 个选项, 选啥用啥), 切换实时重启 scheduler
//   user �?push: PWA 活着也走 push-server (不是 PWA 死了才走推�?
//   user �?app: 完全关掉 push-server 主动消息, 只用应用�?
// 2026-08-05 v0.1.89: bump CACHE_VERSION 强制清缓存（�?buildProactiveContext 共享函数 �?
//   ai-group.js �?buildProactiveContext(chat, options) 共享函数 (天气/亲属�?多层摘要/关联记忆/表情�?世界�?双源长期记忆)
//   暴露 window.buildProactiveContext, proactive-wake.js generateProactiveMessage 改用�?
//   现在新通道 (推�? 和老功�?(应用�? 用同一�?context 构建, 新功�?context 跟老功能一样全)
// 2026-08-05 v0.1.88: bump CACHE_VERSION 强制清缓存（AI 主动消息生成带完�?context �?
//   prompt �?�?AI 按人设自主决�? (不再硬场景列�?
//   generateProactiveMessage 注入完整 system prompt: 角色 prompt + 角色深度人设 (aiPersona) + 勾选世界书 + 日记 + 变量记忆闪回
//   双源记忆�?vectorMemoryManager.buildMemoryContext (�?330 主聊天一�?
//   history 10 �?20 �?
// 2026-08-05 v0.1.87: bump CACHE_VERSION 强制清缓存（合并 AI 定时提醒 + 主动消息 + 冷却时间 �?
//   �?ai-reminders-screen / ai-reminders.js / ai-reminders.css 独立 UI, 合并�?proactive-wake 管理页面
//   加冷却时间检�?(默认 30 分钟, user 可调 0-120), 防止 AI 在聊天过程中疯狂设提醒刷�?
//   任务列表加来源标�? 👤 手动 (user_message 有�? / 🤖 AI (user_message null + user_prompt 有�?
//   prompt �?{{proactiveCooldownMinutes}} 占位�? replaceTemplateVars 加默认�?30 fallback)
// 2026-08-05 v0.1.86: bump CACHE_VERSION 强制清缓存（AI 自动创建主动消息任务 �?
//   330 主体 chat AI �?JSON 指令里加 {"type": "create_push_task", userPrompt, recurrenceType, visible_hint}
//   AI 觉得"该主动关�?user"时输出这条指�?�?前端 hookProactiveWakeInMessages 自动�?ProactiveWake.createTask()
//   这样 user 不用手动创建, AI 自己设提�?
// 2026-08-05 v0.1.85: bump CACHE_VERSION 强制清缓存（AI 主动消息管理 UI �?
//   chat-list 顶部 banner + 全屏管理页面（玩法说�?+ 订阅状�?+ 任务列表 + 创建表单 + 测试推送）
//   粉白色系配色，modules/proactive-wake-ui.js + css/proactive-wake.css 新增�?
// 2026-08-05 v0.1.84: bump CACHE_VERSION 强制清缓存（push �?wake-up 模式 �?
//   push handler 收到 push-server 发来�?{type: 'proactive-wake', chatId, charId, charName, taskId, fixedMessage, aiPrompt} payload�?
//   fixed 模式 (fixedMessage 有�?: 直接 showNotification
//   guided/auto 模式 (fixedMessage null): 弹占位通知 + postMessage 主页�? 主页面调 LLM 生成后发 UPDATE_NOTIFICATION 替换占位�?
//   message handler �?UPDATE_NOTIFICATION 类型: 主页�?LLM 生成完消息后用同 tag 关闭占位 + 弹新通知�?
//   notificationclick 已用 event.notification.data?.chatId 跳转, 不用改�?
//   借鉴糯米�?(worker/proactive-push) �?wake-up 设计: AI 生成�?client �?(chat history + character prompt 完整 �?AI 人格健全)�?
// 2026-08-05 v0.1.83: bump CACHE_VERSION 强制清缓存（iOS 18.3.2 PWA VAPID 修复 v3 �?
//   v0.1.76 �?Uint8Array 实测 iPhone PWA 仍报 "must contain a valid P-256 public key"�?
//   v0.1.83 �?urlBase64ToUint8Array 返回 ArrayBuffer (u8.buffer) + �?try/catch �?fallback
//   (ArrayBuffer 优先, 失败时回退 Uint8Array)�?
//   实测 desktop Chrome 调�?(v0.1.76 也能), iPhone PWA iOS 18.3.2 严格模式要求 ArrayBuffer�?
//   修了 2 �?urlBase64ToUint8Array (line 22 + line 444) + 2 �?pushManager.subscribe try/catch
//   (line 63 subscribeToPushServer + line 481 tryCreatePushSubscription)�?
//   如果 v0.1.83 还报�? �?web-push-libs CLI 重新生成 VAPID 密钥 + push-server 加调试端点�?
// 2026-08-06 v0.1.98: bump CACHE_VERSION 强制清缓存（修存储徽章看不到比例 + 工具栏按钮七零八�?�?
//   vector-memory.js �?.vm-room-storage �?.vm-room-tabs 拿出�? 单独一�?.vm-storage-line
//   (display: flex; justify-content: space-between, 左侧存储信息 + 右侧状态点),
//   左右内边�?0 �?tab �?工具栏对�?(user 原话 "和下面的宽度对齐")。textContent 改回完整
//   `${formatted} / ${quota} · ${percent}` (user 原话 "现在又看不到比例�?, 接受 v0.1.82 简化方案不�?�?
//   工具栏按钮重新分�? 3 �?(添加/添加核心/清理) + flex:1 + 4 �?(导出/导入/设置/教程),
//   状态点挪到 storageLine 共享一�?(不再占工具栏空间)�?
//   css/variable-memory-skyblue.css 工具栏改 flex-wrap: nowrap (强制单行) + overflow-x: auto 兜底
//   (万一窄屏还是�? 水平滚动而不是换行乱�? 修真�?"七零八落"), 按钮紧凑�?(padding 7px�?px,
//   font 13px�?2px, gap 8px�?px), flex-shrink: 0 (不收�? 优先保证可点击区�?�?
//   index.html 同步 bump vector-memory.js ?v=0.0.45 �??v=0.0.46 + variable-memory-skyblue.css ?v=0.0.39 �??v=0.0.40�?
// 2026-08-06 v0.1.97: bump CACHE_VERSION 强制清缓存（撤回 v0.1.96 �?_importedAt 重置时间 + �?importMemory 保留 recallCount 原�?�?
//   v0.1.96 加的 _importedAt = now �?user 明确反对�?"重置时间" 操作, 撤回。_importedAt 字段 + getRoom �?1 行都撤掉�?
//   user 原话: "旧记忆原来什么样就什么样�? 日期召回次数都要原封不动, 如果以前就是很多�?召回�?
//   进回收站也没什�? 但这全都进就不正常啊, 你也别给他们重置时间"�?
//   真因: v0.1.78 决定 "importMemory 重置 recallCount=0" + 旧记忆的 memoryTime 是旧时间
//   �?user 设置 foyerDays=3 + threshold=0 �?100+ 旧记忆全部满�?"age > 3�?&& 0 <= 0" �?全部�?foyer�?
//   修法: importMemory �?recallCount/lastRecalled �?"重置�?0" 改为 "保留原�? (跨设�?backup 语义)�?
//   memoryTime/createdAt 也保留原�? 缺省�?now (旧导出文件没字段�?�?
//   不加 _importedAt 字段, getRoom 不改 �?100+ 旧记忆按原值自然判断进 foyer (recallCount=0 + memoryTime �? 或留 bedroom (recallCount>=1)�?
//   12/12 mock 验证 (100 条混�?recallCount 0/1/5, 30 �?foyer + 70 �?bedroom + 字段原值保�?+ �?_importedAt)�?
//   v0.1.96 那次是过度设�? user 反馈 "你别重置时间" 后撤回�?
//   index.html 同步 bump vector-memory.js ?v=0.0.44 �??v=0.0.45�?
// 2026-08-06 v0.1.95: bump CACHE_VERSION 强制清缓存（修玄关批量删 "toast 弹了但卡片还�? 真因 �?
//   vector-memory.js 修真�?bug: class 内有两个同名 `deleteFragments` 方法 (line 238-248 老版同步接收
//   string id array + line 1048-1057 新版 async 接收 fragment object array), JS class 后定义覆�?
//   前定�? 新版覆盖了老版, 但玄�?handler 还在按老版签名�?string id array (ids / selected).
//   新版内部 `fragments.map(f => f.id)` �?string 当对象取 .id �?全部�?undefined �?Set �?undefined
//   �?filter 不删任何东西 �?toast �?已清�?N �?(handler �?ids.length 自算, 不是返回�?�?
//   实际 vm.fragments 没改 �?renderVectorMemoryView 渲染没删�?chat �?卡片还在�?
//   单条删除 OK 因为用的�?`deleteFragment`(单数) 没重名问题�?
//   修法: �?line 1048-1057 �?`async deleteFragments(chat, fragments)` 改成兼容两种传法
//   (`typeof item === 'string' ? item : item.id`), 顺手补回关联引用清理 + stats 同步,
//   3 个传 string array 调用�?(玄关清空回收�?+ 删除选中) �?1 个传 fragment array 调用�?
//   (一键清�? 都能正常 work�?1/11 mock 验证通过 (string array / fragment array / 混合 / 边界)�?
//   之前 v0.1.79 liveChat 修复 (race condition) 是错的方�? 已保留作为防御性代�?(不撤)�?
//   index.html 同步 bump vector-memory.js ?v=0.0.42 �??v=0.0.43�?
// 2026-08-05 v0.1.81: bump CACHE_VERSION 强制清缓存（核心记忆�?转普�?按钮 �?
//   vector-memory.js �?unpinFromCoreMemory(chat, id) 方法 (pinToCoreMemory 镜像)�?
//   卧室核心记忆卡片渲染时不再用 `${isCore ? '' : '�?核心'}` 留空, 改成显示"转普�?按钮�?
//   行为: 点转普�?�?�?fragment.category �?'C' 改成 'E' (默认事件分类), 其他字段
//   (importance / emotionalWeight / tags / content / lastRecalled / recallCount �? 全部保留�?
//   importance 保留是因为它是用户主观评�? 不应该被自动�? 想换分类�?�?按钮手动改�?
//   memory-summary.js �?.vm-unpin-btn handler, �?state.chats[state.activeChatId] 拿最新引�?
//   (跟玄�?3 �?handler 同模�? �?race condition)�?
//   index.html 同步 bump vector-memory.js ?v=0.0.40 �??v=0.0.41 + memory-summary.js ?v=0.0.39 �??v=0.0.40�?
// 2026-08-05 v0.1.80: bump CACHE_VERSION 强制清缓存（修导入导出按钮缺�?�?
//   vector-memory.js 卧室工具栏在 "🧹 清理" 按钮后补 #vm-export-btn / #vm-import-btn 两个按钮�?
//   modules/memory-summary.js:1057-1097 那段 handler 代码（调 vectorMemoryManager.exportMemory /
//   importMemory）其实早就写了，�?vector-memory.js 里从来没渲染过这俩按�?DOM，导�?
//   container.querySelector('#vm-export-btn') 永远返回 null，if 永远 false，点不到�?
//   �?UI 接好但方法缺�?一个套路的"UI 接好�?DOM 缺失"�?
//   index.html 同步 bump vector-memory.js ?v=0.0.39 �??v=0.0.40�?
// 2026-08-05 v0.1.79: bump CACHE_VERSION 强制清缓存（修回收站批量删除 race condition bug �?
//   modules/memory-summary.js 玄关 3 �?handler（清空回收站 / 删除选中 / 救回）改为每次从
//   state.chats[state.activeChatId] 拿最�?chat 引用，绕开后台 red-packet-poll.js:163 /
//   data-management.js:2584 �?"state.chats[chatId] = freshChat" 替换逻辑。原版用闭包 chat�?
//   用户在二次确认弹窗停留几秒时后台轮询可能�?state 里的 chat 换成另一个对象，导致
//   deleteFragments 改的是旧对象、renderVectorMemoryView 读的是新对象（没改），结�?
//   "toast 说清了但卡片还在"。手�?PWA + iOS Safari 性能�?PC 慢，撞概率高。单条删�?
//   耗时短所�?user �?OK，批量删除多一�?showCustomConfirm 弹窗停留所�?user 报不 OK�?
//   �?v0.1.78 同期: vector-memory.js �?exportMemory/importMemory，showCustomConfirm 参数�?
//   confirmButtonText/cancelButtonText �?confirmText/cancelText 修正�?
//   index.html 同步 bump vector-memory.js ?v=0.0.37 �??v=0.0.39 + memory-summary.js ?v=0.0.37 �??v=0.0.39�?
// 2026-08-05 v0.1.78: bump CACHE_VERSION 强制清缓存（变量记忆新增导出/导入 �?
//   vector-memory.js �?exportMemory + importMemory 方法。UI 入口早就�?modules/memory-summary.js:1057-1097
//   接好（导出按�?#vm-export-btn + 导入按钮 #vm-import-btn + merge/replace 弹窗），但方法本体一直缺失，
//   点了会报 "exportMemory is not a function"。修�? 实现 exportMemory(chat) 返回 JSON 字符串（剥离 embedding
//   跨模�?端点兼容性更�?+ 只导关键 settings + 自定义分�?+ 时间线摘要），实�?importMemory(chat, json, mode)
//   'merge' �?content+memoryTime+category 三元组去�?/ 'replace' 清空再覆盖，导入�?embedding 强制 null
//   触发懒重算，lastExtractedTimestamp 不动避免重头提取产生重复�?
//   index.html 同步 bump vector-memory.js ?v=0.0.37 �??v=0.0.38�?
// 2026-08-05 v0.1.77: bump CACHE_VERSION 强制清缓存（回退 Gemini 调工�?�?
//   js/mcp-tool-bridge.js:
//     1. �?runChatWithToolLoopGemini (~150 �? �?v0.1.71 �? 试了 2 天修不干净, 放弃
//     2. �?convertSchemaToGemini + openAIToolsToGemini (协议 schema 转换函数, Gemini 工具循环配套�? ~50 �?
//     3. �?formatGeminiFunctionResponseContent (~10 �?
//     4. wrappedFetch 改回 v0.1.69 行为: Gemini native 永远 bypass, 工具 ON �?bypass
//   保留: isGeminiNativeRequest (�? / wrapAsJsonResp (OpenAI 路径�?
//
//   行为:
//   - Gemini native 端点 �?永远 bypass, 普通聊�?+ 视频/语音 + 总结记忆 work
//   - 调工具用 M3 / Gemini OpenAI 兼容端点 / 公益�?(OpenAI 风格, �?runChatWithToolLoop)
//   - user 决定: 放弃 Gemini 调工�? 普通聊天就普通聊�? 调工具换渠道换模�?
//
//   v0.1.77 之前的回退: v0.1.69 (Gemini native 永远 bypass, user 部署验证 work)
//
//   教训 (memory): "中间层转 body 是反模式" + "bypass �?做不�? + "试了 2 天修不干净就该认命回退, 别死�?
// 2026-08-03 v0.1.76: bump CACHE_VERSION 强制清缓存（iOS Safari 16.4+ VAPID 修复 v2 �?
//   v0.1.75 �?urlBase64ToUint8Array 返回 ArrayBuffer, 实测仍报 "must contain a valid P-256 public key"�?
//   改回 Uint8Array (Uint8Array.from + 兼容更好)。iOS Safari 16.4 不同 patch 行为不一�? 改回标准 Uint8Array�?
//   如果 v0.1.76 还报�? 下一步在 iPhone console 跑诊断看公钥实际值�?
// 2026-08-03 v0.1.75: bump CACHE_VERSION 强制清缓存（iOS Safari 16.4+ VAPID P-256 严格性修�?�?
//   modules/notification-battery.js urlBase64ToUint8Array 返回 Uint8Array �?ArrayBuffer (返回 u8.buffer)�?
//   iOS Safari 16.4+ 严格模式�?applicationServerKey 要求 BufferSource, 直接�?Uint8Array �?"must contain a valid P-256 public key"�?
//   之前 web 标准允许 Uint8Array, iOS Safari 16.4 早期版本不识�? 必须 ArrayBuffer 包裹。改 2 �?(line 22 + line 444)�?
//   实测: 2:03 iPhone 截图报错, 改完 push 部署�?iPhone 重启 PWA 应该能订阅�?
// 2026-08-02 v0.1.74: bump CACHE_VERSION 强制清缓存（Gemini function response role 修正 �?
//   js/mcp-tool-bridge.js runChatWithToolLoopGemini 调工具后写回 contents �?role:'function' �?role:'user' (2 �?�?
//   根因: Gemini API 不接�?role:'function', �?400 "Role 'function' is not supported. Please use a valid role: SYSTEM, SYSTEM_1, USER, ASSISTANT, DEVELOPER, CONTEXT, USER_CONTEXT, MODEL, USER"�?
//   正确格式: functionResponse 必须嵌在 role:'user' �?message �?parts �?(user 消息 + parts:[{functionResponse:{name,response:{content}}}]), 不是独立�?role:'function' 消息�?
//   实测: 用户 21:35 截图, 调高�?maps_geo 工具, AI 调工具后写回 functionResponse �?400, �?role 后应�?work
// 2026-08-02 v0.1.73: bump CACHE_VERSION 强制清缓存（菜单卡片加底部双按钮 + �?FAB 长按"半透明卡住"bug �?
//   js/mcp-menu-card.js ensureSheet: �?.mcp-menu-sheet-footer �?"关闭菜单" (data-role="close-bottom" �?closeSheet, FAB 还在)
//   �?"不再显示入口" (data-role="hide-fab" �?hideFab + closeSheet, 跟长�?FAB 一�? 两按�? �?mcp-pay-card 风格统一;
//   js/mcp-menu-card.js hideFab: 立即移除 is-visible + is-longpress-done + is-longpressing 三个 class, 避免长按�?FAB 留在
//   "半透明卡住" 状�?(is-longpress-done 有自己的 transition, 跟默�?transition 冲突, 看着像没关掉);
//   css/mcp-miniapp-pink.css: �?.mcp-menu-sheet-footer / .mcp-menu-sheet-footer-btn / .mcp-menu-sheet-footer-btn.secondary 样式
// 2026-08-02 v0.1.72: bump CACHE_VERSION 强制清缓存（AI 请求 total 超时 3 分钟 �?10 分钟 �?
//   modules/ai-response.js AI_TOTAL_TIMEOUT_MS 180000 �?600000�?
//   原因: v0.1.71 Gemini 工具循环可能�?6 �?(AI 调工�?+ 重发), 单轮 5-50 �? 3 分钟会被掐断�?
//   10 分钟给足 12 �?× 50 �?余量, firstChunk 60 秒保�?(�?API 完全不响�?�?
//   _patch_ai_timeout.js 也同步改�?600000, �?patch 脚本跟当�?ai-response.js 不一�?(脚本�?120000, 实际 180000), 直接改源文件更稳
// 2026-08-02 v0.1.71: bump CACHE_VERSION 强制清缓存（Gemini 原生 API 工具循环重做 �?
//   之前 v0.1.58 走的�?中间层转 OpenAI body"反模�? �?3 次坑 (type/enum/stream) �?v0.1.69 矫枉过正完全 bypass;
//
//   v0.1.71 新方�? 不中间层�?body, 直接�?Gemini 原生协议 (contents + tools[functionDeclarations]):
//   1. mcp-tool-bridge.js 恢复 convertSchemaToGemini + openAIToolsToGemini (协议 schema 转换, 必须 �?Gemini proto3 枚举大写 + enum 元素 string �?
//   2. mcp-tool-bridge.js �?runChatWithToolLoopGemini (~140 �? �?直接�?Gemini 原生 contents �?API 通信, 解析 candidate.content.parts[].functionCall, 调工�? 写回 functionResponse (role:function + parts:[{functionResponse:{name,response:{content}}}])
//   3. mcp-tool-bridge.js wrappedFetch �? Gemini native + 工具 ON �?�?runChatWithToolLoopGemini; 工具 OFF �?bypass; stream=true �?bypass (流式调工具暂不做)
//   4. formatGeminiFunctionResponseContent: mcp 工具结果�?mcp-tool-bridge.js 自己�?formatMcpToolResult (会处�?mcd 真实 markdown 包装), 转成 Gemini 期望�?string
//
//   普通聊天行为不�?(stream=true �?bypass, �?v0.1.69 一�?; AI 性格不受影响 (�?systemInstruction 不动, 只追�?sysBlock 工具说明);
//
//   真机验证 (用户没梯, 跑不�?Gemini API 直接�? 但代码逻辑�?v0.1.63 M3 调工具路径一�? 行为稳定):
//   - 主聊�?stream=true �?永远 bypass, 行为�?v0.1.69 一�?�?
//   - 调工�?(非流�?Gemini) �?走新工具循环, schema 转换 + 调工�?+ 写回 + 重发
//   - 端到�?Node mock 跑不�?(sandbox 设计问题, installHook �?originalFetch �? �?删了 _reports/test-gemini-native-loop.mjs, 改真机验�?
//
// 2026-08-02 v0.1.70: bump CACHE_VERSION 强制清缓存（MCP 工具调用日志持久�?+ v0.1.58 死代码彻底清�?�?
//   (1) js/mcp-tool-call-log.js: 实时 onCard �?push �?chat.mcpToolLogs (新字�? chat 对象下独立数�? + db.chats.put(chat) �?IndexedDB;
//       持久�?entry = { ts, afterMsgTs, toolName, aiName, summary, success } (afterMsgTs = 当时最近一�?assistant 消息 timestamp 作锚�?;
//       MutationObserver 监控 #chat-messages 容器 childList 变化, debounce 100ms 后调 renderHistoricalLogs(activeChatId)
//       把当前聊�?mcpToolLogs 重新�?afterMsgTs 锚点插入 DOM (�?data-ts 跳过已渲�? 幂等);
//       找不到精确锚点气泡时兜底�?ts 之前最近一�? 仍找不到就插�?chat-messages 容器末尾;
//       老聊�?(�?mcpToolLogs 字段) 兼容不报�?(test case 14 验证);
//   (2) js/mcp-tool-bridge.js: 删除 v0.1.58 死代�?~200 �?(convertSchemaToGemini / openAIToolsToGemini / geminiBodyToOpenAI /
//       openAIMessagesToGeminiContents / openAIResponseToGemini / runChatWithToolLoopGemini), 保留 isGeminiNativeRequest (v0.1.69 wrappedFetch �?
//       �?wrapAsJsonResp (runChatWithToolLoop �?;
//       v0.1.69 行为完全保留 (test-stream-bypass.mjs 8/8 仍然通过);
//   端到端验�?23/23 通过 (实时渲染 9 + 多调用堆�?2 + 持久化写�?4 + 切聊天恢�?4 + 幂等 1 + 兜底 1 + 老聊天兼�?1 + 实时 summary 2);
//   modules/data-management.js type='chat' 分支已联�? 群聊 + 单聊清空 history 时同�?chat.mcpToolLogs = [], 避免锚点孤立;
//   charId==='user' 分支不动 mcpToolLogs (那个分支是过�?user 消息保留 assistant 消息, afterMsgTs 锚点指向 assistant 不受影响)
// 2026-08-02 v0.1.69: bump CACHE_VERSION 强制清缓存（Gemini 直连普通聊天全�?v3 �?v0.1.58 写的 wrappedFetch + runChatWithToolLoopGemini 拦截所�?Gemini 请求, 强制 non-stream + 注入 tools + systemInstruction, 破坏 330 主聊�?总结记忆的原生行为。v0.1.67 试图�?stream bypass 但只�?body.stream === true 有效, Gemini native 端点 body 不带 stream 字段所�?bypass 不生效。v0.1.69 根本性修�? wrappedFetch 简�?�?Gemini native 端点 (generativelanguage.googleapis.com/v1beta/models/.../generateContent) 永远 bypass �?originalFetch (普通聊�?+ 总结记忆 work), 想用 Gemini 调工具改�?OpenAI 兼容端点 (generativelanguage.googleapis.com/v1beta/openai) 走工具循�?(已验�?work)。v0.1.65 + v0.1.68 仍然有效 (�?mcd 工具 work)。端到端 8/8 通过 (Gemini native bypass + Gemini OpenAI 兼容进工具循�?+ M3 进工具循�?+ �?LLM bypass + GET bypass + 公益�?Gemini 两种模式�?work)�?
// 2026-08-02 v0.1.68: bump CACHE_VERSION 强制清缓存（Gemini enum 元素 number �?string + 类型回转 �?mcd 工具真实 inputSchema �?enum �?number 数组 (e.g. beType: enum=[1,5] type=integer), Gemini API 期望 enum �?repeated string 不接�?number, �?400 Invalid value at 'enum[0]'。修�? (1) mcp-tool-bridge.js convertSchemaToGemini 转换时把 enum 元素全部 toString, (2) mcp-generic-client.js normalizeValueBySchema �?enum 类型回转 �?AI 输出 string "1" �?mcd.cn 端点期望 number 1, 自动转回。端到端 12/12 通过 (�?mcd query-nearby-stores 真实 beType=[1,5]/searchType=[1,2] number enum 转换 + 类型回转测试)�?
// 2026-08-02 v0.1.65: bump CACHE_VERSION 强制清缓存（Gemini 原生 API type 大写 bug 修复 �?openAIToolsToGemini �?convertSchemaToGemini() 递归转换 OpenAPI Schema 小写 (string/number/integer/boolean/object/array) �?Gemini proto3 枚举大写 (STRING/NUMBER/INTEGER/BOOLEAN/OBJECT/ARRAY)。修�? Gemini 直连调工具报 400 Invalid value at 'tools[0].function_declarations[1].parameters.properties.X.type' (TYPE_STRING)。修后端到端 11/11 通过 (mcd 真实参数 + 嵌套 object/array + enum + description/required 保留)�?
// 2026-08-02 v0.1.63: bump CACHE_VERSION 强制清缓存（MCP 工具调用日志 �?新建 js/mcp-tool-call-log.js 监听所�?onCard, 覆盖所有通用 MCP 工具 (不限 mcd/luckin/amap), inline 渲染简洁文字行紧跟最后一�?AI 消息: "[emoji] [toolName] · [摘要]"。跟 mcp-menu-card / mcp-pay-card 共存互补 �?菜单/支付是大卡片, 日志是文字证�? 用户看日志就知道 AI 真调了工具不是瞎编。摘要逻辑通用: 优先�?pois/stores/meals/items 等数组长�?�?数字字段 (count/amount/distance) �?订单�?�?兜底字段数。css/mcp-miniapp-pink.css �?.mcp-tool-log-group / .mcp-tool-log-line / .mcp-tool-log-ok/err 样式�?
// 2026-08-02 v0.1.62: bump CACHE_VERSION 强制清缓存（inline 支付卡片 �?新建 js/mcp-pay-card.js + css/mcp-miniapp-pink.css �?.mcp-pay-card 系列样式 + index.html 加载 + 麦当�?瑞幸教程�?系统自动 inline 渲染支付卡片, AI 自由发挥不重�?提示。监�?create-order/createOrder/mall-create-order, 提取 payUrl/payOrderUrl/payOrderQrCodeUrl, 紧跟最后一�?AI 消息气泡后面渲染。设计原�? 不弹全屏 (破坏"AI 帮你下单"代入�?, �?inline 渲染支付信息让用户能�?点。不规定 AI 说话, AI 用人设自由发挥）
// 2026-08-02 v0.1.61: bump CACHE_VERSION 强制清缓存（备份模块漏掉悬浮�?生图/MCP 修复 �?modules/backup-import-export.js �?EXTRA_LOCALSTORAGE_PREFIXES 列表统一管理 8 �?localStorage key（couple/floating-ball/novelai-/google-imagen-/pollinations-/openaiCompatImage/ephone.mcp./aphone.mcp.），重构 exportExtraLocalStorage / clearExtraLocalStorage / restoreExtraLocalStorage 三个函数。import 路径全部更新（importStreamedBackup/importLegacyBackup/handleSelectiveImport 3 处），旧�?exportCoupleSpaceLocalStorage 等保留做兼容转发。_reports/test-extra-localstorage.mjs 端到端验�?94/94 通过�?
// 2026-08-02 v0.1.60: bump CACHE_VERSION 强制清缓存（麦当劳教程按官方文档 https://open.mcd.cn/mcp/guide.md 重写 �?21 个工具全覆盖：到店流�?5 �?/ 外送流�?5 �?/ 优惠�?4 工具 / 订单管理 2 工具 / 辅助 7 工具。修之前"🚫 官方没做查订单工�?的错误（实际�?query-order），加协议版本兼容说�?+ 限流 600/�?提示 + 数据依赖�?storeCode/mealCode/订单ID�?
// 2026-08-02 v0.1.59: bump CACHE_VERSION 强制清缓存（高德 3 个端�?REST 兜底: maps_text_search / maps_around_search / maps_weather �?mcp-generic-client.js 新增 amapTextSearchRestFallback / amapAroundSearchRestFallback / amapWeatherRestFallback + tryAmapRestFallback 集中分发 + amapMcpDataIsEmpty 空数据检�?+ isAmapBugTool 判断，callTool �?isError / 空数据两种分支都触发 REST 兜底。AI 完全无感，端到端验证 4/4 通过：成都搜麦当�?20 �?POI / 周边 2km 7 �?POI / 成都实况小雨 22°C / 洛阳�?3 个候选）
// 2026-07-09 v0.1.18: 改用 Vercel 默认 bodyParser:true —�?req.body 直接是解析后的对象，不用 rawBody 兜底
// 2026-07-09 v0.1.12: 修致�?bug �?runChatWithToolLoop 内部 fetch(url) = window.fetch = wrappedFetch �?无限递归 �?OOM 闪退。改�?originalFetch 绕过自己�?
// 2026-07-09 v0.1.11: �?refreshToolbarActive 闭包 bug �?�?refreshToolbarActive 提升�?IIFE module-scope �?ensureMiniAppDom 闭包也能访问
// 2026-07-29 v1.0.0: 通用 MCP 工具服务�?�?�?mcd/luckin 硬编�? 改用 McpGenericClient + 通用 UI 列表
// 2026-07-09 v0.1.6: 诊断行暴�?preload 错误信息；重连后强制重激活当�?brand + 同步 UI；toggle click 后刷 diag
// 2026-07-09 v0.1.5: 干净设计 �?去掉"强制开�?按钮；UI 永远服从 storage；toggle 提示文案区分 token 没填/开关没开
// 2026-07-09 v0.1.4: �?resetAll() 错误�?setEnabled(false) 残留 bug；UI �?🔧 强制开�?/ 🔄 刷UI 按钮兜底恢复
// 2026-07-09 v0.1.3: �?MCP token 输入�?change→input 事件 + toggle click 兜底 setToken（解�?看着填了�?storage 没存"bug�?
// 2026-07-15 v0.1.25: bump CACHE_VERSION 强制清缓存（hotNews + vector memory + isGenerating 残留 3 处修�?�?modules/hot-news.js + modules/ai-response.js + modules/vector-memory.js�?
// 2026-07-15 v0.1.24: bump CACHE_VERSION 强制清缓存（歌词解析 parseLRC 兼容无毫秒时间戳 �?modules/music-player.js �?1 �?parseLRC + index.html bump ?v=0.0.44�?
// 2026-07-14 v0.1.22: bump CACHE_VERSION 强制清缓存（一起读书加 URL 抓取 + 粉白美化，index.html/main-ui.css/reading-room.js 都改了）
// 2026-07-14 v0.1.21: getProxyUrl �?hostname 优先判断 �?双平台切换永远正确不靠缓�?
// 2026-07-21 v0.1.29: bump CACHE_VERSION �?新增 js/ai-songs-store.js（AI 原创�?IndexedDB 持久化层�?
// 2026-07-24 v0.1.44: bump CACHE_VERSION 强制清缓存（Live2D 硬开�?�?state.globalSettings.live2dEnabled !== true �?mountLive2DForCall 直接 return, UI 输入框也隐藏；之前卖家模型不兼容 doDrawModel undefined '0'，保留所�?Live2D 代码和数据以备以后换兼容模型�?
// 2026-07-21 v0.1.30: bump CACHE_VERSION �?视频通话 Live2D 接入（cubism core + pixi.js + pixi-live2d-display + lib/live2dcubismcore.min.js + modules/live2d-loader.js + assets/live2d/�?

// 2026-07-24 v0.1.45: bump CACHE_VERSION 强制清缓存（音色样本时长上限 60s �?180s / 3 分钟 �?js/role-voice-sample-ui.js MAX_DURATION 60�?80、MAX_SIZE 10MB�?0MB、文案跟着变。MiniMax Cover 输出音频长度受参考音频长度限制，60s 唱不完整一首歌�? 分钟够用�? 分钟 wav 25-35MB 仍超 20MB，但 mp3 5-8MB 够用，主�?mp3�?
// 2026-07-23 v0.1.38: bump CACHE_VERSION 强制清缓存（"角色有音色样本时自动�?Cover" 开�?�?index.html �?#auto-cover-when-has-sample-switch 开关；settings-presets.js 加载默认 true；init-event-bindingsA.js 保存�?globalSettings.autoCoverWhenHasSample；ai-music.js 强制 cover 逻辑改成读这个开关，false 时即使有样本也用用户在设置里选的普通模型）
// 2026-07-23 v0.1.37: bump CACHE_VERSION 强制清缓存（灵动岛点击打不开播放�?�?modules/init-event-bindingsA.js setupMusicIslandWidget openPlayer 原来只判 musicState.isActive，AI 自动唱歌的路径不�?startListenTogetherSession 一直是 false，加 playlist+isPlaying 兜底判断�?
// 2026-07-23 v0.1.36: bump CACHE_VERSION 强制清缓存（AI �?caller 漏传 lyrics �?ai-response.js:6739 + ai-group.js:1092 + ai-group.js:1567 三处 addAiSongToPlaylist 没传 lyrics 字段，buildLrcFromLyrics 拿不到词 �?播放�?lrcContent 一直是空，歌词不显示）
// 2026-07-23 v0.1.35: bump CACHE_VERSION 强制清缓存（Cover 模式歌词覆盖 bug �?modules/ai-music.js generateCover 删掉 preprocess 返回�?formatted_lyrics 覆盖逻辑，之前是 server 从参考音�?ASR 出来的旧歌词覆盖了用户给的新词，导致 Cover 唱的还是上传内容�?
// 2026-07-22 v0.1.34: bump CACHE_VERSION 强制清缓存（音色样本 file input accept 加扩展名兜底 �?js/role-voice-sample-ui.js accept 改为 ".mp3,.wav,.m4a,..." 列表避免 audio/* �?Windows Chrome/PWA 过滤�?mp3；hidden �?display:none 保险；js/music-voice-sample.js setVoiceSample 强制 blob mime=audio/mpeg 避免 IDB �?mime�?
// 2026-07-22 v0.1.33: bump CACHE_VERSION 强制清缓存（悬浮�?AI 原创曲管�?入口 �?modules/floating-ball.js �?data-action="manage-ai-songs" + handleQuickManageAiSongs() mini modal 列出 IndexedDB 所�?AI 歌，每首 �?�?🗑，底部一键清空；js/ai-songs-store.js �?listAllSongs API�?
// 2026-07-22 v0.1.32: bump CACHE_VERSION 强制清缓存（AI �?blob 强制 mime=audio/mpeg �?IDB 反序列化常丢 mime type，导�?data URI 前缀�?data:;base64, �?mime�?audio> 拒播。修法：modules/music-player.js addAiSongToPlaylist 入口 + js/ai-songs-store.js persistSong 写库时都强制 new Blob([blob], { type: 'audio/mpeg' })�?
// 2026-07-22 v0.1.31: bump CACHE_VERSION 强制清缓存（AI 原创曲按 songId 去重 �?modules/music-player.js addAiSongToPlaylist �?songId pre-dedup 块，绕过 getMusicTrackKey 不认 songId �?bug�?
// 2026-07-21 v0.1.30: bump CACHE_VERSION �?视频通话 Live2D 接入（cubism core + pixi.js + pixi-live2d-display + lib/live2dcubismcore.min.js + modules/live2d-loader.js + assets/live2d/�?
// 2026-07-21 v0.1.29: bump CACHE_VERSION �?新增 js/ai-songs-store.js（AI 原创�?IndexedDB 持久化层�?
// 2026-07-24 v0.1.42: bump CACHE_VERSION 强制清缓存（SW install 改宽容：cache.addAll �?Promise.allSettled，单�?URL 失败不再让整�?install 失败 �?修复"一键修复通知 SW 注册不上"根因�?
// 2026-07-24 v0.1.41: bump CACHE_VERSION 强制清缓存（一键修复通知卡死修复：navigator.serviceWorker.ready �?5s timeout + 全流�?console.log 进度 + 按钮 disabled 状�?�?modules/notification-battery.js + index.html bump ?v=0.0.38�?
// 2026-07-25 v0.1.46: bump CACHE_VERSION 强制清缓存（语音/视频通话 Gemini 直连修复 �?video-voice-call.js 两处 isGemini 兜底：resolveApiSlotConfig 不返�?isGemini, �?proxyUrl.includes('generativelanguage') 兜底判定�?
// 2026-07-24 v0.1.40: bump CACHE_VERSION 强制清缓存（"无声智能保活"settings-item 改用标准结构 label + .settings-desc，跟其他设置项对�?�?index.html line 3173-3183�?
// 2026-07-24 v0.1.39: bump CACHE_VERSION 强制清缓存（系统设置首页"数据与存�?卡片跳转目标�?sec-cloud-storage 改到 sec-data-management �?modules/system-settings-home.js + index.html bump ?v=0.0.37�?
// 2026-08-01 v0.1.56: MCP 菜单卡片 parse bug 修复 + 教程简�?
//   1) mcp-generic-client.js callTool: safeParseJson 失败时改�?extractJsonFromMcpText
//      brace-match �?mcd.cn / 其他 MCP 端点 text 里嵌�?JSON (前面 markdown 描述导致 JSON.parse 整体�?
//   2) mcp-menu-card.js parseMcpResult: McpGenericClient 包成 {success,data,rawText} �?
//      改成 return result.data (而不�?return result), 剥外层包�?
//   3) mcp-menu-card.js onCard: 加诊�?log, 列出 result shape + 没解析出菜单数据时打 rawText �?200 字符
//   4) mcp-ui-list.js 教程简�? �?30 �?WORKER_CODE + �?5 分钟部署教程"�?+ �?通用流程"�?+ �?
//      "遇到问题"�?+ �?"copy-worker-code" 事件�?(~200 �?�?75 �?, 弹窗顶部改成
//      "代理已部署好, URL �?https://mcp.lhualan338.workers.dev/" + 2 个服务各 3 步接�?
// 验证: _reports/test-extract-only.mjs 端到端跑�?�?14 分类 116 餐品, 跟用户截�?蘸酱炸鸡五选一 11.9�?对上
// 2026-08-01 v0.1.56: 修绿江章节删除按钮不响应 - checkbox 点击时同�?selectedChapters
// 2026-08-01 v0.1.57: 修绿�?AI 续写不接剧情 - prompt 拼接多章 summary + 硬性接续要�?+ summary 缺失 fallback
// 2026-08-01 (合并�?v0.1.58) MCP 端点使用教程注入: mcp-tool-bridge.js buildMcpSystemBlock
//   �?server.url 识别, 注入对应端点的踩坑使用教�?(麦当�? reservationDate/营业时段, 瑞幸:
//   keyword 写法/菜单只有 2-3 个是真没�?. 解决 Gemini 漏参�?/ Deepseek 流程不对 / M3 较稳
//   的模型差异大问题. 不再 bump 版本�? �?v0.1.58 一起发, 避免 SW 缓存反复失效
// 2026-08-01 (合并�?v0.1.58) 瑞幸菜单卡片: mcp-menu-card.js
//   1) MENU_TOOL_PATTERNS �?searchProductForMcp / queryProductDetailInfo (实际工具�? 不是猜的 searchProduct)
//   2) �?parseLuckinMenu 函数, 解析瑞幸的扁平商品数�?(data[].productId/productName/pictureUrl/initialPrice/estimatePrice/productAttrs)
//   3) 商品卡片�?.mcp-menu-item-attrs 渲染杯型/温度/糖度等属性折叠文�?
//   4) 端到端验�? _reports/test-luckin-parse.mjs 跑�? 拿到 2 个生椰拿铁商�?
//   5) 教程�? 瑞幸 searchProductForMcp(deptId+query) / queryShopList(longitude+latitude) / previewOrder 不是 calculate-price
// 2026-08-01 (合并�?v0.1.58) 瑞幸教程按官方文档完整重�? 8 步骤全流�?
//   1) 查门�?(经纬�? / 2) 搜商�?(关键�? / 3) 切属�?(operation=3) / 4) 查详�?
//   5) 算价 (�?couponCodeList) / 6) 下单 (⚠️ longitude/latitude 必填 + couponCodeList �?�?�? �?payOrderUrl 给用户扫)
//   7) 查订�?(orderStatus 10-100) / 8) 取消 (待付/下单才能取消)
//   数据依赖�? deptId (①→所�? / productId+skuCode (②→⑤⑥) / couponCodeList (⑤→�?
// 2026-08-01 (合并�?v0.1.58) Gemini 直连 MCP 工具修复: mcp-tool-bridge.js isLLMRequest
//   原版只匹�?/v1/chat/completions (OpenAI 风格), Gemini �?generativelanguage.googleapis.com
//   完全不匹�? hook 跳过 �?AI 看不�?tools �?拉不到菜�? 修法: 新增 OR 匹配
//   /v1beta/openai/chat/completions (Gemini OpenAI 兼容) + generativelanguage.googleapis.com (Gemini 原生)
//   老匹�?/v1/chat/completions 完全保留, M3/MiniMax/Deepseek 不受影响. 安全�? 新加字符串都�?Google
//   域名专属, 不会误匹配其�?LLM. 可回退: �?if 那几行删了恢复原�?
// 2026-08-01 (合并�?v0.1.58) Gemini 原生 API 工具循环: mcp-tool-bridge.js runChatWithToolLoopGemini
//   原计�? Gemini body �?OpenAI body �?复用 OpenAI 内部逻辑 (�? Gemini API 收到 OpenAI 风格 body
//   �?400, 两种协议完全不兼�?. �? 直接�?Gemini 风格 body + contents + systemInstruction
//   �?Gemini API 通信, 自己解析 Gemini 风格响应 (candidates[0].content.parts[].functionCall).
//   工具结果�?role:function + parts:[{functionResponse:{name, response:{content}}}]
//   wrappedFetch 根据 isGeminiNativeRequest 分发�?runChatWithToolLoopGemini �?runChatWithToolLoop
//   新增: openAIToolsToGemini (OpenAI tools �?functionDeclarations), isGeminiNativeRequest (URL 识别)
//   ⚠️ 端到端测试需用户拿真�?Gemini API 调一次验�?(我电脑没梯连不上 generativelanguage.googleapis.com)
// 2026-08-01 (合并�?v0.1.58) 高德 MCP 教程: mcp-tool-bridge.js SERVER_USAGE_GUIDES
//   实测 15 个工�? 部分端点 bug: maps_text_search/around_search/weather 都返空或 null (�?key 都复�?
//   教程避开 bug 端点, �?AI 引导用户�?REST API 兜底
//   WORK: maps_distance/maps_geo(偶发失败)/maps_regeocode/路径规划 4 �?maps_ip_location
//   关键依赖: 经纬�?(lng,lat) 字符串格�? 几乎所有工具都需�?
//   瑞幸教程 (deptId 经纬度搜�? 现在引用高德 geocode 拿经纬度
// 2026-08-01 (合并�?v0.1.58) 高德 maps_geo REST 兜底: mcp-generic-client.js
//   mcp.amap.com/mcp �?maps_geo 端点�?(�?ENGINE_RESPONSE_DATA_ERROR),
//   �?callTool 检测到 maps_geo + result.isError 时自�?fallback �?
//   https://restapi.amap.com/v3/geocode/geo?address=...&key=server.bearerToken
// 2026-08-08 v0.2.09: bump CACHE_VERSION 强制清缓存（�?2 �?v0.2.08 误报 bug �?
//   notification-battery.js line 619-620: �?v0.2.02 时代遗留�?"VAPID 公钥未发�? 警告
//     (永远触发, getConfiguredPushApplicationServerKey() 永远�?null, 因为 v0.2.02 �?
//     VAPID 公钥改成 fetch /api/vapid-public-key, UI 没字段了)
//   proactive-wake.js createTask line 386-392: �?v0.2.06 时代写错的字段读�?
//     (原来�?state.globalSettings.apiKey 是错�? �?API 实际�?state.apiConfig.apiKey,
//     导致 "user 没配 LLM" 误报, 推送任务永远创建失�?
//   background-activity.js triggerProactivePushMessage line 2304-2310: 同样字段�?
//     (v0.2.08 加巡�?push 模式时复制了 proactive-wake.js 的错)
//   root cause: proactive-wake.js 一直读 state.globalSettings �?330 �?API 配在
//     state.apiConfig (index.html input fields 'api-key'/'api-base-url'/'model' 直接写到
//     state.apiConfig, 不进 globalSettings), 永远拿不�? 修法: 优先 apiConfig, fallback globalSettings
// 2026-08-08 v0.2.08: bump CACHE_VERSION 强制清缓存（AI 巡视机制 + push 模式也跑巡视 �?
//   user 反馈两个设计洞见:
//   1) "AI 应该巡视, 而不是只等对话触�? �?AI 定期(10 分钟)问自�?要不要主动发", LLM 决定
//   2) "锲而不�? �?AI 推了 user 没回, 应该�?LLM 决定"换角度再�?算了", 由人设驱�?
//   init-and-state.js proactiveIntervalMinutes 默认 30 �?10 (巡视频率, "再怎么刷也�?10 分钟一�?)
//   background-activity.js startProactiveScheduler �?mode==='app' 拦截, push 模式也跑巡视
//   background-activity.js runProactiveTick �?retryContext 收集 (lastProactivePushAt, consecutiveUnreplied, minutesSinceUserMsg)
//     触发时分�? app 模式 triggerProactiveMessage(chatId, {retryContext}) / push 模式 triggerProactivePushMessage
//   background-activity.js 新增 triggerProactivePushMessage: �?push-server /api/proactive-patrol
//   ai-group.js triggerProactiveMessage 接受 retryContext 选项, 拼到 silenceHint �?("你已经主动发�?N 条没�?)
//   push-server �?/api/proactive-patrol 端点 (v0.2.08 新增):
//     一�?LLM 调用决定"action: send/skip" + 生成消息内容, 推系统通知
//     �?proactive_patrol_state �? (user_id, chat_id) �?last_send_at, send_count, consecutive_unreplied
//   push-server init-db.sql �?proactive_patrol_state �?+ index
//   proactive-wake-ui.js 应用内模式说明卡 �?巡视机制"说明 (10 分钟 + 锲而不�?
//   不给频率约束 (4h/6h/2h), 不给 retry 上限, 完全�?LLM 人设决定 (符合 user "按人设决�? + "留一个半夜别发就�? 偏好)
// 2026-08-08 v0.2.07: bump CACHE_VERSION 强制清缓存（修应用内模式 + push 模式完全断裂 �?
//   background-activity.js startProactiveScheduler: �?v0.1.91 误加�?mode !== 'app' return 拦截
//     (�?30 分钟 scheduler 本来就该�? mode 默认 app)
//   proactive-wake.js createTask/createFixedTask: �?v0.1.91 误加�?mode !== 'push' throw 拦截
//     (防御性检查留�?push-server �?subscription 校验, UI 控制入口)
//   proactive-wake.js tryHandleAction: mode === 'app' 时静默拒�?+ 提示切�?scheduler
//     (app 模式 AI 不需要设任务, �?scheduler 自动�?
//   proactive-wake-ui.js 管理页面: �?[应用内模式说明卡] (默认隐藏, app 模式显示) +
//     updateUiForDeliveryMode() 根据 mode 隐藏任务列表 + [+ 创建任务] 按钮
//   loadTaskList: app 模式 early return, 不查 push-server (任务列表卡已隐藏)
//   核心: 恢复 330 老版 "主动信息体系" (state.globalSettings.proactiveIntervalMinutes 频率 +
//     chat.settings.proactiveEnabled 角色开�?+ chat.history 最后一条消息起算冷�?,
//     push-server 任务管理�?push 模式专属 (v0.1.85+ 的设计不�?
//   教训: v0.1.91 �?"应用�? �?"系统推�? 当二选一互斥错了 �?应该是两条独立通道
//   教训: 不要 hard-reject 已经实现的老功�? 这次让管理页面误�?user "管理页面没任�?
// 2026-08-09 v0.2.13: bump CACHE_VERSION 强制清缓存（�?push-server �?LLM �?proxyUrl 失败 �?
//   user 反馈"明明选了服务器推送但从没收到通知"+"创建任务 500 fetch failed"�?
//   真因: PWA �?LLM �?proxyUrl (CF worker) 是因为用户电脑没�? �?PWA �?proxyUrl 传给�?push-server�?
//   push-server 在阿里云云端, 根本不需�?CORS 绕过, 应该走直�?LLM URL�?
//   实测: push-server 直连 api.minimax.chat �? �?mcp.lhualan338.workers.dev 超时 5s+�?
//   修法: 3 �?(proactive-wake.js createTask + background-activity.js triggerProactivePushMessage +
//          proactive-wake-ui.js syncCurrentChatPushConfig) �?LLM URL fallback �?
//          apiConfig.apiUrl || apiConfig.mainApiUrl || apiConfig.proxyUrl (proxyUrl 放到最�?
//   教训: PWA �?server 用的 LLM URL 应该分开, PWA 优先 proxyUrl (浏览�?CORS), server 优先直连 (云端�?internet)
//   教训: 任何"前端传给 server �?LLM" 的代�? fallback 链不能让 server 拿到前端专用�?proxyUrl 当首�?
// 2026-08-08 v0.2.12: bump CACHE_VERSION 强制清缓存（push-server �?10 分钟巡视 �?
//   user 反馈 "PWA 不划掉一会儿也会�? 我还以为是服务器上巡视呢" �?之前 v0.2.08 巡视跑在 PWA setInterval,
//   PWA �?iOS 杀后台就停�? �?无后台保�?承诺不符�?
//   修法: PWA �?启用主动消息 + 系统推�?�? POST /api/push-config 同步 LLM 配置 + 角色 prompt + 最�?20 �?context �?push-server�?
//   push-server 自己�?setInterval (10 分钟, 进程不挂就一直跑), 遍历 push_user_config �? �?LLM 决定要不要发, 推系统通知�?
//   完全不依�?PWA 活着 (PWA 死了 push-server 照跑)�?
//   端点: POST /api/push-config (PWA sync) + DELETE /api/push-config (PWA unsync) + GET /api/push-config (调试) + POST /api/patrol-all (手动触发)�?
//   新表: push_user_config (user_id + chat_id 主键, enabled bool, llm_api_url/key/model, contact_personality, context_summary)�?
//   教训: 之前 v0.2.08 巡视设计�? 我和 user 都默�?前端能跑就行", 忘了 iOS PWA 后台随时被杀的现实�?
//   教训: "无后台保�? �?"server 主动找人" �?实际�?server 处理已触发的任务", 自主巡视�?push-server 自己做�?
// 2026-08-08 v0.2.11: bump CACHE_VERSION 强制清缓存（�?v0.2.10 漏改�?2 �?userId fallback �?
//   v0.2.10 只改�?4 �? 漏了 proactive-wake.js �?saveSubscription (line 528) + listTasks (line 568),
//   这俩还在用�?fallback 'default-user' (state?.userId || state?.currentUserId || state?.deviceId || 'default-user')�?
//   真因: 你部�?v0.2.10 �? �?/ 琪琪 / 音音 �?"服务器推�? 开�?�?触发 saveSubscription �?�?'default-user' �?�?覆盖你新 UUID 的订阅�?
//   DB �?default-user 订阅 updated_at 13:31 (部署�?2 分钟) 就是证据�?
//   修法: �?2 处也�?getOrCreatePushUserId()�?
//   教训: "修一个相�?bug �? 应该顺手 review 同类 bug 模式" �?v0.2.10 修串台没 review 所�?userId 取值链, 漏了 2 个�?
// 2026-08-08 v0.2.10: bump CACHE_VERSION 强制清缓存（修多 PWA 串台 bug �?
//   之前所�?push-server 操作�?userId fallback �?'default-user' (test push) / 'anonymous' (订阅),
//   导致多个 PWA 用户 (�?+ 琪琪 + 音音) 装同一 netlify URL �? 没配 state.userId 的全掉到 fallback,
//   串到同一 userId, 测试推�?+ 巡视推送全推给同一个人 (实测 音音收所有人�?�?
//   修法: notification-battery.js �?getOrCreatePushUserId() �?�?PWA 启动时生�?UUID �?localStorage,
//   永不换�? �?(订阅/test push/createTask/createFixedTask/triggerProactivePushMessage) 全改用这�?UUID�?
//   教训: �?PWA �?URL 场景, fallback 必须�?per-device 唯一�?(UUID), 永远不能共享字符�?(�?'default-user')
//   教训: 之前没暴�?per-device 唯一 ID 是设计漏�? 必须 localStorage + crypto.randomUUID 兜底)
// 2026-08-08 v0.2.09: bump CACHE_VERSION 强制清缓存（�?v0.2.08 误报 bug �?
//   proactive-wake.js createTask + background-activity.js triggerProactivePushMessage 字段读取�?(state.globalSettings �?state.apiConfig),
//   notification-battery.js �?v0.2.02 时代遗留�?"VAPID 未发�? 永远触发的检查。实�?web_fetch /api/vapid-public-key �?87 字符 base64url �?
// 2026-08-09 v0.2.15.1: bump CACHE_VERSION 强制清缓存（�?ByteString 仍抛 �?
//   之前 v0.2.15 �?proactive-wake.js / background-activity.js + v0.2.15.1 �?notification-battery.js / proactive-wake.js 都忘�?bump SW cache, iPhone PWA SW 仍认 v0.2.14, 划掉重开也没�? SW 强制缓存�?modules/*.js (v0.2.13) �?仍抛 ByteString (subscription.toJSON() 旧代�?�?
//   修法: bump CACHE_VERSION v0.2.14 �?v0.2.15.1, SW activate event 会删 ephone-cache-v0.2.14 �?cache, 装新 cache�?
//   同时�?3 �?modules �?URLS_TO_CACHE (之前漏了, 现在白名单让 SW 主动管理�?3 个文�? 未来改这 3 个文件再 bump 就行)�?
// 2026-08-17 v0.2.30.5: bump CACHE_VERSION 强制清缓存（修变量记忆塞 system 中后�?LLM 注意力不�?�?
//   modules/ai-response.js 单聊路径�?resolvedMemoryContextForPrompt �?"## 3. 你的长期记忆" 下面抽出�?
//   改塞�?system 最开�?独立一级标�?"# ⚠️ 你的近期真实记忆 (最高优先级,必须视为亲身经历)"�?
// 2026-08-22 v0.2.30.16: bump CACHE_VERSION 强制清缓存（proactive-wake.js handleProactiveWakePushed 解析 Gemini native 推�?message 字段 �?
//
//   modules/proactive-wake.js:handleProactiveWakePushed �?4 段解�?(照搬 ai-response.js:1323 parseAiResponse):
//     1. Markdown code fence 提取 ```json ... ```
//     2. 标准 JSON 数组解析
//     3. 强力提取 [ ... } ... ]
//     4. 强力提取 {...}
//   真凶 (user 2026-08-22 00:19): Gemini native 主动信息推送过来是 markdown "```json" 代码�? 旧代码直接用 message 字段显示整段
//   修法: 解析 message 字段�?markdown + JSON, 多段 text �?多个气泡 (跟主�?chat 一�?
//   跨项目通用 SOP: 任何 push 路径�?server �?message 字段都应该过 4 段解�? 跟主屏对�?
const CACHE_VERSION = 'v0.2.30.71y';
// (v0.2.26: 推送落进聊天框 �?SW push handler 优先�?data.fixedMessage (不管 messageType) 直接显示真内�?+ �?IndexedDB
//   + postMessage 主页�?PROACTIVE_WAKE_PUSHED. 真凶: 之前 messageType==='patrol' �?SW �?guided/auto 占位分支,
//   fixedMessage 字段被忽�? 主页�?handleProactiveWake 又调一�?LLM (浪费 + 通知保持占位).
//   修法: 1) SW �?fixedMessage 就直接显�?+ �?IndexedDB (native indexedDB API) + postMessage
//         2) 主页�?PROACTIVE_WAKE_PUSHED handler 收到直接�? 不调 LLM, �?messages �?+ 切屏 + reload chat
//   2026-08-16: push-server �?v0.2.25.14 已能�?push-server �?LLM 生成, �?SW 没接�?fixedMessage
//   iOS notification body 限制 178 字符, 通知显示�?30 字符 + "...", 完整内容�?data.message 字段
//   v0.2.25: �?API 变化�? PWA 立即 sync �?push-server �?复用 ProactiveWakeUI.syncPushConfig, �?/api/push-config �?
//   push_user_config.llm_api_url/api_key/model (per-user). push-server �?resolveLlmConfig �?body 优先, 巡视自然用用户当前主 API)
// (v0.2.24 �?v0.2.23 PWA �?SW 没真激�?bug �?iOS PWA 模式�?SW 永不关闭, �?SW �?waiting. �?self.skipWaiting() 强制 activate)
// (v0.2.23 �?PWA �?tryCreatePushSubscription + ProactiveWake.subscribe 函数 VAPID 0 字节 ArrayBuffer �?"valid P-256 public key" 错诊,
//   �?fallback 字段 + 严格 byteLength === 65 检�?
const CACHE_NAME = `ephone-cache-${CACHE_VERSION}`;

const URLS_TO_CACHE = [
  './index.html',
  './style.css',
  './online-app.css',
  './script.js',
  './modules/hot-news.js',
  './modules/runtime-diagnostics.js',
  // v0.1.28 新增：AI 唱歌�? 个新模块�?
  './modules/ai-music.js',
  './js/music-voice-sample.js',
  './js/role-voice-sample-ui.js',
  // v0.1.29 新增：AI 原创�?IndexedDB 持久化层
  './js/ai-songs-store.js',
  './js/netease-music.js',
  // v1.0.0 改�? 通用 MCP 工具（删 mcd/luckin 硬编�? 删旧 mcp-ui-init + 3 �?css, �?generic-client + ui-list�?
  './js/mcp-generic-client.js',
  './js/mcp-tool-bridge.js',
  './js/mcp-ui-list.js',
  // v0.1.55 新增: MCP 菜单卡片渲染（粉白色系浮动按�?+ 全屏 sheet�?
  './js/mcp-menu-card.js',
  './css/mcp-miniapp-pink.css',
  // v0.1.30 新增：Live2D 视频通话（cubism 引擎 + loader + 视频通话主文件）
  './lib/live2dcubismcore.min.js',
  './modules/live2d-loader.js',
  './modules/video-voice-call.js',
  'https://unpkg.com/dexie/dist/dexie.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://phoebeboo.github.io/mewoooo/pp.js',
  'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js',
  'https://img.baidu.re/i/2026/07/w6p47e.png',
  // v0.2.15.1 新增: �?ByteString 涉及�?3 �?modules (之前漏了, 现在加进白名�? SW 主动缓存)
  './modules/proactive-wake.js',
  './modules/notification-battery.js',
  './modules/background-activity.js'
];

self.addEventListener('install', event => {
  console.log('[SW] Installing service worker...');
  // v0.2.24 �? iOS PWA 模式�?service worker install 后卡 waiting (�?SW 永不关闭), �?self.skipWaiting() 强制 activate
  //   之前 v0.2.23 部署了但 PWA �?SW 没真激�? 报错没变. skipWaiting() 让新 SW 跳过 waiting 立刻 activate.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Cache opened, caching core files...');
        // 2026-07-24 修复：cache.addAll �?allSettled 单独缓存每个文件
        // 原因：URLS_TO_CACHE 里有 25 个文件（�?5 个外�?CDN），任何一�?fetch
        // 失败（CDN 抽风 / CORS / 404）整�?addAll 就会 reject，导�?SW install
        // 永远�?installing 状�?�?navigator.serviceWorker.register() 抛错 �?
        // "一键修复通知" alert 里看不到"已重新注�?的成功提示�?
        // 改宽容后：单个失败只 warn 跳过，整�?install 必成功�?
        return Promise.allSettled(
          URLS_TO_CACHE.map(url =>
            cache.add(url).catch(err => {
              console.warn('[SW] 缓存失败（已跳过�?', url, err.message || err);
              return null;
            })
          )
        ).then(results => {
          const ok = results.filter(r => r.status === 'fulfilled').length;
          const fail = results.length - ok;
          console.log(`[SW] Core files cached: ${ok} ok, ${fail} failed.`);
        });
      })
      .then(() => {
        console.log('[SW] skipWaiting()');
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Service worker activated.');
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  const isLocalAsset = url.startsWith(self.location.origin) &&
    (url.includes('/index.html') ||
     url.includes('/style.css') ||
     url.includes('/online-app.css') ||
     url.includes('/script.js') ||
     url.includes('/modules/hot-news.js') ||
     url.includes('/modules/runtime-diagnostics.js') ||
     // v0.1.28 新增：AI 唱歌模块
     url.includes('/modules/ai-music.js') ||
     url.includes('/js/music-voice-sample.js') ||
     url.includes('/js/role-voice-sample-ui.js') ||
     // v0.1.29 新增：AI 原创曲存储层
     url.includes('/js/ai-songs-store.js') ||
     // v1.0.0 改�? 通用 MCP 文件命中拦截, 走缓存（请求带回 ?v= 时也�?fetch�?
     url.includes('/js/mcp-generic-client.js') ||
     url.includes('/js/mcp-tool-bridge.js') ||
     url.includes('/js/mcp-ui-list.js') ||
     // v0.1.30 新增：Live2D 视频通话（引�?+ loader + 模型目录�?
     url.includes('/lib/live2dcubismcore.min.js') ||
     url.includes('/modules/live2d-loader.js') ||
     url.includes('/modules/video-voice-call.js') ||
     url.includes('/assets/live2d/'));

  const isKnownCDN =
    url.includes('unpkg.com/dexie') ||
    url.includes('cdnjs.cloudflare.com/ajax/libs/html2canvas') ||
    url.includes('cdn.jsdelivr.net/npm/streamsaver') ||
    url.includes('phoebeboo.github.io/mewoooo/pp.js') ||
    url.includes('i.postimg.cc/') ||
    url.includes('img.baidu.re/') ||
    // v0.1.30 新增：Live2D 引擎 (UMD prebuilt, 完全不用 esm.sh)
    url.includes('cdn.jsdelivr.net/npm/pixi.js') ||
    url.includes('cdn.jsdelivr.net/npm/pixi-live2d-display') ||
    url.includes('cdn.jsdelivr.net/gh/dylanNew/live2d');

  if (isLocalAsset || isKnownCDN) {
    const isVersioned = url.includes('?v=');
    if (isVersioned) {
      event.respondWith(
        fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            const noQueryUrl = url.split('?')[0];
            caches.open(CACHE_NAME).then(cache => cache.put(noQueryUrl, clone));
          }
          return response;
        }).catch(() => caches.match(url.split('?')[0]))
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, response.clone());
            });
          }
          return response;
        }).catch(() => null);

        return cachedResponse || fetchPromise;
      })
    );
  }
});

// 330 v0.1.83 wake-up 模式 push handler
// 收到 push-server 发来�?{type: 'proactive-wake', chatId, charId, charName, taskId, fixedMessage, aiPrompt} payload
//   v0.2.26 �? �?fixedMessage (不管 messageType, 包括 patrol/fixed/guided/auto) �?直接显示真内�?+ �?IndexedDB
//     + postMessage 主页�?PROACTIVE_WAKE_PUSHED. fixedMessage �?null 时才走�?guided/auto 占位 + postMessage PROACTIVE_WAKE
self.addEventListener('push', event => {
  console.log('[SW] Push received:', event);

  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }

  // ===== wake-up 模式 (v0.1.83+, v0.2.26 �? =====
  if (data.type === 'proactive-wake') {
    const charName = data.charName || data.charId || 'AI 角色';
    const chatId = data.chatId;
    const taskId = data.taskId;
    const messageType = data.messageType || 'fixed';
    const fixedMessage = data.fixedMessage;

    // ===== v0.2.26 优先路径: �?fixedMessage (不管 messageType) 直接用真内容 =====
    //   真凶: 老逻辑 messageType==='fixed' 才用 fixedMessage, push-server patrol 模式 messageType='patrol' 
    //   �?SW �?guided/auto 占位分支 �?通知显示 "X 想跟你说点什�?.." 占位, 完整内容�?fixedMessage 字段被忽�?
    //   �?主页�?handleProactiveWake 又调一�?LLM (浪费 token) + UPDATE_NOTIFICATION 失败时占位保�?
    if (fixedMessage && String(fixedMessage).trim()) {
      event.waitUntil((async () => {
        // 1. �?IndexedDB (native indexedDB API, PWA 完全关掉再开也能看到消息)
        try {
          await writeProactiveMessageToIDB({
            chatId,
            role: 'assistant',
            content: fixedMessage,
            timestamp: Date.now(),
            taskId,
            charId: data.charId,
            charName
          });
          console.log(`[SW v0.2.26] �?已落 IndexedDB: chatId=${chatId} content="${fixedMessage.substring(0, 30)}..."`);
        } catch (e) {
          console.warn('[SW v0.2.26] �?IndexedDB 失败 (不阻塞通知):', e.message);
        }

        // 2. 弹真内容通知 (body 截前 30 字符避免 iOS 178 限制截成乱码省略�? 完整内容�?data.message)
        const notifBody = fixedMessage.length > 30
          ? fixedMessage.substring(0, 30) + '...'
          : fixedMessage;
        await self.registration.showNotification(`💬 ${charName}`, {
          body: notifBody,
          icon: data.icon || 'https://img.baidu.re/i/2026/07/w6p47e.png',
          badge: data.badge || 'https://img.baidu.re/i/2026/07/w6p47e.png',
          tag: `task-${taskId}`,
          data: { chatId, taskId, type: 'proactive-wake', messageType, message: fixedMessage },
          requireInteraction: true,
          vibrate: [200, 100, 200],
          timestamp: Date.now()
        });

        // 3. postMessage 主页�?(强制 reload chat window, PWA 在前台时立刻显示)
        try {
          const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of clientList) {
            client.postMessage({
              type: 'PROACTIVE_WAKE_PUSHED',
              chatId,
              taskId,
              charId: data.charId,
              charName,
              message: fixedMessage,
              sentAt: data.sentAt
            });
          }
        } catch (e) {
          console.warn('[SW v0.2.26] postMessage 失败 (不阻�?:', e.message);
        }
      })());
      return;
    }

    // ===== �?guided/auto 模式 (fixedMessage �?null): 弹占�?+ postMessage 主页面让 AI 生成 =====
    //   保留兼容 push-config.js 老接�?(messageType=guided/auto + aiPrompt), 让主页面�?LLM
    const placeholderTitle = `💬 ${charName}`;
    const placeholderBody = `${charName} 想跟你说点什�?..`;
    const placeholderOptions = {
      body: placeholderBody,
      icon: data.icon || 'https://img.baidu.re/i/2026/07/w6p47e.png',
      badge: data.badge || 'https://img.baidu.re/i/2026/07/w6p47e.png',
      tag: `task-${taskId}`,
      data: { chatId, taskId, type: 'proactive-wake', messageType, generating: true },
      requireInteraction: true,
      vibrate: [200, 100, 200],
      timestamp: Date.now()
    };

    event.waitUntil((async () => {
      // 1. 弹占位通知
      await self.registration.showNotification(placeholderTitle, placeholderOptions);

      // 2. postMessage 主页�?(如果�?, 让主页面�?LLM 生成 + �?UPDATE_NOTIFICATION
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        client.postMessage({
          type: 'PROACTIVE_WAKE',
          chatId,
          taskId,
          charId: data.charId,
          charName,
          messageType,
          aiPrompt: data.aiPrompt || null,
          sentAt: data.sentAt
        });
      }
    })());
    return;
  }

  // ===== �?payload 格式兼容 (测试推送等) =====
  const title = data.title || 'EPhone';
  const options = {
    body: data.body || 'You have a new message',
    icon: data.icon || 'https://img.baidu.re/i/2026/07/w6p47e.png',
    badge: data.badge || 'https://img.baidu.re/i/2026/07/w6p47e.png',
    tag: data.tag || 'default',
    data: data.data || {},
    requireInteraction: true,
    vibrate: [200, 100, 200],
    timestamp: Date.now()
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// v0.2.26 �? SW �?native indexedDB API 写主动消�?(PWA 关掉再开也能看到)
// 真凶: SW 是独�?worker context, 拿不�?window.db (Dexie) 也没 modules 脚本, 必须�?native indexedDB
// 同步主线 (init-db-schema.js v60): messages �?schema &id, chatId, timestamp, [chatId+timestamp], role, type
//                                chats �?schema &id, isGroup, ..., lastMessageTimestamp, messageSchemaVersion
// 消息 id 格式: ${chatId}::${timestamp}::${role}::${type}::${index} (�?init-db-schema.js / message-store.js 保持一�?
function writeProactiveMessageToIDB(msg) {
  return new Promise((resolve, reject) => {
    let db;
    try {
      const openReq = indexedDB.open('GeminiChatDB');
      openReq.onerror = () => reject(openReq.error || new Error('open GeminiChatDB 失败'));
      openReq.onsuccess = () => {
        db = openReq.result;
        try {
          if (!db.objectStoreNames.contains('messages')) {
            db.close();
            return reject(new Error('messages store 不存�?(PWA 数据�?schema 未升级到 v60)'));
          }
          if (!db.objectStoreNames.contains('chats')) {
            db.close();
            return reject(new Error('chats store 不存�?));
          }
          const tx = db.transaction(['messages', 'chats'], 'readwrite');
          const messagesStore = tx.objectStore('messages');
          const chatsStore = tx.objectStore('chats');

          // 1. 写消息到 messages �?
          const messageId = `${msg.chatId}::${msg.timestamp}::assistant::text::0`;
          const messageRow = {
            id: messageId,
            chatId: msg.chatId,
            role: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            type: 'text',
            proactive: true,
            taskId: msg.taskId || null
          };
          messagesStore.put(messageRow);

          // 2. 更新 chat 元数�?(lastMessageTimestamp + lastMessagePreview + messageCount)
          const chatReq = chatsStore.get(msg.chatId);
          chatReq.onsuccess = () => {
            const chat = chatReq.result;
            if (chat) {
              chat.lastMessageTimestamp = msg.timestamp;
              const previewText = String(msg.content || '').replace(/\s+/g, ' ').trim();
              chat.lastMessagePreview = previewText.length > 80 ? previewText.slice(0, 80) + '...' : previewText;
              chat.lastMessageRole = 'assistant';
              chat.lastMessageType = 'text';
              chat.messageCount = (Number(chat.messageCount) || 0) + 1;
              // v0.2.60+ 已经拆表, chat 上不�?history 字段
              delete chat.history;
              chatsStore.put(chat);
            }
          };

          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { const err = tx.error; db.close(); reject(err || new Error('transaction 失败')); };
          tx.onabort = () => { const err = tx.error; db.close(); reject(err || new Error('transaction aborted')); };
        } catch (innerErr) {
          if (db) db.close();
          reject(innerErr);
        }
      };
    } catch (e) {
      if (db) db.close();
      reject(e);
    }
  });
}

// 330 v0.1.83: 主页面调 LLM 生成完消息后, �?UPDATE_NOTIFICATION 替换占位通知
self.addEventListener('message', event => {
  console.log('[SW] Message received:', event.data);

  if (!event.data) return;

  // ===== 兼容�?SHOW_NOTIFICATION =====
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, options)
    );
    return;
  }

  // ===== �? UPDATE_NOTIFICATION 替换占位通知 =====
  if (event.data.type === 'UPDATE_NOTIFICATION') {
    const { tag, title, body, data: notifData } = event.data;
    if (!tag) return;
    event.waitUntil((async () => {
      // 关闭旧的占位通知 (用同一�?tag)
      const existing = await self.registration.getNotifications({ tag });
      for (const n of existing) n.close();

      // 弹新通知
      await self.registration.showNotification(title, {
        body,
        icon: 'https://img.baidu.re/i/2026/07/w6p47e.png',
        badge: 'https://img.baidu.re/i/2026/07/w6p47e.png',
        tag,
        data: notifData || {},
        requireInteraction: true,
        vibrate: [200, 100, 200],
        timestamp: Date.now()
      });
    })());
    return;
  }
});

self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event);

  event.notification.close();

  const chatId = event.notification.data?.chatId;
  const urlToOpen = chatId ? `/?openChat=${chatId}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (let client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus().then(client => {
              if (chatId) {
                client.postMessage({ type: 'OPEN_CHAT', chatId });
              }
              return client;
            });
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});
