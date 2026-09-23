# 120 秒下班

一款竖屏低模 3D 斜俯视办公室射击撤离小游戏。玩家需要在 120 秒内手动射击怪物、管理弹药、拾取门禁卡，并在老板追击下进入电梯成功下班。

## 当前功能

- Three.js 低模办公室地图、正交相机、灯光、障碍碰撞和敌人寻路。
- PC 键盘/指针与移动端摇杆操作。
- 手动冲锋枪、射线命中、弹匣换弹、后备弹药和地图补给。
- Bug 怪、需求变更怪、会议怪和老板的分阶段刷新。
- 区域巡逻、感知调查、共享流场、稳定接近槽位、拥堵让行和自动脱困组成的完整怪物 AI。
- Bug／需求变更／PPT 怪分别最多同时存在 5／4／3 只，老板使用独立槽位。
- 泡泡膨胀、烟雾和怪物显形组成的出生提示效果。
- 门禁卡、电梯开放、撤离读条与成功/失败结算。
- 升级暂停与选择面板，已实现「火力校准」和「弹匣管理」Lv1-Lv5。
- 顶部倒计时、右上状态区、左上实时小地图和开局短暂显示的通关目标。
- 移动端 Safari 文字选择、双击、双指和 gesture 手势防护。

开发中的详细状态见 [开发进度](docs/开发进度.md)。

## 技术栈

- TypeScript
- Vite
- Three.js
- HTML/CSS HUD

## 快速开始

需要 Node.js 和 npm。可使用 `make` 命令：

```bash
make install
make dev
```

开发服务默认监听 `0.0.0.0:6173`。本机访问：

```text
http://localhost:6173
```

检查角色蒙皮和动作时，可打开独立的角色动作验收台：

```text
http://localhost:6173/character-preview.html
```

验收台默认加载仓库根目录下的 `ksman_v3_walk_1k_meshopt.glb`，支持旋转、缩放、播放暂停、逐帧拖动、播放速度、循环和骨骼显示；也可以直接拖入其他 `.glb` 文件进行对比。

在「Idle / Walk / Shoot 切换测试」中，按住空格或「按住移动」按钮播放 Walk，松开回 Idle；按 F 或「播放 Shoot」触发一次射击动作。「自动完整流程」每 3 秒交替站立与移动，并在每段开始 0.75 秒后触发 Shoot，依次检查 `Idle → Shoot → Idle` 和 `Walk → Shoot → Walk`。射击过程中改变移动意图不会打断 Shoot，动作结束后会回到最新的 Idle／Walk。速度滑块同时影响动作与过渡，调到 0.25× 可观察 Idle、Walk、Shoot 的混合权重。支持暂停、快速重复 Shoot、触控移出按钮后释放和失焦释放；切回单动作模式仍可拖动时间轴。缺少 Idle 或 Walk 的模型禁用切换测试，缺少 Shoot 时射击和自动流程按钮禁用。验收时检查身体不歪斜、手臂不抽动、脚底不突然升降、Shoot 不被移动覆盖，以及结束后回退正确。此模式复用游戏的 `CharacterAnimationController`，不会模拟角色在地图上的位移；最后仍需在游戏中用键盘和触控验收。

`npm run test:animation` 检查初始姿势、权重归一化、中途反向切换、一次性 Shoot、移动时不被覆盖、结束后回退、快速重复射击、循环、单 Walk 模型兼容及实例独立性。`npm run build` 同时构建游戏和 `character-preview.html`。

主角的 Idle 使用原始 Mixamo 动画第 2–5 秒（30 FPS 下第 61–151 帧），重新计时为 0–3 秒。合并时根据同一帧的父子骨骼矩阵转换到基础骨架，逐帧核对姿态，不清零非根骨骼位移、不强制缩放。前 2.4 秒保留原动作，最后 0.6 秒（18 帧）用五次缓动接回开头的姿势和运动方向，使循环接缝连续，避免突然跳回或先停顿再启动；不对整段动作额外平滑。

重新生成主角动画（原始 FBX 保留在本地）：

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b --python-exit-code 1 \
  --python scripts/merge_character_animations.py -- \
  ksman_v3_walk.fbx ksman_v3_walk.glb \
  --clip Idle=ksman_v3_idle.fbx --clip-range Idle=61:151 \
  --clip-loop-blend Idle=18 \
  --clip Shoot=ksman_v3_shoot.fbx --clip-forearm-twist Shoot=Left:0.5 --force
npx --yes @gltf-transform/cli@4.5.0 optimize \
  ksman_v3_walk.glb ksman_v3_walk_1k_meshopt.glb \
  --compress meshopt --meshopt-level medium --resample false \
  --texture-compress webp --texture-size 1024
```

这里保留动画采样精度，避免压缩步骤再次引入手指旋转误差；`Walk` 和 `Idle` 共用同一个模型与骨架。

Shoot 左手与前臂相对于绑定姿势的变形存在约 140° 扭转差，会使线性蒙皮在腕部拧细；这里不是人体腕关节角度。`--clip-forearm-twist Shoot=Left:0.5` 将一半扭转分摊到左前臂，再补偿手部局部变换，保持手掌／手指的世界姿势和所有关节位置。此修正只作用于 Shoot，不改模型权重或 Idle／Walk；再生成时应保留该选项。

排查证据、修复原理、参数适用范围及前后对比方法记录在 [角色动画调优经验](docs/角色动画调优经验.md)。遇到手腕变细、扭转塌缩或类似“莲藕人”现象时可从这里开始排查。

循环回归检查：`node scripts/validate_character_loop.mjs ksman_v3_walk_1k_meshopt.glb`。检查 65 根骨骼的首尾姿势、接缝速度、连续循环和克隆实例独立性；可追加改动前 GLB 的路径，验证前 2.4 秒以及整个 `Walk` 没有变化。

也可直接使用 npm：

```bash
npm install
npm run dev
```

## 常用命令

```bash
make dev       # 启动开发服务，端口 6173
make build     # TypeScript 检查并构建
make test-ai   # 运行 AI 状态、日志与人群移动测试
make test-navigation # 运行寻路缓存、体型和动态障碍测试
make preview   # 预览生产构建，端口 6174
```

## 操作

### PC

| 输入 | 功能 |
|---|---|
| WASD / 方向键 | 移动并改变朝向 |
| J / 鼠标左键 | 射击 |
| 鼠标移动 | 停止移动时调整瞄准 |
| R | 换弹 |
| 1 / 2 / 3 | 选择升级项 |
| F3 | 开关怪物 AI 调试层 |

### 移动端

| 输入 | 功能 |
|---|---|
| 左下角摇杆 | 移动并改变朝向 |
| 右下角射击按钮 | 按住连续射击 |
| 换弹按钮 | 主动换弹 |
| 升级卡片 | 选择升级项 |

## 怪物 AI 调试

阶段 A 已支持可复现的怪物生成和运行时调试。参数可以组合使用：

```text
http://localhost:6173/?aiDebug=1&aiSeed=120&aiEnemy=meeting
```

- `aiDebug=1`：进入游戏时打开调试层；运行中可按 F3 开关。
- `aiSeed=120`：固定怪物种类、出生位置和环绕参数的随机序列。
- `aiEnemy=meeting`：强制普通刷新使用指定怪物；支持 `bug`、`changeRequest`、`meeting` 和 `boss`。

## 手机端性能日志

开发服务内置了同源性能日志收集接口。使用 `perf=1` 开启采集，建议先关闭 AI 可视化以获得基准数据：

```text
http://<开发机局域网 IP>:6173/?perf=1&aiSeed=120&aiEnemy=meeting
```

页面左下角出现 `PERF REC` 表示采集已开启。采集器只上报超过 50ms 的长帧、怪物生成事件和每 5 秒一次的汇总，不会逐帧发送请求。可以用 `perfThreshold=80` 调整长帧阈值。

日志写入开发机的 `.performance-logs/performance-YYYY-MM-DD.jsonl`，包含：

- 游戏更新、敌人更新和渲染耗时。
- 怪物生成种类及同步生成耗时。
- 寻路调用、流场命中／重建次数及重建耗时。
- 怪物 AI 的 failure 汇总、根因分类、卡住数量和最长持续时间；异常怪物会附带 ID、种类、状态、位置、目标及恢复等级。
- 怪物进入或恢复 `noDirection`／`insufficientProgress` 时记录一次状态转换，不逐帧重复上报。
- failure 根因会在 0.5 秒窗口内区分 `noFlowDirection`、`blockedWaypoint`、`staticCollision`、`crowdBlocked`、`invalidSlot` 与兜底的 `unclassified`；接近位未分配也会区分无效目标和容量已满。
- 怪物持续卡住时会依次执行安全格回中、相邻格绕行和高净空绕行；恢复事件会携带实际触发的 `recoveryLevel`。
- 怪物深度重叠对、修正应用、最大重叠量、恢复优先、双恢复让行、侧向让路、前进约束、静态碰撞阻挡和修正后残留重叠。
- 接近槽位的可分配怪物数、两圈占用、未分配数、换位、失效、无效目标、容量不足和释放次数。
- 敌人数、动画怪物数、draw calls、三角形、几何体和纹理数量。
- 浏览器允许时记录 JS heap；不支持的手机浏览器会省略内存字段。

日志目录已加入 `.gitignore`，仅用于本地诊断。

### 双恢复窄通道专项测试

开发服务提供独立的确定性压力场景，不需要在正式地图里等待怪物随机相遇：

```text
http://<开发机局域网 IP>:6173/crowd-test.html
```

页面会加载正式游戏使用的 PPT 怪和 Bug 怪 Meshopt GLB，让两只处于双恢复状态的怪物在窄通道中迎面相遇，约 8 秒后自动显示 `PASS` 或 `FAIL`。判定会检查稳定通行权、侧向让行、成功错身、failure 恢复、三级恢复、重复 failure 和静态碰撞安全；结果同时以 `crowd-stress-*` 会话写入性能日志。该入口完全独立于正式游戏，不向 `main.ts` 增加测试逻辑。

### 全平台动态点光源策略

所有平台默认关闭子弹、枪口、命中、补给、Boss 和任务信标等数量会变化的点光源，避免 WebGL 因灯光数量变化重新编译 shader 而产生长帧。发光 Mesh、固定环境灯和角色常驻灯保持不变。

性能诊断时可显式指定两种模式：

```text
http://<开发机局域网 IP>:6173/?perf=1&perfLights=off
http://<开发机局域网 IP>:6173/?perf=1&perfLights=on
```

- `perfLights=off`：显式关闭动态点光源。
- `perfLights=on`：强制开启动态点光源，仅用于回归对照和后续灯光池实验。
- 省略参数：手机和桌面端均关闭。

左下角显示 `PERF REC · LIGHTS OFF` 表示当前动态点光源已关闭。日志会记录选择原因、当前点光源数量、可见动态点光源数量和已编译 shader program 数。

## 项目结构

```text
.
├── docs/          # 需求、技术方案、数据配置、任务与开发进度
├── src/
│   ├── ai/         # 怪物 AI 运行时、调试层和可复现随机
│   ├── effects/    # 怪物出生等轻量表现效果
│   ├── ui/         # 小地图等独立 UI 逻辑
│   ├── main.ts    # 游戏主循环、场景和玩法编排
│   ├── config.ts  # 数值与升级配置
│   ├── input.ts   # 键盘、指针和摇杆输入
│   ├── performance/ # 手机端长帧与运行时指标采集
│   ├── weapon.ts  # 枪械、弹匣和换弹状态
│   ├── combat.ts  # 射线命中计算
│   └── navigation.ts
├── tests/         # 导航等可重复运行的逻辑测试
├── Makefile
└── package.json
```

## 项目文档

- [MVP 需求文档](docs/120秒下班_MVP需求文档_v0.1.md)
- [MVP 技术实现方案](docs/120秒下班_MVP技术实现方案_v0.1.md)
- [MVP 开发任务列表](docs/120秒下班_MVP开发任务列表_v0.1.md)
- [MVP 数据配置表](docs/120秒下班_MVP数据配置表_v0.1.md)
- [怪物 AI 与自动寻路设计](docs/怪物AI与自动寻路设计_v0.1.md)
- [角色动画、战斗表现与武器系统设计](docs/角色动画、战斗表现与武器系统设计_v0.1.md)
- [开发进度](docs/开发进度.md)
