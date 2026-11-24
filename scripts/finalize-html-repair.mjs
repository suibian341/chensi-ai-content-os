import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, 'artifacts');
const publicDir = join(root, 'web/public');
const apply = process.argv.includes('--apply');
const C = (...codepoints) => String.fromCodePoint(...codepoints);

function replaceAll(value, pairs) {
  for (const [from, to] of pairs) value = value.split(from).join(to);
  return value;
}

function workspace(value) {
  const c = C;
  value = replaceAll(value, [
    ['\u5df2\u5b8c?', '\u5df2\u5b8c\u6210'],
    ['\u4e2a\u6838\u5fc3\u73af', '\u4e2a\u6838\u5fc3\u73af\u8282'],
    ['\u6210\u529f\u4e0e\u5931\u8d25\u5747\u53ef\u8ffd', '\u6210\u529f\u4e0e\u5931\u8d25\u5747\u53ef\u8ffd\u6eaf'],
    ['<h2>\u4e0b\u4e00</h2>', '<h2>\u4e0b\u4e00\u6b65</h2>'],
    ['<h2>\u6700\u8fd1\u4ea7</h2>', '<h2>\u6700\u8fd1\u4ea7\u51fa</h2>'],
    ['IP \u6863\u6848\u4e0e\u521b\u4f5c\u5b9a', 'IP \u6863\u6848\u4e0e\u521b\u4f5c\u5b9a\u4f4d'],
    ['\u7ed3\u6784\u5316\u8d44</span>', '\u7ed3\u6784\u5316\u8d44\u6599</span>'],
    ['\u4e1a\u52a1\u4e0e\u670d\u52a1\u8303', '\u4e1a\u52a1\u4e0e\u670d\u52a1\u8303\u56f4'],
    ['\u89e3\u51b3\u4ec0\u4e48\u95ee', '\u89e3\u51b3\u4ec0\u4e48\u95ee\u9898'],
    ['\u6848\u4f8b\u4e0e\u80cc', '\u6848\u4f8b\u4e0e\u80cc\u666f'],
    ['\u6296\u97f3 / \u5c0f\u7ea2\u4e66?/', '\u6296\u97f3 / \u5c0f\u7ea2\u4e66 /'],
    ['<option>\u89c6\u9891</option>', '<option>\u89c6\u9891\u53f7</option>'],
    ['\u914d\u7f6e?Cookie', '\u914d\u7f6e Cookie'],
    ['\u8d26\u53f7\u7ea7\u62c6', '\u8d26\u53f7\u7ea7\u62c6\u89e3'],
    ['\u8bfb\u53d6\u4f5c\u54c1\u5e76\u62c6', '\u8bfb\u53d6\u4f5c\u54c1\u5e76\u62c6\u89e3'],
    ['\u5408\u89c4\u68c0</span>', '\u5408\u89c4\u68c0\u67e5</span>'],
    ['\u6cbf\u7528\u539f\u6807</label>', '\u6cbf\u7528\u539f\u6807\u9898</label>'],
    ['\u5f53\u524d\u8d26\u53f7\u7684\u672c\u5730\u6587\u6848\u5e93\u5e93', '\u5f53\u524d\u8d26\u53f7\u7684\u672c\u5730\u6587\u6848\u5e93'],
    ['0 \u7bc7\u6587</span>', '0 \u7bc7\u6587\u6848</span>'],
    ['\u6309\u9879\u76ee\u7b5b\u9009\u6587', '\u6309\u9879\u76ee\u7b5b\u9009\u6587\u6848'],
    ['0 \u7bc7\u7ed3</span>', '0 \u7bc7\u7ed3\u679c</span>'],
    ['\u6388\u6743\u72b6\u6001\u5355\u72ec\u8bb0', '\u6388\u6743\u72b6\u6001\u5355\u72ec\u8bb0\u5f55'],
    ['\u6570\u5b57\u4eba\u6a21</span>', '\u6570\u5b57\u4eba\u6a21\u5f0f</span>'],
    ['\u6388\u6743\u72b6</span>', '\u6388\u6743\u72b6\u6001</span>'],
    ['\u5f85\u8865\u5145\u6388</option>', '\u5f85\u8865\u5145\u6388\u6743</option>'],
    ['\u672c\u4eba\u5df2\u6388</option>', '\u672c\u4eba\u5df2\u6388\u6743</option>'],
    ['\u53c2\u8003\u89c6</span>', '\u53c2\u8003\u89c6\u9891</span>'],
    ['\u4ec5\u521b\u5efa\u5f62', '\u4ec5\u521b\u5efa\u5f62\u8c61'],
    ['\u7d20\u6750\u5e93\u58f0\u97f3\u6837', '\u7d20\u6750\u5e93\u58f0\u97f3\u6837\u672c'],
    ['\u4f7f\u7528\u6388</label>', '\u4f7f\u7528\u6388\u6743</label>'],
    ['\u6587\u751f?/ \u5c01\u9762\u4e0e\u914d', '\u6587\u751f\u56fe / \u5c01\u9762\u4e0e\u914d\u56fe'],
    ['\u751f\u6210\u7684\u5c01\u9762\u6216\u914d', '\u751f\u6210\u7684\u5c01\u9762\u6216\u914d\u56fe'],
    ['\u672a\u9009\u62e9 \u00b7 \u6700?4 ', '\u672a\u9009\u62e9 \u00b7 \u6700\u591a 4 \u5f20'],
    ['\u7d20\u6750\u5e93\u540d\u79f0\u6216\u6807', '\u7d20\u6750\u5e93\u540d\u79f0\u6216\u6807\u7b7e'],
    ['00 \u4e2a\u7d20</span>', '00 \u4e2a\u7d20\u6750</span>'],
    ['\u6570\u5b57\u4eba\u53e3</strong>', '\u6570\u5b57\u4eba\u53e3\u64ad</strong>'],
    ['\u89c6\u9891\u7247\u6bb5\uff08\u6309\u5217\u8868\u987a\u5e8f\u62fc\u63a5</span>', '\u89c6\u9891\u7247\u6bb5\uff08\u6309\u5217\u8868\u987a\u5e8f\u62fc\u63a5\uff09</span>'],
    ['\u771f\u5b9e\u89c6\u9891\u7d20</small>', '\u771f\u5b9e\u89c6\u9891\u7d20\u6750</small>'],
    ['\u591a\u7d20\u6750\u5e93\u987a\u5e8f\u62fc', '\u591a\u7d20\u6750\u5e93\u987a\u5e8f\u62fc\u63a5'],
    ['\u6c14\u53e3\u9608</span>', '\u6c14\u53e3\u9608\u503c</span>'],
    ['\u9910\u996e\u3001\u6559\u80b2\u3001\u5bb6', '\u9910\u996e\u3001\u6559\u80b2\u3001\u5bb6\u88c5'],
    ['\u6570\u5b57\u4eba\u53e3\u64ad\u6210</h2>', '\u6570\u5b57\u4eba\u53e3\u64ad\u6210\u7247</h2>'],
    ['\u5f62\u8c61\u4e0e\u58f0</strong>', '\u5f62\u8c61\u4e0e\u58f0\u97f3</strong>'],
    ['\u5df2\u4fdd\u5b58\u5f62</span>', '\u5df2\u4fdd\u5b58\u5f62\u8c61</span>'],
    ['\u5df2\u4fdd\u5b58\u58f0</span>', '\u5df2\u4fdd\u5b58\u58f0\u97f3</span>'],
    ['\u518d\u63d0?TTS', '\u518d\u63d0\u4ea4 TTS'],
    ['\u8f93\u5165\u6570\u5b57\u4eba\u8981\u8bb2\u8ff0\u7684\u5185', '\u8f93\u5165\u6570\u5b57\u4eba\u8981\u8bb2\u8ff0\u7684\u5185\u5bb9'],
    ['\u4ea7\u54c1\u4ecb\u7ecd\u53e3', '\u4ea7\u54c1\u4ecb\u7ecd\u53e3\u64ad'],
    ['\u751f\u6210\u6570\u5b57\u4eba\u89c6', '\u751f\u6210\u6570\u5b57\u4eba\u89c6\u9891'],
    ['\u6700\u591a\u53d6?10 \u4e2a\u6807\u7b7e\uff0c\u4e0d\u9700\u8981\u8f93?#', '\u6700\u591a\u53d6\u524d 10 \u4e2a\u6807\u7b7e\uff0c\u4e0d\u9700\u8981\u8f93\u5165 #'],
    ['\u5b8c\u6210\u4e0a\u4f20\u540e\u76f4\u63a5\u63d0', '\u5b8c\u6210\u4e0a\u4f20\u540e\u76f4\u63a5\u63d0\u4ea4'],
    ['\u5237\u65b0\u72b6', '\u5237\u65b0\u72b6\u6001'],
    ['\u751f\u6210\u53d1\u5e03</button>', '\u751f\u6210\u53d1\u5e03\u5305</button>'],
    ['\u53d1\u5e03\u5230\u5df2\u9009\u5e73', '\u53d1\u5e03\u5230\u5df2\u9009\u5e73\u53f0'],
    ['0 \u6b21\u53d1</span>', '0 \u6b21\u53d1\u5e03</span>'],
    ['JSON \u53ef\u5bfc</span>', 'JSON \u53ef\u5bfc\u51fa</span>'],
    ['\u4e2a\u4eba\u8d26\u53f7\u53ef\u521b\u5efa\u6700?3 ?IP \u6863\u6848', '\u4e2a\u4eba\u8d26\u53f7\u53ef\u521b\u5efa\u6700\u591a 3 \u4e2a IP \u6863\u6848'],
    ['\u5f00\u901a\u4f01\u4e1a\u5de5\u4f5c\u7a7a', '\u5f00\u901a\u4f01\u4e1a\u5de5\u4f5c\u7a7a\u95f4'],
    ['\u6210\u5458\u5e2d\u4f4d\u4e0e\u6743</h2>', '\u6210\u5458\u5e2d\u4f4d\u4e0e\u6743\u9650</h2>'],
    ['\u5f00\u653e\u6743</span>', '\u5f00\u653e\u6743\u9650</span>'],
    ['\u8d26\u53f7\u4e0e\u6743</option>', '\u8d26\u53f7\u4e0e\u6743\u9650</option>'],
    ['\u521b\u4f5c\u4e0e\u751f</option>', '\u521b\u4f5c\u4e0e\u751f\u6210</option>'],
    ['\u7d20\u6750\u5e93\u4e0e\u6210</option>', '\u7d20\u6750\u5e93\u4e0e\u6210\u7247</option>'],
    ['\u53d1\u5e03\u4e0e\u5e73</option>', '\u53d1\u5e03\u4e0e\u5e73\u53f0</option>'],
    ['\u7b80\u8981\u63cf\u8ff0\u95ee', '\u7b80\u8981\u63cf\u8ff0\u95ee\u9898'],
    ['\u5ba2\u6237\u4e13\u5c5e\u6a21\u677f\u5f00\u53d1\u9700', '\u5ba2\u6237\u4e13\u5c5e\u6a21\u677f\u5f00\u53d1\u9700\u6c42'],
    ['\u9700\u6c42\u767b</span>', '\u9700\u6c42\u767b\u8bb0</span>'],
    ['\u5f00\u653e\u8303</span>', '\u5f00\u653e\u8303\u56f4</span>'],
    ['\u4ec5\u5f53\u524d\u5ba2</option>', '\u4ec5\u5f53\u524d\u5ba2\u6237</option>'],
    ['\u53c2\u8003\u89c6\u9891\u94fe</span>', '\u53c2\u8003\u89c6\u9891\u94fe\u63a5</span>'],
    ['\u53c2\u8003\u89c6\u9891\u94fe', '\u53c2\u8003\u89c6\u9891\u94fe\u63a5'],
    ['\u6548\u679c\u4e0e\u4ea4\u4ed8\u8981</span>', '\u6548\u679c\u4e0e\u4ea4\u4ed8\u8981\u6c42</span>'],
    ['<h2>\u9700\u6c42\u8bb0</h2>', '<h2>\u9700\u6c42\u8bb0\u5f55</h2>'],
    ['\u521b\u5efa\u5e76\u8fdb\u5165\u9879', '\u521b\u5efa\u5e76\u8fdb\u5165\u9879\u76ee'],
    ['\u6240\u5c5e\u9879</span>', '\u6240\u5c5e\u9879\u76ee</span>'],
    [c(0x5185,0x5bb9,0x521b,0x4f5c,0x4e0e,0x8d26,0x53f7,0x53f7,0x7ba1,0x7406), c(0x5185,0x5bb9,0x521b,0x4f5c,0x4e0e,0x8d26,0x53f7,0x7ba1,0x7406)],
    [c(0x7d20,0x6750,0x5e93,0x5e93), c(0x7d20,0x6750,0x5e93)],
    [c(0x6587,0x6848,0x5e93,0x4e0e,0x5efa), c(0x6587,0x6848,0x4e0e,0x751f,0x6210)],
    [c(0x6587,0x6848,0x5e93,0x6807,0x9898), c(0x6587,0x6848,0x6807,0x9898)],
    [c(0x6587,0x6848,0x5e93,0x7c7b,0x578b), c(0x6587,0x6848,0x7c7b,0x578b)],
    [c(0x586b,0x5199,0x5b8c,0x6574,0x6587,0x6848,0x5e93), c(0x586b,0x5199,0x5b8c,0x6574,0x6587,0x6848)],
    [c(0x6587,0x6848,0x5e93,0x7684), c(0x6587,0x6848,0x7684)],
    [c(0x53e3,0x64ad,0x6587,0x6848,0x5e93), c(0x53e3,0x64ad,0x6587,0x6848)],
    [c(0x5b57,0x5e55,0x6587,0x6848,0x5e93), c(0x5b57,0x5e55,0x6587,0x6848)],
    [c(0x751f,0x6210,0x7d20,0x6750,0x5e93,0x89c6,0x9891), c(0x751f,0x6210,0x7d20,0x6750,0x89c6,0x9891)],
    [c(0x6587,0x6848,0x5e93,0x9884,0x89c8), c(0x6587,0x6848,0x9884,0x89c8)],
    [c(0x53ef,0x7528,0x7d20,0x6750,0x5e93), c(0x53ef,0x7528,0x7d20,0x6750)],
    [c(0x6587,0x6848,0x5e93,0x5de5,0x4f5c), c(0x6587,0x6848,0x5de5,0x4f5c)],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
  ]);
  value = replaceAll(value, [
    ['?newProjectButton', 'newProjectButton'],
    ['?newProjectButton', 'newProjectButton'],
  ]);
  value = value
    .replace(/<button class="secondary-button" id="newProjectButton">\s*\?([^<]*)/g, '<button class="secondary-button" id="newProjectButton">+ $1')
    .replace(/<button class="primary-button" id="createCopyButton">\?([^<]*)/g, '<button class="primary-button" id="createCopyButton">+ $1')
    .replace(/<button class="primary-button" id="assetUploadButton">\s*\?([^<]*)/g, '<button class="primary-button" id="assetUploadButton">+ $1')
    .replace(/<span class="nav-icon">\?<\/span>/, '<span class="nav-icon">?</span>')
    .replace(/\?(?=(?:\s*<\/|\s*$))/gm, '')
    .replace(c(0x521b,0x4f5c,0x5de5,0x4f5c,0x53f0) + '?<span', c(0x521b,0x4f5c,0x5de5,0x4f5c,0x53f0) + '<span')
    .replace(c(0x5ba2,0x6237,0x5728,0x8d2d,0x4e70,0x524d,0x6700,0x62c5,0x5fc3) + ' <\/textarea>', c(0x5ba2,0x6237,0x5728,0x8d2d,0x4e70,0x524d,0x6700,0x62c5,0x5fc3,0x4ec0,0x4e48) + '"\n                  ></textarea>')
    .replace(/placeholder="\u5ba2\u6237\u5728\u8d2d\u4e70\u524d\u6700\u62c5\u5fc3\u4ec0\s*><\/textarea>/, 'placeholder="\u5ba2\u6237\u5728\u8d2d\u4e70\u524d\u6700\u62c5\u5fc3\u4ec0\u4e48"\n                  ></textarea>')
    .replace(/placeholder="[^"]*每行一\? required>/, 'placeholder="' + c(0x586b,0x5199,0x5b8c,0x6574,0x6587,0x6848,0xff1b,0x95ee,0x7b54,0x811a,0x672c,0x5efa,0x8bae,0x6bcf,0x884c,0x4e00,0x53e5) + '" required>');
  return value;
}

function admin(value) {
  const c = C;
  return replaceAll(value, [
    ['\u914d\u7f6e\u503c\u5168\u7a0b\u8131\u654f\u663e', '\u914d\u7f6e\u503c\u5168\u7a0b\u8131\u654f\u663e\u793a'],
    ['id="adminName">\u7ba1\u7406</strong>', 'id="adminName">\u7ba1\u7406\u5458</strong>'],
    ['id="adminAccount">\u8bfb\u53d6</small>', 'id="adminAccount">\u8bfb\u53d6\u4e2d</small>'],
    ['\u8fd4\u56de\u5de5\u4f5c</a>', '\u8fd4\u56de\u5de5\u4f5c\u53f0</a>'],
    ['\u9000\u51fa\u767b</button>', '\u9000\u51fa\u767b\u5f55</button>'],
    ['\u521b\u4f5c\u80fd\u529b\u63a5\u5165\u72b6</h2>', '\u521b\u4f5c\u80fd\u529b\u63a5\u5165\u72b6\u6001</h2>'],
    ['>\u52a0\u8f7d</span>', '>\u52a0\u8f7d\u4e2d</span>'],
    ['\u80fd\u529b\u63a5\u5165\u72b6</h2>', '\u80fd\u529b\u63a5\u5165\u72b6\u6001</h2>'],
    ['\u65b0\u7528\u6237\u89d2', '\u65b0\u7528\u6237\u89d2\u8272'],
    ['<option value="admin">\u7ba1\u7406</option>', '<option value="admin">\u7ba1\u7406\u5458</option>'],
    ['0 \u4efd\u6863</span>', '0 \u4efd\u6863\u6848</span>'],
    ['\u5957\u9910\u552e\u4ef7\uff08\u5143</span>', '\u5957\u9910\u552e\u4ef7\uff08\u5143\uff09</span>'],
    ['\u53ef\u5151\u6362\u6b21</span>', '\u53ef\u5151\u6362\u6b21\u6570</span>'],
    ['\u5361\u5bc6\u4e0e\u5151\u6362\u8bb0</h2>', '\u5361\u5bc6\u4e0e\u5151\u6362\u8bb0\u5f55</h2>'],
    ['\u5ba2\u6237\u4e13\u5c5e\u6a21\u677f\u5f00\u53d1\u9700', '\u5ba2\u6237\u4e13\u5c5e\u6a21\u677f\u5f00\u53d1\u9700\u6c42'],
    ['\u6863\u6848\u4f4d\u3001', '\u6863\u6848\u4f4d\u6570\u3001'],
    ['\u79ef\u5206\u6d41</h2>', '\u79ef\u5206\u6d41\u6c34</h2>'],
    [c(0x5ba2,0x6237,0x4e0e,0x8d26), c(0x5ba2,0x6237,0x4e0e,0x8d26,0x53f7)],
    [c(0x5206,0x9500,0x4e0e,0x5361), c(0x5206,0x9500,0x4e0e,0x5361,0x5bc6)],
    [c(0x7b97,0x529b,0x4e0e,0x79ef), c(0x7b97,0x529b,0x4e0e,0x79ef,0x5206)],
    [c(0x5b9a,0x5236,0x9700), c(0x5b9a,0x5236,0x9700,0x6c42)],
    [c(0x6587,0x6848,0x68c0,0x67e5,0x89c4), c(0x6587,0x6848,0x68c0,0x67e5,0x89c4,0x5219)],
    [c(0x81f3) + '?8 ' + c(0x4f4d), c(0x81f3,0x5c11) + ' 8 ' + c(0x4f4d)],
    [c(0x5ba2,0x6237,0x8d44,0x6599) + '?IP ' + c(0x6863,0x6848), c(0x5ba2,0x6237,0x8d44,0x6599) + ' / IP ' + c(0x6863,0x6848)],
  ]).replace(/\?(?=(?:\s*<\/|\s*$))/gm, '');
}

function index(value) {
  const c = C;
  return replaceAll(value, [
    ['\u8fdb\u5165\u5de5\u4f5c</span>', '\u8fdb\u5165\u5de5\u4f5c\u53f0</span>'],
    ['\u5185\u5bb9\u667a\u80fd\u4e2d\u67a2\u5df2\u5c31</p>', '\u5185\u5bb9\u667a\u80fd\u4e2d\u67a2\u5df2\u5c31\u7eea</p>'],
    ['>?IP \u6863\u6848', '>\u4ece IP \u6863\u6848'],
    ['\u4ea7\u54c1\u6838\u5fc3\u7279"', '\u4ea7\u54c1\u6838\u5fc3\u7279\u6027"'],
    ['>\u771f\u5b9e\u5de5\u4f5c</span>', '>\u771f\u5b9e\u5de5\u4f5c\u53f0</span>'],
    ['\u5de5\u4f5c\u53f0\u754c\u9762\u9884', '\u5de5\u4f5c\u53f0\u754c\u9762\u9884\u89c8'],
    ['\u5185\u5bb9\u5de5\u4f5c</span>', '\u5185\u5bb9\u5de5\u4f5c\u53f0</span>'],
    ['\u6587\u6848\u5df2\u751f</strong>', '\u6587\u6848\u5df2\u751f\u6210</strong>'],
    ['\u771f\u5b9e\u5de5\u4f5c\u53f0\u754c</div>', '\u771f\u5b9e\u5de5\u4f5c\u53f0\u754c\u9762</div>'],
    ['\u8d2f\u901a\u5185\u5bb9\u751f</h2>', '\u8d2f\u901a\u5185\u5bb9\u751f\u4ea7</h2>'],
    ['>\u89c6\u9891\u4e0e\u53d1</h3>', '>\u89c6\u9891\u4e0e\u53d1\u5e03</h3>'],
    ['\u660e\u786e\u8d26\u53f7\u4e0e\u5185\u5bb9\u5b9a</small>', '\u660e\u786e\u8d26\u53f7\u4e0e\u5185\u5bb9\u5b9a\u4f4d</small>'],
    ['>\u62c6\u89e3\u53c2</strong>', '>\u62c6\u89e3\u53c2\u8003</strong>'],
    ['\u63d0\u53d6\u7ed3\u6784\u548c\u8868\u8fbe\u65b9</small>', '\u63d0\u53d6\u7ed3\u6784\u548c\u8868\u8fbe\u65b9\u5f0f</small>'],
    ['\u8ffd\u8e2a\u4efb\u52a1\u4e0e\u53d1\u5e03\u7ed3</small>', '\u8ffd\u8e2a\u4efb\u52a1\u4e0e\u53d1\u5e03\u7ed3\u679c</small>'],
    ['\u67e5\u770b\u8d26\u53f7\u4e0e\u56e2</a>', '\u67e5\u770b\u8d26\u53f7\u4e0e\u56e2\u961f</a>'],
    ['\u5e2d\u4f4d\u4e0e\u6743\u9650\u6e05\u6670\u53ef</h3>', '\u5e2d\u4f4d\u4e0e\u6743\u9650\u6e05\u6670\u53ef\u63a7</h3>'],
    ['\u771f\u5b9e\u4efb\u52a1\u5168\u7a0b\u53ef\u8ffd</h3>', '\u771f\u5b9e\u4efb\u52a1\u5168\u7a0b\u53ef\u8ffd\u6eaf</h3>'],
    [c(0x5185,0x5bb9,0x521b,0x4f5c,0x4e0e,0x5168,0x94fe,0x8def,0x8fd0,0x8425,0x5de5,0x4f5c), c(0x5185,0x5bb9,0x521b,0x4f5c,0x4e0e,0x5168,0x94fe,0x8def,0x8fd0,0x8425,0x5de5,0x4f5c,0x53f0)],
    [c(0x8fdb,0x5165,0x5de5,0x4f5c) + '?<span', c(0x8fdb,0x5165,0x5de5,0x4f5c,0x53f0) + '<span'],
    [c(0x5f00,0x59cb,0x5185,0x5bb9,0x521b) + '?<span', c(0x5f00,0x59cb,0x5185,0x5bb9,0x521b,0x4f5c) + '<span'],
    [c(0x62c6,0x89e3,0x53c2,0x8003,0x5185) + '?<span', c(0x62c6,0x89e3,0x53c2,0x8003,0x5185,0x5bb9) + '<span'],
    [c(0x6253,0x5f00,0x521b,0x4f5c,0x5de5,0x4f5c) + '?<span', c(0x6253,0x5f00,0x521b,0x4f5c,0x5de5,0x4f5c,0x53f0) + '<span'],
    [c(0x81ea,0x5df1) + '?IP', c(0x81ea,0x5df1,0x7684) + ' IP'],
    [c(0x7b2c,0x4e00) + '?IP', c(0x7b2c,0x4e00,0x4e2a) + ' IP'],
    [c(0x4e2a,0x4eba,0x521b,0x4f5c,0x6709,0x79ef,0x7d2f,0xff0c,0x56e2,0x961f,0x534f,0x4f5c,0x6709,0x8fb9), c(0x4e2a,0x4eba,0x521b,0x4f5c,0x6709,0x79ef,0x7d2f,0xff0c,0x56e2,0x961f,0x534f,0x4f5c,0x6709,0x8fb9,0x754c)],
  ]).replace(/\?(?=(?:\s*<\/|\s*$))/gm, '');
}

function login(value) {
  const c = C;
  return replaceAll(value, [
    [c(0x767b,0x5f55,0x5de5,0x4f5c), c(0x767b,0x5f55,0x5de5,0x4f5c,0x53f0)],
    [c(0x7ba1,0x7406,0x5458,0x59d3), c(0x7ba1,0x7406,0x5458,0x59d3,0x540d)],
    [c(0x81f3,0x5c11) + ' 8 ', c(0x81f3,0x5c11) + ' 8 ' + c(0x4f4d)],
  ]).replace(/\?(?=(?:\s*<\/|\s*$))/gm, '');
}

const repairs = { workspace, admin, index, login };
for (const name of Object.keys(repairs)) {
  const input = join(artifacts, `${name}.repaired.html`);
  const output = join(artifacts, `${name}.final.html`);
  const repaired = repairs[name](await readFile(input, 'utf8'));
  await writeFile(output, repaired, 'utf8');
  if (apply) await writeFile(join(publicDir, `${name}.html`), repaired, 'utf8');
  console.log(`${name}: ids=${(repaired.match(/\bid="/g) ?? []).length} questions=${(repaired.match(/\?/g) ?? []).length} replacement=${(repaired.match(/\uFFFD/g) ?? []).length}`);
}
