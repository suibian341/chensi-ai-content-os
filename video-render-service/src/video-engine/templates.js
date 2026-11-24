export const VIDEO_TEMPLATES = Object.freeze([
  {
    id: 'talking-head',
    name: '口播去气口',
    category: '真人口播',
    providerId: 'video-template-talking-head',
    algorithm: '词级停顿剪辑',
    description: '逐词识别停顿，自动剪掉气口并保留自然呼吸',
    duration: '自动按气口计算',
    maxAssets: 12,
    inputHint: '可批量选择多条清晰人声口播视频，逐条独立出片'
  },
  {
    id: 'vlog',
    name: 'AI 自动剪辑',
    category: '智能成片',
    providerId: 'video-template-vlog',
    algorithm: '主视频时间线语义素材匹配',
    description: '理解主视频口播时间线，从素材库自动匹配画面并连续覆盖',
    duration: '自动跟随主视频',
    maxAssets: 1,
    inputHint: '选择 1 条主视频，其他视频由系统自动匹配'
  },
  {
    id: 'industry-viral',
    name: '行业爆款',
    category: '高光混剪',
    providerId: 'video-template-industry-viral',
    algorithm: '语义高光剪辑',
    description: '转写、语义分段、爆点评分、精选重排并导出高光成片',
    duration: '自动匹配高光内容',
    maxAssets: 12,
    inputHint: '可批量选择多条行业口播或访谈素材，逐条独立出片'
  }
]);

export function videoTemplate(templateId) {
  return VIDEO_TEMPLATES.find((item) => item.id === templateId) || null;
}
