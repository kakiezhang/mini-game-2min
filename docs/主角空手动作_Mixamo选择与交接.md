# 主角空手动作：Mixamo 素材与预览

> 2026-10-01：用户已提供八段源动作。八个 FBX 均为 Mixamo FBX Binary、30 FPS、65 根骨骼、无网格；骨骼名称及父子层级与 `ksman_v3_walk.fbx` 一致。已合并为独立预览模型，尚未替换正式游戏资源或接入战斗按键。

## 动作与玩法映射

| 动作 | 源文件 | 合并后的 Clip | 源时长约 | 用途 |
| --- | --- | --- | --- | --- |
| 空手跑步 | `ksman_v3_unarmed_run.fbx` | `UnarmedRun` | 0.70 秒 | 摇杆外圈空手跑步 |
| 刺拳 | `ksman_v3_punch_jab_punch.fbx` | `PunchJab` | 1.03 秒 | 普通出拳，和四连击交替 |
| 四连击 | `ksman_v3_punch_four_punch_combo.fbx` | `PunchFourCombo` | 2.20 秒 | 普通出拳，和刺拳交替；多个命中时刻待逐帧确定 |
| 勾拳 | `ksman_v3_punch_hook_punch.fbx` | `PunchHook` | 2.17 秒 | 蓄力出拳；伤害为普通出拳的两倍 |
| 侧踢 | `ksman_v3_kick_mma_side_kick.fbx` | `KickSide` | 1.27 秒 | 普通踢腿轮换之一 |
| 低扫腿 | `ksman_v3_kick_mma_low_kick.fbx` | `KickLow` | 1.20 秒 | 普通踢腿轮换之一 |
| 回旋踢 | `ksman_v3_kick_mma_roundhouse_kick.fbx` | `KickRoundhouse` | 1.33 秒 | 普通踢腿轮换之一 |
| 旋风踢 | `ksman_v3_kick_hurricane_kick.fbx` | `KickHurricane` | 2.37 秒 | 蓄力踢腿；伤害数值待定 |

未来的**出拳键**和**踢腿键**彼此独立。短按出拳键在刺拳、四连击之间交替；蓄力出拳用勾拳。短按踢腿键在侧踢、低扫腿、回旋踢之间依次轮换；蓄力踢腿用旋风踢。蓄力阈值、四连击的逐拳伤害和连续输入规则要在接入战斗时与动作时长一起设计。不能用同一个攻击键自动混出拳和踢腿。

## 当前预览资产

- 原始合并模型：`ksman_v3_unarmed_moves_review.glb`。
- 1K WebP／Meshopt 预览模型：`ksman_v3_unarmed_moves_review_1k_meshopt.glb`，约 1.73 MB，共 15 段动作（原有七段和新增八段）。
- 打开 `http://localhost:6173/character-preview.html`，页面会优先加载这份压缩预览 GLB 并播放 `PunchJab`。在动作下拉框依次选 `UnarmedRun`、`PunchJab`、`PunchFourCombo`、`PunchHook`、`KickSide`、`KickLow`、`KickRoundhouse`、`KickHurricane`；这八段动作不显示枪。预览原有 `RifleIdle`、`RifleWalk`、`RifleRun`、`Shoot`、`Reload` 时仍显示枪。可调慢播放、逐帧拖动、旋转镜头检查脚底、手腕和动作收势。

合并脚本报告新增动作的最大关节位置误差低于 0.0001 米。`UnarmedRun` 源文件首尾骨骼位置最大差约 0.0000015 米，首尾骨骼角度差为 0°。压缩模型使用 1024×1024 WebP 和 Meshopt；现有 `Idle` 循环及原始 `Walk` 对照检查通过。以上是结构和数值检查，**视觉效果仍以动作验收台查看为准**。

正式接入时，先按每段动作的实际出拳／踢腿画面标记命中帧，再实现独立按钮、普通招式轮换和蓄力判定。四连击的完整动作约 2.20 秒，不能按刺拳的时长截断。完成后再验收移动中攻击、连按、蓄力、受击打断、手机竖屏及枪械拾取切换。
