/**
 * 消息落库前的规范化。新图片先上传 OSS，消息只保存 attachmentId 与元数据。
 * 历史接口为有权访问的附件生成短期签名 URL；该 URL 不写入数据库。
 * 对遗留 Base64 内容块，仍剥离像素以保持兼容，已剥离的内容保持幂等。
 */

/** 剥离后 source.data 的统一占位值 */
export const OMITTED_IMAGE_DATA = '';

function omitImagePayload(block, stats) {
  const source = block && typeof block === 'object' ? block.source : null;
  const data = source && typeof source.data === 'string' ? source.data : '';

  if (!data) {
    return block; // 已无像素数据：原样保留，保证幂等
  }

  const bytes = Buffer.byteLength(data, 'base64');
  stats.images += 1;
  stats.bytes += bytes;

  return {
    ...block,
    source: {
      type: source.type || 'base64',
      media_type: source.media_type || null,
      data: OMITTED_IMAGE_DATA,
      bytes,
    },
    imagePayloadOmitted: true,
  };
}

/**
 * 把待写入 messages.content 的内容转为字符串，并剥离图片像素。
 * @param {string|Array|object} content 原始消息（字符串或内容块数组）
 * @returns {string} 可直接写库的字符串
 */
export function toStorableContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const stats = { images: 0, bytes: 0 };
    const blocks = content.map((block) =>
      block && block.type === 'image' ? omitImagePayload(block, stats) : block,
    );
    return JSON.stringify(blocks);
  }

  return JSON.stringify(content);
}
