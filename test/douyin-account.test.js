import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchDouyinAccount } from '../backend/providers/douyin-account.js';

test('TikHub adapter resolves a Douyin homepage and returns actual public posts', async (t) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    assert.equal(req.headers.authorization, 'Bearer test-tikhub-key');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/v1/douyin/web/get_sec_user_id') {
      return res.end(JSON.stringify({ data: { sec_user_id: 'MS4wLjAB-test' } }));
    }
    if (url.pathname === '/api/v1/douyin/web/handler_user_profile') {
      return res.end(JSON.stringify({ data: { user: { nickname: '真实账号', unique_id: 'real-account' } } }));
    }
    if (url.pathname === '/api/v1/douyin/web/fetch_user_post_videos') {
      assert.equal(url.searchParams.get('sec_user_id'), 'MS4wLjAB-test');
      return res.end(JSON.stringify({ data: { aweme_list: [
        { aweme_id: 'a1', desc: '真实作品一', share_url: 'https://www.douyin.com/video/a1', statistics: { digg_count: 12 } },
        { aweme_id: 'a2', desc: '真实作品二', share_url: 'https://www.douyin.com/video/a2', statistics: { comment_count: 3 } }
      ], has_more: 0, max_cursor: '1' } }));
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

  const result = await fetchDouyinAccount('https://www.douyin.com/user/MS4wLjAB-test', { maxPosts: 5 });
  assert.equal(result.provider, 'tikhub');
  assert.equal(result.account, '真实账号');
  assert.equal(result.secUserId, 'MS4wLjAB-test');
  assert.deepEqual(result.posts.map((item) => item.title), ['真实作品一', '真实作品二']);
});

