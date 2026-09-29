<div align="center">

<img src="assets/logo.svg" alt="Window Nativizer 图标" width="128">

# Window Nativizer

**让非原生应用无缝融入 GNOME 桌面。**

[English](README.md) | [简体中文](README.zh-CN.md)

<p>
  <a href="https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml"><img src="https://github.com/everyx/gnome-shell-extension-window-nativizer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/GNOME%20Shell-50%20%7C%2051-blue.svg" alt="GNOME Shell">
  <img src="https://img.shields.io/badge/License-GPL--2.0--or--later-blue.svg" alt="License">
</p>

<p>
为所有未遵循 Adwaita 样式的第三方窗口（Qt, GTK3, Wine, 各类自绘 CSD 应用等）带来官方对齐的圆角、GPU 烘焙阴影以及与 GTK 原生一致的窗口调整大小体验。
</p>

<img src="assets/preview.webp" alt="对比：方角窗口 vs. 同一窗口补上圆角与阴影" width="560">

</div>

---

## 核心特性

### 🎯 与 Libadwaita 一致的规范
非原生应用在现代 GNOME 桌面上常显得格格不入。Window Nativizer 让它们与官方样式对齐：
- **原生标准圆角**与内侧细腻微光轮廓
- **多层高斯阴影**，与 libadwaita 逐层一致
- **装饰覆盖全部状态**：有焦点时是圆角加阴影，失去焦点时换成更浅的非活动态阴影，分屏贴边时改画跟随主题的细描边环，最大化与全屏时完全不做装饰
- **高对比度适配**：跟随系统的对比度设置，加深轮廓
- **取自上游源码**：曲线与数值直接从 GNOME 源码生成，不用肉眼对齐

### 🖱️ 流畅的原生拖拽调整大小手感
圆角只是视觉的一半，非原生窗口最大的问题是“边框太窄，很难拉伸”。Window Nativizer 把窗口的抓取手感整个重做了：
- **不用再抠像素**：把难以瞄准的 0~1px 边缘扩展成与 GTK 原生一致的隐形抓取区
- **拐角拖拽更顺手**：照 GTK 的拐角坐标算法实现，判定范围更宽
- **Mutter 原生拖拽联动**：直接触发合成器级 8 向原生调整大小手势（Grab-Op）与自适应光标，不撕裂、不延迟
- **不会误触**：抓取区严格位于窗口外围，不会侵占内部标题栏拖拽、窗口控制按钮或浏览器标签页点击

### ⚡ 平滑流畅的 GPU 着色器
- **GPU 阴影纹理预烘焙**：运行期不产生 CSS 解析与重排开销
- **管线直连挂钩**：连续拉伸窗口时圆角不会延迟或撕裂
- **过渡跟着焦点走**：失去焦点时阴影淡出到非活动态，重新获得焦点时直接切换，与上游声明一致；这层透明度同时跟随 GNOME Shell 的关闭动画
- **跟随系统动画开关**：关闭动画后，淡出同样直接切换
- **资源开销低**：全透明时自动剔除着色（Zero Overdraw），单窗显存与内存增量极小

### 🛡️ 智能识别与非侵入设计
- **不打扰原生应用**：自动识别并跳过 Libadwaita、Libhandy 与 Firefox
- **消除多层阴影**：精确识别 Mutter 与系统既有阴影，只补缺失部分
- **Overview 视图自适应**：进入 GNOME Shell Overview 时自动挂起圆角裁剪，防止缩略图出现发虚与边缘锯齿
- **拼缝不叠线**：与相邻分屏窗口共享的那条边不画描边环，接缝处不会叠出双线

### 🔍 分数缩放文字清晰度保护
传统圆角插件在 125%、150% 等分数缩放屏幕下容易导致全窗文字发虚。
- **“优先清晰文本”选项**：缩放屏幕下自动跳过圆角离屏裁剪，完整保留锐利文字与 GPU 阴影
- **紧跟 Mutter 上游方案**：持续跟进并适配上游修复（[!5179](https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5179)），待其合并后改用像素对齐直绘，圆角与清晰文字可以兼得

---

## 架构定位对比：Window Nativizer vs. Rounded Window Corners

| 维度 | Rounded Window Corners (Reborn) | Window Nativizer（本项目） |
| :--- | :--- | :--- |
| **核心目标** | 桌面主题美化与个性化风格定制 | 专注 GNOME / Adwaita 原生一致性补齐 |
| **覆盖范围** | 默认覆盖所有窗口（黑名单除外） | 仅修饰非原生应用；原生程序不会介入 |
| **圆角半径** | 用户自由设定（如 12px、16px、20px） | 严格遵循官方 Libadwaita 标准规范 |
| **拖拽调整大小体验** | 仅做视觉圆角，保留客户端极窄边框（常为 0~1px，很难抓取） | 补齐 GTK 标准的外侧抓取区与 8 向自适应光标，拉伸更顺手 |
| **阴影架构** | St.Bin CSS 控件树布局 | GPU 纹理预烘焙切片网格 |

---

## 误判修正

Window Nativizer 对绝大多数应用能自动识别，但也支持按窗口种类修正它的误判：

每条修正都列出**圆角**、**阴影**、**调整大小**三个轴中在本窗口上**判断有误**的那些，扩展在这些轴上做相反的判断；未列出的轴继续跟随自动判断 — 所以修正永远是一次真实的改变，而不是把现状复述一遍。

| 修正的轴 | 典型场景 |
| :--- | :--- |
| 无 | 默认。自动判断照常生效，大多数窗口不需要修正 |
| 圆角 | 把扩展没圆的窗口圆上，或让圆角出问题的窗口保持原样（黑边、瑕疵，或想要原生外观） |
| 阴影 | 在扩展把阴影留给客户端时改成我们自己投，或反过来收回我们的阴影（常见于 X11，合成器已绘制） |
| 调整大小 | 在固定比例弹窗上收回 band（我们的 band 跟不上），或在扩展把窗口自带的把手误判为原生时补上原生抓取环（GTK4 宽边距） |

觉得哪个窗口看着不对，在**首选项**的**误判修正**里点**选取窗口…**即可。

[深入了解规则模型与匹配逻辑 →](docs/rule-model.md)

---

## 安装使用

### 环境要求
- GNOME Shell 50、51（Wayland 或 X11）

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

## 进阶：让应用自己也像原生

本扩展只管窗口本身。窗口里面的标题栏、按钮、菜单来自应用自己的主题，窗口装饰改不了。想让那些也对上：

- **[adw-gtk3](https://github.com/lassekongo83/adw-gtk3)** — GTK3 应用用，libadwaita 的非官方 GTK3 移植。
- **[Legacy Theme Scheme Auto Switcher](https://extensions.gnome.org/extension/4998/legacy-gtk3-theme-scheme-auto-switcher/)** — 让 GTK3 应用跟着深色模式走。
- **[QAdwaitaDecorations](https://github.com/FedoraQt/QAdwaitaDecorations)** — Qt 应用用，换成 Adwaita 风格的标题栏。

Electron、Wine、Java 和非 libadwaita 的 GTK4 应用各有对应项目，adw-gtk3 的 README 有一份[清单](https://github.com/lassekongo83/adw-gtk3#related-projects)。

---

## 底层架构与工程文档

查看底层实现细节、设计推导与跑分基准：
- [着色器与渲染架构](docs/decoration-model.md) — GPU 烘焙网格、动态拉伸挂钩与性能预算
- [像素级精度与对齐测量](docs/decoration-alignment.md) — Libadwaita 曲线拟合与自动化回归校验
- [规则系统设计](docs/rule-model.md) — 进程探针探测逻辑、窗口类型与规则优先级
- [开发调试指南](docs/development.md) — 嵌套 Shell 调试与自动化测试执行

---

## 开源协议与致谢

遵循 **GPL-2.0-or-later** 许可证。
- 视觉参数生成自 [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita)，阴影着色器取自 [GTK4](https://gitlab.gnome.org/GNOME/gtk)，窗口行为遵循 [Mutter](https://gitlab.gnome.org/GNOME/mutter)。
- 同类项目参考：[Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners)。
