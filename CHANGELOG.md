# Changelog

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
