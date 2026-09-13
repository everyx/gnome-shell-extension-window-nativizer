![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

一个 GNOME Shell 扩展。缺阴影的补上，圆角统一成 GNOME 的样子——本来就长那样的窗口不碰。

![对比：方角窗口 vs. 同一窗口补上圆角与投影](assets/preview.webp)

## 功能

- **补缺口，并统一外观**：
  - **阴影——只补不猜**：自己声明了阴影边距的窗口、带系统标题栏的 X11 应用、以及由 Mutter 代画阴影的裸 X11 窗口，一律保留原样。
  - **圆角——统一到 GNOME 的 15px**：不管工具包自己有没有圆角；除非那个窗口已经长成 Adwaita 的样子（libadwaita、[adw-gtk3](#给我们省点活让工具包自己画)、[QAdwaitaDecorations](#给我们省点活让工具包自己画)）——那些一律不碰。[为什么 →](docs/decoration-model.md)
  - 两轴独立。
- **绝不重复装饰**：
  - 两层阴影 → 更黑、边缘错位，所以阴影轴只在没人画的时候补；
  - 圆角裁剪落在**窗口本体**上，绝不碰客户端自画阴影占用的那圈留白：它的阴影原样保留；
  - 拿不准 → 跳过。误漏一条规则可补，误画是观感 bug。[为什么 →](docs/decoration-model.md)
- **可手动修正**：误判 → 拾取窗口，建一条强制或屏蔽规则
- **对齐 GNOME**：圆角、阴影、描边在各状态下与原生窗口一致——激活、失焦、贴边、最大化、全屏、高对比度。取值来自 libadwaita。

## 安装

GNOME Shell 50，Wayland 或 X11。45–49 预期可用但尚未验证——[帮忙确认](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/8)。

```sh
git clone https://github.com/everyx/gnome-shell-extension-window-nativizer.git
cd gnome-shell-extension-window-nativizer
pnpm install
pnpm run install-ext
```

启用后注销重登（X11：Alt+F2、`r`）：

```sh
gnome-extensions enable window-nativizer@everyx.github.io
```

尚未上架 extensions.gnome.org。

## 性能

- **静默零开销**：静态窗口不触发 JS，不额外重绘。
- **阴影预烘焙**：每种风格共用一张纹理，不再逐帧模糊；缩放只改纹理坐标。数字见 [docs/decoration-model.md](docs/decoration-model.md)。
- **最大化即退出**：最大化 / 全屏 / 贴边平铺时，阴影与离屏裁剪均跳过；`pnpm run benchmark:perf` 可核对预算。
- **每个被圆角的窗口一张离屏缓冲**（1920×1080 约 8 MB），该窗口重绘时重画一次。

### 给我们省点活：让工具包自己画

已经自己画了 GNOME 圆角的窗口会被跳过，也就省掉那张离屏缓冲。两件可选的配料能让多数应用自己画：

- **GTK 应用** — [adw-gtk3](https://github.com/lassekongo83/adw-gtk3)：用 libadwaita 自己的样式表做出来的 GTK 3/4 主题，圆角与本扩展完全一致。
- **Qt 应用** — [QAdwaitaDecorations](https://github.com/FedoraQt/QAdwaitaDecorations)：模仿同样外观的 Qt Wayland 装饰插件。它的圆角比 libadwaita 略紧（12px 对 15px），于是 Qt 窗口会保留 12px、不再被统一成 15px：用一处观感差异换掉每窗口一张离屏缓冲。

两者都不是必需的。不装的话这些窗口由本扩展来画圆角——与 adw-gtk3 的效果一致，代价是每窗口一张离屏缓冲。

## 遇到问题

- **缺圆角或阴影** → 拾取窗口，**强制**加上。
- **被多画了一层装饰** → 拾取窗口，**屏蔽**掉。
- **分数缩放下文字发虚** → 打开「优先保证文字清晰」（用圆角换清晰）。

规则在首选项里用拾取按钮创建，按窗口种类生效，不按应用。

## 开发

- **提交即 CI**：`pnpm install` 把 `core.hooksPath` 指向 `.githooks/`。
- **文档**：[docs/development.md](docs/development.md)。

## 致谢

- 取值生成自 [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita)，阴影着色器取自 [GTK4](https://gitlab.gnome.org/GNOME/gtk)，窗口行为遵循 [Mutter](https://gitlab.gnome.org/GNOME/mutter)。
- 同类：[Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners)。

## 开源许可

GPL-2.0-or-later
