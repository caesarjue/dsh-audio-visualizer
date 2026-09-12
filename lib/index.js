/**
 * dsh-audio-visualizer — Host 半
 *
 * 这个插件没有任何 host 侧行为：音频分析与绘制全部发生在浏览器里
 * （lib/client.js），音频数据只存在于 AudioContext 内存中。
 * host 半存在的意义是让 bundle 流程有一个可解析的入口（package.json
 * 的 exports "."）。
 */

export const name = 'dsh-audio-visualizer'

export function apply() {
  // 无需 host 服务与路由。
}
