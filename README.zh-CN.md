![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

一个 GNOME Shell 扩展。缺阴影的补上，圆角统一成 GNOME 的样子——本来就长那样的窗口不碰。

![对比：方角窗口 vs. 同一窗口补上圆角与投影](assets/preview.webp)

## 功能

- **补缺口，并统一外观**：
  - **阴影——读窗口自己的声明，不是猜**：自己声明了阴影边距的窗口、带系统标题栏的 X11 应用、以及由 Mutter 代画阴影的裸 X11 窗口，一律保留原样。唯一会读错的情况：客户端自画阴影却不声明。
  - **圆角——统一到 GNOME 的 15px**：不管工具包自己有没有圆角；除非那个窗口已经长成 Adwaita 的样子（libadwaita、[QAdwaitaDecorations](#给我们省点活让工具包自己画)）——那些一律不碰。[为什么 →](docs/decoration-model.md)
  - 两轴独立。
- **绝不重复装饰**：
  - 两层阴影 → 更黑、边缘错位，所以阴影轴只有一个主人：自己画了阴影的窗口，换成我们那层——绝不叠加；
  - 圆角裁剪落在**窗口本体**上，不碰外侧那一圈；只有当那一圈里的阴影是照着**我们正在替换的圆角**画的，才会被一并擦掉；
  - 拿不准 → 跳过。误漏一条规则可补，误画是观感 bug。[为什么 →](docs/decoration-model.md)
- **可手动修正**：误判 → 拾取一次窗口，规则会自动设成相反的状态（加装饰 / 不加 / 只要圆角 / 只要阴影）。[规则模型 →](docs/rule-model.md)
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

已经自己画了 GNOME 圆角的窗口会被跳过，也就省掉那张离屏缓冲。探测只看进程映射了哪些库，所以链接了 libadwaita 的 GTK4 应用、以及装了 Adwaita 装饰插件的 Qt 应用无需配置就会被识别：

- **GTK4 应用** — 只要链接了 libadwaita 就会被识别并放过。GTK3 主题（如 [adw-gtk3](https://github.com/lassekongo83/adw-gtk3)）进不了这个名单：GTK3 的 `decoration` 节点盖不到窗口底部，主题再像也给不了四个圆角。这类窗口改由本扩展接手——圆角和阴影一起。[为什么 →](docs/decoration-model.md)
- **Qt 应用** — [QAdwaitaDecorations](https://github.com/FedoraQt/QAdwaitaDecorations)：模仿同样外观的 Qt Wayland 装饰插件，装了就跳过。它的圆角比 libadwaita 略紧（12px 对 15px），于是 Qt 窗口会保留 12px、不再被统一成 15px：用一处观感差异换掉每窗口一张离屏缓冲。

只有这个 Qt 插件是可选的。探测认不出的窗口——包括 adw-gtk3 主题下的 GTK3 应用——都由本扩展来画，代价是每窗口一张离屏缓冲。

## 遇到问题

- **缺圆角或阴影** → 拾取窗口，规则会被设成 **加装饰**。
- **被多画了一层装饰** → 拾取窗口，规则会被设成 **不加（保持原样）**。
- **只有一轴不对** → 在下拉里选 **只要我们的圆角** 或 **只要我们的阴影**。
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
