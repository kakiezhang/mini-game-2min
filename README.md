# 120 秒下班

一款竖屏低模 3D 斜俯视办公室射击撤离小游戏。玩家需要在 120 秒内手动射击怪物、管理弹药、拾取门禁卡，并在老板追击下进入电梯成功下班。

## 当前功能

- Three.js 低模办公室地图、正交相机、灯光、障碍碰撞和敌人寻路。
- PC 键盘/指针与移动端摇杆操作。
- 手动冲锋枪、射线命中、弹匣换弹、后备弹药和地图补给。
- Bug 怪、需求变更怪、会议怪和老板的分阶段刷新。
- 门禁卡、电梯开放、撤离读条与成功/失败结算。
- 升级暂停与选择面板，已实现「火力校准」和「弹匣管理」Lv1-Lv5。
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

也可直接使用 npm：

```bash
npm install
npm run dev
```

## 常用命令

```bash
make dev       # 启动开发服务，端口 6173
make build     # TypeScript 检查并构建
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
- 敌人数、动画怪物数、draw calls、三角形、几何体和纹理数量。
- 浏览器允许时记录 JS heap；不支持的手机浏览器会省略内存字段。

日志目录已加入 `.gitignore`，仅用于本地诊断。

### 动态点光源 A/B 诊断

使用 `perfLights=off` 可以关闭子弹、枪口、命中、补给、Boss 和任务信标等数量会变化的点光源；发光 Mesh、固定环境灯和角色常驻灯保持不变：

```text
http://<开发机局域网 IP>:6173/?perf=1&perfLights=off
```

左下角显示 `PERF REC · LIGHTS OFF` 即表示实验组已生效。日志会额外记录当前点光源数量、可见动态点光源数量和已编译 shader program 数。省略 `perfLights=off` 时为原始基准组。

## 项目结构

```text
.
├── docs/          # 需求、技术方案、数据配置、任务与开发进度
├── src/
│   ├── ai/         # 怪物 AI 运行时、调试层和可复现随机
│   ├── main.ts    # 游戏主循环、场景和玩法编排
│   ├── config.ts  # 数值与升级配置
│   ├── input.ts   # 键盘、指针和摇杆输入
│   ├── performance/ # 手机端长帧与运行时指标采集
│   ├── weapon.ts  # 枪械、弹匣和换弹状态
│   ├── combat.ts  # 射线命中计算
│   └── navigation.ts
├── Makefile
└── package.json
```

## 项目文档

- [MVP 需求文档](docs/120秒下班_MVP需求文档_v0.1.md)
- [MVP 技术实现方案](docs/120秒下班_MVP技术实现方案_v0.1.md)
- [MVP 开发任务列表](docs/120秒下班_MVP开发任务列表_v0.1.md)
- [MVP 数据配置表](docs/120秒下班_MVP数据配置表_v0.1.md)
- [怪物 AI 与自动寻路设计](docs/怪物AI与自动寻路设计_v0.1.md)
- [开发进度](docs/开发进度.md)
