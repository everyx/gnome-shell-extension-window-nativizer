![](assets/logo.svg)

# Window Nativizer

[English](README.md) | [简体中文](README.zh-CN.md)

一个 GNOME Shell 扩展：把窗口圆角统一成 GNOME 的半径，只在没有合成器、边框或客户端画阴影的地方补上阴影。已经像原生的窗口保留自己的圆角；阴影仍看窗口自己声明了什么。

![对比：方角窗口 vs. 同一窗口补上圆角与阴影](assets/preview.webp)

## 功能

启用后，不画 Adwaita 外观的普通窗口、对话框和工具窗口会得到 GNOME 的圆角与相配的阴影。最大化、全屏窗口，以及菜单、Dock 之类的窗口类型保持不变。

一条**规则**对应一个窗口种类——同一个应用中，客户端类型、窗口类型、父窗口和缩放行为都相同的窗口——而不是一个应用的所有窗口。每条规则取四种状态之一。两条装饰轴互相独立，但界面每次都同时设置两条轴。

| 状态 | 圆角 | 阴影 |
|---|---|---|
| 都加 | 扩展 | 扩展 |
| 都不加 | 客户端 | 客户端 |
| 仅圆角 | 扩展 | 客户端 |
| 仅阴影 | 客户端 | 扩展 |

误判时，用首选项里的按钮选取一次窗口，规则会设成能纠正当前显示的状态。[规则模型 →](docs/rule-model.md)

## 缩放触发区

原生 GNOME 窗口可以拖动窗口外缘的带子来缩放：两侧 12 像素，四角 24 像素。缩放边框更窄的窗口会由扩展补上同样的带子，从而能像原生窗口一样被拖动。这条带子贴着窗口本身，不包含可见的阴影；自身声明边距已达每边 12 像素的窗口不会再被加宽，最大化、全屏和贴边窗口都没有。

这条带子是扩展唯一参与命中测试的地方：带子里的点击会开始缩放，而不再传给后面的东西。如果希望这些点击照旧穿透，在首选项里关掉**加宽窗口缩放触发区**。

## 不处理的窗口

- **已经画成 Adwaita 外观的窗口。** 扩展只看进程映射了哪些库：libadwaita、libhandy，或 Qt 的 Adwaita 装饰插件。它不读 GTK 主题，因为 GTK3 画不出窗口底部的圆角。[为什么 →](docs/decoration-model.md)
- **最大化和全屏窗口。** 它们贴着屏幕边缘，加圆角或阴影都不对。
- **普通窗口、对话框和工具窗口以外的窗口类型**，例如菜单和 Dock。
- **有相邻配对的贴边窗口。** 只丢掉扩展要画的那层阴影；客户端自己画的阴影保留。

## 什么时候用哪个状态

- **都加**是默认值：两条轴都由扩展绘制。窗口缺圆角或阴影时用它。
- **都不加**用于扩展不该碰的窗口，例如它已经自带同类装饰。
- **仅圆角**和**仅阴影**用来纠正单独一条轴。
- 在 X11 上，Mutter 会在窗口外画一层扩展清不掉的阴影；这类窗口选**仅圆角**，否则**都加**会叠出第二层阴影。
- 分数缩放下，圆角需要一次离屏渲染，文字可能发虚。打开**优先保证文字清晰**可以去掉圆角、保留阴影。
- 不要和其它画圆角与阴影的扩展或主题同时启用，否则同一个窗口会被装饰两次。

## 安装

需要 GNOME Shell 50，Wayland 或 X11。

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

## 开发

`pnpm install` 把 git 的 hooks 指向 `.githooks/`，所以每次提交都会跑检查：`pnpm run lint`、`pnpm test`、`pnpm run check-style` 和 `pnpm run ego-lint`。安装步骤与在嵌套会话里测量装饰的方法见 [docs/development.md](docs/development.md)。

各项决策记录在 [docs/decoration-model.md](docs/decoration-model.md) 和 [docs/rule-model.md](docs/rule-model.md)。

## 致谢

- 取值生成自 [libadwaita](https://gitlab.gnome.org/GNOME/libadwaita)，阴影着色器取自 [GTK4](https://gitlab.gnome.org/GNOME/gtk)，窗口行为遵循 [Mutter](https://gitlab.gnome.org/GNOME/mutter)。
- 同类：[Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners)。

## 开源许可

GPL-2.0-or-later
