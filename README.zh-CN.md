![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml/badge.svg)](https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml)
![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-blue.svg)
![License](https://img.shields.io/badge/License-GPL--2.0--or--later-blue.svg)

**让非原生应用无缝融入 GNOME 桌面。**

为所有未遵循 Adwaita 样式的第三方窗口（Electron, Chromium, GTK3, Qt, Wine 等）带来**官方对齐的圆角、GPU 烘焙阴影以及 GTK 原生 12px 窗口缩放边距**。

<img src="assets/preview.webp" alt="对比：方角窗口 vs. 同一窗口补上圆角与阴影" width="500">

---

## 核心特性

### 🎯 原汁原味的 Libadwaita 规范
拒绝肉眼调参。视觉指标直接从 GNOME / Libadwaita 官方源码编译生成：
- **15px 标准圆角** 与内侧细腻微光轮廓
- **多层高斯阴影**，深度贴合深色与浅色主题
- 完美契合 GNOME 整体视觉风格

### 🪟 12px GTK 原生缩放边距
Wayland 下的无边框应用（如 VS Code、Chrome、微信等）边缘常只有 1px，鼠标极难瞄准抓取。
- **12px 隐形外延触发区**：告别像素级微操，随手拖拽调整窗口大小
- **24px 拐角优先捕获**：斜向拉伸顺滑自然
- 支持边缘点击穿透至下层窗口（可在首选项中按需关闭）

### ⚡ 平滑流畅的 GPU 着色器
- **GPU 8-Slice 阴影预烘焙**：运行期零 CSS 解析重排开销
- **管线直连挂钩**：连续拉伸窗口时圆角零延迟、无撕裂
- **超轻资源开销**：单窗显存与内存增量极小

### 🛡️ 智能识别与非侵入设计
- **不打扰原生应用**：自动识别并跳过 Libadwaita、Libhandy 与 Firefox
- **消除多层阴影**：精确识别 Mutter 与系统既有阴影，只补缺失部分
- **状态感知**：窗口最大化、全屏或分屏贴边对齐时，自动撤销外侧多余装饰与接缝阴影

### 🔍 分数缩放文字清晰度保护
传统圆角插件在 125%、150% 等分数缩放屏幕下容易导致全窗文字发虚。
- **“优先清晰文本”选项**：缩放屏幕下自动跳过圆角离屏裁剪，完整保留锐利文字与 GPU 阴影
- **紧跟 Mutter 上游根治方案**：紧密跟踪并适配上游修复（[!5179](https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5179)），待上游合并后将自动启用像素对齐直绘，无损兼得圆角与清晰文字

---

## 架构定位对比：Window Nativizer vs. Rounded Window Corners

| 维度 | Rounded Window Corners (Reborn) | Window Nativizer (本项目) |
| :--- | :--- | :--- |
| **核心目标** | 桌面主题美化与个性化风格定制 | 专注 GNOME / Adwaita 原生一致性补齐 |
| **覆盖范围** | 全桌面窗口通配（黑名单排除机制） | 仅修饰非原生应用；原生程序绝不介入 |
| **圆角半径** | 用户自由设定（如 12px、16px、20px） | 固定 15px，严格遵循官方 Libadwaita 标准 |
| **缩放边距** | 保持客户端原有边框不变 | 补齐 12px 原生 GTK 拖拽判定带 |
| **阴影架构** | St.Bin CSS 控件树布局 | GPU 纹理预烘焙切片网格 |

---

## 窗口规则系统

Window Nativizer 对绝大多数应用能自动识别，但也支持针对单个程序独立调整规则：

| 规则状态 | 圆角 (Corners) | 阴影 (Shadow) | 适用场景 |
| :--- | :---: | :---: | :--- |
| **都加 (Both)** | 扩展绘制 | 扩展绘制 | 默认值。缺少 GNOME 风格的普通第三方应用 |
| **都不加 (Neither)** | 客户端保持 | 客户端保持 | 自身已具备完备原生装饰的窗口 |
| **仅圆角 (Corners only)**| 扩展绘制 | 客户端保持 | 常见于 X11：合成器已绘制阴影，仅需补齐圆角 |
| **仅阴影 (Shadow only)** | 客户端保持 | 扩展绘制 | 窗口自绘了内部圆角，但未声明外边距阴影 |

如遇特殊窗口识别不准，只需在**首选项**中点击**“选取窗口”**，点一下目标窗口即可一键完成规则修正。

[深入了解规则模型与匹配逻辑 →](docs/rule-model.md)

---

## 安装使用

### 环境要求
- GNOME Shell 50（Wayland 或 X11）

### 从 Release 安装（推荐）
从 [GitHub Releases](https://github.com/everyx/gnome-shell-extension-window-nativizer/releases) 下载 `window-nativizer@everyx.github.io.shell-extension.zip`，直接执行：

```sh
gnome-extensions install --force window-nativizer@everyx.github.io.shell-extension.zip
```

### 从源码安装
```sh
git clone https://github.com/everyx/gnome-shell-extension-window-nativizer.git
cd gnome-shell-extension-window-nativizer
pnpm install
pnpm run install-ext
```

### 启用与重启
注销重登（X11 按 `Alt+F2` 输入 `r` 重启 Shell），然后启用扩展：
```sh
gnome-extensions enable window-nativizer@everyx.github.io
```

---

## 底层架构与工程文档

查看底层实现细节、设计推导与跑分基准：
- [着色器与渲染架构](docs/decoration-model.md) — GPU 烘焙网格、动态拉伸挂钩与性能预算
- [像素级精度与对齐测量](docs/decoration-alignment.md) — Libadwaita 曲线拟合与自动化回归校验
- [规则系统设计](docs/rule-model.md) — 进程探针探测逻辑、窗口类型与规则优先级
- [开发调试指南](docs/development.md) — 嵌套 Shell 调试与自动化测试执行

---

## 开源协议与致谢

- 遵循 **GPL-2.0-or-later** 许可证。
- 视觉参数生成自 [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita)，阴影着色器取自 [GTK4](https://gitlab.gnome.org/GNOME/gtk)，窗口行为遵循 [Mutter](https://gitlab.gnome.org/GNOME/mutter)。
- 同类项目参考：[Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners)。
