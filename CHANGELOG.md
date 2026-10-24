# Changelog

## [0.11.2](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.11.1...v0.11.2) (2026-10-24)


### Bug Fixes

* **decoration:** cancel a queued disable when the close keeps the visuals ([96661b4](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/96661b4d811bd98765fa64a3b7601e617df7f130))
* **diagnostics:** compare a phase pair only when one container was resolved ([194cb97](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/194cb97a92740e11391db39823a4e09f3fcfd15e))
* **diagnostics:** make the offscreen-box invariant say something actionable ([57ac674](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/57ac6740ae5578b5f3999f44fe4de93d9bfdfd98))
* **diagnostics:** name a window by its class, never by its title ([8ca8095](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8ca809562f8346b25d90c2151e9ac2c7bb0a1005))
* **e2e:** release the client's timeline on a signal, not a delay ([ce2796f](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ce2796f5a9bf6570538e37cad32486473699d46c))
* **effects:** read the paint's target size the guarded way ([c2da797](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c2da7976b600c416a1d1da634f4c34570ba63729))
* **inspector:** unwind the D-Bus export when the constructor throws ([0501f39](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0501f396400e4f4f47c720cb1248669a3b0ac9bb))
* **lifecycle:** keep the re-entrant release, and never orphan the queued disable ([6abd3f1](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/6abd3f144395f28bc7cf8d5baafec27e60e9e9fd))
* **overview:** pad the preview shadow from the container's box, not its own ([42fb8a6](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/42fb8a64d73859c619b7b167baa807ffaae4a4c5))
* **prefs:** escape the toast text Pango parses as markup ([a6fa48c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a6fa48c8d11bc6b50b428291cd6af5c336f144e3))
* **shadow:** catch a failed allocation instead of testing its return value ([7c0f162](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7c0f162fd99d17ac6e3b4220bb22fbb0ef0e164e))
* **tools:** define the line helper before the mode that uses it ([a907930](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a9079300bf31ff27d956e512e8f5efb25e490d01))


### Documentation

* **compatibility:** record that the GL purge signal left in 51 ([ae4ba4e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ae4ba4e9213761925663ade23c3e353a3decb157))
* keep tooling out of code comments, and drop what was there ([95cab4e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/95cab4ef866b0fb27cf7e5664e26fd61ae03a121))
* list the modules the last few refactors added ([d285ff1](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/d285ff1342da9cb80d487157143a74f4a6dc4016))
* **metadata:** say why /proc is read, and what is actually stored ([e570596](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e5705964674ae2e1e83a4887d0f600a298997d0f))
* record the code conventions the lint config cannot see ([6e9530f](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/6e9530f3fa46d9135b80742a776db2ba87422c16))
* write down the house style, and align the prose to it ([4b82c18](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/4b82c18dac3f0718c8de59919d9850e3cb0cb98f))

## [0.11.1](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.11.0...v0.11.1) (2026-10-21)


### Bug Fixes

* **decoration:** derive and reconcile the clip's offscreen box ([96e3ed5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/96e3ed559db840bf191bcdb6c23d48ed064a428f))
* **decoration:** drop the settle's reference points with the decoration episode ([bcea3ad](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/bcea3ad396a062d013bd6e3ea1657b13b77bd921))
* **decoration:** hand the window whose second surface paints its box to the forced clip ([509450d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/509450de09e18fe71ad441a32739094443a859a9))
* **decoration:** judge the visual floor on the window's initial stable size ([b844936](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/b8449362aa2a97dd4f137999f06b60a33b25861b))
* **decoration:** read a bare X11 shadow's owner from the buffer's alpha channel ([a166c5c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a166c5c8325aee1d745f57830eaec1d0bd5f59ef))
* **decoration:** read the FBO's scale candidates from the actor's buffer rect ([fa08989](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/fa089890eb290dc03ef8ae3bad6ea2f42403b4e7))
* **decoration:** size and cut a window by the monitor scale the engine used ([ddb575f](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ddb575f48da2e0d0846696eb485517d4199ae7ec))
* **e2e:** move and read one pinned window, and poll for the placement ([3beda8b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/3beda8bebacb13a691b9236314184bfe72379ee0))
* **effects:** report a body disagreement only while the settle is undecided ([c597566](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c597566faffe0d74bcd8515bbe083fc5e63e776d))
* **hooks:** keep a failed check's log instead of deleting it ([d38d13a](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/d38d13abb876533599b31e76efb16b1032d3f181))
* **manager:** guard only what can fail, so a firing guard is visible ([53487ed](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/53487ede7e547d83febf35955a8395f43603e55f))
* **rules:** an absent wire field keeps the value the field table declares ([6542964](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/6542964ab0f05798e3d73a673c8c87a8cc771b33))
* **shadow:** do not report a settle that could not read the window at all ([6886201](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/6886201906c8ebdcf1cd2f74b1df75e049faf2b4))


### Documentation

* **decoration:** target unpatched mutter, not the !5179 patchset ([97f9b6f](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/97f9b6f7cd844c3d42c0dabbabf3dbeb18f648f0))
* **model:** record the flat-window inset boundary ([5665b59](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5665b59262adedd62b040c22e6579ce7bdba7d03))
* **model:** record why the desktop keeps the offscreen clip ([f99d9df](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f99d9df145cf735d7802166d69f39277b04514bc))
* **readme:** add the Arch Linux AUR install path ([9f71b87](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9f71b87213f7c349cd8bab6e0c1117a29c5fe0f9))
* **readme:** describe the decisions users see, not the code behind them ([2a3f04e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2a3f04e01d24f4d6049c6dd80acd08a79e370a53))
* **readme:** merge the overview-corner and crisp-text notes into one section ([664a563](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/664a563971846bf3ffec0f26989217eac79c71f3))

## [0.11.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.10.0...v0.11.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **inspector:** PickWindow now requires a boolean `debug` argument. D-Bus has no default arguments, so existing callers must pass `false` for the quiet interactive pick; a call with no argument is refused with InvalidArgs. There is no non-interactive diagnostics path any more.

### Features

* **inspector:** keep diagnostics behind the interactive PickWindow gesture ([b3855d1](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/b3855d1fb4ce878df2aa517970d71cc43eed889d))
* **overview:** keep preview cards sharp while rounding and shadowing them ([86d2ba7](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/86d2ba7488f9f152e25dd47aa738a4c2f7f9414c))
* **pick:** show the applied subpixel phase beside the mirrored one ([095ede7](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/095ede727e77dd817a9b840db69e943735c7f1e4))
* **prefs:** add rules import and export via clipboard ([#5](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/5)) ([f5e833e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f5e833e0492c3d4b140636c8a1f65caf5f6ecaa0))
* **prefs:** force corners on every window in the overview ([f3d2705](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f3d27052234789e0a74cb6a0c7acd986c9977240))


### Bug Fixes

* **classifier:** learn a window's pid when it arrives after tracking ([d85e6f5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/d85e6f53b700dd0edd45568cf9d9a253966df0d6))
* **classifier:** remember a window's pid instead of re-reading it at teardown ([64d1d2b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/64d1d2bc204c64978f948b1cab7afee373cfcf22))
* **classifier:** retry a failed /proc read on a bounded backoff ([55ea58b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/55ea58b8bde8017177a9c9f854ba93b75cdf2ae7))
* **classifier:** treat a failed maps read as unknown, not a verdict ([b1f83e1](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/b1f83e1c3ca76bcc13fda51bf85175178b9f36fd))
* **clip:** compare the settle's pair as the one buffer box they are ([671e490](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/671e490f2a079db05fd389a54b7c1af230cb7d68))
* **clip:** derive the flat cover from device pixels ([57cee81](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/57cee8102b265c52cd2106db4102e785120676d0)), closes [#129](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/129)
* **clip:** re-pin from the effect's actor, not the target field ([a7389d7](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a7389d79d147dd63b5d44568a85985b75350112a))
* **clip:** refuse a surface container whose box cannot be verified ([706d9dc](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/706d9dc2f82122aa5593bf994e9e5d865bdad592))
* **clip:** resolve a persistent body disagreement instead of holding forever ([40cae5c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/40cae5c9120265d13932becd402d7bd52aba0ba1))
* **clip:** resolve the cut's body on the paint clock, not the pass clock ([85dc87f](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/85dc87f022a675349f360007e2913980f34b7756))
* **clip:** take the ring from the buffer that made it, not from a held value ([2936d03](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2936d034e5a4f3409af25434cbba3ffff1c652de))
* **compat:** ask for a cursor by shape, only where the line has one ([7ac4c0d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7ac4c0d40105882fcaa913b00830c36dc668854c))
* **compat:** give 46 a way to a Cogl context ([5f9472d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5f9472de4a418f5000dcd3b0025cab9bb4092640))
* **decoration:** do not persist a substituted scale as the last good one ([e554cee](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e554cee0af23329788d82b03ca11c29ee3735b20))
* **decoration:** guard the ring hold's reads ([3f28f3e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/3f28f3ed403d19ee4a71722407d1d82e8936d414))
* **decoration:** keep the corner state current on passes that draw nothing ([cd5b7d3](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/cd5b7d3f05cc1226d616bf72eaaa68011d823bed))
* **display:** give an unreadable monitor scale its own unknown state ([621f85c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/621f85cb8dedd6bb30b208c6c9aff4add95bbbd3))
* **effects:** align shadow shader cutout with GTK4 analytical box shadow ([baa0699](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/baa0699e22610ab24d6135ffe725d3fc5bbc8f92))
* **effects:** cast the shadow by the body the clip draws ([4eb43ac](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/4eb43acc77396c357b24bfd211ff8e603605c93c))
* **effects:** compensate Mutter Wayland subpixel grid translation to eliminate edge gaps ([4cc166d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/4cc166dcef2ed79ee87cb9c3d15f511ac290e493))
* **effects:** crop a narrow window's shadow instead of scaling it ([9602c32](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9602c320fe37d5f8ef280f16e8eaed7844ca4047))
* **effects:** cut the clip and the shadow on one subpixel phase ([6d17475](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/6d1747533b9bc963543b5213d2fdb39391cd8c57)), closes [#117](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/117)
* **effects:** cut the clip on the surface container, outside the FBO ([9373af9](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9373af95b3575869034afc54ec84d827f50b2143)), closes [#117](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/117)
* **effects:** decouple straight edge clipping from corner AA to prevent dragging blur ([0021992](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/00219926de8853a543ccfcdea0aef1b33287687e))
* **effects:** derive the phase strategy and the shadow's phase from the clip target ([a0ffc1c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a0ffc1c48e8c568cd96d7f795d724285ce6cad7c)), closes [#117](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/117) [#119](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/119)
* **effects:** eliminate overview edge aliasing and preserve mipmap LOD derivatives ([b1d28d3](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/b1d28d3904aba0096d713e0361eddfa08c5a2ced))
* **effects:** excise flat window client borders with safe insets to prevent corner seams ([c826e35](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c826e35bbccb66909fddda74476576568db9d463))
* **effects:** extend corner slice to cover Gaussian optical decay ([428676d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/428676d0023fd05fc06e530130f8dd8af08dfc7c))
* **effects:** extract Gaussian constant SQRT1_2 from upstream common.glsl ([9cddd7c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9cddd7c009e34211ee15bb6bd01920785292564c))
* **effects:** isolate CSD stroke normal sampling push to prevent ringless edge flicker ([126f636](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/126f636be06ca05e9fc64012f2cb2c99036947a5))
* **effects:** land the shadow cutout on the scaled window's visual box ([20ba273](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/20ba273589b0eec6a8f04a74ede5405acf7e3c64))
* **effects:** probe the mask by capability and never re-probe a masked window ([13009cc](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/13009cccfa526edb139731631a775be8d9c629ec))
* **effects:** push texture sampling inward along boundary normal to eliminate fractional scaling dark seams ([83b880a](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/83b880aa69155f5b6d848897efe7b30f755e83b4))
* **effects:** report a repeated shadow-bake failure once per episode ([e2f5a50](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e2f5a50e49a8084024ff2a09f2e3ff5d9183af13))
* **effects:** snap buffer body margins symmetrically across device grid and align body edge ([dc2d19c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/dc2d19c8520f115bdfa57058d68100ec9fec8c86))
* **effects:** stop rewriting the shadow's translation when it did not move ([bd58700](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/bd58700dc10b4ef4927e4f7b92feeb0034d641f1))
* **effects:** suspend the clip on a degenerate target instead of painting nothing ([989c200](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/989c200fb54a7b4f76cddb2f9a357a010a9e548f))
* **effects:** take the window actor as the body authority ([f26bc73](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f26bc73e476e4e53f6cfe766582e732b3955c38a)), closes [#121](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/121)
* **hooks:** run the performance check on push, and fix the band guard it exposed ([8acb3e5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8acb3e5e344167d585c53d2fa0a287df8f2a4a94))
* **lib:** choose the clip target by one verified rule ([bb23925](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/bb23925f8f9e41bc8fc05071f5fe501423d7dffb)), closes [#119](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/119)
* **lib:** derive the shadow slice span from its UV span ([48a7c3e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/48a7c3eac4146a80249d81ef55f4ec6c571c7b7b)), closes [#119](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/119)
* **lib:** read the declared ring one way ([c1d8b69](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c1d8b69f99e22db8d16d5e8274da7abfa4f2ca02))
* **overview:** do not let an unreadable frame rect escape the shadow build ([891631b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/891631bd99c60dff416254fb36fe24ce79fc8b2d))
* **overview:** hold the corner and shadow work on the window, not a card ([de82fe4](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/de82fe4764395711a7707accb0405fb72d1deacf)), closes [#27](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/27)
* **overview:** keep the mask verdict across drop() ([137e630](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/137e63075a19fcc86b6700dd877a44849669f5ce))
* **overview:** key the bypass and the shadow clones on their actor ([51008ca](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/51008caaa9aa28baedae655288011fe11f1fec35))
* **overview:** mask every Wayland window in the overview ([8962245](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/89622455524f2e2d79b0433c9f8bf27472f6c206))
* **overview:** never re-probe a mask the overview has already moved ([cbfc125](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/cbfc125553fb356a50f3a157adbd3e0b6d2900d7))
* **overview:** never round a window outside the overview ([afd131b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/afd131b947c41e06c350fd2bbd04b166b651088e))
* **overview:** re-probe when the mask readback cannot tell, and back it by the audit ([7e1f065](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7e1f065d2a86e0603f657ab67411543f4f822f11))
* **overview:** refuse an unreadable client type instead of masking it ([2193d78](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2193d78d7164d97195f9127e0ee82244c12423f0))
* **overview:** settle the overview mode once and keep the clip in step ([0d827b5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0d827b539cf744b5b553cdb4b58d2008c7dd1729))
* **overview:** withhold the mask verdict until the draw target is allocated ([e1c5bef](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e1c5bef57b223ab33e09bf545ff2527c7bd70253)), closes [#121](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/121)
* **phase:** answer null, not a zero offset, when the read fails ([7bbe680](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7bbe680e5f9a6498e01087690d9b5c7ce159b3a0))
* **phase:** find the surface container past Mutter's fullscreen backing ([f9dc5ae](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f9dc5aec872400918157ce838b31c463a0dbbf7c))
* **phase:** resolve the surface container with the clip's St ([9f84d31](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9f84d317d236a25891188aca449e67c04ffaeb3b))
* **platform:** honor the compositor grab result and boolean allows_resize ([1340356](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/1340356aed63531ba189fe1941647dce06f40d2e))
* **platform:** state the ROUND snap deviation instead of claiming GSK parity ([f842afc](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f842afc67eb4e4267d8dc6a8f30edbbba0d5f2cc))
* **prefs:** say which windows the overview corners option is about ([0da8c63](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0da8c6320eb90927a69a40290f0527e0f620022d))
* **prefs:** show a failed import apply instead of closing over it ([2fe9ed9](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2fe9ed90002a3aba2162d95e906b921c0ce179ac))
* **reconcile:** keep the decoration while the geometry cannot be read ([0312dee](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0312deeccbf7665a3daf43807d1d7b8647724185))
* **resize-band:** drop the band when the monitor bounds are unknown ([cf36cb3](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/cf36cb3bf3b7a9f913c22364eb8c8be68a405991))
* **shadow:** derive the body from the clip's authority ([d9fc7dd](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/d9fc7dd690677811ce51c025cd7d4b44605efab9))
* **shadow:** relayout when the clip target's read changes in place ([deea5ef](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/deea5ef9ce751658522e838f03bfb566e41d9101)), closes [#126](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/126)
* **tools:** stop the nested session by pid, not the shared display name ([26e4f65](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/26e4f6563b0f2990c95cea4d744ebf52021edec9))
* **window:** distinguish an unreadable monitor from a non-overlapping one ([9f98fd5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9f98fd517ac1356d1ea61ff0bd20ff3ba85ffa20))
* **window:** surface an unreadable monitor count or scale as unknown ([47efd19](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/47efd199bdd66d6dfb208cc2050f539ae1d85e03))


### Performance

* **decoration:** resolve the MetaWindow once per actor ([714a428](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/714a428dee521e5d6354a03cdfefdb1faf10cbed))
* **phase:** stop re-scanning the monitors on every paint ([cf02cfe](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/cf02cfe1b83caaa23935a99829f3783b76a079aa))
* **shadow:** stop rebuilding the slice table when only the cast moved ([62a7a72](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/62a7a7267f028dd10444b9f9d5ee9f1b7ebda837))
* **tools:** budget the resize CPU delta against its own baseline ([84c49e8](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/84c49e890a654eae53588cc3cab94aa59c320ff1))
* **tools:** take the stress ratio per round, then the median ([12a56b0](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/12a56b0f80485be15cd8d1b8612ef624a3370065))


### Documentation

* align documentation and comments with the code ([0faea4d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0faea4d96656fb61f7ea431851079d4560d289d0))
* align documentation with symmetric physical margin snapping ([2a6bc32](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2a6bc3296eb1eb77b4d42a6e56a8d0b57d4b3bbe))
* call the X11 clients XWayland, and name the overview corners capability ([437912e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/437912e9e82c1f32ccd8dfb029fd4851466c56e9))
* **clip:** record why an unreadable window size releases the hold ([cba7539](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/cba7539d0c2e92ed86e7b6bd8b102ec470ed1f01))
* **decoration:** record the principles the decisions are made under ([db19548](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/db19548d924c542720b1c6fc327de6208d18e432))
* **decoration:** record the two clocks, the five rules, and who owns a reading ([9ef2cbc](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9ef2cbc2ab6418e7b08d4939f133010af23640fc))
* **development:** document the session queue and its timeout ([3ca0069](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/3ca00691770f94aff3f398b8270c4f2af777046e))
* **development:** record who a log line is for ([bf231e3](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/bf231e3eaf80d51f9c436175e48a3390359d0b47))
* document straight edge AA decoupling and safe inset alignment ([90867c9](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/90867c9249133620085b4314c9dbaca4463b3202))
* eliminate circular doc pointers and greeter comments ([62c7138](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/62c7138bc337de90a8ec281da718da57ab56186d))
* generalise the clip/shadow edge rules into one section ([76e3dae](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/76e3dae7c22af75b6f555754410e2f4888880bff)), closes [#117](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/117) [#119](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/119)
* give each fact one home, and fix the drift the code left behind ([d173e58](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/d173e5845584742816ab978d9a7ee7ef7234c11c))
* guard the phase-freshness ordering assumption instead of changing it ([fdf8972](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/fdf897201c32df7e25c8fff7a93a0d546ff59597))
* introduce patched mutter package in Going Further ([a6b4482](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a6b4482fc8c2eefe4130f395e4abb66bbd602b1c))
* **preview:** update the comparison asset, and store it losslessly ([4bc5039](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/4bc5039875f10d0eacb3b8434affba8ffd1ffdf3))
* prune implementation detail from the design documents ([a927b46](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a927b46862e3daa5340b62db34a903b9ff1f1070))
* record one body authority and the container identification rule ([8b63f59](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8b63f5991d148f34ccf4d494dc74266dfc6d1ab8))
* record the overview probe's NULL causes and the rules they earned ([fbfba2a](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/fbfba2af557c2681a481bbb656592a243255acfe))
* **rule-model:** the resize axis carries the tiled ring ([7167abe](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7167abeb28aa521a76e46d590652e3d518407187))
* say what a window capture of a clipped window contains ([22eb7de](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/22eb7de9f74e359cbea454c152683059c6d214e2))
* state the straight-edge guarantee and give the alignment fact one home ([5dfd8c5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5dfd8c55fe8a7d51352893772c013e04cb0e74e3))
* synchronize documentation and toolchains with codebase reality ([8642bfa](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8642bfa8cf3092b9122aaf53e496f5867a1cad35))

## [0.10.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.9.0...v0.10.0) (2026-10-03)


### Features

* **effects:** retain rounded corners in overview with hardware mipmapping ([#80](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/80)) ([1416bc4](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/1416bc4e03667a238ea86589b4e6d870468482e1))


### Bug Fixes

* **effects:** erase outer corner fringe on windows without shadow insets ([401ca43](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/401ca4390aa0b1bc74f0d7b5bf7e05e41606e51d))
* **lib:** do not treat libxul as an adwaita provider ([a27a4bb](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a27a4bbc8bd047f2163e4047b168e6c64941eb8c))
* **prefs:** do not auto-collapse rule row when toggling axis switch ([f977cd5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f977cd5d29452299e3f4ed24e5453dcb0038483f))


### Documentation

* **compat:** record the invariant the cached static snippet relies on ([38ea4f2](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/38ea4f2c09979007515dddfe57136b2c83e1c518))
* **decoration-model:** say what Mutter's X11 shadow costs on a focus change ([345aea6](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/345aea654dc093081ff645bd1a02f251da0f651d))
* **development:** say where the API-compatibility claim stops being mechanical ([387c983](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/387c983ed84a5484bda804728c020b2828f471e4))
* **readme:** say what a correction cannot fix ([abcbeaf](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/abcbeaf2de639be06d1abd122264303aef76fbbf))

## [0.9.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.8.1...v0.9.0) (2026-09-29)


### Features

* **style:** derive which states animate from the SCSS ([246b826](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/246b8260ae442bc694a04313ef4e5ef93cdaf23d))
* **style:** draw the tiled ring as a shadow layer that carries a colour ([e6a627d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e6a627de8fd05cf5c68dff749ba6fbdf8e89b6f2))
* **style:** stop blending when the user has turned animations off ([85589e6](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/85589e612c50c9f7fd1737ab2f9108e653de3310))


### Bug Fixes

* **compat:** tell GNOME 45 apart from 49–51 by what the backend can do ([8e2c7f6](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8e2c7f69fb485b2a1f87c300d4e7704832f3ea04))
* **detector:** clear a client's ring only when the tiled style draws one ([ea3287e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ea3287eb7a2df7216c416b320de91ffd7c66efed))
* **manager:** decide the tiled decoration actor from the axes, not from the shadow ([7581a76](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7581a7687fa4fa1061acccbdcf519dcf4ba3b6e4))
* **manager:** reconcile a focus change immediately, not after the debounce ([5e24d83](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5e24d83362d1295601b1f4f1017066ddfc86f44d))
* **prefs:** generate the picker highlight from the Shell's own pickers ([4af7402](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/4af7402268506f894da681f41d46e18b11366f5c))


### Performance

* **shadow:** advance the blend from the paint pass, not a 60Hz timer ([1170675](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/1170675a98138e20db8fc7bb0f62e2b2f388b526))


### Documentation

* correct the API surface against the audited declarations ([2050ab2](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2050ab255b3ba2805eb53fee83f5da3eaa2cef76))
* **decoration-model:** record why the two libadwaita variants are left alone ([5ed8222](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5ed8222b09a66922705b633b66be5222110e3b0c)), closes [#69](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/69)
* derive the API table from the audit record instead of typing it ([a18e036](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a18e036fbb681e79a63d220adbb486c9afbf5a79))
* **development:** say what a stub may stand for, and what only pixels settle ([7ba9068](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7ba90687504a514020953a5e3e4b1ec5e1ec598e))
* **readme:** fold the related-projects list into the adw-gtk3 entry ([ec0b825](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ec0b825458deb9f8579d211bc714e021c108e1b9))
* **readme:** keep the license section to the license ([e1698b0](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e1698b0b683e49ad0089cd17771a40690f284757))
* **readme:** make the Chinese README correspond to the English one ([a5b51a5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a5b51a580aad3995ba8e1120842a921f2a161028))
* **readme:** show the tiled ring and the states the decoration follows ([c9d9889](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c9d988978baec069c1565c7661ac8aac8dbf38c7))
* say the project is LLM-assisted, and what an EGO review rejects ([052d8cd](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/052d8cdc5c08298694ebffc2d67c14847b16c1f6))

## [0.8.1](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.8.0...v0.8.1) (2026-09-28)


### Bug Fixes

* **prefs:** escape the ampersand in the group title ([445a1cf](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/445a1cff070901d2f47c95f675ef5a31df6ab8eb))
* **prefs:** name a correction row after its axis ([2470d86](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2470d866041ee5ac79997852efbe2d0522603da5))
* **prefs:** rewrite the interface copy to follow the GNOME HIG ([3e7d346](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/3e7d34673a7d48bf7cd21a432c72f82673714cdb))


### Documentation

* fix what the Chinese README broke of the style guide ([97ed7ab](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/97ed7ab16f1370de6e82f29e1560c8f27dbcf48f))
* point at the projects that cover the app itself ([c87c578](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c87c5787a8bda123e9abd129f5e6778cf3ae3711))
* **prefs:** tell translators the entity placeholders can be swapped ([0d4067e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0d4067eb5664da3c24d34cea077816111ca5fa3f))
* update preview image ([e291b4b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e291b4bdc492a0bdcdb6428ea38cfdbf498272c7))
* write both READMEs in plain language ([5aef810](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5aef8105c4dcbfc297dc9b3df72af7bb20f6e66e))

## [0.8.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.7.0...v0.8.0) (2026-09-28)


### Features

* **effects:** align shadow slices with device pixel grid and cache per scale ([da3fcec](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/da3fcecfed2dd34f10f615c7d192d3a000c6bf64))
* **effects:** snap window clip with grow rule and normalize shader AA to physical scale ([8d8398b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8d8398be097edf87bd345962765b18289fcfb232))
* **lib:** implement GTK4 physical device pixel grid snapping primitives ([bc22a98](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/bc22a9840f639620ea458d07b68ce91065e11bb5))


### Bug Fixes

* **compat:** never cache an unresolved shader uniform location ([bbca576](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/bbca5763af3c7179c84cbbd11b6eb5030b9791fb))
* **core:** keep the /proc probe out of the native-like-corner queries ([8759cea](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8759cea132438e78156756589afaa976103674a2))
* **core:** tolerate half-torn-down windows while reading properties ([ed2ed5b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ed2ed5bec15258cad3f22c5dc33641fe23b05a06))
* **e2e:** remove the pick-reply file in cleanup ([fd5e1e9](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/fd5e1e901bcd3e9753bb7acf21968f86e190acd3))
* **effects:** clamp the clip corner radius to the body it rounds ([a0b83a8](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a0b83a8af32fa87f96d904b7224cd2729a1fd88e))
* **effects:** keep shadow slices ordered at degenerate window sizes ([923f08f](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/923f08f931d0932e5c70cb849b4c45650e4f31fd))
* **effects:** restart the shadow cross-fade on a mid-fade style change ([72461d5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/72461d50ba09c5c9f5c2eb32c392b621491dcdcc))
* **inspector:** answer the pick even when the target window tears down ([7cb6502](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7cb6502938f4885794d038c9bbf731292b8f9cb6))
* **inspector:** drop the D-Bus handlers GJS never disconnects ([a8237f0](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/a8237f0a104e64fa0f3d530624665e33adf836e4))
* **inspector:** leave no picker on the stage when it cannot start ([32ff95a](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/32ff95a7525a221ce3862cec84a9b731c29cfa7a))
* **manager:** finish teardown when a window's actor is already gone ([39dca0b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/39dca0b100e1323a8d19d27ee757495494abc707))
* **manager:** wire the window actor's signals once it exists ([57ebade](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/57ebadef5790462bc46e6286235c2afeff8e914f))
* **monitor:** bound monitor queries before Mutter logs a CRITICAL ([5cfe508](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5cfe5085c7a4d73b5650af888152d63ffe9e1fec))
* **pick:** treat a whitespace-only WM_CLASS as absent ([9c652c5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9c652c549849823776cc81616bcad2a7834858ab))
* **prefs:** bound the pick call and report a busy pick ([aa3fdbc](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/aa3fdbc846c4698a5bdb4d99a26a57ec36bedd9f))
* **prefs:** cancel the pick call when the preferences window closes ([332d9d0](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/332d9d00f698cc8cd14601cf9dbca235ab3c7092))
* **prefs:** refresh the rule list on external changes and unescape group headings ([c1562b2](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c1562b22bc8edefaa30399773c2c253b71d2f5f1))
* **rules:** canonicalise a rule title's key like its state ([3c32619](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/3c32619b7b186312557de0d7cb1aabb23a04d8f3))
* **tools:** fail the generators instead of silently emitting wrong output ([984fcf9](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/984fcf92122d3aa461faa8ee196d1e9eb4a85947))
* **tools:** reap a dev session that never became ready ([fe51bc6](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/fe51bc6a7e7188a95b5e2cb60dcfaa053e3c7b36))
* **tools:** replace the deployed extension instead of merging into it ([8723203](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/87232037fb767c3ef5b7e6f18c99c4cd7d3951d2))
* **window:** do not remember a peer-borrowed identity ([3dce71a](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/3dce71aaf2494eebd2f7c124910a2df1fe201b07))


### Performance

* **manager:** reconcile the focus pair, reuse the read insets, cache high contrast ([5153756](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/51537565f652b9146b6563b9bd03be19c44735d2))
* **resize-band:** compute the bands in place on the allocate path ([bd7ebad](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/bd7ebad9294dfe5a64aac283023dd1c5e496223c))


### Documentation

* **architecture:** document GTK4 grid snap alignment and actor-local coordinate model ([03e33a4](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/03e33a41b8400efc22f2670fa88b82d7006346dd))
* **architecture:** point shadow geometry and uniform caching at their modules ([e0e9b21](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e0e9b21a529002b59a2d20bbe50f56229440b330))
* **clipTarget:** record why the X11 fallback keeps a foreign first child ([f6991db](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f6991db036a59aef95474ac3af830f5c5a8ae350))
* fix three claims the code contradicts, and fill four omissions ([482dfa4](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/482dfa49d74ec619fefd759decb2dc4702938617))
* **manager:** record what a throwing pid read costs ([82c6802](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/82c680247a5b339a2f1ba491c6efd7886c7f8ca7))

## [0.7.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.6.0...v0.7.0) (2026-09-25)


### Features

* **compat:** add GNOME 51 support with zero-side-effect ponyfills ([dc44223](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/dc442237fd2cda9e8c1494f5d8125cfeaf1d9f40))


### Bug Fixes

* **inspector:** align pick highlight border and adapt square window corners ([ff72000](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ff72000142c730b7dd70dbb8750967279f7ba364))


### Documentation

* establish anti-drift documentation hierarchy and align inspector architecture ([45baedd](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/45baeddf5f94be17c64fb0f7a1cd7bd9e9a605af))

## [0.6.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.5.1...v0.6.0) (2026-09-21)


### ⚠ BREAKING CHANGES

* **rules:** rules stored in the previous form are dropped, not migrated. A rule is now a per-axis reversal written as 'corners,shadow', the resize band is one of its axes, the old resize-band setting is gone, and the rule key gained has_ssd - re-add a rule from Preferences if one of yours disappears.

### Features

* **prefs:** label the pick button, and stop showing internals ([cfde3e3](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/cfde3e3f0dac2149a2542d7d24fc2d296f022ec0))
* **prefs:** show the window a rule was picked from ([dfdb668](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/dfdb66856d81911a8e55822fa9d631105ba16e33))
* **resize:** band bare windows by default, opt out per kind ([4d261ed](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/4d261edba80da5e397d3fec758b9fb2aa92228f3))
* **rules:** correct every axis on a pick, and name the rows corrections ([990ff0f](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/990ff0fa71801bcaa18a791d6835a66d7056eb51))
* **rules:** distinguish windows with and without declared margin rings via has_ring ([592e00e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/592e00ed7ba49726c5b2f743b34ad5e38a918e2d))
* **rules:** override each decoration axis by reversing the automatic decision ([7ca1e37](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7ca1e37f1f893a87deba7b42a7b4ebec04f89cb5))

## [0.5.1](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.5.0...v0.5.1) (2026-09-19)


### Bug Fixes

* **dev:** isolate test sandbox xdg config and enforce extension enablement ([5169d58](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5169d58042887822f5ade3b9cebe001086e33903))
* **manager:** ignore non-decoratable window types and guard focus reconcile ([ec67441](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ec674412c2d8975b177e6095160996fa6e2c4c7f)), closes [#13](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/13)
* **manager:** resolve clip target to surface container when foreign widgets injected ([69ed0ee](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/69ed0eefbf0b87597fa199b6e73c2f926ace516b)), closes [#16](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/16)
* **manager:** verify compat coordinate space and react to late child injection ([462bdc1](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/462bdc16ffb2edfac298ed6aeb10dac17050b200))
* **nativeLikeCorners:** read /proc/&lt;pid&gt;/maps asynchronously ([8611225](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/86112253027b2eb679f3af93afdef9104726bc48))
* **probe:** resolve probe timing inversion, enforce symmetrical lifecycle, and optimize band insets ([61a9b57](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/61a9b57fa125fe52f7de0d762a3cbdd4365f46f1))
* **resize-band:** keep the band on tiled and tile-matched windows ([1b3f59c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/1b3f59cd9814631efffcf95d1108733c338562cc))
* **resize-band:** read the client and the ring it reserved, not the declared margin ([062adf1](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/062adf1d7e2c289c00755172d7a7ec7e82641df7))
* **shadow:** modulate pipeline opacity with paint opacity to fade on window close ([c918f27](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c918f27359b30c495cd3e3b192d0bb605ae54310))
* suspend clip effect during overview to prevent blurry downscaled previews ([0fd03d5](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0fd03d58564afc89b7725db330e2a701d61162c2))


### Documentation

* **decoration-model:** record how a tiled window's edges are decided ([284fd7d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/284fd7db281d7bd06449d7e72141aa9672f3cbf5))
* **decoration-model:** record who gets a resize band, and why ([55c47fc](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/55c47fcf8ace2d854b2ea55ff4551b930f1388b5))
* decouple implementation details and define architectural invariants ([84ea8b3](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/84ea8b37b57142c2d2509e8e2bf0c64a4e311de4))
* formalize CQS purity rules, decoupled metrics, and overview suspension rationale ([590cc5b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/590cc5b5f3450bc6ac9d7dc83d7a71737c7cf8a8))
* **lib:** document libxul Gecko rounded corners implementation and Bug 1850827 ([02573de](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/02573de056ac9f1a5d4cf5c1148a7bc2214fdb44))
* **readme:** decouple metrics, elevate drag ergonomics, and polish hero layout ([c08dc8a](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c08dc8a8d64261b67849d0b2c3dc25b599ba894c))
* **readme:** disclose LLM-assisted (vibe coding) development and real-world testing ([ca16724](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ca1672480bb1abe45a3a4f38008a8c8fbca9a532))
* **readme:** document installation via release zip archive ([fd200bb](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/fd200bb5419851952e3acd92500fa9a891deab65))
* **readme:** streamline copy, improve readability, and offload deep specs to docs ([5fb9b00](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5fb9b00e701e01fb0d228fb0349add2fe44b8039))

## [0.5.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.4.0...v0.5.0) (2026-09-16)


### Features

* **rules:** support size specifier for fixed-size window keys to resolve collision ([ee74833](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/ee74833050bed9e408902ad42f635261238a49d3))


### Bug Fixes

* **prefs:** correct pick suggestion to break status quo and clarify feedback ([79a7c17](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/79a7c17083eeb5a11a0f2f2afcda5fbc5e4d5a5b))


### Documentation

* **schema:** name the size specifier in the fingerprint grammar ([1263cfe](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/1263cfe1561548d6dcf5304ee14a2c8fd21d1c76))

## [0.4.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.3.0...v0.4.0) (2026-09-16)


### Features

* **detector:** read a declared margin as the client drawing its own decoration ([210b2f4](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/210b2f462f0177bf9aee462ce5d26614b1fe14d4))
* **effects:** widen a window's resize band to 12px, as a native window has ([da90aab](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/da90aab50c3aadfe84203008ecbae5c3bd0199b9))
* **lib:** treat libxul (Firefox/Gecko) as a native-like corner provider ([0818d3e](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0818d3e77cb5e3e567627608261157336755de5e))


### Bug Fixes

* **detector:** keep the shadow axis reading any declared side ([2eee6f9](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2eee6f9a3560064e6257e504edd2689e20760a91))
* **effects:** address review feedback on outline comparison, teardown guard, and benchmark methodology ([9c8a183](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/9c8a1832fbc8efe92e041d4c48498cf94e332f0d))
* **effects:** draw the inner outline at the strength it was meant to have ([45b15f9](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/45b15f9a45a5a1599e8ceb4966099ccc50ca2b36))
* **effects:** keep a degenerate frame from erasing the window, and gate the band ([513c49a](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/513c49a0fb82fecd13790744b70c7a66b833089f))
* **effects:** only band a narrow window, and keep the geometry live ([b10c164](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/b10c1641dd6847383746e4f89ae424af6423b39d))
* **lib:** let the corner regions extend 24px along the edge ([5dcd7b1](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/5dcd7b10a64fd63aed0fde264422ecdef29fa6dc))
* **lib:** skip only the toolkits that round all four corners ([7c3ae19](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7c3ae196095072ff021f073bb2136f276be8e1f4))
* **lib:** take over an X11 SSD frame's square shadow ([45e0e35](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/45e0e357752db3a66b6adf99ec1605ac7d49ef84))
* **lib:** take the corner assignment from GTK's order, not from a floor ([c1f2e7a](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c1f2e7a2e433f2ff1baa77bb7f6ec2f7da262ebc))
* **lib:** trim the corner blocks to the twelve pixels GTK can receive ([1c3e27c](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/1c3e27c41ffbcc31ccdb6d37151bbdaa148dbeb1))
* **tools:** make the generated shader say where its numbers came from ([e3545d1](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/e3545d15bc60892778cdbf24de4f30bfb52867c5))


### Performance

* **effects:** guard uniform uploads and reuse actor boxes during resize ([4a442cf](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/4a442cfd42a487a5c3da9e3ed77a59b708e25434))


### Documentation

* overhaul user-facing documentation, metadata, and copy across the project ([5901696](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/59016960f63e1fba03217af906acda4b1e14c72a))
* **preview:** composite native top-left resize cursor in comparison asset ([1302ed8](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/1302ed8e94cde817473092d6d153c69998985c3c))
* read the numbers as depth and length, not two depths ([b1423eb](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/b1423ebf5f781b57b23e89bb2efeddb9bdaf3ce2))
* **readme:** constrain preview image display width to 500px ([0c00460](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0c004604280b844d8696665a0b7a4638828db600))
* record the grab band a native window actually has ([7a3c836](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7a3c836794f156a54882320df2260a9c84903586))
* say where the problems actually are, and why ([d88834d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/d88834d68d39c6740ae866d551d7c0d05e2ed3c7))
* say who takes input, and fix the wording the review found ([7d76652](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7d76652e7e3012bd5ef1f1d5d3afb3122306fdf2))

## [0.3.0](https://github.com/everyx/gnome-shell-extension-window-nativizer/compare/v0.2.0...v0.3.0) (2026-09-14)


### ⚠ BREAKING CHANGES

* the UUID becomes window-nativizer@everyx.github.io, so GNOME sees a new extension and existing installs must be reinstalled. Move the old rules across with `dconf dump /org/gnome/shell/extensions/csd-fixer/ | dconf load /org/gnome/shell/extensions/window-nativizer/ && dconf reset -f /org/gnome/shell/extensions/csd-fixer/`, then drop the old install with `gnome-extensions uninstall csd-fixer@everyx.github.io`.

### Features

* **decoration:** one owner per axis, four states per rule ([22db6c3](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/22db6c31e5fc455bc5489a0cc67a5b2f0053f94f))
* **detector:** round corners on X11 and SSD windows, skip libadwaita ([034d038](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/034d0387eb77a18c6ee54c04f24fb6039dd3556f))
* **detector:** round every window unless its corners already look like ours ([0dc0613](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0dc06137d2aab26f4d0d4709e8136c0eb3218285))
* **detector:** take the corners of adw-gtk3 GTK3 windows too ([056ea07](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/056ea074fa39fc4044d46d524d5218b1f32575e8))
* **prefs:** align the copy with GNOME's writing style, and rewrite the READMEs ([28d3a92](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/28d3a9216a89971572007262153090b74f8763bf))


### Bug Fixes

* **adwaita:** do not cache a failed process probe ([448c253](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/448c2539bc7618d581bde1d73e726cffef98590f))
* **detector:** skip degenerate helper windows ([3120e42](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/3120e4276dec0830852e6c645483eb0b795a18c9))
* **effects:** clip the window body, not the actor ([76e0998](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/76e09981b78f017ece5c0d864e26bd73724b5d5d))
* **effects:** seal the shadow cache and share the style key ([76b4f92](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/76b4f92d1dd2636528d6b4fddbbab894250a69ec))
* **identity:** read window strings without throwing on non-UTF-8 ([7ff0b91](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/7ff0b911b18077c820656159f58be1c98b395cdb))
* **manager:** harden the clip decision, lifecycle and teardown ([c163509](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/c163509ca3a66bbf00d015882a9df3c7aec265fe))
* **metadata:** declare only the Shell version we have tested ([b903755](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/b90375544a9ce8293366825c1aa36fc2b492fcc0)), closes [#8](https://github.com/everyx/gnome-shell-extension-window-nativizer/issues/8)
* **picker:** take only the corners where the shadow is not ours to clear ([37721ce](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/37721ce0c5da882ae07d894eeb6d4a5b6babbc62))
* **prefs:** drop the first person from the window rules description ([8b6d84b](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8b6d84b95b0e500943f0eec2e072b2f8a64b0c72))
* **runtime:** picker, enable, identity and client-type ([8a0e384](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/8a0e38497af2b08c1c0fbcc01bca9e365a5904d2))


### Refactoring

* rename the extension to Window Nativizer ([1535dfe](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/1535dfe97a059c47c3d5abf24ca37f6cef5ca58b))


### Documentation

* read the shadow axis as one-sided evidence, not a declared fact ([2223e05](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/2223e051ec72bec52f7063509d0fe37a38d3d4af))
* record the commit convention and align the docs with the code ([0687eea](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/0687eea97bdc35d9602122481b35aeb17efaa69d))
* record what the shadow comparison measured, and the window we cannot measure ([d34684d](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/d34684dbc64636367212fe62978489e2293b4d75))
* rewrite the READMEs ([6ffbe7f](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/6ffbe7fb98900bb27f2a112b771e631a0e0b394c))
* say what "looks native" actually skips, and claim Shell 50 only ([f8babf6](https://github.com/everyx/gnome-shell-extension-window-nativizer/commit/f8babf6ea473cf1b2627d4b8259ff9cb11cb1c73))

## [0.2.0](https://github.com/everyx/csd-fixer/compare/v0.1.0...v0.2.0) (2026-09-12)


### Features

* **benchmark:** add automated CPU and memory performance benchmark ([561c803](https://github.com/everyx/csd-fixer/commit/561c803e896038c366626deb67b305261c7a2d1c))
* **detector:** benchmark composite static fingerprints against KWin hierarchy ([13515c3](https://github.com/everyx/csd-fixer/commit/13515c3a724955ad02792e0e6482f813e093a361))
* expand supported GNOME Shell versions to 45-50 ([3f1f3f9](https://github.com/everyx/csd-fixer/commit/3f1f3f91bb762cda9a15a11c741decb662895a31))
* **inspector:** add interactive window picker over D-Bus service ([b2442da](https://github.com/everyx/csd-fixer/commit/b2442da15b8a7e6110f1a274fd795030449db123))
* **prefs:** rebuild the rule list around what a rule matches ([b9c2279](https://github.com/everyx/csd-fixer/commit/b9c22790610c4731af7782506d41dafa42fc633e))
* **prefs:** report a pick that added no rule ([002a5e9](https://github.com/everyx/csd-fixer/commit/002a5e92b2ce0e0e5c3da069172ebbfada5c925a))
* **prefs:** simplify rules UI with instant inspect workflow ([ec2a425](https://github.com/everyx/csd-fixer/commit/ec2a4254eeabf32df77885fc900f2d295bb51d9f))
* **rules:** isolate subwindows using native properties and zero-confirmation picker ([c8061c2](https://github.com/everyx/csd-fixer/commit/c8061c261b15c388b231a101924d90a863da996b))
* **rules:** report whether a picked rule would change anything ([419c4b3](https://github.com/everyx/csd-fixer/commit/419c4b3d1fe8198a087b6d03347167cc96506184))
* **rules:** split decoration rules into suppress and force groups ([1e59dbe](https://github.com/everyx/csd-fixer/commit/1e59dbebf8b21bd174127b60f2390172ac14bafe))


### Bug Fixes

* **detector:** drop the scale factor the content margins never needed ([8249095](https://github.com/everyx/csd-fixer/commit/824909580d5ad730022abdf652300ec0ebd5dc0a))
* **detector:** narrow X11 native shadow skip to windows without frame extents ([f7edbe8](https://github.com/everyx/csd-fixer/commit/f7edbe853bec459907beeca001b7a685e099b48f))
* **detector:** skip decoration on Mutter-managed X11 windows to prevent double shadows ([8c23d69](https://github.com/everyx/csd-fixer/commit/8c23d6963311c0299202c8f89a639f02266d6647))
* **detector:** strictly align window tiling and tile-match behavior with Mutter ([5f0fedc](https://github.com/everyx/csd-fixer/commit/5f0fedcc76abfbb2198e57af5213c561b5d20b1f))
* harden picker teardown and drop dead plumbing ([fd2dd67](https://github.com/everyx/csd-fixer/commit/fd2dd67e0edde6693f32508c9a8ff5d24c7ca047))
* **inspector:** resolve app identity for windows without WM_CLASS ([346dba0](https://github.com/everyx/csd-fixer/commit/346dba0a6149bea7a1639e0efadbae105262701a))
* **manager:** redraw the decoration when the theme switches to high contrast ([496e7f3](https://github.com/everyx/csd-fixer/commit/496e7f3a48643870bbf974b8b7d7cfd9244766f3))
* **manager:** skip the clip effect when there is nothing to clip ([e8d9029](https://github.com/everyx/csd-fixer/commit/e8d9029e3bb19c94526817a51fb90c6a08823d0e))
* **rules:** keep rules addressable for windows without WM_CLASS ([f92d7ea](https://github.com/everyx/csd-fixer/commit/f92d7eaad470180948726e12ded8c1fd1f5ef2df))
* **shadow:** blend layers with alpha-over and hollow outset border ([c2e8a43](https://github.com/everyx/csd-fixer/commit/c2e8a436c6cb8e0a7e9844af2fff7d3a6101dbd9))
* **shadow:** clear the bake, and take edge strips from the middle of an edge ([f13643b](https://github.com/everyx/csd-fixer/commit/f13643b1c89f4b67e0b4803a509450b138b13a13))
* **shadow:** cross-fade a style change instead of delaying it ([8770d90](https://github.com/everyx/csd-fixer/commit/8770d904492bed9187e78ba8c02978eeb5e0eb9e))
* **shadow:** destroy cached pipelines on extension disable ([7e27cc2](https://github.com/everyx/csd-fixer/commit/7e27cc2a132184c593f40fb98b25cba6ab32f72a))


### Performance

* **shadow:** bake the shadow once per style instead of per window per frame ([5e9360b](https://github.com/everyx/csd-fixer/commit/5e9360bc57134fc09f4bf9a57778cd3888506ce4))
* stop redoing work that cannot change the result ([5034a1a](https://github.com/everyx/csd-fixer/commit/5034a1ad29e62681b6fe968aac889ee5f2b057da))


### Documentation

* add preview image and update development commands in README ([84d8917](https://github.com/everyx/csd-fixer/commit/84d8917c42a24333d4037f28a451536483f148ff))
* align decoration model and development docs with current codebase ([822e797](https://github.com/everyx/csd-fixer/commit/822e797f8d0c4068b61c8048380bc43fea30c128))
* align licence, rule description and dev setup with reality ([0b90a32](https://github.com/everyx/csd-fixer/commit/0b90a329cc18691c1376d6068862a524c4748e45))
* align style docstring with shadow layer schema ([ccdf504](https://github.com/everyx/csd-fixer/commit/ccdf504546777c49ae63b162642f68d6c7729d85))
* **detector:** correct X11 native shadow criteria description ([7abbd53](https://github.com/everyx/csd-fixer/commit/7abbd539a9c38de1dadb56afe3731332a539dbd4))
* **detector:** tighten the commentary the reviewer's density check flags ([c3f82e6](https://github.com/everyx/csd-fixer/commit/c3f82e6e97bdb2df7c0f8b84a8e20957cd5e3dae))
* **development:** record how to measure the effects in the nested session ([46d522d](https://github.com/everyx/csd-fixer/commit/46d522d18257af278f807ec092690b264f82113c))
* highlight performance advantages in READMEs ([1b2efa3](https://github.com/everyx/csd-fixer/commit/1b2efa351b99cbf97282be9fb6fb926247b326b6))
* move the background out of the comments and into docs/ ([5b23d15](https://github.com/everyx/csd-fixer/commit/5b23d15905864f4ca73983cb2ea2211030fbabd4))
* **readme:** rewrite it for the people who will read it ([772f0d4](https://github.com/everyx/csd-fixer/commit/772f0d41cfff8128a238dbcc018f4bb42c557a3a))
* record libadwaita decoration alignment measurements and probe tool ([f4b5a38](https://github.com/everyx/csd-fixer/commit/f4b5a382e5613af8d9ba3da34f558f7dbd9b6aa3))
* record the decoration model outside the module it describes ([6bb79e9](https://github.com/everyx/csd-fixer/commit/6bb79e96acd51f3f98cf290ae117928e3c9843b0))
* record why the shadow is not drawn or animated through CSS ([378e1bf](https://github.com/everyx/csd-fixer/commit/378e1bfd6d8e729ab82a4bd8071c0439cfdacd6c))
* refresh rule feature description for the interactive picker ([a593769](https://github.com/everyx/csd-fixer/commit/a593769648678952887e29666f360dcb5d7819da))

## 0.1.0 (2026-09-09)


### Features

* **build:** add install-ext script and switch from symlink to real extension installation ([252a5a1](https://github.com/everyx/csd-fixer/commit/252a5a1920e8ef24934cbba90d04a547302ccd97))
* **detector:** implement window csd detector and rule evaluator ([5bba5b2](https://github.com/everyx/csd-fixer/commit/5bba5b259ff71fe996cd0f86dfe23833e213fc8d))
* **effects:** implement gpu box shadow and rounded clip effects ([d671a43](https://github.com/everyx/csd-fixer/commit/d671a432c27fdbf68db029e674533751168e5f86))
* **generators:** introduce upstream baselines and code generators ([3e2899d](https://github.com/everyx/csd-fixer/commit/3e2899d949943e29f6a93f1bb44961deaf674816))
* **i18n:** add gettext translation support and user documentation ([3cf4ab5](https://github.com/everyx/csd-fixer/commit/3cf4ab5d56bbcaf5f00a84a74b93c16e47bc6923))
* **manager:** coordinate window tracking and decoration lifecycle ([0c9fe87](https://github.com/everyx/csd-fixer/commit/0c9fe87e6daee09139210fe934f7ca3f7582684d))
* **prefs:** add settings schema and libadwaita preferences ui ([a2f47e0](https://github.com/everyx/csd-fixer/commit/a2f47e08810923091ef0cf5a03231d1772adb2bc))


### Bug Fixes

* **dev:** remove redundant user-level glib schema registration ([69a3e26](https://github.com/everyx/csd-fixer/commit/69a3e26387383f5c76d351d1ac00a5c5950454b7))
* **i18n:** validate PO syntax in gen-locale check without relying on gitignored MO files ([b066680](https://github.com/everyx/csd-fixer/commit/b066680edb3fd6af300116e706a0d9f4927ca0c1))


### Documentation

* clarify project description to cover both wayland and xwayland applications ([11982bc](https://github.com/everyx/csd-fixer/commit/11982bc4db24e39d31d4d072dceafc35a3d3b961))


### CI/CD

* set up github actions workflows and release-please automation ([d8b56c6](https://github.com/everyx/csd-fixer/commit/d8b56c67e300b18f69d9d1302606a700fcb80a8d))
