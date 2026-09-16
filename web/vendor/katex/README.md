# KaTeX 本地资源

- 固定版本：`katex@0.18.7`（npm 官方包，稳定版）。
- 上游仓库：https://github.com/KaTeX/KaTeX
- 下载来源：https://registry.npmjs.org/katex/-/katex-0.18.7.tgz
- npm tarball integrity：`sha512-h+UCwkZ+4Jz8WQ7MLGfj7UVFrRCizGb912fwF4luGdYsC5paYG1vx+jy+KRcC/XkpjGva/P7nAWuxNnPzRvzHw==`
- 许可证：MIT，原文见 `LICENSE`。

以下文件原样复制自官方 npm 包，没有重新打包或修改上游代码：

| 本地路径 | npm 包内路径 |
| --- | --- |
| `katex.min.js` | `dist/katex.min.js` |
| `katex.min.css` | `dist/katex.min.css` |
| `fonts/` | `dist/fonts/`（全部 60 个 woff2、woff、ttf 字体文件） |
| `LICENSE` | `LICENSE` |

## 获取与更新

在仓库外临时目录下载，不安装依赖、不执行生命周期脚本：

```sh
tmp_dir=$(mktemp -d /tmp/yeaft-katex-vendor.XXXXXX)
npm pack katex@0.18.7 --registry=https://registry.npmjs.org --ignore-scripts --pack-destination "$tmp_dir"
tar -xzf "$tmp_dir/katex-0.18.7.tgz" -C "$tmp_dir"
```

更新时同步替换上述文件，核对 tarball integrity，并更新本文件中的固定版本、来源和字体数量。不要修改根目录依赖或 lockfile。

## 加载方式

- 开发：`web/index.html` 同步加载本地 `katex.min.js`，在应用模块执行前提供全局 `katex`；直接加载本地 CSS。
- 生产：`web/build.js` 将 JS 纳入先于应用执行的 `vendor.bundle.js`，将 CSS、fonts 和许可证复制到 `web/dist/vendor/katex/`，并在生产 HTML 中加载 CSS。
- CSS 独立于应用样式 bundle，保持 `fonts/` 相对路径不变，并先于应用样式加载，以便应用按需覆盖布局。
- 运行时不访问 CDN，不引入 auto-render 扩展；Markdown 的公式识别与调用由应用负责。
