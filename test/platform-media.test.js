import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, extractFirstUrl, extractTikhubVideoUrl, extractWechatChannelsMedia, extractXiaohongshuVideoUrl, platformCookieStatus, splitCommandLine, tikhubVideoStatus, validateExternalUrl } from '../backend/providers/platform-media.js';
import { decryptWechatVideoBuffer } from '../backend/providers/wechat-video-decrypt.js';

test('extracts a URL from platform share text', () => {
  assert.equal(extractFirstUrl('复制打开抖音，看看这个 https://v.douyin.com/abc/ 。'), 'https://v.douyin.com/abc/');
  assert.equal(detectPlatform('小红书分享 https://xhslink.com/a/'), '小红书');
  assert.equal(detectPlatform('小红书分享 https://xhslink.cn/a/'), '小红书');
  assert.equal(detectPlatform('视频号 https://channels.weixin.qq.com/s/abc'), '视频号');
});

test('extracts encrypted WeChat Channels media from simplified and raw responses', () => {
  assert.deepEqual(extractWechatChannelsMedia({
    data: { media: { full_url: 'https://finder.video.qq.com/video?token=one', decode_key: '123456' } }
  }), {
    videoUrl: 'https://finder.video.qq.com/video?token=one',
    decodeKey: '123456'
  });
  assert.deepEqual(extractWechatChannelsMedia({
    data: { objects: [{ objectDesc: { media: [{ url: 'https://finder.video.qq.com/video?enc=one', urlToken: '&token=two', decodeKey: 987654 }] } }] }
  }), {
    videoUrl: 'https://finder.video.qq.com/video?enc=one&token=two',
    decodeKey: '987654'
  });
});

test('decrypts only the encrypted WeChat Channels prefix with XOR', () => {
  const plain = Buffer.alloc(140_000, 7);
  plain.write('ftyp', 4, 'ascii');
  const keystream = Buffer.alloc(131_072, 0x5a);
  const encrypted = decryptWechatVideoBuffer(plain, keystream);
  const decrypted = decryptWechatVideoBuffer(encrypted, keystream);
  assert.deepEqual(decrypted, plain);
  assert.equal(encrypted[135_000], plain[135_000]);
});

test('parses configurable yt-dlp command', () => {
  assert.deepEqual(splitCommandLine('"C:/Program Files/Python/python.exe" -m yt_dlp'), ['C:/Program Files/Python/python.exe', '-m', 'yt_dlp']);
});

test('extracts video URLs from nested Douyin payloads', () => {
  const payload = {
    data: {
      aweme_detail: {
        cover: { url_list: ['https://cdn.example.com/cover.jpeg'] },
        music: { play_url: 'https://cdn.example.com/audio' },
        video: { play_addr: { url_list: ['https://cdn.example.com/video?token=abc'] } }
      }
    }
  };
  assert.equal(extractTikhubVideoUrl(payload), 'https://cdn.example.com/video?token=abc');
  assert.equal(extractTikhubVideoUrl({ data: { video: { url: 'https://cdn.example.com/stream?id=1' } } }), 'https://cdn.example.com/stream?id=1');
  const status = tikhubVideoStatus();
  assert.equal(Object.hasOwn(status, 'provider'), false);
  assert.ok(['configured', 'unconfigured'].includes(status.status));
  assert.doesNotMatch(status.message, /TikHub/i);
});

test('extracts the requested Xiaohongshu note video from deeply nested stream data', () => {
  const payload = {
    data: {
      data: [
        {
          id: 'related-note',
          type: 'video',
          video_info_v2: { media: { stream: { h264: [{ master_url: 'https://cdn.example.com/related.mp4', default_stream: 1, size: 10 }] } } }
        },
        {
          id: 'target-note',
          type: 'video',
          video_info_v2: {
            image: { thumbnail: 'https://cdn.example.com/cover.webp' },
            media: {
              video: { subtitles: { 'zh-CN': [{ url: 'https://cdn.example.com/subtitle.srt' }] } },
              stream: {
                h264: [{ master_url: 'https://cdn.example.com/target-h264.mp4', default_stream: 0, size: 70 }],
                h265: [{ master_url: 'https://cdn.example.com/target-default.mp4', backup_urls: ['https://cdn.example.com/target-backup.mp4'], default_stream: 1, size: 25 }]
              }
            }
          }
        }
      ]
    }
  };
  assert.equal(
    extractXiaohongshuVideoUrl(payload, 'https://www.xiaohongshu.com/discovery/item/target-note?xsec_token=one'),
    'https://cdn.example.com/target-default.mp4'
  );
});

test('rejects private media URLs before downloading', async () => {
  await assert.rejects(() => validateExternalUrl('http://127.0.0.1/video.mp4'), { code: 'UNSAFE_MEDIA_URL' });
  await assert.rejects(() => validateExternalUrl('http://localhost/video.mp4'), { code: 'UNSAFE_MEDIA_URL' });
});

test('reports a safe, actionable platform cookie status', async () => {
  const status = await platformCookieStatus();
  assert.ok(['valid', 'browser', 'refreshing', 'invalid', 'locked', 'unconfigured'].includes(status.status));
  assert.equal(status.state, status.status);
  assert.equal(typeof status.configured, 'boolean');
  assert.equal(status.canRefresh, true);
  assert.equal(typeof status.message, 'string');
  assert.equal(Object.hasOwn(status, 'content'), false);
});
