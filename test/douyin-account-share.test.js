import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchDouyinAccount } from '../backend/providers/douyin-account.js';

test('TikHub adapter extracts a share link from copied Douyin text and accepts string data', async (t) => {
  const secUserId = 'MS4wLjAB-string-data';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v1/douyin/web/get_sec_user_id') {
      assert.equal(url.searchParams.get('url'), 'https://v.douyin.com/zhisnAzsYXc/');
      return res.end(JSON.stringify({ code: 200, data: secUserId }));
    }
    if (url.pathname === '/api/v1/douyin/web/handler_user_profile') {
      assert.equal(url.searchParams.get('sec_user_id'), secUserId);
      return res.end(JSON.stringify({ data: { nickname: 'share-account', unique_id: 'share-account' } }));
    }
    if (url.pathname === '/api/v1/douyin/web/fetch_user_post_videos') {
      assert.equal(url.searchParams.get('sec_user_id'), secUserId);
      return res.end(JSON.stringify({ data: { aweme_list: [{ aweme_id: 'share-1', desc: 'share post', share_url: 'https://www.douyin.com/video/share-1' }], has_more: 0, max_cursor: '0' } }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = { base: process.env.IP_AGENT_TIKHUB_BASE_URL, key: process.env.IP_AGENT_TIKHUB_API_KEY };
  process.env.IP_AGENT_TIKHUB_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.IP_AGENT_TIKHUB_API_KEY = 'test-tikhub-key';
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    previous.base === undefined ? delete process.env.IP_AGENT_TIKHUB_BASE_URL : process.env.IP_AGENT_TIKHUB_BASE_URL = previous.base;
    previous.key === undefined ? delete process.env.IP_AGENT_TIKHUB_API_KEY : process.env.IP_AGENT_TIKHUB_API_KEY = previous.key;
  });

  const result = await fetchDouyinAccount('long copied text https://v.douyin.com/zhisnAzsYXc/');
  assert.equal(result.secUserId, secUserId);
  assert.equal(result.account, 'share-account');
  assert.equal(result.posts[0].id, 'share-1');
});
