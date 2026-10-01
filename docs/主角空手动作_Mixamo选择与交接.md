# 主角空手动作：Mixamo 素材与预览

> 2026-10-01：用户已提供八段源动作。八个 FBX 均为 Mixamo FBX Binary、30 FPS、65 根骨骼、无网格；骨骼名称及父子层级与 `ksman_v3_walk.fbx` 一致。已合并为压缩模型，并接入正式游戏空手跑步及独立拳／腿按钮；预览页面仍可逐帧验收。

## 动作与玩法映射

| 动作 | 源文件 | 合并后的 Clip | 源时长约 | 用途 |
| --- | --- | --- | --- | --- |
| 空手跑步 | `ksman_v3_unarmed_run.fbx` | `UnarmedRun` | 0.70 秒 | 摇杆外圈空手跑步 |
| 刺拳 | `ksman_v3_punch_jab_punch.fbx` | `PunchJab` | 1.03 秒 | 普通出拳，和四连击交替 |
| 四连击 | `ksman_v3_punch_four_punch_combo.fbx` | `PunchFourCombo` | 2.20 秒 | 普通出拳，和刺拳交替；按源动作伸展帧设置四个命中时刻 |
| 勾拳 | `ksman_v3_punch_hook_punch.fbx` | `PunchHook` | 2.17 秒 | 蓄力出拳；伤害为普通出拳的两倍 |
| 侧踢 | `ksman_v3_kick_mma_side_kick.fbx` | `KickSide` | 1.27 秒 | 普通踢腿轮换之一 |
| 低扫腿 | `ksman_v3_kick_mma_low_kick.fbx` | `KickLow` | 1.20 秒 | 普通踢腿轮换之一 |
| 回旋踢 | `ksman_v3_kick_mma_roundhouse_kick.fbx` | `KickRoundhouse` | 1.33 秒 | 普通踢腿轮换之一 |
| 旋风踢 | `ksman_v3_kick_hurricane_kick.fbx` | `KickHurricane` | 2.37 秒 | 蓄力踢腿；当前每目标 16 点，待实玩调参 |

**出拳键**和**踢腿键**彼此独立。短按出拳键在刺拳、四连击之间交替；蓄力出拳用勾拳。短按踢腿键在侧踢、低扫腿、回旋踢之间依次轮换；蓄力踢腿用旋风踢。当前长按 0.65 秒后松开视为蓄力，四连击每拳 12 点；仅保留最近 0.4 秒内的一次后续输入。不能用同一个攻击键自动混出拳和踢腿。

## 当前预览资产

- 原始合并模型：`ksman_v3_unarmed_moves_review.glb`。
- 1K WebP／Meshopt 预览模型：`ksman_v3_unarmed_moves_review_1k_meshopt.glb`，约 1.73 MB，共 15 段动作（原有七段和新增八段）。
- 打开 `http://localhost:6173/character-preview.html`，页面会优先加载这份压缩预览 GLB 并播放 `PunchJab`。在动作下拉框依次选 `UnarmedRun`、`PunchJab`、`PunchFourCombo`、`PunchHook`、`KickSide`、`KickLow`、`KickRoundhouse`、`KickHurricane`；这八段动作不显示枪。预览原有 `RifleIdle`、`RifleWalk`、`RifleRun`、`Shoot`、`Reload` 时仍显示枪。可调慢播放、逐帧拖动、旋转镜头检查脚底、手腕和动作收势。

合并脚本报告新增动作的最大关节位置误差低于 0.0001 米。`UnarmedRun` 源文件首尾骨骼位置最大差约 0.0000015 米，首尾骨骼角度差为 0°。压缩模型使用 1024×1024 WebP 和 Meshopt；现有 `Idle` 循环及原始 `Walk` 对照检查通过。以上是结构和数值检查，**视觉效果仍以动作验收台查看为准**。

## 正式游戏接入（2026-10-01）

- 空手使用这份 15 段动作的压缩模型，持枪仍使用原持枪模型。空手摇杆外圈或 Shift 跑步播放 `UnarmedRun`。
- 普通拳每次命中 12，勾拳 24；普通腿每次命中 16。旋风踢目前扫击周围目标，每目标整段最多命中一次、伤害 16；这是实现默认值，后续按实玩调参。
- 按 30 FPS 源文件的拳脚伸展采样设置命中点（以下时间从动作开始计）：刺拳 17/30 秒；四连击 19/30、26/30、34/30、41/30 秒；勾拳 34/30 秒；侧踢 15/30 秒；低扫 14/30 秒；回旋踢 18/30 秒。旋风踢在 0.1、18/30、36/30、54/30 秒扫击并对整段已命中目标去重。实际接触观感仍需在游戏里验收。
- 完整播放源动作，四连击保持 2.20 秒；攻击期间锁定朝向并暂停位移，结束恢复移动。受击仍采用原有伤害逻辑，本轮未新增受击打断。
- 蓄力 0.65 秒，按钮边缘显示蓄力进度，松开触发；触控取消、失焦和切换方式会取消未释放的攻击输入。普通拳与腿各自轮换，蓄力动作不推进普通轮换。
- `npm run test:animation` 覆盖招式轮换、命中点、短按／长按、输入取消、切换和自动换弹；整体动作效果仍以实际页面验收为准。
