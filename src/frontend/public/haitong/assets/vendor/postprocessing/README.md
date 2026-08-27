# postprocessing 本地副本

- 包：`postprocessing`
- 固定版本：`6.38.3`
- 来源：npm 官方包 `postprocessing@6.38.3`
- npm integrity：`sha512-5qCFp8j62nWL6sSVv/RKuHscQUIV+VMMgWeHLYZQEBpAk7G+r3jA3bSKON7gZjiuxdZ/F4PXj2Jc1oPh/7Eg+g==`
- 许可证：Zlib，见同目录 `LICENSE.md`
- 上游项目：https://github.com/pmndrs/postprocessing

项目内置 Three.js 为 r160。`postprocessing@6.38.3` 的官方 peerDependencies 为
`three >= 0.157.0 < 0.184.0`，可覆盖当前版本。没有采用 2026-08-27 的最新
`6.39.4`，因为该版本要求 `three >= 0.168.0`，与当前离线引擎不兼容。

`postprocessing.esm.js` 原样复制自 npm 包的 `build/index.js`，未修改上游源码。
