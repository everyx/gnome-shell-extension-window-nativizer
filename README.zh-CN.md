![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml/badge.svg)](https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml)
![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-blue.svg)
![License](https://img.shields.io/badge/License-GPL--2.0--or--later-blue.svg)

**让非原生应用无缝融入 GNOME 桌面。**

为所有未采用 Libadwaita 外观的窗口（Electron, Chromium, GTK3, Qt, Wine, WPS 等）带来**像素级对齐的 GNOME 官方圆角、GPU 烘焙阴影以及 GTK 原生 12px 缩放触发区**。

![对比：方角窗口 vs. 同一窗口补上圆角与阴影](assets/preview.webp)

---

## 为什么选择 Window Nativizer？

Window Nativizer 不是一个无差别的“窗口裁切工具”，而是一个以 **GNOME / Libadwaita 原生规范为唯一准绳**的桌面原生化对齐层。

### 🎯 像素级对齐 GNOME 官方规范（Pixel-Exact Truth）
不依赖主观肉眼调试。圆角半径（15px）、内高光轮廓（18/255 强度）以及多层高斯阴影衰减参数，全部由自动化代码生成器从 `libadwaita` 官方 SCSS 和 GTK 源码提取编译。内置自动化像素级回归测试，确保曲线 100% 四向对称、首像素偏差仅 −8 灰阶且在 4 像素内单调收敛归零（平均偏差 ≤5/255）。

### 🪟 补齐 12px GTK 原生缩放触发区（Interaction Truth）
原生 GNOME 窗口的灵魂不仅在视觉，更在**可交互性**。第三方无边框应用（如各类 Electron/Web 应用）在 Wayland 下往往只有 0~1px 的抓取边缘，鼠标极难调整窗口大小。Window Nativizer 严格复刻 GTK4 `gtkwindow.c` 的 12px 触发区外延与 24px 拐角优先级算法，让任何窗口都能像原生应用一样轻松拖拽缩放。

### ⚡ 毫秒级性能预算与资源控制
- **GPU 8-Slice 阴影切片**：样式按需单次离屏烘焙，运行时以 8 块 Cogl 纹理网格直接渲染，零 CSS 解析开销；
- **渲染管线挂钩（Live Size Hook）**：圆角着色器直连 Clutter 当前帧分配管线，窗口连续拉伸缩放平滑流畅，零延迟零撕裂；
- **严格的性能预算守卫**：内置自动化性能基准，采用预热与 AB-BA 对衡采样，确保动态拉伸单次事件耗时处于预算范围内（目标 <0.8ms），且单窗内存增量严格受控（每窗口 PSS 增量预算 <2MB）。

> **基准测试环境**：Arch Linux（Linux 7.2 内核），GNOME Shell 50.4 (Wayland)，11th Gen Intel® Core™ i5-11300H @ 3.10GHz（4 核 / 8 线程），32 GB 内存，Intel® Iris® Xe 核显。测试由 `tools/benchmark-perf.py` 在自动化 headless 会话中执行（150 次 60 FPS 连续动态缩放，3 轮预热与 AB-BA 对衡采样；真机硬件实测数据可能有所不同）。

### 🛡️ 外科手术式的克制（Non-Invasive）
- **绝不打扰原生应用**：自动检测进程库映射，对已自带原生 Adwaita 圆角的应用（Libadwaita、Libhandy、Qt Adwaita 装饰插件）**坚决不碰**；
- **绝不叠加多层阴影**：精确识别 Mutter 合成器与 X11 既有阴影边界，只补齐缺失部分；
- **精准感知窗口状态**：最大化、全屏贴齐屏幕边缘时自动撤销圆角与阴影；贴边对齐（Snap Tiled）窗口自动消除内侧接缝阴影。

### 🔍 真实的分数缩放文字清晰度保护（Crisp Text Protection）
市面上其他圆角方案在 125%、150% 等分数缩放屏幕上，往往会导致全屏窗口文字发虚发糊。这是由于 Mutter 底层的 `ClutterOffscreenEffect` 在分数缩放下会丢失帧缓冲区的像素相位（Pixel Phase）。

Window Nativizer 采取了高度务实与透明的处理策略：
- **现阶段（零妥协的阅读体验）**：开启“优先保证文字清晰”后，扩展会在分数缩放屏上自动跳过圆角离屏裁切，保留完整的 GPU 烘焙阴影与原生锐利文字；
- **跟进 GNOME 上游根治方案**：我们正紧密追踪并适配 GNOME/Mutter 核心修复（[!5179](https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5179) / [Issue #6](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/6)）。一旦该修复随新版 Mutter 发布，Window Nativizer 将自动启用像素对齐直绘，届时分数缩放用户将无需任何取舍，即可直接兼得原生圆角与 100% 锐利文字！

---

## 架构与定位对比：Window Nativizer vs. Rounded Window Corners

两个扩展都致力于改善 Linux 桌面体验，但遵循完全不同的设计目标与定位：

| 维度 | Rounded Window Corners (Reborn) | Window Nativizer (本项目) |
| :--- | :--- | :--- |
| **核心定位** | **桌面主题美化与个性化**<br/>为所有窗口提供统一、可自定义的圆角半径，营造整体风格 | **GNOME 原生标准对齐与兼容**<br/>严格补充非原生应用缺失的 Adwaita 视觉与交互规范 |
| **目标窗口** | **全桌面通用覆盖**<br/>对各窗口通配圆角样式，提供排除项与黑名单机制 | **选择性原生化（缺什么补什么）**<br/>仅装饰缺少 Adwaita 样式的窗口，原生应用完全不介入 |
| **圆角半径** | **用户自定义**<br/>支持用户自由设定任意圆角半径（如 16px、20px） | **上游 Adwaita 规范**<br/>15px 半径与内侧高光轮廓，参数直接编译自 libadwaita 源码 |
| **边缘缩放触发区** | **保持客户端原状**<br/>依赖应用自身声明的窗口边距进行缩放 | **12px GTK 原生缩放触发区**<br/>精准复刻 GTK4 优先捕获算法，彻底恢复轻松拖拽缩放 |
| **阴影架构** | **St.Bin CSS 管线**<br/>通过 `St.Bin` 阴影结合 Clutter 裁剪效果呈现 | **GPU 8-Slice 预烘焙网格**<br/>按样式预烘焙纹理并直接提交 GPU 网格，无运行时 CSS 布局开销 |

---

## 规则系统

针对特殊窗口形态，系统为每个窗口种类独立维护**圆角**与**阴影**两条决策轴：

| 规则状态 | 圆角 (Corners) | 阴影 (Shadow) | 典型适用场景 |
| :--- | :---: | :---: | :--- |
| **都加 (Both)** | 扩展绘制 | 扩展绘制 | 默认值。用于缺少 Adwaita 风格的普通窗口 |
| **都不加 (Neither)** | 客户端保持 | 客户端保持 | 窗口已自带同等质量的第三方装饰 |
| **仅圆角 (Corners only)**| 扩展绘制 | 客户端保持 | 常见于 X11：Mutter 已画原生阴影，只需补齐下边圆角 |
| **仅阴影 (Shadow only)** | 客户端保持 | 扩展绘制 | 窗口内部已实现圆角，但未声明外部投影边距 |

遇到特殊软件时，在首选项中点击**选取窗口**即可单键修正，无需繁琐的手动配置文件。

> **关于内部自绘窗口的说明**：若某应用在自身表面内部自绘装饰或边框、且未声明外边距（常见于部分 CEF/Electron 及 Qt 窗口，如微信等），合成器无法从外部感知其内绘边框。这类窗口可以通过点选拾取一次，为其建立适配规则。

[了解规则系统细节 →](docs/rule-model.md)

## 缩放触发区设置

如果不希望扩展加宽窗口边框（例如希望边缘点击直接穿透给底层窗口），可在首选项中关闭**加宽窗口缩放触发区**。

---

## 安装与使用

### 系统要求
- GNOME Shell 50（Wayland 或 X11）

### 从源码安装
```sh
git clone https://github.com/everyx/gnome-shell-extension-window-nativizer.git
cd gnome-shell-extension-window-nativizer
pnpm install
pnpm run install-ext
```

启用扩展，然后注销重登（X11 按 Alt+F2 执行 `r`）：
```sh
gnome-extensions enable window-nativizer@everyx.github.io
```

### 卸载
```sh
gnome-extensions disable window-nativizer@everyx.github.io
gnome-extensions uninstall window-nativizer@everyx.github.io
```

---

## 开发与工程规范

运行 `pnpm install` 会将 Git 挂载点链接至 `.githooks/`，确保每次提交前自动执行完整验证链：
- `pnpm run lint`：ESLint 严格代码审查
- `pnpm test`：217 项 GJS + Jasmine 单元规格测试
- `pnpm run check-style`：上游代码生成一致性校验（确保与 Libadwaita / GTK / Mutter 上游源码严格一致）
- `ego-lint`：GNOME 官方扩展审查器（232 项合规性检查）
- `pnpm run benchmark:perf`：CPU 与内存开销防回归红线检查

详细设计模型见 [docs/decoration-model.md](docs/decoration-model.md)，开发环境搭建见 [docs/development.md](docs/development.md)。

---

## 开源协议与致谢

- 遵循 **GPL-2.0-or-later** 许可证。
- 视觉参数生成自 [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita)，阴影着色器取自 [GTK4](https://gitlab.gnome.org/GNOME/gtk)，窗口行为遵循 [Mutter](https://gitlab.gnome.org/GNOME/mutter)。
- 同类项目参考：[Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners)。
